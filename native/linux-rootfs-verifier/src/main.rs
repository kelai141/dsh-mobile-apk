use nix::dir::Dir;
use nix::fcntl::{open, openat, readlinkat, AtFlags, OFlag};
use nix::sys::stat::{fstatat, Mode, SFlag};
use nix::unistd::{symlinkat, unlinkat, UnlinkatFlags};
use std::io;
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

const VERIFIED: &str = "dsh-rootfs-verified-v1";

fn invalid(detail: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, detail)
}

fn directory_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW
}

// Resolve guest targets lexically. No host lookup may follow a guest symlink.
fn guest_link(root: &Path, parent: &Path, link: &str) -> io::Result<Option<PathBuf>> {
    if link.is_empty() {
        return Err(invalid("Empty guest link"));
    }
    let absolute = link.starts_with('/');
    let joined = if absolute {
        root.join(link.trim_start_matches('/'))
    } else {
        parent.join(link)
    };
    let mut resolved = PathBuf::from("/");
    for component in joined.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::ParentDir => {
                resolved.pop();
            }
            _ => {}
        }
    }
    if !resolved.starts_with(root) {
        return Err(invalid("Guest link leaves the rootfs"));
    }
    if !absolute {
        return Ok(None);
    }
    let shared = parent
        .components()
        .zip(resolved.components())
        .take_while(|(a, b)| a == b)
        .count();
    let mut relative = PathBuf::new();
    for _ in parent.components().skip(shared) {
        relative.push("..");
    }
    for part in resolved.components().skip(shared) {
        relative.push(part);
    }
    if relative.as_os_str().is_empty() {
        relative.push(".");
    }
    Ok(Some(relative))
}

fn walk(root: &Path, parent: &Path, fd: OwnedFd) -> io::Result<()> {
    let mut directory = Dir::from_fd(fd.try_clone()?)?;
    for entry in directory.iter() {
        let entry = entry?;
        let name = entry.file_name();
        let text = name
            .to_str()
            .map_err(|_| invalid("Invalid UTF-8 entry name"))?;
        if text == "." || text == ".." {
            continue;
        }
        let stat = fstatat(&fd, name, AtFlags::AT_SYMLINK_NOFOLLOW)?;
        match SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT {
            SFlag::S_IFREG => {}
            SFlag::S_IFDIR => {
                let child = openat(&fd, name, directory_flags(), Mode::empty())?;
                walk(root, &parent.join(text), child)?;
            }
            SFlag::S_IFLNK => {
                let target = readlinkat(&fd, name)?;
                let value = target
                    .to_str()
                    .ok_or_else(|| invalid("Invalid UTF-8 guest link"))?;
                if let Some(relative) = guest_link(root, parent, value)? {
                    unlinkat(&fd, name, UnlinkatFlags::NoRemoveDir)?;
                    // A failed replacement invalidates the candidate. A later walk
                    // could no longer see the removed link and must not retry it.
                    symlinkat(&relative, &fd, name).map_err(|error| {
                        io::Error::other(format!("Could not replace guest link: {error}"))
                    })?;
                }
            }
            _ => return Err(invalid("Unsupported rootfs entry type")),
        }
    }
    Ok(())
}

fn verify(root: &Path) -> io::Result<()> {
    if !root.is_absolute() || root.components().any(|p| p == Component::ParentDir) {
        return Err(invalid("Expected an absolute claimed tree path"));
    }
    let fd = open(root, directory_flags(), Mode::empty())?;
    walk(root, root, fd)
}

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(root) = args.next() else {
        return ExitCode::from(2);
    };
    if args.next().is_some() {
        return ExitCode::from(2);
    }
    match verify(Path::new(&root)) {
        Ok(()) => {
            println!("{VERIFIED}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            // A descriptor-starved device can retry the original full worker walk.
            match error.raw_os_error() {
                Some(nix::libc::EMFILE | nix::libc::ENFILE) => ExitCode::from(3),
                _ => ExitCode::FAILURE,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};
    #[test]
    fn target_names_match_guest_root_and_relative_directory_semantics() {
        let root = Path::new("/app/claimed/unpacked");
        let parent = root.join("usr/lib");
        assert_eq!(
            guest_link(root, &parent, "/usr/bin/env").unwrap(),
            Some("../bin/env".into())
        );
        assert_eq!(
            guest_link(root, &parent, "/usr/lib/").unwrap(),
            Some(".".into())
        );
        assert_eq!(
            guest_link(root, &parent, "/").unwrap(),
            Some("../..".into())
        );
        assert_eq!(guest_link(root, &parent, "../bin/env").unwrap(), None);
        assert!(guest_link(root, &parent, "").is_err());
        assert!(guest_link(root, &parent, "../../../outside").is_err());
    }

    #[test]
    fn walk_normalizes_only_guest_links_and_rejects_unsupported_entries() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let scratch =
            std::env::temp_dir().join(format!("rootfs-verify-{}-{nonce}", std::process::id()));
        fs::create_dir(&scratch).unwrap();
        let root = scratch.join("tree");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(root.join("data"), b"inside").unwrap();
        fs::write(scratch.join("outside"), b"preserved").unwrap();
        symlink("/data", sub.join("absolute")).unwrap();
        symlink("../data", sub.join("relative")).unwrap();
        verify(&root).unwrap();
        assert_eq!(
            fs::read_link(sub.join("absolute")).unwrap(),
            Path::new("../data")
        );
        assert_eq!(
            fs::read_link(sub.join("relative")).unwrap(),
            Path::new("../data")
        );
        symlink("../../outside", sub.join("invalid")).unwrap();
        assert!(verify(&root).is_err());
        fs::remove_file(sub.join("invalid")).unwrap();
        let socket = sub.join("socket");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        assert!(verify(&root).is_err());
        drop(listener);
        fs::remove_file(socket).unwrap();
        symlink(&root, scratch.join("alias")).unwrap();
        assert!(verify(&scratch.join("alias")).is_err());
        assert_eq!(fs::read(scratch.join("outside")).unwrap(), b"preserved");
        fs::remove_dir_all(scratch).unwrap();
    }
}
