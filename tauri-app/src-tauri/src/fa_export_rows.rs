//! Replay computed output rows without re-reading/recalculating the source.
//! Small sheets stay in memory; larger sheets spill to a temporary JSONL file.

use super::{AppError, io_error};
use std::{fs::{self, File, OpenOptions}, io::{BufRead, BufReader, BufWriter, Write}, path::PathBuf};

const MEMORY_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub(super) struct PreparedRows {
    memory: Vec<Vec<String>>,
    bytes: usize,
    spool: Option<Spool>,
    pub(super) count: usize,
}

struct Spool {
    path: PathBuf,
    writer: Option<BufWriter<File>>,
}

impl Drop for Spool {
    fn drop(&mut self) {
        drop(self.writer.take());
        let _ = fs::remove_file(&self.path);
    }
}

impl Spool {
    fn new() -> Result<Self, AppError> {
        let dir = std::env::temp_dir().join("AuditToolbox").join("export-rows");
        fs::create_dir_all(&dir).map_err(io_error)?;
        let path = dir.join(format!("{}.jsonl", uuid::Uuid::new_v4().simple()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(io_error)?;
        Ok(Self { path, writer: Some(BufWriter::new(file)) })
    }

    fn push(&mut self, row: &[String]) -> Result<(), AppError> {
        let writer = self.writer.as_mut().expect("尚未开始回放");
        serde_json::to_writer(&mut *writer, row).map_err(|e| io_error(std::io::Error::other(e)))?;
        writer.write_all(b"\n").map_err(io_error)
    }
}

impl PreparedRows {
    /// Replay already prepared narrow rows while retaining the bounded store.
    /// The borrow keeps its temporary file alive even on early iterator drop.
    pub(super) fn replay(&mut self) -> Result<Box<dyn Iterator<Item = Result<Vec<String>, AppError>> + '_>, AppError> {
        if let Some(spool) = self.spool.as_mut() {
            if let Some(writer) = spool.writer.as_mut() { writer.flush().map_err(io_error)?; }
            let reader = BufReader::new(File::open(&spool.path).map_err(io_error)?).lines();
            Ok(Box::new(reader.map(|line| {
                serde_json::from_str(&line.map_err(io_error)?).map_err(|e| io_error(std::io::Error::other(e)))
            })))
        } else {
            Ok(Box::new(self.memory.iter().cloned().map(Ok)))
        }
    }

    pub(super) fn push(&mut self, row: Vec<String>) -> Result<(), AppError> {
        // Include String/Vec storage, so even empty strings cannot grow without bound.
        self.bytes = self.bytes.saturating_add(std::mem::size_of::<Vec<String>>()
            + row.iter().map(|s| std::mem::size_of::<String>() + s.len()).sum::<usize>());
        if self.spool.is_none() && self.bytes > MEMORY_BYTES {
            let mut spool = Spool::new()?;
            for buffered in self.memory.drain(..) { spool.push(&buffered)?; }
            self.spool = Some(spool);
        }
        if let Some(spool) = self.spool.as_mut() { spool.push(&row)?; }
        else { self.memory.push(row); }
        self.count += 1;
        Ok(())
    }

    pub(super) fn into_rows(self) -> Result<Box<dyn Iterator<Item = Result<Vec<String>, AppError>>>, AppError> {
        if let Some(mut spool) = self.spool {
            spool.writer.as_mut().unwrap().flush().map_err(io_error)?;
            drop(spool.writer.take());
            let reader = BufReader::new(File::open(&spool.path).map_err(io_error)?).lines();
            Ok(Box::new(SpoolRows { reader, _spool: spool }))
        } else {
            Ok(Box::new(self.memory.into_iter().map(Ok)))
        }
    }
}

struct SpoolRows {
    // Close the reader before Spool removes the file (also on early drop/cancel).
    reader: std::io::Lines<BufReader<File>>,
    _spool: Spool,
}

impl Iterator for SpoolRows {
    type Item = Result<Vec<String>, AppError>;
    fn next(&mut self) -> Option<Self::Item> {
        self.reader.next().map(|line| {
            let line = line.map_err(io_error)?;
            serde_json::from_str(&line).map_err(|e| io_error(std::io::Error::other(e)))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spill_roundtrip_and_early_drop_remove_temporary_file() {
        let mut rows = PreparedRows::default();
        let row = vec!["资产\n\"含转义\"".repeat(10_000), "00123".into(), "=H3".into()];
        for _ in 0..12 { rows.push(row.clone()).unwrap(); }
        assert_eq!(rows.count, 12);
        let path = rows.spool.as_ref().unwrap().path.clone();
        for _ in 0..3 {
            assert_eq!(rows.replay().unwrap().collect::<Result<Vec<_>, _>>().unwrap(), vec![row.clone(); 12]);
        }
        let mut reader = rows.into_rows().unwrap();
        assert_eq!(reader.next().unwrap().unwrap(), row);
        assert!(path.exists());
        drop(reader);
        assert!(!path.exists());
    }

    #[test]
    fn small_sheets_and_abandoned_preparation_cleanup() {
        let mut rows = PreparedRows::default();
        rows.push(vec!["".into(), "中文".into()]).unwrap();
        assert!(rows.spool.is_none());
        assert_eq!(rows.into_rows().unwrap().collect::<Result<Vec<_>, _>>().unwrap(), vec![vec!["", "中文"]]);
        let mut rows = PreparedRows::default();
        rows.push(vec!["x".repeat(MEMORY_BYTES + 1)]).unwrap();
        let path = rows.spool.as_ref().unwrap().path.clone();
        drop(rows);
        assert!(!path.exists());
    }
}
