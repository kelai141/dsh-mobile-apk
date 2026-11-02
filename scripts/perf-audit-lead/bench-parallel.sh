#!/usr/bin/env bash
# Does the SHIPPED xz stream allow parallel decode? (Android's Java XZCompressorInputStream
# is single-threaded regardless, but measure the headroom to size the opportunity.)
set -u
echo "== block structure of shipped archive =="
xz --list --verbose /tmp/snap.tar.xz 2>&1 | sed -n '1,30p'
echo
echo "== single-thread vs multi-thread decode of the SAME shipped stream =="
for t in 1 2 4 8 16; do
  best=99999
  for i in 1 2; do
    s=$( { /usr/bin/time -f "%e" xz -dT$t -c /tmp/snap.tar.xz > /dev/null; } 2>&1 )
    best=$(echo "$s $best" | awk '{print ($1<$2)?$1:$2}')
  done
  echo "  xz -dT$t  best_of_2 = $best s"
done
echo
echo "== decode+extract with parallel decode (what a device COULD do) =="
for t in 1 4 8; do
  rm -rf /tmp/outT
  s=$( { /usr/bin/time -f "%e" sh -c "mkdir -p /tmp/outT && xz -dT$t -c /tmp/snap.tar.xz | tar -x -C /tmp/outT"; } 2>&1 )
  echo "  extract -dT$t = $s s"
done
