// 使用统计（匿名埋点）：记录「启动软件 / 打开工具 / 执行任务 / 退出软件」
// 四类事件，先落本机 SQLite 队列，后台线程批量上报到部门自建统计服务器。
//
// 红线（结构性约束，不是口头承诺）：
// 1. 事件字段只有统计必需项（见 enqueue），不存在携带文件路径、账表内容、
//    客户数据的通道；
// 2. 发送失败静默保留在本地（封顶 5000 条），绝不影响主流程、绝不报错弹窗；
// 3. 设置里关掉统计后，连同本地攒着的事件一并清空。

use parking_lot::Mutex;
use rusqlite::{Connection, params, params_from_iter};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, OnceLock, mpsc},
    time::{Duration, Instant},
};

/// 出厂内置的统计服务器地址。留空 = 未配置（事件只攒在本机，设置里填了
/// 地址后连同历史一起补发）。部门统计服务器部署定型后把内网地址写在这里，
/// 用户端即可零配置上报。
pub(crate) const DEFAULT_SERVER_URL: &str = "";

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_QUEUED: i64 = 5_000;
const SEND_TIMEOUT: Duration = Duration::from_secs(3);
const RETRY_INTERVAL: Duration = Duration::from_secs(120);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct TrackEvent {
    pub event: String,
    pub tool_id: Option<String>,
    pub tool_name: Option<String>,
    pub success: Option<bool>,
    pub duration_ms: Option<i64>,
}

enum Msg {
    Track(TrackEvent),
    Shutdown(mpsc::Sender<()>),
}

/// 埋点句柄：track 只是把事件塞进通道，落库与网络全在后台线程。
/// 需要作为 Tauri state 被多个线程共享，因此通道口包一层锁。
#[derive(Clone)]
pub(crate) struct Telemetry {
    tx: Arc<Mutex<mpsc::Sender<Msg>>>,
    launched: Instant,
}

struct Facts {
    install_id: String,
    host_name: String,
    user_name: String,
    os_version: String,
}

impl Telemetry {
    pub(crate) fn start(db_path: PathBuf) -> Telemetry {
        let (tx, rx) = mpsc::channel::<Msg>();
        std::thread::Builder::new()
            .name("telemetry".into())
            .spawn(move || run_loop(db_path, rx))
            .ok();
        Telemetry {
            tx: Arc::new(Mutex::new(tx)),
            launched: Instant::now(),
        }
    }

    /// 非阻塞上报：后台线程不在了（理论上仅退出后）就丢弃。
    pub(crate) fn track(
        &self,
        event: &str,
        tool_id: Option<&str>,
        tool_name: Option<&str>,
        success: Option<bool>,
        duration_ms: Option<i64>,
    ) {
        let _ = self.tx.lock().send(Msg::Track(TrackEvent {
            event: event.to_string(),
            tool_id: tool_id.map(str::to_string),
            tool_name: tool_name.map(str::to_string),
            success,
            duration_ms,
        }));
    }

    pub(crate) fn session_ms(&self) -> i64 {
        self.launched.elapsed().as_millis() as i64
    }

    /// 退出前尽力补发一次（带超时，不拖慢关窗）。
    pub(crate) fn shutdown(&self) {
        let (ack_tx, ack_rx) = mpsc::channel::<()>();
        if self.tx.lock().send(Msg::Shutdown(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(SHUTDOWN_TIMEOUT);
        }
    }
}

fn run_loop(db_path: PathBuf, rx: mpsc::Receiver<Msg>) {
    let Ok(conn) = Connection::open(&db_path) else {
        return;
    };
    if init_tables(&conn).is_err() {
        return;
    }
    let facts = Facts {
        install_id: ensure_install_id(&conn),
        host_name: std::env::var("COMPUTERNAME").unwrap_or_default(),
        user_name: std::env::var("USERNAME").unwrap_or_default(),
        os_version: os_version(),
    };
    loop {
        match rx.recv_timeout(RETRY_INTERVAL) {
            Ok(Msg::Track(event)) => {
                enqueue(&conn, &facts, event);
                flush(&conn);
            }
            Ok(Msg::Shutdown(ack)) => {
                flush(&conn);
                let _ = ack.send(());
                break;
            }
            // 空闲超时也冲一次：服务器恢复后把攒着的历史补出去。
            Err(mpsc::RecvTimeoutError::Timeout) => flush(&conn),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                flush(&conn);
                break;
            }
        }
    }
}

fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA busy_timeout=5000;
         CREATE TABLE IF NOT EXISTS telemetry_queue(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           payload_json TEXT NOT NULL,
           created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS telemetry_meta(
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL);",
    )
}

fn ensure_install_id(conn: &Connection) -> String {
    if let Ok(existing) = conn.query_row(
        "SELECT value FROM telemetry_meta WHERE key='install_id'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        if !existing.is_empty() {
            return existing;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO telemetry_meta(key, value) VALUES('install_id', ?1)",
        params![id],
    );
    id
}

