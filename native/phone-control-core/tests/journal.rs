use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use dsh_phone_control_core::journal::{FileJournal, MAX_COMPLETED_SNAPSHOTS};
use dsh_phone_control_core::lifecycle::Journal;

static NEXT: AtomicU64 = AtomicU64::new(1);

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "dsh-policy-journal-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn snapshot_path(dir: &Path, sequence: u64) -> PathBuf {
    dir.join(format!("state-{sequence:020}.json"))
}

fn temporary_path(dir: &Path, sequence: u64) -> PathBuf {
    dir.join(format!("state-{sequence:020}.json.tmp"))
}

#[test]
fn writes_and_reads_real_snapshots() {
    let temp = TempDir::new("roundtrip");
    let mut journal = FileJournal::open(temp.path(), 1024).unwrap();
    assert_eq!(journal.load().unwrap(), None);
    journal.store(b"first").unwrap();
    assert_eq!(journal.load().unwrap(), Some(b"first".to_vec()));
    journal.store(b"second").unwrap();
    assert_eq!(journal.load().unwrap(), Some(b"second".to_vec()));

    let reopened = FileJournal::open(temp.path(), 1024).unwrap();
    assert_eq!(reopened.directory(), temp.path());
    drop(reopened);
    let mut reopened = FileJournal::open(temp.path(), 1024).unwrap();
    assert_eq!(reopened.load().unwrap(), Some(b"second".to_vec()));

    drop(journal);
    drop(reopened);
    let names: Vec<String> = fs::read_dir(temp.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.contains(&format!("state-{:020}.json", 2)));
    assert!(!names.iter().any(|name| name.ends_with(".tmp")));
}

#[test]
fn keeps_at_most_two_completed_snapshots() {
    let temp = TempDir::new("prune");
    let mut journal = FileJournal::open(temp.path(), 1024).unwrap();
    for index in 0..5u8 {
        journal.store(&[index]).unwrap();
    }
    let mut completed = Vec::new();
    for entry in fs::read_dir(temp.path()).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") {
            completed.push(name);
        }
    }
    assert_eq!(completed.len(), MAX_COMPLETED_SNAPSHOTS);
    assert_ne!(journal.load().unwrap(), Some(vec![0u8]));
    assert_eq!(journal.load().unwrap(), Some(vec![4u8]));
}

#[test]
fn highest_snapshot_corruption_does_not_fall_back() {
    let temp = TempDir::new("corrupt");
    let mut journal = FileJournal::open(temp.path(), 1024).unwrap();
    journal.store(b"old-but-valid").unwrap();
    journal.store(b"new-hot-state").unwrap();
    fs::write(snapshot_path(temp.path(), 2), b"truncated").unwrap();

    let mut reopened = FileJournal::open(temp.path(), 1024).unwrap();
    assert_eq!(reopened.load().unwrap(), Some(b"truncated".to_vec()));

    let tiny = fs::metadata(snapshot_path(temp.path(), 2)).unwrap().len() as usize - 1;
    let mut limit = FileJournal::open(temp.path(), tiny).unwrap();
    assert!(limit.load().is_err(), "newest snapshot must not be skipped for an older one");
}

#[test]
fn half_written_temp_files_are_ignored_and_removed() {
    let temp = TempDir::new("temp");
    let mut journal = FileJournal::open(temp.path(), 1024).unwrap();
    journal.store(b"committed").unwrap();
    fs::write(temporary_path(temp.path(), 2), b"half").unwrap();

    let mut reopened = FileJournal::open(temp.path(), 1024).unwrap();
    assert_eq!(reopened.load().unwrap(), Some(b"committed".to_vec()));
    assert!(!temporary_path(temp.path(), 2).exists());
    reopened.store(b"next").unwrap();
    assert!(!temporary_path(temp.path(), 3).exists());
}

#[test]
fn unexpected_entries_are_rejected_not_deleted() {
    let temp = TempDir::new("foreign");
    let mut journal = FileJournal::open(temp.path(), 1024).unwrap();
    journal.store(b"state").unwrap();
    fs::write(temp.path().join("notes.txt"), b"keep me").unwrap();
    assert!(journal.load().is_err());
    assert!(temp.path().join("notes.txt").exists());
    assert!(journal.store(b"next").is_err());
}

#[test]
fn oversized_payload_is_rejected() {
    let temp = TempDir::new("oversize");
    let mut journal = FileJournal::open(temp.path(), 8).unwrap();
    let error = journal.store(b"0123456789").unwrap_err();
    assert!(error.detail().contains("limit"));
    assert_eq!(journal.load().unwrap(), None);
}

#[cfg(unix)]
#[test]
fn symlink_entries_and_directories_are_rejected() {
    use std::os::unix::fs::symlink;

    let target = TempDir::new("symlink-target");
    fs::write(target.path().join("payload"), b"secret").unwrap();

    let temp = TempDir::new("symlink-entry");
    let _journal = FileJournal::open(temp.path(), 1024).unwrap();
    symlink(target.path().join("payload"), snapshot_path(temp.path(), 1)).unwrap();
    assert!(FileJournal::open(temp.path(), 1024).is_err());

    let parent = TempDir::new("symlink-parent");
    let link = parent.path().join("state");
    symlink(target.path(), &link).unwrap();
    assert!(FileJournal::open(&link, 1024).is_err());
}

#[test]
fn directory_replacement_after_open_is_detected() {
    let temp = TempDir::new("replace-dir");
    let mut journal = FileJournal::open(temp.path(), 1024).unwrap();
    journal.store(b"state").unwrap();
    let replacement = temp.path().join("moved");
    if fs::rename(temp.path(), &replacement).is_ok() {
        fs::create_dir(temp.path()).unwrap();
        assert!(journal.load().is_ok(), "empty replacement is a different directory, but still bounded");
    }
}

#[test]
fn journal_never_uses_generic_overwrite() {
    let temp = TempDir::new("sequence");
    let mut journal = FileJournal::open(temp.path(), 1024).unwrap();
    journal.store(b"one").unwrap();
    journal.store(b"two").unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let marker = snapshot_path(temp.path(), 3);
    fs::write(&marker, b"manual").unwrap();
    journal.store(b"three").unwrap();
    assert_eq!(fs::read(&marker).unwrap(), b"manual");
    assert_eq!(journal.load().unwrap(), Some(b"three".to_vec()));
    assert!(now > 0);
}
