# gotchas.md — 关键实现细节与坑（全量）

> grep 用法：`grep -n "<坑号>\." docs/AGENTS/gotchas.md` 或按关键词（如 `borrowSession`、`MANAGE_EXTERNAL_STORAGE`、`store-rehome`）定位。
> 维护约定：新坑追加到文末并递增编号；修复后保留条目（教训与历史归档）。

## 6. 关键实现细节与坑（每次踩坑必须登记）

1. **realpath 前缀混用（B7 运行时表现，已修）**：Android 上 `/data/user/0` 可能是 `/data/data` 的软链——只把「文件侧」realpath 后再与未 realpath 的 ws 比较必拒。修复：`safeResolveInside` **两侧都 realpath**（ws 侧失败按原样参与），symlink 目标按 `dirname(rel)` 解析（`../../LICENSES` 从 `doc/<pkg>/` 出发 = `share/LICENSES`）。**新路径校验代码一律双侧规范化。**
2. **会话 header meta 白名单**：`Session.create(meta)` 的 `origin` 只允许 `"subagent"`——自定义值报 `session header origin must be "subagent"`；只写白名单键（如 `cwd`）。
3. **surface 事件必须带 surfaceOp**：`user/message` 等 surface-eligible 事件 append 需第 3 参 `{surfaceOp:'append'}`，否则 `requires a surfaceOp marker`。
4. **pnpm 是市场安装的硬依赖（已固化进快照构建）**：`dsh plugin add` spawns `pnpm`（apps/cli plugin.ts）；快照缺 pnpm → `pnpm not found on PATH`；且**陈旧 pnpm 状态记录**（base-dsh 里的 `.modules.yaml`/`.pnpm-workspace-state`/`pnpm-lock`）指向旧 store → `ERR_PNPM_UNEXPECTED_STORE`——build-snapshot-013.mjs 已装配 pnpm 10.12.1 standalone（npm tgz + `usr/bin/pnpm` shim）并清理这三种记录。**市场目录里的部分插件（如 humanizer-ru）不在 npm，安装 404 属上游目录数据，不是本链路缺陷。**
5. **快照 node 需要 OPENSSL_CONF**：运行快照内 node 时务必与 UndoGate 同样注入（否则 OpenSSL config error 静默吞 CLI 输出）。
6. **Windows 侧读 WSL 9p 文件 = EACCES**：stage 文件不可直 stat/read；校验类代码走 `--tar`（wsl tar -tvf 带大小）视图；wsl.exe 输出前有 localhost 代理噪音行，解析时过滤。
7. **npm registry 元数据可能缺 dist.sha512**：pnpm tgz 完整性校验「在场则严格，缺席降级警告」。
8. **run-as 引号地狱 / adb 二进制传输**：PowerShell 双引号内 `$var` 本地展开；二进制经 `adb exec-out`/push 传输。
9. **template 字符串反斜杠**（页面注入）：`\n` 双写。
10. **签名一致性**：debug.keystore 固定，否则覆盖安装失败。
11. **CDP 断言注意**：input placeholder 不在 innerText（查 `[placeholder]`）；「live 会话禁止 API prompt」；`session.list` 的 stats 字段（turns/llmMs）判断代理是否真跑。
12. **引擎级 OPENSSL_CONF 曾有缺口（2026-08-24 真机实锤，已修）**：快照 node 编译期硬编码 OpenSSL 配置路径 `/data/data/com.termux/files/usr/etc/tls/openssl.cnf`（app 域不可读）——`shellEnv()` 未注入 OPENSSL_CONF 时，**任何 node/npm 子进程（agent 工具调用）启动即 OpenSSL configuration error 退出**；引擎本体侥幸存活（不触发该初始化的路径）。修复 = `shellEnv()` 加 `OPENSSL_CONF=<usr>/etc/tls/openssl.cnf`（与 UndoGate/AdbState 统一；坑 #5 是本坑在 CLI 面的显式版）。
13. **apt/dpkg 编译期路径（issue #80，2026-08-24 重写）**：apt/apt-get/dpkg 二进制内置 `/data/data/com.termux/files/usr` 编译期路径。`-o Dir::Etc=...` 参数覆盖不了 apt.conf.d 早期扫描（仍报 Permission denied）；**有效方案 = APT_CONFIG 主文件**（build-snapshot-013.mjs 7d 段生成 `usr/etc/apt/apt.conf`，wrapper 统一 `export APT_CONFIG`）——注意 `K='...$B...'` 单引号不展开曾令 wrapper 失效。**dpkg 的 SYSCONFDIR（dpkg.cfg.d 配置目录）无 env 可覆盖**（strings 证实无 DPKG_CONFIG_DIR 变量；`--admindir/--instdir` 不覆盖）→ apt 在线安装 dpkg 阶段受限；`scripts/check-prefix-residue.sh` 设备端自检验证。
14. **配对伪成功防御（2026-08-24 真机实锤）**：`nativeBridge()?.setAdbPair?.()` 可选链在桥缺失/方法缺失时返回 undefined → `ok === false` 恒 false → 前端误报「配对完成」——**显式检查 `typeof b.setAdbPair === 'function'` 且无函数即 throw**。设置页两端口输入框是必经项，用户嫌手动抄录——0.13.0 起端口发现用 **NSD/mDNS**（AdbState.discoverPorts：系统属性直读优先 → `_adb-tls-pairing._tcp`/`_adb-tls-connect._tcp` NSD 发现（5s 超时）→ 手动输入硬回退；盲扫 37000-45999 已剔除，Q17）。
15. **临时工作区面板不可见（issue #60，2026-08-24 已修）**：workspace registry 只从**既有会话 cwd** bootstrap——无会话时「临时工作区」不出现在工作区面板。修复：dsh-android-file-open apply 时 `workspaceRegistry.create(tmpWorkspace(), '临时工作区')`（幂等复用）。TTL 清理（7 天）壳侧 FileIncoming.sweepExpired（启动 + 每次入队前）。
16. **老内核 ES2022 polyfill（issue apk#81/#79）**：华为/荣耀/小米定制 WebView（Chromium<92）缺 `Object.hasOwn`/`Array.at`/`String.at` → 前端加载插件报 "Failed to load plugins"。polyfill 注入点 = `assets/patched/web-frontend-index.html` `<head>` 首个 script 之前（引擎 applyAssetPatch 用它替换内核 index.html）；**升级 dsh 后其模块脚本哈希（index-ClqxG24t.js）须同步更新**。
17. **错位目录（issue #80 P5）**：relocate-snapshot 曾把包内绝对路径 `/data/data/com.termux` 当相对路径搬进 usr 树（`usr/data/data/...`）——纯冗余；构建链 7e 无条件删除 `usr/data`。
18. **debug APK 默认 x86_64 快照（2026-08-24 本日重大事故）**：`app/build.gradle.kts` mergeDebugAssets 注释写死「从 GitHub Releases 下载 snapshot-x86_64.tar.xz 放 assets」→ `app-debug.apk` 内快照是 x86_64；**装到 arm64 真机覆盖终版后引擎崩**：`error: "/data/data/.../usr/bin/node" is for EM_X86_64 (62) instead of EM_AARCH64 (183)`。核对方法：解快照 tar 读 `usr/bin/node` 的 ELF e_machine（62=x86_64，183=arm64），或 `aapt dump badging <apk>` 看 native-code。修复/预防：构建/安装前核对设备 ABI 与快照 ABI；换 arm64 快照须**同时替换** `assets/snapshot.tar.xz` + `snapshot.sha256`（指纹变→refreshSnapshot 全量重解压 2-4 分钟，勿中断）。
19. **cordis.patch.yml 装配缺陷**：基座 cordis.patch.yml 只含 shell-termux/host-web-compat/ui-responsive——0.13.0 新增的 android-bridge/android-manage/android-linux-env/android-file-open/undo-savepoint/marketplace **从不进入快照装配** → 引擎不加载这些插件（`/api/android/file-incoming` 404、ADB 设置项缺失、通知事件桥无宿主）。修复：build-snapshot-013.mjs 7b2 用 `scripts/profile-web.cordis.patch.yml` **权威覆盖**快照内同名文件（缺失即 `process.exit` 拒发）。**注意**：真机热改 cordis.patch.yml 后必须**冷启动 app**（`am force-stop` + start）才重装配——watchdog 热重启引擎不重读 profile（只重跑 node）。
20. **EngineService 挂载缺失**：startEngineService 只在 startEngineFlow 首次轮询成功时调用——**引擎先跑、app 后启动（热启动/恢复）时服务从未启动 → watchdog 缺失 → 通知消费（task-done 标记）/自动回退/唤醒锁全链路失效**。修复：MainActivity `onResume` 幂等 `startEngineService()`。
21. **通知链路三缺（2026-08-24 用户实测「任务完成没通知」根因）**：① 引擎事件桥缺失（前端 showNotification 桥无调用方，F0.3 部分实现=以前未做）——补：dsh-android-bridge 监听 `ctx.on('session/event')` 捕获 `assistant/message` → 写 `files/home/.dsh/.task-done.ndjson` 标记；② WatchdogV2.consumeTaskDoneMarkers 消费标记 → `NotifyCenter.notify`（deepProbe 成功路径顺带；JSON 解析失败会丢通知——务必确保标记是 `JSON.stringify` 合法 JSON）；③ EngineService 必须挂载（见坑 20）。验证：`files/notify-debug.log` 落盘每步（诊断时开）；通知 id=`("dsh-"+category).hashCode() and 0x7fffffff` 稳定正数。
22. **免 hooks 环境 ELF 不可执行**：`adb shell run-as ... /usr/bin/<bin> | head` 会报 `not executable: 64-bit ELF file` / `CANNOT LINK ... library libandroid-support.so not found`——因为 run-as 裸环境无 termux-exec LD_PRELOAD 钩子与 LD_LIBRARY_PATH。**验证快照内二进制必须带全套引擎 env**（`LD_PRELOAD=libtermux-exec-ld-preload.so` + `TERMUX_EXEC__*` + `LD_LIBRARY_PATH` + `OPENSSL_CONF`）。这是「run-as 测出假错误」的常见来源（如 node/npm/adb）。
23. **通知 debug 落盘**：WatchdogV2.consumeTaskDoneMarkers 写了 `files/notify-debug.log`（诊断用，**保留**——是排查通知链路的关键工具）。
24. **adb client 冷启动 server 必败（2026-08-27 真机实锤，已修）**：termux-exec/Linker64 重路由环境下，`adb pair` 首次调用自动起 server（fork-server）时握手坏——client 打印 "* daemon started successfully" 后读不到应答，报 `error: protocol fault (couldn't read status message)`，**配对必失败（用户侧观感"光速报错"）**。对照实验证明：client 直连**已存在**的 server（`adb server nodaemon` 常驻）时 pair/connect 全部正常（同码同端口复刻 2/2 成功）。修复 = AdbState 壳内自管常驻 server（runAdb 前 `ensureAdbServer`：spawn `server nodaemon` + 5037 探测 + 日志落 `files/home/adb-server.log`）+ `retryRunAdb`（protocol fault 时毁 server 重建重试一次）；pair 失败首行错误文本入审计（不含码）。另：discoverPorts 同步 NSD 等待 5s 会卡配对页 UI（bridge 同步调用链）——超时压到 2s + 启动后台预取 + 15s TTL 缓存（`cachedPorts`），bridge 缓存优先。**补锤**：app 域直接 exec app-data ELF 恒 EACCES（error=13，server/client 双双中招，审计 error 字段实锤），spawn 一律走 `spawnAdb`（捕获 Permission denied 降级 `/system/bin/linker64` 加载——EngineManager.startWithArgs 同机制）。
25. **配对码窗口被自家冷启动链耗光（2026-08-27 复盘实锤，三探针 logcat/audit/adb-server 时间线定案，已修 F1+F2+F3+F4）**：系统「使用配对码配对」弹窗的端口仅在弹窗存活期监听；用户点「配对」后壳侧才冷启动（linker64 加载 ~3s + 回收配对后密钥删除触发全新 RSA keygen + 首轮 client 握手竞态必吃 protocol fault 再自愈重建），合计 7 秒以上，拨号时窗口已关 → 恒 `Connection refused`（pairing_client.cpp），用户在系统弹窗上点什么都不救得回来。修复四件套 = **F1 常驻预热**（`AdbState.prewarm`：getAdbState 轮询钩子/onResume 后台线程拉起，60s 节流；**密钥生成移出关键路径**——回收配对会删 `$HOME/.android/adbkey*`，下次任何连接都会重新生成）+ **F2 真实就绪判定**（5037 bind ≠ 可服务：`ensureAdbServer` 放行条件收紧为一次真实 `devices` 客户端往返通过，`serverReady` 标志贯穿 spawn/复用孤儿/self-heal 三路径）+ **F3 结构化配对结果**（`setAdbPair` 返回 JSON `{ok, reason, message}` 替代 Boolean，壳侧 `classifyFailure` 归因 window-closed/protocol-fault/server-not-ready/handshake-timeout 等）+ **F4 前端分流**（AdbAuthSection 轮询不再抹操作报错——双通道 pollError/actionError 且后者留存 15s；失败不清空输入框；文案按 reason 分流，refused 明示「窗口已关闭请重开弹窗」而非误导性「核对 6 位码」）。
26. **vivo SELinux 拒读无线调试属性（2026-08-27 logcat 实锤）**：untrusted_app 读 `service.adb.tls.pairing_port` / `service.adb.tls.port` 触发 `avc denied { read } adbd_prop`——AdbState.discoverPorts 的「系统属性直读」优先路径在 vivo OriginOS 上恒失效（异常路径静默吞掉无感知），实际全靠 NSD/mDNS 兜底。勿据此属性在 vivo 上做正确性假设；后续若在此设备上看到直读成功属 ROM 变更，需回归。
27. **引擎侧页面误调 openNativePath（2026-08-27 记录在案）**：logcat 出现 `dsh-image: openNativePath: not exists: 自动扫描系统无线调试的配对/连接端口…`——引擎 UI 包把按钮 title 文案当路径传给了桥调用。壳侧安全拒绝 no-op 无实害；根因在上游引擎页面包（非本仓库管辖），升级引擎时留意。
28. **dsh-shell run() 返回 CollectedOutput 结构体（2026-08-27 活体插桩实锤，已修）**：`shellFace.run()` 契约返回 `{stdout:{text,truncated,spillPath?}, stderr:{…}, exitCode,…}` 而非字符串（引擎内置 bash 工具经 `streamText(output).text` 同款读取）。插件历史代码 `String(r.stdout)` 直取 → 恒 `"​[object Object]"`：**进程真实执行（审计恒 ok）、模型转录全毁**，并连带 device_info 满屏 `?` 占位（拿乱码 grep MODEL= 零匹配）与 lossless 拒收（可选字段 undefined 成员被引擎整值拒绝）。修复 = `collectText()` 解包 + `pickText()` 类型闸 render（非 string 一律 JSON 转写，杜绝 [object Object] 再入转录）+ 可选成员空串兜底。**伴生雷**：NSD 抓的连接端口随无线调试重启轮换（37575 失联实锤）→ `resolveLivePort()` 配置端口失效即回退 5555。**排障方法论沉淀**：①疑似「改码不改行为」先杀引擎进程再验——`force-stop` 后可能有孤儿 `node -`（linker64 链）幸存占 5037/3080 继续用旧模块（/proc 扫 cmdline 对照注入 mtime）；②设备端插件注入用 base64 分块 `printf %s >> ` 通道（MSYS /tmp 不跨执行块存活，stdin 管道会截断）；③插桩指纹（状态消息缀 ⟪标记⟫）一次往返即可判定加载版本。
29. **引擎会话档位为事件溯源、按会话隔离（2026-08-27 澄清，非缺陷）**：UI 档位选择器写入会话日志 `sandbox/mode` 事件（`effectiveSandboxMode` fold，最后一条生效），重启经重放恢复、两会话互不可见；`session.list` projections.permissions.currentValue 为真值。状态端点显示的 `writeMode=workspace-write` 仅部署默认（装配 yml shell-termux config），工具实际放行以会话档位为准（gateFor→sandboxPolicy.resolve）。勿把部署默认当死锁。
30. **ps1 双 ABI 循环后 assets 停留 x86_64（2026-08-29 实锤，坑 18 现代版）**：build-apk-013.ps1 循环内按 ABI 覆盖 `assets/snapshot.tar.xz`，循环结束留在 x86_64——此后直接 `gradlew assembleDebug` 的 debug 包即 x86 树，装 arm64 真机报 EM_X86_64（本轮已踩）。铁律：真机安装只用 ps1 对应 ABI 命名产物；存疑时 `od -A d -j 18 -N 2 -t u1` 读 node ELF 机器码（183=arm64/62=x86_64）。
31. **force-stop 杀不死 linker64 回退子进程（2026-08-29 vivo 实锤，0.14 修复）**：升级后旧引擎孤儿存活 → 双引擎抢 3080（探活打到旧引擎、新引擎 bind 失败循环；两代 engine.log 交错误导排障）。真机找引擎 `ps -A | grep linker64`（进程名非 node，pidof node 必空）；处置：run-as kill 全部 linker64 → 看门狗 ~7s 自愈。`pkill -f bin.js` 在 vivo 疑似不生效（坑 28 排障方法论①的 /proc cmdline 扫描为可靠手段）。
32. **adb forward 静默失效（2026-08-29 实锤）**：APK 重装/USB 重枚举后宿主 forward 清空 → 宿主探活 000，但设备内正常（用户 WebView 秒起）——「引擎挂了」的判断必须先 `adb forward --list` 再重 forward，否则误诊。
33. **系统 HTTP 代理劫持壳侧本地探针（#118 根因1，2026-09-02 实锤）**：WiFi 配置系统代理时，`HttpURLConnection.openConnection()` 默认走 `ProxySelector` 下发的系统代理 → 把 `127.0.0.1:3080` 的本地请求发给代理网关（回不来本机）→ 探针恒 timeout；而 WebView（Chromium 对 loopback 豁免代理）与 curl（不读系统代理）直连正常 → 「网页能开、app 却判引擎没起来」的矛盾现场。修复 = **壳侧所有本地引擎端口调用一律 `openConnection(Proxy.NO_PROXY)`**（EngineProbe / file-incoming / session.export / session.cancel；UpdateManager 的远程下载**不走** NO_PROXY），且诊断包 probe 字段区分 timeout/refused。
34. **UndoGate.runCli 直接 exec app-data ELF 无 linker64 fallback（#118 根因2，2026-09-02 修）**：`runCli` 直接 `ProcessBuilder` exec `usr/bin/node`（对比 `EngineManager.startWithArgs` 有 `/system/bin/linker64` fallback）——Android 15+ 拒绝直接 exec app-data ELF → error=13 → auto-undo 从未真正执行。修复 = 与 startWithArgs 同款：捕获「Permission denied」降级 `linker64` 加载（`build` 复用 shellEnv/OPENSSL_CONF/redirectErrorStream）。
35. **requestLegacyExternalStorage 对 targetSdk≥30 应用无效（#120/MT 调研，2026-09-02 实锤）**：该 flag 仅对「targetSdk≤29 + 运行在 Android 10」生效；targetSdk≥30（含 34）应用即使运行在 Android 10 设备上 flag 也被忽略（SO 63365334 / cgeo #10386 / 小米适配指南多源实锤）→ Android 10 上 SAF 树授权不解锁 FUSE 原始路径、bash 走不了 ContentResolver → 非 root 下「读用户任意目录作工作区」不可达成。落地：SDK 26-28（无分区存储）运行时 READ/WRITE 权限放行；SDK 29 保留拒绝但显式 reason（`__dsh_pick_refused__:android-10`）而非伪装取消；SDK 30+ 维持 All Files Access。
36. **自包含内置子仓副本必须与协调仓同版（2026-09-02 实锤）**：本仓库是**云端自包含构建宿主**（`.github/workflows/build-apk.yml` 依赖 `$GITHUB_WORKSPACE`=本仓库，不签协调私库），仓库内自带整套子仓副本（`dsh-shell-termux`、`dsh-client-ui-responsive`、`dsh-host-web-compat`、`plugins/dsh-android-*`）。**协调仓改动这些子仓的源码或 bump 版本后，必须把产物同步进本仓库对应子目录（src + package.json + lib/），否则自包含链（云端构建 + `gradlew assembleDebug` 直打）注入的是旧副本**——设备上表现「悬浮球开关消失 / ADB 面板缺失 / #120 拒绝信号缺席 / 配置导入导出按钮消失」这类**功能性缺失但编译通过**的幽灵缺陷。0.13.2 实测：协调仓 ui-responsive 0.1.11 含悬浮球开关、apk 仓副本 0.1.9 无它（DevSection 少了 W7 悬浮球开关行 + 配置导入导出块）；host-web-compat 0.1.8 vs 0.1.6（#120 拒绝信号缺席）。**教训：凡协调仓动了这三个独立子仓/bridge/manage，发布前必须比对两个仓库的 package.json version + 抽验 apk 仓副本 lib/client.js 关键字符串（如「悬浮球」），不一致即用 robocopy 从协调仓同步**（`robocopy "<协调仓子仓>" "<本仓\<同名子目录>" /E /XD .git node_modules /XF *.tgz`，lib/ 必须一并拷入——自包含链不对这些子仓执行 npm build）。
37. **快照刷新中途杀进程 → 看门狗拿半解压运行时拉引擎 → 用户 settings 被剪（2026-09-05 三重实锤）**：① refreshSnapshot 全量解压在模拟器实测 **~8 分钟**（44805 文件；流式逐文件覆盖——「bridge mtime 已新」≠ 完成，**唯一完成标志 = `.snapshot-fingerprint` 翻转新值 + `.dsh-backup` 消失**，中途抽验必误判）；② 解压中 force-stop → 无闸门的看门狗 5s 一拍用「半新半旧运行时」spawn 引擎（12:45:26 补丁日志实证）→ 混合态引擎的 settings 归一化把 `llm-pi-ai.providers`（**用户自定义供应商 Hy3/opencode-go 挂此**）剪成出厂空模板，且后续刷新备份忠实保留损坏结果；③ 恢复通道 = `undo-snapshots/auto/<最后好版本>/home-settings.yaml` 拷回 `.dsh/settings.yaml` + 重启（.credentials.yaml 的 apiKeyEnv 引用未受损）。**修复**：`EngineManager.snapshotRefreshing` companion 级 @Volatile 闸门（MainActivity/EngineService 各持实例字段互不可见，同 STARTING CAS 道理），刷新期 startEngine 直接跳过、finally 清标志。**升级/排障铁律：装新包触发重解压期间，禁 force-stop、禁拔 USB、禁 adb reboot（协调仓雷点 1 同源）。**

