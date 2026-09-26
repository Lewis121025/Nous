//! `SQLite` 派生索引：链接图、标题、标签、属性与全文。
//!
//! 所有表都是磁盘 Markdown 的派生物，可随时全量重建；`user_version`
//! 记录扫描器版本，落后即重扫。

use std::collections::HashMap;

use rusqlite::{params, Connection};

use crate::error::Error;
use crate::link::{LinkKind, LinkRecord, LinkResolution};

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

/// 索引里的一行标题记录。
///
/// `start_byte`/`end_byte` 是标题节点在源文件的 UTF-8 字节区间，
/// 供锚点跳转映射编辑器位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadingRecord {
    /// 源文件库内相对路径。
    pub path: String,
    /// 标题等级（1–6）。
    pub level: i64,
    /// 去除行内语法后的标题纯文本。
    pub text: String,
    /// 区间起点（含）。
    pub start_byte: i64,
    /// 区间终点（不含）。
    pub end_byte: i64,
}

/// 一篇文件的派生索引行（标题/标签/属性/全文）。
///
/// 只随该文件重扫而重建；未改文件的派生行在刷新时保持不动。
pub(crate) struct DerivedRows {
    /// 标题行，按文档顺序。
    pub headings: Vec<HeadingRecord>,
    /// 规范化标签（小写、无 `#`）。
    pub tags: Vec<String>,
    /// frontmatter 属性行 `(key, value)`。
    pub attributes: Vec<(String, String)>,
    /// 全文行 `(title, body)`；非 Markdown 或不可解码文件为 `None`，不进全文索引。
    pub text: Option<(String, String)>,
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
    let tables: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table'
          AND name IN ('files', 'links', 'headings', 'tags', 'attributes', 'search_index')",
        [],
        |row| row.get(0),
    )?;
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
            end_byte INTEGER NOT NULL,
            resolution TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS links_from_path ON links(from_path);
        CREATE INDEX IF NOT EXISTS links_to_path ON links(to_path);
        CREATE TABLE IF NOT EXISTS headings (
            path TEXT NOT NULL,
            idx INTEGER NOT NULL,
            level INTEGER NOT NULL,
            text TEXT NOT NULL,
            start_byte INTEGER NOT NULL,
            end_byte INTEGER NOT NULL,
            PRIMARY KEY (path, idx)
        );
        CREATE TABLE IF NOT EXISTS tags (
            path TEXT NOT NULL,
            tag TEXT NOT NULL,
            PRIMARY KEY (path, tag)
        );
        CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
        CREATE TABLE IF NOT EXISTS attributes (
            path TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS attributes_path ON attributes(path);
        CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
            path UNINDEXED,
            title,
            body,
            tokenize = 'trigram'
        );
        ",
    )?;
    if tables != 6 {
        // 派生表被移除后，新建空表必须同时失效旧扫描版本；恢复库始终独立保留。
        conn.pragma_update(None, "user_version", 0)?;
    }
    ensure_link_resolution(&conn)?;
    Ok(conn)
}

/// 旧库的 `links` 没有解析状态列；补上默认值后由扫描版本触发全量重绑。
fn ensure_link_resolution(conn: &Connection) -> Result<(), Error> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('links') WHERE name = 'resolution')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        conn.execute(
            "ALTER TABLE links ADD COLUMN resolution TEXT NOT NULL DEFAULT 'dead'",
            [],
        )?;
    }
    Ok(())
}

/// 扫描器/解析输出格式。区间或目标解析变了必须加一，已打开的库才会重扫而不是复用旧行。
pub(crate) const SCAN_VERSION: i32 = 8;

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
    query_links(conn, &format!("SELECT {LINK_COLUMNS} FROM links"), None)
}

/// 读出每篇笔记的别名键；`alias` / `aliases` 之外的属性不参与链接解析。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_alias_keys(conn: &Connection) -> Result<HashMap<String, Vec<String>>, Error> {
    let mut stmt = conn.prepare(
        "SELECT path, key, value FROM attributes WHERE key = 'alias' OR key = 'aliases'",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut grouped: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for row in rows {
        let (path, key, value) = row?;
        grouped.entry(path).or_default().push((key, value));
    }
    let mut out = HashMap::new();
    for (path, attributes) in grouped {
        let keys = crate::identity::alias_keys(&attributes);
        if !keys.is_empty() {
            out.insert(path, keys);
        }
    }
    Ok(out)
}

