use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;

const LIMIT: usize = 50_000;
const TOP: usize = 20;
const EXCLUDED: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    "target",
    ".next",
    ".nuxt",
    ".turbo",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".gradle",
];

struct Entry {
    path: String,
    sort: Vec<u16>,
    lower: Vec<u16>,
    name_at: usize,
    directory: bool,
    hidden: bool,
}

fn scan(root: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut dirs = vec![(root.to_path_buf(), String::new())];
    let mut at = 0;
    while at < dirs.len() && entries.len() < LIMIT {
        let (absolute, rel) = dirs[at].clone();
        let children = match fs::read_dir(absolute) {
            Ok(result) => result,
            Err(error) if at == 0 => return Err(error),
            Err(_) => {
                at += 1;
                continue;
            }
        };
        at += 1;
        let mut sorted = Vec::new();
        for item in children {
            let item = item?;
            let name = item.file_name().into_string().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "non-Unicode path outside probe scope",
                )
            })?;
            sorted.push((name.encode_utf16().collect::<Vec<_>>(), name, item));
        }
        sorted.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        for (_, name, item) in sorted {
            let kind = item.file_type()?;
            let directory = kind.is_dir();
            if (!directory && !kind.is_file()) || (directory && EXCLUDED.contains(&name.as_str())) {
                continue;
            }
            let path = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let sort = path.encode_utf16().collect();
            let lower: Vec<_> = path.to_lowercase().encode_utf16().collect();
            let name_at = lower
                .iter()
                .rposition(|&x| x == u16::from(b'/'))
                .map_or(0, |i| i + 1);
            let hidden = path.split('/').any(|s| s.starts_with('.'));
            if directory {
                dirs.push((item.path(), path.clone()));
            }
            entries.push(Entry {
                path,
                sort,
                lower,
                name_at,
                directory,
                hidden,
            });
            if entries.len() == LIMIT {
                break;
            }
        }
    }
    Ok(entries)
}

fn find(target: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.len() == 1 {
        target.iter().position(|c| *c == needle[0])
    } else {
        target.windows(needle.len()).position(|part| part == needle)
    }
}

fn score(entry: &Entry, needle: &[u16], chars: &[([u16; 2], usize)]) -> Option<usize> {
    let name = &entry.lower[entry.name_at..];
    let rank = if name == needle {
        1000
    } else if name.starts_with(needle) {
        900
    } else if find(name, needle).is_some() {
        700
    } else if find(&entry.lower, needle).is_some() {
        500
    } else {
        let mut at = 0;
        let mut gap = 0;
        for (code, len) in chars {
            let offset = find(&entry.lower[at..], &code[..*len])?;
            gap += offset;
            // Upstream's JS starts the next indexOf one UTF-16 code unit later.
            at += offset + 1;
        }
        300 + 100usize.saturating_sub(gap)
    };
    Some(rank + if entry.directory { 25 } else { 0 })
}

fn rank(entries: &[Entry], query: &str) -> Value {
    let folded = query.to_lowercase();
    let needle: Vec<_> = folded.encode_utf16().collect();
    let chars: Vec<_> = folded
        .chars()
        .map(|c| {
            let mut code = [0; 2];
            let len = c.encode_utf16(&mut code).len();
            (code, len)
        })
        .collect();
    let mut hits: Vec<_> = entries
        .iter()
        .filter(|entry| !entry.hidden || query.starts_with('.'))
        .filter_map(|entry| Some((score(entry, &needle, &chars)?, entry)))
        .collect();
    let compare = |(a, left): &(usize, &Entry), (b, right): &(usize, &Entry)| {
        b.cmp(a)
            .then_with(|| right.directory.cmp(&left.directory))
            .then_with(|| left.sort.len().cmp(&right.sort.len()))
            .then_with(|| left.sort.cmp(&right.sort))
    };
    if hits.len() > TOP {
        hits.select_nth_unstable_by(TOP, compare);
        hits.truncate(TOP);
    }
    hits.sort_unstable_by(compare);
    json!(hits
        .into_iter()
        .map(|(_, e)| json!({
            "path": e.path, "kind": if e.directory { "directory" } else { "file" },
        }))
        .collect::<Vec<_>>())
}

fn cpu_ms() -> f64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: Android getrusage initializes the output struct on success.
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    let usage = unsafe { usage.assume_init() };
    let ms = |t: libc::timeval| t.tv_sec as f64 * 1000.0 + t.tv_usec as f64 / 1000.0;
    ms(usage.ru_utime) + ms(usage.ru_stime)
}

fn main() -> io::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().expect("fixture directory"));
    let queries: Vec<_> = args
        .map(|arg| arg.into_string().expect("Unicode query"))
        .collect();
    assert!(
        !queries.is_empty()
            && queries
                .iter()
                .all(|q| !q.is_empty() && !q.contains(['/', '\\'])),
        "probe supports bare fuzzy queries only"
    );
    let cpu = cpu_ms();
    let start = Instant::now();
    let entries = scan(&root)?;
    let mut rows = vec![rank(&entries, &queries[0])];
    let cold_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    for i in 0..8 {
        for query in &queries {
            let row = rank(&entries, query);
            if i == 0 {
                rows.push(row);
            } else {
                std::hint::black_box(row);
            }
        }
    }
    println!(
        "{}",
        json!({ "coldMs": cold_ms, "warmMs": start.elapsed().as_secs_f64()*1000.0,
        "cpuMs": cpu_ms()-cpu, "rows": rows })
    );
    Ok(())
}
