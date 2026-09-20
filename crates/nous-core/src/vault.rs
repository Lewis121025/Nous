//! 笔记库：根目录约束下的原始字节读写与链接索引。

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::Error;
use crate::index::{self, FileRow};
use crate::link::LinkRecord;
use crate::pathutil::resolve_in_root;
use crate::scan;

/// 已打开的笔记库。
///
/// `root` 是笔记文件的唯一真相；`index_dir` 仅存放索引，由调用方提供且应在库外。
pub struct Vault {
    root: PathBuf,
    index_dir: PathBuf,
    conn: Mutex<Connection>,
    /// 索引提交代次：刷新若带着更早快照回来则丢弃，避免盖住已经提交的写入。
    index_epoch: AtomicU64,
}

impl Vault {
    /// 打开目录作为库根并重建链接索引。
    ///
    /// `root` 必须已存在且为目录。`index_dir` 若不存在则创建。
    ///
    /// # Errors
    ///
    /// 根不是目录、无法创建索引目录或索引写入失败时返回错误。
    pub fn open(root: impl AsRef<Path>, index_dir: impl AsRef<Path>) -> Result<Self, Error> {
        let root = root.as_ref().to_path_buf();
        let metadata = fs::metadata(&root)?;
        if !metadata.is_dir() {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "库根必须是目录",
            )));
        }
        let index_dir = index_dir.as_ref().to_path_buf();
        fs::create_dir_all(&index_dir)?;
        let conn = index::open_connection(&index_dir.join("index.sqlite"))?;
        let vault = Self {
            root,
            index_dir,
            conn: Mutex::new(conn),
            index_epoch: AtomicU64::new(0),
        };
        vault.refresh_index()?;
        Ok(vault)
    }

    /// 按磁盘现状刷新链接索引。
    ///
    /// `mtime` 未变的文件不读内容；内容哈希未变则只更新时间戳。
    /// 扫描器版本落后时忽略上述跳过，全量重扫。
    /// 文件集合变了才重算全库链接指向。
    ///
    /// 文件监视在防抖后调用；外部改盘不会走 `write`，必须显式刷新。
    ///
    /// # Errors
    ///
    /// 读盘或写索引失败。
    pub fn refresh_index(&self) -> Result<(), Error> {
        let files = self.list_files()?;
        let (indexed_files, indexed_links, stale_scan, epoch) = {
            let conn = self.lock_conn()?;
            (
                index::load_files(&conn)?,
                index::load_links(&conn)?,
                index::scan_version(&conn)? != index::SCAN_VERSION,
                self.index_epoch.load(Ordering::SeqCst),
            )
        };
        let by_path: HashMap<String, FileRow> = indexed_files
            .into_iter()
            .map(|row| (row.path.clone(), row))
            .collect();
        let mut links_by: HashMap<String, Vec<LinkRecord>> = HashMap::new();
        for link in indexed_links {
            links_by
                .entry(link.from_path.clone())
                .or_default()
                .push(link);
        }

        let disk_set: HashSet<&str> = files.iter().map(String::as_str).collect();
        let indexed_set: HashSet<&str> = by_path.keys().map(String::as_str).collect();
        let set_changed = disk_set != indexed_set;

        let mut file_rows = Vec::new();
        let mut links = Vec::new();
        for rel in &files {
            let abs = resolve_in_root(&self.root, rel)?;
            let meta = fs::metadata(&abs)?;
            let mtime = mtime_stamp(&meta);
            if !stale_scan {
                if let Some(old) = by_path.get(rel) {
                    if old.mtime == mtime {
                        file_rows.push(old.clone());
                        if let Some(existing) = links_by.get(rel) {
                            links.extend(existing.iter().cloned());
                        }
                        continue;
                    }
                }
            }
            let bytes = fs::read(&abs)?;
            let hash = hex_sha256(&bytes);
            if !stale_scan {
                if let Some(old) = by_path.get(rel) {
                    if old.content_hash == hash {
                        let mut updated = old.clone();
                        updated.mtime = mtime;
                        file_rows.push(updated);
                        if let Some(existing) = links_by.get(rel) {
                            links.extend(existing.iter().cloned());
                        }
                        continue;
                    }
                }
            }
            file_rows.push(file_row_from_bytes(rel, &bytes, mtime));
            links.extend(extract_resolved(rel, &bytes, &files));
        }

        if set_changed {
            for link in &mut links {
                link.to_path = resolve_against(&files, &link.from_path, &link.to_raw, link.kind);
            }
        }

        let conn = self.lock_conn()?;
        if self.index_epoch.load(Ordering::SeqCst) != epoch {
            return Ok(());
        }
        index::replace_all(&conn, &file_rows, &links)?;
        self.index_epoch.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
        self.conn
            .lock()
            .map_err(|_| Error::Io(io::Error::other("索引锁已毒化")))
    }

    /// 库根。
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 索引目录。
    #[must_use]
    pub fn index_dir(&self) -> &Path {
        &self.index_dir
    }

    /// 读取相对路径文件的原始字节。
    ///
    /// # Errors
    ///
    /// 路径越界返回 [`Error::PathEscape`]；文件不存在返回 [`Error::NotFound`]。
    pub fn read(&self, rel: &str) -> Result<Vec<u8>, Error> {
        let path = resolve_in_root(&self.root, rel)?;
        match fs::read(&path) {
            Ok(bytes) => Ok(bytes),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Err(Error::NotFound { path }),
            Err(err) => Err(Error::Io(err)),
        }
    }

    /// 原子写入相对路径，成功后重扫该文件所属索引。
    ///
    /// # Errors
    ///
    /// 路径越界返回 [`Error::PathEscape`]。
    pub fn write(&self, rel: &str, bytes: &[u8]) -> Result<(), Error> {
        self.write_disk(rel, bytes)?;
        self.reindex_written(rel, bytes)
    }

    fn write_disk(&self, rel: &str, bytes: &[u8]) -> Result<(), Error> {
        let path = resolve_in_root(&self.root, rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("nous-tmp");
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        fs::rename(&tmp, &path)?;
        if let Some(parent) = path.parent() {
            let dir = File::open(parent)?;
            dir.sync_all()?;
        }
        Ok(())
    }

    /// 列出库内文件的相对路径（跳过以 `.` 开头的目录与文件）。
    ///
    /// # Errors
    ///
    /// 读目录失败时返回 IO 错误。
    pub fn list_files(&self) -> Result<Vec<String>, Error> {
        let mut out = Vec::new();
        collect_files(&self.root, &self.root, &mut out)?;
        out.sort();
        Ok(out)
    }

    /// 指向 `path` 的入链。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn links_to(&self, path: &str) -> Result<Vec<LinkRecord>, Error> {
        let conn = self.lock_conn()?;
        index::links_to(&conn, path)
    }

    /// `path` 的出链。
    ///
    /// # Errors
    ///
    /// 索引查询失败。
    pub fn links_from(&self, path: &str) -> Result<Vec<LinkRecord>, Error> {
        let conn = self.lock_conn()?;
        index::links_from(&conn, path)
    }

    /// 把 `from` 文件中的链接原文解析为库内路径。
    ///
    /// wiki 仅在文件名唯一时命中；Markdown 相对路径按源文件目录拼接。
    #[must_use]
    pub fn resolve_link(
        &self,
        from: &str,
        raw: &str,
        kind: crate::link::LinkKind,
    ) -> Option<String> {
        let Ok(files) = self.list_files() else {
            return None;
        };
        resolve_against(&files, from, raw, kind)
    }

    /// 将库内文件改名为 `to`（相对路径），并按字节区间更新全库链接。
    ///
    /// 目标已存在则失败且不改任何文件。失败时尽量把已写入的文件恢复为改名前快照。
    ///
    /// # Errors
    ///
    /// 越界、源不存在、目标已存在或 IO/索引失败。
    pub fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        if from == to {
            return Ok(());
        }
        let from_abs = resolve_in_root(&self.root, from)?;
        let to_abs = resolve_in_root(&self.root, to)?;
        if !from_abs.is_file() {
            return Err(Error::NotFound { path: from_abs });
        }
        if to_abs.exists() {
            return Err(Error::AlreadyExists { path: to_abs });
        }

        let incoming = self.links_to(from)?;
        let mut by_file: std::collections::HashMap<String, Vec<LinkRecord>> =
            std::collections::HashMap::new();
        for link in incoming {
            by_file
                .entry(link.from_path.clone())
                .or_default()
                .push(link);
        }

        let mut snapshots: std::collections::HashMap<String, Vec<u8>> =
            std::collections::HashMap::new();
        let mut patched: std::collections::HashMap<String, Vec<u8>> =
            std::collections::HashMap::new();

        for (path, mut links) in by_file {
            links.sort_by_key(|link| std::cmp::Reverse(link.start_byte));
            let mut bytes = self.read(&path)?;
            snapshots.insert(path.clone(), bytes.clone());
            for link in links {
                let start = usize::try_from(link.start_byte).map_err(|_| {
                    Error::Io(io::Error::new(io::ErrorKind::InvalidData, "链接起点溢出"))
                })?;
                let end = usize::try_from(link.end_byte).map_err(|_| {
                    Error::Io(io::Error::new(io::ErrorKind::InvalidData, "链接终点溢出"))
                })?;
                if end > bytes.len() || start > end {
                    return Err(Error::Io(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "链接区间超出文件",
                    )));
                }
                let original = std::str::from_utf8(&bytes[start..end]).map_err(|_| {
                    Error::Io(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "链接区间不是 UTF-8",
                    ))
                })?;
                let new_target = match link.kind {
                    crate::link::LinkKind::Wiki => crate::rewrite::wiki_target_name(to),
                    crate::link::LinkKind::Markdown => {
                        crate::rewrite::relative_markdown_url(&path, to)
                    }
                };
                let replacement = crate::rewrite::rewrite_span(link.kind, original, &new_target);
                let mut next = Vec::with_capacity(bytes.len() - (end - start) + replacement.len());
                next.extend_from_slice(&bytes[..start]);
                next.extend_from_slice(replacement.as_bytes());
                next.extend_from_slice(&bytes[end..]);
                bytes = next;
            }
            patched.insert(path, bytes);
        }

        for (path, bytes) in &patched {
            self.write_disk(path, bytes)?;
        }
        if let Some(parent) = to_abs.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Err(err) = fs::rename(&from_abs, &to_abs) {
            for (path, bytes) in &snapshots {
                let _ = self.write_disk(path, bytes);
            }
            return Err(Error::from(err));
        }
        if let Err(err) = self.refresh_index() {
            let _ = fs::rename(&to_abs, &from_abs);
            for (path, bytes) in &snapshots {
                let _ = self.write_disk(path, bytes);
            }
            return Err(err);
        }
        Ok(())
    }

    /// 用刚写入的字节更新该文件索引；文件集合变了才重算全库指向。
    fn reindex_written(&self, rel: &str, bytes: &[u8]) -> Result<(), Error> {
        let files = self.list_files()?;
        let disk_set: HashSet<String> = files.iter().cloned().collect();
        let abs = resolve_in_root(&self.root, rel)?;
        let mtime = mtime_stamp(&fs::metadata(&abs)?);
        let row = file_row_from_bytes(rel, bytes, mtime);
        let new_links = extract_resolved(rel, bytes, &files);

        let conn = self.lock_conn()?;
        let mut file_rows = index::load_files(&conn)?;
        let mut links = index::load_links(&conn)?;
        let indexed_set: HashSet<String> = file_rows.iter().map(|file| file.path.clone()).collect();
        let set_changed = disk_set != indexed_set;
        file_rows.retain(|file| disk_set.contains(&file.path));
        links.retain(|link| disk_set.contains(&link.from_path));
        file_rows.retain(|file| file.path != rel);
        file_rows.push(row);
        links.retain(|link| link.from_path != rel);
        links.extend(new_links);
        if set_changed {
            for link in &mut links {
                link.to_path = resolve_against(&files, &link.from_path, &link.to_raw, link.kind);
            }
        }
        index::replace_all(&conn, &file_rows, &links)?;
        self.index_epoch.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn file_row_from_bytes(rel: &str, bytes: &[u8], mtime: i64) -> FileRow {
    let is_md = is_markdown(rel);
    let kind = if is_md { "markdown" } else { "other" };
    let title = if is_md {
        std::str::from_utf8(bytes)
            .ok()
            .and_then(scan::first_heading)
            .unwrap_or_else(|| file_title_fallback(rel))
    } else {
        file_title_fallback(rel)
    };
    FileRow {
        path: rel.to_string(),
        title,
        kind: kind.to_string(),
        mtime,
        content_hash: hex_sha256(bytes),
    }
}

fn extract_resolved(rel: &str, bytes: &[u8], files: &[String]) -> Vec<LinkRecord> {
    if !is_markdown(rel) {
        return Vec::new();
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Vec::new();
    };
    let mut links = scan::extract_links(rel, text);
    for link in &mut links {
        link.to_path = resolve_against(files, &link.from_path, &link.to_raw, link.kind);
    }
    links
}

fn mtime_stamp(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            i64::try_from(duration.as_nanos()).unwrap_or(i64::MAX)
        })
}

