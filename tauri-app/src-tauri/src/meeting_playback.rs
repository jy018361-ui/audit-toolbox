use crate::AppError;
use parking_lot::Mutex;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
};
use tauri::http::{Method, Request, Response, StatusCode, header};
use uuid::Uuid;

const MAX_RANGE_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
pub(crate) struct Playback(Mutex<Option<Arc<Media>>>);

struct Media {
    token: Uuid,
    file: Mutex<File>,
    length: u64,
    content_type: &'static str,
}

fn access_error(error: std::io::Error) -> AppError {
    AppError::new(
        "MEETING_PLAYBACK_FAILED",
        "无法打开本地录音，文件可能已被移动或删除。",
        true,
        Some(error.to_string()),
    )
}

impl Playback {
    pub(crate) fn open(&self, path: &Path) -> Result<String, AppError> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let content_type = match extension.as_str() {
            "wav" => "audio/wav",
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            "flac" => "audio/flac",
            "aac" => "audio/aac",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "wmv" => "video/x-ms-wmv",
            "avi" => "video/x-msvideo",
            _ => {
                return Err(AppError::new(
                    "MEETING_PLAYBACK_FORMAT",
                    "该文件格式无法在会议页试听。",
                    false,
                    None,
                ));
            }
        };
        let file = File::open(path).map_err(access_error)?;
        let metadata = file.metadata().map_err(access_error)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(AppError::new(
                "MEETING_PLAYBACK_EMPTY",
                "录音文件没有可播放的内容。",
                false,
                None,
            ));
        }
        let token = Uuid::new_v4();
        *self.0.lock() = Some(Arc::new(Media {
            token,
            file: Mutex::new(file),
            length: metadata.len(),
            content_type,
        }));
        Ok(token.to_string())
    }

    pub(crate) fn close(&self, token: &str) {
        let Ok(token) = Uuid::parse_str(token) else {
            return;
        };
        let mut current = self.0.lock();
        if current.as_ref().is_some_and(|media| media.token == token) {
            *current = None;
        }
    }

    pub(crate) fn respond(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let token = request
            .uri()
            .path()
            .strip_prefix('/')
            .and_then(|value| Uuid::parse_str(value).ok());
        let media = self
            .0
            .lock()
            .as_ref()
            .filter(|media| Some(media.token) == token)
            .cloned();
        let Some(media) = media else {
            return empty(StatusCode::NOT_FOUND);
        };
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            return empty(StatusCode::METHOD_NOT_ALLOWED);
        }
        let mut response = Response::builder()
            .header(header::CONTENT_TYPE, media.content_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff");
        if request.method() == Method::HEAD {
            return response
                .header(header::CONTENT_LENGTH, media.length)
                .body(Vec::new())
                .unwrap();
        }
        let range = request.headers().get(header::RANGE);
        let span = match range {
            Some(value) => value
                .to_str()
                .ok()
                .and_then(|value| parse_range(value, media.length)),
            None if media.length <= MAX_RANGE_BYTES => Some((0, media.length - 1)),
            None => None,
        };
        let Some((start, end)) = span else {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{}", media.length))
                .body(Vec::new())
                .unwrap();
        };
        let nbytes = end - start + 1;
        let mut bytes = vec![0; nbytes as usize];
        let mut file = media.file.lock();
        if file
            .seek(SeekFrom::Start(start))
            .and_then(|_| file.read_exact(&mut bytes))
            .is_err()
        {
            return empty(StatusCode::NOT_FOUND);
        }
        if range.is_some() {
            response = response.status(StatusCode::PARTIAL_CONTENT).header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{}", media.length),
            );
        }
        response
            .header(header::CONTENT_LENGTH, nbytes)
            .body(bytes)
            .unwrap()
    }
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let (first, last) = value.strip_prefix("bytes=")?.split_once('-')?;
    let last_byte = length.checked_sub(1)?;
    let (start, end) = if first.is_empty() {
        let suffix = last.parse::<u64>().ok()?;
        (length.saturating_sub(suffix), last_byte)
    } else {
        let first = first.parse::<u64>().ok()?;
        let last = if last.is_empty() {
            last_byte
        } else {
            last.parse::<u64>().ok()?.min(last_byte)
        };
        (first, last)
    };
    (start <= end).then(|| (start, end.min(start.saturating_add(MAX_RANGE_BYTES - 1))))
}

pub(crate) fn not_found() -> Response<Vec<u8>> {
    empty(StatusCode::NOT_FOUND)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_playback_reads_only_the_requested_bytes_for_the_active_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("录音.wav");
        std::fs::write(&path, b"0123456789").unwrap();
        let playback = Playback::default();
        let token = playback.open(&path).unwrap();
        let request = |token: &str, range: &str| {
            Request::builder()
                .uri(format!("http://meeting-audio.localhost/{token}"))
                .header(header::RANGE, range)
                .body(Vec::new())
                .unwrap()
        };
        let response = playback.respond(request(&token, "bytes=4-7"));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 4-7/10");
        assert_eq!(response.body(), b"4567");
        assert_eq!(playback.respond(request(&token, "bytes=-2")).body(), b"89");
        assert_eq!(
            playback.respond(request(&token, "bytes=10-")).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert_eq!(
            parse_range("bytes=0-", 3 * MAX_RANGE_BYTES),
            Some((0, MAX_RANGE_BYTES - 1))
        );
        let other = playback.open(&path).unwrap();
        playback.close(&token);
        assert_eq!(
            playback.respond(request(&token, "bytes=0-")).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            playback.respond(request(&other, "bytes=0-")).status(),
            StatusCode::PARTIAL_CONTENT
        );
        playback.close(&other);
        assert_eq!(
            playback.respond(request(&other, "bytes=0-")).status(),
            StatusCode::NOT_FOUND
        );
    }
}
