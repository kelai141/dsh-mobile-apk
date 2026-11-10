#!/bin/bash
# Build dsh-session-header-probe for Android from a Linux shell, using the
# Windows-side NDK sysroot through WSL. This exists so the probe does not
# depend on a cloud runner: the same toolchain that devs already have works.
#
# Usage: build-local.sh [x86_64|aarch64] [outdir]
#
# Two NDK r27 facts this has to work around:
#   * libgcc is gone (compiler-rt only) and libunwind merged into libc, but
#     rustc still passes -lgcc / -lunwind. Both names are mapped onto real
#     NDK archives instead of stubs, so unwind tables still resolve.
set -euo pipefail

TARGET_ARCH="${1:-x86_64}"
OUT="${2:-/tmp/dsh-session-header-probe}"
NDK="${ANDROID_NDK_HOME:-/mnt/d/Android/Sdk/ndk/27.0.12077973}"
# The NDK bundles the sysroot under tools/..., not at its root.
SR="$NDK/toolchains/llvm/prebuilt/windows-x86_64/sysroot"
[ -d "$SR" ] || SR="$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/root/.cargo/bin:$PATH"

case "$TARGET_ARCH" in
  x86_64)  TRIPLE=x86_64-linux-android;  CLANG_ARCH=x86_64;  MACHINE='Advanced Micro Devices X86-64' ;;
  aarch64) TRIPLE=aarch64-linux-android; CLANG_ARCH=aarch64; MACHINE='AArch64' ;;
  *) echo "unknown arch: $TARGET_ARCH" >&2; exit 2 ;;
esac

if [ ! -d "$SR" ]; then
  echo "NDK sysroot not found: $SR" >&2
  echo "Set ANDROID_NDK_HOME to an NDK r27 install." >&2
  exit 2
fi

# clang's own runtime lives next to the prebuilt toolchain, under its version dir.
CLANG_LIB="$(dirname "$SR")/lib/clang"
CLANG_LIB="$(echo "$CLANG_LIB"/[0-9]* | tail -1)"

mkdir -p "$OUT/lib" "$OUT/target"
ln -sf "$CLANG_LIB/lib/linux/$CLANG_ARCH/libunwind.a" "$OUT/lib/libunwind.a"
BUILTINS="$CLANG_LIB/lib/linux/libclang_rt.builtins-$CLANG_ARCH-android.a"
[ -f "$BUILTINS" ] || BUILTINS="$(find "$CLANG_LIB/lib/linux" -maxdepth 1 -name "libclang_rt.builtins-$CLANG_ARCH*" | head -1)"
[ -f "$BUILTINS" ] || { echo "compiler-rt builtins for $CLANG_ARCH not found" >&2; exit 2; }
ln -sf "$BUILTINS" "$OUT/lib/libgcc.a"

cat > "$OUT/clang-wrapper.sh" <<WRAP
#!/bin/bash
exec clang --target=${TRIPLE}26 --sysroot="$SR" \
  -isystem "$SR/usr/include/${TRIPLE}" -isystem "$SR/usr/include" \
  -L"$OUT/lib" -L"$SR/usr/lib/${TRIPLE}/26" "\$@"
WRAP
chmod +x "$OUT/clang-wrapper.sh"

ENV_PREFIX="${TRIPLE//-/_}"
TARGET_ENV="${TRIPLE^^}"
TARGET_ENV="${TARGET_ENV//-/_}"
export "CARGO_TARGET_${TARGET_ENV}_LINKER=$OUT/clang-wrapper.sh"
export "CC_${ENV_PREFIX}=$OUT/clang-wrapper.sh"
export "AR_${ENV_PREFIX}=ar"
# Android 16 needs 16 KiB page alignment for freshly built native code.
export RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384'

cargo build --locked --release --manifest-path "$HERE/native/Cargo.toml" \
  --target "$TRIPLE" --target-dir "$OUT/target"

BIN="$OUT/target/$TRIPLE/release/dsh-session-header-probe"
echo "built: $BIN"
readelf -h "$BIN" | grep Machine
echo "LOAD align:"; readelf -lW "$BIN" | awk '$1 == "LOAD" { print $NF }' | sort -u
