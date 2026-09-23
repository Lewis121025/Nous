//! 保存的提交边界：先保留草稿，再核对磁盘，最后原子替换。

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use tempfile::{Builder, NamedTempFile};

use crate::pathutil::resolve_in_root;
use crate::{Draft, Error, Vault};

/// 文件已提交与版本冲突是不同结果；索引失败不撤销已经提交的内容。
#[derive(Debug)]
pub enum WriteOutcome {
    /// 内容已写入；警告表示目录同步、索引更新或草稿清理需要重试。
    Saved { warning: Option<String> },
    /// 磁盘与编辑基准不同；`None` 表示文件已被删除。
    Conflict { disk: Option<Vec<u8>> },
}

/// 打开编辑器所需的磁盘内容和未提交草稿。
#[derive(Debug)]
pub struct FileSnapshot {
    /// 当前磁盘字节；删除后的草稿也可以打开。
    pub disk: Option<Vec<u8>>,
    /// 上次保存失败或冲突时保留的内容。
    pub draft: Option<Draft>,
}

/// 另存副本的最终路径与提交后的警告。
#[derive(Debug)]
pub struct SavedCopy {
    /// 新文件的库内相对路径。
    pub path: String,
    /// 内容已写入，但派生状态或持久化确认失败。
    pub warning: Option<String>,
}

impl Vault {
    /// 读取磁盘与恢复草稿，已落盘的同内容草稿不再重复恢复。
    ///
    /// `rel` 为库内相对路径。返回可用于重建编辑器的快照。
    ///
    /// # Errors
    ///
    /// 越界、读盘或读取恢复记录失败。
    pub fn snapshot(&self, rel: &str) -> Result<FileSnapshot, Error> {
        let _guard = self.lock_writes()?;
        let disk = read_optional(&resolve_in_root(self.root(), rel)?)?;
        let draft = self
            .recovery
            .get(rel)?
            .filter(|draft| disk.as_ref() != Some(&draft.bytes));
        Ok(FileSnapshot { disk, draft })
    }

    /// 基于 `expected` 保存 `bytes`；缺失基准表示仅允许创建新文件。
    ///
    /// 保存尝试先落入恢复记录。已知的外部修改返回冲突，不修改目标；
    /// 应用内写入串行，但无法阻止其他进程在核对与替换之间写入。
    ///
    /// # Errors
    ///
    /// 越界、草稿持久化或文件提交前的 IO 失败。提交后的问题随成功结果返回。
    pub fn write(
        &self,
        rel: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<WriteOutcome, Error> {
        let _guard = self.lock_writes()?;
        let path = resolve_in_root(self.root(), rel)?;
        self.recovery.put(rel, bytes, expected)?;
        crate::rename::recover_pending(self.root(), &self.recovery)?;
        let disk = read_optional(&path)?;
        if disk.as_deref() != expected {
            return Ok(WriteOutcome::Conflict { disk });
        }
        let staged = stage(&path, bytes)?;
        // 草稿与临时文件的同步可能较慢，提交前再次检查外部修改。
        let disk = read_optional(&path)?;
        if disk.as_deref() != expected {
            return Ok(WriteOutcome::Conflict { disk });
        }
        if expected.is_none() {
            match staged.persist_noclobber(&path) {
                Ok(_) => {}
                Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => {
                    return Ok(WriteOutcome::Conflict {
                        disk: read_optional(&path)?,
                    });
                }
                Err(err) => return Err(err.error.into()),
            }
        } else {
            staged.persist(&path).map_err(|err| err.error)?;
        }
        Ok(WriteOutcome::Saved {
            warning: self.finish_write(rel, bytes, rel),
        })
    }

    /// 将 `bytes` 保存为同目录下的新副本，保留原文件和已有副本。
    ///
    /// `rel` 为原文件路径，`expected` 仅用于记录恢复草稿的基准。
    /// 返回实际创建的路径；同名候选使用独占创建，避免覆盖并发出现的文件。
    ///
    /// # Errors
    ///
    /// 路径非法、恢复记录或副本提交失败。
    pub fn write_copy(
        &self,
        rel: &str,
        bytes: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<SavedCopy, Error> {
        let _guard = self.lock_writes()?;
        let path = resolve_in_root(self.root(), rel)?;
        self.recovery.put(rel, bytes, expected)?;
        crate::rename::recover_pending(self.root(), &self.recovery)?;
        let stem = path.file_stem().ok_or(Error::PathEscape)?.to_string_lossy();
        let extension = path
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()))
            .unwrap_or_default();
        let mut staged = stage(&path, bytes)?;
        for number in 1_u64.. {
            let suffix = if number == 1 {
                "副本".to_string()
            } else {
                format!("副本 {number}")
            };
            let candidate = path.with_file_name(format!("{stem} ({suffix}){extension}"));
            match staged.persist_noclobber(&candidate) {
                Ok(_) => {
                    let copy_rel = candidate
                        .strip_prefix(self.root())
                        .map_err(|_| Error::PathEscape)?
                        .to_string_lossy()
                        .replace('\\', "/");
                    let warning = self.finish_write(&copy_rel, bytes, rel);
                    return Ok(SavedCopy {
                        path: copy_rel,
                        warning,
                    });
                }
                Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => staged = err.file,
                Err(err) => return Err(err.error.into()),
            }
        }
        Err(Error::Io(io::Error::other("副本名称已耗尽")))
    }

    fn finish_write(&self, rel: &str, bytes: &[u8], recovery_rel: &str) -> Option<String> {
        let mut warnings = Vec::new();
        let synced = sync_parent(&self.root().join(rel));
        if let Err(err) = &synced {
            warnings.push(format!("目录同步失败，恢复草稿已保留：{err}"));
        }
        if let Err(err) = self.reindex_written(rel, bytes) {
            warnings.push(format!("链接索引更新失败：{err}"));
        }
        if synced.is_ok() {
            if let Err(err) = self.recovery.remove(recovery_rel) {
                warnings.push(format!("恢复草稿清理失败：{err}"));
            }
        }
        (!warnings.is_empty()).then(|| warnings.join("；"))
    }
}

pub(super) fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, Error> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub(super) fn stage(path: &Path, bytes: &[u8]) -> Result<NamedTempFile, Error> {
    let parent = path.parent().ok_or(Error::PathEscape)?;
    fs::create_dir_all(parent)?;
    let mut file = Builder::new().prefix(".nous-").tempfile_in(parent)?;
    if let Ok(metadata) = fs::metadata(path) {
        file.as_file().set_permissions(metadata.permissions())?;
    }
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    Ok(file)
}

pub(super) fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::File::open(
        path.parent()
            .ok_or_else(|| io::Error::other("路径没有父目录"))?,
    )?
    .sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
