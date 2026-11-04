# overlay 缓存命中也要校验，落盘改原子（2026-11-03，issue #1414）

## 现象

`overlayTgz()` 的命中判据是 `if (existsSync(dest)) return dest`：上次中断留下的截断 tgz、或换镜像后
同名不同字节的包，会被原样解进引擎树，构建日志里没有任何异常。落盘也是裸 `writeFileSync`，
写到一半被杀就留下截断文件——而它下次会被「命中」。

## 真因

缓存的存在性被当成了完整性。三个侧面同源：

1. **命中即信**：没有任何摘要可用于复核缓存内容；
2. **写入非原子**：中断产生残档的概率不低，而残档恰好满足 `existsSync`；
3. **缓存名没有内容维度**：同名不同字节的包无法区分。

## 修法

缓存逻辑抽成 `scripts/lib/overlay-cache.mjs`（纯函数，临时目录毫秒级可测）：

- `overlayCacheHit(dest)`：只有「文件在 + sidecar `<dest>.sha512` 在 + 摘要一致」才算命中；
  缺 sidecar（旧缓存）或摘要不符一律**删掉残档**并返回 null，让调用方重下；
- `overlayCacheStore(dest, buf)`：先写 `<dest>.tmp-<pid>` 再 rename（原子），成功后写 sidecar。

`build-snapshot-013.mjs` 只负责「调一次」：命中走 `overlayCacheHit`，落盘走 `overlayCacheStore`。

抽成模块的理由与 #1415 同：这段判据原来只能靠「真的跑一次双 ABI 构建」来验，负控没人跑得动。

## 复验

- `scripts/overlay-cache.test.mjs`（6 例）：未命中返回 null / 落盘写 sidecar 且再命中 / 截断文件不命中
  且清掉残档与 sidecar / 无 sidecar 的旧缓存不命中 / 空 sidecar 不命中 / 不残留 `.tmp-`。
- 改前形态：同一份「无 sidecar 的旧缓存」在旧判据（`existsSync`）下得到 `HIT`——坏包被解进引擎树。
- `node scripts/check-code-map.mjs` → PASSED（`build-snapshot-013.mjs` 锚点按内容重映射后手钉 `#expect`，
  其中三条原本指向 `//` 与 `}` 的锚点改钉到真正有意义的那一行）。
- `node scripts/check-release-gates.mjs` → 除本机 `node --check` 环境项外全 PASS（含
  「scripts/lib 公共模块均有真实消费者（12 个模块，豁免 0 个）」）。
- **未做设备验证**：纯构建链脚本，不涉及设备面。
