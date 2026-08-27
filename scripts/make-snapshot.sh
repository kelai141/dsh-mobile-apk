#!/system/bin/sh
# M1.5: slim Termux environment snapshot (exclude toolchain/headers/man; rewrite embedded paths)
set -e
ROOT="${DSH_SNAPSHOT_ROOT:-/data/data/com.termux/files}"
# Shell path target for the in-snapshot profile patch (v0.12.3-FX-1: package renamed to
# com.dsharnessmobile.shell, decoupled from the DSH_SNAPSHOT_ROOT source — the source may still
# point at the old package dir, the patch writes the new package path directly).
SNAP_PKG_ROOT="${DSH_SNAPSHOT_PKG_ROOT:-/data/user/0/com.dsharnessmobile.shell}"
if [ ! -d "$ROOT/usr" ] || [ ! -d "$ROOT/home" ]; then
  echo "snapshot root is incomplete: $ROOT" >&2
  exit 1
fi

# Default remains standalone Termux; the embedded APK points DSH_SNAPSHOT_ROOT at its own files/.
# The latter needs the same Termux-exec/dynamic-lib env as EngineManager.shellEnv, so that host
# /system/bin/sh launching snapshot binaries does not fall back to compile-time Termux paths.
export PATH="$ROOT/usr/bin:/system/bin"
export HOME="$ROOT/home"
export PREFIX="$ROOT/usr"
if [ -f "$ROOT/usr/lib/libtermux-exec-ld-preload.so" ]; then
  export LD_LIBRARY_PATH="$ROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export LD_PRELOAD="$ROOT/usr/lib/libtermux-exec-ld-preload.so${LD_PRELOAD:+:$LD_PRELOAD}"
  export TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE=force
  export TERMUX_EXEC__EXECVE_CALL__INTERCEPT=1
  export TERMUX__ROOTFS="$ROOT"
  export TERMUX__PREFIX="$ROOT/usr"
  export TERMUX_APP__DATA_DIR="${ROOT%/files}"
fi
if [ -f "$ROOT/usr/etc/tls/openssl.cnf" ]; then
  export OPENSSL_CONF="$ROOT/usr/etc/tls/openssl.cnf"
fi
# sed -i temp files must land in a writable dir (the embedded app domain cannot write /data/local).
export TMPDIR="$ROOT/home/tmp"
mkdir -p "$TMPDIR"
cd "$ROOT"
# Base toolchain ships with the snapshot (2026-08-15: user wants curl/wget usable in bash;
# git/jq/unzip/nano are common base tools). pkg skips idempotently when already installed.
if command -v pkg >/dev/null 2>&1; then
  pkg install -y wget git jq unzip nano || echo "pkg install skipped (offline?)"
else
  echo "pkg unavailable; using installed snapshot tools"
fi
rm -rf "$ROOT/home/snapshot"
mkdir -p "$ROOT/home/snapshot"
EXCLUDES=""
for pat in \
  usr/include usr/var usr/tmp usr/share/man usr/share/info usr/share/doc \
  usr/lib/libLLVM.so usr/lib/libLLVM-21.so usr/lib/libclang-cpp.so usr/lib/libclang.so \
  usr/lib/clang usr/lib/python3.14 usr/lib/libpython3.14.so usr/lib/liblldELF.a usr/lib/liblldCOFF.a \
  usr/lib/libLTO.so usr/lib/libRemarks.so usr/lib/libarcher.so usr/lib/libbfd.so usr/lib/libbfd-2.47.so \
  usr/lib/libctf.so usr/lib/libctf-nobfd.so usr/lib/libsframe.so usr/lib/libopcodes.so usr/lib/gcc \
  usr/lib/cmake usr/lib/pkgconfig \
  usr/bin/llvm-exegesis usr/bin/llvm-tblgen usr/bin/llvm-readobj usr/bin/llvm-* usr/bin/clangd \
  usr/bin/clang-tidy usr/bin/clang-* usr/bin/cmake usr/bin/ctest usr/bin/cpack usr/bin/lld \
  usr/bin/gcc usr/bin/gcc-* usr/bin/cc usr/bin/c++ usr/bin/python usr/bin/python3* usr/bin/pip* \
  usr/bin/pkg-config usr/bin/ld usr/bin/ld.bfd usr/bin/ld.gold usr/bin/as usr/bin/ar usr/bin/nm \
  usr/bin/objcopy usr/bin/strip usr/bin/readelf usr/bin/objdump usr/bin/size usr/bin/strings \
  usr/bin/addr2line usr/bin/dwp usr/bin/ranlib usr/bin/elfedit usr/bin/llvm-symbolizer \
  '*/CMakeFiles/*' '*.o.d' '*/installed-tests/*' '*compile_commands.json' 'CMakeCache.txt' \
