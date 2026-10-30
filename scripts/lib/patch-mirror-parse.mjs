// check-patch-mirror.mjs 的两个判定原语（2026-10-28 抽出并补自测）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 比较两个文件的字节：same = 原始字节一致；eol = 仅行尾差异；content = 归一后仍不同。
 *
 * 抽出来的理由：它决定「这份镜像到底算不算漂移」——`eol` 只告警、`content` 判红，
 * 分界线错了要么放过真漂移、要么被 autocrlf 噪声刷红。原本嵌在顶层直跑的脚本里，无法单测。
 */
export function compareBytes(a, b) {
  const ba = readFileSync(a)
  const bb = readFileSync(b)
  if (ba.equals(bb)) return 'same'
  const norm = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
  return norm(ba).equals(norm(bb)) ? 'eol' : 'content'
}

/**
 * 某镜像面相对路径是否被本仓 `.gitignore` 忽略。
 *
 * **注意它的真实能力边界**（2026-10-28 复核）：只认「单段目录形态」的规则（`/name/`、`/name`、`name/`），
 * 通配与多段规则（`plugins/* /lib/`、`build/` 之外的 `a/b/`）一律不认；而调用方传入的
 * `MIRROR_TOP` 条目**全是多段路径**（`scripts/build-apk-013.ps1` 之类），因此本函数对它
 * **恒返回 false**。这不是 bug 而是刻意 fail-closed：认不出来就照旧判红，绝不因「以为它被忽略」而放过真漂移。
 * 保留它的意义只在单段目录场景；改它之前先确认调用方是否已换成多段路径。
 */
export function ignoredByGitignore(root, rel) {
  const gitignore = join(root, '.gitignore')
  if (!existsSync(gitignore)) return false
  const target = rel.replace(/\\/g, '/').replace(/\/+$/, '')
  for (const rawLine of readFileSync(gitignore, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^\/?([A-Za-z0-9._-]+)\/?$/.exec(line)
    if (m === null) continue
    if (m[1] === target) return true
  }
  return false
}
