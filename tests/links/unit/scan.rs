use nous_core::{LinkKind, Vault};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn copy_fixture_dir(name: &str) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/links/fixtures");
    for entry in fs::read_dir(&fixtures).expect("夹具目录") {
        let entry = entry.expect("夹具项");
        if entry.file_type().expect("类型").is_file() {
            fs::copy(entry.path(), root.path().join(entry.file_name())).expect("复制夹具");
        }
    }
    let _ = name;
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

fn source_slice(root: &Path, rel: &str, start: i64, end: i64) -> String {
    let bytes = fs::read(root.join(rel)).expect("读源");
    let start = usize::try_from(start).expect("start");
    let end = usize::try_from(end).expect("end");
    String::from_utf8(bytes[start..end].to_vec()).expect("utf8")
}

#[test]
fn fenced_and_inline_code_wiki_are_not_indexed() {
    let (_root, _index, vault) = copy_fixture_dir("code");
    let from = vault.links_from("code_and_wiki.md").expect("出链");
    let raws: Vec<&str> = from.iter().map(|l| l.to_raw.as_str()).collect();
    assert!(!raws.iter().any(|r| r.contains("FakeFence")));
    assert!(!raws.iter().any(|r| r.contains("FakeInline")));
    assert!(raws.contains(&"Other"));
}

#[test]
fn wiki_and_markdown_links_record_byte_ranges() {
    let (root, _index, vault) = copy_fixture_dir("ranges");
    let from = vault.links_from("source.md").expect("出链");
    assert_eq!(from.len(), 2);

    let wiki = from
        .iter()
        .find(|l| l.kind == LinkKind::Wiki)
        .expect("wiki");
    assert_eq!(wiki.to_raw, "Other");
    assert_eq!(wiki.to_path.as_deref(), Some("Other.md"));
    assert_eq!(
        source_slice(root.path(), "source.md", wiki.start_byte, wiki.end_byte),
        "[[Other]]"
    );

    let md = from
        .iter()
        .find(|l| l.kind == LinkKind::Markdown)
        .expect("md");
    assert_eq!(md.to_raw, "./Other.md");
    assert_eq!(md.to_path.as_deref(), Some("Other.md"));
    assert_eq!(
        source_slice(root.path(), "source.md", md.start_byte, md.end_byte),
        "[label](./Other.md)"
    );
}

#[test]
fn links_to_other_includes_source() {
    let (_root, _index, vault) = copy_fixture_dir("backlinks");
    let incoming = vault.links_to("Other.md").expect("入链");
    let sources: Vec<&str> = incoming.iter().map(|l| l.from_path.as_str()).collect();
    assert!(sources.contains(&"source.md"));
    assert!(sources.contains(&"code_and_wiki.md"));
}
