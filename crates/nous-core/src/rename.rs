//! 根据实时内容生成改名计划，并以持久化日志恢复中断的文件提交。

use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::Path;

use crate::pathutil::resolve_in_root;
use crate::recovery::RecoveryStore;
use crate::rename_journal::{FileChange, RenameJournal};
use crate::save::{read_optional, stage, sync_parent};
use crate::vault::{resolve_against, Inventory};
use crate::{Error, LinkKind, Vault};

/// 文件已完成改名；派生索引和日志清理的失败不撤销已提交内容。
#[derive(Debug)]
pub struct RenameOutcome {
    /// 提交后的警告；没有待处理问题时为 `None`。
    pub warning: Option<String>,
}

impl Vault {
    /// 将 `from` 改名为 `to`，按当前源内容更新内部链接。
    ///
    /// 两个参数均为库内相对路径。提交前保存每个文件的前后版本；失败时回滚，
    /// 回滚遇到外部修改则保留日志与外部内容，后续写入和重新打开库会重试恢复。
    ///
    /// # Errors
    ///
    /// 路径非法、目标已存在、有未处理草稿、版本冲突或提交/恢复失败。
    pub fn rename(&self, from: &str, to: &str) -> Result<RenameOutcome, Error> {
        let _guard = self.lock_writes()?;
        recover_pending(self.root(), &self.recovery)?;
        let from = relative_path(self.root(), from)?;
        let to = relative_path(self.root(), to)?;
        if from == to {
            return Ok(RenameOutcome { warning: None });
        }
        self.check_rename_drafts()?;
        let journal = self.plan_rename(&from, &to)?;
        self.recovery.prepare_rename(&journal)?;
        if let Err(cause) = self.apply_rename(&journal) {
            // 提交标记若已持久化，清理故障不能再把成功的改名回滚。
            let committed = self
                .recovery
                .load_rename()
                .map_err(|err| Error::RenameRecovery {
                    detail: format!("提交失败：{cause}；无法读取提交状态：{err}。恢复记录已保留"),
                })?
                .is_some_and(|record| record.committed);
            if !committed {
                recover_pending(self.root(), &self.recovery).map_err(|err| {
                    Error::RenameRecovery {
                        detail: format!("提交失败：{cause}；{err}"),
                    }
                })?;
                return Err(cause);
            }
        }
        let mut warnings = Vec::new();
        if let Err(err) = self.recovery.clear_rename() {
            warnings.push(format!("改名记录清理失败，下次打开时会重试：{err}"));
        }
        if let Err(err) = self.refresh_index_locked() {
            warnings.push(format!("链接索引更新失败：{err}"));
        }
        Ok(RenameOutcome {
            warning: (!warnings.is_empty()).then(|| warnings.join("；")),
        })
    }

    fn check_rename_drafts(&self) -> Result<(), Error> {
        for path in self.recovery.paths()? {
            if let Some(draft) = self.recovery.get(&path)? {
                if read_optional(&resolve_in_root(self.root(), &path)?)?.as_ref()
                    != Some(&draft.bytes)
                {
                    return Err(Error::Io(io::Error::other(format!(
                        "请先处理未保存草稿：{path}"
                    ))));
                }
                self.recovery.remove(&path)?;
            }
        }
        Ok(())
    }

