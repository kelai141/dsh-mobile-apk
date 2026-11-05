/**
 * 上游 Switch 的测试适配器。
 *
 * 2026-10-24 起，通知 / 手机控制 / 开发者选项的开关换成上游 `Switch`
 * （`<button role="switch" aria-checked>`），不再是 `<input type=checkbox>`。
 * 各 spec 里大量断言用的是 `.checked` / `.disabled` / `.click()`，这里用一个 Proxy
 * 把按钮包装成旧的 input 形状，调用点无需改写，也不必在每处手写 aria-checked 比较。
 */
export function toggleOf(el: ParentNode, label: string): HTMLInputElement {
  const button = el.querySelector(`button[role="switch"][aria-label="${label}"]`) as HTMLButtonElement | null
  if (button === null) throw new Error('找不到开关：' + label)
  return new Proxy(button, {
    get(target, prop) {
      if (prop === 'checked') return target.getAttribute('aria-checked') === 'true'
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as HTMLInputElement
}
