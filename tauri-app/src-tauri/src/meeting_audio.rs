//! Teams 音频会话快照：不依赖 SlimCore 日志，也不以音量判定设备是否在用。
//! 只读取 Windows 会话状态，不启动录音。WebView 媒体进程按 Teams 进程树归属。

use std::collections::HashMap;
use wasapi::{Device, DeviceEnumerator, Direction, SessionState};

#[derive(Debug, Default)]
pub(crate) struct TeamsAudio {
    pub capture_devices: Vec<String>,
    pub rendering: bool,
}

#[derive(Debug)]
struct ProcessEntry {
    pid: u32,
    parent: u32,
    name: String,
    created_at: Option<u64>,
}

fn is_teams_executable(name: &str) -> bool {
    name.eq_ignore_ascii_case("ms-teams.exe")
}

fn is_teams_media_executable(name: &str) -> bool {
    is_teams_executable(name) || name.eq_ignore_ascii_case("msedgewebview2.exe")
}

/// PID 会复用：同时读取当前映像名与创建时间，不能只信 ToolHelp 的父 PID。
fn process_identity(pid: u32) -> Option<(String, u64)> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::core::PWSTR;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let result = (|| {
            let mut path = vec![0u16; 32_768];
            let mut size = path.len() as u32;
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut size,
            )
            .ok()?;
            let path = String::from_utf16_lossy(&path[..size as usize]);
            let name = path.rsplit(['\\', '/']).next()?.to_string();
            let mut created = FILETIME::default();
            let mut exited = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).ok()?;
            Some((
                name,
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime),
            ))
        })();
        let _ = CloseHandle(handle);
        result
    }
}

fn process_table() -> Vec<ProcessEntry> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    let mut processes = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return processes;
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&ch| ch == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                let created_at = if is_teams_media_executable(&name) {
                    process_identity(entry.th32ProcessID)
                        .filter(|(actual, _)| actual.eq_ignore_ascii_case(&name))
                        .map(|(_, created)| created)
                } else {
                    None
                };
                processes.push(ProcessEntry {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name,
                    created_at,
                });
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    processes
}

fn teams_processes(processes: &[ProcessEntry]) -> HashMap<u32, u64> {
    let mut owned: HashMap<u32, u64> = processes
        .iter()
        .filter(|process| is_teams_executable(&process.name))
        .filter_map(|process| process.created_at.map(|created| (process.pid, created)))
        .collect();
    loop {
        let before = owned.len();
        for process in processes {
            if !is_teams_media_executable(&process.name) {
                continue;
            }
            if let (Some(created), Some(parent_created)) =
                (process.created_at, owned.get(&process.parent))
            {
                // 真正的子进程不能早于当前父进程创建；无法读取时不猜归属。
                if created >= *parent_created {
                    owned.insert(process.pid, created);
                }
            }
        }
        if owned.len() == before {
            return owned;
        }
    }
}

fn session_is_owned(pid: u32, current: Option<(String, u64)>, owned: &HashMap<u32, u64>) -> bool {
    current.is_some_and(|(name, created)| {
        is_teams_media_executable(&name) && owned.get(&pid) == Some(&created)
    })
}

fn ownership_uncertain(processes: &[ProcessEntry], owned: &HashMap<u32, u64>) -> bool {
    processes.iter().any(|process| {
        process.created_at.is_none()
            && (is_teams_executable(&process.name)
                || (is_teams_media_executable(&process.name)
                    && owned.contains_key(&process.parent)))
    })
}

fn has_active_teams_session(device: &Device, owned: &HashMap<u32, u64>) -> Result<bool, String> {
    let sessions = device
        .get_iaudiosessionmanager()
        .and_then(|manager| manager.get_audiosessionenumerator())
        .map_err(|e| format!("{e:?}"))?;
    for index in 0..sessions.get_count().map_err(|e| format!("{e:?}"))? {
        let session = sessions.get_session(index).map_err(|e| format!("{e:?}"))?;
        if session.get_state().map_err(|e| format!("{e:?}"))? == SessionState::Active {
            let pid = session.get_process_id().map_err(|e| format!("{e:?}"))?;
            if owned.contains_key(&pid) {
                if session_is_owned(pid, process_identity(pid), owned) {
                    return Ok(true);
                }
                // 进程退出／复用或查询失败都先视作未知，不能据此累计结束防抖。
                return Err("Teams 音频进程身份暂时无法确认，等待下次检测。".into());
            }
        }
    }
    Ok(false)
}

fn active_device(enumerator: &DeviceEnumerator, direction: Direction) -> Option<Device> {
    let owned = teams_processes(&process_table());
    if owned.is_empty() {
        return None;
    }
    let devices = enumerator.get_device_collection(&direction).ok()?;
    for index in 0..devices.get_nbr_devices().ok()? {
        let Ok(device) = devices.get_device_at_index(index) else {
            continue;
        };
        if has_active_teams_session(&device, &owned).unwrap_or(false) {
            return Some(device);
        }
    }
    None
}

pub(crate) fn active_capture_device(enumerator: &DeviceEnumerator) -> Option<Device> {
    active_device(enumerator, Direction::Capture)
}

