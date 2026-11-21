/** Status snapshots are parsed JSON, including the optional root maintenance result. */
function sameSnapshot(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return false
  if (Array.isArray(previous) !== Array.isArray(next)) return false
  const fields = Object.entries(previous)
  const nextFields = next as Record<string, unknown>
  return fields.length === Object.keys(nextFields).length &&
    fields.every(([key, value]) => Object.prototype.hasOwnProperty.call(nextFields, key) &&
      sameSnapshot(value, nextFields[key]))
}

export const phoneStateOptions = { managed: true, equal: sameSnapshot }

export function watchPhoneControlPanel(
  panel: HTMLElement,
  refresh: { fast(): void; accessibility(): void; onReturn(): void },
): () => void {
  const fastInterval = 2_000
  const accessibilityInterval = 3_000
  let timer: number | undefined
  let visible = false
  let nextFast = 0
  let nextAccessibility = 0
  let observed = typeof IntersectionObserver !== 'function'

  const tick = (due = 0): void => {
    if (document.visibilityState !== 'visible') {
      update()
      return
    }
    const now = Math.max(due, performance.now())
    if (nextFast <= now) {
      refresh.fast()
      nextFast = now + fastInterval
    }
    if (nextAccessibility <= now) {
      refresh.accessibility()
      nextAccessibility = now + accessibilityInterval
    }
    const next = Math.min(nextFast, nextAccessibility)
    const delay = Math.max(1, Math.ceil(next - Math.max(now, performance.now())))
    timer = window.setTimeout(() => tick(next), delay)
  }

  const update = (force = false): void => {
    const next = observed && document.visibilityState === 'visible'
    if (next === visible && !force) return
    visible = next
    window.clearTimeout(timer)
    if (!visible) return
    refresh.onReturn()
    nextFast = 0
    nextAccessibility = 0
    tick()
  }

  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    observed = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0)
    update()
  }) : undefined
  const onVisibility = (): void => update()
  const onFocus = (): void => update(true)
  observer?.observe(panel)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  update()
  return () => {
    observer?.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    window.clearTimeout(timer)
  }
}