/// 工具 id → 展示名，取自内嵌的工具目录，上报前把名称补齐。
fn tool_name_map() -> &'static HashMap<String, String> {
    static NAMES: OnceLock<HashMap<String, String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        let catalog: Value =
            serde_json::from_str(include_str!("../../public/tool-catalog.json"))
                .unwrap_or(Value::Array(Vec::new()));
        catalog
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        Some((
                            row.get("id")?.as_str()?.to_string(),
                            row.get("name")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

#[cfg(windows)]
fn os_version() -> String {
    use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .ok();
    let product: String = key
        .as_ref()
        .and_then(|k| k.get_value("ProductName").ok())
        .unwrap_or_default();
    let display: String = key
        .and_then(|k| {
            k.get_value::<String, _>("DisplayVersion")
                .or_else(|_| k.get_value("ReleaseId"))
                .ok()
        })
        .unwrap_or_default();
    let joined = format!("{product} {display}").trim().to_string();
    if joined.is_empty() {
        "Windows".to_string()
    } else {
        joined
    }
}

#[cfg(not(windows))]
fn os_version() -> String {
    "Windows".to_string()
}

fn enqueue(conn: &Connection, facts: &Facts, event: TrackEvent) {
    let tool_name = event
        .tool_name
        .or_else(|| event.tool_id.as_deref().and_then(|id| tool_name_map().get(id).cloned()));
    let payload = json!({
        "install_id": facts.install_id,
        "event": event.event,
        "ts": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        "tool_id": event.tool_id,
        "tool_name": tool_name,
        "success": event.success,
        "duration_ms": event.duration_ms,
        "app_version": APP_VERSION,
        "host_name": facts.host_name,
        "user_name": facts.user_name,
        "os_version": facts.os_version,
    });
    if conn
        .execute(
            "INSERT INTO telemetry_queue(payload_json, created_at) VALUES(?1, ?2)",
            params![payload.to_string(), chrono::Utc::now().to_rfc3339()],
        )
        .is_err()
    {
        return;
    }
    // 封顶：只保留最近的 MAX_QUEUED 条。
    let _ = conn.execute(
        "DELETE FROM telemetry_queue WHERE id <= (SELECT MAX(id) - ?1 FROM telemetry_queue)",
        params![MAX_QUEUED],
    );
}

struct TelemetryConfig {
    enabled: bool,
    server_url: Option<String>,
}

/// 设置里的 `telemetry` 顶层键：`{"enabled": bool, "server_url": "http://…:8787"}`。
/// 键不存在时按默认（开 + 出厂地址）处理。
fn telemetry_config(conn: &Connection) -> TelemetryConfig {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key='telemetry'",
            [],
            |row| row.get(0),
        )
        .ok();
    let value = raw
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    let enabled = value.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let server_url = value
        .get("server_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .or_else(|| {
            (!DEFAULT_SERVER_URL.is_empty()).then(|| DEFAULT_SERVER_URL.to_string())
        });
    TelemetryConfig { enabled, server_url }
}

