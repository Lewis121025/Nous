//! 从 Markdown 源抽出 wiki 与内部 Markdown 链接。

use markdown::mdast::Node;
use markdown::{to_mdast, Constructs, ParseOptions};
use regex::Regex;
use std::collections::HashSet;
use std::ops::Range;
use std::sync::OnceLock;

use crate::link::{LinkKind, LinkRecord};

fn wiki_regex() -> &'static Regex {
    static WIKI: OnceLock<Regex> = OnceLock::new();
    WIKI.get_or_init(|| Regex::new(r"\[\[([^\[\]\r\n]+)\]\]").expect("wiki 正则"))
}

/// 一次解析同时取出标题与出链，避免同一篇走两遍 `to_mdast`。
#[must_use]
pub fn scan_markdown(from_path: &str, source: &str) -> (Option<String>, Vec<LinkRecord>) {
    let options = ParseOptions {
        constructs: Constructs {
            frontmatter: true,
            math_flow: true,
            math_text: true,
            ..Constructs::gfm()
        },
        ..ParseOptions::default()
    };
    let Ok(tree) = to_mdast(source, &options) else {
        return (None, Vec::new());
    };
    let mut links = Vec::new();
    let mut excluded = Vec::new();
    let mut references = HashSet::new();
    collect_references(&tree, &mut references);
    walk(
        &tree,
        from_path,
        source,
        &mut links,
        &mut excluded,
        &mut references,
    );
    excluded.sort_unstable_by_key(|span| span.start);
    collect_wiki(from_path, source, &excluded, &mut links);
    links.sort_by_key(|link| link.start_byte);
    (find_heading(&tree), links)
}

fn collect_references(node: &Node, references: &mut HashSet<String>) {
    match node {
        Node::LinkReference(link) => {
            references.insert(link.identifier.to_lowercase());
        }
        Node::ImageReference(image) => {
            references.insert(image.identifier.to_lowercase());
        }
        _ => {}
    }
    if let Some(children) = node.children() {
        for child in children {
            collect_references(child, references);
        }
    }
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

fn walk(
    node: &Node,
    from_path: &str,
    source: &str,
    out: &mut Vec<LinkRecord>,
    excluded: &mut Vec<Range<usize>>,
    references: &mut HashSet<String>,
) {
    let target = match node {
        Node::Image(image) => Some(image.url.as_str()),
        // CommonMark 使用第一条同名定义；后续重复定义与未引用定义都不参与改名。
        Node::Definition(definition)
            if references.remove(&definition.identifier.to_lowercase()) =>
        {
            Some(definition.url.as_str())
        }
        _ => None,
    };
    if let Some(record) = target.and_then(|url| markdown_link(from_path, source, node, url)) {
        out.push(record);
    }
    if matches!(
        node,
        Node::Code(_)
            | Node::InlineCode(_)
            | Node::Math(_)
            | Node::InlineMath(_)
            | Node::Html(_)
            | Node::Yaml(_)
            | Node::Toml(_)
            | Node::Definition(_)
            | Node::Image(_)
            | Node::ImageReference(_)
    ) {
        if let Some(position) = node.position() {
            excluded.push(position.start.offset..position.end.offset);
        }
        return;
    }
    if let Node::Link(link) = node {
        if let Some(record) = markdown_link(from_path, source, node, &link.url) {
            out.push(record);
        }
        if let Some(position) = &link.position {
            // 标签内可以有 wiki，目标 URL 和标题中的双括号不能成为额外链接。
            if let (Some(first), Some(last)) = (
                link.children.first().and_then(Node::position),
                link.children.last().and_then(Node::position),
            ) {
                excluded.push(position.start.offset..first.start.offset);
                excluded.push(last.end.offset..position.end.offset);
            } else {
                excluded.push(position.start.offset..position.end.offset);
            }
        }
    }
    if let Some(children) = node.children() {
        for child in children {
            walk(child, from_path, source, out, excluded, references);
        }
    }
}

fn markdown_link(from_path: &str, source: &str, node: &Node, url: &str) -> Option<LinkRecord> {
    let url = url.trim();
    if url.is_empty() || is_external(url) || url.starts_with('#') {
        return None;
    }
    let position = node.position()?;
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
    excluded: &[Range<usize>],
    out: &mut Vec<LinkRecord>,
) {
    let wiki = wiki_regex();
    for cap in wiki.captures_iter(source) {
        let full = cap.get(0).expect("0");
        let preceding_escapes = source.as_bytes()[..full.start()]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        let excluded_index = excluded.partition_point(|span| span.end <= full.start());
        if preceding_escapes % 2 == 1
            || excluded
                .get(excluded_index)
                .is_some_and(|span| span.contains(&full.start()))
        {
            continue;
        }
        let inner = crate::wiki::decode_text(cap.get(1).expect("1").as_str());
        let target = inner
            .split_once('|')
            .map_or(inner.as_str(), |(t, _)| t)
            .trim();
        if target.is_empty() {
            continue;
        }
        // 只用原始 UTF-8 的区间；解码后的字符长度不能用来定位改名写入。
        let start = i64::try_from(full.start()).expect("start");
        let end = i64::try_from(full.end()).expect("end");
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
    url.starts_with("//")
        || url.split_once(':').is_some_and(|(scheme, _)| {
            scheme
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
                && scheme
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'+' | b'-' | b'.'))
        })
}

/// markdown-rs 的 `Point.offset` 是源 UTF-8 字节下标，不是 Unicode 标量下标。
fn point_offset_to_byte(source: &str, offset: usize) -> usize {
    offset.min(source.len())
}
