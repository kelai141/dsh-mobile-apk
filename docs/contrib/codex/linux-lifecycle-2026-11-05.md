# Linux 与 DSH 引擎生命周期（2026-11-05）

## 行为

DSH 的父插件先激活；Linux bootstrap 以非阻塞子 fiber 恢复用户先前启用的 Debian。父 apply 不等待子 fiber。`linux_environment_status` 同步读取状态快照，每轮 required context 同样提供状态；未完成时明确告知“Linux 运行时引擎仍在启动”，区分未安装、未启用和真实失败。

`linux-lifecycle.ts` 只在加载 Linux 服务后异步 attach/subscription，不从工具调用或父 apply 等待 bootstrap.ready。安装和恢复不替用户启用一套未选择的系统。

关闭时 `EngineStartFlow` 先持久化 userShutdown，显示 Stopping 并锁定启动按钮。Node 收到 SIGTERM 后停止接受新的 runtime 激活，并等待 `pluginHost.shutdown()` 释放插件、工具、管理器、终端与任务；重复信号不重复执行，8 秒后兜底退出。原生侧给 12 秒宽限，再视实际宿主状态升级为 SIGKILL。旧代际的 PID/starttime/UID 身份在停止前保存，清理不靠进程名或全 UID 扫杀。未知或未退出的已归属进程不能报清理完成，也不能叠加新引擎。

`OwnedEngineStop.kt` 的账本在 spawn 前落盘；下一次启动先结算旧代际。启动流程在实际 spawn 前重新检查 userShutdown，关闭中恢复的激活请求返回 LINUX_ENGINE_STOPPING，bootstrap 不把这类取消写成用户已禁用。Bionilux runtime 的白名单应保留 DSH_ENGINE_INSTANCE，同时仍过滤提供商密钥；该改动在 Bionilux 仓及对应 Release 资产中维护。

## 验证

MuMu `127.0.0.1:16448`，真实 d1/deepseek-v4.1-flash；ADB 真实导航、关闭确认、切后台、force-stop、重新启动；CDP 仅读。

- 模型读取状态工具 ready，自行建立持续 shell、非默认 cwd/变量及后台心跳任务。正常关闭后约 3.804 秒复查，DSH Node 与全部 Linux 进程退出、账本清空；Stopping 和 Closed 两阶段截图均已核对。
- 最终 APK 中后台 force-stop 后约 0.656 秒复查，整个应用及 Linux 进程退出。重开自动恢复相同 Linux 实例；145 个包均为 ii，dpkg audit / -C 无异常，gcc 实编实跑与 zstd 往返通过，637 个原始源码未变，原 4 MB 归档 SHA256 一致。
- 再次在新引擎进程出现、HTTP 未就绪时 force-stop；重新打开后状态接口 200、installed/enabled/activated=true、busy=false，页面恢复。两类强杀后系统信息、dpkg status、原归档摘要均不变，无手工修复或重装。实际 18793 下载服务器请求数保持此前 10 条，本轮没有下载。
- 最终 APK SHA256：b2ba3ee8d80bfe4bc6dabd5eb692e0cd320d9f2b2ed550f6bf053958466e182f；207354337 字节。快照 SHA256：37fe2e297d55142a95222526f3da17b589d6a905d12fc898b44ee1e978ae082b。v1/v2/v3 签名有效。两 profile 中相关插件 42 个文件与构建产物逐字节一致。
- JVM：停止策略 18、Guide 27+3，全通过。Debian 内宿主插件 69、bootstrap 15 全通过；runtime 聚焦 61 通过、1 条件跳过，marker/secret 回归另外通过。执行地图、鉴权、vendor 和维护文档检查通过。

完整证据与报告保存在 Bionilux 独立工作树的 `target/independent-linux/` 及 `docs/ENGINE_LINUX_LIFECYCLE_ACCEPTANCE.md`。正常关闭轮次先验证同策略前一包，最终包清理无用辅助接口后重跑单测，实际验证两类强杀恢复。

## 范围

这里管理应用内 Debian 用户空间及其进程，不负责关闭 MuMu 虚拟机。强杀结束内存变量和当前命令；文件系统和已安装软件保留，重启创建新 shell。本次复用用户已有 0.5.0 runtime 与 rootfs，新的 runtime marker 白名单以 Bionilux 源码/资产及 Debian 回归验证，未热推替换旧安装。正式 Release 尚未发布，自包含 APK 缺少上游 checkout 的发布门禁仍为 SKIP。

普通 Linux 主机的全量进程夹具在嵌套 Bionilux 虚拟路径下不适用，此处不宣称该全量集通过；包数据库校验也不是 debsums 全文件检查。未测试 apt/dpkg 正安装时强杀或设备断电，不能据此承诺任何时刻绝无损坏。
