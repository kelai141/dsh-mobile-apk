#!/usr/bin/env bash
# Faithful host-side model of SnapshotExtractor.extractEntries() cost, run on Linux (WSL).
# Android and WSL-ubuntu are both Linux: the syscall set is identical; only the fs/CPU differ.
set -u
SRC=/mnt/d/coding/dsh-mobile/dsh-mobile-apk/app/src/main/assets/snapshot.tar.xz
echo "== env ==" ; nproc ; grep -m1 'model name' /proc/cpuinfo ; df -h /tmp | tail -1
echo
echo "== stage archive onto ext4 (not 9p) =="
if [ ! -f /tmp/snap.tar.xz ]; then cp "$SRC" /tmp/snap.tar.xz ; fi
ls -l /tmp/snap.tar.xz | awk '{print "archive bytes:", $5}'
sync
echo
echo "== T1: pure xz decode, no writes (single-threaded CPU floor) =="
for i in 1 2 3; do
  /usr/bin/time -f "  decode run$i wall=%e s cpu=%P maxrssKB=%M" xz -dc /tmp/snap.tar.xz > /dev/null
done
echo
echo "== T2: tar list (decode + parse 53k headers, zero file writes) =="
for i in 1 2; do
  /usr/bin/time -f "  list run$i wall=%e s cpu=%P" tar -tJf /tmp/snap.tar.xz > /dev/null
done
echo
echo "== T3: real extract with tar -xJ (decode + create 44k files + write 716MiB) =="
for i in 1 2; do
  rm -rf /tmp/out
  /usr/bin/time -f "  extract run$i wall=%e s cpu=%P" sh -c 'mkdir -p /tmp/out && tar -xJf /tmp/snap.tar.xz -C /tmp/out'
  echo "  extracted bytes: $(du -sb /tmp/out | cut -f1)"
done
echo
echo "== T4: Android-specific per-entry overhead (the code does, per file:) =="
echo "     Files.deleteIfExists(target) ; then write ; then"
echo "     setReadable(false,false) + setReadable(true,true) + setWritable(true,true) + setExecutable(bool,true)"
echo "   -> 1 unlink + 4 chmod per file x 44568 files"
if command -v node >/dev/null; then
  /usr/bin/time -f "  node-chmod-4x wall=%e s cpu=%P" node -e '
    const fs=require("fs"),path=require("path");
    let files=[];
    (function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
      if(e.isDirectory())walk(p); else if(e.isFile())files.push(p);}})("/tmp/out");
    const t0=process.hrtime.bigint();
    for(const f of files){
      try{ fs.chmodSync(f,0o600); fs.chmodSync(f,0o644); fs.chmodSync(f,0o444); fs.chmodSync(f,0o755);}catch(e){}
    }
    const ms=Number(process.hrtime.bigint()-t0)/1e6;
    console.log("  files="+files.length+" chmod4x total="+ms.toFixed(0)+"ms perFile="+(ms/files.length).toFixed(3)+"ms");
  '
else echo "  node missing in WSL"; fi
echo
echo "== T5: unlink cost (Files.deleteIfExists on a non-existent target) =="
if command -v node >/dev/null; then
  node -e '
    const fs=require("fs");
    const t0=process.hrtime.bigint();
    for(let i=0;i<44568;i++){ try{fs.unlinkSync("/tmp/out/does-not-exist-"+i);}catch(e){} }
    const ms=Number(process.hrtime.bigint()-t0)/1e6;
    console.log("  unlink-miss x44568 total="+ms.toFixed(0)+"ms perFile="+(ms/44568).toFixed(4)+"ms");
  '
fi
echo
echo "== T6: single-thread scalability check — decode twice in parallel to see if host is contended =="
( /usr/bin/time -f "  par-decodeA wall=%e s" xz -dc /tmp/snap.tar.xz > /dev/null ) &
( /usr/bin/time -f "  par-decodeB wall=%e s" xz -dc /tmp/snap.tar.xz > /dev/null ) &
wait
echo
echo "== filesystem of target =="; df -T /tmp | tail -1