38. **rc.2 锁定型运行时补丁在引擎升级时抹掉新引擎代码（0.13.3 模拟器实锤，prompt 链阻断）**：assets/patched 的 session-persistence-jsonl/attachment-local 等是 0.1.1-rc.2 原版整文件（无 delta），0.1.2-rc.1 引擎启动前 applyRuntimePatches 整文件覆盖 → 新代码被旧版回退（persistence.borrowSession is not a function → 一切会话写入/发送全断）。**修复/约定**：升级引擎时逐补丁核对上游是否原生覆盖（能退役则退役——fs-local/primitives 已退役）；重出 asset 必须从新版本包文件改起（RUNTIME-PATCHES.md §3-2）；本次重出 SPJ/ATT 的最小 delta = link(2) 失败 EACCES/EPERM/ENOTSUP → rename 回退（grep "rebuild-runtime-patches" 见协调仓 .tmp-upgrade 备忘）。grep `borrowSession`。
39. **rc.1 loader module table 不再应答 client-runtime require（store-rehome 落地）**：上游把 store 引擎迁到 @deepseek-ai/dsh-client-store（web dist 内联 + Module table 命名空间），ui-responsive 构建预设的 RUNTIME_STORE_EXEMPTION（require("@deepseek-ai/dsh-client-runtime/client") external）在新 loader 上必炸——"missed the module table — build-time externals drift"，boot 即 Failed to load plugins。**修复**：源码 import 迁到 client-store；构建预设 CLIENT_EXTERNALS 移除豁免、INLINE_SAFE 加 client-store（内联，官方 ui-layout 同款）；ClientContext 类型改用 cordis Context；自备 slots-augment.d.ts（SlotMap root / GlobalStandardProps.useSessions / Context.slots-sessions 增强抄自 runtime rc.2 types）。grep `store-rehome`。
40. **npm arborist 对复杂 peer 树 + 精确 pin 会崩（spec undefined）**：ui-responsive 升 cordis 4.0.2 + client-store rc.1 后，npm install 带包参数崩（Cannot read properties of undefined (reading 'spec')）；且半装 node_modules 会让 "up to date" 谎报。**处置**：删 node_modules + package-lock 全新 install --legacy-peer-deps；peer cordis 从精确 4.0.1 放宽到 ^4.0.2；装完必须回读 node_modules/<pkg>/package.json 验证版本（npm "up to date" 不代表真装）。grep `legacy-peer-deps`。
41. **overlay 登记表漏项（primitives 缺席 rc.1 升级）**：engine-overlay.json 生成以 research 的 196 包清单为主循环——@deepseek-ai/dsh-client-ui-primitives 在旧树但不在清单 → 未覆盖留在 rc.2。**修复/约定**：登记表必须与基座树全量对账（.tmp-upgrade/audit-manifest.mjs：base-nm-paths 逐包 vs manifest ∪ keepUnpublished，未覆盖即查 npm）；发现 npm 有新版即补登记+拉 tgz。grep `audit-manifest`。
42. **run-as 的权限视图不代表引擎运行时**（Android 15 模拟器实测）：appops MANAGE_EXTERNAL_STORAGE allow 后 run-as cat /storage/emulated/0 仍 Permission denied（run-as/FUSE 评估差异）——引擎进程（同 uid 真实运行）实测可读（AI 轮 read 工具逐字读回）。验证权限问题必须走引擎运行时（会话轮/工具），不能只信 run-as。grep `run-as`。
43. **AppFrame 白屏静默挂起：create 循环 + rc.1 session-scope 严格绑定（0.13.3，两轮定位，已修）**：
（原以「坑 43 修复记录」附录形态追加，2026-09-12 归位为编号条目，正文未改。）

**第二轮定位（原「43 续」）：白屏静默挂起的真因与修复**：


首轮定位到「create 循环静默挂起」后，用 **Runtime.enable + dist 插桩**（设备侧 python 给 index-Df-65__b.js 的 boot await 链插 console.log）拿到完整时序：**50 个 entries 全部 created、r5-pluginboot-done、mount-effect、r6-mounted 全部触达——boot 管线本身是通的**。真因在 mount 后的 **React 渲染错误**：`Error: strict session slot 'details' rendered without a scope binding`（console error，0.13.2 时代无此强制）。

**根因**：rc.1 对 session-scope 槽（details 等）加了**严格 scope binding 强制**——session-scope 槽必须包在框架注入的 `<SessionProvider>` 里渲染（官方 ui-layout AppFrame 的写法：`jsx(SessionProvider, { children: renderSlot("details", {}) })`，SessionProvider 从 AppFrameProps 解构）。我们 rc.2 时代的 AppFrame 直接裸渲染 `renderSlot('details')` → 渲染期 throw → React 卸载整树 → root 空、且 React 渲染错误不进 Runtime.consoleAPICalled（error boundary 前抛出）→ **零 console 静默白屏**。

**修复**：AppFrame.tsx 三处——① 解构加 `SessionProvider`；② 桌面形态 `DetailsColumn` 内包 `<SessionProvider>{renderSlot('details')}</SessionProvider>`；③ 移动形态 bottom sheet 同款。conversation 是 session-maybe scope（无需 binding）；sidebar 是 root scope。

**定位方法论（可复用）**：
1. `Runtime.consoleAPICalled` 事件**必须先发 `Runtime.enable`** 才投递——没 enable 时「零 console」是探针假象（本坑第一轮误判「静默」的根因之一）。
2. 设备侧 python 给 minified bundle 插桩（boot await 链插 console.log）+ push + run-as（带全套引擎 env，坑 22）+ 重启引擎（内存中的旧 bundle 不会自动换）→ CDP reload 读日志——黑盒时序一步到位。
3. 服务器内存 serve：combo bundle 从 flush 时内存 responses 出（非磁盘直读），**改 dist 文件后必须重启引擎**才生效。

**验证**：SessionProvider 修复 + 第 6 次装机解压后——rootLen=411682、零 error、composer（contenteditable）在场、截图实证完整 UI（Hy3 选择器/会话历史/悬浮球全部在场）、session/create+list+prompt 新 wire 全 PASS。


44. **WSL 9p 挂载 chmod 无效 → 归档权限归一化只能在重打包层做（2026-09-08 实测）**：`/mnt/d` 是 9p 挂载且未启用 metadata，`chmod 600` 后 `stat` 仍 777、`tar -tvf` 记录 777（实测探针目录）。因此「归档前 chmod 整棵树」在 Windows 侧是**无效步骤**（白走 6 万文件），快照 tar 的权限只能靠**流式重打包**修正——唯一权威落点 = `scripts/inject-all.py`（重写每个成员：ELF/shebang=0700、数据文件=0600、目录=0700），门禁 `scripts/check-snapshot-file-modes.mjs` 校验注入后快照（= APK 内嵌 + 发布资产同源）。`build-snapshot-013.mjs` 8a3 步已删除并注明原因；`build-apk-013.ps1` 的 `-SkipInject` dev 档跳过该门禁（警告不拒打包）。grep `check-snapshot-file-modes`。

45. **快照含绝对符号链接（9 个 applet 指向 `files/usr/...`）→ 暂存解压必须放行 runtimeRoot 内的绝对目标（2026-09-08 实测）**：final 快照 1989 个符号链接中 554 个是绝对目标——545 个 Termux 残留（`/data/data/com.termux/...`，应拒）与 **9 个指向本应用运行时根**（`/data/user/0/com.dsharnessmobile.shell/files/usr/bin/{editor,ex,nc,pager,vi,view,vim,vimdiff,vimtutor}` → `libexec/{busybox,vim}/*`、`bin/more`；设备实测这 9 条在场）。旧解压器只在 `dest`（当时 = filesDir）内放行，**暂存目录解压（`.snapshot-stage`）会把它们全部静默丢弃** → applet 缺失。修复：`SnapshotExtractor.extract(..., runtimeRoot = context.filesDir)`，绝对目标只要落在 runtimeRoot 内即放行（交换后正是正确路径）；相对链接仍须落在解压根内，Termux 残留与 `../` 逃逸照旧拒绝。在线更新路径（UpdateManager，dest=update-stage）同款受益——此前同样在静默丢链。回归验证：装机后 `run-as ... ls -l files/usr/bin/more` 应见绝对链接。grep `isLinkTargetAllowed`。
46. **无障碍通道的两条「僵尸」陷阱（2026-09-10 模拟器实测）**：① **prefs 僵尸 a11yEnabled**——`am force-stop` 杀进程时 `onDestroy/onUnbind` 不保证执行，`dsh-adb.xml` 里的 `a11yEnabled=true` 会留在原地，而系统已解绑服务；引擎若只读该标记就会把请求投进队列后无人取活（表现为工具 8s 超时）。修复：引擎侧 `a11yEnabled()` = prefs 标记 **且** 队列轮询心跳新鲜（`ControlQueue.pollAgeMs() < 20s`，壳侧长轮询每次调用即刷新 `lastTakeAt`）。② **重启后服务不解绑但也不重连**——force-stop + 重新 `am start` 后必须重新 `settings put secure enabled_accessibility_services ...`（实测 `settings get` 返回 null），否则 `dumpsys accessibility` 的 `Bound services:{}` 为空。排障顺序：`dumpsys accessibility | grep -A2 "Bound services"` → prefs → 队列 `lastTakeAt`。grep `pollAgeMs`。

