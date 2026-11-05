/**
 * 「插件」页 →「添加插件」下拉里的「插件市场」入口。
 *
 * 用户定例（0.15.0）：市场是**完整的、可返回上级的整页**，入口只保留在「添加插件」下拉里，
 * 原来「插件」页里的市场 Tab 入口舍去。
 *
 * 走法：市场插件自己监听 `command/executed` 的 `store` 回执并打开它的浮层
 * （与 `/store` 命令同一条路）；该浮层已由补丁 `market-J-fullpage` 改成整页——
 * 拉满屏幕、面板内自带「‹ 返回」页头，返回即关闭浮层回到「插件」页。
 *
 * 为什么不做「跳设置分区」：截图诊断确认「插件」页不在设置对话框内，DOM 里没有设置导航
 * （`[data-dsh-settings-dialog]` 缺席），从这一页切设置分区没有可用通道。
 */
import { IconBrowseOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { tr } from '../i18n.ts'

/** 发 `store` 命令回执，市场插件据此打开整页；成功派发返回 true。 */
export function openMarketplaceDialog(ctx: unknown): boolean {
  const emit = (ctx as { emit?: (...args: unknown[]) => void } | undefined)?.emit
  if (typeof emit !== 'function') return false
  try {
    // 事件签名与 dsh-client-ui-commands 一致：(sessionId, name, result)。
    // 市场侧只读 name/result，sessionId 传 null 即可。
    emit.call(ctx, 'command/executed', null, 'store', { kind: 'success', query: '' })
    return true
  } catch {
    return false
  }
}

export interface MarketplaceMenuItemProps {
  /** 菜单项渲染时由插件管理器传入，点选后先收起菜单。 */
  onDismiss?: () => void
  ctx?: unknown
}

export function MarketplaceMenuItem({ onDismiss, ctx }: MarketplaceMenuItemProps) {
  return (
    <MenuItemButton
      icon={<IconBrowseOutlineRegular size={16} />}
      onSelect={() => {
        onDismiss?.()
        // 直接打开整页：不再先找导航行（那要先等 6×120ms 才回退，表现为明显延迟）。
        openMarketplaceDialog(ctx)
      }}
    >
      <span className="dsh-market-item">
        <span>{tr('插件市场', 'Plugin store')}</span>
        <span className="dsh-market-item-desc">
          {tr('浏览社区插件，按移动端兼容性筛选', 'Browse community plugins, filtered by mobile compatibility')}
        </span>
      </span>
    </MenuItemButton>
  )
}

/**
 * 把「插件市场」注册进「添加插件」下拉。
 *
 * 插槽名 `plugins.add.actions` 由 dsh-client-ui-plugin-manager 在运行时渲染
 * （它的 `renderSlot("plugins.add.actions", { onDismiss })`），但本包依赖的
 * slots 类型版本尚未收录该名字，故这里按运行时形状断言一次，不引入 any。
 */
export function registerMarketplaceAction(slots: unknown, ctx?: unknown): () => void {
  const registry = slots as {
    inject: (name: string, factory: () => unknown) => () => void
    register: (definition: Record<string, unknown>, component: unknown) => unknown
  }
  return registry.inject('plugins.add.actions', () => registry.register({
    name: 'plugins.add.actions',
    id: 'android-marketplace',
    order: 30,
    inject: () => ({ ctx }),
  }, MarketplaceMenuItem))
}
