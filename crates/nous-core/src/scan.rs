//! 从 Markdown 源抽出 wiki 与内部 Markdown 链接。

use markdown::mdast::Node;
use markdown::{to_mdast, ParseOptions};
use regex::Regex;
use std::sync::OnceLock;

use crate::link::{LinkKind, LinkRecord};

fn wiki_regex() -> &'static Regex {
    static WIKI: OnceLock<Regex> = OnceLock::new();
    WIKI.get_or_init(|| Regex::new(r"\[\[([^\[\]]+)\]\]").expect("wiki 正则"))
}

/// 一次解析同时取出标题与出链，避免同一篇走两遍 `to_mdast`。
#[must_use]
pub fn scan_markdown(from_path: &str, source: &str) -> (Option<String>, Vec<LinkRecord>) {
    let Ok(tree) = to_mdast(source, &ParseOptions::default()) else {
        return (None, Vec::new());
    };
    let mut links = Vec::new();
    walk(&tree, from_path, source, &mut links);
    (find_heading(&tree), links)
}

fn find_heading(node: &Node) -> Option<String> {
    if let Node::Heading(heading) = node {
        let text = heading
            .children
            .iter()
            .map(Node::to_string)
            .collect::<String>();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        return Some(trimmed.to_string());
    }
    if let Some(children) = node.children() {
        for child in children {
            if let Some(found) = find_heading(child) {
                return Some(found);
            }
        }
    }
    None
}

fn walk(node: &Node, from_path: &str, source: &str, out: &mut Vec<LinkRecord>) {
    match node {
        Node::Code(_) | Node::InlineCode(_) | Node::Math(_) | Node::InlineMath(_) => {}
        Node::Link(link) => {
            if let Some(record) = markdown_link(from_path, source, link) {
                out.push(record);
            }
        }
        Node::Text(text) => {
            collect_wiki(from_path, source, text, out);
        }
        _ => {
            if let Some(children) = node.children() {
                for child in children {
                    walk(child, from_path, source, out);
                }
            }
        }
    }
}

fn markdown_link(
    from_path: &str,
    source: &str,
    link: &markdown::mdast::Link,
) -> Option<LinkRecord> {
    let url = link.url.trim();
    if url.is_empty() || is_external(url) || url.starts_with('#') {
        return None;
    }
    let position = link.position.as_ref()?;
    let start = i64::try_from(point_offset_to_byte(source, position.start.offset)).ok()?;
    let end = i64::try_from(point_offset_to_byte(source, position.end.offset)).ok()?;
    Some(LinkRecord {
        from_path: from_path.to_string(),
        to_raw: url.to_string(),
        to_path: None,
        kind: LinkKind::Markdown,
        start_byte: start,
        end_byte: end,
    })
}

fn collect_wiki(
    from_path: &str,
    source: &str,
    text: &markdown::mdast::Text,
    out: &mut Vec<LinkRecord>,
) {
    let Some(position) = text.position.as_ref() else {
        return;
    };
    let text_start = point_offset_to_byte(source, position.start.offset);
    let wiki = wiki_regex();
    for cap in wiki.captures_iter(&text.value) {
        let full = cap.get(0).expect("0");
        let inner = cap.get(1).expect("1").as_str();
        let target = inner.split_once('|').map_or(inner, |(t, _)| t).trim();
        if target.is_empty() {
            continue;
        }
        let start = i64::try_from(text_start + full.start()).expect("start");
        let end = i64::try_from(text_start + full.end()).expect("end");
        out.push(LinkRecord {
            from_path: from_path.to_string(),
            to_raw: target.to_string(),
            to_path: None,
            kind: LinkKind::Wiki,
            start_byte: start,
            end_byte: end,
        });
    }
}

fn is_external(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.contains("://")
}

/// markdown-rs 的 `Point.offset` 是源 UTF-8 字节下标，不是 Unicode 标量下标。
fn point_offset_to_byte(source: &str, offset: usize) -> usize {
    offset.min(source.len())
}
