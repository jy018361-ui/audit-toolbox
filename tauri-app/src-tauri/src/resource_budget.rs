//! Windows worker resource monitoring and process lifetime protection.
use crate::AppError;
use std::ffi::c_void;
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

/// Policy is pure so 8/16/24/32/64 GiB hosts can be tested without allocating RAM.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryBudget {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub reserve_bytes: u64,
    pub worker_bytes: u64,
    pub batch_bytes: u64,
    pub sqlite_cache_kib: u64,
}

fn safety_reserve(total: u64) -> u64 {
    // 忙碌主机仍至少给 Windows 留出约 10% 物理内存；上限避免大内存主机被
    // 不必要地挡住。剩余余量仍留出 30% 吸收系统波动。
    (total / 10).clamp(GIB, 4 * GIB)
}

pub(crate) fn plan(total: u64, available: u64, commit_available: u64) -> MemoryBudget {
    let reserve = safety_reserve(total);
    let usable = |bytes: u64| bytes.saturating_sub(reserve).saturating_mul(7) / 10;
    let worker = (total / 3)
        .min(usable(available))
        .min(usable(commit_available));
    let batch = if worker < 256 * MIB {
        0
    } else {
        (worker / 12).clamp(8 * MIB, 256 * MIB)
    };
    MemoryBudget {
        total_bytes: total,
        available_bytes: available,
        reserve_bytes: reserve,
        worker_bytes: worker,
        batch_bytes: batch,
        sqlite_cache_kib: if batch == 0 {
            0
        } else {
            (batch / 1024).clamp(16_384, 262_144)
        },
    }
}

pub(crate) fn budget() -> Result<MemoryBudget, AppError> {
    #[cfg(test)]
    if synthetic_test_budget_enabled() {
        // Explicit opt-in for small synthetic fixtures only. The production
        // binary has no override; physical safety is still checked below.
        let memory = available()?;
        if memory.available < 512 * MIB { return Err(failure("可用内存不足以运行合成小样本测试。")); }
        return Ok(MemoryBudget { total_bytes:memory.total, available_bytes:memory.available,
            reserve_bytes:memory.total/10, worker_bytes:256*MIB, batch_bytes:16*MIB, sqlite_cache_kib:16384 });
    }
    let memory = available()?;
    let result = plan(memory.total, memory.available, memory.commit_available);
    if result.worker_bytes < 256 * MIB {
        return Err(failure(
            "当前剩余内存不足以安全处理，请关闭其他大型程序后重试。",
        ));
    }
    Ok(result)
}

/// 共享业务逻辑只在实际使用大文件磁盘模式时申请受保护预算。
/// 普通内存路径既不查询系统余量，也不套用磁盘 worker 的最低启动门槛。
pub(crate) fn budget_for_disk(disk_mode: bool) -> Result<Option<MemoryBudget>, AppError> {
    if disk_mode { budget().map(Some) } else { Ok(None) }
}

#[cfg(test)]
thread_local! {
    static TEST_MEMORY: std::cell::Cell<Option<MemoryStatus>> = const { std::cell::Cell::new(None) };
}

/// 仅测试使用，按线程模拟内存压力，避免实际占满内存或干扰并行测试。
#[cfg(test)]
pub(crate) fn with_test_memory<T>(memory: MemoryStatus, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<MemoryStatus>);
    impl Drop for Restore {
        fn drop(&mut self) { TEST_MEMORY.with(|slot| slot.set(self.0)); }
    }
    let _restore = Restore(TEST_MEMORY.with(|slot| slot.replace(Some(memory))));
    run()
}

#[cfg(test)]
fn synthetic_test_budget_enabled() -> bool {
    std::env::var_os("AUDIT_TOOLBOX_SYNTHETIC_TEST_BUDGET").is_some_and(|value| value == "1")
}

fn parallelism_for(worker_bytes: u64, logical_processors: usize) -> usize {
    let desired = if worker_bytes < 768 * MIB {
        1
    } else if worker_bytes < 1536 * MIB {
        2
    } else {
        4
    };
    desired.min(logical_processors.max(1))
}

