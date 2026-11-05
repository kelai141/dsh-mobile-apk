// issue #960 文案止损：自定义模型提供商卡片的提示文案。
export const NS = 'android-custom-provider-hint'

export const zh = {
  'hint.catalog': '下面的列表来自内置目录，不代表当前端点；请用“添加模型”手动填入端点返回的模型。',

}

export const en = {
  'hint.catalog': 'The list below comes from the built-in catalog, not from this endpoint; use "Add model" to enter the models your endpoint actually returns.',

}

export type ProviderHintKey = keyof typeof zh
// issue #979：命名空间必须登记进 LocaleNamespaceMap，`locale.register(ns, { zh, en })` 的**有类型**
// 重载才接受它（未登记 ⇒ error TS2345: Argument of type '"android-custom-provider-hint"' is not
// assignable to parameter of type 'keyof LocaleNamespaceMap'）。绕开只能写 `as never`，那会把
// 「中英两份必须齐备」这条编译期检查一并放弃。写法同 mobile/file-card-capsule.locales.ts：
// 声明与字典同文件，键集由字典推导。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'android-custom-provider-hint': ProviderHintKey }
}
