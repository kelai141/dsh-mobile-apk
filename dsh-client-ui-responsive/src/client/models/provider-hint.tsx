// issue #960 文案止损（**不改上游**）。
//
// 现场：设置 → 模型 → 添加模型提供商 → 自定义模型 API 时，「获取可用模型」拉的是**内置目录**
//（193 条无关条目），用户会直接判定「端点不通」而放弃。
//
// 归属已查明：表单在上游 `packages/client/ui-settings-models`（CustomProviderCard.tsx / ProviderEditor.tsx），
// 且上游后端能力是**存在**的（`llm-pi-ai/src/discovery.ts` 已按 `GET {baseURL}/models` 拉）。
// 是 UI 默认取了内置目录 —— 真正的修法在上游，我们这里只做**降低劝退感**的提示。
//
// 挂载点用上游**官方扩展位** `settings.models.provider-card`（keyed slot，
// 声明见 `ui-settings-models/src/client/slot-contract.ts`），按 `settingsNs` 分发：
// 自定义 provider 的命名空间是 `llm-pi-ai`（`CustomProviderCard.tsx:45` 的 `const NS`）。
// 因此本提示**只在自定义 provider 卡片上出现**，官方 provider（如 `llm-deepseek`）不会命中。
import type { ReactElement } from 'react'
// 类型声明：镜像上游 `ui-settings-models/src/client/slot-contract.ts` 的契约。
//
// 为什么不 import 上游那份：本插件**不依赖** `@deepseek-ai/dsh-client-ui-settings-models`（也不该依赖——
// 那会把一个纯 UI 文案提示绑到整个设置页包的版本上）。上游文档明确这类槽由注册方自己声明
//（slot-contract.ts 头注：「a plugin registering an extension already depends on this package for the declaration」），
// 所以这里做同形合并。类型在构建期被擦除，不影响运行期分发。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.models.provider-card': {
      kind: 'keyed'
      scope: 'root'
      owner: { provider: unknown; configured: boolean; keyConfigured: boolean }
    }
  }
}

import { zh, en, NS } from './provider-hint.locales.ts'

/** 自定义 provider 的 settings 命名空间（上游 `CustomProviderCard.tsx` 的 `const NS`）。 */
export const CUSTOM_PROVIDER_NS = 'llm-pi-ai'

export { NS as LOCALE_NS, zh, en }

/** 组件 props：只用到框架注入的 `t`。 */
export interface ProviderHintProps {
  t: (key: 'hint.catalog') => string
}

/**
 * 自定义 provider 卡片上的一行提示：说明列表来源，并指引用「添加模型」手动补。
 *
 * 刻意**不做成错误样式** —— 它不是失败，是「你可能被这份列表误导」。
 */
export function CustomProviderHint(props: ProviderHintProps): ReactElement {
  const t = props.t
  return (
    <div
      data-dsh-custom-provider-hint=''
      style={{
        margin: '8px 0 0',
        padding: '6px 8px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '12px',
        lineHeight: '1.5',
      }}
    >
      <div>{t('hint.catalog')}</div>
    </div>
  )
}