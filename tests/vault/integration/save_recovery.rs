use nous_core::{Vault, WriteOutcome};
use std::fs;
use std::sync::{Arc, Barrier};
use tempfile::TempDir;

fn setup() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("note.md"), b"base").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    (root, index, vault)
}

#[test]
fn external_edit_is_not_overwritten_by_autosave() {
    let (root, index, vault) = setup();
    let base = vault.read("note.md").unwrap();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    let result = vault.write("note.md", b"my edits", Some(&base)).unwrap();
    assert!(matches!(result, WriteOutcome::Conflict { disk: Some(bytes) } if bytes == b"external"));
    assert_eq!(vault.read("note.md").unwrap(), b"external");
    drop(vault);

    let reopened = Vault::open(root.path(), index.path()).unwrap();
    let snapshot = reopened.snapshot("note.md").unwrap();
    let draft = snapshot.draft.unwrap();
    assert_eq!(draft.bytes, b"my edits");
    assert_eq!(draft.base, Some(base));
    assert_eq!(snapshot.disk.unwrap(), b"external");
}

#[test]
fn deleted_file_remains_deleted_and_its_draft_is_discoverable_after_restart() {
    let (root, index, vault) = setup();
    fs::remove_file(root.path().join("note.md")).unwrap();
    assert!(matches!(
        vault.write("note.md", b"my edits", Some(b"base")).unwrap(),
        WriteOutcome::Conflict { disk: None }
    ));
    assert!(!root.path().join("note.md").exists());
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(reopened.list_files().unwrap(), vec!["note.md"]);
    let snapshot = reopened.snapshot("note.md").unwrap();
    assert!(snapshot.disk.is_none());
    assert_eq!(snapshot.draft.unwrap().bytes, b"my edits");
}

#[test]
fn io_failure_keeps_latest_draft_and_retry_clears_it() {
    let (root, index, vault) = setup();
    fs::remove_file(root.path().join("note.md")).unwrap();
    fs::create_dir(root.path().join("note.md")).unwrap();
    assert!(vault
        .write("note.md", b"latest edits", Some(b"base"))
        .is_err());
    fs::remove_dir(root.path().join("note.md")).unwrap();
    fs::write(root.path().join("note.md"), b"base").unwrap();
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(
        reopened.snapshot("note.md").unwrap().draft.unwrap().bytes,
        b"latest edits"
    );
    assert!(matches!(
        reopened
            .write("note.md", b"latest edits", Some(b"base"))
            .unwrap(),
        WriteOutcome::Saved { warning: None }
    ));
    assert!(reopened.snapshot("note.md").unwrap().draft.is_none());
    assert_eq!(reopened.read("note.md").unwrap(), b"latest edits");
}

#[test]
fn index_failure_reports_committed_content_and_does_not_cause_a_false_conflict() {
    let (_root, index, vault) = setup();
    let probe = rusqlite::Connection::open(index.path().join("index.sqlite")).unwrap();
    probe.execute_batch("CREATE TRIGGER reject_update BEFORE UPDATE ON files BEGIN SELECT RAISE(ABORT, 'test index failure'); END;").unwrap();
    let saved = vault
        .write("note.md", b"first save", Some(b"base"))
        .unwrap();
    assert!(matches!(saved, WriteOutcome::Saved { warning: Some(_) }));
    assert_eq!(vault.read("note.md").unwrap(), b"first save");
    assert!(vault.snapshot("note.md").unwrap().draft.is_none());
    probe.execute_batch("DROP TRIGGER reject_update;").unwrap();
    assert!(matches!(
        vault
            .write("note.md", b"second save", Some(b"first save"))
            .unwrap(),
        WriteOutcome::Saved { warning: None }
    ));
}

#[test]
fn saving_a_copy_preserves_both_versions_and_existing_copies() {
    let (root, _index, vault) = setup();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    fs::write(root.path().join("note (副本).md"), b"older copy").unwrap();
    vault.write("note.md", b"draft", Some(b"base")).unwrap();
    let copy = vault
        .write_copy("note.md", b"newer draft", Some(b"base"))
        .unwrap();
    assert_eq!(copy.path, "note (副本 2).md");
    assert!(copy.warning.is_none());
    assert_eq!(vault.read(&copy.path).unwrap(), b"newer draft");
    assert_eq!(vault.read("note.md").unwrap(), b"external");
    assert_eq!(vault.read("note (副本).md").unwrap(), b"older copy");
    assert!(vault.snapshot("note.md").unwrap().draft.is_none());
}

#[test]
fn concurrent_saves_from_the_same_base_cannot_both_commit() {
    let (_root, _index, vault) = setup();
    let vault = Arc::new(vault);
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = [b"one", b"two"]
        .into_iter()
        .map(|bytes| {
            let vault = Arc::clone(&vault);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                vault.write("note.md", bytes, Some(b"base")).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, WriteOutcome::Saved { .. }))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, WriteOutcome::Conflict { .. }))
            .count(),
        1
    );
}

#[test]
fn existing_temporary_named_file_is_never_truncated() {
    let (root, _index, vault) = setup();
    fs::write(root.path().join("note.nous-tmp"), b"valuable").unwrap();
    vault.write("note.md", b"edited", Some(b"base")).unwrap();
    assert_eq!(
        fs::read(root.path().join("note.nous-tmp")).unwrap(),
        b"valuable"
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn missing_expected_version_cannot_replace_an_existing_file() {
    let (_root, _index, vault) = setup();
    assert!(matches!(
        vault.write("note.md", b"new", None).unwrap(),
        WriteOutcome::Conflict { .. }
    ));
    assert_eq!(vault.read("note.md").unwrap(), b"base");
}

#[test]
fn recovery_storage_failure_leaves_the_original_untouched() {
    let (_root, index, vault) = setup();
    let probe = rusqlite::Connection::open(index.path().join("recovery.sqlite")).unwrap();
    probe.execute_batch("CREATE TRIGGER reject_draft BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT, 'test recovery failure'); END;").unwrap();
    assert!(vault.write("note.md", b"edited", Some(b"base")).is_err());
    assert_eq!(vault.read("note.md").unwrap(), b"base");
}

#[test]
fn latest_conflicting_edits_replace_the_recoverable_draft() {
    let (root, index, vault) = setup();
    fs::write(root.path().join("note.md"), b"external").unwrap();
    vault.write("note.md", b"first", Some(b"base")).unwrap();
    vault.write("note.md", b"latest", Some(b"base")).unwrap();
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(
        reopened.snapshot("note.md").unwrap().draft.unwrap().bytes,
        b"latest"
    );
    assert_eq!(reopened.read("note.md").unwrap(), b"external");
}
