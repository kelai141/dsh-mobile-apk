/**
 * 安卓调试授权设置块（browser half，PRD F1.7 设置页闭环，2026-08-23）：
 * 注册进「开发者选项」分区的子槽 `settings.dev.item`（DevSection 声明，见
 * dsh-client-ui-responsive）——不占独立导航行；块内提供：
 *  - 三道人门状态视图（档位 + 完全访问 / 无线调试 / 允许开关 / 配对）
 *  - 完全访问档位引导（按钮跳系统授权）
 *  - 应用内「允许访问」开关（危险明示 + 二次确认，默认关闭）
 *  - 配对码输入（六位，码值不入审计/日志）与回收配对
 *
 * 数据面：状态经只读 GET /api/android/privilege/status（宿主导读壳侧 SharedPreferences）；
 * 授权变更（setAdbAllow/setAdbPair/revokeAdbPair）唯一经壳侧原生 AdbState（window.androidBridge）
 * ——被提权方不得自改授权（Shizuku 对照）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { AdbAuthSection } from './AdbAuthSection.tsx'
import { ADB_AUTH_CSS } from './adb-auth.css.ts'

// 声明与本槽 owner（ui-responsive SlotMap augmentation）一致的成员——interface 合并允许
// 相同签名的重复声明，桥侧因此可以强类型注册 'settings.dev.item'。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.dev.item': { kind: 'list'; scope: 'root' }
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots'] as const

/**
 * Client plugin body: inject the block stylesheet once, then register the ADB
 * authorization block into the developer-options child seat (deferred until
 * DevSection declares the slot).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'adb-auth')
    style.textContent = ADB_AUTH_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'adb-auth: section styles')

  ctx.slots.inject('settings.dev.item', () => ctx.slots.register({
    name: 'settings.dev.item',
    id: 'android-adb',
    order: 0,
    label: () => '安卓调试授权',
    // list entry 的 props 由 inject 提供（本块不用 owner share → 空对象）
    inject: () => ({}),
  }, AdbAuthSection))
}
