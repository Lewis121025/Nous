//! 笔记库：根目录约束下的原始字节读写与链接索引。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::Error;
use crate::index::{self, FileRow};
use crate::link::LinkRecord;
use crate::mention::{self, MentionKind, MentionRecord, Mentions};
use crate::pathutil::{path_to_slashes, resolve_in_root};
use crate::scan;

/// 已打开的笔记库。
///
/// `root` 是已保存笔记的唯一真相；`index_dir` 存放派生索引、草稿与操作恢复记录，应在库外。
pub struct Vault {
    root: PathBuf,
    index_dir: PathBuf,
    conn: Mutex<Connection>,
    /// 最近一次扫描的库内路径。列目录和解析链接走这里，避免每次下盘。
    inventory: Mutex<Option<Inventory>>,
    /// 空目录也参与监视变更判断，文件树不能依赖文件索引推断全部目录。
    directories: Mutex<Vec<String>>,
    /// 文件提交串行化，避免两次应用内保存同时通过版本检查。
    writes: Mutex<()>,
    pub(super) recovery: crate::recovery::RecoveryStore,
}

impl Vault {
    /// 打开目录作为库根并重建链接索引。
    ///
    /// `root` 必须已存在且为目录。`index_dir` 若不存在则创建。
    ///
    /// # Errors
    ///
    /// 根不是目录、状态目录不可用、改名恢复受阻或索引写入失败时返回错误。
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
        let _operation = lock_operation(&index_dir)?;
        let recovery = crate::recovery::RecoveryStore::open(&index_dir.join("recovery.sqlite"))?;
        crate::rename::recover_pending(&root, &recovery)?;
        let conn = index::open_connection(&index_dir.join("index.sqlite"))?;
        let vault = Self {
            root,
            index_dir,
            conn: Mutex::new(conn),
            inventory: Mutex::new(None),
            directories: Mutex::new(Vec::new()),
            writes: Mutex::new(()),
            recovery,
        };
        let _ = vault.refresh_index_locked()?;
        Ok(vault)
    }

    /// 按磁盘现状刷新链接索引。
    ///
    /// `mtime` 未变的文件不读内容；内容哈希未变则只更新时间戳。
    /// 扫描器版本落后时忽略上述跳过，全量重扫。
    /// 文件集合变了才重算全库链接指向。
    /// 磁盘集合与每篇 `mtime` 都未变时不写 SQLite，避免打开库和监视空转把整表重抄。
    ///
    /// 文件监视在防抖后调用；外部改盘不会走 `write`，必须显式刷新。
    ///
    /// 返回是否改写了索引；监视器据此决定要不要通知界面。
    ///
    /// # Errors
    ///
    /// 读盘或写索引失败。
    pub fn refresh_index(&self) -> Result<bool, Error> {
        let _guard = self.lock_writes()?;
        self.refresh_index_locked()
    }

    pub(super) fn refresh_index_locked(&self) -> Result<bool, Error> {
        let entries = crate::entries::scan_entries(&self.root, false)?;
        let files: Vec<_> = entries
            .iter()
            .filter(|entry| entry.kind == crate::EntryKind::File)
            .map(|entry| entry.path.clone())
            .collect();
        let directories: Vec<_> = entries
            .into_iter()
            .filter(|entry| entry.kind == crate::EntryKind::Directory)
            .map(|entry| entry.path)
            .collect();
        self.store_inventory(files.clone())?;
        let (indexed_files, indexed_links, stale_scan) = {
            let conn = self.lock_conn()?;
            (
                index::load_files(&conn)?,
                index::load_links(&conn)?,
                index::scan_version(&conn)? != index::SCAN_VERSION,
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

        let mut mtimes = Vec::with_capacity(files.len());
        for rel in &files {
            let abs = resolve_in_root(&self.root, rel)?;
            mtimes.push(mtime_stamp(&fs::metadata(&abs)?));
        }

        if !stale_scan && !set_changed {
            let all_match = files
                .iter()
                .zip(&mtimes)
                .all(|(rel, mtime)| by_path.get(rel).is_some_and(|old| old.mtime == *mtime));
            if all_match {
                return self.store_directories(directories);
            }
        }

        let inventory = Inventory::from_files(files.clone());
        let mut file_rows = Vec::new();
        let mut links = Vec::new();
        for (rel, mtime) in files.iter().zip(mtimes) {
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
            let abs = resolve_in_root(&self.root, rel)?;
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
            let (row, outgoing) = index_bytes(rel, &bytes, mtime, &inventory);
            file_rows.push(row);
            links.extend(outgoing);
        }

        if set_changed {
            for link in &mut links {
                link.to_path =
                    resolve_against(&inventory, &link.from_path, &link.to_raw, link.kind);
            }
        }

        let conn = self.lock_conn()?;
        index::replace_all(&conn, &file_rows, &links)?;
        self.store_directories(directories)?;
        Ok(true)
    }

    fn store_directories(&self, directories: Vec<String>) -> Result<bool, Error> {
        let mut previous = self
            .directories
            .lock()
            .map_err(|_| Error::Io(io::Error::other("目录缓存锁已毒化")))?;
        let changed = *previous != directories;
        *previous = directories;
        Ok(changed)
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
        self.conn
            .lock()
            .map_err(|_| Error::Io(io::Error::other("索引锁已毒化")))
    }

    pub(super) fn lock_writes(&self) -> Result<WriteGuard<'_>, Error> {
        let local = self
            .writes
            .lock()
            .map_err(|_| Error::Io(io::Error::other("文件写入锁已毒化")))?;
        Ok(WriteGuard {
            _local: local,
            _operation: lock_operation(&self.index_dir)?,
        })
    }

    fn lock_inventory(&self) -> Result<std::sync::MutexGuard<'_, Option<Inventory>>, Error> {
        self.inventory
            .lock()
            .map_err(|_| Error::Io(io::Error::other("目录缓存锁已毒化")))
    }

    fn store_inventory(&self, files: Vec<String>) -> Result<(), Error> {
        *self.lock_inventory()? = Some(Inventory::from_files(files));
        Ok(())
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

    /// 列出库内文件及可恢复草稿的相对路径（跳过以 `.` 开头的磁盘条目）。
    ///
    /// 打开或刷新之后走内存名单，避免每次解析链接、加载图片都递归扫盘。
    ///
    /// # Errors
    ///
    /// 读目录失败时返回 IO 错误。
    pub fn list_files(&self) -> Result<Vec<String>, Error> {
        let mut files = self.list_disk_files()?;
        files.extend(self.recovery.paths()?);
        files.sort();
        files.dedup();
        Ok(files)
    }

    pub(super) fn list_disk_files(&self) -> Result<Vec<String>, Error> {
        {
            let guard = self.lock_inventory()?;
            if let Some(inventory) = guard.as_ref() {
                return Ok(inventory.files.clone());
            }
        }
        let files = self.scan_files()?;
        self.store_inventory(files.clone())?;
        Ok(files)
    }

    pub(super) fn scan_files(&self) -> Result<Vec<String>, Error> {
        Ok(crate::entries::scan_entries(&self.root, false)?
            .into_iter()
            .filter(|entry| entry.kind == crate::EntryKind::File)
            .map(|entry| entry.path)
            .collect())
    }

    pub(super) fn directory_paths(&self) -> Result<Vec<String>, Error> {
        Ok(self
            .directories
            .lock()
            .map_err(|_| Error::Io(io::Error::other("目录缓存锁已毒化")))?
            .clone())
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

    /// 指向 `path` 的已链接提及与未链接提及。
    ///
    /// 未链接在查询时扫其它 Markdown，不写索引。
    ///
    /// # Errors
    ///
    /// 索引查询失败。单个 Markdown 读失败则跳过该文件。
    pub fn mentions_to(&self, path: &str) -> Result<Mentions, Error> {
        let (files, linked_links) = {
            let conn = self.lock_conn()?;
            (index::load_files(&conn)?, index::links_to(&conn, path)?)
        };
        let file_map: HashMap<String, FileRow> = files
            .into_iter()
            .map(|row| (row.path.clone(), row))
            .collect();
        let title = file_map.get(path).map_or("", |row| row.title.as_str());
        let needles = mention::mention_needles(title, path);
        let linked = self.mentions_from_links(&linked_links, &file_map);
        let mut unlinked = Vec::new();
        for rel in self.list_files()? {
            if rel == path || !is_markdown(&rel) {
                continue;
            }
            let Ok(bytes) = self.read(&rel) else {
                continue;
            };
            let Ok(source) = String::from_utf8(bytes) else {
                continue;
            };
            let hits = mention::find_unlinked(&rel, &source, &needles);
            let meta = file_map.get(&rel);
            let from_title =
                meta.map_or_else(|| file_title_fallback(&rel), |row| row.title.clone());
            let mtime = meta.map_or(0, |row| row.mtime);
            for (start, end) in hits {
                let start_byte = i64::try_from(start).unwrap_or(i64::MAX);
                let end_byte = i64::try_from(end).unwrap_or(i64::MAX);
                unlinked.push(MentionRecord {
                    from_path: rel.clone(),
                    from_title: from_title.clone(),
                    mtime,
                    start_byte,
                    end_byte,
                    snippet: mention::paragraph_snippet(&source, start, end),
                    kind: MentionKind::Unlinked,
                    link_kind: None,
                    to_raw: source.get(start..end).unwrap_or("").to_string(),
                });
            }
        }
        Ok(Mentions { linked, unlinked })
    }

    fn mentions_from_links(
        &self,
        links: &[LinkRecord],
        files: &HashMap<String, FileRow>,
    ) -> Vec<MentionRecord> {
        let mut sources: HashMap<String, Option<String>> = HashMap::new();
        let mut out = Vec::with_capacity(links.len());
        for link in links {
            if !sources.contains_key(&link.from_path) {
                let text = match self.read(&link.from_path) {
                    Ok(bytes) => String::from_utf8(bytes).ok(),
                    Err(_) => None,
                };
                sources.insert(link.from_path.clone(), text);
            }
            let Some(Some(source)) = sources.get(&link.from_path) else {
                continue;
            };
            let meta = files.get(&link.from_path);
            let from_title = meta.map_or_else(
                || file_title_fallback(&link.from_path),
                |row| row.title.clone(),
            );
            let mtime = meta.map_or(0, |row| row.mtime);
            let start = usize::try_from(link.start_byte).unwrap_or(0);
            let end = usize::try_from(link.end_byte).unwrap_or(0);
            out.push(MentionRecord {
                from_path: link.from_path.clone(),
                from_title,
                mtime,
                start_byte: link.start_byte,
                end_byte: link.end_byte,
                snippet: mention::paragraph_snippet(source, start, end),
                kind: MentionKind::Linked,
                link_kind: Some(link.kind),
                to_raw: link.to_raw.clone(),
            });
        }
        out
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
        let guard = self.lock_inventory().ok()?;
        let inventory = guard.as_ref()?;
        resolve_against(inventory, from, raw, kind)
    }

    /// 用刚写入的字节更新该文件索引；文件集合变了才重算全库指向。
    ///
    /// 必须扫盘：外部删文件不会走 `write`，缓存里还留着旧路径。
    pub(super) fn reindex_written(&self, rel: &str, bytes: &[u8]) -> Result<(), Error> {
        let files = self.scan_files()?;
        self.store_inventory(files.clone())?;
        let inventory = Inventory::from_files(files);
        let mtime = mtime_stamp(&fs::metadata(&resolve_in_root(&self.root, rel)?)?);
        let (row, new_links) = index_bytes(rel, bytes, mtime, &inventory);

        let conn = self.lock_conn()?;
        let file_rows = index::load_files(&conn)?;
        let indexed_set: HashSet<String> = file_rows.iter().map(|file| file.path.clone()).collect();
        let set_changed = inventory.set != indexed_set;
        if set_changed {
            for old in &indexed_set {
                if !inventory.set.contains(old) {
                    index::delete_file(&conn, old)?;
                }
            }
        }
        index::upsert_file(&conn, &row, &new_links)?;
        if set_changed {
            let mut links = index::load_links(&conn)?;
            for link in &mut links {
                link.to_path =
                    resolve_against(&inventory, &link.from_path, &link.to_raw, link.kind);
            }
            index::replace_links(&conn, &links)?;
        }
        Ok(())
    }
}

// 文件句柄释放时自动解锁；多个内核实例不能把进行中的改名当作崩溃日志恢复。
pub(super) struct WriteGuard<'a> {
    _local: std::sync::MutexGuard<'a, ()>,
    _operation: fs::File,
}

