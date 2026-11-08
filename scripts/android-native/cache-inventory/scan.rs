//! Read-only measurement of a cache subtree; it never selects or removes entries.
use std::{fs, io, path::Path};

fn measure(path: &Path) -> io::Result<(u64, u64)> {
    let stat = fs::symlink_metadata(path)?;
    if !stat.is_dir() {
        return Ok((if stat.is_file() { stat.len() } else { 0 }, 1));
    }
    let (mut bytes, mut files) = (0_u64, 0_u64);
    for entry in fs::read_dir(path)? {
        let Ok(entry) = entry else { continue };
        if let Ok((b, f)) = measure(&entry.path()) {
            bytes = bytes.saturating_add(b);
            files = files.saturating_add(f);
        }
    }
    Ok((bytes, files))
}

fn main() -> io::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let root = args
        .next()
        .filter(|_| args.next().is_none())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "usage: cache-inventory <test directory>",
            )
        })?;
    let (bytes, files) = measure(Path::new(&root))?;
    println!("bytes={bytes} files={files}");
    Ok(())
}
