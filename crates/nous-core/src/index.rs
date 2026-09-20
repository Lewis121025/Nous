//! `SQLite` 链接图。

use rusqlite::{params, Connection};

use crate::error::Error;
use crate::link::{LinkKind, LinkRecord};

/// 索引里的一行文件记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileRow {
    /// 库内相对路径。
    pub path: String,
    /// 展示标题。
    pub title: String,
    /// `markdown` 或 `other`。
    pub kind: String,
    /// 内容修改时间（自纪元起的纳秒）。
    pub mtime: i64,
    /// 内容 SHA-256 十六进制。
    pub content_hash: String,
}

/// 打开或创建索引库并建表。
///
/// # Errors
///
/// `SQLite` 失败时返回 IO 包装错误。
pub fn open_connection(path: &std::path::Path) -> Result<Connection, Error> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            kind TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            content_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY,
            from_path TEXT NOT NULL,
            to_raw TEXT NOT NULL,
            to_path TEXT,
            kind TEXT NOT NULL,
            start_byte INTEGER NOT NULL,
            end_byte INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS links_from_path ON links(from_path);
        CREATE INDEX IF NOT EXISTS links_to_path ON links(to_path);
        ",
    )?;
    Ok(conn)
}

/// 扫描器/解析输出格式。区间或目标解析变了必须加一，已打开的库才会重扫而不是复用旧行。
pub(crate) const SCAN_VERSION: i32 = 2;

/// 当前索引里记录的扫描器版本；从未写过则为 0。
pub(crate) fn scan_version(conn: &Connection) -> Result<i32, Error> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

/// 读出当前全部文件行。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_files(conn: &Connection) -> Result<Vec<FileRow>, Error> {
    let mut stmt = conn.prepare("SELECT path, title, kind, mtime, content_hash FROM files")?;
    let rows = stmt.query_map([], |row| {
        Ok(FileRow {
            path: row.get(0)?,
            title: row.get(1)?,
            kind: row.get(2)?,
            mtime: row.get(3)?,
            content_hash: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 读出当前全部链接。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_links(conn: &Connection) -> Result<Vec<LinkRecord>, Error> {
    query_links(
        conn,
        "SELECT from_path, to_raw, to_path, kind, start_byte, end_byte FROM links",
        None,
    )
}

/// 用当前文件集合替换索引。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn replace_all(
    conn: &Connection,
    files: &[FileRow],
    links: &[LinkRecord],
) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM links; DELETE FROM files;")?;
    {
        let mut insert_file = tx.prepare(
            "INSERT INTO files(path, title, kind, mtime, content_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for file in files {
            insert_file.execute(params![
                file.path,
                file.title,
                file.kind,
                file.mtime,
                file.content_hash
            ])?;
        }
    }
    insert_link_rows(&tx, links)?;
    tx.commit()?;
    conn.pragma_update(None, "user_version", SCAN_VERSION)?;
    Ok(())
}

/// 只更新一篇文件及其出链，其它行的 `rowid` 保持不变。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn upsert_file(
    conn: &Connection,
    file: &FileRow,
    outgoing: &[LinkRecord],
) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM links WHERE from_path = ?1", params![file.path])?;
    tx.execute(
        "INSERT INTO files(path, title, kind, mtime, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            kind = excluded.kind,
            mtime = excluded.mtime,
            content_hash = excluded.content_hash",
        params![
            file.path,
            file.title,
            file.kind,
            file.mtime,
            file.content_hash
        ],
    )?;
    insert_link_rows(&tx, outgoing)?;
    tx.commit()?;
    Ok(())
}

/// 删除一篇文件及其出链。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn delete_file(conn: &Connection, path: &str) -> Result<(), Error> {
    conn.execute("DELETE FROM links WHERE from_path = ?1", params![path])?;
    conn.execute("DELETE FROM files WHERE path = ?1", params![path])?;
    Ok(())
}

/// 用当前链接集合替换 `links` 表，不动 `files`。
///
/// 文件集合变了、需要重绑 `to_path` 时用这个，避免把未改动的文件行删掉重建。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn replace_links(conn: &Connection, links: &[LinkRecord]) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM links;")?;
    insert_link_rows(&tx, links)?;
    tx.commit()?;
    Ok(())
}

fn insert_link_rows(tx: &rusqlite::Transaction<'_>, links: &[LinkRecord]) -> Result<(), Error> {
    let mut insert_link = tx.prepare(
        "INSERT INTO links(from_path, to_raw, to_path, kind, start_byte, end_byte)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for link in links {
        insert_link.execute(params![
            link.from_path,
            link.to_raw,
            link.to_path,
            link.kind.as_str(),
            link.start_byte,
            link.end_byte
        ])?;
    }
    Ok(())
}

/// 查询指向 `path` 的入链。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub fn links_to(conn: &Connection, path: &str) -> Result<Vec<LinkRecord>, Error> {
    query_links(
        conn,
        "SELECT from_path, to_raw, to_path, kind, start_byte, end_byte FROM links WHERE to_path = ?1",
        Some(path),
    )
}

/// 查询 `path` 的出链。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub fn links_from(conn: &Connection, path: &str) -> Result<Vec<LinkRecord>, Error> {
    query_links(
        conn,
        "SELECT from_path, to_raw, to_path, kind, start_byte, end_byte FROM links WHERE from_path = ?1",
        Some(path),
    )
}

fn query_links(conn: &Connection, sql: &str, path: Option<&str>) -> Result<Vec<LinkRecord>, Error> {
    let mut stmt = conn.prepare(sql)?;
    let mut out = Vec::new();
    if let Some(path) = path {
        for row in stmt.query_map(params![path], map_link_row)? {
            out.push(row?);
        }
    } else {
        for row in stmt.query_map([], map_link_row)? {
            out.push(row?);
        }
    }
    Ok(out)
}

fn map_link_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LinkRecord> {
    let kind_raw: String = row.get(3)?;
    let kind = kind_raw.parse::<LinkKind>().map_err(|()| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "未知链接种类",
            )),
        )
    })?;
    Ok(LinkRecord {
        from_path: row.get(0)?,
        to_raw: row.get(1)?,
        to_path: row.get(2)?,
        kind,
        start_byte: row.get(4)?,
        end_byte: row.get(5)?,
    })
}