    fn plan_rename(&self, from: &str, to: &str) -> Result<RenameJournal, Error> {
        let to_abs = resolve_in_root(self.root(), to)?;
        if fs::symlink_metadata(&to_abs).is_ok() {
            return Err(Error::AlreadyExists { path: to_abs });
        }
        let source = self.read(from)?;
        let mut directories = Vec::new();
        let mut parent = to_abs.parent();
        while let Some(path) = parent.filter(|path| !path.exists()) {
            directories.push(relative_path(
                self.root(),
                path.strip_prefix(self.root())
                    .map_err(|_| Error::PathEscape)?
                    .to_str()
                    .ok_or(Error::PathEscape)?,
            )?);
            parent = path.parent();
        }
        directories.reverse();
        let permissions = file_permissions(&resolve_in_root(self.root(), from)?)?;
        let files = self.scan_files()?;
        let before = Inventory::from_files(files.clone());
        let after = Inventory::from_files(
            files
                .iter()
                .map(|path| {
                    if path == from {
                        to.to_string()
                    } else {
                        path.clone()
                    }
                })
                .collect(),
        );
        let mut moved = source.clone();
        let mut changes = Vec::new();
        let mut observed = Vec::new();
        for path in &files {
            if !path.to_lowercase().ends_with(".md") {
                continue;
            }
            let bytes = if path == from {
                source.clone()
            } else {
                self.read(path)?
            };
            let rewritten = rewrite_file(path, &bytes, from, to, &before, &after)?;
            if path == from {
                moved = rewritten;
            } else if rewritten != bytes {
                changes.push(FileChange {
                    path: path.clone(),
                    before: Some(bytes.clone()),
                    after: Some(rewritten),
                    permissions: file_permissions(&resolve_in_root(self.root(), path)?)?,
                    started: false,
                });
            }
            // 未改动文件只保留摘要，避免整库正文同时常驻内存。
            observed.push((path, Sha256::digest(&bytes)));
        }
        // 读取与解析期间有文件发生变化时，整个计划作废，不能混用两次快照。
        for (path, digest) in observed {
            if Sha256::digest(self.read(path)?) != digest {
                return Err(Error::FileChanged {
                    path: resolve_in_root(self.root(), path)?,
                });
            }
        }
        if self.scan_files()? != files {
            return Err(Error::Io(io::Error::other("库文件集合已变化，请重试改名")));
        }
        changes.insert(
            0,
            FileChange {
                path: to.to_string(),
                before: None,
                after: Some(moved),
                permissions,
                started: false,
            },
        );
        changes.push(FileChange {
            path: from.to_string(),
            before: Some(source),
            after: None,
            permissions,
            started: false,
        });
        Ok(RenameJournal {
            from: from.to_string(),
            to: to.to_string(),
            committed: false,
            changes,
            directories,
        })
    }

    fn apply_rename(&self, journal: &RenameJournal) -> Result<(), Error> {
        for (ordinal, change) in journal.changes.iter().enumerate() {
            self.recovery.start_rename_step(ordinal)?;
            let mut written = false;
            let result = replace_version(
                self.root(),
                change,
                change.before.as_deref(),
                change.after.as_deref(),
                &mut written,
            );
            if result.is_err() && !written {
                self.recovery.cancel_rename_step(ordinal)?;
            }
            result?;
        }
        for directory in journal.directories.iter().rev() {
            sync_parent(&resolve_in_root(self.root(), directory)?)?;
        }
        self.recovery.commit_rename()
    }
}

fn rewrite_file(
    path: &str,
    bytes: &[u8],
    from: &str,
    to: &str,
    before: &Inventory,
    after: &Inventory,
) -> Result<Vec<u8>, Error> {
    let Ok(source) = std::str::from_utf8(bytes) else {
        return Ok(bytes.to_vec());
    };
    let (_, links) = crate::scan::scan_markdown(path, source);
    let mut edits = Vec::new();
    for link in links.iter().rev() {
        let Some(target) = resolve_against(before, path, &link.to_raw, link.kind) else {
            continue;
        };
        let new_source = if path == from { to } else { path };
        let new_target = if target == from { to } else { &target };
        if target != from && (path != from || link.kind != LinkKind::Markdown) {
            continue;
        }
        let target_text = match link.kind {
            LinkKind::Wiki => {
                let stem = crate::rewrite::wiki_target_name(to);
                if resolve_against(after, new_source, &stem, LinkKind::Wiki).as_deref() != Some(to)
                {
                    return Err(Error::Io(io::Error::other(
                        "目标名称会使现有 wiki 链接产生歧义，请换一个名称",
                    )));
                }
                stem
            }
            LinkKind::Markdown => crate::rewrite::relative_markdown_url(new_source, new_target),
        };
        let start = usize::try_from(link.start_byte)
            .map_err(|_| Error::Io(io::Error::other("链接起点溢出")))?;
        let end = usize::try_from(link.end_byte)
            .map_err(|_| Error::Io(io::Error::other("链接终点溢出")))?;
        let span = source
            .get(start..end)
            .ok_or_else(|| Error::Io(io::Error::other("链接区间无效")))?;
        let replacement = crate::rewrite::rewrite_span(link.kind, span, &target_text)?;
        let prefix = span
            .bytes()
            .zip(replacement.bytes())
            .take_while(|(left, right)| left == right)
            .count();
        let suffix = span.as_bytes()[prefix..]
            .iter()
            .rev()
            .zip(replacement.as_bytes()[prefix..].iter().rev())
            .take_while(|(left, right)| left == right)
            .count();
        edits.push((
            start + prefix,
            end - suffix,
            replacement.as_bytes()[prefix..replacement.len() - suffix].to_vec(),
        ));
    }
    edits.sort_by_key(|(start, _, _)| *start);
    if edits.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(Error::Io(io::Error::other("链接修改区间重叠，已停止改名")));
    }
    let mut rewritten = bytes.to_vec();
    for (start, end, replacement) in edits.into_iter().rev() {
        rewritten.splice(start..end, replacement);
    }
    Ok(rewritten)
}

