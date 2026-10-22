//! Teams 音频会话快照：不依赖 SlimCore 日志，也不以音量判定设备是否在用。
//! 只读取 Windows 会话状态，不启动录音。WebView 媒体进程按 Teams 进程树归属。

use std::collections::HashSet;
use wasapi::{Device, DeviceEnumerator, Direction, SessionState};

#[derive(Debug, Default)]
pub(crate) struct TeamsAudio {
    pub capture_devices: Vec<String>,
    pub rendering: bool,
}

pub(crate) fn process_table() -> Vec<(u32, u32, String)> {
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
                processes.push((
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..len]),
                ));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    processes
}

fn teams_processes(processes: &[(u32, u32, String)]) -> HashSet<u32> {
    let mut owned: HashSet<u32> = processes
        .iter()
        .filter(|(_, _, name)| name.eq_ignore_ascii_case("ms-teams.exe"))
        .map(|(pid, _, _)| *pid)
        .collect();
    loop {
        let before = owned.len();
        for (pid, parent, _) in processes {
            if owned.contains(parent) {
                owned.insert(*pid);
            }
        }
        if owned.len() == before {
            return owned;
        }
    }
}

fn has_active_teams_session(device: &Device, owned: &HashSet<u32>) -> Result<bool, String> {
    let sessions = device
        .get_iaudiosessionmanager()
        .and_then(|manager| manager.get_audiosessionenumerator())
        .map_err(|e| format!("{e:?}"))?;
    for index in 0..sessions.get_count().map_err(|e| format!("{e:?}"))? {
        let session = sessions.get_session(index).map_err(|e| format!("{e:?}"))?;
        if session.get_state().map_err(|e| format!("{e:?}"))? == SessionState::Active
            && owned.contains(&session.get_process_id().map_err(|e| format!("{e:?}"))?)
        {
            return Ok(true);
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
            (400, 300, "msedgewebview2.exe".into()),
            (300, 200, "msedgewebview2.exe".into()),
            (200, 100, "MS-TEAMS.EXE".into()),
            (500, 100, "msedgewebview2.exe".into()),
        ];
        assert_eq!(teams_processes(&processes), HashSet::from([200, 300, 400]));
        assert!(teams_processes(&[(500, 100, "msedge.exe".into())]).is_empty());
    }

    #[test]
    #[ignore = "只读枚举真实 Windows 音频会话，供人工诊断"]
    fn live_audio_sessions() {
        assert!(wasapi::initialize_mta().is_ok());
        let enumerator = DeviceEnumerator::new().unwrap();
        println!("Teams 音频会话: {:?}", snapshot(&enumerator).unwrap());
    }
}
