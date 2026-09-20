//! `SQLite` 链接图。

use rusqlite::{params, Connection};

use crate::error::Error;
use crate::link::{LinkKind, LinkRecord};

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

/// 用当前文件集合替换索引。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub fn replace_all(
    conn: &Connection,
    files: &[(String, String, String, i64, String)],
    links: &[LinkRecord],
) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("DELETE FROM links; DELETE FROM files;")?;
    {
        let mut insert_file = tx.prepare(
            "INSERT INTO files(path, title, kind, mtime, content_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for (path, title, kind, mtime, hash) in files {
            insert_file.execute(params![path, title, kind, mtime, hash])?;
        }
    }
    {
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
    }
    tx.commit()?;
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
        path,
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
        path,
    )
}

fn query_links(conn: &Connection, sql: &str, path: &str) -> Result<Vec<LinkRecord>, Error> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![path], |row| {
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
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
