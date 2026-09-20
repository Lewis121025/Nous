use nous_core::{Error, Vault};
use std::fs;
use tempfile::TempDir;

fn vault_with(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    for (name, body) in files {
        fs::write(root.path().join(name), body).expect("写夹具");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开");
    (root, index, vault)
}

#[test]
fn rename_updates_wiki_and_markdown_links() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "See [[B]] and [go](./B.md)\n"),
        ("B.md", "# B\n"),
        ("code.md", "```\n[[B]]\n```\n"),
    ]);

    vault.rename("B.md", "C.md").expect("改名");

    let a = fs::read_to_string(root.path().join("A.md")).expect("A");
    assert!(a.contains("[[C]]"));
    assert!(a.contains("[go](./C.md)"));
    assert!(!a.contains("[[B]]"));
    assert!(!root.path().join("B.md").exists());
    assert!(root.path().join("C.md").exists());

    let code = fs::read_to_string(root.path().join("code.md")).expect("code");
    assert!(code.contains("[[B]]"));

    let incoming = vault.links_to("C.md").expect("入链");
    assert!(incoming.iter().any(|l| l.from_path == "A.md"));
}

#[test]
fn rename_refuses_existing_destination_and_leaves_bytes() {
    let (root, _index, vault) =
        vault_with(&[("A.md", "[[B]]\n"), ("B.md", "b\n"), ("C.md", "c\n")]);
    let a_before = fs::read(root.path().join("A.md")).expect("A");
    let b_before = fs::read(root.path().join("B.md")).expect("B");

    let err = vault.rename("B.md", "C.md").expect_err("应失败");
    assert!(matches!(err, Error::AlreadyExists { .. }));
    assert_eq!(fs::read(root.path().join("A.md")).expect("A"), a_before);
    assert_eq!(fs::read(root.path().join("B.md")).expect("B"), b_before);
}