47. **门禁顺序错位会让新通道永远不可达（用户当场指出的设计缺陷，2026-09-10）**：把无障碍后端接进工具层后，如果 `gateFor()` 仍然只认 ADB 三道人门，工具会先被 ADB 门拒绝——a11y 分支永远走不到（实测：AI 拿到的一律是「请在开发者选项 → 无线调试 配对」）。修复原则（PRD §3.3 B3）：**两条通道等价、无障碍优先**——`gateFor` = a11y 在线 **或** ADB 门齐备，`ControlPolicy.decideControl(op)` 再决定后端；会话档位 `danger-full-access` 对两者同等要求。设置页也必须同步（无障碍为主入口 + 官方 Intent 跳系统设置 + Android 13 受限设置一键解锁，ADB 折叠为高级/脚本面），否则「改了后端没改授权面」等于没改。grep `decideControl`。

48. **`settings.describe(options)` 的 options 被实现忽略（0.13.5 引擎侧踩坑，影响所有读其它命名空间的插件）**：`ctx.settings.describe({namespaces:['llm-pi-ai']})` **不会**按命名空间过滤，返回全部注册命名空间且顺序即注册顺序——取 `[0]` 很可能拿到 `llm-deepseek`，于是自定义路由永远查不到（表现为能力自动补全静默不写回）。正确写法：`.find(d => d.ns === 'llm-pi-ai')`。同族坑：未 `inject` 的服务直接读属性会抛 `cannot get property "credentials" without inject`——可选服务一律走 `ctx.get(name)`。grep `describe(options)`。

49. **inset 通道只做了一半：没有 top 通道 → 关闭沉浸式后顶栏/设置页头被状态栏压住（#135，2026-09-10 模拟器实证）**：`WindowCompat.setDecorFitsSystemWindows(window, false)` 让页面铺满全屏，但 `MainActivity` 的 insets 监听**只缓存 bottom/mandatoryGestures/ime 并推给页面**，`bars.top` 仅用于引导页 padding；同时 Android WebView 实测 `env(safe-area-inset-top) = 0`，于是状态栏可见时（沉浸式关闭）topbar 矩形 `y=0 h=61` 的顶部 16px 与设置面板 nav（`y=12`）都落在状态栏（48 物理 px = 24 CSS px）下面。修复：insets 监听补 `webSystemTopInset = pxToCssPx(max(bars.top, displayCutout.top))` → `pushWebInsets` 推 `--dsh-android-system-top`（状态栏隐藏时 `bars.top=0`，开关天然自洽）；注入层 `.mobileFrame` 定义 `--dsh-mobile-top-inset = max(env(safe-area-inset-top), var(--dsh-android-system-top))`，topbar/抽屉/设置面板/轨迹面板/开发者弹层消费。注意设置面板是被 fixed 遮罩**居中**的，改高度会把头部推回状态栏下——正确做法是 `box-sizing: border-box` + `padding-top`。grep `webSystemTopInset`。

50. **弹出面板几何：宽度上限打在内层滚动容器上 = 卡片留空条 + 滚动条悬空（#135，CDP 实测）**：斜杠菜单 DOM 是「卡片 `[class*=_menu]`（背景/圆角/阴影）> 滚动容器 `[role=listbox]`」，壳侧历史注入脚本的 `[role="listbox"],[role="menu"]{max-width:min(92vw,340px)!important}` 只命中内层 → 卡片仍 410px、内容 340px（实测 `x=16 w=410` vs `x=20 w=340`），右侧 70px 空条、滚动条落在离卡片右缘 70px 处。模型菜单另有 `right:0 + width:max-content`，以触发器为基准 → 360px 视口下左缘 -84px，模型名丢前缀。修复：注入层 `ComposerPopupGuard` 按**实测矩形**写 `--dsh-mobile-popup-max-width`（卡片与滚动容器同值）+ `--dsh-mobile-popup-shift`（水平钳制，`[data-dsh-popup]` 上 translateX）+ 高度上限；按 `data-*` 锚点与测量工作，上游 CSS Module 改名不回归。grep `ComposerPopupGuard`。

51. **无障碍截屏落应用私有目录 → 引擎 read_image 打不开；且多花一轮（#127，2026-09-10）**：`DeviceControlService.handleScreenshot` 原写 `filesDir/control-shots/`，该目录不在引擎可读根内（引擎侧报 `EACCES: open '/data/user/0'`）。修复：改写 `files/home/tmp/dsh-tmp/`（= `EngineManager` 给引擎的 `TMPDIR`，与管理插件 ADB 截图落地同源）+ 目录 LRU 兜底保留 8 份；工具层 `android_screenshot` 读字节 → `attachments.saveImage` → **结果内联图像块 → 立即删除临时文件**（模型不再需要额外一轮 `read_image`，零残留）；路由不支持图像/附件缺失/超上限时回退返回路径。grep `inlineShot`。

52. **点击无生效校验（#129）→ 新增便宜 `state` op**：`AccessibilityService` 的窗口/内容/滚动事件已维护 `invalidated` 标记与快照代次 `generation`，但只在 dump 时暴露。修复：新增 `state` op 返回 `{gen, invalidated, enabled}`（**不建树**），`android_ui_click` 点后 260ms 读一次并回报「已生效/未观察到变化」；同时把 `ACTION_CLICK` 的节点中心 / 手势落点回填到 `x/y`（此前 a11y 归一化路径恒返回 0）。新增 op 必须同时进引擎侧 `ControlOp` 与 `A11Y_OPS`（坑 47 同族）。grep `handleState`。

53. **悬浮球完成态脱节（#133）**：`api-session/status running=false` 只重置 `sessionBusy/toolCount`，**不清该会话的待答/待审批项** → `pendingKind` 仍派生为 question/approval，球停在琥珀「等待你的回答…」且面板不收。修复：完成事件调用 `OverlayPanel.dropPendingFor(agentId)` 丢弃该会话 pending，并按 `overlay_display/auto_collapse_on_done`（默认开）自动收起面板——**有未提交草稿时不收**。grep `dropPendingFor`。

54. **目录同名模型跨厂商方言不一致 → 写入 reasoningEfforts 会让请求被网关拒（#134，独立排查）**：`dsh-model-capability` 从引擎目录按模型 id 取 `thinkingLevelMap` 写 `reasoningEfforts`，但**不写配套的 `compat.thinkingFormat`**；pi-ai 便按探测默认方言（未知 baseURL → `openai`）发送 `reasoning_effort`，真实厂商方言（如 zai）不同的网关可能直接 400，且档位持久化在 `agent-default-model` 被新会话继承。修复（0.2.1）：方言键改用**严格口径**——只要有目录声明了而另一些没声明即视为「方言不明」→ 跳过 `reasoningEfforts` 写入并记冲突；统一时连同 `compat.thinkingFormat/supportsReasoningEffort/maxTokensField` 一起写。grep `pickDialect`。

55. **历史编号保留（内容不可还原）**：该编号由 0.13.5/0.13.6 的更新记录行引用（"新增坑 55-57"），但正文从未落到本文件；`docs/AGENTS/changelog-archive.md` 现存最早条目仅到 0.13.2-preview（2026-08-31），无法还原。按"不重编号"纪律保留该号占位；
如需补正文，从 0.13.6 的认证台账 `docs/AGENTS/0.13.6-CERTIFICATION.md` 与当期 PR 描述回溯（登记义务：找到即回填本条）。
56. **历史编号保留（内容不可还原）**：同坑 55——0.13.5/0.13.6 更新记录行引用的编号，正文不在库内、archive 无对应版本行。保留占位，勿重编号。
57. **历史编号保留（内容不可还原）**：同坑 55——0.13.5/0.13.6 更新记录行引用的编号，正文不在库内、archive 无对应版本行。保留占位，勿重编号。
58. **0.1.5 起 ui-layout 不能禁用（2026-09-10，追上游）**：上游把 `ui-layout` 变成布局服务中枢（`ctx.layout` 五方法、键控 `main` 槽、`provideRoot({hooks:{panelInfo}})`、`layoutInfo` 八字段）。profile patch 若仍 `- id: ui-layout / disabled: true`（0.1.2 时代为换自研 AppFrame 而设），`ui-conversation` 注册不进 `main`、`ui-sidebar-right` 注入不到 `rightbar`、`SidebarRoot` 读不到 `usePanelInfo` → **会话与左栏一起消失**。修复：删除该 disabled 条目，注入层改「移动适配层」（0.2.0 起不再注册 root 槽、也不再 `provide('layout')`——重复 provide 会整链失败，同 directory-picker 事故）。

59. **手机形态不能再锚 `[data-mobile]`（注入层 0.2.0）**：旧 AppFrame fork 自带 `[data-mobile]`/`[data-mobile-topbar]`；去 fork 后这些属性不复存在，样式会静默失效（弹出面板越界、设置页窄条、轨迹详情被遮）。现由 `mobile/form-marker.ts` 发布 `html[data-dsh-mobile-form]`（镜像 `(max-width:767px)`）、`[data-dsh-frame]`（由上游 `[data-rightbar-col]` 反查）、`html[data-dsh-modal-open]`、`[data-dsh-settings-dialog]`；顶栏为 `[data-dsh-mobile-topbar]`。改动样式前先 grep 这五个锚点。

60. **原生「打开方式」两条出口与白名单（0.13.7）**：`PathOpen.openChooser` 与 `FileIncoming.openWithExternalReader` 共用 `FileIncoming.isReaderAllowed`（file_paths.xml 同一映射面）；目录主候选固定 `ACTION_OPEN_DOCUMENT_TREE`（FileProvider 目录 URI 多数文件管理器不可枚举），MT 管理器等按包名进「初始意图」——装了才出现，未装不臆造。返回 `{"ok",reason?}`，页面按 reason 分流文案，绝不静默（`no-handler` 弹提示）。


61. **polyfill 片段共用一个 `<script>`：一个片段语法错误 = 整块 polyfill 静默全灭（0.13.7 模拟器实锤，排查花掉一整轮）**：`dsh-host-web-compat` 的 `POLYFILLS` 数组原来用 `join('')` 拼进同一个 script 元素——Set 集合方法片段以表达式 `})()` 结尾（**没有分号**），紧接着的下一段以 `if (` 开头，两段贴成 `})()if(` → 解析器拒绝**整个 script 元素**（`Unexpected token 'if'`）→ 页面上 `typeof Iterator === 'undefined'`、`Promise.withResolvers` 也没了，上游 0.1.5 客户端包 import 期直接 `Iterator is not defined`（表现为 "Failed to load plugins"，截图见 `.deploy-tmp/0137/now-01.png`）；而**服务出去的 HTML 里片段文本一个不少**，所以 `grep` 类检查全绿，检查脚本用的「`ES2024/2025 builtins`」标记还只是插件源码里的 JS 注释（根本不会出现在页面），假绿 + 假红线同时误导。**防线（三层）**：① 装配规则 `POLYFILL_SCRIPT_BODY` 对每段补 `;` 并用换行分隔；② `apply()` 装载期对装配结果逐段 `new Function` 解析断言，失败直接抛（`host-web-compat: polyfill injection does not parse: …`）；③ 门禁 `node dsh-host-web-compat/scripts/smoke-injections.mjs`（桩 cordis 真装配 + 逐段解析 + 页面标记）+ 设备侧 `scripts/verify-webview-015.mjs` 的「全部内联脚本可解析 / polyfill 活性」断言。**教训：注入类缺陷只能按「装配后能不能解析/能不能用」判，不能按文本在场判。** grep `POLYFILL_SCRIPT_BODY`。

62. **孤儿写锁会让引擎永久起不来（Android 没有 operator）→ F4 引擎树补丁（0.13.7）**：`dsh-atomic-write.withFileLock` 用 `wx` 建 `<file>.lock`（内容 = 持有者 pid），只在 `finally` 里 `rm`。进程被硬杀（用户划掉应用 / 系统 OOM / `am force-stop` / 看门狗重启）时 finally 不执行 → 锁永久残留 → 之后每次写该文件都等到 deadline 抛 `atomic-write: timed out waiting for the writer lock at …/.credentials.yaml.lock`，**引擎 boot 直接失败**（实测现场：重复引擎进程被清掉后仍起不来，只因这一颗残留锁）。上游注释明写「contender never removes an existing lock … orphan recovery is an operator action」——桌面/服务器有位运维能删锁，Android 应用私有目录（`/data/data/<pkg>/…`）用户无任何可达手段。补丁 `atomic-stale-lock-F4`（scope=engine）在超时点做**一次**受控回收：锁记录的 pid 已消失（`process.kill(pid,0)` 得 ESRCH；EPERM 视为存活）且锁内容二次核验一致才删；读数失败/非 pid/不一致/任何异常一律不动锁（退回上游等待-超时语义）。行为回归 `node scripts/patches/tests/atomic-stale-lock.test.mjs`。排障配套：**同一时刻只许一个引擎进程**（重复进程既制造锁争用也污染 `dsh web:` banner 判读），现场先 `ps -A | grep -E 'linker|node'` 清干净再起。grep `recoverStaleLock`。

63. **`inject-snapshot.py` 只替换快照内已存在的成员——给已有插件包「加新文件」不会进快照（幽灵缺陷温床）**：注入器按 tar 成员逐个判定（`member.isfile() and is_injectable(...)` → 用本地内容替换），只有**整包都不在快照里**时才走 `need_add` 全量新增（`scripts/inject-snapshot.py` 第 90-121 行）。因此「在 `dsh-host-web-compat/lib/` 里新加一个模块文件」这类改动，release 快照里**不会出现该文件**（本地跑得通、设备上 `Cannot find module`；0.13.7 处理 polyfill 缺陷时刻意把修复留在 `lib/index.js` 内就是为了避开这条）。需要新增文件时：要么确认该包整包走 add 路径，要么改注入器补「本地有、tar 内无 → 追加成员」的分支，并**在设备上 `ls` 该文件复核**。grep `need_add`。


61 续（同日第二层，同一入口）：**Iterator 垫片必须长成构造器形状，否则 pdfjs 把整树打挂**。清掉「Iterator is not defined」之后，`ui-sidebar-documentpreview` 的 combo 包仍在 import 期抛 `Cannot read properties of undefined (reading 'join')`。定位方式（可复用）：CDP `Debugger.setPauseOnExceptions: all` 暂停在抛点 + `Debugger.getScriptSource` 取源码行——出错行是 pdfjs 的 `if (typeof Iterator.prototype.join !== "function") Iterator.prototype.join = ...`：真 `Iterator` 是构造器且 `.prototype === %IteratorPrototype%`，而第一版垫片是裸对象 `{from}`（`Iterator.prototype` 为 undefined）→ 守卫行即抛，loader 记 `failed to import loader entry ...` → 整树 Failed to load plugins。修复：垫片改成 `function Iterator(){throw new TypeError(...)}` + `from` + `Object.defineProperty(ctor,'prototype',{value:proto})`（proto 仍是打过助手的 %IteratorPrototype%）；同时 `box()` 包装器必须 `Object.create(proto)` 而不是裸对象，否则链式助手 `iter.map(f).toArray()` 全断（真机断言当时报 `toArray is not a function`）。两道回归都进了 `dsh-host-web-compat/scripts/smoke-injections.mjs`：在 `node:vm` 里先删掉 Iterator 全局**和**原生助手方法（如实模拟 Chromium 110）再跑垫片，然后执行 pdfjs 的守卫行与 `Iterator.from([1,2]).map(...).toArray()`。**教训：垫片要按「真实现的结构」补（构造器 + prototype + 继承链），只补名字不够。**


