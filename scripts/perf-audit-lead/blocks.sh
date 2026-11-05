#!/usr/bin/env bash
for f in /mnt/d/coding/dsh-mobile/dsh-mobile-apk/snapshot/snapshot-x86_64.tar.xz          /mnt/d/coding/dsh-mobile/dsh-mobile-apk/app/src/main/assets/snapshot.tar.xz ; do
  echo "== $f"
  echo "   bytes = $(stat -c%s "$f")"
  xz --list --verbose "$f" 2>/dev/null | grep -E 'Blocks:|Compressed size:|Uncompressed size:|Ratio:'
done
