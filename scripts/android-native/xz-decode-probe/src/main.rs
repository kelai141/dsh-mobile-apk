use lzma_rust2::{XzReader, XzReaderMt};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::File;
use std::io::{self, BufReader, Read};
use std::time::Instant;

const BUFFER: usize = 256 * 1024;
const XZ_MEMORY_LIMIT_KIB: u32 = 64 * 1024;
const USAGE: &str = "usage: dsh-xz-decode-probe <snapshot.tar.xz> <1|2|4> <tar-bytes> <tar-sha256>";

fn digest(reader: &mut impl Read, expected_bytes: u64) -> io::Result<(u64, String)> {
    let mut buffer = vec![0u8; BUFFER];
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > expected_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "output exceeds expected size",
            ));
        }
        hash.update(&buffer[..count]);
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}

#[cfg(unix)]
fn resources() -> io::Result<(f64, f64, i64)> {
    // SAFETY: getrusage initializes this correctly aligned output when it returns 0.
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let usage = unsafe { usage.assume_init() };
    let ms = |t: libc::timeval| t.tv_sec as f64 * 1000.0 + t.tv_usec as f64 / 1000.0;
    let rss = usage.ru_maxrss as i64;
    // Android and Linux report KiB; Darwin reports bytes.
    let rss_kib = if cfg!(target_os = "macos") {
        rss / 1024
    } else {
        rss
    };
    Ok((ms(usage.ru_utime), ms(usage.ru_stime), rss_kib))
}

#[cfg(not(unix))]
fn resources() -> io::Result<(f64, f64, i64)> {
    Ok((0.0, 0.0, 0))
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let path = args.next().ok_or(USAGE)?;
    let mut text = || args.next().and_then(|v| v.into_string().ok()).ok_or(USAGE);
    let workers: u32 = text()?.parse()?;
    let expected_bytes: u64 = text()?.parse()?;
    let expected_hash = text()?;
    if args.next().is_some()
        || !matches!(workers, 1 | 2 | 4)
        || expected_bytes == 0
        || expected_hash.len() != 64
        || !expected_hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(USAGE.into());
    }

    let file = File::open(path)?;
    let compressed_bytes = file.metadata()?.len();
    let start_usage = resources()?;
    let start = Instant::now();
    let file = BufReader::with_capacity(BUFFER, file);
    // Only trusted APK build assets belong here. The multi-worker crate buffers full blocks.
    let (bytes, sha256) = if workers == 1 {
        digest(
            &mut XzReader::new_mem_limit(file, true, XZ_MEMORY_LIMIT_KIB),
            expected_bytes,
        )?
    } else {
        digest(&mut XzReaderMt::new(file, true, workers)?, expected_bytes)?
    };
    let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
    let (user, system, rss) = resources()?;
    if bytes != expected_bytes || !sha256.eq_ignore_ascii_case(&expected_hash) {
        return Err(format!("decoded tar mismatch: bytes={bytes}, sha256={sha256}").into());
    }
    let cpu = user + system - start_usage.0 - start_usage.1;
    println!(
        "{{\"workers\":{workers},\"compressedBytes\":{compressed_bytes},\"bytes\":{bytes},\"sha256\":\"{sha256}\",\"wallMs\":{wall_ms:.3},\"cpuMs\":{cpu:.3},\"maxRssKiB\":{rss}}}"
    );
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("xz probe failed: {err}");
        std::process::exit(1);
    }
}