fn flush(conn: &Connection) {
    let config = telemetry_config(conn);
    if !config.enabled {
        // 用户关掉统计：本地攒着的一并清空。
        let _ = conn.execute("DELETE FROM telemetry_queue", []);
        return;
    }
    let Some(server_url) = config.server_url else {
        return; // 没配地址：先攒着，配好后一起补发。
    };
    loop {
        let rows: Vec<(i64, String)> = conn
            .prepare("SELECT id, payload_json FROM telemetry_queue ORDER BY id LIMIT 50")
            .and_then(|mut stmt| {
                stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default();
        if rows.is_empty() {
            return;
        }
        let events: Vec<Value> = rows
            .iter()
            .filter_map(|(_, text)| serde_json::from_str(text).ok())
            .collect();
        if !send_batch(&server_url, &events) {
            return; // 发送失败：留着，下次事件或定时重试时再补。
        }
        let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
        let placeholders = vec!["?"; ids.len()].join(",");
        let _ = conn.execute(
            &format!("DELETE FROM telemetry_queue WHERE id IN ({placeholders})"),
            params_from_iter(ids),
        );
    }
}

fn send_batch(server_url: &str, events: &[Value]) -> bool {
    let endpoint = format!("{}/api/events", server_url.trim_end_matches('/'));
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(SEND_TIMEOUT)
        .build()
    else {
        return false;
    };
    client
        .post(endpoint)
        .json(&json!({ "events": events }))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    fn track_event(event: &str) -> TrackEvent {
        TrackEvent {
            event: event.to_string(),
            tool_id: Some("tbje_check".into()),
            tool_name: None,
            success: Some(true),
            duration_ms: Some(120),
        }
    }

    fn test_db() -> (PathBuf, Connection) {
        let root = std::env::temp_dir().join(format!("audit-telemetry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let conn = Connection::open(root.join("t.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings(
               key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();
        init_tables(&conn).unwrap();
        (root, conn)
    }

    fn queue_len(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM telemetry_queue", [], |row| row.get(0))
            .unwrap()
    }

    fn set_settings(conn: &Connection, value: Value) {
        conn.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES('telemetry', ?1, 'now')
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            params![value.to_string()],
        )
        .unwrap();
    }

    /// 极简 HTTP 假服务器：收 POST、记请求体、回 200。用完即弃（线程阻塞在
    /// accept 上随测试进程退出）。
    fn spawn_mock_server() -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 8192];
                let mut head = Vec::new();
                loop {
                    let read = match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => read,
                    };
                    head.extend_from_slice(&buffer[..read]);
                    if let Some(pos) = find_subsequence(&head, b"\r\n\r\n") {
                        let header_text = String::from_utf8_lossy(&head[..pos]).to_string();
                        let content_length = header_text
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().ok())?
                            })
                            .unwrap_or(0);
                        if head.len() >= pos + 4 + content_length {
                            let body = head[pos + 4..pos + 4 + content_length].to_vec();
                            let _ = tx.send(String::from_utf8_lossy(&body).to_string());
                            let response =
                                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                                  Content-Length: 13\r\nConnection: close\r\n\r\n{\"accepted\":9}";
                            let _ = stream.write_all(response);
                            break;
                        }
                    }
                }
            }
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    #[test]
    fn install_id_is_stable_across_reopens() {
        let (root, conn) = test_db();
        let first = ensure_install_id(&conn);
        assert_eq!(ensure_install_id(&conn), first);
        drop(conn);
        let reopened = Connection::open(root.join("t.db")).unwrap();
        assert_eq!(ensure_install_id(&reopened), first);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn enqueue_fills_tool_name_from_catalog_and_caps_queue() {
        let (root, conn) = test_db();
        let facts = Facts {
            install_id: "install-1".into(),
            host_name: "PC-A".into(),
            user_name: "zhangsan".into(),
            os_version: "Windows 11".into(),
        };
        enqueue(&conn, &facts, track_event("tool_open"));
        let text: String = conn
            .query_row(
                "SELECT payload_json FROM telemetry_queue ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payload: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(payload["tool_id"], "tbje_check");
        let expected_name = tool_name_map().get("tbje_check").unwrap().clone();
        assert_eq!(payload["tool_name"].as_str(), Some(expected_name.as_str()));
        assert_eq!(payload["install_id"], "install-1");
        assert_eq!(payload["app_version"], APP_VERSION);

        for _ in 0..=(MAX_QUEUED + 10) {
            enqueue(&conn, &facts, track_event("job_run"));
        }
        assert_eq!(queue_len(&conn), MAX_QUEUED);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn flush_posts_batches_and_clears_queue() {
        let (root, conn) = test_db();
        let (url, rx) = spawn_mock_server();
        set_settings(&conn, json!({ "enabled": true, "server_url": url }));
        let facts = Facts {
            install_id: "install-1".into(),
            host_name: "PC-A".into(),
            user_name: "zhangsan".into(),
            os_version: "Windows 11".into(),
        };
        enqueue(&conn, &facts, track_event("app_start"));
        enqueue(&conn, &facts, track_event("job_run"));
        flush(&conn);
        let body = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(body.contains("\"app_start\""));
        assert!(body.contains("\"job_run\""));
        assert_eq!(queue_len(&conn), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn flush_without_server_url_keeps_queue() {
        let (root, conn) = test_db();
        let facts = Facts {
            install_id: "install-1".into(),
            host_name: "PC-A".into(),
            user_name: "zhangsan".into(),
            os_version: "Windows 11".into(),
        };
        enqueue(&conn, &facts, track_event("app_start"));
        flush(&conn); // 未配置地址（默认也留空）：只攒不发。
        assert_eq!(queue_len(&conn), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn disabled_telemetry_purges_queue_without_sending() {
        let (root, conn) = test_db();
        let (url, rx) = spawn_mock_server();
        let facts = Facts {
            install_id: "install-1".into(),
            host_name: "PC-A".into(),
            user_name: "zhangsan".into(),
            os_version: "Windows 11".into(),
        };
        enqueue(&conn, &facts, track_event("app_start"));
        set_settings(&conn, json!({ "enabled": false, "server_url": url }));
        flush(&conn);
        assert_eq!(queue_len(&conn), 0);
        assert!(rx.try_recv().is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn flush_retries_later_when_server_down() {
        let (root, conn) = test_db();
        // 端口存在但无人监听：发送失败，队列保留。
        let url = {
            let probe = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = probe.local_addr().unwrap().port();
            drop(probe);
            format!("http://127.0.0.1:{port}")
        };
        set_settings(&conn, json!({ "enabled": true, "server_url": url }));
        let facts = Facts {
            install_id: "install-1".into(),
            host_name: "PC-A".into(),
            user_name: "zhangsan".into(),
            os_version: "Windows 11".into(),
        };
        enqueue(&conn, &facts, track_event("tool_open"));
        flush(&conn);
        assert_eq!(queue_len(&conn), 1);
        let _ = std::fs::remove_dir_all(root);
    }
}