/// 用当前文件集合替换 `files`/`links`，并增量同步派生表。
///
/// `files`/`links` 行小且刷新时已全量在手，维持整表重写；标题/标签/属性/全文
/// 按篇重建：`removals` 删除已消失路径的行，`derived` 只覆盖本次重扫过的文件，
/// 未改文件的派生行保持不动。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn replace_all(
    conn: &Connection,
    files: &[FileRow],
    links: &[LinkRecord],
    removals: &[String],
    derived: &[(String, DerivedRows)],
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
    for path in removals {
        delete_derived(&tx, path)?;
    }
    for (path, rows) in derived {
        replace_derived(&tx, path, rows)?;
    }
    tx.commit()?;
    conn.pragma_update(None, "user_version", SCAN_VERSION)?;
    Ok(())
}

/// 重建一篇文件的派生行；调用方保证事务语义。
fn replace_derived(
    tx: &rusqlite::Transaction<'_>,
    path: &str,
    rows: &DerivedRows,
) -> Result<(), Error> {
    delete_derived(tx, path)?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO headings(path, idx, level, text, start_byte, end_byte)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (idx, heading) in rows.headings.iter().enumerate() {
            let idx =
                i64::try_from(idx).map_err(|_| Error::Io(std::io::Error::other("标题序号溢出")))?;
            insert.execute(params![
                path,
                idx,
                heading.level,
                heading.text,
                heading.start_byte,
                heading.end_byte
            ])?;
        }
    }
    {
        let mut insert = tx.prepare("INSERT OR IGNORE INTO tags(path, tag) VALUES (?1, ?2)")?;
        for tag in &rows.tags {
            insert.execute(params![path, tag])?;
        }
    }
    {
        let mut insert =
            tx.prepare("INSERT INTO attributes(path, key, value) VALUES (?1, ?2, ?3)")?;
        for (key, value) in &rows.attributes {
            insert.execute(params![path, key, value])?;
        }
    }
    if let Some((title, body)) = &rows.text {
        tx.execute(
            "INSERT INTO search_index(path, title, body) VALUES (?1, ?2, ?3)",
            params![path, title, body],
        )?;
    }
    Ok(())
}

/// 删除一篇文件在全部派生表里的行。
fn delete_derived(conn: &Connection, path: &str) -> Result<(), Error> {
    conn.execute("DELETE FROM headings WHERE path = ?1", params![path])?;
    conn.execute("DELETE FROM tags WHERE path = ?1", params![path])?;
    conn.execute("DELETE FROM attributes WHERE path = ?1", params![path])?;
    conn.execute("DELETE FROM search_index WHERE path = ?1", params![path])?;
    Ok(())
}

/// 读取一篇文件的全部标题，按文档顺序。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn load_headings(conn: &Connection, path: &str) -> Result<Vec<HeadingRecord>, Error> {
    let mut stmt = conn.prepare(
        "SELECT path, level, text, start_byte, end_byte FROM headings
         WHERE path = ?1 ORDER BY idx",
    )?;
    let rows = stmt.query_map(params![path], |row| {
        Ok(HeadingRecord {
            path: row.get(0)?,
            level: row.get(1)?,
            text: row.get(2)?,
            start_byte: row.get(3)?,
            end_byte: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 只更新一篇文件及其出链与派生行，其它行的 `rowid` 保持不变。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn upsert_file(
    conn: &Connection,
    file: &FileRow,
    outgoing: &[LinkRecord],
    derived: &DerivedRows,
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
    replace_derived(&tx, &file.path, derived)?;
    tx.commit()?;
    Ok(())
}

/// 删除一篇文件及其出链与派生行。
///
/// # Errors
///
/// `SQLite` 失败时返回错误。
pub(crate) fn delete_file(conn: &Connection, path: &str) -> Result<(), Error> {
    conn.execute("DELETE FROM links WHERE from_path = ?1", params![path])?;
    conn.execute("DELETE FROM files WHERE path = ?1", params![path])?;
    delete_derived(conn, path)?;
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
        "INSERT INTO links(from_path, to_raw, to_path, kind, start_byte, end_byte, resolution)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for link in links {
        insert_link.execute(params![
            link.from_path,
            link.to_raw,
            link.to_path,
            link.kind.as_str(),
            link.start_byte,
            link.end_byte,
            link.resolution.as_str()
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
        &format!("SELECT {LINK_COLUMNS} FROM links WHERE to_path = ?1"),
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
        &format!("SELECT {LINK_COLUMNS} FROM links WHERE from_path = ?1"),
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
    let resolution_raw: String = row.get(6)?;
    let resolution = resolution_raw.parse::<LinkResolution>().map_err(|()| {
        rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "未知链接解析状态",
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
        resolution,
    })
}

const LINK_COLUMNS: &str = "from_path, to_raw, to_path, kind, start_byte, end_byte, resolution";