/// CPU-heavy row decoding uses a small bounded pool. Memory pressure reduces
/// the pool automatically without changing business results or row order.
pub(crate) fn recommended_parallelism() -> Result<usize, AppError> {
    let memory = budget()?;
    let logical = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    Ok(parallelism_for(memory.worker_bytes, logical))
}

fn physical_pause_floor(total: u64) -> u64 {
    (total / 32).clamp(512 * MIB, 2 * GIB)
}

fn runtime_memory_critical(total: u64, available: u64, commit_available: u64) -> bool {
    // 启动时按 safety_reserve 计算 worker 上限；运行中先在系统接近失稳时暂停。
    // 两者若共用同一条保留线，Windows 的正常缓存波动就会误暂停磁盘任务。
    // 阈值仍随总内存变化，并为提交余量保留独立底线。
    available < physical_pause_floor(total) || commit_available < GIB
}

fn runtime_memory_recovered(total: u64, available: u64, commit_available: u64) -> bool {
    available >= physical_pause_floor(total).saturating_mul(2) && commit_available >= 2 * GIB
}

fn runtime_memory_emergency(total: u64, available: u64, commit_available: u64) -> bool {
    let physical_floor = (total / 64).clamp(128 * MIB, 512 * MIB);
    available < physical_floor || commit_available < 256 * MIB
}
#[repr(C)]
#[derive(Default)]
struct Memory {
    length: u32,
    load: u32,
    total: u64,
    available: u64,
    commit: u64,
    commit_available: u64,
    virtual_total: u64,
    virtual_available: u64,
    extended: u64,
}
#[repr(C)]
#[derive(Default)]
struct Basic {
    process_time: i64,
    job_time: i64,
    flags: u32,
    min: usize,
    max: usize,
    active: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}
