/**
 * 快照软链自净化（0.14.1 P0）。
 *
 * 为什么需要它
 * ------------
 * 快照归档由**构建机**（WSL + Termux 基座 + Termux deb 包）拼出，树里天然带着构建机的绝对前缀
 * `/data/data/com.termux/files/usr/...`：
 *   - deb 数据树里 bzip2 的 `usr/bin/bzcmp -> /data/data/com.termux/files/usr/bin/bzdiff`；
 *   - 基座 bootstrap 的 `home/.dsh/profiles/node_modules/<pkg> -> <Termux 前缀>/usr/lib/node_modules/...`
 *     （同树 dedup 链接，目标就在同一份归档里）。
 *
 * 而**设备侧**提取器必须拒绝它们，这是安全边界不是保守：
 * `SnapshotExtractor.isLinkTargetAllowed` 的判据是「相对链解析后必须在解压根内；绝对链只接受本 App
 * 运行时根（供 busybox applet 绝对链存活）」并明文拒绝 Termux 残留与逃逸目标；在线更新快照走明文
 * HTTP，放宽这一层就是拿沙箱换便利。
 *
 * 后果是**幽灵缺失**：产物清点实测 arm64 111 条、x86_64 113 条旧前缀绝对链，每台设备都静默丢弃
 * （实测设备 `home/.dsh/profiles/node_modules/` 198 条 vs 归档 264 条）——构建机上解析得到、
 * 设备上必然解析不到，且**只在设备上才暴露**（模拟器/单测都看不见）。
 *
 * 判据与策略（幂等）
 * ------------------
 *  1. 相对链：保留（设备侧接受树内相对链）。
 *  2. 绝对链指向**本 App**：保留（设备侧按 runtimeCanon 接受）。两种写法都算本 App：
 *     `/data/data/com.dsharnessmobile.shell/...` 与别名 `/data/user/0/com.dsharnessmobile.shell/...`
 *     （Android 上 `/data/user/0/<pkg>` 是指向 `/data/data/<pkg>` 的别名；设备侧判据走
 *     `canonicalPath`，两种写法都解析进运行时根，**必须都保留**——实测 `usr/bin/{vi,editor,pager,nc}`
 *     就是 `/data/user/0/...` 写法，按「非 App 前缀即删」处理会误删可用的编辑器入口）。
 *  3. 绝对链指向**旧 Termux 前缀**：剥前缀得树内候选路径 —— 存在则改写为**相对链**（功能等价，
 *     设备可解析）；不存在则删除（纯残留，留着只会在每台设备上被丢弃）。
 *  4. 其它绝对链：**原样保留**（维持现状）。本步只处理「已实测必然被设备丢弃」的旧前缀一类，
 *     顺手扩大删除面属于无依据的改动。
 *
 * 实测（x86_64 快照全量 2023 条软链）：旧前缀 113 条 → 相对化 19（目标确在树内）+ 删除 103 残留；
 * 净化后旧前缀软链 **0** 条，`usr/bin/{vi,editor,pager,nc}` 等 App 绝对链全部保留。
 * 目标路径存在性用 `lstat`（**不跟随**）：链接是树内符号链接时同样算命中，
 * 与 `tar` 归档语义一致。
 */

import { lstatSync, readlinkSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'

/** 构建机 Termux 数据根（旧前缀）。 */
export const OLD_DEVICE_PREFIX = '/data/data/com.termux/files'
/** 本 App 运行时根（快照内 `usr`/`home` 最终落点）。 */
export const APP_DEVICE_PREFIX = '/data/data/com.dsharnessmobile.shell/files'
/** 本 App 的别名写法：Android 上 `/data/user/0/<pkg>` 指向 `/data/data/<pkg>`（多用户时为 /data/user/<n>）。 */
const APP_DEVICE_ALIAS_RE = /^\/data\/user\/\d+\/com\.dsharnessmobile\.shell\//

/** 该绝对目标是否指向本 App（`data/data` 或 `data/user/<n>` 两种写法）。 */
export function isAppAbsoluteTarget(target) {
  return target.startsWith(APP_DEVICE_PREFIX) || APP_DEVICE_ALIAS_RE.test(target)
}

/**
 * 归一化一棵 stage 树里的软链。
 *
 * @param stageRoot - stage 树根（归档时以其为 cwd，含 `usr`/`home`）。
 * @param dirs - 相对 [stageRoot] 的待扫目录（只扫会被归档的子树）。
 * @param opts - `log` 可选日志函数，便于构建链与测试复用。
 * @returns 统计：`{links, rewrote, dropped, keptAppAbsolute, keptOtherAbsolute, droppedSamples}`。
 */
export function sanitizeSymlinks(stageRoot, dirs, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const stats = { links: 0, rewrote: 0, dropped: 0, keptAppAbsolute: 0, keptOtherAbsolute: 0, droppedSamples: [] }

  const visit = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return // 目录不在场（该 ABI 无此子集）：跳过，不阻断构建
    }
    for (const name of names) {
      const full = join(dir, name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue // 竞态/元数据异常：交给后续步骤，不在此处失败
      }
      if (st.isSymbolicLink()) {
        stats.links++
        let target
        try {
          target = readlinkSync(full)
        } catch {
          continue
        }
        if (!target.startsWith('/')) continue
        if (isAppAbsoluteTarget(target)) {
          stats.keptAppAbsolute++
          continue
        }
        const relInTree = target.startsWith(OLD_DEVICE_PREFIX)
          ? target.slice(OLD_DEVICE_PREFIX.length).replace(/^\//, '')
          : null
        if (relInTree === null || relInTree === '') {
          // 非旧前缀、也非本 App 的绝对链：不在本步的处理面内，原样保留（见模块 KDoc 第 4 条）。
          stats.keptOtherAbsolute++
          continue
        }
        const candidate = join(stageRoot, relInTree)
        let candidateExists = false
        try {
          candidateExists = lstatSync(candidate) !== null
        } catch {
          candidateExists = false
        }
        if (candidateExists) {
          const relLink = relative(dirname(full), /** @type {string} */ (candidate))
          rmSync(full, { force: true })
          symlinkSync(relLink, full)
          stats.rewrote++
          log(`    [rel] ${relative(stageRoot, full)} -> ${relLink}`)
        } else {
          if (stats.droppedSamples.length < 5) {
            stats.droppedSamples.push(`${relative(stageRoot, full)} -> ${target}`)
          }
          rmSync(full, { force: true })
          stats.dropped++
        }
      } else if (st.isDirectory()) {
        visit(full)
      }
    }
  }

  for (const d of dirs) visit(join(stageRoot, ...d.split('/').filter((x) => x !== '')))
  return stats
}
