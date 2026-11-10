use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::time::Instant;

const FRAME_LIMIT: usize = 64 * 1024;
const OUTPUT_BUDGET: usize = 8 * 1024 * 1024;

fn header(path: &str) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut input = BufReader::with_capacity(8192, file.take(FRAME_LIMIT as u64));
    let prefix = input.fill_buf().ok()?;
    // Match the installed scanner's magic and reserved/unused bits. Anything
    // unsupported or unreadable goes through the unchanged upstream reader.
    if !prefix.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) || prefix.get(4)? & 0x18 != 0 {
        return None;
    }
    let mut decoder = zstd::stream::read::Decoder::with_buffer(input)
        .ok()?
        .single_frame();
    decoder.window_log_max(23).ok()?;
    let mut bytes = Vec::new();
    decoder
        .take((FRAME_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > FRAME_LIMIT || bytes.pop()? != b'\n' || bytes.contains(&b'\n') {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn usage() -> io::Result<libc::rusage> {
    let mut usage = std::mem::MaybeUninit::uninit();
    // SAFETY: getrusage initializes the structure when it returns success.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { usage.assume_init() })
}

fn cpu_ms(rusage: &libc::rusage) -> f64 {
    let ms = |t: libc::timeval| t.tv_sec as f64 * 1000.0 + t.tv_usec as f64 / 1000.0;
    ms(rusage.ru_utime) + ms(rusage.ru_stime)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let start = usage()?;
    let mut request = Vec::new();
    io::stdin()
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut request)?;
    if request.len() > 4 * 1024 * 1024 {
        return Err("request too large".into());
    }
    let paths: Vec<String> = serde_json::from_slice(&request)?;
    if paths.len() > 5000 {
        return Err("too many paths".into());
    }
    let mut stored = 0;
    let mut headers = Vec::with_capacity(paths.len());
    for path in paths {
        let row = header(&path).filter(|row| stored + row.len() <= OUTPUT_BUDGET);
        stored += row.as_ref().map_or(0, String::len);
        headers.push(row);
    }
    let stats = usage()?;
    serde_json::to_writer(
        io::stdout().lock(),
        &serde_json::json!({
            "headers": headers,
            "cpuMs": cpu_ms(&stats) - cpu_ms(&start),
            "maxRssKiB": stats.ru_maxrss,
            "workMs": started.elapsed().as_secs_f64() * 1000.0,
        }),
    )?;
    Ok(())
}
