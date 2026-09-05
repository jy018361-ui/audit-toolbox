// 使用统计（匿名埋点）：记录「启动软件 / 打开工具 / 执行任务 / 退出软件」
// 四类事件，先落本机 SQLite 队列，后台线程批量上报到部门自建统计服务器。
// 纯后台功能：无任何界面入口，使用者不可见。
//
// 服务器地址由内网自动发现：本模块向局域网广播 UDP 探测包，统计服务器
// （独立工程 metrics-server）应答自身地址。任何地址都不经人手录进客户端。
//
// 红线（结构性约束，不是口头承诺）：
// 1. 事件字段只有统计必需项（见 enqueue），不存在携带文件路径、账表内容、
//    客户数据的通道；
// 2. 发送失败静默保留在本地（封顶 5000 条），绝不影响主流程、绝不报错弹窗；
// 3. 需要停用某台机器时，向本机数据库写入 telemetry.enabled=false 即可，
//    停用后连同本地攒着的事件一并清空。

use parking_lot::Mutex;
use rusqlite::{Connection, params, params_from_iter};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::UdpSocket,
    path::PathBuf,
    sync::{Arc, OnceLock, mpsc},
    time::{Duration, Instant},
};

/// 出厂内置的统计服务器地址兜底（正常情况留空，靠内网自动发现拿地址）。
pub(crate) const DEFAULT_SERVER_URL: &str = "";

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_QUEUED: i64 = 5_000;
const SEND_TIMEOUT: Duration = Duration::from_secs(3);
const RETRY_INTERVAL: Duration = Duration::from_secs(120);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// 内网自动发现：探测包发往统计服务器的这个 UDP 端口，服务器应答自身地址。
/// 与 metrics-server 的 DISCOVERY_PORT 保持一致。
const DISCOVERY_PORT: u16 = 8790;
const PROBE_BYTES: &[u8] = br#"{"service":"audit-toolbox-metrics","type":"probe"}"#;
const DISCOVERY_META_KEY: &str = "discovered_url";

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
    // 启动先在内网找一次服务器（后台线程内最长 2 秒，不碰界面）；
    // 找不到就用上次记住的地址（重启后不必等发现即可先补发）。
    let mut discovered = refresh_discovery(&conn).unwrap_or_else(|| load_saved_urls(&conn));
    loop {
        match rx.recv_timeout(RETRY_INTERVAL) {
            Ok(Msg::Track(event)) => {
                enqueue(&conn, &facts, event);
                flush(&conn, &discovered);
            }
            Ok(Msg::Shutdown(ack)) => {
                flush(&conn, &discovered);
                let _ = ack.send(());
                break;
            }
            // 空闲超时：重新找一次服务器（换机器/换网段后自动跟上），再冲队列。
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(urls) = refresh_discovery(&conn) {
                    discovered = urls;
                }
                flush(&conn, &discovered);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                flush(&conn, &discovered);
                break;
            }
        }
    }
}

/// 探测一次内网；找到就落库记住，供下次启动直接使用。
fn refresh_discovery(conn: &Connection) -> Option<Vec<String>> {
    let discovered = discover_server_url()?;
    if load_saved_urls(conn) != discovered {
        save_discovered_urls(conn, &discovered);
    }
    Some(discovered)
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
        let catalog: Value = serde_json::from_str(include_str!("../../public/tool-catalog.json"))
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
    let tool_name = event.tool_name.or_else(|| {
        event
            .tool_id
            .as_deref()
            .and_then(|id| tool_name_map().get(id).cloned())
    });
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

// ---------- 服务器地址自动发现 ----------

/// 从应答包里解析服务器地址候选：主地址（出口 IP）在前，兜底地址（电脑名）
/// 在后。不是本服务的应答、或没有合法 http 地址，一律忽略（内网广播可能撞上别的服务）。
fn parse_announcement(bytes: &[u8]) -> Option<Vec<String>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let is_ours = value.get("service").and_then(Value::as_str) == Some("audit-toolbox-metrics")
        && value.get("type").and_then(Value::as_str) == Some("announce");
    if !is_ours {
        return None;
    }
    let mut urls: Vec<String> = ["url", "alt_url"]
        .iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|url| url.starts_with("http"))
        .map(str::to_string)
        .collect();
    urls.dedup();
    (!urls.is_empty()).then_some(urls)
}

