# -*- coding: utf-8 -*-
"""build_lingshu_snapshot.py —— 灵枢注入 dsh-mobile 快照（流式保真重打包）

输入：
  snapshot-arm64.tar.xz    官方运行时快照（node+dsh）
  python_3.14.6-1_aarch64.deb  Termux python 3.14
  site-packages/aeis, wisdom   灵枢引擎
  dsh-memory 插件（~/.dsh/profiles/web/node_modules/@furongjun1999/dsh-memory）
  快照 dsh 引擎 @deepseek-ai 生态（peer 依赖）

输出：
  snapshot-lingshu-arm64.tar.xz —— 手机端在线更新推送用
"""
import io, lzma, os, sys, tarfile, time, json

sys.stdout.reconfigure(encoding="utf-8")
BASE = r"D:\Program Files\2_ai\dsh-snapshots"
SRC = os.path.join(BASE, "snapshot-arm64.tar.xz")
OUT = os.path.join(BASE, "snapshot-lingshu-arm64.tar.xz")
PY_DEB = os.path.join(BASE, "python_3.14.6-1_aarch64.deb")
SP = r"C:\Users\FuRongJun\AppData\Local\Programs\Python\Python310\lib\site-packages"
ROOT = os.path.join(BASE, "snapshot-root")
MEM_SRC = r"C:\Users\FuRongJun\.dsh\profiles\web\node_modules\@furongjun1999\dsh-memory"

# ---------------- 1. python deb data ----------------
def read_ar_member(data, name):
    off = 8
    while off < len(data) - 60:
        hdr = data[off:off+60]
        fname = hdr[0:16].decode().strip().rstrip("/")
        size = int(hdr[48:58].decode().strip())
        body = data[off+60:off+60+size]
        if fname == name:
            return body
        off = off + 60 + size + (size % 2)
    return None

deb_data = open(PY_DEB, "rb").read()
py_t = tarfile.open(fileobj=io.BytesIO(lzma.decompress(read_ar_member(deb_data, "data.tar.xz"))), mode="r:")
PY_PREFIX = "./data/data/com.termux/files/"
py_entries = {}  # relpath -> dict(type, data|link)
for m in py_t.getmembers():
    rel = m.name[len(PY_PREFIX):] if m.name.startswith(PY_PREFIX) else m.name.lstrip("./")
    if rel == "usr" or rel == ".":
        continue
    if m.issym():
        py_entries[rel] = {"type": "sym", "link": m.linkname}
    elif m.isreg():
        # 保留 deb 原始 mode（usr/bin/* 为 0o755 可执行——之前丢失执行位导致
        # 手机端 spawn python3.14 EACCES）
        py_entries[rel] = {"type": "file", "data": py_t.extractfile(m).read(),
                           "mode": m.mode}
print("python deb entries:", len(py_entries))

# ---------------- 2. aeis 核心包（裁剪） ----------------
AEIS_KEEP = ["__init__.py", "api.py", "attention.py", "blindspot.py", "cognition.py",
             "core.py", "entities.py", "flywheel.py", "knowledge.py", "lifecycle.py",
             "longterm_gate.py", "prediction.py", "roleplay.py", "roleplay_chat.py",
             "self_cognition.py", "semantic.py",
             "mcp/__init__.py", "mcp/server.py",
             "security/__init__.py", "security/adversarial.py"]