64. **运行时补丁不得引用引擎构建产物（bundle hash）**：`adaptIndexHashes` 用 `-([A-Za-z0-9]{8})\.(js|css)` 抓引擎
    `dist/index.html` 的 bundle 名，而 npm 现包的 hash 已经是 `index-Df-65__b.js` 这种（带 `-`、9 字符）——正则匹配不上就
    「原样返回」，patched 模板的旧引用被整文件写回 → 页面引到不存在的 bundle（白屏）。结论：这类补丁的生命周期跟着上游构建走，
    要么不写，要么写就得随每次引擎升级核对（0.13.7fx-1 直接退役 `web-frontend-index.html`，见 RUNTIME-PATCHES §8）。

65. **Android 应用进程的 cwd 是 `/`，而引擎拿它当默认值**：`SessionCommandController(ctx, agents, process.cwd())` 把
    `process.cwd()` 当「未指定工作区」会话的 cwd；`file-reference-local` 在会话无 cwd 时也回退到同一个进程目录。
    壳侧不设工作目录 → 新会话 cwd=`/` → `@` 菜单列的是设备根目录（acct/apex/cache…），用户看到「@文件功能无法使用」
    （apk #150/#144）。修复：`ProcessBuilder.directory(应用工作区根)`（0.13.7fx-1，EngineManager.workspaceRootDir）。
    同一族的坑：任何「上游拿 process.cwd() 兜底」的地方在 Android 上都会落到 `/`。

66. **Android 应用域禁 `link(2)`：补丁必须清点目标文件的全部 link 站点，不能只补历史锚点**：
    0.13.7 追上游 0.1.5 后，运行期 asset `session-persistence-jsonl-index.js` 只给 `materialize` 路径
    （`lib/index.js:2973`）补了 `EACCES → rename` 回退，漏了 `publishCurrentExclusive()`（:2021/:2032）——
    而后者正是 `v0→v3` 会话迁移的必经路径，结果是**升级前写入的会话全部打不开**（apk #154，贡献者定位）。
    修复：asset 从 0.1.5 包重出（两处都补）、新增构建期补丁 `spj-migration-link-F5`、门禁断言「两处标记都在」、
    并加行为回归 `scripts/patches/tests/spj-migration-link-f5.test.mjs`（桩 fs 让 link 抛 EACCES → 断言 rename 生效）。
    回退必须用**模块顶层导入的 `rename`**：`internals.fs`（defaultFileSystem）只暴露 open/readFile/readdir/stat/lstat/link/rm，
    `internals.fs.rename` 会 `TypeError`（贡献者在 PR #156 里实测记录）。同类站点清点义务适用于所有 fs 原语回退补丁。

67. **文件名净化把 `..` 当「非法字符」处理是无效防线（#177 实锤，0.13.8 修复）**：`sanitizeName`
    旧版只替换 `?*|:"<>` 与控制符，字符类无 `/`、无 `\`、无点——而 `..` 不是非法字符而是**路径语义
    token**：外部 ContentProvider 完全可控 DISPLAY_NAME（`../../../../pwn.txt`），净化后原样落
    `File(dir, name)`，上溯 5 级 = 应用私有数据目录根（任意新建，已存在文件因 uniqueName 的
    exists() 检查不被覆盖）。根因 = validate() 守 URI、sanitizeName() 守字符集，**拼好的最终
    落点无人校验**。修复 = ① sanitizeName 白名单化（`/` `\` → `_`、`\.{2,}` 折叠、百分号解码
    先行、去首尾点）；② copyIn 落点走 safeTarget canonical 归属断言（写前+写后，双侧
    canonical 化——Android 把 `/data/user/0` 解析为 `/data/data`，只做一侧会永远拒绝），fail-closed。
    铁律：凡「外部字符串 → 落盘路径」一律过 safeTarget 同型守门，新增出口先查本坑。

68. **部署默认写面档位不是能力门（#172 实锤，0.13.8 修复）**：`dsh-android-bridge` 的
    `gateFor/gateFacts/controlDecision` 三处曾叠 `&& st.tier !== 'T0'`——出厂装配
    `writeMode: workspace-write`（profile-web.cordis.patch.yml:23）使 `tier` 恒 T0，
    ADB 通道**恒判未就绪**（`android_adb_shell_exec` 永不返回 via:'adb'），且设置页显示
    「未授权（T0）」——坑 29「勿把部署默认当死锁」的活体复刻。修复 = 三处删 tier 条件，
    能力门 = 引擎级三道门 + 会话档位实时 resolve；`tier` 降级为部署视图字段
    （AdbAuthSection 的「已授权」改按三道门，linux-env 的 adbTier 文案标注「档位视图」）。
    铁律：门禁判定只允许「设备全局事实 + 会话实时档位」，任何部署常量进判定即缺陷。

69. **往 profile patch 挂「上游已挂」的包 = 整棵插件树加载失败（0.13.8 批 F/P2-14 实锤）**：
    按设计文档把 `@deepseek-ai/dsh-spill-local` + `dsh-spill-policy` 以 `- insert:` 挂进
    `scripts/profile-web.cordis.patch.yml` 后，设备上引擎起不来，日志真因：
    `dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
    duplicate loader entry id: spill-local`。即**上游 host 组合默认已经挂了 spill 子系统**
    （所以「已装未挂」的推断是错的——overlay manifest 只说明包在快照里，不代表没挂）。
    代价是整棵树加载失败，不是单插件降级。铁律：新增 `- insert:` 前先确认 row id 在上游
    组合/预置里不存在；挂载失败先看 duplicate id，再谈配置。
70. **profile patch 的合并语义是「按 id 只增不删」——错误的 row 会永久留在设备上（0.13.8 实锤）**：
    坑 69 的 spill 行写进 `home/.dsh/profiles/web/cordis.patch.yml` 后，**改回代码 + 重装 APK
    + 重解压快照都没能删掉它**（实测：重装后该文件仍是旧的含 spill 版本，引擎持续起不来）。
    根因是快照事务的 profiles 分区合并对 `cordis.patch.yml` 按 id 合并（0.13.8 B345 批
    `SnapshotTransaction.mergePatchYamlById`），设计目的是保住用户手改，代价是**我们自己也删不掉
    已注入的行**。恢复路径（已实测）：`adb shell` 删/改
    `<files>/home/.dsh/profiles/web/cordis.patch.yml`（注意不要留 root 属主备份文件，见坑 71），
    或清应用数据。**发布含义**：0.13.8 之后若需要下线某条已注入 row，老设备上删不掉——
    必须在合并语义上给「上游注入行以 staged 为准」留口子（已登记 known-gaps）。
71. **profiles 目录里放 root 属主文件 → 引擎 watcher EACCES 崩溃（0.13.8 调试时踩到）**：
    用 `adb shell cp`（root）在 `home/.dsh/profiles/web/` 下留了 `cordis.patch.yml.bak-spill`，
    引擎对 profiles 目录做 `watch`，读不到该文件 → `syscall: 'watch', code: 'EACCES'` 直接崩，
    表现为「引擎启动失败」而日志里没有任何插件错误。铁律：调试期在 profiles 目录里造文件
    必须 `chown u0_a53:u0_a53` 或立刻删除（应用 uid 见 `dumpsys package`）。

72. **工具返回面聚合体不得含 `undefined` 成员（0.13.8 批 B0/B1 实锤）**：工具体对返回值做 lossless JSON 判定，
    含 `undefined` 成员的整值被拒收（不是丢字段，是整条结果失败）。铁律：可选键缺省**整键不发**，
    源头（构造对象处）与出口（序列化前）双修；新增/修改返回字段必须在**同一次改动**里进 `output.schema`。
    锚点：`plugins/dsh-android-manage/src/lossless-json.ts` + `plugins/dsh-android-manage/test/privilege-status.test.mjs`。
73. **`defineTool` 之后必须确认进了 `tools()` 的 return 数组**：不进注册数组就是死代码，而提示文案还在引导
    模型去调它（表现为「工具明明写了却 always unknown tool」）。注册完整性**不得**用硬编码名单比对——
    要源码级抽取 `defineTool` 名集合与注册名集合求差集（本轮 T2 门禁 `check-tool-output-schema.mjs`）。
    锚点：`plugins/dsh-android-manage/src/index.ts` 的 `tools()` 数组 + `scripts/check-tool-output-schema.mjs`。
74. **跨语言/跨模块等价门禁只锁「同一输入同一输出」不够，还要锁「输出能被另一端正确解释」**：V2 行句柄口径即此例

143. **对虚拟屏截图拿到的是真实屏画面：ADB 回落路径完全忽略 `screenId`（0.14.0 模拟器实锤）**：
    现象：设备内 agent 把「设置」成功拉到虚拟屏（`dumpsys activity` 确认在 Display #10），
    但 `android_screenshot { screenId: "virtual-1" }` 返回的画面是 **DSH 聊天界面**；
    它据此判定「设置没开在虚拟屏上」，整轮往错误方向排查。

    真因：`android_screenshot` 有两条路，**只有无障碍那条认 screenId**。
    无障碍离线时回落到的 ADB 路径写死了：
      `adb shell screencap -p <remote> && adb pull ...`
    无参 `screencap` 只抓默认屏（display 0），`screenId` 从始至终没被读过一次。
    这是一个**静默错误答案**：工具返回成功、图也真实，只是拍错了屏——比直接报错更有害。

    修法：ADB 路径也解析目标屏（`screenAccessResolved` → `vdInfo`）并落到 `screencap -d <displayId>`
    （该通道 uid=2000，具备此权限）；同时**把分辨率锚点换成目标屏自己的像素**——
    锚点若仍是真实屏尺寸，模型按归一化坐标点击会整体错位。
    未指定 screenId 时不注入 `-d`，保持真实屏默认语义不变。

    通用教训：**同一工具的多条通道必须共享同一份参数语义。**
    这条缺陷的本质不是「截图坏了」，而是「两条路的 screenId 支持度不一致」——
    加通道时只测了主路，回落路径的参数就跟主路脱钩了。
    回归：`a11y-routing.test.mjs` 两条（带 screenId 必须 `-d <id>` + 锚点是虚拟屏像素；不带则不得注入 `-d`）。

144. **「探针值恒为 -1」不一定是解析 bug：先证明产出面在场（0.14.1 块F P0 实锤）**：
    现象：`files/boot-segments.log` 的 `t_compose_total` 在设备上 42/42 样本恒为 `-1`，
    而 `scripts/check-perf-instrumentation.mjs`（P-AC-04）一直判绿——因为它只查「三字段在场」。

    真因（两条，缺一不可）：
    ① **产出面根本不在**：`[perf] TOTAL calls=… totalMs=…` 只有测量用 preload
       `scripts/perf/count-compose.mjs` 会打印（`--import` 注入引擎命令行 + `process.on('exit')` 汇总）。
       该脚本**没有任何发行路径**：不在快照 stage、不在 `engine-overlay.json`、不被 `inject-all.py` 注入，
       出厂 argv 与 env 也都不含它。⇒ 正则/解析器没错，**上游从未产出那一行**。
    ② **解析链挂在默认关闭的开关上**：`maybeEmitComposeTotal` 只被 `tick()` 调用，而 `tick()`
       由调试日志采集器驱动、**采集器默认关闭**。即便探针在场，默认设备上也永远落不出真值。

    修法：口径解析改为**与采集器解耦的有界 tail**（`startProbeTail`，独立读偏移、90s 上限、daemon），
    且**探针缺席时显式落 `note=probe-absent`** + 判据行带 `t_compose_source`，
    使「探针没装」与「采样为 0」从此可区分（`none` vs 真实值）。

    通用教训：**指标恒为缺省值时必须先证产出面**——「解析器存在」不等于「数据源存在」。
    同理：**不得用近似量冒充**（A3 缓存行只有 entries/hits、A5 只有 singles，都不含耗时，
    拿它们填 `t_compose_total` 就是新的假绿）。回归：`EngineBootInstrumentationTest`
    的 `composeSourceDistinguishesAbsentProbeFromZeroSample`（含「A3/A5 在场也不得产出 totalMs」反向断言）。

145. **门禁断言「安全姿态」时，改姿态必须同批改断言，且新断言要守住**真正要守的东西**（0.14.1 块K 实锤）**：
    现象：issue #232 的用户裁定是「撑开 NSC 支持明文 http」（准入面一直放行 http，而平台 NSC
    只白名单回环 ⇒「准入说行、平台必炸」）。撑开后 `check-manifest-hardening.mjs` 立即必红——
    它把 `base-config cleartextTrafficPermitted="false"` 锁死了。

    修法要点（不是把 false 改成 true 了事）：
    - 断言改为**显式声明**：`cleartextTrafficPermitted` 漏写即平台默认 false（=静默收紧）→ 判红；
    - **回环保留面逐字比对**（127.0.0.1 / localhost / 10.0.2.2，多一个少一个都判红）——
      防止「放开全域时顺手把可信回环定义放宽」；
    - 拒绝 `<domain-config cleartextTrafficPermitted="true">` 不带 `<domain>`（=全域明文口子）；
    - **跨层同向**下沉为 JVM 测试 `BrowserHostCleartextConsistencyTest`（真实调用准入面函数 +
      解析 NSC 本体），门禁只断言「该测试仍被接线」——单层门禁发现不了「准入面另开口子」。

    #183「壳侧明文收敛」影响（**必须书面记录**）：原目标「默认禁明文、仅放行回环」对隔离浏览器
    **不再成立**——隔离 WebView 可访问任意明文站点，明文流量回到不受平台默认保护的状态。
    这是用户明确拍板接受的取舍；影响面仅限 BrowserHost（无桥、无 addJavascriptInterface），
    引擎子进程（不受 NSC 约束）、APK 自更新（HTTPS）、主 WebView（回环）三条均零变化。

    通用教训：**门禁锁的应是「要守的性质」，不是「当时的取值」**；姿态变更时若只翻转字面量，
    门禁就变成一句永远为真的废话。

146. **「抑制」类开关默认值翻转必须配存量升级策略，且不得静默改写用户显式选择（0.14.1 块J 实锤）**：
    现象：`NotifyCenter.suppressForeground()` 缺键返回 `true`，导致**前台工作时整条工作汇报被永久丢弃**
    （命中即 `return Result.SUPPRESSED_FOREGROUND`，无入队、无补投；而消费侧已推进字节偏移）
    ⇒ 用户体感「必须划到后台才推送」。用户裁定默认值改为 `false`（前台也真发）。

    存量升级的关键事实：**旧抑制是默认值造出来的，不是 prefs 写出来的**——
    全仓 `setSuppressForeground` 零调用、0.14.0-preview 起从未接线，**没有任何发行版写过该键**。
    ⇒ 改默认值即修好存量用户，**无需改他们任何一个 prefs 字节**。

    因此迁移形态是「**不动 prefs**」：缺键 → 走新默认值（被修好）；**显式存在的值原样保留**
    （那只能是用户/自动化写入的真实意志，静默改写它属于「代理信号当真实状态」的反面错误），
    只备份到 `suppressForegroundLegacy` + 探针留痕；`suppressForegroundSchema` 代次保证只跑一次。

    同批补的另一半：抑制从「丢弃」改为「**延后**」（待投队列 + TTL + 覆盖式去重 + 有界），
    且 `listener` 从「全仓零赋值的空操作」补上真实实现（复用既有 `flashStatus`）——
    否则用户既无系统通知、也无应用内提示，是「一切正常与彻底失败不可区分」的静默失败形态。

    通用教训：**改语义默认值前先查「旧行为是默认值造的，还是被显式写出来的」**——两者迁移策略相反。
    回归：`NotifySuppressQueueTest`（TTL/覆盖/有界/最新优先）+ `NotificationContractTest` 六条。

155. **悬浮窗完成位必须挂在服务级字段：自动收起是默认路径，「完成后用户还没看到面板」才是常态**：
    现象（需求侧）：用户要求「对话完成且首次打开悬浮窗时」显示「已完成，长按查看汇报」。
    若把完成位放进 `unitView` 的视图状态或某次 `setText`，自动收起（`autoCollapseOnDone` 默认 true，
    完成后 900ms 收面板）会 `removeView(unitView)`，完成位随之丢失 → 用户点球重开时**永远看不到**该文案。

    真因：`hidePanel()` 会 `unitView.visibility = GONE` 并 `removeView`，视图状态不是跨展开期的载体。

    修法：完成位放 `OverlayService` 服务级字段（`internal val completion = CompletionNotice()`，
    与 `sessionBusy`/`toolCount` 同族），置位与消费分离——`applyAgentStatus` 的 `running=false` 分支置位，
    `showPanel()` 消费。**且必须覆盖「置位时面板已展开」路径**（autoCollapseOnDone 关闭时）：
    该路径不走 `showPanel`，若不显式消费则展开态永远不显示。

    通用教训：**任何「跨收起/再打开」的用户可见状态，都不能存在会被 remove 的视图里。**

    回归：`OverlayCompletionNoticeTest`（无 pending 的普通完成必须显示、收起再打开回常态、两轮不残留）。

148. **`flashStatus("已完成")` 的真实触发条件不是「工作完成」，而是「有 pending 被丢弃」**：
    现象：既有实现里「已完成」只在 `dropPendingFor` 返回 true 时闪现，故**普通完成（无待答/待审批）
    根本不显示**；且它是 2.5s 瞬时闪现、只在展开态可见。

    真因：两处 `flashStatus("已完成")` 调用都在 `if (dropped)` 之内，`dropped` 来自
    `panel.dropPendingFor(agentId)`。这正是旧认知与本需求的分歧点——先读源码再改，
    不要沿用「完成就会显示已完成」的错误前提。

    另注：自动收起分支里的那次 `flashStatus` 是**死调用**（同点先 `hidePanel()` 同步置
    `expanded=false`，而 `flashStatus` 内有 `if (expanded)` 守卫 → 必不显示）。

    修法：新完成态是**独立常驻状态位**（`CompletionNotice`），触发取自权威信号
    `api-session/status running=false`，与 `dropped` 无关——这样无 pending 的普通完成也能显示。

149. **`as? GradientDrawable ?: return@post` 式取层是静默失败源：drawable 改形态后门禁全绿但功能不动**：
    现象（本轮实锤形态）：`setHalo` 原为
    `val g = hv.background as? GradientDrawable ?: return@post`。把 `newHaloDrawable` 改成
    `LayerDrawable`（glow+ring 两层）后，该 `as?` **恒为 null**，于是每一次状态改色请求都被
    无声吞掉——不抛错、不日志、编译过、门禁绿，表现只是「球不变色」。

    真因：`?: return@post` 把「类型不匹配」这种**结构性错误**降级成了正常控制流。

    修法：显式取层 + 失败留痕（`LogCollector.log`），并让「背景必须是 LayerDrawable」成为
    源码契约断言的一部分（`CallSiteContractTest`：不得再出现 `background as? GradientDrawable`）。

    通用判据（同坑 61）：**任何 `as?` + `?: return` 组合，若其失败分支等价于「功能静默失效」，
    就必须改为显式诊断**——否则它是一道永远发现不了缺陷的防线。

150. **`Color.argb(...)` 在 `unitTests.isReturnDefaultValues = true` 下恒返回 0：颜色类单测会假绿**：
    现象：`Halo` 枚举若用 `android.graphics.Color.argb(...)` 在枚举初始化时求值，JVM 单测里
    `Color.argb` 被打桩返回 **0** → `Halo.values()` 全部取值为 0 → 任何
    `assertEquals(ringColor, Halo.PENDING.color)` 一类的断言**恒真**。
    这类测试看起来在防漂移，实际是「永远不会失败的防线」。

    真因：`app/build.gradle.kts` 的 `unitTests.isReturnDefaultValues = true` 把 android 图形类
    统一打桩成默认值（0/null），纯 JVM 测试拿不到真实图形 API。

    修法：状态色改用**纯 Kotlin ARGB 十六进制字面量**（`0xCDEBBE3C.toInt()` 等，换算口径
    `(a shl 24) or (r shl 16) or (g shl 8) or b`，逐字节等价），枚举即可在 JVM 上求真实值；
    并补一条「四态取值互不相同」的反证——把实现改回 `Color.argb` 时它会立刻变红。

    **连带坑（本轮实际踩到，比坑本身更值得记）**：人工转写十六进制极易**把 g/b 两个字节写反**
    ——`argb(205,235,190,60)` 的正确拆解是 `a=CD r=EB g=BE b=3C → 0xCDEBBE3C`，本轮误写成
    `0xCDEBBC3C`（`BE3C` 错位成 `BC3C`）。更要命的是**设计详档 §4.3 的换算表里写的就是错值**，
    照做即错（已就地更正 `docs/0.14.1-preview-HALO-FREE-MOVE-AND-RING.md:277-278` 与本条）。
    教训：**转写类改动的唯一可靠验收是「逐字节等价断言」，不是肉眼比对**——本轮正是
    `argbLiteralsEqualThePreviousColorArgbValues` 把它抓出来的。
    另注意：契约测试若拿**具体字面量**当「在场」判据（如原文的 `code.contains("0xCDEBBC3C")`），
    会把错值一起钉死 → 修源码后测试反而判红。正确写法 = 断言 8 个**正确**字面量在场
    **且**显式禁止已知错值形态（见 `CallSiteContractTest.haloEnumUsesPlainKotlinArgbLiterals`）。

    回归：`OverlayHaloInvariantTest`（四态互不相同 + 字面量逐字节等价 + 通道语义方向）。

151. **构建器「跑到一半就正常退出」= 打包链静默复用陈旧快照（0.14.0 实锤，本轮修复）**：
    现象（本轮取证）：`scripts/build-snapshot-013.mjs` 跑完打印「瘦身完成」后 **exit 0**，但
    `.deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz` 的 mtime 停在 9/15，而同级 `stage/` 已更新到 9/19
    —— **「stage 是新的、产物是旧的」**。整条打包链零报错：`build-apk-013.ps1` 只判「该 tar 是否存在」，
    存在就继续注入/打包，于是**发布产物里嵌的是上一次的快照**。

    真因：提交 `0849579`（0.14.0 正式轮）对 `build-snapshot-013.mjs` 做了**纯尾部删除**（父提交
    866 行 → 823 行），删掉的正是 `── 8. 归档` 整段：`tar -c --mtime=@… | xz -T0 -6` 产出 tar、写
    `snapshot.sha256`、归档内 LICENSES 自检、A1 出厂声明值对账。该提交的 message **完全没提**这件事。

    **第一手信号（最快判据）**：`scripts/snapshot-config/slim.json` 出现**死键**——
    `reflinkGlobs` / `orphanGlobalNodePackages` 在构建器里已无任何消费者（被删的还有依赖它们的
    两步瘦身）。**判据：配置文件的每个键都必须在消费它的构建器里被引用；死键 = 某步被删/被绕过的
    确定性证据**（比「事后去读 diff」快，且不依赖有人记得查历史）。

    修法：从 `0849579~1` 恢复尾块（**+99 行 / 0 删除**的纯新增；尾块与删除前逐行一致、`node --check`
    通过），重跑构建器实测产出 162.7 MB tar 并打通归档后自检；并新增常驻门禁
    `scripts/check-snapshot-builder-output.mjs`：① 产出面构造在场（tar 打包 / sha256 落盘 / 归档后
    LICENSES 自检 / A1 对账 / 两步瘦身，且**纯注释行不计入**，防「只剩注释提到」的假绿）；②
    slim.json 键消费者闭合（死键即红）；③ 与打包链**路径同源**（构建器写 A、打包链读 B 亦属同类
    静默假绿）；④ 两树同版。该门禁自带 `--self-test`（含「尾部删掉归档段必须判红」「纯注释不计入」
    等反向对照），并已用**真实回归版本**实测判红 9 项。

    通用判据：**任何「产物生成器」与「产物消费者」分居两处时，必须有一条断言锁住「产出面还在」**
    —— 只判「产物文件存在」是假防线：文件可能是上一次的。

147. **`screencap -d <Android displayId>` 对虚拟屏必然失败：必须用 SurfaceFlinger 的长整型 display token（0.14.1 块G F6 设备实测）**：
    现象（MuMu x86_64 模拟器，Android 15 / API 35）：已建虚拟屏 `virtual-1`
    （Android `displayId=2`、1200x675、`mHasContent=true`、屏上有前台应用）时：
      `screencap -d 2 -p out.png`  → `Failed to take screenshot. Status: -2`（无文件）
      `screencap -d 0 -p out.png`  → 同样 Status -2
      `screencap -d 4619827820427265280 -p out.png`（真实屏的 SF token）→ 成功 256479 B
      `screencap -d 11529215049621561620 -p out.png`（**虚拟屏的 SF token**）→ 成功 93785 B
        （PNG 1200x675 RGBA，解出 984 种不同 RGB、非全黑；uid=2000 shell 亦成功）
    真因：`screencap -d` 吃的是 **SurfaceFlinger 的 display token**（`dumpsys SurfaceFlinger` 里的
    `Display <长整型>`，虚拟屏那份形如 `11529215049621561620` = `0xa0000000d3c7e114`），
    **不是** `DisplayManager` 的 `displayId`（后者是 `dumpsys display` 的 `mDisplayId=2`）。
    两者在所有现有文档与代码注释里都被当作同一个数——这就是「-d 传对了也不出图」的真因。
    另注：`Status: -2` 与「display id 合法但 SF 认不出」同形，故错误码本身不区分这两种输入。

    影响面（**已交叉核对，非仅 F6**）：`plugins/dsh-android-manage/src/index.ts:549-552` 的截图回落
    路径就是 `adb shell screencap -p -d <screenAccessResolved().displayId>`，即传的是
    DisplayManager 的 `displayId` ⇒ **该回落路径对虚拟屏截图在当前实现下必然失败**
    （0.13.8 修的是「忽略 screenId」，本轮暴露的是「传了 screenId 但 id 空间错」）。
    而 `VdisplayController` 的 `ImageReader` 通道注释明写 "not a pixel transport"（只排空帧）。

    已确证的落地形态（F6 收口，见 152）：壳侧按 SF 的 `name="DSH <alias>"` 反查 token，
    再 `screencap -d <token>`。反查命令用**收窄**形式（输出只 ~25 B）：
      `dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'`
    实测输出（逐字）：
      `    name="mumuscreen000"` / `Virtual Display 11529215047793762666` / `    name="DSH virtual-1"`
    注意**不要用全量 `dumpsys SurfaceFlinger`**：本机全量 31,590 B，而虚拟屏段落在第 ~9,500 字节之后，
    超出壳侧 capture 路径的 8 KiB inline 回传窗口 ⇒ 全量取回必然拿不到目标行、反查恒空。
    另注意 token **每世代都变**（同一会话内实测出现过 `...46816944610`、`...49621561620`、
    `...47793762666`），**不得缓存**，必须每次现查。
    （本节此前写「token 数值未在公开 API 暴露、反查未跑通」——已被 F6 的设备实测推翻，就地更正。）

    通用教训：**两个同名不同值域的 id 不可互换**——`-d` 的参数空间必须在代码与文档里写清是
    「SF token」还是「DisplayManager displayId」；本仓此前三处（manage 截图、F2 正则、F5 副本）
    都默认它是 displayId。F2/F5 的放行判据本身不受影响（它们只比对「是否是已注册虚拟屏的
    displayId」，用于范围判定而非透传），但**透传面**必须转成 token。

