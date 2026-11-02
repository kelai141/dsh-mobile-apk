#!/usr/bin/env bash
# SnapshotExtractor.resolveEntry() calls File.getCanonicalPath() ONCE PER ENTRY (line 299).
# 53,178 entries. On Linux/Android that is realpath(3).
# Measure it honestly on ext4 with the real extracted tree (not Windows, where it is 1-2 orders slower).
set -u
[ -d /tmp/out ] || { mkdir -p /tmp/out && tar -xJf /tmp/snap.tar.xz -C /tmp/out; }
echo "files in tree: $(find /tmp/out -type f | wc -l)"
node -e '
const fs=require("fs"),path=require("path");
const files=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isDirectory())walk(p); else files.push(p);}})("/tmp/out");
console.log("walked entries:",files.length);
const dirs=new Set(files.map(f=>path.dirname(f)));
const dirList=[...dirs];
// A: realpath on the PARENT dir of each entry (what resolveEntry actually does)
const t0=process.hrtime.bigint();
for(const f of files){ try{ fs.realpathSync(path.dirname(f)); }catch(e){} }
const a=Number(process.hrtime.bigint()-t0)/1e6;
// B: unique parent dirs only (the caching alternative)
const t1=process.hrtime.bigint();
for(const d of dirList){ try{ fs.realpathSync(d); }catch(e){} }
const b=Number(process.hrtime.bigint()-t1)/1e6;
console.log("unique parent dirs:",dirList.length);
console.log("A per-entry realpath (current)  : "+(a/1000).toFixed(2)+" s  ("+(a/files.length).toFixed(1)+" us/entry)");
console.log("B unique-dir realpath (cached)  : "+(b/1000).toFixed(2)+" s  ("+(b/dirList.length).toFixed(1)+" us/dir)");
console.log("saving                          : "+((a-b)/1000).toFixed(2)+" s  ("+(100*(a-b)/a).toFixed(1)+"%)");
' 2>&1
echo
echo "== control: same measurement on the Windows tree via 9p (/mnt/d) to show fs sensitivity =="
echo "(skipped: 9p numbers are not representative of Android, see report C-15)"
