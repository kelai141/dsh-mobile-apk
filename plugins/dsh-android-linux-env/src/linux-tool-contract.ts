import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

export const HOST_BASH_ENVIRONMENT = 'Execution environment: Android/Termux host, Bionic libc; this is not the Debian Linux shell. Use bash for Android/Termux operations. Use linux_bash or linux_session for Debian apt packages, JDK/Android SDK/Gradle, compilation and APK packaging.'

export const LINUX_TOOL_GUIDANCE = [
  '执行环境契约：bash 是 Android/Termux（Bionic），linux_bash / linux_session 是 Debian/glibc。',
  'Linux 依赖安装、JDK、Android SDK、Gradle、编译和 APK 打包全程使用 Linux 工具；生成 Android 产物不代表应切换到宿主 bash。',
  '工作区和文件编辑工具共享相同绝对路径；/usr、/etc、/var、/root 属于 Debian。',
  'Debian 共享 Android 内核和 /proc；/proc/1/root 或命名空间权限不能用来判断当前工具是否进入 Debian，不要再次嵌套 proot/chroot。',
  'linux_bash 不带 session 时每次创建新 shell，cd/export 不跨调用保留。需要 JAVA_HOME/PATH 等状态时复用同名 session 或使用 linux_session；长构建用 start/poll。',
  'Linux 尚未就绪时先查 linux_environment_status 并等待；报错时在同一环境诊断，不把宿主工具报错当作 Linux 的执行结果。',
].join('\n')

/** The slice of the 0.2.2 systemPrompt service this plugin relies on. */
interface SystemPromptLike {
  assemble(context?: unknown): Promise<PromptAssembly>
}

/**
 * Refine the model wire schema without replacing the host executor or policy.
 *
 * 0.2.2-rc.1 的契约变更（上游把工具声明从 waterfall 里移出去了，不是我们想换写法）：
 *   · system-prompt/assemble 瀑布流的入参与返回都是 PromptPresentation，只有
 *     { sections, contexts, variables } —— 没有 tools；
 *   · 工具声明改由 systemPrompt.tools(provider) 拥有，且 provider 的结果是**追加**
 *     （assemble 内部 collected.push(...schemas) 后按 name 过滤排序，同名不会去重），
 *     所以「再注册一个同名 bash」会得到两条 bash，而不是替换。
 * 因此这里改为包装服务的 assemble()：先让上游装配完，再在返回的 PromptAssembly 上
 * 改写 bash 的 description。语义与旧实现一致（同一个 bash 工具、同一段文本、只改
 * description，不动执行器与策略），但不再依赖瀑布流内部结构。
 */
export function registerLinuxToolContract(ctx: Context) {
  ctx.inject(['systemPrompt'], (scope) => {
    const systemPrompt = scope.get('systemPrompt') as SystemPromptLike | undefined
    if (systemPrompt === undefined || typeof systemPrompt.assemble !== 'function') return
    const original = systemPrompt.assemble.bind(systemPrompt)
    systemPrompt.assemble = async (context?: unknown) => {
      const assembly = await original(context)
      const tools = Array.isArray(assembly?.tools) ? assembly.tools : undefined
      if (tools === undefined) return assembly
      return {
        ...assembly,
        tools: tools.map((tool) => tool.name === 'bash'
          ? { ...tool, description: HOST_BASH_ENVIRONMENT + '\n' + (tool.description ?? '') }
          : tool),
      }
    }
  })
}
