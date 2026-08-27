#!/usr/bin/env python3
"""Assemble the arm64 rc8 snapshot from:
  A = rc7 arm64 snapshot   (native layer: usr/bin|etc|share|lib minus node_modules;
                            arm64 koffi build + node-pty 1.1.0)
  B = MuMu rc8 js-layer    (usr/lib/node_modules, tar paths under node_modules/)
  C = MuMu rc8 dsh-layer   (home/.dsh profile, tar paths under .dsh/)
Streams tar.xz -> tar.xz; symlinks are preserved as metadata (no on-disk links).
usage: assemble-arm64.py <A.tar.xz> <B.tar.xz> <C.tar.xz> <out.tar.xz>
"""
import io
import lzma
import sys
import tarfile

NM_PREFIX = "usr/lib/node_modules/"
DSH_NM = "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/"
# JS-layer paths to skip (replaced by arm64 natives from A)
# koffi: whole package from A (rc7, 3.1.5) — mixing rc8 JS layer (3.1.4) with the
# rc7-built arm64 .node (3.1.5) trips koffi's "Mismatched native Koffi modules" check
# (src/koffi/index.cjs wrapNative: native2.version != version2) and the engine
# fails to boot on arm64. The rc7 package carries both halves at 3.1.5.
# node-pty: rc8 has no android prebuild; rc7's 1.1.0 package is the working build.
SKIP_PREFIXES = (
    DSH_NM + "koffi/",
    DSH_NM + "node-pty/",
)
# Sensitive runtime data stripped from profile layer (mirrors make-snapshot.sh):
# note: tar directory entries carry no trailing slash, so match without one.
SENSITIVE_FRAGMENTS = (
    "/.credentials.yaml",
    "/.anonymous-user-id",
    "/settings.yaml",
    "/sessions",
    "/storages",
    "/update-cache",
)
SENSITIVE_SUFFIX = ".js.map"


def should_strip(name: str) -> bool:
    return any(f in name for f in SENSITIVE_FRAGMENTS) or name.endswith(SENSITIVE_SUFFIX)


def main() -> None:
    a, b, c, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    stats = {"a_native": 0, "b_js": 0, "a_native_overlay": 0, "c_dsh": 0, "skipped": 0}
    with lzma.open(out, "wb") as fout:
        with tarfile.open(fileobj=fout, mode="w|") as tout:
            # ---- A: native layer (usr/* minus node_modules) ----
            with lzma.open(a) as fin:
                with tarfile.open(fileobj=fin, mode="r|") as tin:
                    for m in tin:
                        if m.name.startswith("usr/lib/node_modules/"):
                            continue
                        if m.name.startswith("home/"):
                            continue
                        if m.isfile():
                            d = tin.extractfile(m)
                            if d is None:
                                tout.addfile(m)
                            else:
                                tout.addfile(m, d)
                        else:
                            tout.addfile(m)
                        stats["a_native"] += 1
            # ---- B: rc8 JS layer (node_modules/ -> usr/lib/node_modules/) ----
            with lzma.open(b) as fin:
                with tarfile.open(fileobj=fin, mode="r|") as tin:
                    for m in tin:
                        if not m.name.startswith("node_modules/"):
                            continue
                        if any(m.name.startswith(p) for p in SKIP_PREFIXES):
                            stats["skipped"] += 1
                            if m.isfile():
                                d = tin.extractfile(m)
                                if d is not None:
                                    d.read()
                            continue
                        m.name = NM_PREFIX + m.name[len("node_modules/"):]
                        if m.isfile():
                            d = tin.extractfile(m)
                            if d is None:
                                tout.addfile(m)
                            else:
                                tout.addfile(m, d)
                        else:
                            tout.addfile(m)
                        stats["b_js"] += 1
            # ---- A: arm64 koffi (whole package, 3.1.5) + node-pty overlay ----
            for prefix in (DSH_NM + "koffi/", DSH_NM + "node-pty/"):
                with lzma.open(a) as fin:
                    with tarfile.open(fileobj=fin, mode="r|") as tin:
                        for m in tin:
                            if not m.name.startswith(prefix):
                                continue
                            if m.isfile():
                                d = tin.extractfile(m)
                                if d is None:
                                    tout.addfile(m)
                                else:
                                    tout.addfile(m, d)
                            else:
                                tout.addfile(m)
                            stats["a_native_overlay"] += 1
            # ---- C: rc8 profile layer (.dsh/ -> home/.dsh/) ----
            with lzma.open(c) as fin:
                with tarfile.open(fileobj=fin, mode="r|") as tin:
                    for m in tin:
                        if not m.name.startswith(".dsh/"):
                            continue
                        m.name = "home/" + m.name
                        if should_strip(m.name):
                            stats["stripped"] = stats.get("stripped", 0) + 1
                            if m.isfile():
                                d = tin.extractfile(m)
                                if d is not None:
                                    d.read()
                            continue
                        if m.isfile():
                            d = tin.extractfile(m)
                            if d is None:
                                tout.addfile(m)
                            else:
                                tout.addfile(m, d)
                        else:
                            tout.addfile(m)
                        stats["c_dsh"] += 1
    print(f"assembled: native={stats['a_native']} js={stats['b_js']} "
          f"native-overlay={stats['a_native_overlay']} dsh={stats['c_dsh']} "
          f"skipped={stats['skipped']}")
    print("DONE")


if __name__ == "__main__":
    main()
