//! 有界文件日志：Lifecycle 的真实耐久后端。
//!
//! 目录只接受本模块命名的快照与临时文件：
//! - `state-<20 位序号>.json`：已提交快照；
//! - `state-<20 位序号>.json.tmp`：写入中的临时文件。
//!
//! 写入走 create_new -> write_all -> sync_all -> rename -> 目录 sync。
//! 新快照用新序号，从不覆盖旧文件；Windows 与 Unix 都不依赖覆盖式 rename。
//! 已提交快照最多保留 [MAX_COMPLETED_SNAPSHOTS] 份。最高序号快照是唯一
//! 权威状态；它损坏时不会回退到更旧快照。

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::lifecycle::{Journal, JournalError};

/// 已提交快照保留上限。
pub const MAX_COMPLETED_SNAPSHOTS: usize = 2;
/// 单次日志载荷默认上限。
pub const DEFAULT_MAX_JOURNAL_BYTES: usize = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 8;
const SNAPSHOT_PREFIX: &str = "state-";
const SNAPSHOT_SUFFIX: &str = ".json";
const TEMP_SUFFIX: &str = ".json.tmp";
const SEQUENCE_DIGITS: usize = 20;

/// 只由应用 UID 可写的文件日志。
pub struct FileJournal {
    dir: PathBuf,
    max_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Entry {
    sequence: u64,
    temporary: bool,
}

impl FileJournal {
    /// 打开或创建日志目录。目录必须是非符号链接目录。
    pub fn open(dir: impl AsRef<Path>, max_bytes: usize) -> Result<Self, JournalError> {
        if max_bytes == 0 {
            return Err(JournalError::load("journal byte limit must be positive"));
        }
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)
            .map_err(|error| JournalError::load(format!("create journal directory: {error}")))?;
        let metadata = fs::symlink_metadata(&dir)
            .map_err(|error| JournalError::load(format!("inspect journal directory: {error}")))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(JournalError::load("journal path must be a real directory, not a symlink"));
        }

        let journal = Self { dir, max_bytes };
        journal.scan()?;
        Ok(journal)
    }

    pub fn directory(&self) -> &Path {
        &self.dir
    }

    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    fn scan(&self) -> Result<BTreeMap<u64, Entry>, JournalError> {
        let mut entries = BTreeMap::new();
        let mut count = 0usize;
        let iterator = fs::read_dir(&self.dir)
            .map_err(|error| JournalError::load(format!("read journal directory: {error}")))?;
        for item in iterator {
            let item = item.map_err(|error| JournalError::load(format!("read journal entry: {error}")))?;
            count += 1;
            if count > MAX_DIRECTORY_ENTRIES {
                return Err(JournalError::load("journal directory contains too many entries"));
            }
            let file_type = item
                .file_type()
                .map_err(|error| JournalError::load(format!("inspect journal entry: {error}")))?;
            if file_type.is_symlink() {
                return Err(JournalError::load("journal directory contains a symlink"));
            }
            let name = item.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| JournalError::load("journal entry name is not UTF-8"))?;
            let entry = parse_entry(name)
                .ok_or_else(|| JournalError::load(format!("unexpected journal entry {name}")))?;
            if entries.insert(entry.sequence, entry).is_some() {
                return Err(JournalError::load("journal contains duplicate sequence numbers"));
            }
        }
        Ok(entries)
    }

    fn snapshot_path(&self, sequence: u64) -> PathBuf {
        self.dir.join(format!("{SNAPSHOT_PREFIX}{sequence:020}{SNAPSHOT_SUFFIX}"))
    }

    fn temporary_path(&self, sequence: u64) -> PathBuf {
        self.dir.join(format!("{SNAPSHOT_PREFIX}{sequence:020}{TEMP_SUFFIX}"))
    }

    fn prune(&self, entries: &BTreeMap<u64, Entry>) {
        let mut completed: Vec<u64> = entries
            .values()
            .filter(|entry| !entry.temporary)
            .map(|entry| entry.sequence)
            .collect();
        completed.sort_unstable();
        while completed.len() > MAX_COMPLETED_SNAPSHOTS {
            let sequence = completed.remove(0);
            let _ = fs::remove_file(self.snapshot_path(sequence));
        }
    }

    fn remove_temporaries(&self, entries: &BTreeMap<u64, Entry>) {
        for entry in entries.values().filter(|entry| entry.temporary) {
            let _ = fs::remove_file(self.temporary_path(entry.sequence));
        }
    }
}