pub(crate) fn active_render_device(enumerator: &DeviceEnumerator) -> Option<Device> {
    active_device(enumerator, Direction::Render)
}

/// 调用线程须先初始化 COM。任一路无法可靠枚举时返回错误，检测层不能把它当作会议结束。
pub(crate) fn snapshot(enumerator: &DeviceEnumerator) -> Result<TeamsAudio, String> {
    let processes = process_table();
    if processes.is_empty() {
        return Err("无法读取 Windows 进程列表。".into());
    }
    let owned = teams_processes(&processes);
    if ownership_uncertain(&processes, &owned) {
        return Err("无法校验 Teams 音频进程归属，等待下次检测。".into());
    }
    let mut audio = TeamsAudio::default();
    if owned.is_empty() {
        return Ok(audio);
    }
    for direction in [Direction::Capture, Direction::Render] {
        let devices = enumerator
            .get_device_collection(&direction)
            .map_err(|e| format!("{e:?}"))?;
        for index in 0..devices.get_nbr_devices().map_err(|e| format!("{e:?}"))? {
            let device = devices
                .get_device_at_index(index)
                .map_err(|e| format!("{e:?}"))?;
            if has_active_teams_session(&device, &owned)? {
                match direction {
                    Direction::Capture => audio
                        .capture_devices
                        .push(device.get_id().map_err(|e| format!("{e:?}"))?),
                    Direction::Render => audio.rendering = true,
                }
            }
        }
    }
    Ok(audio)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_webview_descendants_but_not_unrelated_audio_apps() {
        let processes = vec![
            process(400, 300, "msedgewebview2.exe", Some(30)),
            process(300, 200, "msedgewebview2.exe", Some(20)),
            process(200, 100, "MS-TEAMS.EXE", Some(10)),
            process(500, 100, "msedgewebview2.exe", Some(20)),
            process(600, 200, "wetype_server.exe", Some(20)),
            process(700, 600, "msedgewebview2.exe", Some(30)),
        ];
        assert_eq!(
            teams_processes(&processes),
            HashMap::from([(200, 10), (300, 20), (400, 30)])
        );
        assert!(teams_processes(&[process(500, 100, "msedge.exe", Some(10))]).is_empty());
    }

    fn process(pid: u32, parent: u32, name: &str, created_at: Option<u64>) -> ProcessEntry {
        ProcessEntry {
            pid,
            parent,
            name: name.into(),
            created_at,
        }
    }

    #[test]
    fn recycled_parent_pid_does_not_adopt_older_wechat_webview_or_its_children() {
        let processes = [
            process(200, 100, "ms-teams.exe", Some(100)),
            process(300, 200, "msedgewebview2.exe", Some(20)),
            process(400, 300, "msedgewebview2.exe", Some(110)),
            process(500, 200, "msedgewebview2.exe", Some(101)),
        ];
        assert_eq!(
            teams_processes(&processes),
            HashMap::from([(200, 100), (500, 101)])
        );
    }

    #[test]
    fn unknown_process_identity_does_not_grant_teams_ownership() {
        let processes = [
            process(200, 100, "ms-teams.exe", Some(10)),
            process(300, 200, "msedgewebview2.exe", None),
            process(400, 300, "msedgewebview2.exe", Some(30)),
            process(500, 100, "ms-teams.exe", None),
        ];
        assert_eq!(teams_processes(&processes), HashMap::from([(200, 10)]));
        assert!(ownership_uncertain(
            &processes,
            &teams_processes(&processes)
        ));
    }

    #[test]
    fn unrelated_unreadable_webviews_do_not_block_teams_enumeration() {
        let processes = [
            process(200, 100, "ms-teams.exe", Some(10)),
            process(300, 200, "msedgewebview2.exe", Some(20)),
            process(400, 500, "msedgewebview2.exe", None),
        ];
        assert!(!ownership_uncertain(
            &processes,
            &teams_processes(&processes)
        ));
    }

    #[test]
    fn active_session_must_still_belong_to_same_live_process() {
        let owned = HashMap::from([(200, 10), (300, 20)]);
        assert!(session_is_owned(
            300,
            Some(("msedgewebview2.exe".into(), 20)),
            &owned
        ));
        assert!(!session_is_owned(
            300,
            Some(("wetype_server.exe".into(), 20)),
            &owned
        ));
        assert!(!session_is_owned(
            300,
            Some(("msedgewebview2.exe".into(), 21)),
            &owned
        ));
        assert!(!session_is_owned(
            500,
            Some(("msedgewebview2.exe".into(), 20)),
            &owned
        ));
        assert!(!session_is_owned(200, None, &owned));
    }

    #[test]
    fn current_process_identity_is_readable() {
        let (name, created) = process_identity(std::process::id()).unwrap();
        assert!(name.to_ascii_lowercase().ends_with(".exe"));
        assert!(created > 0);
    }

    #[test]
    #[ignore = "只读枚举真实 Windows 音频会话，供人工诊断"]
    fn live_audio_sessions() {
        assert!(wasapi::initialize_mta().is_ok());
        let enumerator = DeviceEnumerator::new().unwrap();
        println!("Teams 音频会话: {:?}", snapshot(&enumerator).unwrap());
    }
}
