#!/system/bin/sh
# check-prefix-residue.sh — 内嵌 Termux 快照坏前缀体检（issue #80 反馈固化，2026-08-24）
#
# 用途：app 安装/升级后自检「旧前缀 /data/data/com.termux 残留」的实际影响面。
# 运行位置：app 内（run-as 或控制台），PREFIX=app files/usr。逐项输出 PASS/FAIL。
#
# 判定标准（与构建链修复对应）：
#   P1 node 工具链：npm/corepack/pnpm 可执行 + 无 OpenSSL config error（需 OPENSSL_CONF）
#   P2 apt/dpkg：wrapper 存在 + APT_CONFIG 主文件 + apt --version 干净（编译期路径覆盖）
#   P3 alternatives：pager/editor 链接可达
#   P4 git：usr/bin/git 存在
#   P5 错位目录：usr/data/data/com.termux/... 冗余文件（警示，非致命）
#
# 用法：sh check-prefix-residue.sh [PREFIX]
set -u
B="${1:-/data/user/0/com.dsharnessmobile.shell/files/usr}"
FAIL=0

echo "== 前缀体检: B=$B =="

# P1 node 工具链（需引擎级 OPENSSL_CONF——EngineManager.shellEnv 已注入；此处显式给一份兜底）
export PATH="$B/bin:/system/bin"
export LD_LIBRARY_PATH="$B/lib"
export HOME="$(dirname "$B")/home"
export TMPDIR="$HOME/tmp"
export OPENSSL_CONF="$B/etc/tls/openssl.cnf"
if [ -x "$B/bin/node" ] && "$B/bin/node" -e 'console.log("node-ok")' >/dev/null 2>&1; then
  echo "P1 node: PASS ($("$B/bin/node" -v 2>&1))"
else
  echo "P1 node: FAIL (node 无法启动——检查 OPENSSL_CONF/$B/etc/tls/openssl.cnf 与 LD_LIBRARY_PATH)"
  FAIL=1
fi
if [ -x "$B/bin/npm" ] && npm --version >/dev/null 2>&1; then
  echo "P1 npm: PASS ($(npm --version 2>&1))"
else
  echo "P1 npm: FAIL (npm 无法启动——shebang/OPENSSL_CONF 残留旧前缀)"
  FAIL=1
fi
if [ -x "$B/bin/corepack" ] && corepack --version >/dev/null 2>&1; then
  echo "P1 corepack: PASS ($(corepack --version 2>&1))"
else
  echo "P1 corepack: FAIL"
  [ "$B/bin/corepack" ] || echo "  (corepack 缺失或不可执行)"
fi
if [ -x "$B/bin/pnpm" ] && pnpm --version >/dev/null 2>&1; then
  echo "P1 pnpm: PASS ($(pnpm --version 2>&1))"
else
  echo "P1 pnpm: FAIL"
fi

# P2 apt/dpkg wrapper（编译期路径覆盖）
if [ -f "$B/etc/apt/apt.conf" ] && grep -q "Dir::Etc" "$B/etc/apt/apt.conf" 2>/dev/null; then
  echo "P2 apt.conf 主文件: PASS (APT_CONFIG 覆盖就位)"
else
  echo "P2 apt.conf 主文件: FAIL（缺少 $B/etc/apt/apt.conf——apt 会回落编译期旧前缀）"
  FAIL=1
fi
if [ -f "$B/bin/apt" ] && [ -x "$B/bin/apt" ] && grep -q "apt.real" "$B/bin/apt" 2>/dev/null; then
  echo "P2 apt wrapper: PASS (apt -> apt.real wrapper)"
else
  echo "P2 apt wrapper: FAIL（apt 非 wrapper 形态——编译期路径未被覆盖）"
  FAIL=1
fi
K="-o Dir::Etc=$B/etc/apt -o Dir::Etc::sourcelist=$B/etc/apt/sources.list -o Dir::Etc::sourceparts=$B/etc/apt/sources.list.d -o Dir::State=$B/var/lib/apt -o Dir::Cache=$B/var/cache/apt"
if APT_CONFIG="$B/etc/apt/apt.conf" "$B/bin/apt.real" $K --version 2>&1 | head -2 | grep -q "^apt "; then
  echo "P2 apt 真实执行: PASS"
else
  echo "P2 apt 真实执行: FAIL（仍读旧前缀 /data/data/com.termux——wrapper 未生效）"
  FAIL=1
fi
if APT_CONFIG="$B/etc/apt/apt.conf" "$B/bin/dpkg.real" --instdir="$B" --admindir="$B/var/lib/dpkg" --print-architecture >/dev/null 2>&1; then
  echo "P2 dpkg: PASS ($(APT_CONFIG="$B/etc/apt/apt.conf" "$B/bin/dpkg.real" --instdir="$B" --admindir="$B/var/lib/dpkg" --print-architecture 2>&1))"
else
  echo "P2 dpkg: WARN（编译期 SYSCONFDIR 不可覆盖——已知限制，apt 装包受限；见 AGENT.md 坑记录）"
fi

# P3 alternatives
for a in pager editor; do
  if [ -e "$B/etc/alternatives/$a" ]; then
    tgt=$(readlink "$B/etc/alternatives/$a" 2>/dev/null)
    case "$tgt" in
      /data/data/com.termux*) echo "P3 $a: FAIL（链接仍指旧前缀: $tgt）"; FAIL=1;;
      *) [ -e "$tgt" ] && echo "P3 $a: PASS" || echo "P3 $a: WARN（目标不可达: $tgt）";;
    esac
  else
    echo "P3 $a: WARN（无 alternatives 条目）"
  fi
done

# P4 git
if [ -x "$B/bin/git" ]; then
  echo "P4 git: PASS ($("$B/bin/git" --version 2>&1 | head -1))"
else
  echo "P4 git: FAIL（git 未预装——issue #80 P3；构建链 TARGETS 应含 git）"
  FAIL=1
fi

# P5 错位目录（relocate 把绝对路径当相对路径搬移的残留）
if [ -d "$B/data/data/com.termux" ]; then
  n=$(find "$B/data/data/com.termux" -type f 2>/dev/null | wc -l)
  echo "P5 错位目录: WARN（$B/data/data/com.termux 存在 $n 个文件——纯冗余，不影响运行；构建链应剔除）"
else
  echo "P5 错位目录: PASS"
fi

echo "== 前缀体检结束: $([ $FAIL -eq 0 ] && echo ALL-PASS || echo HAS-FAIL) =="
exit $FAIL