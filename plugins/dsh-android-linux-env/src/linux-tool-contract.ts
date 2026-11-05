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

/** Refine the model wire schema without replacing the host executor or policy. */
export function registerLinuxToolContract(ctx: Context) {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next): Promise<PromptAssembly> => {
    const assembly = await next()
    return { ...assembly, tools: assembly.tools.map(tool => tool.name === 'bash'
      ? { ...tool, description: HOST_BASH_ENVIRONMENT + '\n' + (tool.description ?? '') }
      : tool) }
  })
}