152. **无障碍通道对虚拟屏**取树/截屏**曾被范围门误拒**（screen-blind；F1 已修，见条末更正）：`android_screenshot {screenId:"virtual-1"}`
     必须走 ADB 回落，SF token 反查因此是**承重路径**而非兜底（0.14.1 块G F6 设备实测）：
     现象（MuMu x86_64 模拟器 / Android 15 / API 35，装机版 0.14.0，a11y 服务已确认 bound）：
       `android_screenshot {screenId:"virtual-1"}` → 返回**真实屏命令词拒绝文案**
       `android_ui_dump {screenId:"virtual-1"}`     → `无障碍取树失败：screen-out-of-scope:
         用户当前开放屏幕范围为 virtual-only，不允许读取或操作真实屏幕`
     真因：a11y 通道在**虚拟屏目标**上被范围门按 `real` 判定而拒（与 F1/F2 同族的 screen-blind 判定：
     门只认「调用点是否把 screenId 传进门」，a11y 分支不解析别名 → 落到 real → virtual-only 下必拒）。
     这同时解释了「模型反复改用 `android_shell_exec` 试 screencap」的行为：它拿到的是一条与真实
     判据不符的拒绝（T3 修过的「文案撒谎」同族），于是整轮在错误前提下排查。
     结论：**ADB 回落是承重路径**，故 F6 的 SF token 修法是必需的，不是锦上添花。
     关于 a11y 侧的 screen-blind 判定——**该结论已过期，就地更正（2026-09-19 收口轮）**：
     当时记「本轮未修，属独立遗留缺陷」已被 F1 修正取代。`bridge/index.ts:832-838` 现在**读
     `args.screenId` 并经 `screenAccessResolved` 按目标屏判定**（不再按 op 名一刀切），
     故 virtual-only 下指虚拟屏的 a11y op **不再被门拒**；上引「无障碍取树失败：screen-out-of-scope」
     是 F1 修好**之前**的现场报文。
     能力面另有新证据（同日实测，MuMu x86_64 / API 35）：虚拟屏 active 时
     `dumpsys window windows` 出现 `WindowsForAccessibilityObserver{mDisplayId=10, mInitialized=true}`，
     且 `uiautomator dump --display 10` 能出 1916 B 真实节点表 → **a11y 通道对虚拟屏可达**，
     原先「对虚拟屏不可用」的推断不成立（真因是范围门，不是能力缺失）。
     **仍未确证**：`takeScreenshot(displayId≠0)` 对**应用自建 private display** 是否成功
     （详档 §6 U5），需引擎工具面端到端调用方可定性；`android_screenshot` 的 ADB 回落
     仍然是已验证可用的那条路。

     复验方式（本轮实际用的，可复用）：页面内 RPC 驱动一次真实模型工具调用——
     `adb forward tcp:29225 localabstract:<webview_devtools sock>` → CDP
     `Runtime.evaluate` 发 `fetch('/api/commands/execute', {agentId,line:'/permission danger-full-access',
     submittedAttachments:[]})` 先提档（否则工具面被 `workspace-write` 门拒绝，会误判成 a11y 失败），
     再 `fetch('/api/session/prompt', {request:{requestId,sessionId,mode:'queue',content:[{type:'text',text}]}})`，
     最后拉 `files/home/.dsh/sessions/<dir>/session.v3.jsonl.zstd` 解出工具结果。
     **两个必踩的坑**：① RPC `payload.args` 的字段名逐方法不同（`session/list` 是 `_request`、
     `session/prompt` 是 `request`、`commands/execute` 是 `agentId/line/submittedAttachments`），
     字段错会得 `gateway/arguments-invalid` 而不是静默失败；② 会话日志是**多帧 zstd 拼接**
     （本机 31 帧），Node 的 `zstdDecompressSync` 只解第一帧（得 243 B），必须按 `28 b5 2f fd`
     魔术字切帧后逐帧解；③ **WebView 在后台会挂起 fetch**（表现是 evaluate 永不返回）——
     必须先把 App 拉到前台（`monkey -p com.dsharnessmobile.shell -c android.intent.category.LAUNCHER 1`）。

