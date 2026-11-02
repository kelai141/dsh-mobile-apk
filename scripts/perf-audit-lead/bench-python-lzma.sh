#!/usr/bin/env bash
# Decisive: does Python's lzma (what inject-snapshot.py:123 uses) reproduce the SHIPPED size,
# or does xz -9?  Input is byte-identical (the decompressed stream of the shipped archive).
set -u
SHIPPED=200877488
echo "shipped archive bytes: $SHIPPED ($(echo "scale=2;$SHIPPED/1048576"|bc) MiB)"
echo "plain tar bytes    : $(stat -c%s /tmp/plain.tar)"
echo
for p in 6 9; do
  out=/tmp/py${p}.tar.xz
  if [ ! -f "$out" ]; then
    s=$( { /usr/bin/time -f "%e" python3 -c "
import lzma,sys
preset=int(sys.argv[1])
with lzma.open(sys.argv[2],'wb',preset=preset) as f:
    with open('/tmp/plain.tar','rb') as i:
        while True:
            b=i.read(1<<20)
            if not b: break
            f.write(b)
" $p "$out"; } 2>&1 )
  fi
  b=$(stat -c%s "$out")
  d=$( { /usr/bin/time -f "%e" xz -dT1 -c "$out" > /dev/null; } 2>&1 )
  printf "python-lzma preset=%s | %10s B | %7.2f MiB | delta_vs_shipped=%+d | encode %s s | decode1 %s s
" \
    "$p" "$b" "$(echo "scale=2;$b/1048576"|bc)" "$((b-SHIPPED))" "${s:-?}" "$d"
done
echo
echo "blocks in each:"
for f in /tmp/py6.tar.xz /tmp/py9.tar.xz /tmp/p9.tar.xz; do
  [ -f "$f" ] && echo -n "  $f -> " && xz --list --verbose "$f" 2>/dev/null | sed -n 's/^  Blocks: *//p' | head -1
done
