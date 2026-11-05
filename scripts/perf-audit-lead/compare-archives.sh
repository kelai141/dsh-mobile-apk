#!/usr/bin/env bash
set -u
A=/mnt/d/coding/dsh-mobile/dsh-mobile-apk/snapshot/snapshot-x86_64.tar.xz
B=/mnt/d/coding/dsh-mobile/dsh-mobile-apk/snapshot/snapshot-arm64.tar.xz
C=/mnt/d/coding/dsh-mobile/dsh-mobile-apk/app/src/main/assets/snapshot.tar.xz
for f in "$A" "$B" "$C"; do
  echo "=== $(basename $(dirname "$f"))/$(basename "$f") ==="
  echo "  file bytes: $(stat -c%s "$f")"
  xz --list --verbose "$f" 2>/dev/null | sed -n 's/^  (Streams|Blocks|Compressed size|Uncompressed size|Ratio): */  \1: /p'
  echo "  entries: $(tar -tJf "$f" 2>/dev/null | wc -l)"
done
echo
echo "== if uncompressed sizes are equal, the three hold the SAME payload and the compressed"
echo "   size difference is purely encoder settings =="