#[repr(C)]
#[derive(Default)]
struct Limits {
    basic: Basic,
    io: [u64; 6],
    process_memory: usize,
    job_memory: usize,
    peak_process: usize,
    peak_job: usize,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalMemoryStatusEx(memory: *mut Memory) -> i32;
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(
        job: *mut c_void,
        class: i32,
        data: *const c_void,
        length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetDiskFreeSpaceExW(
        path: *const u16,
        available: *mut u64,
        total: *mut u64,
        free: *mut u64,
    ) -> i32;
}
fn failure(message: &str) -> AppError {
    AppError::new("MEMORY_PROTECTION", message, true, None)
}
fn available() -> Result<Memory, AppError> {
    #[cfg(test)]
    if let Some(memory) = TEST_MEMORY.with(|slot| slot.get()) {
        return Ok(Memory { total: memory.total, available: memory.available,
            commit_available: memory.commit_available, ..Default::default() });
    }
    let mut memory = Memory {
        length: size_of::<Memory>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
        return Err(failure("无法检查系统内存，未启动文件读取。"));
    }
    Ok(memory)
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct MemoryStatus {
    pub total: u64,
    pub available: u64,
    pub commit_available: u64,
}

pub(crate) fn memory_status() -> Result<MemoryStatus, AppError> {
    let memory = available()?;
    Ok(MemoryStatus {
        total: memory.total,
        available: memory.available,
        commit_available: memory.commit_available,
    })
}

impl MemoryStatus {
    pub(crate) fn should_pause(self) -> bool {
        runtime_memory_critical(self.total, self.available, self.commit_available)
    }

    pub(crate) fn auto_resume_ready(self) -> bool {
        runtime_memory_recovered(self.total, self.available, self.commit_available)
    }

    pub(crate) fn emergency(self) -> bool {
        runtime_memory_emergency(self.total, self.available, self.commit_available)
    }

    pub(crate) fn can_start_worker(self) -> bool {
        self.worker_bytes() >= 256 * MIB
    }

    pub(crate) fn worker_bytes(self) -> u64 {
        plan(self.total, self.available, self.commit_available).worker_bytes
    }

    pub(crate) fn available_gib(self) -> f64 {
        self.available as f64 / GIB as f64
    }
}

struct RuntimeMemoryControl {
    cancel: Arc<AtomicBool>,
    retry_path: PathBuf,
}

static RUNTIME_MEMORY_CONTROL: OnceLock<RuntimeMemoryControl> = OnceLock::new();

/// A worker process handles exactly one job, so one process-wide control is sufficient.
pub(crate) fn install_runtime_memory_control(cancel: Arc<AtomicBool>, retry_path: PathBuf) {
    let _ = RUNTIME_MEMORY_CONTROL.set(RuntimeMemoryControl { cancel, retry_path });
}

pub(crate) fn memory_retry_path(pause_path: &Path) -> PathBuf {
    pause_path.with_extension("memory-retry")
}

pub(crate) fn check_available() -> Result<(), AppError> {
    #[cfg(test)]
    if synthetic_test_budget_enabled() && RUNTIME_MEMORY_CONTROL.get().is_none() {
        return budget().map(|_| ());
    }
    let memory = available()?;
    if !runtime_memory_critical(memory.total, memory.available, memory.commit_available) {
        if let Some(control) = RUNTIME_MEMORY_CONTROL.get() {
            let _ = std::fs::remove_file(&control.retry_path);
        }
        return Ok(());
    }
    let Some(control) = RUNTIME_MEMORY_CONTROL.get() else {
        return Err(failure(
            "系统可用内存不足，当前任务尚未启动，正在等待内存恢复。",
        ));
    };
    let mut recovered_since = None::<Instant>;
    let mut emergency_since = None::<Instant>;
    loop {
        if control.cancel.load(Ordering::Relaxed) {
            return Err(AppError::new("JOB_CANCELLED", "任务已取消。", false, None));
        }
        let memory = available()?;
        let manually_retried = control.retry_path.exists();
        if manually_retried {
            let _ = std::fs::remove_file(&control.retry_path);
        }
        let critical =
            runtime_memory_critical(memory.total, memory.available, memory.commit_available);
        if manually_retried && !critical {
            return Ok(());
        }
        if runtime_memory_recovered(memory.total, memory.available, memory.commit_available) {
            let since = recovered_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_secs(5) {
                return Ok(());
            }
        } else {
            recovered_since = None;
        }
        if runtime_memory_emergency(memory.total, memory.available, memory.commit_available) {
            let since = emergency_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_secs(15) {
                return Err(failure("系统内存持续处于危险水平，已停止任务以保护电脑。"));
            }
        } else {
            emergency_since = None;
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// 长任务在 worker 中安装控制器后才等待内存恢复。同步探测、单元测试等
/// 非 worker 调用不应因为主机一时繁忙而被这个运行期检查误拦。
pub(crate) fn check_available_if_managed() -> Result<(), AppError> {
    if RUNTIME_MEMORY_CONTROL.get().is_some() {
        check_available()
    } else {
        Ok(())
    }
}

pub(crate) fn check_disk_space(path: &std::path::Path, estimated: u64) -> Result<(), AppError> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0;
    if unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(failure("无法检查缓存磁盘空间，未开始大文件读取。"));
    }
    if free < estimated.saturating_add(GIB) {
        return Err(AppError::new(
            "CACHE_DISK_SPACE",
            "缓存磁盘剩余空间不足，请清理空间后重新读取大文件。",
            true,
            None,
        ));
    }
    Ok(())
}
// Job Object only owns the worker lifetime. Estimated working-set budgets must
// not become OS allocation ceilings; actual system pressure controls pause/resume.
fn worker_lifetime_limits() -> Limits {
    Limits { basic: Basic { flags: 0x2000, ..Default::default() }, ..Default::default() }
}
pub(crate) struct WorkerLifetime(*mut c_void);
impl WorkerLifetime {
    pub(crate) fn attach(child: &std::process::Child) -> Result<Self, AppError> {
        use std::os::windows::io::AsRawHandle;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(failure("无法启用任务进程保护，未开始读取。"));
        }
        let guard = Self(handle);
        let limits = worker_lifetime_limits();
        if unsafe {
            SetInformationJobObject(
                handle,
                9,
                &limits as *const _ as *const c_void,
                size_of::<Limits>() as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
        {
            return Err(failure("无法安装任务进程保护，未开始读取。"));
        }
        Ok(guard)
    }
}
impl Drop for WorkerLifetime {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_job_owns_lifetime_without_estimated_memory_ceiling() {
        let limits = worker_lifetime_limits();
        assert_eq!(limits.basic.flags, 0x2000);
        assert_eq!(limits.process_memory, 0);
        assert_eq!(limits.job_memory, 0);
    }
    #[test]
    fn ordinary_mode_skips_disk_memory_gate_but_disk_mode_keeps_it() {
        with_test_memory(MemoryStatus { total: 16 * GIB, available: 128 * MIB, commit_available: 128 * MIB }, || {
            assert!(budget_for_disk(false).unwrap().is_none());
            assert_eq!(budget_for_disk(true).unwrap_err().code, "MEMORY_PROTECTION");
        });
    }
    #[test]
    fn adaptive_budget_scales_with_host_memory() {
        let mut previous = 0;
        for size in [8, 16, 24, 32, 64] {
            let total = size * GIB;
            let p = plan(total, total * 3 / 4, total);
            assert!(p.worker_bytes > previous);
            assert!(p.worker_bytes <= total / 3);
            assert!(p.worker_bytes + p.reserve_bytes < p.available_bytes);
            assert!((8 * MIB..=256 * MIB).contains(&p.batch_bytes));
            previous = p.worker_bytes;
        }
    }
    #[test]
    fn adaptive_budget_respects_busy_hosts_and_commit_pressure() {
        let free = plan(32 * GIB, 24 * GIB, 32 * GIB);
        let busy = plan(32 * GIB, 8 * GIB, 32 * GIB);
        let commit = plan(32 * GIB, 24 * GIB, 8 * GIB);
        assert!(busy.worker_bytes < free.worker_bytes);
        assert_eq!(busy.worker_bytes, commit.worker_bytes);
        for p in [
            plan(16 * GIB, GIB, 32 * GIB),
            plan(64 * GIB, 48 * GIB, GIB),
            plan(0, 0, 0),
        ] {
            assert_eq!(p.worker_bytes, 0);
            assert_eq!(p.batch_bytes, 0);
        }
    }

    #[test]
    fn sixteen_gib_host_can_continue_slowly_with_three_gib_free() {
        let p = plan(16 * GIB, 3 * GIB, 20 * GIB);
        assert_eq!(p.reserve_bytes, 16 * GIB / 10);
        assert_eq!(
            p.worker_bytes,
            (3 * GIB - 16 * GIB / 10).saturating_mul(7) / 10
        );
        assert!(p.worker_bytes >= 256 * MIB);
        assert!(p.worker_bytes + p.reserve_bytes < p.available_bytes);
        assert!(p.sqlite_cache_kib <= 128 * 1024);
    }

    #[test]
    fn runtime_guard_only_trips_near_system_exhaustion() {
        assert!(!runtime_memory_critical(16 * GIB, GIB, 8 * GIB));
        assert!(runtime_memory_critical(16 * GIB, 400 * MIB, 8 * GIB));
        assert!(runtime_memory_critical(64 * GIB, 8 * GIB, 512 * MIB));
        assert_eq!((64 * GIB / 32).clamp(512 * MIB, 2 * GIB), 2 * GIB);
    }

    #[test]
    fn runtime_pause_has_hysteresis_and_a_lower_emergency_line() {
        assert!(runtime_memory_critical(16 * GIB, 400 * MIB, 8 * GIB));
        assert!(!runtime_memory_recovered(16 * GIB, 900 * MIB, 8 * GIB));
        assert!(runtime_memory_recovered(16 * GIB, GIB, 8 * GIB));
        assert!(!runtime_memory_emergency(16 * GIB, 300 * MIB, 8 * GIB));
        assert!(runtime_memory_emergency(16 * GIB, 100 * MIB, 8 * GIB));
    }

    #[test]
    fn decoding_parallelism_scales_down_under_memory_pressure() {
        assert_eq!(parallelism_for(512 * MIB, 16), 1);
        assert_eq!(parallelism_for(GIB, 16), 2);
        assert_eq!(parallelism_for(2 * GIB, 16), 4);
        assert_eq!(parallelism_for(2 * GIB, 2), 2);
    }
}
