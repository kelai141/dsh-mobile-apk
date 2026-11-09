//! 只读 git 对象读取探针：同一份负载下比较 `git cat-file --batch` 与 gix。
//!
//! 覆盖：树递归遍历、路径字面（glob 元字符 / tab / CJK / 空格）、二进制与
//! 非法 UTF-8 blob、缺失对象、字节级 SHA-256 校验、真实子进程数、分阶段耗时。
//! 写侧完全不涉及：只调用 find_object / cat-file --batch。

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Instant;

use sha2::{Digest, Sha256};

const TREE_MODE: &str = "40000";

#[derive(Clone, Debug)]
struct Entry {
    path: Vec<u8>,
    mode: String,
    oid: String,
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// 解析一个树对象：重复的 "<mode> SP <name> NUL <20-byte oid>"。
fn parse_tree(data: &[u8]) -> Result<Vec<(String, Vec<u8>, [u8; 20])>, String> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while cursor < data.len() {
        let space = data[cursor..]
            .iter()
            .position(|b| *b == b' ')
            .ok_or_else(|| format!("tree: missing mode separator at {cursor}"))?;
        let mode = std::str::from_utf8(&data[cursor..cursor + space])
            .map_err(|_| "tree: mode is not utf-8".to_string())?
            .to_string();
        cursor += space + 1;
        let nul = data[cursor..]
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| format!("tree: missing name terminator at {cursor}"))?;
        let name = data[cursor..cursor + nul].to_vec();
        cursor += nul + 1;
        if data.len() < cursor + 20 {
            return Err("tree: truncated object id".to_string());
        }
        let mut oid = [0u8; 20];
        oid.copy_from_slice(&data[cursor..cursor + 20]);
        cursor += 20;
        out.push((mode, name, oid));
    }
    Ok(out)
}

/// 递归展开一棵树，返回按路径字节序排序的 blob 清单。
fn walk_tree(
    read: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
    root: &str,
) -> Result<Vec<Entry>, String> {
    let mut blobs = Vec::new();
    let mut stack: Vec<(Vec<u8>, String)> = vec![(Vec::new(), root.to_string())];
    while let Some((prefix, tree_oid)) = stack.pop() {
        let data = read(&tree_oid)?;
        for (mode, name, oid) in parse_tree(&data)? {
            let mut path = prefix.clone();
            if !path.is_empty() {
                path.push(b'/');
            }
            path.extend_from_slice(&name);
            if mode == TREE_MODE {
                stack.push((path, hex(&oid)));
            } else {
                blobs.push(Entry {
                    path,
                    mode,
                    oid: hex(&oid),
                });
            }
        }
    }
    blobs.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(blobs)
}

/// 一次完整负载的规范化结果；两个引擎必须逐字节相同。
#[derive(Debug, Default)]
struct Outcome {
    blob_count: usize,
    tree_digest: String,
    content_digest: String,
    total_bytes: u64,
    lookups: Vec<String>,
    missing: String,
    binary_sha256: String,
    binary_len: usize,
    empty_sha256: String,
    latin1_sha256: String,
}

#[derive(Default, Clone, Copy)]
struct Stages {
    open_ms: f64,
    walk_ms: f64,
    blob_ms: f64,
    lookup_ms: f64,
    total_ms: f64,
}

struct Commits {
    base: String,
    head: String,
    base_tree: String,
    head_tree: String,
}

