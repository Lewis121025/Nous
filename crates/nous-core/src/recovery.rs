//! 未提交的编辑单独持久化，链接索引故障不能破坏恢复记录。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::Error;

/// 一次保存尝试的完整内容及其编辑基准。
#[derive(Debug)]
pub struct Draft {
    /// 用户编辑后的原始字节。
    pub bytes: Vec<u8>,
    /// 编辑基准；`None` 表示文件原先不存在。
    pub base: Option<Vec<u8>>,
}

pub(super) struct RecoveryStore(Mutex<Connection>);

impl RecoveryStore {
    pub(super) fn open(path: &Path) -> Result<Self, Error> {
        let conn = Connection::open(path).map_err(Error::Recovery)?;
        conn.execute_batch(
            "PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS drafts (
                 path TEXT PRIMARY KEY, bytes BLOB NOT NULL, base BLOB
             );
             CREATE TABLE IF NOT EXISTS rename_operation (
                 id INTEGER PRIMARY KEY CHECK (id = 1), from_path TEXT NOT NULL,
                 to_path TEXT NOT NULL, committed INTEGER NOT NULL CHECK (committed IN (0, 1))
             );
             CREATE TABLE IF NOT EXISTS rename_steps (
                 ordinal INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
                 before_bytes BLOB, after_bytes BLOB, permissions INTEGER NOT NULL,
                 started INTEGER NOT NULL CHECK (started IN (0, 1))
             );
             CREATE TABLE IF NOT EXISTS rename_directories (
                 ordinal INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE
             );",
        )
        .map_err(Error::Recovery)?;
        Ok(Self(Mutex::new(conn)))
    }

    pub(super) fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
        self.0
            .lock()
            .map_err(|_| Error::Io(std::io::Error::other("恢复记录锁已毒化")))
    }

    pub(super) fn put(&self, path: &str, bytes: &[u8], base: Option<&[u8]>) -> Result<(), Error> {
        self.lock()?
            .execute(
                "INSERT INTO drafts (path, bytes, base) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, base = excluded.base",
                params![path, bytes, base],
            )
            .map_err(Error::Recovery)?;
        Ok(())
    }

    pub(super) fn get(&self, path: &str) -> Result<Option<Draft>, Error> {
        self.lock()?
            .query_row(
                "SELECT bytes, base FROM drafts WHERE path = ?1",
                [path],
                |row| {
                    Ok(Draft {
                        bytes: row.get(0)?,
                        base: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(Error::Recovery)
    }

    pub(super) fn remove(&self, path: &str) -> Result<(), Error> {
        self.lock()?
            .execute("DELETE FROM drafts WHERE path = ?1", [path])
            .map_err(Error::Recovery)?;
        Ok(())
    }

    pub(super) fn paths(&self) -> Result<Vec<String>, Error> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT path FROM drafts ORDER BY path")
            .map_err(Error::Recovery)?;
        let paths = stmt
            .query_map([], |row| row.get(0))
            .map_err(Error::Recovery)?
            .collect::<Result<_, _>>()
            .map_err(Error::Recovery)?;
        Ok(paths)
    }
}