153. **看门狗熔断的「永久锁存」与启动预算互斥：半死引擎下自动 undo 与自动重启双双永久失效**
     （存量缺陷，0.14.1 修复；用户口径「引擎崩溃时自动 undo 并重启是不是失效了」的直接真因）：

     现象（审计结论，非设备复现）：`WatchdogV2.planTick` 中 `tripped()` 一旦为真即返回**永久**
     `HOLD`，只有 HEALTHY 探活或 `EngineStartFlow` 里**唯一一处** `WatchdogV2.reset()` 能解。
     而熔断在 `effectiveFailureCount >= MAX_CONSEC_FAILURES`(12) 时打开，看门狗 5s/拍 ⇒ **60s**；
     托管子进程的启动预算 `START_COOLDOWN_MS` 却是 **90s**。

     真因：`tripped()` 的判定原本排在 boot-window 与 `undoReady()` **之前**。于是当引擎
     **进程存活但 HTTP 永远不健康**（半死 / 插件树挂住 / 端口可连但 serve 不响应）时：
     ① 计数器先撞满 12 拍打开熔断（60s）；② 熔断早退使 `undoReady()` **此后永不被求值**；
     ③ undo 的两阶段闸门（`OnProbeFailure` 需先 arm、再过 `WATCH_MS`=15s 才放行）连第一步都
     走不到。结果 = **自动 undo 与自动重启同时永久失效**，且没有任何日志（见下条观测盲区）。
     对照：真·反复死亡（进程不存活）路径正常——第 9 拍(45s) 就在熔断(60s) 之前触发 undo，
     故该缺陷**只在「半死」形态下显现**，这也解释了为什么它长期未被发现。

     修法（两处，正交）：
     ① `planTick` 把 `undoReady()` 提到 `tripped()` **之前** —— 配置回滚与「禁止盲目重启」是
        两种正交恢复手段，不应互斥。熔断继续守它该守的「undo 不可用时不得盲目反复重启」；
     ② undo 成功路径（`EngineService` 的 UNDO 分支 + `EngineStartFlow.maybeAutoUndo`）补
        `WatchdogV2.reset()` —— undo 成功正是「引擎应当重新可用」的时点，不复位会让恢复后的
        世代被上一次的失败计数白白锁住。
     附带同族修复：`EngineStartFlow.kt:256` 原先传 `WatchdogV2.consecutiveFailures`（该计数在
     DEGRADED_HTTP 下恒被清零）→ 改为 `effectiveFailureCount()`，与看门狗侧同口径；
     DEAD 下两者相等，故真死亡路径时序不变。

     不可回退的两条不变量（已写成断言）：① `DEAD` 路径第 9 拍触发 undo 的时序不得回退；
     ② 熔断对「undo 不可用 + 真·反复死亡」的保护不得被削掉——反向对照
     `circuitBreakerStillBlocksBlindRestartWhenUndoIsUnavailable` 与
     `bootWindowStillGuardsALiveChildFromUndo` 锁住这两条。

     防线（本缺陷能存活至今的根因是「恢复判据无防线」）：`WatchdogLadderTest` 原先**全部**
     `undoReady = { false }`、且**没有任何用例断言 `TickAction.UNDO`**；`UndoGate` 本身零测试。
     本轮补：`WatchdogLadderTest` 四个新用例（正向 undo、真实半死场景、熔断保护反向对照、boot
     预算保护）+ 新增 `UndoGateDecisionTest`（把闸门四态判定抽成纯函数 `UndoGate.decide` 后直测，
     含 WATCH/RETRY 两个窗口的边界值）。判红证据：修复前正向用例得到 `HOLD(circuit-open)`、
     半死用例 `undoReady` 求值 **0** 次。

     教训：**「防抖/熔断」类锁存与其要保护的「恢复动作」若共享同一拍决策链，必须显式排定顺序
     并各写一条断言**——否则「保护」会静默吞掉「恢复」，而且吞掉时既不报错也不留日志。

154. **默认配置下「自动 undo 是否跑过」零观测面：`LogCollector.log` 受 DevLogPrefs 闸门**：
     `LogCollector.log` 在 `appContext == null` 时**直接 return**，而 `appContext` 仅在
     `LogCollector.start` 内设置，后者受 `DevLogPrefs.isEnabled` 闸门且**默认 false**
     （`MainActivity.kt` 的 `dev_log_enabled` 缺键即 false；`EngineService.onCreate` 亦按此判）。
     后果：默认设备上 `auto-undo trigger` / `auto-undo not executed` / `restart requested` 这类
     **看门狗叙述行全部落空**，用户无法判断自动回撤到底跑没跑——这正是「感觉自动 undo 失效了」
     的直接来源（机制其实正常，缺的是证据面）。

     修法：`UndoGate` 自带独立判据落盘 `files/undo-gate.log`（前缀 `dsh-undo-gate`，
     **不经 DevLogPrefs 闸门**，64 KiB 轮转一代），在 arm / trigger / suppress / execute 成功
     / execute 失败 / 各 abort 分支（CLI 缺席、list 超时、无快照）逐点留痕；同时仍双写
     `LogCollector.log`（采集器打开时两处都有）。
     单条取证：`adb shell run-as <pkg> cat files/undo-gate.log`。

     通用判据：**「关键恢复动作是否执行」不得只依赖可开关的调试日志面**——必须有默认在产的
     判据文件或 marker（`.undo-auto-done` 即此范式）；否则用户与排障者都只能靠「感觉」。
156. **`java.util.stream.Stream.toList()` 是 API 34 才有的方法：minSdk 26 下真机必崩且 catch(Exception) 抓不住**：
    现象（真机实锤，华为 NOH-AN00 / **Android 31** / 出厂 0.14.0 vc39，反馈目录
    `报错反馈/0.14.0/20260919-125714-engine-died-during-boot/`）：`engine-died-during-boot` exit=1，
    logcat 里 12:55/12:56/12:57 三时点、主线程与工作线程**反复**同一条硬崩溃：
    `java.lang.NoSuchMethodError: No interface method toList()Ljava/util/List; in class Ljava/util/stream/Stream;`
    → `at com.dsharnessmobile.shell.SnapshotFs.deletePath(SnapshotFs.kt:50)`
    → `SnapshotTransaction.finish` → `EngineManager.applyRecovery` → `recoverInterruptedRefresh` → `EngineService.ensureEngine`。

    真因：`Files.list(dir).use { it.toList() }` 里的 `toList()` 是 **Java `Stream.toList()`**
    （Java 16 引入，`api-versions.xml` 实测 **since=34**），不是 Kotlin 的 stdlib 扩展。项目 `minSdk = 26`
    → API < 34 设备上该接口方法不存在，抛 `NoSuchMethodError`。

    **为什么比普通崩溃更严重（后果链）**：① `NoSuchMethodError` 是 **`Error` 而非 `Exception`**，
    `deletePath` 的 `catch (e: Exception)` **根本抓不住** → 直接打穿整条恢复链；
    ② 恢复流程**永远无法完成**，marker 保留（`recovery marker retained`）→ **快照刷新/恢复在
    Android < 34 上永久卡死**，用户装了新 APK 也可能拿不到新基线（正是「更新后无需操作即得最新基线」
    这一用户诉求被打破的根因之一）。

    修法：改用 `Files.newDirectoryStream(dir).use { it.toList() }` —— `DirectoryStream<Path>` 是
    `Iterable` + `Closeable`，Kotlin 的 `toList()` 是 **stdlib 扩展**（无 API 级别依赖），
    `use` 保证关闭；语义等价（只列直接子项、不跟随符号链接、项读取失败记 onFailure 并跳过）。

    **为什么既有测试拦不住（关键教训）**：JVM 单测跑在 **JDK 17** 上，`Stream.toList()` 在那儿存在
    → 单测恒绿、设备必崩。这是「宿主机 JDK 面 ⊃ 设备 API 面」的**系统性盲区**，只能靠静态 API 守卫补。
    新增 `ApiLevelGuardTest`（禁用清单 + 词法扫描器，已带反证：回退该行即判红）。

    **同类自查（本轮全仓扫描 115 个 .kt 的结论）**：命中 1 处（即本坑），已修；其余疑点均判安全——
    `SnapshotUserData.kt:106` 用的是 `Stream.forEach`（since=24，安全）；`SnapshotTransaction.kt:240` 的
    `File.listFiles()` 是老 API（安全，未混入 Stream）；全仓 23 处 `.toList()` 里其余 22 处接收者均为
    Kotlin 集合/Sequence/FileTreeWalk（stdlib 扩展，安全）。**注意区分两类 `.toList()`**——
    用 grep 全仓搜 `.toList()` 会命中大量安全用法，不可据此改动。

    **扫描器自身的坑（本轮自伤一次，值得记）**：写静态守卫时，若用「本行是否含块注释起始符」判注释，
    会被 `ConfigTransfer.kt` 的 MIME 字面量（图片通配、任意类型通配）**误入块注释态**，静默丢掉
    3273 行代码（占全仓 18%，EngineManager/BrowserHost/NotifyCenter 成片漏扫）→ 防线大面积假绿。
    正确做法是**真正的词法扫描**：先剥字符串、再剥注释（顺序不可颠倒），并断言扫描面覆盖量防止回归。

157. **公开仓泄漏面：设备序列号以「测试注释/夹具」形态随**新文件**混入（0.14.1 P0-c 实锤）**：
    现象：`app/src/test/.../ShellOpsScopeTargetTest.kt` 的注释里写了「设备实测夹具（`emulator-<4 位端口号>` /
    Android 15 / API 35）」，而该文件是**本轮新增的 untracked 文件**（`git show HEAD:<path>` 不存在），
    会随 PR 进公开仓 `kelai141/dsh-mobile-apk`。用户硬要求：设备拓扑（serial / boot_id / 本机路径）
    **只能进协调仓 `docs/`，绝不进公开仓**（`docs/DEVICE-TOPOLOGY-PRIVATE.md` 首段为权威口径）。

    真因：序列号写在「设备实测夹具」这类**注释**里，形态上像技术细节、评审时极易放过；而它在
    **HEAD 中零出现**——「HEAD 零命中」不是安全证据，因为**新增即引入**：
    泄漏判据必须是「会不会进提交面」，不是「历史里有没有」。

    修法：统一写**仓内既有惯例的抽象表述**「MuMu x86_64 模拟器 / Android 15 / API 35」；
    端口 `127.0.0.1:16384` / `:16416` 是既存公开约定（`shell-ops.test.mjs` 等已在用），可保留；
    `emulator-55xx` 形态的 serial、boot_id、本机绝对路径一律不写。
    **本文自己就是反例**（本条初稿把 serial 逐字写进了公开仓，自查时才发现）——记述这类缺陷时
    必须用占位式（`emulator-<端口号>`）而不是逐字复述，否则「讲泄漏」的文档本身成为泄漏源。

    复验（只扫**会进提交的面**，别扫本地产物）：
      `git ls-files`（已跟踪）∪ untracked 且**未被 gitignore**（`git check-ignore` 不命中），
      再 grep 该 serial 形态。**不要**对全树 `Get-ChildItem -Recurse`：`.kotlin/errors/`、
      `.deploy-tmp/`、`build/` 这类本地产物会淹出数十处噪声（本轮实测 87 处），把真泄漏埋掉。

    配套铁律 5：**逐字节镜像（robocopy）前先确认源侧已脱敏**——镜像会把源侧的序列号原样搬进公开仓。
    本轮 `plugins/dsh-android-manage/**` 的镜像就曾把 coord 侧的 serial 带进 apk 工作树
    （3 文件，其中 `test/a11y-routing.test.mjs` 是 TRACKED），故正确顺序是「先脱敏源侧 → 再镜像 →
    再校验双仓逐字节一致且公开仓 serial 命中为 0」。
    gitignore 的 `plugins/*/lib/` 会覆盖 `lib/*.revbak` 等未跟踪产物，那类不入库、无需处理。

158. **补偿动作（catch 里的回滚/清理）会掩盖真因：`deletePath` 逐项容错 → move 到非空目录 → 次生异常取代原始异常（0.14.1 升级路径 P0 实测）**：
    现象（16384 覆盖安装 0.14.0 → 0.14.1）：`.snapshot-transaction` 永久停在 `phase=SWAPPING`（27 分钟不收敛，
    AGENTS 窗口 8–12 分钟），残留 `.snapshot-previous` 922MB + `.snapshot-stage` 160MB，**live 插件树只剩 1/10**
    （`@dsh-android/` 仅 `dsh-android-browser`）→ `dsh-host-web-compat` 缺席 → polyfill 未注入 →
    页面 `Failed to load plugins: … Iterator is not defined`。引擎活着、页面能开，**但插件面整体不可用**——
    比「全旧」或「全新」都糟，因为没有任何用户可见的「升级失败」提示。
    真因（栈已定位到行）：`SnapshotTransaction.mergeProfiles` 的 catch 块旧实现是裸三行
    `deletePath(liveProfiles); move(previousProfiles, liveProfiles); throw t`。而 **`SnapshotFs.deletePath`
    是逐项容错的**（删不掉的子项记 `onFailure` 后继续遍历）→ 它可能**正常返回而目录仍非空** →
    紧接着 `move` 到非空目标抛 `FileSystemException: … Directory not empty`。该次生异常**取代了 `throw t`**，
    于是**原始异常（真因 + 栈）被彻底掩盖**：logcat / 日志里只剩 `Directory not empty`，排障者拿不到真正的失败原因。
    连带：`EngineManager.refreshSnapshot` 的 rollback 走同一路径也失败 → 走
    「rollback failed; recovery marker retained」→ marker 永久留存、**每次启动重试、每次同样失败**（实测重启 3 次仍 SWAPPING）。
    修法：① **补偿一律不得取代真因**——补偿用 `try/catch` 包住，次生错误 `addSuppressed` 到原异常上、
    始终返回/抛出原异常；② **删除失败必须有兜底**——目标仍非空时不再 move 到非空目录，改为把目标
    **改名挪开**（改名只动父目录项、不递归子项，是文件系统层面最后可用的手段）。
    复验：行为级单测 `mergeCompensationNeverMasksTheOriginalFailureAndRecoversTheBackup`（构造 previous 缺席
    使补偿必然失败 → 断言交回的是**原始异常**且次生错误进 suppressed）；反证把 `addSuppressed` 换成
    `throw compensation` → 判红并打印
    `expected same:<IllegalStateException> was not:<NoSuchFileException …>`。
    **为何极易漏测**：全新安装（`uninstall` → `install`）**不触发**该路径，只有**覆盖安装**才走 `swap + mergeProfiles`——
    必须专门跑升级路径。
    配套教训（诊断面）：`refreshSnapshot` 只回布尔值，调用方只能写「返回 false」，导致 `boot-fail.log` 出现
    `error=none(boolean-failure-path)` 这种**不可排障**的形态（用户反馈一「日志与事实不符」的同形复发）。
    故「布尔返回值」的失败 API 必须另设**真因出口**（本例 `EngineManager.lastRefreshFailure`），否则等于没日志。
