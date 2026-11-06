/** The vendored JavaScript module is validated by importLinuxBootstrap at runtime. */
declare module '@dsh-android/linux-bootstrap' {
  import type { Context } from '@deepseek-ai/cordis'
  export const name: string
  export const inject: string[]
  export function apply(ctx: Context, config?: Record<string, unknown>): unknown
}
