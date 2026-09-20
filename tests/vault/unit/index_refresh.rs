//! 写入与刷新只处理变化文件：未改的兄弟文件即使不可读也不应挡住索引更新。

use nous_core::Vault;
use std::fs;
use tempfile::TempDir;

fn open_temp_vault(files: &[(&str, &str)]) -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().expect("库目录");
    let index = TempDir::new().expect("索引目录");
    for (name, body) in files {
        fs::write(root.path().join(name), body).expect("写夹具");
    }
    let vault = Vault::open(root.path(), index.path()).expect("打开库");
    (root, index, vault)
}

#[cfg(unix)]
fn make_unreadable(path: &std::path::Path) -> fs::Permissions {
    use std::os::unix::fs::PermissionsExt;
    let previous = fs::metadata(path).expect("元数据").permissions();
    fs::set_permissions(path, fs::Permissions::from_mode(0o000)).expect("去掉读权限");
    previous
}

#[cfg(unix)]
fn restore_permissions(path: &std::path::Path, permissions: fs::Permissions) {
    fs::set_permissions(path, permissions).expect("恢复权限");
}

#[cfg(unix)]
#[test]
fn write_updates_own_links_without_reading_unreadable_sibling() {
    let (root, _index, vault) = open_temp_vault(&[("A.md", "hello\n"), ("B.md", "[[C]]\n")]);
    assert!(vault.links_from("A.md").expect("A 出链").is_empty());

    let sibling = root.path().join("B.md");
    let previous = make_unreadable(&sibling);
    let written = vault.write("A.md", b"[[C]]\n");
    restore_permissions(&sibling, previous);
    written.expect("写 A 不应去读 B");

    let outgoing = vault.links_from("A.md").expect("A 新出链");
    assert!(outgoing.iter().any(|link| link.to_raw == "C"));
    let from_b = vault.links_from("B.md").expect("B 出链保持打开时的快照");
    assert!(from_b.iter().any(|link| link.to_raw == "C"));
}

#[cfg(unix)]
#[test]
fn refresh_skips_unreadable_unchanged_sibling() {
    let (root, _index, vault) = open_temp_vault(&[("A.md", "hello\n"), ("B.md", "[[C]]\n")]);
    let sibling = root.path().join("B.md");
    let previous = make_unreadable(&sibling);
    let refreshed = vault.refresh_index();
    restore_permissions(&sibling, previous);
    refreshed.expect("未改的 B 不可读时刷新仍应成功");
    let from_b = vault.links_from("B.md").expect("B 出链");
    assert!(from_b.iter().any(|link| link.to_raw == "C"));
}

#[test]
fn write_after_external_delete_re_resolves_remaining_wiki() {
    let (root, _index, vault) =
        open_temp_vault(&[("A.md", "hello\n"), ("B.md", "# B\n"), ("C.md", "[[B]]\n")]);
    assert!(vault
        .links_from("C.md")
        .expect("C")
        .iter()
        .any(|link| link.to_path.as_deref() == Some("B.md")));

    fs::remove_file(root.path().join("B.md")).expect("删 B");
    vault.write("A.md", b"hello again\n").expect("写 A");

    let from_c = vault.links_from("C.md").expect("C 应重算");
    assert!(from_c
        .iter()
        .any(|link| link.to_raw == "B" && link.to_path.is_none()));
    assert!(vault.links_to("B.md").expect("入链").is_empty());
}

#[test]
fn write_new_unique_note_resolves_existing_dead_wiki() {
    let (_root, _index, vault) = open_temp_vault(&[("A.md", "[[B]]\n")]);
    let before = vault.links_from("A.md").expect("打开时");
    assert!(before
        .iter()
        .any(|link| link.to_raw == "B" && link.to_path.is_none()));

    vault.write("B.md", b"# B\n").expect("新建 B");

    let incoming = vault.links_to("B.md").expect("入链");
    assert!(incoming.iter().any(|link| link.from_path == "A.md"));
}

#[test]
fn refresh_rescans_when_scan_version_is_stale() {
    let prefix = "字".repeat(200);
    let body = format!("{prefix}[a](./t.md)\n");
    let (root, index, vault) = open_temp_vault(&[("t.md", "# t\n"), ("src.md", &body)]);
    let good = vault.links_from("src.md").expect("出链");
    assert_eq!(good.len(), 1);
    let good_start = good[0].start_byte;
    assert_ne!(good_start, 0);
    drop(vault);

    let conn = rusqlite::Connection::open(index.path().join("index.sqlite")).expect("索引库");
    conn.execute("UPDATE links SET start_byte = 0, end_byte = 0", [])
        .expect("污染区间");
    conn.pragma_update(None, "user_version", 0)
        .expect("旧扫描版本");
    drop(conn);

    let vault = Vault::open(root.path(), index.path()).expect("重开");
    let restored = vault.links_from("src.md").expect("重扫后");
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].start_byte, good_start);
}
