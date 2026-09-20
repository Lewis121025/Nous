//! 将用户提供的相对路径约束在库根内。

use std::path::{Component, Path, PathBuf};

use crate::error::Error;

/// 把库内相对路径解析为绝对路径。
///
/// 拒绝绝对路径、空路径、以及任何 `..` 分量。不跟随符号链接做 canonicalize，
/// 以免 TOCTOU；仅按分量拼接并要求结果仍以库根为前缀。
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
    for component in rel_path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(Error::PathEscape);
            }
        }
    }
    if !out.starts_with(root) {
        return Err(Error::PathEscape);
    }
    Ok(out)
}