159. **「修了但没修」：两处写同一个裸字符 = 恒等替换，而单测类路径上的另一份 org.json 让断言假绿（0.14.1 执行地图排查实锤）**：`jsString` 号称把 U+2028/U+2029 转成 `\uXXXX` 文本，实际 `AndroidBridge.kt:420-422` 的 `.replace(<裸 U+2028 字符>, "\u2028")` 在 Kotlin 里两侧编译成同一个裸字符 → 返回原串；而 JVM 单测类路径上有 `org.json:json`（其 `quote()` 自己会转义行分隔符），断言「结果里没有裸字符」依然通过 → **生产没修、单测绿**。真因：① 源码里 `\\u2028` 与 `\u2028` 只差一个反斜杠，写文件时反斜杠被折叠过多次（本仓有前科）；② 断言测的是「结果形态」而不是「替换发生了」，两种实现都能满足。修法：方向定型为「裸字符 → 转义文本」，抽纯函数 `escapeLineSeparators(quoted)`；单测直接判形态（`assertNotEquals(raw, escaped)` + 期望 `a\u2028b` 的转义文本形态）再叠加端到端断言。复验：`./gradlew :app:testDebugUnitTest --tests "com.dsharnessmobile.shell.BrowserHostNavigationPolicyTest"` 9 例 0 失败。**教训：被测函数依赖第三方实现时，只有纯函数面的形态断言才是真判据。** grep `escapeLineSeparators`。
160. **JS 字符串字面量里的 `\w`/`\d` 有被吞风险：正则静默失效，门禁「在跑」其实什么都没查（0.14.1 建执行地图门禁时实锤）**：`new RegExp('([\w.@-]+\.(?:kt)):(\d+)')` 落盘后反斜杠消失，正则变成要求字面 `w` → 锚点一个都匹配不到，而 `--self-test` 反而更容易全绿（「没有命中」被当成「没有违规」）。修法：**字符串里完全不写反斜杠**——`\w` 用 `A-Za-z0-9_`、`\d` 用 `[0-9]`、`\.` 用 `[.]`；自检必须带「正例必须命中、反例必须不命中」的判别样例。复验：`node scripts/check-code-map.mjs --self-test`（8 例全绿）。grep `PATH_GROUP`。
161. **把「尚未探测」渲染成「未就绪」= 让模型放弃一个可用能力（0.14.1 设备实测，缺陷 A1）**：用户会话里状态区显示「Shizuku 特权通道：已授权」且虚拟屏已建成，而同一时刻工具面 `android_capabilities` 报「Shizuku 特权通道：未就绪（**虚拟屏建屏需要它**）」。模型的下一步推理逐字是「Shizuku isn't ready, which means I can't create a virtual display」——**它据此绕开了当时完全可用的路径**。
    真因：工具面读 `svc.shizukuReady()` → `controlQueue.stats().caps.shizuku`，而 `caps` 只随**执行过的控制 op 的回执信封**抵达（`ControlQueue.noteShell` 的唯一调用点在 `POST /api/android/ui/result`）；`android_capabilities` 自己不入队 ⇒ 会话首次询问它时 caps 必然缺席，旧实现把这个「缺席」折成 `false` 并渲染成「未就绪」。壳侧真值一直是活的（`VdisplayController.status → ShizukuTransport.status` 每次重探）。
    修法：**三态**（`true` 就绪 / `false` 已实测未就绪 / `undefined` 尚未探测到）+ caps 缺席时引擎补探一次（`AndroidPrivilegeService.shizukuChannelProbed()`：TTL 内只打一发、探测失败保持 undefined、绝不降级成 false；补探用 `vdInfo`——它**不在** `TIER_REQUIRED_OPS` 内，注释明写「读面/管理面不纳入」，故无需会话档位）。三分文案里「未知」必须给出**可执行动作**（直接试建屏），不得劝阻。
    复验：`node --test plugins/dsh-android-bridge/test/{capability-gate,shizuku-caps-probe}.test.mjs`；反证是「探测失败必须仍为 undefined」与「三态必须是三条不同文案」。grep `shizukuChannelProbed`。
162. **两份「会读设备屏的 op」清单漂移 → 缺省范围下大面积工具不可用，而两侧都自认正常（0.14.1，缺陷 B4/B6）**：引擎 `screen-scope.ts` 的 `REAL_SCREEN_CONTROL_OPS`（8 条）与壳侧 `DeviceControlService.REAL_SCREEN_OPS`（**11** 条）不一致，多出的 `state`/`webSnapshot`/`webAction` 是 `control-policy.ts` 的 `A11Y_OPS`（**后端能力**清单）的陈旧拷贝，与「是否读设备屏」无关：`state`（`handleState`）只回内存快照代次/失效标记且**签名不收 args**，`web*` 的目标是壳自有 WebView。
    后果链：这三条都不带 `screenId` ⇒ 壳侧范围门取默认 `real` ⇒ `virtual-only`（**缺省即此**，fail-closed）下恒拒。于是 `android_web_dump`、`android_ui_click`/`android_ui_input` 的 WebView ref 路径、以及点击**生效校验**（`verifyClick` 读 `state`）在缺省范围下一律报 `screen-out-of-scope`——用户看到的「点击成功但校验被阻止」「virtual-only 和不存在一样」有一半出自这里。
    修法：**壳侧收敛到 8 条**（不是把引擎扩到 11——那只会把过度拦截搬进引擎层），并新增 `scripts/check-op-registry-parity.mjs` 把两份清单锁成逐条相同（跨语言契约，不是实现细节）。复验：`node scripts/check-op-registry-parity.mjs`（自证含「壳侧多 3 条」这个原形反例）。grep `REAL_SCREEN_OPS`。
163. **工具声明了它执行不了的参数：`android_act_input` 的 `screenId` 永远无法兑现（0.14.1，缺陷 B1）**：该工具在参数表里声明 `screenId`（并因此进 `SCREEN_ACTIONS` 被范围门裁决），执行面却是 `input <verb> <args>`——`/system/bin/input` **没有屏幕维度**；范围门对这条命令在 `bridge/index.ts` 直接早退（命令里没有任何目标屏 token，无从核对注册表）恒判拒绝。模型于是反复重试一个不可能成功的参数。
    同族第二种形态：`android_ui_tree` 收 `screenId` 但只有 `uiautomator dump` 一条路，而 `uiautomator` 家族的目标屏参数被判为「无」⇒ 恒拒（本仓设备读数曾把 `uiautomator dump --display 10` 当成功证据，见坑 165）。
    修法：act_input 目标为虚拟屏时改走既有 `vdInput`（`input -d <displayId>`，argv 原生构造，text 作单个 argv 元素直传故不受 ASCII 白名单限制）；`ui_tree` **删掉** `screenId` 参数（它本就只能读默认屏），范围门据 `requested=undefined` 判 real，virtual-only 下给出「当前范围不含真实屏 + 改用 android_ui_dump」的可执行文案。
    复验：`node --test plugins/dsh-android-manage/test/a11y-routing.test.mjs`（含「虚拟屏路径不得再拼真实屏 input 命令」「不带 screenId 的原路径不得被改坏」「壳侧拒绝不得谎报成功」）。**判据：工具声明的每个参数都必须有一条能兑现它的执行路径。**
164. **`am` 退出码 0 ≠ 落在目标屏；且 16 KiB stdout 上限会把虚拟屏那一段吃掉（0.14.1，缺陷 C1）**：跨屏拉起修复前只判 `result.optBoolean("ok")`（=走 Shizuku UserService 的 `Process.exitValue()==0`）就报「已拉起到 virtual-N；真实屏前台不变」。设备实测（MuMu x86_64/API 35）：目标包已在真实屏有 task 时，`am start --display 2 -n <comp>` **仍回 0**，只多打印一行 `Warning: Activity not started, intent has been delivered to currently running top-most instance.`——这句话在成功分支被丢弃（只读 `ok`，不读 `stdout`）⇒ **假成功**。
    第二个坑在取证手段本身：回读要用 `dumpsys activity activities`（42 KB），而 `ShizukuUserService.exec` 的 `OUTPUT_LIMIT = 16 * 1024` 且**读到上限就 break**；display 段按号**递增**排列 ⇒ 截断掉的恰好是虚拟屏那一段，回读会得出**反向错误结论**。修法：服务端先过滤（固定字面量 `dumpsys activity activities | grep -E '^ *Display #|ActivityRecord'`，实测 1,969 B），再按 `Display #<n>` 分组 + `ActivityRecord{` 行 + `包名/` 精确前缀解析（**不得**用 Task 行的 `A=…:pkg` affinity 判落点）。
    三态如实回报：包在目标屏 → `vd-launched`；只在别的屏 → **`ok=false` + `vd-launch-denied`**（带 `landedDisplayIds`）；读不到 → `vd-launched-unverified`（明写「不构成落点证明」）。复验：`./gradlew :app:testDebugUnitTest --tests "com.dsharnessmobile.shell.VdisplayLaunchLandingTest"`（6 例，样本取自真实设备输出）。grep `displaysRunning`。
165. **`uiautomator dump --display <n>` 会被收下但不生效：本仓曾把真实屏的树当虚拟屏证据（0.14.1 判定性实测）**：`known-gaps.md` 曾记「`uiautomator dump --display 10` → 1916 B 真实节点表」并据此讨论 a11y 可达性。2026-09-19 判定性实测（虚拟屏 `virtual-1` displayId=2、其上已放 Settings 且 `dumpsys` 确认 task 在 display 2）：无参 dump / `--display 2` / `--display 0` 三者输出**逐字节相同**（7799 B、19 节点、全是真实屏上的应用），即 `--display` 对 uiautomator **无效**——它恒 dump 默认屏。
    结论：`screen-scope.ts` 把 `uiautomator` 家族的目标屏参数判为「无」**实质正确**，不得放开；要修的是上层工具面（见坑 163）。**教训：把「命令没报错」当成「参数生效」是同一类误读——判定性实测必须让两个取值产生可区分的输出**（彼时虚拟屏是空的，空 vs 满本可区分，却没有做这一比）。
