//! 标签与属性索引：frontmatter 与行内 `#tag` 共享一张 tags 表。
//!
//! 夹具 `tests/search/fixtures/inline-tags.md` 是规则表的权威用例集；
//! TS 侧编辑器分词器落地时必须与本断言集逐条对齐。

use nous_core::{SearchQuery, Vault};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn fixture_vault() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/search/fixtures");
    for entry in fs::read_dir(&fixtures).expect("夹具目录") {
        let entry = entry.expect("夹具项");
        if entry.file_type().expect("类型").is_file() {
            fs::copy(entry.path(), root.path().join(entry.file_name())).expect("复制夹具");
        }
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn indexed_tags(index: &TempDir, path: &str) -> Vec<String> {
    let conn = rusqlite::Connection::open(index.path().join("index.sqlite")).expect("索引库");
    let mut stmt = conn
        .prepare("SELECT tag FROM tags WHERE path = ?1")
        .expect("准备");
    let rows = stmt
        .query_map([path], |row| row.get::<_, String>(0))
        .expect("查询");
    rows.map(|row| row.expect("行")).collect()
}

fn indexed_attributes(index: &TempDir, path: &str) -> Vec<(String, String)> {
    let conn = rusqlite::Connection::open(index.path().join("index.sqlite")).expect("索引库");
    let mut stmt = conn
        .prepare("SELECT key, value FROM attributes WHERE path = ?1")
        .expect("准备");
    let rows = stmt
        .query_map([path], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("查询");
    rows.map(|row| row.expect("行")).collect()
}

#[test]
fn inline_tag_rules_match_fixture_expectations() {
    let (_root, index, _vault) = fixture_vault();
    let mut tags = indexed_tags(&index, "inline-tags.md");
    tags.sort();
    assert_eq!(
        tags,
        [
            // frontmatter：tags/tag 键、`#` 前缀剥离、纯数字丢弃；
            // 行内：标题内、正文、大小写规范化、嵌套、CJK、标点收尾、
            // 反斜杠双转义、链接标签内。整体按字典序。
            "comma",
            "ends-here",
            "escaped",
            "front",
            "hashed",
            "heading-tag",
            "link-label-tag",
            "nested/deep/tag",
            "nested/one",
            "plain",
            "slash",
            "split",
            "upper",
            "日本語",
            "标签",
        ]
    );
}

#[test]
fn frontmatter_attributes_only_model_flat_scalars() {
    let (_root, index, _vault) = fixture_vault();
    let mut attributes = indexed_attributes(&index, "inline-tags.md");
    attributes.sort();
    assert_eq!(
        attributes,
        [
            ("draft".to_string(), "false".to_string()),
            ("list".to_string(), "one".to_string()),
            ("list".to_string(), "two".to_string()),
            ("priority".to_string(), "2".to_string()),
            ("status".to_string(), "active".to_string()),
        ]
    );
}

#[test]
fn tag_search_is_case_insensitive() {
    let (_root, _index, vault) = fixture_vault();
    let hits = vault
        .search(&SearchQuery {
            tags: vec!["PLAIN".to_string()],
            ..SearchQuery::default()
        })
        .expect("检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "inline-tags.md");
}

#[test]
fn ancestor_tag_prefix_matches_nested_tags() {
    let (_root, _index, vault) = fixture_vault();
    // `nested` 命中 `nested/one` 与 `nested/deep/tag`（Obsidian 语义）。
    let hits = vault
        .search(&SearchQuery {
            tags: vec!["nested".to_string()],
            ..SearchQuery::default()
        })
        .expect("检索");
    assert_eq!(hits.len(), 1);
    // 精确子标签同样命中；`nested/o` 这样的半截前缀不命中。
    let exact = vault
        .search(&SearchQuery {
            tags: vec!["nested/one".to_string()],
            ..SearchQuery::default()
        })
        .expect("检索");
    assert_eq!(exact.len(), 1);
    let partial = vault
        .search(&SearchQuery {
            tags: vec!["nested/o".to_string()],
            ..SearchQuery::default()
        })
        .expect("检索");
    assert!(partial.is_empty());
}

#[test]
fn unknown_tag_and_hash_prefixed_query_still_work() {
    let (_root, _index, vault) = fixture_vault();
    let missing = vault
        .search(&SearchQuery {
            tags: vec!["does-not-exist".to_string()],
            ..SearchQuery::default()
        })
        .expect("检索");
    assert!(missing.is_empty());
    // 查询侧带 `#` 前缀等价于不带。
    let hashed = vault
        .search(&SearchQuery {
            tags: vec!["#front".to_string()],
            ..SearchQuery::default()
        })
        .expect("检索");
    assert_eq!(hashed.len(), 1);
}
