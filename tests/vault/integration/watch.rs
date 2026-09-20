use nous_core::Vault;
use std::fs;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;

#[test]
fn external_edit_refreshes_backlinks_after_debounce() {
    let root = TempDir::new().expect("库");
    let index = TempDir::new().expect("索引");
    fs::write(root.path().join("A.md"), "hello\n").expect("A");
    fs::write(root.path().join("B.md"), "# B\n").expect("B");
    let vault = Arc::new(Vault::open(root.path(), index.path()).expect("打开"));
    assert!(vault.links_to("B.md").expect("入链").is_empty());

    let (tx, rx) = mpsc::channel();
    let watched = Arc::clone(&vault);
    let _handle = nous_core::start_watch(
        root.path().to_path_buf(),
        Duration::from_millis(80),
        move || {
            let _ = watched.refresh_index();
            let _ = tx.send(());
        },
    )
    .expect("监视");

    fs::write(root.path().join("A.md"), "[[B]]\n").expect("外改");
    rx.recv_timeout(Duration::from_secs(3)).expect("等到监视回调");

    let incoming = vault.links_to("B.md").expect("刷新后入链");
    assert!(incoming.iter().any(|link| link.from_path == "A.md"));
}
