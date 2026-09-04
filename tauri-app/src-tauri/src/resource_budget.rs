//! Windows worker memory protection. Limits are installed before sending stdin.
use crate::AppError;
use std::ffi::c_void;
use std::mem::size_of;

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
    // 不必要地挡住。worker 只拿剩余安全余量的一半，另一半吸收系统波动。
    (total / 10).clamp(GIB, 4 * GIB)
}

pub(crate) fn plan(total: u64, available: u64, commit_available: u64) -> MemoryBudget {
    let reserve = safety_reserve(total);
    let worker = (total / 4)
        .min(available.saturating_sub(reserve) / 2)
        .min(commit_available.saturating_sub(reserve) / 2);
    let batch = if worker < 256 * MIB {
        0
    } else {
        (worker / 16).clamp(4 * MIB, 128 * MIB)
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
            (batch / 1024).clamp(8192, 131072)
        },
    }
}

pub(crate) fn budget() -> Result<MemoryBudget, AppError> {
    let memory = available()?;
    let result = plan(memory.total, memory.available, memory.commit_available);
    if result.worker_bytes < 256 * MIB {
        return Err(failure(
            "当前剩余内存不足以安全处理，请关闭其他大型程序后重试。",
        ));
    }
    Ok(result)
}

fn runtime_memory_critical(total: u64, available: u64, commit_available: u64) -> bool {
    // 启动时按 safety_reserve 计算 worker 上限；运行中只在系统接近失稳时熔断。
    // 两者若共用同一条保留线，Windows 的正常缓存波动就会把已经受 Job Object
    // 限制的磁盘任务误杀。阈值仍随总内存变化，并为提交余量保留独立底线。
    let physical_floor = (total / 32).clamp(512 * MIB, 2 * GIB);
    available < physical_floor || commit_available < GIB
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
    let mut memory = Memory {
        length: size_of::<Memory>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
        return Err(failure("无法检查系统内存，未启动文件读取。"));
    }
    Ok(memory)
}
pub(crate) fn check_available() -> Result<(), AppError> {
    let memory = available()?;
    if runtime_memory_critical(memory.total, memory.available, memory.commit_available) {
        return Err(failure(
            "系统可用内存不足，已停止任务以保护电脑。请关闭其他大型程序后重试。",
        ));
    }
    Ok(())
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
pub(crate) struct WorkerLimit(*mut c_void);
impl WorkerLimit {
    pub(crate) fn attach(child: &std::process::Child) -> Result<Self, AppError> {
        use std::os::windows::io::AsRawHandle;
        check_available()?;
        let budget = budget()?.worker_bytes;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(failure("无法启用任务内存保护，未开始读取。"));
        }
        let guard = Self(handle);
        let limits = Limits {
            basic: Basic {
                flags: 0x100 | 0x200 | 0x2000,
                ..Default::default()
            },
            process_memory: budget as usize,
            job_memory: budget as usize,
            ..Default::default()
        };
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
            return Err(failure("无法安装任务内存上限，未开始读取。"));
        }
        Ok(guard)
    }
}
impl Drop for WorkerLimit {
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
    fn adaptive_budget_scales_with_host_memory() {
        let mut previous = 0;
        for size in [8, 16, 24, 32, 64] {
            let total = size * GIB;
            let p = plan(total, total * 3 / 4, total);
            assert!(p.worker_bytes > previous);
            assert!(p.worker_bytes <= total / 4);
            assert!(p.worker_bytes + p.reserve_bytes < p.available_bytes);
            assert!((4 * MIB..=128 * MIB).contains(&p.batch_bytes));
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
        assert_eq!(p.worker_bytes, (3 * GIB - 16 * GIB / 10) / 2);
        assert!(p.worker_bytes >= 256 * MIB);
        assert!(p.worker_bytes + p.reserve_bytes < p.available_bytes);
        assert!(p.sqlite_cache_kib <= 64 * 1024);
    }

    #[test]
    fn runtime_guard_only_trips_near_system_exhaustion() {
        assert!(!runtime_memory_critical(16 * GIB, GIB, 8 * GIB));
        assert!(runtime_memory_critical(16 * GIB, 400 * MIB, 8 * GIB));
        assert!(runtime_memory_critical(64 * GIB, 8 * GIB, 512 * MIB));
        assert_eq!(
            (64 * GIB / 32).clamp(512 * MIB, 2 * GIB),
            2 * GIB
        );
    }
}