fn probe_socket(targets: &[String]) -> Option<UdpSocket> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.set_broadcast(true).ok()?;
    for target in targets {
        let _ = socket.send_to(PROBE_BYTES, target);
    }
    Some(socket)
}

/// 发完探测后等应答：单次收包超时 1.2 秒，总时限 2 秒；期间只认合法应答。
fn await_announcement(socket: &UdpSocket) -> Option<Vec<String>> {
    socket
        .set_read_timeout(Some(Duration::from_millis(1200)))
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut buf = [0u8; 1024];
    loop {
        match socket.recv_from(&mut buf) {
            Ok((n, _)) => {
                if let Some(urls) = parse_announcement(&buf[..n]) {
                    return Some(urls);
                }
            }
            Err(_) if Instant::now() >= deadline => return None,
            Err(_) => continue,
        }
    }
}

/// 向指定地址探测（定点/测试场景）。
fn probe_at(target: &str) -> Option<Vec<String>> {
    let socket = probe_socket(&[target.to_string()])?;
    await_announcement(&socket)
}

/// 内网广播找统计服务器；同机部署（服务器装在自己电脑）时补一发环回探测。
fn discover_server_url() -> Option<Vec<String>> {
    let socket = probe_socket(&[
        format!("255.255.255.255:{DISCOVERY_PORT}"),
        format!("127.0.0.1:{DISCOVERY_PORT}"),
    ])?;
    await_announcement(&socket)
}

/// 记住的地址列表（每行一个），下次启动不必等发现即可先补发。
fn load_saved_urls(conn: &Connection) -> Vec<String> {
    let saved: Option<String> = conn
        .query_row(
            "SELECT value FROM telemetry_meta WHERE key=?1",
            [DISCOVERY_META_KEY],
            |row| row.get(0),
        )
        .ok();
    saved
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|url| !url.is_empty() && url.starts_with("http"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn save_discovered_urls(conn: &Connection, urls: &[String]) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO telemetry_meta(key, value) VALUES(?1, ?2)",
        params![DISCOVERY_META_KEY, urls.join("\n")],
    );
}

struct TelemetryConfig {
    enabled: bool,
    server_url: Option<String>,
}

/// 本机数据库里的 `telemetry` 覆盖键：`{"enabled": bool, "server_url": "http://…:8787"}`。
/// 纯内部后门（无界面入口）：键不存在时按出厂默认处理；enabled=false 静默停用。
/// 这里的 server_url 只反映覆盖键里手写的地址，自动发现与出厂常量在 flush 里按优先级并入。
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
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let server_url = value
        .get("server_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string);
    TelemetryConfig {
        enabled,
        server_url,
    }
}