166. **从 Git Bash 跑构建链会触发「假红」：子进程 `tar` 变成 MSYS 版，把 `D:\…` 当远端主机（2026-09-19 两次打包实锤）**：在 Git Bash 里 `pwsh -File scripts/build-apk-013.ps1 -Fast`，PATH 里 `/usr/bin` 在前的 `tar` 被注入完整性门禁继承，于是 `tar -tf D:\coding\...\snap-final2.tar.xz` 被 GNU tar 解析成「主机 `D`」，报 `tar: Cannot connect to D: resolve failed` → 门禁判「注入产物成员不完整」并拒绝打包。**这不是缺陷，是环境**：同一棵树在 PowerShell 里跑全链是绿的。
    修法（二选一）：① 把构建链放在 **PowerShell** 里跑（推荐）；② 必须在 Git Bash 里跑时，显式把 Windows 目录提前：`PATH="/c/Windows/System32:/c/Windows:$PATH" pwsh -File scripts/build-apk-013.ps1 -Fast`（这样 `tar` 解析到 Windows bsdtar）。
    同族陷阱（同一轮踩过，一起记）：`robocopy` 的参数 `/MIR /XD` 会被 MSYS 路径转换吃掉（报 `ERROR 2 ... plugins$p\`，rc=16 一文件未拷）→ 加 `MSYS_NO_PATHCONV=1` 且**用正斜杠**写源/目标（`robocopy "plugins/$p" "dsh-mobile-apk/plugins/$p" /MIR /XD node_modules`）。**判据：打包失败先看报错是不是「路径/工具被解释错」，再怀疑代码——本轮两次都不是代码问题。**
167. **渐进披露的解锁前置对模型不可见：模型如实报「工具不存在」，用户看到的是「工具全不可用」（2026-09-19 设备实测，用户第三问的另一半真因）**：`capability gate` 在 `agent/created` 时把 `DEVICE_TOOLS` 全部掩蔽，只有模型**主动调用 `android_capabilities { group }`** 才逐组解锁；而组锁存在内存里 ⇒ **引擎每次重启（重装/崩溃重启/换版本）都重置**。实测现场（MuMu x86_64 / MiMo 2.5 / 新装包）：用户（与套件）说「把应用拉到虚拟屏上」，模型的回答逐字是
      - 「DONE — `android_app_launch` **不在当前可用工具列表中**，无法执行。」
      - 「DONE — but the required tool (`android_shell_exec` or `android_ui_click`) **is not available in my current environment**, so the click could not actually be executed.」
      **它没说谎**：那一刻工具列表里确实没有 `android_*`。用户看到的现象因此是「各种工具在 virtual-only 状态和不存在一样完全不可用」——与范围门、通道状态都无关，纯粹是**解锁前置没有被工具面暴露出来**。弱模型（本项目专用测试模型 MiMo 2.5）不会自己去读 skill 目录猜出这一步；强模型可能靠 `android_capabilities` 的存在硬撑过去——这正说明「拿强模型验收」会掩盖该缺陷。
      当前处置（不改设计、先让验收可跑）：设备套件在任务文案里显式写明「先调 android_capabilities 解锁 phone 与 virtual-display 组」这个**环境前置**（`verify-screen-scope-matrix.mjs` 的 `UNLOCK_PRECONDITION`）。
      **未修的真缺口**：解锁应有**可发现性**——候选修法：① facade 工具的描述里直写「设备工具默认掩蔽，先调我」；② 首次 `agent/created` 时不掩蔽、改为按首次调用自动解锁；③ 在工具列表里保留一个不可调用的占位说明。三条都要另做取舍（涉及 wire 预算与「模型第一眼看不到设备工具」的原设计意图），故本轮只登记，不擅自改。
168. **「只有 ADB / 纯 Shizuku」下控件树曾经只有一条烂路：`android_ui_tree` 只回 XML 文件路径（2026-09-19 用户实报 + 本轮实修）**：用户口径「猜像素就是折磨」，要求 `android_ui_tree` 做到**与无障碍同等体验**。修前实测该工具的成功返回只有 `treeXmlPath`（一个本地文件路径）+ 一句「控件树已导出」，**既不产出 ref、也不写 `uiCache`**，因此模型拿到它之后**无法用 `android_ui_click/scroll/input` 按 ref 操作**，只能自己读 XML 或猜像素——而它的描述又写着「【ADB 专属 / 兜底】……日常优先 android_ui_dump」，在纯 Shizuku（无障碍关）下 `android_ui_dump` 恒不可用，等于把模型支去撞墙。
    真因是**接线缺失，不是能力缺失**：uiautomator XML 的解析器与剪枝/落明细/写缓存管线**早就存在**（`plugins/dsh-android-manage/src/ui-tree.ts` 的 `parseUiTreeXml`/`checkUiTreeParse`/`pruneNodes`），只是 `android_ui_dump` 的 ADB 回退在用、`ui_tree` 没用。
    修法（单一来源，禁止两份实现）：把那条管线抽成 `uiautomatorTree()`，**两个工具共用**；schema 抽成 `TREE_SCHEMA`、行渲染抽成 `nodeListLines()`，`treeOutput()` 两处共用——「同等体验」因此是**构造上成立**的，不靠两份代码保持同步。描述改为「ADB / 纯 Shizuku **主路**」，明写「无障碍未开启时这就是控件树的唯一来源」与「只读默认屏（虚拟屏走别的路）」。
    判据（可判红，`plugins/dsh-android-manage/test/ui-tree-parity.test.mjs`）：① **同形**——两工具的 `output.schema` 逐字段深度相等（漂移即回归）；② **可用**——无障碍关时 `ui_tree` 返回节点数组、`count===nodes.length`、带 `detailHandle` 与每节点中心坐标；③ **可操作**——清单里的 ref 经 `android_ui_click` 必须恰好注入一次 `input tap <cx> <cy>`（模型只报 ref，**像素由引擎算**）。
    实现坑（同轮踩过）：共享 output 一旦把 schema 根放宽为 `json`，`render` 的参数就会被上下文推断取代——**独立 const 的 render 拿不到上下文类型会退化成隐式 any**，参数显式写成 `unknown` 才逆变兼容；另外 `schema` 抽取时别把外层的 `schema:` 包装一起套进去（运行时会报 `UNSUPPORTED_SCHEMA`，而 TS 因为 `as unknown as` 完全不报）。
169. **通知消费只靠一次文件事件：事件一丢就永久停摆，而「另一个消费者还活着」把现场伪装成正常（0.14.1 真机实报 + 本轮实修）**：真机（V2425A / arm64 / SDK 36）上用户报「消息有但不弹横幅；必须划到后台才收到」「悬浮球长按查看汇报没有内容」。取证三份文件给出**同一个**形状：`files/home/.dsh/.notify.ndjson` 从 8810 长到 9402 B（引擎确实写出了 `kind=report` 行），`shared_prefs/dsh-notify.xml` 的 `notify.offset` **冻在 8810**，`files/notify-responder.log` 里没有任何 `kind=report` 的投递记录。即「文件在长、指针不动、一条也不投」——而同一时刻 `WatchdogV2` 的 `notify-debug.log` 还在按时更新，于是「通知面整体是活的」这个假象成立。
    **真因（结构性）**：`NotifyStore.drain` 的触发点只有两个——`FileObserver` 的事件回调与进程启动时那一次；`NotifyStore` 内**没有任何 Timer/Handler/协程**。一次事件丢失（watcher 构造失败被吞、落盘方式换成「临时文件 + rename」而位集只有 `MODIFY|CREATE`、目录 inode 被换掉导致 inotify 监视静默失效——快照重解包就会重建 `files/home/.dsh`）即**永久停摆**；而 poll 驱动的 `WatchdogV2.consumeTaskDoneMarkers` 照常工作，正好解释「旧信道还活着、新信道死了」的不对称。
    **可控复现（无需等真机复发，MuMu x86_64 实测）**：给同一个 inode 建第二个目录项，从那个名字追加——事件名不是 `.notify.ndjson`，白名单直接忽略，而文件长度确实在长：
    ```bash
    S=127.0.0.1:16416
    adb -s $S shell "run-as com.dsharnessmobile.shell ln files/home/.dsh/.notify.ndjson files/home/.dsh/.notify-inject"
    printf '%s\n' '<一条真实的 report 行>' | adb -s $S shell "run-as com.dsharnessmobile.shell sh -c 'cat >> files/home/.dsh/.notify-inject'"
    # 20 s 后：文件 8733 -> 9064 B，而 notify.offset 仍是 8733，探针零 dispatch  ← 复现成功
    ```
    修法（三条互补，缺一条都不够）：① **兜底驱动**——`NotifyStore.drainTick` 挂到**既有看门狗 tick**（`EngineService` 每 5 s 一拍、持唤醒锁，且是现场唯一被证实还活着的消费者），不自起 Handler（多一处生命周期 = 多一处和事件一起死的东西）；② **监听位扩到 `MODIFY|CREATE|CLOSE_WRITE|MOVED_TO|DELETE|MOVED_FROM`** + 白名单命中 `FILE_NAME`/`ROTATED_NAME`/`path==null`；③ **`drain` 加锁 + 先投递再推进偏移**（三个驱动者并发跑同一份 offset 会重复投递——现场实测同 id 80 ms 内被投 5 次；先推进再投递则会静默丢）。
    取证面同时补齐：每行消费记 `notify drain trigger=<start|tick|watch:名字> … offset a->b len=n`，tick 每 5 分钟记一行 `notify tick alive ticks= lag= watchEvents= watchEventAgeMs=`——**「文件在长但 watchEventAgeMs 一直很大」就是 watcher 失聪**，这一对读数把下次复发的定位从「三份文件对表」压到一行。
    判据（可判红，`NotifyConsumptionStallTest.kt` 五例 + `NotificationContractTest.消费必须有事件之外的兜底驱动`）：①监听位必须含 `MOVED_TO`/`CLOSE_WRITE`（旧位集必红）②`drainStep`/`advanceOffset` 的 Skip/Rotated/Read 与单调性③同 id 同内容窗口内判重复、内容变/窗口外/换 id 不判④尾部倒读只取最后一条 report 行且丢弃被截断的首行；**外加源码级断言「兜底入口写了必须真被 tick 调用」**——防「兜底写了没人调」这类新型假绿。
170. **`seedPhoneControlPreset` 对缺席文件直接 `readText()`：phone-control 预设在任何**干净安装**上恒「加载失败」，且每次启动重试都不自愈（0.14.1 真机实锤，本轮实修）**：预设页「自定义」下 `phone-control` 恒挂红标「加载失败」，文案逐字为 `the composition file agent.cordis.yml is missing — the directory still occupies the id; delete it or restore the file`。
    取证三份事实**互相排除**：① `logcat` 有 `W dsh-engine: phone-control preset seeding failed` + `java.io.FileNotFoundException: …/.agent-presets/phone-control/skills/phone-control/SKILL.md: open failed: ENOENT (No such file or directory)` + `at com.dsharnessmobile.shell.EngineManager.seedPhoneControlPreset(EngineManager.kt:475)`，且**每次引擎启动都在同一行重炸**（实测某次启动的 9 ms 内连发 4 轮）；② `.agent-presets/phone-control/` 四个层级目录的 mtime **精确到纳秒完全相同**（= 一次 `mkdirs()` 的产物）、目录内**文件数为 0**；③ 以**同一 uid** 手工向同一路径写文件**成功**，`/data/user/0/…` 与 `/data/data/…` 两种写法均可 ⇒ **不是权限、不是属主、不是路径解析**。
    真因：`if (skillFile.readText().trim() != PHONE_CONTROL_SKILL.trim())` —— `File.readText()` 在文件缺席时**抛 `FileNotFoundException`**（不是返回空串，Kotlin 没有「读不到给默认值」的语义）。该异常被本函数外层的 `catch (t: Throwable)` 吞掉，函数**当场返回**，于是它后面的三步**一步都没跑**：`customSkillDirs` 注入、`agent.cordis.yml` 从内置 `standard` 预设拷贝、`preset.yml` 写入。而函数末尾的幂等早退判据正是 `if (File(dir, "preset.yml").exists()) return` ⇒ `preset.yml` 永远写不出来 ⇒ 每次启动都从同一行重炸，**永不自愈**（这是确定性死锁，不是偶发）。
    回归出处：#141「fix: phone-control 预设 SKILL 每次启动刷新」把播种语义从「**只在缺失时**播种」改成「**每次启动刷新**」，顺手假设了文件一定在场——而它的验证写的是「**设备侧已热修验证**（`SKILL.md` 含 `android_ui_global`，grep=1）」，热修的前提恰恰是**那台设备已经有这个文件**（#138 播过种）⇒ **干净安装路径从未被测**。#190 在同一段之后追加 frontmatter 与 `customSkillDirs` 注入，验证括号同样明写「存量升级路径验证」，也够不着这条路。**教训：把「刷新」从「缺失才做」改出来时，必须专门验一次「目标不存在」的初态；热修验证天然带着已存在的现场，不能当干净安装的证据。**
    修法：先判在场再读，缺席视同「需要刷新」——`val existingSkill = if (skillFile.isFile) skillFile.readText() else null`，随后 `if (existingSkill?.trim() != PHONE_CONTROL_SKILL.trim())`。
    判据（可判红，`CallSiteContractTest.phoneControlSeedingToleratesAnAbsentSkillFile`）：① 真源表达式 `if (skillFile.isFile) skillFile.readText() else null` 必须在场；② 裸读形态 `skillFile.readText().trim() != PHONE_CONTROL_SKILL` 必须消失——**撤掉守卫即红**。为何用源码契约而非行为测试：`seedPhoneControlPreset` 依赖 `Context`（`context.filesDir` / `context.assets`），纯 JVM 拿不到，与 `CallSiteContractTest` 头部自述的适用面一致；判据一律走 `memberBody` 取函数体（整文件正则跨进相邻成员会误报，见该类教训）。
    设备复验（真机实测，0.14.1）：补一份在场 `SKILL.md` 后重启引擎——`logcat` **首次出现**成功路径的两条日志 `phone-control preset seeded -> …` 与 `phone-control preset: customSkillDirs injected into skill-filesystem row`（修复前从未出现过），`agent.cordis.yml`（13054 B）与 `preset.yml`（187 B）落盘；`agent.cordis.yml` 与内置 `standard` 逐字 `diff` **只差注入的那 3 行（+126 B）**，故与能正常加载的 `standard` 同源，加载性有保障。**注意（勿写错）**：`customSkillDirs` 注入与播种在**同一次启动内**先后完成（19:51:22.825 播种 → .835 注入，间隔 10 ms），因为 `shellEnv()` 在启动路径上会被调用多次 ⇒ 函数第二轮即走到注入分支；不要写成「要下一次启动才生效」（初稿曾如此断言，实测推翻）。
171. **文件写工具在 Android 上建不了新文件：`createIfAbsent` 的 link(2) 没有回退，而退役记录以为上游早就覆盖了它（0.14.1 真机实测 + 本轮实修）**：真机上 `write` 工具报 `EACCES: permission denied, link '<目录>/.<文件名>.<pid>.<uuid>.tmpdir/<文件名>.tmp' -> '<绝对路径>'`，**而覆盖已存在的文件完全正常**——症状是「只能改，不能建」，很容易被当成偶发。
    **真因（结构性，三段链路）**：① `dsh-fs-observation-policy` 对「未观察过／确认不存在」的路径判写意图 `createIfAbsent`；② `dsh-fs-local` 把它透传进 `writeFileAtomic`；③ 该分支**只能**用 `link(2)` 做 no-replace 发布，`catch` 里直接 `throwGuardedCreateFailure` 抛出、**没有任何回退**（对照：覆盖路径走 `rename`，Android 上正常）。Android 应用域 SELinux 拒绝 hardlink（`EACCES`，denial 被 dontaudit 静默）——与坑位 #77 同一 sepolicy 限制的第 4 个站点。
    **判定性实测（三连 + 反证）**：`write` 新建失败 / `write` 覆盖成功 / `edit` 修改成功；同域内 `ln a b` 直接 `Permission denied`（排除 DSH 自身因素）。
    **退役记录为什么没接住**：RUNTIME-PATCHES §「已退役资产」写的是「`fs-local-index.js` 0.13.3 批退役——link(2) 回退族**改由构建期补丁承担**」，但 §7.1 构建期补丁表里**没有 `dsh-fs-local` 行**，且当前快照内 `dsh-fs-local/lib/index.js` grep 不到既有约定的回退标记 `dsh-mobile link->rename fallback`（0 次）。EngineManager 注释同轮的判断「fs-local（rename fallback is upstream-native）」对 0.1.5-rc.1 也不成立：上游把 `rename` 用在**替换**路径上（那是它的正常路径，不是回退），而后来新增的**独占创建**路径又裸用了 `link(2)`。
    **教训**：退役理由「上游已原生覆盖」必须**逐站点**核对，不能按文件整体判定——上游会往同一个文件里继续加新的 `link(2)` 站点。
    **修法**：`EACCES`/`EPERM`/`ENOTSUP` 时改用 **O_EXCL 占位 + rename** 等价实现 no-replace（**不得裸用 rename**：那会静默覆盖并发创建者的文件，把 `link` 的 `EEXIST` 语义变成死代码——这正是坑位 #170（补丁 `publish-exclusive-F7`）修过的形状）；`rename` 失败必须回收占位，否则留下 0 字节目标让之后每次创建都输掉占位竞争。构建期 `fs-local-link-F8` + 运行时 asset `fs-local-index.js` 双路同源。
    **判据（可判红，`scripts/patches/tests/fs-local-link-f8.test.mjs` 19 项）**：① 锚点与接线（权限错误才回退、非权限错误仍走原拒绝路径、`internals` 透传）② 行为三路——占位成功即 `rename` 发布且不回收、占位 `EEXIST` 走原拒绝路径且不 `rename`/不回收（独占语义保住）、`rename` 失败回收占位（带 `force`）并原样抛出；撤掉回退或改成裸 `rename` 即红。该测试支持 `--asset` 由 `check-runtime-assets.mjs` 直测资产本体。
172. **快照内 git 的编译期 `SHELL_PATH` 写死旧前缀：所有 `credential.helper` / `!` 前缀 alias / hook 全废，而「git 存在」的设备自检一直判绿（0.14.1 真机实测 + 本轮实修）**：真机上 `git credential fill` 对**任何**助手一律 `fatal: cannot exec '…': No such file or directory`（`store` / `cache` / `!f() { … }; f` 皆然），`git -c alias.x='!echo hi' x` 同样 `fatal: cannot exec 'echo hi'`。HTTPS 的 clone/push 因此只能用非助手绕行（`GIT_ASKPASS`，或每次显式 `-c http.extraheader=`）。
    **根因**：git 执行凭据助手时 `run-command` 恒 `use_shell=1`，而 shell 取的是**编译期** `SHELL_PATH`；Termux 预编译包把它写死为 `/data/data/com.termux/files/usr/bin/sh`（38 B），本壳运行时前缀是 `/data/data/com.dsharnessmobile.shell/files/usr`。`GIT_TRACE` 的 `start_command` 行直接给出该路径。这是**同一类**的第 2 个站点：`usr/bin/git` 早有一条 wrapper 覆盖编译期 `--exec-path`（`dsh-mobile 0.13.0: git exec-path 重定位（issue apk#87）`）。
    **为什么 #87 的修法接不上（本次的关键判断）**：git 对 `SHELL_PATH` **没有提供任何运行时覆盖点**——`--exec-path` 有 `GIT_EXEC_PATH`、CA 有 `GIT_SSL_CAINFO`，shell 路径没有对应变量。于是 `relocate-snapshot.py` 头注释那套口径（「ELF 不改写，功能路径由 `shellEnv()` 的环境变量覆盖」）在这一项上**恰好没有落点**，形成覆盖空洞。
    **为什么之前没人抓到**：`check-prefix-residue.sh` 的 P4 只判「`$B/bin/git` 存在 / `--version` 能跑」——旧串在场时这两条**一样是绿的**（`--version` 不经过 shell），自检因此长期假绿。
    **修法（本仓唯一可行形态）**：git 来自 Termux 预编译包（`make-snapshot.sh:39` 的 `pkg install -y git`），配方改不了，只能改快照。在 `relocate-snapshot.py` 对 **git 家族白名单**（`usr/bin/git.real` + `usr/libexec/git-core/*`，实测共 8 个 ELF 各含 1 次该串）做**等长**替换：38 B → `/system/bin/sh`（14 B）+ NUL 填充。长度与 ELF 节表/偏移全不变 ⇒ **不违反**该文件「ELF 不做变长重写」的禁令（那条禁令针对的是变长替换会破坏 ELF）。白名单而非「所有含旧串的 ELF」：快照内另有 node / dash / make / tar.real 等 20+ 个 ELF 含同一字面量（多为 help/编译期默认值），它们不在本因果链上，一律不动。
    **判据（可判红）**：`python3 scripts/relocate-snapshot.py --self-test`——8 项，含**反证**「非白名单 ELF 必须原样保留（`usr/bin/curl` 仍含旧串）」与「长度/尾部标记不变」；把白名单关掉即 4 项判红。设备端 `check-prefix-residue.sh` 新增 P4b（`git.real` 内不得再含旧串）+ P4c（helper 功能断言，不需网络/凭据）。
    **真机实测**：真品 `git.real` 3,562,128 B 经 relocate 管道后长度不变、与原文**只差 37 字节**（区间 362,813–362,849）、旧串 0 次；提取物跑 `credential fill` 经 `!` helper 取到 `username/password`，`store` 助手的 `approve→fill` 往返亦通。
    **残留（勿当成已清）**：① `pkg upgrade git` 会带回旧串（配方在 Termux 侧）——P4b 的静态断言正是为这种复发准备；② `/system/bin/sh` 是 Android 的 mksh 而非快照内 dash，实测 `-c` / `!` alias / helper 均通过，若要指回 dash 则必须变长改写 ⇒ 只能重建 git 包，成本与影响面大得多。
