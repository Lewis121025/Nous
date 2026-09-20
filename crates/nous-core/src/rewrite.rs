//! 按字节区间改写链接原文。

use std::path::{Component, Path, PathBuf};

use crate::link::LinkKind;

/// 根据链接种类生成替换后的源文本片段。
#[must_use]
pub fn rewrite_span(kind: LinkKind, original: &str, new_target: &str) -> String {
    match kind {
        LinkKind::Wiki => rewrite_wiki(original, new_target),
        LinkKind::Markdown => rewrite_markdown(original, new_target),
    }
}

fn rewrite_wiki(original: &str, new_target: &str) -> String {
    let inner = original
        .strip_prefix("[[")
        .and_then(|s| s.strip_suffix("]]"))
        .unwrap_or(original);
    if let Some((_, alias)) = inner.split_once('|') {
        format!("[[{new_target}|{alias}]]")
    } else {
        format!("[[{new_target}]]")
    }
}

fn rewrite_markdown(original: &str, new_url: &str) -> String {
    let Some(idx) = original.rfind('(') else {
        return original.to_string();
    };
    let mut out = original[..idx].to_string();
    out.push('(');
    out.push_str(new_url);
    out.push(')');
    out
}

/// 从 `from_file` 出发指向 `to_file` 的 Markdown 相对 URL。
///
/// 同目录使用 `./文件名`，以便与常见写法一致。
#[must_use]
pub fn relative_markdown_url(from_file: &str, to_file: &str) -> String {
    let from_dir = Path::new(from_file)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let to = Path::new(to_file);
    let from_parts = normal_parts(from_dir);
    let to_parts = normal_parts(to);
    let common = from_parts
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let ups = from_parts.len().saturating_sub(common);
    let mut url = PathBuf::new();
    for _ in 0..ups {
        url.push("..");
    }
    for part in to_parts.iter().skip(common) {
        url.push(part);
    }
    let mut rendered = url.to_string_lossy().replace('\\', "/");
    if ups == 0 && !rendered.starts_with('.') {
        rendered = format!("./{rendered}");
    }
    rendered
}

fn normal_parts(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

/// wiki 链接的新 target：目标文件的主文件名（不含扩展名）。
#[must_use]
pub fn wiki_target_name(to_file: &str) -> String {
    Path::new(to_file)
        .file_stem()
        .map_or_else(|| to_file.to_string(), |s| s.to_string_lossy().into_owned())
}