pub(super) fn recover_pending(root: &Path, store: &RecoveryStore) -> Result<(), Error> {
    let Some(journal) = store.load_rename()? else {
        return Ok(());
    };
    if !journal.committed {
        for change in journal.changes.iter().rev().filter(|change| change.started) {
            rollback_file(root, change).map_err(|err| Error::RenameRecovery {
                detail: format!(
                    "{} → {}，恢复 {} 受阻：{err}。原始内容仍保留在恢复记录中",
                    journal.from, journal.to, change.path
                ),
            })?;
        }
        for directory in journal.directories.iter().rev() {
            let path = resolve_in_root(root, directory)?;
            match fs::remove_dir(&path) {
                Ok(()) => sync_parent(&path)?,
                Err(err)
                    if matches!(
                        err.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(err) => {
                    return Err(Error::RenameRecovery {
                        detail: format!("清理目录 {directory} 受阻：{err}"),
                    })
                }
            }
        }
    }
    store.clear_rename()
}

fn rollback_file(root: &Path, change: &FileChange) -> Result<(), Error> {
    let path = resolve_in_root(root, &change.path)?;
    if read_optional(&path)?.as_deref() == change.before.as_deref() {
        if path.parent().is_some_and(Path::exists) {
            sync_parent(&path)?;
        }
        return Ok(());
    }
    replace_version(
        root,
        change,
        change.after.as_deref(),
        change.before.as_deref(),
        &mut false,
    )
}

fn replace_version(
    root: &Path,
    change: &FileChange,
    expected: Option<&[u8]>,
    desired: Option<&[u8]>,
    written: &mut bool,
) -> Result<(), Error> {
    let path = resolve_in_root(root, &change.path)?;
    check_version(&path, expected)?;
    if let Some(bytes) = desired {
        let file = stage(&path, bytes)?;
        set_permissions(file.as_file(), change.permissions)?;
        file.as_file().sync_all()?;
        check_version(&path, expected)?;
        if expected.is_none() {
            file.persist_noclobber(&path).map_err(|err| err.error)?;
        } else {
            file.persist(&path).map_err(|err| err.error)?;
        }
    } else {
        fs::remove_file(&path)?;
    }
    *written = true;
    sync_parent(&path)?;
    Ok(())
}

fn check_version(path: &Path, expected: Option<&[u8]>) -> Result<(), Error> {
    if read_optional(path)?.as_deref() != expected {
        return Err(Error::FileChanged {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn relative_path(root: &Path, rel: &str) -> Result<String, Error> {
    let path = resolve_in_root(root, rel)?;
    Ok(path
        .strip_prefix(root)
        .map_err(|_| Error::PathEscape)?
        .to_string_lossy()
        .replace('\\', "/"))
}

fn file_permissions(path: &Path) -> Result<u32, Error> {
    let permissions = fs::metadata(path)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(permissions.mode())
    }
    #[cfg(not(unix))]
    {
        Ok(u32::from(permissions.readonly()))
    }
}

fn set_permissions(file: &fs::File, mode: u32) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(mode != 0);
        file.set_permissions(permissions)?;
    }
    Ok(())
}