# 裁剪版 __init__.py（去掉 body/vision/vprim/world3d 硬导入）
TRIM_INIT = '''# -*- coding: utf-8 -*-
"""aeis · 灵枢（手机端裁剪版 __init__：去掉设备层 body/vision/vprim/world3d）"""
import sys as _sys
from . import core as _core
_sys.modules["spacetime_memory_core"] = _core
from . import flywheel as _flywheel
_sys.modules["flywheel_engine"] = _flywheel
from . import semantic as _semantic
_sys.modules["semantic_space"] = _semantic
from . import attention as _attention
_sys.modules["attention_policy"] = _attention
from . import prediction as _prediction
_sys.modules["prediction_engine"] = _prediction
from . import lifecycle as _lifecycle
_sys.modules["lifecycle_engine"] = _lifecycle
from . import blindspot as _blindspot
_sys.modules["blindspot_learning_loop"] = _blindspot
from . import cognition as _cognition
_sys.modules["cognitive_orchestrator"] = _cognition
from . import entities as _entities
_sys.modules["entity_registry"] = _entities
from . import self_cognition as _self_cognition
_sys.modules["self_cognition_engine"] = _self_cognition
from . import knowledge as _knowledge
_sys.modules["knowledge"] = _knowledge
from . import longterm_gate as _longterm_gate
_sys.modules["longterm_gate"] = _longterm_gate
from . import api as _api
from .api import Agent
from .core import (SpacetimeMemoryEngine, LayeredStore, ConditionSpace,
                   STNode, STEdge, SelfModel, EdgeType, MemoryLayer, Role, NodeType)
from .flywheel import FlywheelEngine
from .semantic import SemanticSpaceProvider
from .attention import AttentionPolicy
from .prediction import PredictionEngine
from .lifecycle import LifecycleEngine
from .blindspot import BlindSpotLearningLoop
from .cognition import CognitiveOrchestrator
from .entities import EntityRegistry
from .self_cognition import SelfCognitionEngine
from .knowledge import ingest_text, ingest_file, ingest_url
__version__ = "0.3.1"
ENGINE_VERSION = "v1.15.0"
PROTOCOL = "智能论 v3.2"
DISTILL_STANDARD_VERSION = _flywheel.FlywheelEngine.DISTILL_STANDARD_VERSION
__all__ = [
    "Agent", "SpacetimeMemoryEngine", "LayeredStore", "ConditionSpace",
    "STNode", "STEdge", "SelfModel", "EdgeType", "MemoryLayer", "Role", "NodeType",
    "FlywheelEngine", "SemanticSpaceProvider", "AttentionPolicy",
    "PredictionEngine", "LifecycleEngine", "BlindSpotLearningLoop",
    "CognitiveOrchestrator", "EntityRegistry", "SelfCognitionEngine",
    "ingest_text", "ingest_file", "ingest_url",
    "__version__", "ENGINE_VERSION", "PROTOCOL", "DISTILL_STANDARD_VERSION",
]
'''
aeis_entries = {}
aeis_entries["usr/lib/python3.14/site-packages/aeis/__init__.py"] = TRIM_INIT.encode("utf-8")
for rel in AEIS_KEEP:
    if rel == "__init__.py":
        continue
    fp = os.path.join(SP, "aeis", rel)
    if os.path.isfile(fp):
        aeis_entries["usr/lib/python3.14/site-packages/aeis/" + rel] = open(fp, "rb").read()
    else:
        print("WARN aeis missing:", rel)
print("aeis entries:", len(aeis_entries))

# ---------------- 3. wisdom 全部 ----------------
wis_entries = {}
wdir = os.path.join(SP, "wisdom")
for root, dirs, files in os.walk(wdir):
    for f in files:
        fp = os.path.join(root, f)
        rel = os.path.relpath(fp, wdir).replace("\\", "/")
        wis_entries["usr/lib/python3.14/site-packages/wisdom/" + rel] = open(fp, "rb").read()
print("wisdom entries:", len(wis_entries))

# ---------------- 4. dsh-memory 插件 ----------------
mem_entries = {}
for root, dirs, files in os.walk(MEM_SRC):
    for f in files:
        fp = os.path.join(root, f)
        rel = os.path.relpath(fp, MEM_SRC).replace("\\", "/")
        for prof in ("web", "headless"):
            mem_entries[f"home/.dsh/profiles/{prof}/node_modules/@furongjun1999/dsh-memory/{rel}"] = open(fp, "rb").read()
print("dsh-memory entries:", len(mem_entries))