impl Journal for FileJournal {
    fn load(&mut self) -> Result<Option<Vec<u8>>, JournalError> {
        let metadata = fs::symlink_metadata(&self.dir)
            .map_err(|error| JournalError::load(format!("inspect journal directory: {error}")))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(JournalError::load("journal path is no longer a real directory"));
        }

        let entries = self.scan()?;
        let Some(sequence) = entries
            .values()
            .filter(|entry| !entry.temporary)
            .map(|entry| entry.sequence)
            .max()
        else {
            self.remove_temporaries(&entries);
            self.prune(&entries);
            return Ok(None);
        };
        let bytes = read_snapshot(&self.snapshot_path(sequence), self.max_bytes)?;
        self.remove_temporaries(&entries);
        self.prune(&entries);
        Ok(Some(bytes))
    }

    fn store(&mut self, state: &[u8]) -> Result<(), JournalError> {
        if state.len() > self.max_bytes {
            return Err(JournalError::store(format!(
                "journal payload is {} bytes, limit is {}",
                state.len(),
                self.max_bytes
            )));
        }
        let entries = self.scan()?;
        let highest = entries.keys().next_back().copied().unwrap_or(0);
        let sequence = highest
            .checked_add(1)
            .ok_or_else(|| JournalError::store("journal sequence is exhausted"))?;
        if sequence == 0 {
            return Err(JournalError::store("journal sequence must be positive"));
        }

        let temporary = self.temporary_path(sequence);
        let snapshot = self.snapshot_path(sequence);
        if fs::symlink_metadata(&snapshot).is_ok() {
            return Err(JournalError::store("new snapshot path already exists"));
        }

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let write_result = (|| -> Result<(), JournalError> {
            let mut file = options
                .open(&temporary)
                .map_err(|error| JournalError::store(format!("create journal temporary: {error}")))?;
            file.write_all(state)
                .map_err(|error| JournalError::store(format!("write journal temporary: {error}")))?;
            file.sync_all()
                .map_err(|error| JournalError::store(format!("sync journal temporary: {error}")))?;
            drop(file);
            fs::rename(&temporary, &snapshot)
                .map_err(|error| JournalError::store(format!("commit journal snapshot: {error}")))?;
            sync_directory(&self.dir)?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }

        let after = self.scan()?;
        self.prune(&after);
        self.remove_temporaries(&after);
        Ok(())
    }
}

fn parse_entry(name: &str) -> Option<Entry> {
    let rest = name.strip_prefix(SNAPSHOT_PREFIX)?;
    let (digits, temporary) = if let Some(digits) = rest.strip_suffix(TEMP_SUFFIX) {
        (digits, true)
    } else {
        (rest.strip_suffix(SNAPSHOT_SUFFIX)?, false)
    };
    if digits.len() != SEQUENCE_DIGITS || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let sequence = digits.parse::<u64>().ok()?;
    if sequence == 0 {
        return None;
    }
    Some(Entry { sequence, temporary })
}

fn read_snapshot(path: &Path, max_bytes: usize) -> Result<Vec<u8>, JournalError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| JournalError::load(format!("inspect snapshot: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(JournalError::load("snapshot must be a regular file, not a symlink"));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(JournalError::load(format!(
            "snapshot is {} bytes, limit is {max_bytes}",
            metadata.len()
        )));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file: File = options
        .open(path)
        .map_err(|error| JournalError::load(format!("open snapshot: {error}")))?;
    if !file
        .metadata()
        .map_err(|error| JournalError::load(format!("inspect open snapshot: {error}")))?
        .is_file()
    {
        return Err(JournalError::load("open snapshot is not a regular file"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let read_limit = max_bytes.checked_add(1)
        .ok_or_else(|| JournalError::load("journal byte limit overflow"))?;
    file.take(read_limit as u64).read_to_end(&mut bytes)
        .map_err(|error| JournalError::load(format!("read snapshot: {error}")))?;
    if bytes.len() > max_bytes {
        return Err(JournalError::load("snapshot grew beyond the byte limit"));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn sync_directory(dir: &Path) -> Result<(), JournalError> {
    let directory = File::open(dir)
        .map_err(|error| JournalError::store(format!("open journal directory for sync: {error}")))?;
    directory
        .sync_all()
        .map_err(|error| JournalError::store(format!("sync journal directory: {error}")))
}

#[cfg(not(unix))]
fn sync_directory(_dir: &Path) -> Result<(), JournalError> {
    Ok(())
}
