//! 全文搜索：结构化查询条件的 SQL 组装与摘要截取。
//!
//! 查询串解析（`tag:`、`key:value`、`path:` 谓词）是上层职责；本模块只接受
//! 结构化条件，用户输入一律进绑定参数，不拼进 SQL 文本。
//!
//! 全文词按长度分两条路径，语义同为「大小写不敏感的子串匹配、词间 AND」：
//!
//! * 全部词 ≥3 字符：FTS5 trigram `MATCH`，`bm25` 相关度排序（标题权重更高）；
//! * 任一词 <3 字符：trigram 无法建索引，回落 `LIKE` 扫描，按路径排序。
//!   1–2 字的中文查询走这条路径，结果正确、速度慢半拍，个人库规模可接受。

use rusqlite::types::ToSql;
use rusqlite::{Connection, Row};

use crate::error::Error;

/// 摘要里包住命中词的起始控制字符；界面按控制字符切分高亮，不会与正文冲突。
pub const SNIPPET_START: char = '\u{1}';
/// 摘要里包住命中词的结束控制字符。
pub const SNIPPET_END: char = '\u{2}';

/// LIKE 回落路径下命中词两侧保留的上下文字符数。
const SNIPPET_CONTEXT: usize = 40;

/// 无全文词时摘要取正文开头的字符数。
const SNIPPET_LEAD: usize = 80;

/// 结构化检索条件；各字段之间是 AND 关系。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    /// 全文词；大小写不敏感子串匹配。
    pub terms: Vec<String>,
    /// 标签谓词；入库前规范化（去 `#`、小写），祖先标签前缀匹配嵌套子标签。
    pub tags: Vec<String>,
    /// 属性谓词 `(key, value)`；键值均大小写不敏感精确匹配。
    pub attributes: Vec<(String, String)>,
    /// 路径子串过滤；大小写敏感。
    pub path_contains: Option<String>,
    /// 结果上限；非正数按 100 处理，最大 500。
    pub limit: i64,
}

/// 一条搜索命中。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    /// 命中文件库内相对路径。
    pub path: String,
    /// 展示标题。
    pub title: String,
    /// 正文摘要；命中词以 [`SNIPPET_START`]/[`SNIPPET_END`] 包围，可能为空串。
    pub snippet: String,
}

/// 执行结构化检索。
///
/// 全空条件返回空结果——搜索必须由用户输入驱动，不做「列出全部」。
///
/// # Errors
///
/// `SQLite` 查询失败。
pub(crate) fn execute(conn: &Connection, query: &SearchQuery) -> Result<Vec<SearchHit>, Error> {
    let terms = normalized_terms(&query.terms);
    let tags = normalized_tags(&query.tags);
    let path_contains = query
        .path_contains
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    if terms.is_empty() && tags.is_empty() && query.attributes.is_empty() && path_contains.is_none()
    {
        return Ok(Vec::new());
    }
    let limit = if query.limit <= 0 {
        100
    } else {
        query.limit.min(500)
    };
    if terms.is_empty() {
        return predicate_only(conn, &tags, &query.attributes, path_contains, limit);
    }
    if terms.iter().all(|term| term.chars().count() >= 3) {
        fts_search(conn, &terms, &tags, &query.attributes, path_contains, limit)
    } else {
        like_search(conn, &terms, &tags, &query.attributes, path_contains, limit)
    }
}

fn normalized_terms(terms: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for term in terms {
        let term = term.trim();
        if !term.is_empty() && !out.iter().any(|existing: &String| existing == term) {
            out.push(term.to_string());
        }
    }
    out
}

