# Linux 工具环境契约（2026-11-05）

真实 d1/deepseek-v4.1-flash 在 MuMu 构建 APK 时误将宿主 bash 的失败归因到 Debian，导致尝试不必要的 proot/chroot。修复在宿主插件完成：`linux-tool-contract.ts` 经 system-prompt/assemble 补齐模型收到的 bash 定义，required context 每轮明确 Android/Termux 与 Debian、共享工作区、共享内核/proc、启动等待、一次性和持续 shell 的区别。不会替换 bash 执行器或改变权限。

真实 ToolRuntime/SystemPrompt 集成测试验证模型输入含正确描述、连续 assemble 不累积前缀、原执行器不变、未安装时仍有状态与环境提示。Debian 内宿主插件 69 项全通过；执行地图检查通过。新 APK 两个 profile 的 28 个宿主 lib 文件与本地构建逐字节一致；安装到 MuMu，完整运行验证记录见 Bionilux 仓 `docs/AGENT_APK_BUILD_ACCEPTANCE.md` 和 `target/independent-linux/`。

独立的 Java alternatives/$ORIGIN 缺陷修于 Bionilux 加载器，Debian 单测 78 项通过，MuMu 对照 java/javac 从返回 127 到返回 0；对应下载资产已本地重建，尚未发布远端 Release。计数 APK 由机内模型编译并重复重放，宿主仅验包和装机，增量、清零、强杀重开保留均实测通过。首轮包含一次环境纠偏，不能声称零纠偏成功。

本地壳包采用 DEV-FAST 构建，只作设备验证，不作为正式发布产物。

修复后新建会话 `ae935925-3925-4e5e-a80a-be968c840d12`，只给重放构建目标，不提示工具名、不再纠偏。模型自行调用 linux_bash 检查未设置 JAVA_HOME/LD_LIBRARY_PATH/CLASSPATH 的默认 java/javac，均成功；再用 linux_session start/poll 从源码完成构建，退出 0，APK 摘要仍为 `b09ebe5a8597fbcf87db81b1f43ac6e768661985f6300fc511ff0f4e9780633f`。没有复现首轮混用宿主编译或嵌套 proot/chroot 的行为。
