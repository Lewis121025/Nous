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

#[test]
fn rename_updates_links_after_multibyte_prefix() {
    let prefix = "字".repeat(200);
    let body = format!("{prefix}[[B]] {prefix}[go](./B.md)\n");
    let (root, _index, vault) = vault_with(&[("A.md", &body), ("B.md", "# B\n")]);

    vault.rename("B.md", "C.md").expect("改名");

    let a = fs::read_to_string(root.path().join("A.md")).expect("A");
    assert!(a.contains("[[C]]"));
    assert!(a.contains("[go](./C.md)"));
    assert!(!a.contains("[[B]]"));
    assert!(!a.contains("./B.md"));
}

#[test]
fn rename_keeps_markdown_and_wiki_fragments() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[go](./B.md#sec) [[B#sec]] [[B#sec|别名]]\n"),
        ("B.md", "# B\n"),
    ]);

    vault.rename("B.md", "C.md").expect("改名");

    let a = fs::read_to_string(root.path().join("A.md")).expect("A");
    assert!(a.contains("[go](./C.md#sec)"));
    assert!(a.contains("[[C#sec]]"));
    assert!(a.contains("[[C#sec|别名]]"));
    assert!(!a.contains("B.md"));
    assert!(!a.contains("[[B"));

    let incoming = vault.links_to("C.md").expect("入链");
    assert_eq!(incoming.len(), 3);
}

#[test]
fn rename_preserves_surrounding_text_and_encoded_wiki_targets() {
    let body = "中文 \\* &amp; [[A&#38;B|别名]] tail\n";
    let (root, _index, vault) = vault_with(&[("src.md", body), ("A&B.md", "note")]);
    vault.rename("A&B.md", "C&D.md").expect("改名");
    let saved = fs::read_to_string(root.path().join("src.md")).expect("读回");
    assert_eq!(saved, "中文 \\* &amp; [[C&#38;D|别名]] tail\n");
    assert_eq!(vault.links_to("C&D.md").expect("入链").len(), 1);
}

#[test]
fn rename_keeps_wiki_alias_separator_escaped_in_tables() {
    let (root, _index, vault) = vault_with(&[
        ("src.md", "| Note |\n| --- |\n| [[B\\|别名]] |\n"),
        ("B.md", "note"),
    ]);
    vault.rename("B.md", "C.md").expect("改名");
    assert_eq!(
        fs::read_to_string(root.path().join("src.md")).expect("读回"),
        "| Note |\n| --- |\n| [[C\\|别名]] |\n"
    );
}

#[test]
fn rename_uses_current_source_instead_of_stale_index_offsets() {
    let (root, _index, vault) = vault_with(&[("A.md", "[[B]]\n"), ("B.md", "note")]);
    fs::write(root.path().join("A.md"), "新增正文 [[B]]\n").unwrap();
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "新增正文 [[C]]\n"
    );
}

#[test]
fn invalid_destination_parent_does_not_leave_rewritten_backlinks() {
    let (root, _index, vault) =
        vault_with(&[("A.md", "[[B]]\n"), ("B.md", "note"), ("blocked", "file")]);
    assert!(vault.rename("B.md", "blocked/C.md").is_err());
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[[B]]\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("B.md")).unwrap(),
        "note"
    );
}

#[test]
fn rename_preserves_markdown_titles_and_balanced_destination_syntax() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[label](<./B.md#sec> \"title ](x)\")\n"),
        ("B.md", "note"),
    ]);
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[label](<./C.md#sec> \"title ](x)\")\n"
    );
}

#[test]
fn moving_a_note_preserves_outgoing_relative_links_and_self_links() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[B](./B.md)\n"),
        ("B.md", "[peer](./A.md#sec) [[B]] [self](./B.md)\n"),
    ]);
    vault.rename("B.md", "nested/C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[B](./nested/C.md)\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("nested/C.md")).unwrap(),
        "[peer](../A.md#sec) [[C]] [self](./C.md)\n"
    );
    assert_eq!(vault.links_to("nested/C.md").unwrap().len(), 3);
    assert_eq!(vault.links_to("A.md").unwrap().len(), 1);
}