; do EXCLUDES="$EXCLUDES --exclude=$pat"; done
echo "tarring with excludes..."
# Embedded-form path rewrite (done on a staging copy, the original is untouched)
rm -rf stage-root
mkdir -p stage-root/home
cp -r home/.dsh stage-root/home/.dsh
# 🔒 Strip sensitive runtime data (2026-08-14 security audit: the v0.1.0 APK shipped an API key):
# the distributed snapshot carries config + deps only; keys/sessions/user data are generated at first run or configured by the user.
rm -rf stage-root/home/.dsh/.credentials.yaml
rm -rf stage-root/home/.dsh/.anonymous-user-id
rm -rf stage-root/home/.dsh/sessions
rm -rf stage-root/home/.dsh/storages
rm -rf stage-root/home/.dsh/attachments
rm -rf stage-root/home/.dsh/llm-deepseek
rm -rf stage-root/home/.dsh/update-cache 2>/dev/null || true
# Settings: seed zero-secret template (0.13.0 C1/Q14) instead of deleting outright — first boot
# default pin (deepseek-official) must have a resolvable route; secrets never land here.
cat > stage-root/home/.dsh/settings.yaml <<'SEED_EOF'
# dsh-mobile 0.13.0 first-boot default (zero-secret template; UI saves override this file)
llm-deepseek:
  # apiKeyEnv: DEEPSEEK_API_KEY  # injected by the shell; no key on disk
llm-pi-ai:
  providers: {}
SEED_EOF
# Sourcemaps embed full source (client.js.map once leaked UI bundle source in snapshots)
find stage-root/home/.dsh -name '*.map' -delete 2>/dev/null || true
# 2026-08-16 (v0.10.8): authoritative profile patch — the snapshot patch must be a synced copy of the
# main repo's scripts/profile-web.cordis.patch.yml (Termux path form; the sed below rewrites it to shell
# paths). Previously the snapshot patch was leftover Termux state missing the host-web-compat/picker and
# default-model entries → plugins not assembled on device (dir-pick 404, missing injection; verified on
# device in v0.10.8). Forced overwrite at snapshot time eliminates Termux environment drift.
mkdir -p stage-root/home/.dsh/profiles/web
cat > stage-root/home/.dsh/profiles/web/cordis.patch.yml <<'PATCH_EOF'
# Android adaptation: dsh-shell-termux (bash tools) + host-web-compat (polyfill +
# SAF directory-picker bridge) + ui-responsive (mobile form) + default model.
- id: bash-sandbox
  disabled: true
- insert:
    - id: shell-termux
      name: '@dsh-android/dsh-shell-termux'
      config:
        bashPath: /data/data/com.termux/files/usr/bin/bash
        prefix: /data/data/com.termux/files/usr
        home: /data/data/com.termux/files/home
        cwd: /data/data/com.termux/files/home
        timeoutMs: 120000
        maxTimeoutMs: 600000
    - id: host-web-compat
      name: '@dsh-android/dsh-host-web-compat'
- id: ui-layout
  disabled: true
- insert:
    - id: ui-responsive
      name: '@dsh-android/dsh-client-ui-responsive'
# Attachment format extensions (0.12.1, issue #39): dsh-attachment-formats
# (PDF text layer / Office local structuring; scanned-doc local OCR via tesseract.js with bundled language packs).
- insert:
    - id: attachment-formats
      name: dsh-attachment-formats
# Workspace picker (issue apk#5): directory-picker-auto always resolves to browse on Android —
# disable it and mount the upstream renderless native surface, driven by host-web-compat's SAF bridge
# to the system directory picker.
- id: directory-picker
  disabled: true
