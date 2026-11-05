import json, sys
from collections import defaultdict
# 从 tarls.py --entries 的 TSV 统计：同一包名多份实例时，"多余副本"占多少字节
path = sys.argv[1]
inst = defaultdict(lambda: defaultdict(lambda: [0, 0]))  # pkg -> version -> [bytes, files]
NEW = "/node_modules/"
def split(n):
    parts = n.split("/")
    last = -1
    for i, s in enumerate(parts):
        if s == "node_modules":
            last = i
    if last < 0 or last + 1 >= len(parts):
        return None, None
    nm, rest = parts[last + 1], "/".join(parts[last + 2:])
    if nm.startswith("@") and last + 2 < len(parts):
        return nm + "/" + parts[last + 2], "/".join(parts[last + 3:])
    return nm, rest
with open(path, encoding="utf-8") as f:
    next(f)
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        s, _t, p = line.split("\t", 2)
        if NEW not in p:
            continue
        pkg, rel = split(p)
        if not pkg or rel != "package.json":
            continue
        # 该 package.json 所在目录之后的所有文件属于同一实例；这里只记 package.json 位置
        inst[pkg][p.split("/")[-2] if False else p] = [int(s), 1]
# 上面无法拿版本，改用「实例目录」为单位：以 package.json 的父目录为实例键
bypkg = defaultdict(lambda: defaultdict(lambda: [0, 0]))
with open(path, encoding="utf-8") as f:
    next(f)
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        s, _t, p = line.split("\t", 2)
        if NEW not in p:
            continue
        parts = p.split("/")
        last = -1
        for i, seg in enumerate(parts):
            if seg == "node_modules":
                last = i
        if last < 0 or last + 1 >= len(parts):
            continue
        nm = parts[last + 1]
        if nm.startswith("@") and last + 2 < len(parts):
            pkg = nm + "/" + parts[last + 2]
            root = "/".join(parts[:last + 3])
        else:
            pkg = nm
            root = "/".join(parts[:last + 2])
        v = bypkg[pkg][root]
        v[0] += int(s); v[1] += 1
dups = {k: v for k, v in bypkg.items() if len(v) > 1}
extra_bytes = 0
extra_files = 0
rows = []
for pkg, instances in dups.items():
    sizes = sorted(((b, cnt, r) for r, (b, cnt) in instances.items()), reverse=True)
    keep = sizes[0]
    extra = sizes[1:]
    eb = sum(x[0] for x in extra); ef = sum(x[1] for x in extra)
    extra_bytes += eb; extra_files += ef
    rows.append((eb, pkg, len(instances), keep[0], eb, ef))
rows.sort(reverse=True)
total = sum(v[0] for inst in bypkg.values() for v in inst.values())
print(json.dumps({
  "packagesWithMultipleInstances": len(dups),
  "extraBytes": extra_bytes,
  "extraMiB": round(extra_bytes / 1048576, 2),
  "extraFiles": extra_files,
  "totalNodeModulesBytes": total,
  "pctOfNodeModules": round(100.0 * extra_bytes / total, 2) if total else 0,
  "top": [{"pkg": r[1], "instances": r[2], "keptB": r[3], "extraB": r[4], "extraMiB": round(r[4]/1048576, 2), "extraFiles": r[5]} for r in rows[:20]],
}, ensure_ascii=False, indent=1))
