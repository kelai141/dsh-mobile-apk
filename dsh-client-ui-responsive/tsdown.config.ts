import { clientBundle } from './build-scripts/tsdown.client.ts'

// 0.14.8（0.2.1-rc.2）：上游删除 @deepseek-ai/dsh-invariants 与 invariant 子路径约定，
// 本包不再产出 /invariant companion，lib 入口只剩 node 半边。
export default clientBundle('@dsh-android/dsh-client-ui-responsive', ['lib/types/index.js'])

