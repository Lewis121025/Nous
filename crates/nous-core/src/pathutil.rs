//! 将用户提供的相对路径约束在库根内。

use std::path::{Component, Path, PathBuf};

use crate::error::Error;

/// 把库内相对路径解析为绝对路径。
///
/// 拒绝绝对路径、空路径、`..` 分量和库内符号链接，避免恢复日志写到库外。
/// 逐级检查已有父目录；这仍不能阻止外部进程在检查后替换目录。
///
/// # Errors
///
/// 越界或非法分量时返回 [`Error::PathEscape`]。
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, Error> {
    if rel.is_empty() {
        return Err(Error::PathEscape);
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(Error::PathEscape);
    }
    let mut out = root.to_path_buf();
    let mut components = rel_path.components().peekable();
    while let Some(component) = components.next() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(Error::PathEscape);
            }
        }
        match std::fs::symlink_metadata(&out) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(Error::PathEscape),
            Ok(meta) if components.peek().is_some() && !meta.is_dir() => {
                return Err(Error::Io(std::io::Error::new(
                    std::io::ErrorKind::NotADirectory,
                    format!("父路径不是目录：{}", out.display()),
                )));
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    if out == root || !out.starts_with(root) {
        return Err(Error::PathEscape);
    }
    Ok(out)
}
