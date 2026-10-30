// issue #960 文案止损：自定义 provider 卡片的提示。
//
// 守两条：
//  ① 提示**只**在自定义 provider（`llm-pi-ai`）的卡片上出现 —— 靠上游 keyed 槽的 entries key 保证；
//  ② 官方 provider（`llm-deepseek` 等）**不会**拿到本提示 —— 这是用户明确要求的边界。
//
// 为什么用「key 不相等」当官方侧的证据：上游 `settings.models.provider-card` 是 keyed 槽，
// 按 `settingsNs` 分发；我们的注册键是 `llm-pi-ai`，官方卡片的 ns 不同，构造上不会被分发到。
// 这比「渲染后找不到」更本质 —— 后者依赖 DOM 细节，前者是契约。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { CustomProviderHint, CUSTOM_PROVIDER_NS } from '../src/client/models/provider-hint.tsx'
import { zh as hintZh, en as hintEn } from '../src/client/models/provider-hint.locales.ts'

const render = (lang: 'zh' | 'en') => {
  const dict = lang === 'zh' ? hintZh : hintEn
  const t = (key: keyof typeof hintZh) => dict[key]
  return renderToStaticMarkup(<CustomProviderHint t={t} />)
}

describe('自定义 provider 提示（#960 文案止损）', () => {
  it('注册键是**自定义** provider 的命名空间，任何官方 provider 都不会命中', () => {
    expect(CUSTOM_PROVIDER_NS).toBe('llm-pi-ai')
    // 官方 provider 的命名空间（上游 DeepSeekOnboardingDialog 用 llm-deepseek 判定；其余为常见官方族）。
    // 这条就是「官方卡片里出现即红」的**契约级**判据：keyed 槽按 settingsNs 分发，
    // 键一旦改成官方 ns，提示就会出现在官方卡片上 —— 那时本断言先红。
    const OFFICIAL_NAMESPACES = ['llm-deepseek', 'llm-anthropic', 'llm-openai', 'llm-google']
    for (const ns of OFFICIAL_NAMESPACES) {
      expect(CUSTOM_PROVIDER_NS, '注册键不得等于官方 provider 命名空间: ' + ns).not.toBe(ns)
    }
  })

  it('中文提示说明「列表来自内置目录」并指向「添加模型」手动填', () => {
    const html = render('zh')
    expect(html).toContain('data-dsh-custom-provider-hint')
    expect(html).toContain('下面的列表来自内置目录')
    expect(html).toContain('不代表当前端点')
    expect(html).toContain('添加模型')
    expect(html).toContain('手动填入端点返回的模型')
  })

  it('英文提示等价', () => {
    const html = render('en')
    expect(html).toContain('built-in catalog')
    expect(html).toContain('not from this endpoint')
    expect(html).toContain('Add model')
  })

  it('不是错误样式：提示文案里不出现「失败/错误/error/failed」', () => {
    const zhHtml = render('zh')
    const enHtml = render('en')
    for (const bad of ['失败', '错误']) expect(zhHtml).not.toContain(bad)
    for (const bad of ['error', 'failed']) expect(enHtml.toLowerCase()).not.toContain(bad)
  })
})