// The browser platform supplies ReactDOM for synchronous dispatch and overlay rendering.
declare module 'react-dom' {
  export function flushSync<T>(callback: () => T): T
  export function createPortal(children: import('react').ReactNode, container: Element): import('react').ReactPortal
}