fn normalized_tags(tags: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for tag in tags {
        let tag = tag.trim().trim_start_matches('#').trim().to_lowercase();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

/// 只有谓词没有全文词：直接查 `files`，摘要取正文开头。
fn predicate_only(
    conn: &Connection,
    tags: &[String],
    attributes: &[(String, String)],
    path_contains: Option<&str>,
    limit: i64,
) -> Result<Vec<SearchHit>, Error> {
    let mut filters = String::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
    push_filters(&mut filters, &mut params, tags, attributes, path_contains);
    let sql = format!(
        "SELECT files.path, files.title, search_index.body
         FROM files LEFT JOIN search_index ON search_index.path = files.path
         WHERE files.kind = 'markdown'{filters}
         ORDER BY files.path LIMIT {limit}"
    );
    query_hits(conn, &sql, &params, |row| {
        let body: Option<String> = row.get(2)?;
        Ok(SearchHit {
            path: row.get(0)?,
            title: row.get(1)?,
            snippet: lead_snippet(body.as_deref().unwrap_or("")),
        })
    })
}

/// trigram `MATCH` 路径：全部词进一个 MATCH 表达式，按相关度排序。
fn fts_search(
    conn: &Connection,
    terms: &[String],
    tags: &[String],
    attributes: &[(String, String)],
    path_contains: Option<&str>,
    limit: i64,
) -> Result<Vec<SearchHit>, Error> {
    let expression = terms
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut filters = String::new();
    let mut params: Vec<Box<dyn ToSql>> = vec![Box::new(expression)];
    push_filters(&mut filters, &mut params, tags, attributes, path_contains);
    let sql = format!(
        "SELECT files.path, files.title,
                snippet(search_index, 2, '{SNIPPET_START}', '{SNIPPET_END}', '…', 64)
         FROM search_index JOIN files ON files.path = search_index.path
         WHERE search_index MATCH ?1 AND files.kind = 'markdown'{filters}
         ORDER BY bm25(search_index, 0.0, 5.0, 1.0)
         LIMIT {limit}"
    );
    query_hits(conn, &sql, &params, |row| {
        Ok(SearchHit {
            path: row.get(0)?,
            title: row.get(1)?,
            snippet: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        })
    })
}

/// `LIKE` 回落路径：短词（1–2 字）无法进 trigram 索引，逐词扫描正文与标题。
fn like_search(
    conn: &Connection,
    terms: &[String],
    tags: &[String],
    attributes: &[(String, String)],
    path_contains: Option<&str>,
    limit: i64,
) -> Result<Vec<SearchHit>, Error> {
    let mut filters = String::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
    for term in terms {
        let pattern = format!("%{}%", escape_like(term));
        filters.push_str(" AND (search_index.body LIKE ? ESCAPE '\\'");
        filters.push_str(" OR search_index.title LIKE ? ESCAPE '\\')");
        params.push(Box::new(pattern.clone()));
        params.push(Box::new(pattern));
    }
    push_filters(&mut filters, &mut params, tags, attributes, path_contains);
    let sql = format!(
        "SELECT files.path, files.title, search_index.body
         FROM search_index JOIN files ON files.path = search_index.path
         WHERE files.kind = 'markdown'{filters}
         ORDER BY files.path LIMIT {limit}"
    );
    let owned = terms.to_vec();
    query_hits(conn, &sql, &params, move |row| {
        let body: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
        Ok(SearchHit {
            path: row.get(0)?,
            title: row.get(1)?,
            snippet: fallback_snippet(&body, &owned),
        })
    })
}

/// 追加标签/属性/路径谓词；表别名唯一，多个同类谓词可以共存。
fn push_filters(
    filters: &mut String,
    params: &mut Vec<Box<dyn ToSql>>,
    tags: &[String],
    attributes: &[(String, String)],
    path_contains: Option<&str>,
) {
    use std::fmt::Write as _;
    for (index, tag) in tags.iter().enumerate() {
        let _ = write!(
            filters,
            " AND EXISTS (SELECT 1 FROM tags tg{index}
                          WHERE tg{index}.path = files.path
                            AND (tg{index}.tag = ? OR tg{index}.tag LIKE ? ESCAPE '\\'))"
        );
        params.push(Box::new(tag.clone()));
        params.push(Box::new(format!("{}/%", escape_like(tag))));
    }
    for (index, (key, value)) in attributes.iter().enumerate() {
        let _ = write!(
            filters,
            " AND EXISTS (SELECT 1 FROM attributes at{index}
                          WHERE at{index}.path = files.path
                            AND lower(at{index}.key) = lower(?)
                            AND lower(at{index}.value) = lower(?))"
        );
        params.push(Box::new(key.clone()));
        params.push(Box::new(value.clone()));
    }
    if let Some(contains) = path_contains {
        filters.push_str(" AND files.path LIKE ? ESCAPE '\\'");
        params.push(Box::new(format!("%{}%", escape_like(contains))));
    }
}

fn query_hits(
    conn: &Connection,
    sql: &str,
    params: &[Box<dyn ToSql>],
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<SearchHit>,
) -> Result<Vec<SearchHit>, Error> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(params.iter().map(std::convert::AsRef::as_ref)),
        map,
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 转义 LIKE 通配符；调用方统一 `ESCAPE '\'`。
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 取正文开头作摘要（谓词查询没有命中词可圈）。
fn lead_snippet(body: &str) -> String {
    let text = body.trim();
    if text.chars().count() <= SNIPPET_LEAD {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .nth(SNIPPET_LEAD)
        .map_or(text.len(), |(index, _)| index);
    format!("{}…", &text[..cut])
}

/// LIKE 路径的摘要：圈出第一个命中词，两侧按字符数留上下文。
fn fallback_snippet(body: &str, terms: &[String]) -> String {
    let hit = terms
        .iter()
        .filter_map(|term| find_ci(body, term))
        .min_by_key(|(start, _)| *start);
    let Some((start, end)) = hit else {
        // 命中的可能只是标题；退化为正文开头。
        return lead_snippet(body);
    };
    let window_start = body[..start]
        .char_indices()
        .rev()
        .nth(SNIPPET_CONTEXT)
        .map_or(0, |(index, _)| index);
    let window_end = body[end..]
        .char_indices()
        .nth(SNIPPET_CONTEXT)
        .map_or(body.len(), |(index, _)| end + index);
    let prefix = if window_start > 0 { "…" } else { "" };
    let suffix = if window_end < body.len() { "…" } else { "" };
    format!(
        "{prefix}{}{SNIPPET_START}{}{SNIPPET_END}{}{suffix}",
        body[window_start..start].trim_start(),
        &body[start..end],
        body[end..window_end].trim_end(),
    )
}

/// 大小写不敏感子串查找（Unicode 逐字符折叠）；返回原文字节区间。
///
/// 只服务 LIKE 回落路径的摘要圈词：朴素逐位比较，最坏 O(n·m)，
/// 每篇正文只跑一次且命中即返回，个人库规模下无需更复杂的算法。
fn find_ci(haystack: &str, needle: &str) -> Option<(usize, usize)> {
    let needle_chars: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    if needle_chars.is_empty() {
        return None;
    }
    for (start, _) in haystack.char_indices() {
        let mut matched = 0;
        for (offset, ch) in haystack[start..].char_indices() {
            let mut mismatch = false;
            for folded in ch.to_lowercase() {
                if needle_chars.get(matched) != Some(&folded) {
                    mismatch = true;
                    break;
                }
                matched += 1;
            }
            if mismatch {
                break;
            }
            if matched == needle_chars.len() {
                return Some((start, start + offset + ch.len_utf8()));
            }
        }
    }
    None
}