fn finalize(
    commits: &Commits,
    require_coverage: bool,
    read: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
    lookup_paths: &[Vec<u8>],
    missing: &str,
) -> Result<(Outcome, Stages), String> {
    let started = Instant::now();
    let mut outcome = Outcome::default();
    let mut stages = Stages::default();

    let mut tree_hash = Sha256::new();
    let mut content_hash = Sha256::new();
    let mut binary_seen = false;
    let mut empty_seen = false;
    let mut latin1_seen = false;

    let walk_start = Instant::now();
    // 两个提交都走：base 树含 latin1 与 tab 名，head 树含重命名与新增。
    let mut all_blobs: Vec<Entry> = Vec::new();
    for tree in [&commits.base_tree, &commits.head_tree] {
        all_blobs.extend(walk_tree(read, tree)?);
    }
    stages.walk_ms = walk_start.elapsed().as_secs_f64() * 1000.0;

    all_blobs.sort_by(|a, b| a.path.cmp(&b.path));
    all_blobs.dedup_by(|a, b| a.path == b.path && a.oid == b.oid);

    for entry in &all_blobs {
        tree_hash.update(&entry.path);
        tree_hash.update([0u8]);
        tree_hash.update(entry.mode.as_bytes());
        tree_hash.update([0u8]);
        tree_hash.update(entry.oid.as_bytes());
        tree_hash.update(b"\n");
    }
    outcome.blob_count = all_blobs.len();

    let blob_start = Instant::now();
    for entry in &all_blobs {
        let data = read(&entry.oid)?;
        outcome.total_bytes += data.len() as u64;
        content_hash.update(entry.oid.as_bytes());
        content_hash.update(b"\0");
        content_hash.update(Sha256::digest(&data));
        content_hash.update(b"\n");
        if entry.path == b"assets/blob.bin" {
            outcome.binary_sha256 = sha256_hex(&data);
            outcome.binary_len = data.len();
            binary_seen = true;
        } else if entry.path == b"assets/empty.txt" {
            outcome.empty_sha256 = sha256_hex(&data);
            empty_seen = true;
        } else if entry.path == b"docs/latin1.txt" {
            outcome.latin1_sha256 = sha256_hex(&data);
            latin1_seen = true;
        }
    }
    stages.blob_ms = blob_start.elapsed().as_secs_f64() * 1000.0;

    let lookup_start = Instant::now();
    // 路径字面：按字节精确匹配；元字符不参与任何 glob 展开。
    for wanted in lookup_paths {
        let found = all_blobs
            .iter()
            .find(|entry| &entry.path == wanted)
            .map(|entry| entry.oid.clone())
            .unwrap_or_else(|| "absent".to_string());
        outcome
            .lookups
            .push(format!("{}={}", String::from_utf8_lossy(wanted), found));
    }
    outcome.missing = match read(missing) {
        Ok(data) => format!("present:{}", data.len()),
        Err(error) if error == format!("object missing: {missing}") => "missing".to_string(),
        Err(error) => return Err(error),
    };
    stages.lookup_ms = lookup_start.elapsed().as_secs_f64() * 1000.0;

    outcome.tree_digest = hex(&tree_hash.finalize());
    outcome.content_digest = hex(&content_hash.finalize());
    if require_coverage && (!binary_seen || !empty_seen || !latin1_seen) {
        return Err(format!(
            "fixture coverage incomplete: binary={binary_seen} empty={empty_seen} latin1={latin1_seen}"
        ));
    }
    stages.total_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok((outcome, stages))
}

// ---------------------------------------------------------------- gix 引擎

struct GixEngine {
    repo: gix::Repository,
}

impl GixEngine {
    fn open(path: &Path) -> Result<Self, String> {
        gix::open(path)
            .map(|repo| Self { repo })
            .map_err(|error| format!("gix open: {error}"))
    }

    fn read(&self, oid: &str) -> Result<Vec<u8>, String> {
        let id =
            gix::ObjectId::from_hex(oid.as_bytes()).map_err(|error| format!("oid: {error}"))?;
        match self.repo.try_find_object(id) {
            Ok(Some(object)) => Ok(object.detach().data),
            Ok(None) => Err(format!("object missing: {oid}")),
            Err(error) => Err(format!("gix find {oid}: {error}")),
        }
    }
}

// --------------------------------------------------- git cat-file --batch 引擎

struct BatchEngine {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    cache: Option<BTreeMap<String, Vec<u8>>>,
    cached_bytes: usize,
    spawns: u32,
}