# ---------------- 5. @deepseek-ai 生态：不注入实体 ----------------
# dsh-app-boot 启动时 healProfilesModuleFallback 自动为依赖闭包（含
# schemastery/cordis/dsh-tools/dsh-session）在 profiles/node_modules 建
# symlink 指向引擎 real location——实体目录会触发 ensureSymlink 抛错
# （"exists and is not a symlink"）。故此处仅需确认闭包可达，不注入。
ds_entries = {}
print("deepseek-ai entries: 0 (auto-heal by dsh-app-boot)")

# ---------------- 6. cordis.patch.yml 追加 ----------------
PATCH_ADD = """
# 灵枢（AEIS）长期记忆框架（dsh-mobile-lingshu）
- insert:
    - id: lingshu-memory
      name: '@furongjun1999/dsh-memory'
      config:
        python: /data/data/com.dsharnessmobile.shell/files/usr/bin/python3
        dbPath: /data/data/com.dsharnessmobile.shell/files/home/.dsh/lingshu.db
        # 全部 71 个工具（含记忆/认知/白箱 wisdom_* 工具族）
        tools: all
"""
def load_patch(rel):
    p = os.path.join(ROOT, rel)
    return open(p, encoding="utf-8").read() if os.path.exists(p) else ""
patch_entries = {
    "home/.dsh/profiles/web/cordis.patch.yml": load_patch("home/.dsh/profiles/web/cordis.patch.yml") + PATCH_ADD,
    "home/.dsh/profiles/headless/cordis.patch.yml": load_patch("home/.dsh/profiles/headless/cordis.patch.yml") + PATCH_ADD,
}

# ---------------- 7. 流式重打包 ----------------
inject = {**py_entries, **aeis_entries, **wis_entries, **mem_entries, **ds_entries}
inject_files = {k: v for k, v in inject.items() if isinstance(v, dict) and v.get("type") == "file"}
inject_sym = {k: v["link"] for k, v in inject.items() if isinstance(v, dict) and v.get("type") == "sym"}
inject_bytes = {k: v for k, v in inject.items() if isinstance(v, bytes)}
patch_paths = set(patch_entries.keys())

t0 = time.time()
with tarfile.open(SRC, "r:xz") as tin, \
     tarfile.open(OUT, "w:xz", preset=6) as tout:
    # 先写注入的 patch（覆盖原 cordis.patch.yml）
    for rel, txt in patch_entries.items():
        ti = tarfile.TarInfo(rel)
        b = txt.encode("utf-8")
        ti.size = len(b)
        ti.mode = 0o644
        ti.mtime = int(time.time())
        tout.addfile(ti, io.BytesIO(b))
    # 原快照条目（跳过被注入覆盖的路径）
    n_kept = 0
    for m in tin.getmembers():
        name = m.name.lstrip("./")
        if name in patch_paths or name in inject_files or name in inject_sym or name in inject_bytes:
            continue  # 由注入覆盖
        if m.issym():
            tout.addfile(m)
            n_kept += 1
        elif m.isreg():
            f = tin.extractfile(m)
            tout.addfile(m, f)
            n_kept += 1
        else:
            tout.addfile(m)
            n_kept += 1
    print("original entries kept:", n_kept)
    # 注入文件
    def add_bytes(rel, data, mode=0o644):
        ti = tarfile.TarInfo(rel)
        ti.size = len(data)
        ti.mode = mode
        ti.mtime = int(time.time())
        tout.addfile(ti, io.BytesIO(data))
    for rel, d in inject_bytes.items():
        add_bytes(rel, d, 0o644 if not rel.endswith(("/python3.14", "/dsh", "/bash")) else 0o755)
    for rel, d in inject_files.items():
        add_bytes(rel, d["data"], d.get("mode", 0o644))
    for rel, link in inject_sym.items():
        ti = tarfile.TarInfo(rel)
        ti.type = tarfile.SYMTYPE
        ti.linkname = link
        ti.mode = 0o777
        ti.mtime = int(time.time())
        tout.addfile(ti)
print("repacked in", round(time.time() - t0, 1), "s")
print("OUT:", OUT)
