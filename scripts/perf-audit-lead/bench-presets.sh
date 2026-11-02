#!/usr/bin/env bash
# Measure the size/decode tradeoff the DEVICE actually pays.
# Builder uses: xz -T<N> -6 -c     (multi-threaded ENCODE)
# Device uses:  org.tukaani XZCompressorInputStream  (single-threaded DECODE)
# Hypothesis: single-threaded decode time is roughly preset-insensitive; size is not.
set -u
cd /tmp
[ -f plain.tar ] || { xz -dc /tmp/snap.tar.xz > /tmp/plain.tar; }
echo "plain tar bytes: $(stat -c%s /tmp/plain.tar)"
echo
echo "scenario | level | -T | outBytes | MiB | encWall_s | decWall_s(1 thread)"
for lvl in 0 1 3 6 9; do
  out=/tmp/p${lvl}.tar.xz
  if [ ! -f "$out" ]; then
    /usr/bin/time -f "%e" -o /tmp/enc_${lvl}.txt xz -${lvl} -T16 -c /tmp/plain.tar > "$out"
  fi
  enc=$(cat /tmp/enc_${lvl}.txt 2>/dev/null || echo NA)
  # single-threaded decode (matches Android XZCompressorInputStream)
  dec=$( { /usr/bin/time -f "%e" xz -dT1 -c "$out" > /dev/null; } 2>&1 )
  b=$(stat -c%s "$out")
  printf "preset-%-2s | %s | T16 | %10s | %7.2f | %6s | %s
" "$lvl" "$lvl" "$b" "$(echo "scale=2;$b/1048576"|bc)" "$enc" "$dec"
done
echo
echo "== also: what does -T1 (single-thread block, what device sees) change for SIZE? =="
for lvl in 3 6; do
  out=/tmp/s${lvl}.tar.xz
  [ -f "$out" ] || xz -${lvl} -T1 -c /tmp/plain.tar > "$out"
  b=$(stat -c%s "$out"); dec=$( { /usr/bin/time -f "%e" xz -dT1 -c "$out" > /dev/null; } 2>&1 )
  printf "preset-%-2s -T1(encode) | %10s | %7.2f MiB | dec %s s
" "$lvl" "$b" "$(echo "scale=2;$b/1048576"|bc)" "$dec"
done
echo
echo "== xz --list of the SHIPPED archive (block structure) =="
xz --list --verbose /tmp/snap.tar.xz 2>&1 | head -20