impl BatchEngine {
    fn spawn(
        git: &Path,
        repo: &Path,
        extra_lib: Option<&Path>,
        cache: bool,
    ) -> Result<Self, String> {
        let mut command = Command::new(git);
        command
            .arg("--git-dir")
            .arg(repo)
            .arg("cat-file")
            .arg("--batch")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(lib) = extra_lib {
            command.env("LD_LIBRARY_PATH", lib);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("spawn {}: {error}", git.display()))?;
        let stdin = child.stdin.take().ok_or("batch: no stdin")?;
        let stdout = child.stdout.take().ok_or("batch: no stdout")?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            cache: cache.then(BTreeMap::new),
            cached_bytes: 0,
            spawns: 1,
        })
    }

    fn read(&mut self, oid: &str) -> Result<Vec<u8>, String> {
        if let Some(data) = self.cache.as_ref().and_then(|cache| cache.get(oid)) {
            return Ok(data.clone());
        }
        self.stdin
            .write_all(oid.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("batch write: {error}"))?;
        let mut header = String::new();
        self.stdout
            .read_line(&mut header)
            .map_err(|error| format!("batch read header: {error}"))?;
        let header = header.trim_end_matches('\n');
        let fields: Vec<&str> = header.split(' ').collect();
        if fields.len() == 2 && fields[1] == "missing" {
            if fields[0] != oid {
                return Err(format!("batch: mismatched response {header:?}"));
            }
            return Err(format!("object missing: {oid}"));
        }
        if fields.len() != 3 || fields[0] != oid {
            return Err(format!("batch: malformed header {header:?}"));
        }
        let size: usize = fields[2]
            .parse()
            .map_err(|error| format!("batch: bad size {error}"))?;
        let mut data = vec![0u8; size];
        self.stdout
            .read_exact(&mut data)
            .map_err(|error| format!("batch read body: {error}"))?;
        let mut trailer = [0u8; 1];
        self.stdout
            .read_exact(&mut trailer)
            .map_err(|error| format!("batch read trailer: {error}"))?;
        if trailer != [b'\n'] {
            return Err(format!("batch: malformed trailer {trailer:?}"));
        }
        if let Some(cache) = &mut self.cache {
            if cache.len() < 4096 && data.len() <= (8 << 20) - self.cached_bytes {
                cache.insert(oid.to_string(), data.clone());
                self.cached_bytes += data.len();
            }
        }
        Ok(data)
    }
}

impl Drop for BatchEngine {
    fn drop(&mut self) {
        let _ = self.stdin.write_all(b"\n");
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------- main

fn usage() -> ! {
    eprintln!(
        "usage: dsh-git-read-probe --repo <git-dir> --base <oid> [--head <oid>] [--tree-only] \
         (--engine gix | --engine batch --git <git-binary> [--git-lib <dir>] [--cache-blobs]) \
         [--iterations N] [--warm-iterations N]"
    );
    std::process::exit(2)
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1).cloned())
}