#[test]
fn wiki_links_in_markdown_labels_are_rewritten_without_overlapping_edits() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[see [[B]]](./B.md \"title\")\n"),
        ("B.md", "note"),
    ]);
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[see [[C]]](./C.md \"title\")\n"
    );
    assert_eq!(vault.links_to("C.md").unwrap().len(), 2);
}

#[test]
fn renamed_special_characters_are_encoded_and_resolve_back_to_the_actual_filename() {
    let (root, _index, vault) = vault_with(&[
        ("A.md", "[`]`](./B.md#sec 'keep title')\n"),
        ("B.md", "note"),
    ]);
    vault.rename("B.md", "C (一)&.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[`]`](./C%20%28%E4%B8%80%29%26.md#sec 'keep title')\n"
    );
    assert_eq!(vault.links_to("C (一)&.md").unwrap().len(), 1);
}

#[test]
fn files_added_and_links_removed_since_indexing_use_the_current_disk_state() {
    let (root, _index, vault) = vault_with(&[("A.md", "[[B]]\n"), ("B.md", "note")]);
    fs::write(root.path().join("A.md"), "unrelated content\n").unwrap();
    fs::write(root.path().join("new.md"), "new [[B]]\n").unwrap();
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "unrelated content\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("new.md")).unwrap(),
        "new [[C]]\n"
    );
}

#[test]
fn ambiguous_wiki_target_names_are_rejected_before_any_file_changes() {
    let (root, _index, vault) =
        vault_with(&[("A.md", "[[B]]\n"), ("B.md", "note"), ("C.txt", "other")]);
    assert!(vault
        .rename("B.md", "C.md")
        .unwrap_err()
        .to_string()
        .contains("歧义"));
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        "[[B]]\n"
    );
    assert!(root.path().join("B.md").exists());
    assert!(!root.path().join("C.md").exists());
}

#[test]
fn reference_links_rewrite_only_the_effective_definition_and_keep_labels() {
    let source = "[guide][REF] [ref][] [ref]\n\n[ref]: <./B.md#sec> \"keep title\"\n[REF]: ./ignored.md\n[unused]: ./B.md\n";
    let (root, _index, vault) = vault_with(&[("A.md", source), ("B.md", "note")]);
    vault.rename("B.md", "C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        source.replacen("<./B.md#sec>", "<./C.md#sec>", 1)
    );
    assert_eq!(vault.links_to("C.md").unwrap().len(), 1);
}

#[test]
fn renaming_an_image_updates_inline_and_reference_images() {
    let source =
        "![a [nested] label](./photo.png \"caption\") ![second][image]\n\n[image]: <./photo.png>\n";
    let (root, _index, vault) = vault_with(&[("A.md", source), ("photo.png", "image bytes")]);
    vault.rename("photo.png", "new photo.png").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("A.md")).unwrap(),
        source.replace("./photo.png", "./new%20photo.png")
    );
    assert_eq!(vault.links_to("new photo.png").unwrap().len(), 2);
    assert_eq!(
        fs::read(root.path().join("new photo.png")).unwrap(),
        b"image bytes"
    );
}

#[test]
fn moving_a_note_rebases_images_and_reference_definitions() {
    let source = "![photo](./photo.png) [peer][p]\n\n[p]: ./A.md \"title\"\n";
    let (root, _index, vault) = vault_with(&[
        ("A.md", "peer"),
        ("B.md", source),
        ("photo.png", "image bytes"),
    ]);
    vault.rename("B.md", "nested/C.md").unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("nested/C.md")).unwrap(),
        "![photo](../photo.png) [peer][p]\n\n[p]: ../A.md \"title\"\n"
    );
    assert_eq!(vault.links_from("nested/C.md").unwrap().len(), 2);
}