/// 地址优先级：内部覆盖键 > 内网自动发现（IP 在前、电脑名兜底在后）> 出厂常量。
/// 发送时按顺序逐个候选地址尝试。
fn flush(conn: &Connection, discovered: &[String]) {
    let config = telemetry_config(conn);
    if !config.enabled {
        // 覆盖键停用统计：本地攒着的一并清空。
        let _ = conn.execute("DELETE FROM telemetry_queue", []);
        return;
    }
    let candidates: Vec<String> = if let Some(url) = config.server_url {
        vec![url]
    } else if !discovered.is_empty() {
        discovered.to_vec()
    } else if !DEFAULT_SERVER_URL.is_empty() {
        vec![DEFAULT_SERVER_URL.to_string()]
    } else {
        return; // 还不知道服务器在哪：先攒着，发现后一起补发。
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
        let mut sent = false;
        for candidate in &candidates {
            if send_batch(candidate, &events) {
                sent = true;
                break;
            }
        }
        if !sent {
            return; // 所有候选地址都发不出去：留着，下次事件或定时重试时再补。
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
                            let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
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
        flush(&conn, &[]);
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
        flush(&conn, &[]); // 未发现服务器（默认也留空）：只攒不发。
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
        flush(&conn, &[]);
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
        flush(&conn, &[]);
        assert_eq!(queue_len(&conn), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discovered_url_is_used_and_overrides_default_order() {
        let (root, conn) = test_db();
        // 场景一：无覆盖键时，自动发现的地址直接生效。
        let (discovered_url, rx) = spawn_mock_server();
        let facts = Facts {
            install_id: "install-1".into(),
            host_name: "PC-A".into(),
            user_name: "zhangsan".into(),
            os_version: "Windows 11".into(),
        };
        enqueue(&conn, &facts, track_event("tool_open"));
        flush(&conn, &[discovered_url.clone()]);
        assert!(
            rx.recv_timeout(Duration::from_secs(5))
                .unwrap()
                .contains("tool_open")
        );

        // 场景二：覆盖键优先于自动发现（发现指向死端口，覆盖键指向活服务器）。
        let (override_url, rx2) = spawn_mock_server();
        let dead = {
            let probe = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = probe.local_addr().unwrap().port();
            drop(probe);
            format!("http://127.0.0.1:{port}")
        };
        set_settings(
            &conn,
            json!({ "enabled": true, "server_url": override_url }),
        );
        enqueue(&conn, &facts, track_event("job_run"));
        flush(&conn, &[dead]);
        assert!(
            rx2.recv_timeout(Duration::from_secs(5))
                .unwrap()
                .contains("job_run")
        );
        assert_eq!(queue_len(&conn), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn flush_falls_back_to_hostname_address_when_ip_unreachable() {
        let (root, conn) = test_db();
        // 模拟 VPN 场景：发现的 IP 地址是死的，排在后面的电脑名地址才是活的。
        let dead = {
            let probe = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = probe.local_addr().unwrap().port();
            drop(probe);
            format!("http://127.0.0.1:{port}")
        };
        let (live, rx) = spawn_mock_server();
        let facts = Facts {
            install_id: "install-1".into(),
            host_name: "PC-A".into(),
            user_name: "zhangsan".into(),
            os_version: "Windows 11".into(),
        };
        enqueue(&conn, &facts, track_event("app_start"));
        flush(&conn, &[dead, live]);
        assert!(
            rx.recv_timeout(Duration::from_secs(5))
                .unwrap()
                .contains("app_start")
        );
        assert_eq!(queue_len(&conn), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discovered_urls_persist_for_next_launch() {
        let (root, conn) = test_db();
        let urls: Vec<String> = vec![
            "http://192.168.1.10:8787".into(),
            "http://SERVER-PC:8787".into(),
        ];
        save_discovered_urls(&conn, &urls);
        drop(conn);
        let reopened = Connection::open(root.join("t.db")).unwrap();
        assert_eq!(load_saved_urls(&reopened), urls);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn parse_announcement_filters_foreign_packets() {
        let valid =
            br#"{"service":"audit-toolbox-metrics","type":"announce","url":"http://10.0.0.5:8787","alt_url":"http://SERVER-PC:8787"}"#;
        assert_eq!(
            parse_announcement(valid),
            Some(vec![
                "http://10.0.0.5:8787".to_string(),
                "http://SERVER-PC:8787".to_string(),
            ])
        );
        // 别的服务的广播、坏 JSON、非 http 地址一律不认。
        assert!(
            parse_announcement(br#"{"service":"someone-else","type":"announce","url":"http://x"}"#)
                .is_none()
        );
        assert!(parse_announcement(b"not json").is_none());
        assert!(
            parse_announcement(
                br#"{"service":"audit-toolbox-metrics","type":"announce","url":"ftp://x"}"#
            )
            .is_none()
        );
    }

    /// 内网里起一个只应答固定内容的假统计服务器，验证探测→应答→解析全链路。
    fn spawn_udp_responder(reply: &'static [u8]) -> String {
        use std::net::UdpSocket;
        let responder = UdpSocket::bind("127.0.0.1:0").unwrap();
        let addr = responder.local_addr().unwrap().to_string();
        std::thread::spawn(move || {
            let mut buf = [0u8; 256];
            if let Ok((n, peer)) = responder.recv_from(&mut buf) {
                if &buf[..n] == PROBE_BYTES {
                    let _ = responder.send_to(reply, peer);
                }
            }
        });
        addr
    }

    #[test]
    fn probe_at_resolves_announcing_server() {
        let addr = spawn_udp_responder(
            br#"{"service":"audit-toolbox-metrics","type":"announce","url":"http://192.168.1.10:8787","port":8787}"#,
        );
        assert_eq!(
            probe_at(&addr),
            Some(vec!["http://192.168.1.10:8787".to_string()])
        );
    }

    #[test]
    fn probe_at_ignores_non_announce_replies() {
        let addr = spawn_udp_responder(b"hello-lan");
        assert!(probe_at(&addr).is_none());
    }
}