- insert:
    - id: picker-native-surface
      name: '@deepseek-ai/dsh-client-ui-directory-picker-native'
# Default model（0.13.0 C3 修正）：deepseek-official（壳注入 DEEPSEEK_API_KEY，开箱即用）——
# 不再 pin opencode-go（OpenCode Zen Go 端点实测 404，见 profile-web.cordis.patch.yml 注释）。
- id: agent-default-model
  disabled: true
- insert:
    - id: agent-default-model-mobile
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
PATCH_EOF
# Review 2026-08-18 (CP1): eliminate dual-copy drift — the authoritative patch is the main repo's
# scripts/profile-web.cordis.patch.yml (relative to the repo root). The heredoc above is only an offline
# fallback; when the external authoritative file exists it overrides (key entries are validated).
PATCH_TARGET=stage-root/home/.dsh/profiles/web/cordis.patch.yml
PATCH_SRC="${PATCH_SRC:-}"
if [ -z "$PATCH_SRC" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  for cand in "$SCRIPT_DIR/profile-web.cordis.patch.yml" "$SCRIPT_DIR/../scripts/profile-web.cordis.patch.yml"; do
    if [ -f "$cand" ]; then PATCH_SRC="$cand"; break; fi
  done
fi
if [ -n "$PATCH_SRC" ] && [ -f "$PATCH_SRC" ]; then
  if ! grep -q 'host-web-compat' "$PATCH_SRC" || ! grep -q 'picker-native-surface' "$PATCH_SRC"; then
    echo "WARNING: $PATCH_SRC missing key entries (host-web-compat/picker-native-surface); using embedded copy"
  else
    cp "$PATCH_SRC" "$PATCH_TARGET"
    echo "patch: using authoritative copy $PATCH_SRC"
  fi
else
  echo "WARNING: external profile-web.cordis.patch.yml not found; using embedded copy (may drift from the main repo, sync it)"
fi
sed -i "s|/data/data/com.termux/files/usr/bin/bash|$SNAP_PKG_ROOT/usr/bin/bash|g; s|/data/data/com.termux/files/usr|$SNAP_PKG_ROOT/usr|g; s|/data/data/com.termux/files/home|$SNAP_PKG_ROOT/home|g; s|com\.dshmobile\.shell|com.dsharnessmobile.shell|g" stage-root/home/.dsh/profiles/*/cordis.patch.yml
# The Android app domain (untrusted_app/runas_app) forbids link(2) (SELinux domain-level, targetSdk-independent);
# dsh session logs are published atomically via link()+unlink() → EACCES fails every agent turn.
# Minimal artifact-level patch: fall back to rename() on link failure (EACCES/EPERM); a single engine process has no concurrent-overwrite risk.
PJSONL=usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js
if grep -q 'rename, mkdir' "$PJSONL"; then echo "fs.link patch already applied"; else
sed -i 's|import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";|import { link, rename, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";|' "$PJSONL"
sed -i 's|await link(tmp, finalPath);|await link(tmp, finalPath).catch(function (e) { if (e.code !== "EACCES" \&\& e.code !== "EPERM" \&\& e.code !== "ENOTSUP") throw e; return rename(tmp, finalPath); });|' "$PJSONL"
echo "fs.link patch applied"
fi
# 2026-08-15 (Bug fix): the Write tool (fs-local atomic write) also publishes via link() in the
# createIfAbsent branch → Android 16 SELinux + FUSE both forbid link → EACCES.
# Minimal artifact-level patch: on link failure (EACCES/EPERM/ENOTSUP) lstat the target first:
# if it exists keep the original error (no-replace semantics preserved); only on ENOENT fall back to
# rename() (same dir, same fs → atomic publish). Note the TOCTOU window between lstat and rename
# (a concurrent creator could be overwritten by rename) — Android has no hard-link atomic no-replace
# primitive, an acceptable real-world cost for the single-engine-process scenario.
PFS=usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js
if grep -q 'lstat(absolutePath).then' "$PFS"; then echo "fs-local link patch already applied"; else
sed -i 's|await linkFile(tempPath, absolutePath);|await linkFile(tempPath, absolutePath).catch(function (e) { if (e.code !== "EACCES" \&\& e.code !== "EPERM" \&\& e.code !== "ENOTSUP") throw e; return lstat(absolutePath).then(function () { throw e; }, function (e2) { if (e2.code !== "ENOENT") throw e2; return rename(tempPath, absolutePath); }); });|' "$PFS"
echo "fs-local link patch applied"
fi
# 2026-08-15 (Bug fix): Android has no bwrap/Landlock backend, so confined mode
# (workspace-write/read-only) fails closed ("no sandbox backend is usable; refusing to run
# unconfined"). Honest degradation: under the Termux env (engine injects TERMUX__PREFIX) confine
# returns the original argv (enforcement: partial — the real boundary is app-domain SELinux
# u0_aXXX + the approval flow, matching what shell-termux declares).
PSB=usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js
if grep -q 'TERMUX__PREFIX' "$PSB"; then echo "sandbox-local patch already applied"; else
# Insertion point is the top of confine() (the runnerCommand branch is excluded by its own condition):
# runner probing inside selectRunner (spawnSync bwrap / landlock addon probe) may throw non-
# SandboxUnavailableError exceptions on Android, so short-circuiting at the top is safest.
# TERMUX__PREFIX is combined with a platform check (2026-08-15 on-device: Node/Termux on Android
# reports process.platform "android", not "linux"; both are allowed — this guards against a host
# WSL/Termux env that would otherwise disable the sandbox globally). Boundaries stated honestly:
# enforcement=partial, no path-level confiner (Android has no bwrap), real constraints =
# app-domain SELinux u0_aXXX + the approval flow; read-only mode degrades the same way.
sed -i 's|confine(argv, policy) {|confine(argv, policy) {\n\t\tif ((process.platform === "linux" \|\| process.platform === "android") \&\& process.env.TERMUX__PREFIX \&\& this.runnerCommand === void 0) return { argv: [...argv], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] };|' "$PSB"
echo "sandbox-local patch applied"
fi
# 2026-08-15 (on-device): Node/Termux on Android reports process.platform "android" (not "linux");
# dsh-subprocess-local's createProcessInspector only accepts linux/darwin → bash tools fail on the
# spawnTerminal path with "terminal inspection is unsupported on platform android". Android's /proc
# process table is Linux-isomorphic, so reuse LinuxProcessInspector directly (arch passed through).
PSUB=usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js
if grep -q 'platform === "android"' "$PSUB"; then echo "subprocess-local platform patch already applied"; else
sed -i 's|if (platform === "linux") return new LinuxProcessInspector(arch, internals);|if (platform === "linux") return new LinuxProcessInspector(arch, internals);\n\tif (platform === "android") return new LinuxProcessInspector(arch, internals);|' "$PSUB"
echo "subprocess-local platform patch applied"
fi
# 2026-08-15 (v0.10.5): dsh-sandbox's writableRoots (the Write tool's in-process fence writable
# roots) included "/tmp" by default, but the Android app domain cannot write Termux's baked-in /tmp
# → the Write tool hits a bare EACCES under /tmp. Minimal artifact-level patch: exclude "/tmp" on
# Android (keep workspaceRoot and os.tmpdir() — TMPDIR is already pointed at private files/home/tmp
# by the engine env). Note: this patch was once applied only manually to device snapshots, not baked
# into the script (verified present pre-v0.10.5); this section hardens it against snapshot rebuilds
# (idempotent). sed replaces only the first "/tmp", (the sole occurrence in the roots array).
PSANDBOX=usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js
if grep -q 'process.platform === "android" ? \[\] : \["/tmp"\]' "$PSANDBOX"; then echo "dsh-sandbox writableRoots patch already applied"; else
sed -i 's|"/tmp",|...(process.platform === "android" ? [] : ["/tmp"]),|' "$PSANDBOX"
echo "dsh-sandbox writableRoots patch applied"
fi
tar -cf - $EXCLUDES -C "$ROOT" usr -C "$ROOT/stage-root" home/.dsh 2>"$ROOT/home/tarerr.txt" | xz -9 -T0 > "$ROOT/home/snapshot/snapshot.tar.xz"
rm -rf stage-root
ls -lh "$ROOT/home/snapshot/snapshot.tar.xz"
echo "DONE"