fn percentile(values: &[f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let index = ((values.len() - 1) as f64 * fraction).round() as usize;
    values[index]
}

fn json(pairs: &[(&str, String)]) -> String {
    use std::fmt::Write as _;
    let mut out = String::from("{");
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write!(out, "\"{key}\":\"").unwrap();
        for c in value.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\u{0}'..='\u{1f}' => write!(out, "\\u{:04x}", u32::from(c)).unwrap(),
                _ => out.push(c),
            }
        }
        out.push('"');
    }
    out.push('}');
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let repo = PathBuf::from(arg(&args, "--repo").unwrap_or_else(|| usage()));

    let base_arg = arg(&args, "--base").unwrap_or_else(|| usage());
    let head_arg = arg(&args, "--head").unwrap_or_else(|| base_arg.clone());
    let commits = Commits {
        base: base_arg,
        head: head_arg,
        base_tree: String::new(),
        head_tree: String::new(),
    };
    let require_coverage = !args.iter().any(|value| value == "--tree-only");
    let engine = arg(&args, "--engine").unwrap_or_else(|| usage());
    let cache = args.iter().any(|value| value == "--cache-blobs");
    let iterations: usize = arg(&args, "--iterations")
        .map(|value| value.parse().expect("--iterations"))
        .unwrap_or(3);
    let warm: usize = arg(&args, "--warm-iterations")
        .map(|value| value.parse().expect("--warm-iterations"))
        .unwrap_or(20);

    let lookup_paths: Vec<Vec<u8>> = vec![
        b"src/a*b?c[1].txt".to_vec(),
        b"docs/report\t2026.md".to_vec(),
        "docs/\u{62a5}\u{544a}-2026.md".as_bytes().to_vec(),
        b"docs/with space.md".to_vec(),
        b"a/b/c/d/e/f/deep.txt".to_vec(),
        b"src/aXbYc1.txt".to_vec(), // 元字符不得被展开
        b"docs/report".to_vec(),    // tab 之前的截断名不得命中
    ];
    let missing = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    let mut warm_stages: Vec<Stages> = Vec::new();
    let mut cold_stages: Option<Stages> = None;
    let mut outcome: Option<Outcome> = None;
    let mut spawns = 0u32;

    match engine.as_str() {
        "gix" => {
            for index in 0..iterations {
                let open_start = Instant::now();
                let engine = GixEngine::open(&repo).expect("gix open");
                let mut open_ms = open_start.elapsed().as_secs_f64() * 1000.0;
                let tree_start = Instant::now();
                let base_tree = commit_tree(&engine.read(&commits.base).expect("read base"))
                    .expect("base tree");
                let head_tree = commit_tree(&engine.read(&commits.head).expect("read head"))
                    .expect("head tree");
                open_ms += tree_start.elapsed().as_secs_f64() * 1000.0;
                let local = Commits {
                    base: commits.base.clone(),
                    head: commits.head.clone(),
                    base_tree,
                    head_tree,
                };
                let mut read = |oid: &str| engine.read(oid);
                let (result, mut stages) =
                    finalize(&local, require_coverage, &mut read, &lookup_paths, missing)
                        .expect("finalize");
                stages.open_ms = open_ms;
                stages.total_ms += open_ms;
                outcome = Some(result);
                if index == 0 {
                    cold_stages = Some(stages);
                } else {
                    warm_stages.push(stages);
                }
            }
            // 稳态：复用同一仓库句柄，只重做遍历与读取。
            let engine = GixEngine::open(&repo).expect("gix open warm");
            let base_tree =
                commit_tree(&engine.read(&commits.base).expect("read base")).expect("base tree");
            let head_tree =
                commit_tree(&engine.read(&commits.head).expect("read head")).expect("head tree");
            let local = Commits {
                base: commits.base.clone(),
                head: commits.head.clone(),
                base_tree,
                head_tree,
            };
            for _ in 0..warm {
                let mut read = |oid: &str| engine.read(oid);
                let (result, mut stages) =
                    finalize(&local, require_coverage, &mut read, &lookup_paths, missing)
                        .expect("finalize");
                stages.open_ms = 0.0;
                warm_stages.push(stages);
                outcome = Some(result);
            }
        }
        "batch" => {
            let git = PathBuf::from(arg(&args, "--git").unwrap_or_else(|| usage()));
            let lib = arg(&args, "--git-lib").map(PathBuf::from);
            for index in 0..iterations {
                let open_start = Instant::now();
                let mut engine =
                    BatchEngine::spawn(&git, &repo, lib.as_deref(), cache).expect("spawn batch");
                let mut open_ms = open_start.elapsed().as_secs_f64() * 1000.0;
                let tree_start = Instant::now();
                let base_tree = commit_tree(&engine.read(&commits.base).expect("read base"))
                    .expect("base tree");
                let head_tree = commit_tree(&engine.read(&commits.head).expect("read head"))
                    .expect("head tree");
                open_ms += tree_start.elapsed().as_secs_f64() * 1000.0;
                let local = Commits {
                    base: commits.base.clone(),
                    head: commits.head.clone(),
                    base_tree,
                    head_tree,
                };
                let (result, mut stages) = finalize(
                    &local,
                    require_coverage,
                    &mut |oid| engine.read(oid),
                    &lookup_paths,
                    missing,
                )
                .expect("finalize");
                stages.open_ms = open_ms;
                stages.total_ms += open_ms;
                spawns = engine.spawns;
                outcome = Some(result);
                if index == 0 {
                    cold_stages = Some(stages);
                } else {
                    warm_stages.push(stages);
                }
            }
            let mut engine =
                BatchEngine::spawn(&git, &repo, lib.as_deref(), cache).expect("spawn batch warm");
            let base_tree =
                commit_tree(&engine.read(&commits.base).expect("read base")).expect("base tree");
            let head_tree =
                commit_tree(&engine.read(&commits.head).expect("read head")).expect("head tree");
            let local = Commits {
                base: commits.base.clone(),
                head: commits.head.clone(),
                base_tree,
                head_tree,
            };
            for _ in 0..warm {
                let (result, mut stages) = finalize(
                    &local,
                    require_coverage,
                    &mut |oid| engine.read(oid),
                    &lookup_paths,
                    missing,
                )
                .expect("finalize");
                stages.open_ms = 0.0;
                warm_stages.push(stages);
                outcome = Some(result);
            }
        }
        other => {
            eprintln!("unknown engine {other}");
            usage()
        }
    }

    let outcome = outcome.expect("no outcome");
    let cold = cold_stages.expect("no cold stage");
    let mut totals: Vec<f64> = warm_stages.iter().map(|stage| stage.total_ms).collect();
    let mut walk: Vec<f64> = warm_stages.iter().map(|stage| stage.walk_ms).collect();
    let mut blobs: Vec<f64> = warm_stages.iter().map(|stage| stage.blob_ms).collect();
    let mut lookups: Vec<f64> = warm_stages.iter().map(|stage| stage.lookup_ms).collect();
    totals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    walk.sort_by(|a, b| a.partial_cmp(b).unwrap());
    blobs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    lookups.sort_by(|a, b| a.partial_cmp(b).unwrap());

    println!(
        "{}",
        json(&[
            ("engine", engine.clone()),
            ("cacheBlobs", cache.to_string()),
            ("blobCount", outcome.blob_count.to_string()),
            ("totalBytes", outcome.total_bytes.to_string()),
            ("treeDigest", outcome.tree_digest.clone()),
            ("contentDigest", outcome.content_digest.clone()),
            ("missing", outcome.missing.clone()),
            ("binarySha256", outcome.binary_sha256.clone()),
            ("binaryLen", outcome.binary_len.to_string()),
            ("emptySha256", outcome.empty_sha256.clone()),
            ("latin1Sha256", outcome.latin1_sha256.clone()),
            ("lookups", outcome.lookups.join(";")),
            ("spawns", spawns.to_string()),
            ("coldOpenMs", format!("{:.3}", cold.open_ms)),
            ("coldTotalMs", format!("{:.3}", cold.total_ms)),
            ("warmSamples", totals.len().to_string()),
            ("warmTotalP50Ms", format!("{:.3}", percentile(&totals, 0.5))),
            ("warmTotalMinMs", format!("{:.3}", percentile(&totals, 0.0))),
            ("warmTotalP90Ms", format!("{:.3}", percentile(&totals, 0.9))),
            ("warmWalkP50Ms", format!("{:.3}", percentile(&walk, 0.5))),
            ("warmBlobP50Ms", format!("{:.3}", percentile(&blobs, 0.5))),
            (
                "warmLookupP50Ms",
                format!("{:.3}", percentile(&lookups, 0.5))
            ),
        ])
    );
}

/// 从 commit 对象里取 tree id（首行 "tree <oid>"）。
fn commit_tree(data: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(data).map_err(|_| "commit is not utf-8".to_string())?;
    let first = text.lines().next().ok_or("empty commit")?;
    let oid = first
        .strip_prefix("tree ")
        .ok_or_else(|| format!("commit: unexpected first line {first:?}"))?;
    Ok(oid.trim().to_string())
}
