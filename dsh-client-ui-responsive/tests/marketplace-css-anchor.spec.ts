// 插件市场样式表的版本锚。
//
// 背景（review 备记）：MARKETPLACE_CSS 的每条覆盖都依赖上游插件当前的 DOM 结构与 dshm-*
// 类名；上游换主题或改结构时这些规则会静默失效（界面悄悄回到纸色主题，没有任何信号）。
// 这里把「对标版本」写成常量，并与仓库内 vendor/dshmarketplace-plugin 的实际版本比对，
// 版本一涨就判红——提醒重新核对整张样式表，而不是等用户反馈。
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { MARKETPLACE_UPSTREAM_VERSION } from '../src/client/marketplace/marketplace.css.ts'

describe('插件市场样式表的版本锚', () => {
  it('常量与 vendor 内实际插件版本一致', () => {
    // vitest 的 cwd 是本包目录：vendor 在仓库根，即 ../vendor；单包独立检出时也可能在 ./vendor。
    const candidates = ['../vendor/dshmarketplace-plugin/package.json', 'vendor/dshmarketplace-plugin/package.json']
    const path = candidates.find((p) => existsSync(p))
    expect(path, '找不到 vendor/dshmarketplace-plugin/package.json（本测试需要仓库根的 vendor 目录）').toBeTruthy()
    const pkg = JSON.parse(readFileSync(path!, 'utf8')) as { version?: string }
    expect(pkg.version, 'vendor 里的插件必须有 version 字段').toBeTruthy()
    expect(MARKETPLACE_UPSTREAM_VERSION, '上游插件版本变了：请核对 MARKETPLACE_CSS 的每条 dshm-* 覆盖').toBe(pkg.version)
  })
})