fn is_markdown(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn file_title_fallback(rel: &str) -> String {
    Path::new(rel)
        .file_stem()
        .map_or_else(|| rel.to_string(), |s| s.to_string_lossy().into_owned())
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().fold(String::new(), |mut acc, b| {
        use std::fmt::Write as _;
        let _ = write!(acc, "{b:02x}");
        acc
    })
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), Error> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_files(root, &path, out)?;
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| Error::PathEscape)?
                .to_string_lossy()
                .replace('\\', "/");
            out.push(rel);
        }
    }
    Ok(())
}

fn resolve_against(
    files: &[String],
    from: &str,
    raw: &str,
    kind: crate::link::LinkKind,
) -> Option<String> {
    let (path, _) = crate::link::split_resource(raw.trim());
    match kind {
        crate::link::LinkKind::Wiki => resolve_wiki(files, path),
        crate::link::LinkKind::Markdown => resolve_markdown(files, from, path),
    }
}

fn resolve_wiki(files: &[String], raw: &str) -> Option<String> {
    let mut hits = Vec::new();
    for file in files {
        let name = Path::new(file).file_name()?.to_string_lossy();
        let stem = Path::new(file).file_stem()?.to_string_lossy();
        if name == raw || stem == raw {
            hits.push(file.clone());
        }
    }
    if hits.len() == 1 {
        hits.pop()
    } else {
        None
    }
}

fn resolve_markdown(files: &[String], from: &str, raw: &str) -> Option<String> {
    let base = Path::new(from).parent().unwrap_or_else(|| Path::new(""));
    let joined = base.join(raw);
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let rel = out.to_string_lossy().replace('\\', "/");
    files.iter().find(|f| *f == &rel).cloned()
}