fn lock_operation(index_dir: &Path) -> Result<fs::File, Error> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(index_dir.join("operations.lock"))?;
    file.lock()?;
    Ok(file)
}

/// 库内路径名单与 wiki 名到路径的映射。
#[derive(Clone)]
pub(super) struct Inventory {
    files: Vec<String>,
    set: HashSet<String>,
    wiki: HashMap<String, Vec<String>>,
}

impl Inventory {
    pub(super) fn from_files(files: Vec<String>) -> Self {
        let wiki = wiki_map(&files);
        let set = files.iter().cloned().collect();
        Self { files, set, wiki }
    }
}

fn wiki_map(files: &[String]) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for file in files {
        let path = Path::new(file);
        let name = path
            .file_name()
            .map(|part| part.to_string_lossy().into_owned());
        let stem = path
            .file_stem()
            .map(|part| part.to_string_lossy().into_owned());
        if let Some(name) = name {
            map.entry(name.clone()).or_default().push(file.clone());
            if let Some(stem) = stem {
                if stem != name {
                    map.entry(stem).or_default().push(file.clone());
                }
            }
        }
    }
    map
}

fn index_bytes(
    rel: &str,
    bytes: &[u8],
    mtime: i64,
    inventory: &Inventory,
) -> (FileRow, Vec<LinkRecord>) {
    if !is_markdown(rel) {
        return (
            FileRow {
                path: rel.to_string(),
                title: file_title_fallback(rel),
                kind: "other".to_string(),
                mtime,
                content_hash: hex_sha256(bytes),
            },
            Vec::new(),
        );
    }
    let (heading, mut links) = std::str::from_utf8(bytes).map_or_else(
        |_| (None, Vec::new()),
        |text| scan::scan_markdown(rel, text),
    );
    for link in &mut links {
        link.to_path = resolve_against(inventory, &link.from_path, &link.to_raw, link.kind);
    }
    let row = FileRow {
        path: rel.to_string(),
        title: heading.unwrap_or_else(|| file_title_fallback(rel)),
        kind: "markdown".to_string(),
        mtime,
        content_hash: hex_sha256(bytes),
    };
    (row, links)
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

pub(super) fn resolve_against(
    inventory: &Inventory,
    from: &str,
    raw: &str,
    kind: crate::link::LinkKind,
) -> Option<String> {
    let (path, _) = crate::link::split_resource(raw.trim());
    match kind {
        crate::link::LinkKind::Wiki => resolve_wiki(inventory, path),
        crate::link::LinkKind::Markdown => resolve_markdown(inventory, from, path),
    }
}

fn resolve_wiki(inventory: &Inventory, raw: &str) -> Option<String> {
    let hits = inventory.wiki.get(raw)?;
    if hits.len() == 1 {
        hits.first().cloned()
    } else {
        None
    }
}

fn resolve_markdown(inventory: &Inventory, from: &str, raw: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    let raw = decoded.as_ref();
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
    let rel = path_to_slashes(&out).ok()?;
    inventory.set.contains(&rel).then_some(rel)
}
