#!/usr/bin/env bash
# 验证 git cat-file --batch 能在一次进程内取多个 blob（替代 170 次 spawn）
cd /mnt/d/coding/dsh-mobile/dsh-mobile-apk/_dsh-wt/perf-audit || exit 1
echo "== 单次 spawn 基准 =="
s=$(date +%s%N)
git -c core.autocrlf=true cat-file --filters HEAD:scripts/patches/upstream/pi-ai-1.1.0.patch > /dev/null
e=$(date +%s%N); echo "  one spawn: $(( (e-s)/1000000 )) ms"
echo
echo "== 170 次单 spawn（现状口径，抽样 20 次外推）=="
s=$(date +%s%N)
for i in $(seq 1 20); do git -c core.autocrlf=true cat-file --filters HEAD:scripts/patches/upstream/pi-ai-1.1.0.patch > /dev/null; done
e=$(date +%s%N); per=$(( (e-s)/20000000 )); echo "  20 spawns: $(( (e-s)/1000000 )) ms  => per=$per ms  => 170x ~= $(( per*170 )) ms"
echo
echo "== --batch 批量（一次进程取 N 个）=="
s=$(date +%s%N)
printf 'scripts/patches/upstream/pi-ai-1.1.0.patch\n%.0s' $(seq 1 20) | git cat-file --batch > /dev/null
e=$(date +%s%N); echo "  20 batched: $(( (e-s)/1000000 )) ms"
