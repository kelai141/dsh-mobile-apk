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
172. **启动页 APK 自更新在 arm64 设备上恒失败：`assetName` 按开发脚本口径拼 `arm64`，而 GitHub Release 资产是 `arm64-v8a`（0.14.1 真机实锤 + 本轮实修）**：arm64 真机点「检查更新」不出现「下载并安装 vX.Y.Z」，而是失败文案 `检查失败：latest release v0.14.1 无 arm64 资产（dsh-mobile-apk-v0.14.1-arm64.apk）`；同一版本在 MuMu（x86_64）上完全正常。
     真因（两套 ABI 命名口径混用）：本仓 ABI 命名有两条互不相通的链——`scripts/build-apk-013.ps1`（本地/开发产物）出 `dsh-mobile-apk-v<版本>-arm64.apk`，`scripts/build-release.ps1`（GitHub Release 资产，按 `docs/RELEASE.md` 第 6 节约定 `abi = arm64-v8a | x86_64`）出 `dsh-mobile-apk-v<版本>-arm64-v8a.apk`。`UpdateChecker.assetName()` 的旧注释逐字写着「须与 scripts/build-apk-013.ps1 的 Copy-Item 命名逐字一致」，即按**开发口径**拼接，却在 `checkLatest()` 里拿它去匹配 **Release 资产名**；同一处注释还自称 `abi ∈ {arm64, x86_64}`，与发布约定直接矛盾。发布侧第 166 行的 ABI 表（`n='arm64-v8a'`）与测试 `assetNameMatchesBuildScriptProductName` 的断言（`…-arm64.apk`）把这个错误期望**固化了两遍**，两边各自自洽，静态门禁拦不住。
     **为什么开发循环看不见**：`x86_64` 在两条链上**同名**，只有 arm64 分叉；而 §2.1 的三层验收主跑 MuMu **x86_64**，真机只在发布前补充门禁 ⇒ arm64 这条分支**从未被走过**。`abiFrom()` 那条「带 ARM 翻译层的 x86 设备必须以首选 ABI 为准」的判据反而成了掩护——它保证 MuMu 走到 x86_64，恰好是唯一不踩坑的分支。
     回归出处（**本条已按实测更正**）：`arm64-v8a` 口径**不是** `c7600f5d` 引入的——该 commit 对 `scripts/build-release.ps1` 的 diff 里 `arm64-v8a` **零命中**（实测 `git show c7600f5d -- scripts/build-release.ps1 | grep -c arm64-v8a` = 0）。`git log -G"n='arm64-v8a'" -- scripts/build-release.ps1` 只命中 `cf05fe6`（2026-08-27，`feat: 云端构建自包含（从源重建快照，去除协调库依赖）(#93)`）与 `6a86590`，且 `git show v0.14.0:scripts/build-release.ps1` **已经是** `n='arm64-v8a'`。真正的偏差成因是**装配链换用**：`build-release.ps1` 的发布口径早在 2026-08-27 就存在，但 v0.14.0 的 Release 资产实测是 `-arm64.apk`（未用该脚本装配），**v0.14.1 才改用 `build-release.ps1` 组装 Release**（`release/v0.14.1/notes.md` 明写双 ABI `arm64-v8a` + `x86_64`），偏差因此在 0.14.1 暴露。三天后 `fix(0.14.1): 批 6 引导页/权限/更新` 又动了 `UpdateChecker.kt`，两处命名始终未对齐。**该归因更正不影响代码修复的正确性，但会误导后人定位，故一并改。**
     修法：`assetName()` 归一到**发布口径**——`val releaseAbi = if (abi == "arm64") "arm64-v8a" else abi`；同时把 `abiFrom()` 与 `assetName()` 的注释改成各自真实职责（前者是**设备 ABI 家族名**，后者才是**发布资产名**），消除「开发口径即资产口径」的暗示。`abiFrom()` 的逻辑与既有断言**一律不动**（其翻译层判据仍然成立，改动面越小越好）。
     判据（可判红，`UpdateCheckerTest.assetNameMatchesReleaseProductName`）：① `assetName("v0.14.1","arm64")` 必须等于真实发布资产名 `dsh-mobile-apk-v0.14.1-arm64-v8a.apk`，且无 v 前缀的 `"0.14.1"` 归一到同一名；② `x86_64` 两侧同名，不受影响；**撤掉映射即红**（回到 `…-arm64.apk`）。该测试是纯 JVM 逻辑，不需要设备即可跑。
     替代验证（本轮无法构建/跑 Gradle，如实记真因）：把 `abiFrom`/`assetName`/`isNewer` 的纯逻辑等比移植到 Node 逐例复算——既有 16 条 `isNewer`/后缀断言 + 4 条 `abiFrom` 断言 + 新增资产名断言共 **23 例全绿**；并以真实 v0.14.1 资产名做命中对照，复现「arm64 未命中 / x86_64 命中」，修后 arm64 转命中。**构建与三层验收（CDP + ADB 真机）仍需在开发机补跑**——本条只完成了代码层。
173. **快照内 git 的编译期 SHELL_PATH 等长重定位：落点必须晚于 7d（git.real 是那一步才诞生的），且白名单内绝大多数是符号链接（apk#247，0.14.1 真机复现 + 本轮落到产出链）**：git 的 `credential.helper`、`!` 前缀 alias、hook、`rebase --exec` 一律经 run-command 走 shell，而 shell 取的是**编译期写死**的 `SHELL_PATH=/data/data/com.termux/files/usr/bin/sh`（38 B，应用域不存在）⇒ 它们全部 `fatal: cannot exec ... No such file or directory`。真机上 `git --version` 正常，症状只在用到 helper 时才现，故长期被「git 存在且能跑」掩盖。
     真因（三类编译期路径里唯一没有运行时覆盖点的那个）：`--exec-path` 有 `GIT_EXEC_PATH`（0.13.0 的 `usr/bin/git` wrapper 已覆盖，issue apk#80/#87）、CA 有 `GIT_SSL_CAINFO`，而 shell 路径**没有任何环境变量可改**；`run-command` 对凭据助手一律 `use_shell=1`，取的就是 `SHELL_PATH`。
     **落点（本轮修正的关键）**：必须放在 `build-snapshot-013.mjs` 的**第 7d 步之后**。`usr/bin/git.real` 是 7d 里由基座 `usr/bin/git` 改名而来（此前不存在，且会被 7d 的 `rmSync` + `rename` 覆盖），所以本步**不能**与 `fix-shebang.py`（第 6 步）同阶段——放那里会被 7d 抹掉。本轮新增第 **7d2** 步，实现为 `scripts/lib/git-shell-path.mjs`。
     **白名单内 152 个符号链接 + 1 个目录 = 153 个非实体条目（本轮实锤，措辞已按实测精确化）**：`libexec/git-core` 共 181 个条目、其中 **152 个是符号链接**（另有 1 个目录 `mergetools`、28 个实体文件）；模块统计的 `skippedLinks: 153` 把该目录也计入了「非实体条目」——**判定行为无误，只有措辞需要精确**。含旧串的 12 个里 5 个是链接，且 `git-shell -> ../../bin/git-shell`、`scalar -> ../../bin/scalar` **指向白名单之外**。枚举时必须用 `lstat` 只认实体文件——用 `stat` 会跟随链接，等于借白名单越权改写 `usr/bin/` 下的文件。实际命中实体 **8 个**（`bin/git.real` + 7 个 git-core 实体）。
     修法：**等长**原地替换——38 B 旧串换成 `/system/bin/sh`（14 B）+ 24 个 NUL 填充。文件长度与 ELF 节表/偏移全不变，故不违反 `relocate-snapshot.py` 头部那条「ELF 不做变长重写」的禁令。用白名单而非「所有含旧串的 ELF」：快照内另有 node / dash / make / tar.real 等二十余个 ELF 含同一字面量（多为 help 文本），不在本 issue 的因果链上，一律维持原状。
     判据（可判红）：① 模块级自证 12 项——白名单命中数、等长、幂等、尾部标记未破坏、非白名单原样保留、**符号链接被跳过且不被写成实体**；把 `lstat` 换回 `stat` 即红。② 设备端 `check-prefix-residue.sh` 新增 **P4b**（静态：`git.real` 内不得残留旧串）与 **P4c**（功能：`credential.helper` 真能被 shell 拉起）——原 P4 只判「git 存在 / `--version` 能跑」，而旧串在场时这两条一样是绿的，自检因此长期假绿。**P4c 必须带 `-c core.askPass=`**：否则 helper 执行失败时 git 会回退到 askpass，可能取到环境里真实存在的凭据，使断言假绿**且会把凭据打印出来**。
     **真机对照（本轮拿真品 git.real 做修前/修后）**：修前 `fatal: cannot exec 'f(){ ... }; f get': No such file or directory`；修后同一命令返回 `username=u`。8 个实体文件修后逐文件字节数与原文**完全相同**（`bin/git.real` 3,562,128 B、`git-remote-http` 2,010,824 B、`git-daemon` 1,950,560 B 等）。
     残留（勿当成已清）：① `pkg upgrade git` 会带回旧串（配方在 Termux 侧，快照侧改不了）——P4b 的静态断言正是为这种复发准备；② `/system/bin/sh` 是 Android 的 mksh 而非快照内 dash，`-c` 与 `!` alias 语义与 Termux 下略有差异，实测可用但不宜假设等价；③ 本轮只完成代码层（无 WSL 构建环境），构建 + 三层验收（CDP + ADB 真机）需在开发机补跑。

174. **上游 peer 门禁与 npm 解析用的是两套 semver 判据，caret 地板留在旧代会在安装期就炸（2026-09-24 追 0.1.7-rc.1 实锤）**：上游 `app-boot/src/plugin-compatibility.ts:77` 判兼容用 `semver.satisfies(runtime, range, { includePrerelease: true })`，而 **npm 自己解析 peer 时不带 `includePrerelease`** ⇒ 同一个 `^0.1.1-rc.2` 在运行时门禁里放行 0.1.7-rc.1、在 `npm install` 里却判不满足。叠上冻结载体就更狠：`@deepseek-ai/dsh-client-runtime` 只发到 **0.1.1-rc.2**（引擎主版本线从来不含它），它自带 16 条 `^0.1.1-rc.2` peer，把它拽进来的仓装 rc.1 时直接 `ERESOLVE`（实测 `plugins/dsh-android-vdisplay`），错误文案指向的却是「dsh-tools 的 peer dsh-agent」——真因在传递图上，不在被点名的那条边。
    **修法（两件，都不许留）**：① 追版时 caret **地板随版抬**（`scripts/bump-plugin-pins.mjs` 按 `contract.json` 一次性抬，形态保留），别只改精确钉；② 只为拿一个类型而依赖冻结载体 = 把一个时代的引擎图拽进安装面 —— 客户端类型按上游自身写法拿：`import type { Context as ClientContext } from '@deepseek-ai/cordis'`（见 `dsh/packages/client/locale/src/client/index.ts:7`），本仓 `dsh-client-ui-responsive` 一直就是这么写的，只有 bridge/vdisplay 两个入口当年抄了 `dsh-client-runtime/client`。
    **判据**：`scripts/check-contract.mjs` §7 拿**设备侧同一个 semver 库**在构建前复刻上游判定（`--runtime <不可满足版本>` 是它的反证档），§6 的 `contract-pin-gaps.json` 让「钉未对齐」必须显式声明、一旦对齐不删条目即红。教训半条：**写死版本号的反例会在抬版后静默失效**——本轮 `--self-test` 就有 2 例这么失效（§7 反例从「装成 0.1.7-rc.1」改成「装成 0.0.1-rc.1」，§9 反例改从 `contract.baseline` 取值），反证必须与进度无关才可重跑。

175. **面板宽度有两份公式而其中一份是死代码，转屏又没人重算——横屏体验与「窗口比内容宽」两类假象同源（2026-09-24）**
    **现象**：横屏（1600x900）上面板看起来「没用上多出来的宽度」；反过来在竖屏打开面板再转横屏，面板保持竖屏宽度；
    而代码里 `OverlayPanel.buildUnit()` 开头明明也算了一次 `width`（屏宽 - 64dp - 32dp，封顶 400dp）。
    **真因**：① 那个 `val width` 在 `buildUnit()` 全文**无人消费**（实测：`buildUnit` 作用域内 `width` 只出现在声明行），
    面板宽的唯一生效口径是 `OverlayService.showPanel()` 里给窗口的 `panelW`——两份公式（还互不相同）只有一份生效，
    留着会让后来人以为改它能改面板宽；② 两个 Activity 都声明 `configChanges="orientation|screenSize|screenLayout"`
    （不重建），`OverlayService.onConfigurationChanged()` 只重刷主题 + 球坐标 + `positionPanel()`，
    **从不重算窗口宽度**（`panelW` 是 `showPanel()` 的一次性局部量），`hidePanel()` 也不清 `unitView`，
    所以没有任何路径会在转屏后替它换宽——不是概率问题，是结构性无人负责。
    **修法**：① 删掉 `buildUnit()` 里的死 `val width`，宽度口径收敛到 `OverlayService.panelWindowWidth()` 单一函数；
    ② `onConfigurationChanged()` 在面板展开时按新屏幕重算 `pp.width` 并 `updateViewLayout` + 重定位。
    **同类（本条只修了汇报栏，会话选择器**未**改——见下面判据）**：抽屉/浮层窗口高度若只按
    `heightPixels` 取比例，横屏会被压没。`OverlayReport` 的 `maxH = sh * 0.40f` 已加 300dp 地板，
    并用「屏高 - 24dp」封顶（地板永不会把抽屉顶出可用屏幕）。
    同形态还在 `OverlayPanel` 的会话选择器：`maxH = screenH * 0.45f`（横屏 405px=270dp，约 6 行），
    但它是 **ScrollView 内的窗口高度**（列表可滚，不构成「条目够不到」），
    ⇒ 本轮**不动它**，等设备层量出「横屏可见行数 / 用户是否需要多次翻页」再决定，不凭比例猜。
    **设备几何实测（校准基准，勿沿用旧值）**：16416 `user_rotation=0`，natural `900x1600 @320dpi`
    ⇒ 可用 900x1600、density 2.0、450x800dp；16384 `user_rotation=1`，natural 同为 `900x1600`
    但 `@240dpi` ⇒ 可用 **1600x900**、density 1.5、1066x600dp。
    注意 `wm size` 报的是 **natural** 尺寸（两台都显示 900x1600），横屏只能从 `user_rotation` 与
    `dumpsys window` 的当前 frame 判读——照 `wm size` 判断方向会得出「两台都是竖屏」的错结论。
    **判据**：几何类改动必须过竖屏 16416 与横屏 16384 两个方向的 tap 级实测（AGENTS §2.1.6）——
    DOM/CDP 断言看不见这类缺陷（§2.1.4）。

176. **退役 combo-lazy-A4：它的收益声明是 0.1.5 时代的量级，上游 0.1.7 惰性化之后结构性无对象；撤它时又牵出 C5 的两条门禁缺陷（2026-09-25）**
    **现象**：`combo-lazy-A4`（engine 补丁：把 `compose()` 推迟到首个图读者、启动期 flush 只标脏）账面收益是
    「9-14 次全表重算（单次 1.8-3.1s，占 LISTEN 墙钟 88%）收敛为 1 次」，看起来是启动性能支柱。实测却不成立。
    **真因（三支）**：
    ① **收益的量级属于旧代上游**。0.1.7 已把 combo 载荷原生惰性化（`dsh/packages/client/modules/README.md`
    「creates combo descriptors without building response bodies」；`src/index.ts:384 lazyBody`），单次
    compose 只剩个位数 ms（设备真值 5-9ms），「2.8s × 9-14 次」的对象不存在。
    ② **裸树只 compose 2 次，不是 9-14 次**（同基线 0.1.7-rc.1 离线 A/B，双臂零 failures）：构造函数先空表
    `this.composed = this.compose()`（records=0，2.27ms），随后 flush 带真记录再 compose（records=67，3.97ms）。
    A4 省掉的是**空表那次**，并把带真记录那次从构造期挪到**首个图读者**（= 首个页面请求路径）。
    A4 臂 1 次 5.79ms ⇒ 总量与裸树同量级，**位置反而更靠近 TTFB**（实测 HTTP−LISTEN 竖屏 557ms / 横屏 1472ms），
    属「位置为负」。
    ③ **撤它时发现 C5 门禁本身是空的**（两条独立缺陷）：(a) `parseProbe` 的
    `/\[perf\] boot singles=(\d+|n\/a)/` **缺 `-1` 分支**，而 P1 在计数缺席时故意打 `singles=-1`（绝不省字段）
    ⇒ 解析返回 `undefined`，C5 对设备真值**恒不可判定**；(b) C5 的正向对照只认
    `globalThis.__dshMobileComboLazyStats.singleBuilds`——那是**已撤销的 A5** 装的计数器，A5 退役后它
    **没有任何生产者** ⇒ 对照永远「没跑起来」，于是「boot singles 恒 0」这条断言在任何环境下都不构成证据。
    **修法**：① registry 31 → 30 条，`apply-patches.mjs` IMPLS 移除 A4 全符号（`ensureComposed` / `composeDirty`），
    `combo-probe-P1` 的 `requires` 清空（P1 保留：C2/C4/C6 仍消费它）；② C5 解析补 `-1` 分支；③ 正向对照改落
    **上游自己的惰性契约**——离线直驱打过 P1 的引擎树，断言单条 URL 命中 200 + 载荷含该 id + `body()` 两次
    调用返回**同一 promise**（`lazyBody` 的 memoize 契约）；④ C5 判据改三态（`0` → 惰性成立；`> 0` → 判红；
    `-1`/缺读数 → 由正向对照裁定，对照真跑通过即等价成立，跑不起来如实 SKIP），**既不恒绿也不恒红**；
    ⑤ C3「compose ≤ 2」**不放宽**（裸树正是 2 次，阈值仍可满足，注释改写明裸树事实）。
    **判据（可证伪）**：① `node scripts/check-boot-budget.mjs --self-test` 必须全绿，且其中 5 条新用例钉住
    C5 四态——「`-1` + 对照跑过但失败 → 判红」证明判别力没因三态丢失；② 真数据跑
    `node scripts/check-boot-budget.mjs --segments … --probe …`：设备真值 `singles=-1` 时 C5 由 SKIP 转 PASS
    （SKIP 1 → 0）；③ 回归测试 `combo-lazy-a4.test.mjs` 已改写成「撤销不变量守卫」，把 A4 id 塞回 registry 即
    判红（实测 2 项失败），还原即绿。
    **为什么记进坑位**：「补丁的收益声明会随上游版本过期，但补丁自身不会自动消失」——退役判据必须落在
    **同基线 A/B 实测**上，而不是补丁注释里那句当年成立的数字；连带发现的门禁缺陷还说明「门禁的正向对照
    依赖一个会退役的补丁符号」本身就是漂移源。

177. **热推脚本（hot-push.mjs）长期「自称可用、实际每个落点必失败」：adb push 建的 stage 目录对 run-as 身份不可列目录（2026-09-26）**
    **现象**：`node scripts/hot-push.mjs --serial 127.0.0.1:16416 --plugin plugins/dsh-android-vdisplay` 恒失败，
    两个 profile 落点都报 `cp: /data/local/tmp/dsh-hot-push/lib/.: Permission denied`，退出码 1。
    脚本头注释与实际用法都宣称它可用，而它**从来没有成功过**——因为没人真跑过它（此前开发循环一律走全链打包）。
    **真因**：`adb push` 在 `/data/local/tmp` 下新建的目录权限是 **`0771`**（`drwxrwx--x shell shell`）——
    others 位只有「可穿越」（`--x`）**没有「可读」**。而脚本用 `cp -r <stage>/lib/. <target>/` 复制，`cp` 递归时
    **必须列目录内容**才对，于是以 `run-as`（`u0_aXX`，属 others）身份读 stage 恒得 EACCES。
    **注意这不是「stage 里文件权限不对」**：文件本身是 `-rw-rw-rw-`（可读），失败的是**目录列举**这一步。
    **修法**：`adb push` 之后加一步 `adb shell chmod -R 755 <stage>`（只读拷贝源，放开 others 读+穿越即可，
    不需要写权限给 run-as）。`scripts/hot-push.mjs` 已实修。
    **判据（可证伪）**：① A/B 实测——不 chmod 时 `cp: …/lib/.: Permission denied`；chmod 755 后同一命令
    输出 `OK` 并列出 5 个条目；② 修复后脚本自身输出 `HOT-PUSH OK（6 文件 × 2 profile）`、exit 0。
    **绕法（不推荐，仅作诊断）**：手工逐个 `cp -f <file> <target>/` 能成功（不列目录 ⇒ 不受权限影响），
    这正是「为什么当初偶发手动热推看起来能行、而脚本从来不行」的原因。**遇到 Permission denied 先查本条，不要手工绕。**
    **为什么记进坑位**：这条同时暴露了**第三条**「文档承诺 ≠ 可执行面」——`dsh-mobile-apk/AGENTS.md` §2 一直教这条命令，
    而 `scripts/hot-push.mjs` **只存在于协调仓**，apk 自包含树里那条文档指向一个不存在的文件。
    故同批把它登记进 `check-patch-mirror.mjs` 的 `MIRROR_TOP`（单边演进即判红），并同步镜像脚本本体。

178. **「App 重启无效」= 根因在 Shizuku 侧的 UserService 实例，只清进程内标志位永远不会好；必须 `remove = true` 强制移除（2026-09-26，P1）**
    **现象**：Shizuku 已授权、通道一度「可创建」，随后跳成「需要准备」；**重新授权与重启 App 均无效**，设置页刷新多少次都停在坏态。
    **真因**：**「App 重启无效」本身就是决定性证据**——进程内任何脏标志位都会被重启清掉，既然重启没用，坏态就不在我们这一侧。
    它指向 **Shizuku 侧那个 UserService 实例已经僵尸化**：绑定请求发出后既不回调也不抛。此时就算我们把 `service = null`、把绑定标志位清零，
    下一次 `bind` 仍会打回**同一个坏实例**，于是表现成「按钮点了毫无反应」。
    **修法（`ShizukuTransport.resetConnection`）**：三件事缺一不可 ——
    ① **承重墙**：调 `Shizuku.unbindUserService(args(app), connection, remove = true)`。该 API 在 AAR 里的实现是
    `IShizukuService.removeUserService(conn, forRemove = true)`（本仓对 AAR 实测 disassemble 确认），即让 Shizuku 管理器**移除**这个 UserService，
    下次绑定才会重建一个干净的。**这一步失败也不许中断重置**（`runCatching` 吞掉 + `Log.w`）——否则 Shizuku 侧已死时连「清空我们这一侧」都做不到。
    ② 清我们这一侧的记账：`service = null` / `connectedAt = 0` / **`bindLatch?.countDown()` 并置 null**（留着僵尸闩会让下一次 `ensureBound` 复用一个永不 countDown 的 latch，
    重置后仍只是「等满预算再报正在建立」= 按钮看起来没反应）；`ShizukuBindState.onReset()` 令 `bindingFlag = false` 使下一次 `beginAttempt` 必然放行。
    ③ **`ControlCarrier.invalidateShizukuCache()`**：caps 的 5s TTL 缓存必须立即失效，否则重置后最多 5 秒内界面仍报旧值，用户会认定按钮没用。
    **纪律**：本方法在设置页每次点击上**同步**执行（UI 高频路径），**绝不 await 新绑定**（与 `kickBind` 同纪律）；重置后的收敛交给既有 2s 轮询 + `kickBind`。
    返回的是**写后回读的 `status()`**，据此如实展示，**不承诺「已修好」**——能否恢复取决于 Shizuku 服务本身是否还在运行。
    **判据（可证伪）**：① 重置后 `bindAttempts` **递增**（证明确实又发起了绑定，而不是只把界面刷了一遍）；
    ② 反证：重置前人为造出「binding 在飞」的态，重置后断言 `binding = false` 且下一步能再次发起；
    ③ `caps.shizuku` 在重置后 5 秒内即反映新态（证明缓存真的失效了，而不是等 TTL 自然过期）。
    **为什么记进坑位**：按「重启无效」直觉去查代码是**方向相反**的排查——重启无效恰恰说明要往**进程外**找。这条坑把「症状→该查哪一侧」的映射钉住。

179. **出厂默认值 = 凭空造事实；未知必须保持未知（含「`reasoning === true` 推不出档位集」）（2026-09-26，P2）**
    **现象**：自定义供应商的路由在引擎目录里查不到对应模型时，思考档位/上下文长度/模态一律缺失，界面无可渲染。
    **错误做法（初版曾想这么干）**：给一个**出厂默认档位集**或默认上下文长度，让界面「先有东西可显示」。
    这等于**凭空造事实**——用户会看到一个我们其实并不知晓的能力声明，且它会被当成已确证的元数据继续流向模型与设置。
    **修法（来源梯，逐级只认显式声明，六级都不中就是「未知」）**：
    `S1 endpoint-descriptor`（问端点自己返回什么）→ `S2 vendor-descriptor`（按响应形状解析厂商 schema）→
    **`S3 models.dev`（新，跨厂商长尾；见 `src/models-dev.ts`）** → `S4 engine-catalog`（pi-ai 随包目录的精确 id 命中）→
    **`S5 user-fallback`（新，只在用户显式配了 `fallbacks` 时存在，出厂无默认值）** → `S6 active-probe`（需显式批准，因它发真实补全请求）。
    不变量（`capability-probe.ts` 文件头明载）：**没有任何一级报出的能力保持缺失（绝不猜测）**；**每个报出的能力都带 `source`**；
    `S3` 与 `S4` 同时描述同一 id 时**逐字段仲裁**——**分歧字段记为冲突且不写入**（「没有任何来源声明的事实保持缺席，而不是变成掷硬币」）。
    **特别提醒（本题最易犯）**：**`reasoning === true` 推不出档位集**。models.dev 的 `reasoning_options[]` 实测有**四种条目形态**
    （仅 `type` / `type`+`values` / `type`+`min`+`max` / `type`+`min`），只有 **`effort` 变体**才点名档位；裸 `type: 'toggle'` 或 `budget_tokens` **一个档位名都不给**。
    因此拿不到 `effort` 档位时**保持未知**，**不回退出厂档位集**（Lead 裁决）。
    **规模与纪律**：models.dev 实测 **223 provider / 8181 模型 / 压缩后约 1.3 MiB**；只保留上列字段（其余全丢），落盘前先量尺寸，超 `MODELS_DEV_MAX_BYTES`（8 MiB）拒写。
    **网络只在 `ensureModelsDev` 一处**：tick 路径传 `allowNetwork = false` 走**纯缓存读**（`$DSH_HOME/models-dev.json`），**0 次网络**；
    证据 = E-P2-4 单测（自动补给路径 fetch 计数为空 + 反证证明该计数面确实能观测 fetch + tick 的 describe 次数不因 S3/S5 合流增加，上界仍为 2）。
    **合流不是替换**：[0.14.2-preview-SHIZUKU-RESET-AND-MODEL-FILL.md](../../../docs/0.14.2-preview-SHIZUKU-RESET-AND-MODEL-FILL.md) §1 的对比结论是
    **两个实现合流**（S3/S5 作为新增两级插进既有四级），不是用一个替换另一个。
    **为什么记进坑位**：这类缺陷的形态是「界面看起来对、数据是编的」——最坏的一种，因为没有任何断言会红。

180. **快照指纹相同 ≠ 插件内容相同：设备验收必须逐文件核 sha256（2026-09-26，task-56 实证）**
    **现象（本轮实测）**：16384 横屏在**同一 APK、同一快照指纹**下，跑的仍是**修复前的旧 `client.js`**（`33072 B / e6da3471`），
    而仓库权威产物是 `33441 B / 1dc4feeb`。后果是横屏九键 keyCode 全为 0——**看起来装了新包，实际验的是旧插件**。
    **真因**：`.`snapshot-fingerprint` 只标识**快照包的身份**，不标识**设备上插件树当前的内容**。
    两者之间还隔着：热推/镜像是否真的落到该设备、profile 是否冷启动重装配、以及**该设备是否从来就没被更新过**。
    指纹一致只能证明「装的是同一个快照包」，**不能证明「树里的文件是同一份」**。
    **修法（验收纪律，不是代码修复）**：装机/热推后，对**每个受影响的插件文件**取设备侧 sha256 与仓库产物逐一比对——
    至少覆盖 `@dsh-android/*/lib/client.js`、`lib/index.js`、`dsh-model-capability/lib/*.js`；**两者必须逐文件一致**才谈验收结论。
    **判据**：本条是 E-B-2 的依据。任一片不等 ⇒ 该设备的验收结论**作废**（不是「差异可以解释」）。
    **为什么记进坑位**：它直接否掉了「指纹对上了就放心了」这个看似稳妥的惯例；且该缺陷**只会以「功能不生效」的形态出现**，不会报错。

181. **`robocopy /MIR` 镜像会把对端**正确**的 lockfile 覆盖成旧版；镜像前先核盘（2026-09-26，本轮实证）**
    **现象**：做 P1 插件镜像时执行 `robocopy plugins/dsh-android-vdisplay dsh-mobile-apk/plugins/dsh-android-vdisplay /MIR`，
    之后 `check-patch-mirror` 判红 `package-lock.json`。追查发现**被覆盖的 apk 侧才是对的**：
    apk 侧 lockfile 钉 `0.1.7-rc.2`（正确的），而**协调仓侧钉的是 `0.1.7-rc.1`（旧的）** —— `/MIR` 把旧的盖到了新的上。
    **真因（两层）**：
    ① `/MIR` 是**双向抹平**：它不判断谁新谁对，只让两边一致，于是**错的一侧可以污染对的一侧**；
    ② 更根本的一层：协调仓 5 个插件目录（bridge / manage / model-capability / vdisplay / shell-termux）的
    **`package.json` 声明 `0.1.7-rc.2`，而同目录 `package-lock.json` 仍钉 `0.1.7-rc.1`** —— 两文件自相矛盾，
    `npm ci --ignore-scripts` 在 5 个目录**全部 ERESOLVE 失败**（实测 exit=1）。apk 侧的 `ed78f5a` 批次修过这个问题，协调仓当时**漏修**。
    **修法**：① 镜像这类**生成物/锁文件**前，先对两侧取 `package.json` 声明的版本与 lockfile 内实际版本做一次核对，
    确认「哪一侧是权威」再决定覆盖方向；② 权威源修在协调仓（把 apk 侧正确的 lockfile 复制过来），
    而不是反过来让镜像把错误固化成「两侧一致」。
    **判据**：`check-patch-mirror` 对 `package-lock.json` 是**逐字节**比对（`MIRROR_TOP` 目录级），
    所以「两侧一致但都错」也能过门禁 —— **门禁只保一致，不保正确**。锁文件的一致性判据必须额外包含
    「lockfile 内版本 == 同目录 package.json 声明版本」。
    **为什么记进坑位**：`/MIR` 是文档反复推荐的镜像手法，而它在**对端更新**时是**破坏性**的；
    本例中它把一个真缺陷（协调仓 lockfile 陈旧）掩盖成了一次「镜像漂移」。

182. **只跑目标单测文件 ≠ 跑过该插件单测：改动跨模块时必跑聚合门禁（2026-09-26，本轮实证）**
    **现象**：改 `keybar/layout.ts` 与 `keybar/mount.ts` 后，只跑 `node --test test/keybar-layout.test.mjs`（10/10 绿）就宣称
    「单测全绿」。随后 `check-plugin-tests` 判红：`keybar-mount.test.mjs:433` 断言「留白变量写在**键条**上」，
    而本次改动正是把它移到了**终端根节点**上 —— 该断言按设计必须红。
    **真因**：`node --test <单个文件>` 只覆盖被点名的文件；同一插件的**其它测试文件**同样消费被改的模块，
    单文件绿**不能**推出插件绿。聚合门禁（`check-plugin-tests`）跑的是整目录，因此会红。
    **后果**：这是**自己给自己发假绿**——若聚合门禁没被跑，这个回归会随 PR 进主干。
    **修法**：改动落在某个插件的 `src/**` 时，收口一律跑聚合门禁（`node scripts/check-plugin-tests.mjs`），
    或至少跑该插件 test 目录**全量**（`node --test test/*.mjs`）；单文件只用于**开发中的快循环**，不得作为收口证据。
    **判据**：插件单测的收口证据必须是聚合门禁的整行输出（含文件数与项数），不得是单文件退出码。
    **为什么记进坑位**：单文件快循环是很自然的工作方式，而它与「验证充分」之间隔着一整类**跨文件断言漂移**，
    后者恰好是本项目测试里最常见的一类（断言写在 A 文件、被改的实现被 B 文件消费）。

183. **`build-release.ps1` 的快照输入必须是**注入后**产物，不是 pre-injection 快照（2026-09-26，本轮实证）**
    **现象**：把 `.deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz`（引擎已 rc.2、但**尚未注入插件**）
    放进 `dsh-mobile-apk/snapshot/` 后跑发布链，在**第 0b 步**就被拒：
    `CHECK-API-ROUTE-AUTH FAILED (16): post-injection marker: web/dsh-undo-savepoint/lib/index.js; …`，
    16 条全是「marker 不在归档里」，随后 `CHECK-RELEASE-GATES FAILED -> 中止组装`。
    **真因**：发布链**先门禁、后注入**，而该门禁验的是**注入后**形态：
      - 第 60 行 `check-release-gates --run --require --snapshot-dir dsh-mobile-apk/snapshot` —— 在注入**之前**；
      - 第 114 行才 `python inject-snapshot.py` 做宿主注入；
      - 第 143-148 行的注释自述：0b 验的是「**输入**快照」，2f 才在注入后产物上复跑。
    ⇒ 即「输入」这个词的真实口径是**已经注入过的那份**（历史流程里它来自设备侧 make-snapshot.sh 的产出树），
    不是「未经注入的裸快照」。判据要求 marker 在场，而 marker 只可能来自注入。
    **修法**：把**注入后**快照喂进去 —— 本地链对应 `.deploy-tmp/build-/13-<abi>/snap-final2.tar.xz`
    （由 `build-apk-013.ps1` 产出，含 undo-savepoint / marketplace / @dsh-android 全套）。
    实测该份含 `dsh-undo-savepoint/lib/index.js` ×2（web+headless）、`dshmarketplace-plugin` ×2、
    `@dsh-android/dsh-android-bridge/lib/index.js` ×2，且引擎 = 0.1.7-rc.2。
    **判据**：`tar -tJf <快照> | grep dsh-undo-savepoint/lib/index.js` **非空** 才可作发布输入。
    **为什么记进坑位**：错误方向的直觉（「pre-injection 才是干净输入、让发布链自己注入」）看起来更合理，
    而实际口径相反；喂错方向的表现是 16 条 marker 缺失，很容易被误读成「补丁没进快照」而去查补丁。

184. **发布输入快照会随插件改动一起过期：`dsh-mobile-apk/snapshot/` 必须重出（2026-09-26，本轮实证）**
    **现象**：`dsh-mobile-apk/snapshot/` 里躺着 9/23 旧快照（引擎 `0.1.5-rc.1`，且不含本轮任何插件改动）。
    若直接跑发布链，会打出**引擎回退到 0.1.5-rc.1、且不含本轮修复**的包 —— 与本地全链验过的两个 APK
    完全不是同一个东西。同族于坑 180（指纹相同 ≠ 内容相同）：**输入源认错，验收全白做**。
    **修法**：插件改动后必须重跑 `build-apk-013.ps1`，再把 **snap-final2** 放进 `dsh-mobile-apk/snapshot/`。
    逐文件判据（不能只看指纹）：从待发布输入里抽出 `@dsh-android/<pkg>/lib/client.js`，
    与仓库产物取 sha256 **逐文件相等**。
    **顺带实测**：`.deploy-tmp/build-/13-x86_64/snap-final2.tar.xz` 在只重建 arm64 后会**仍是旧内容**
    （其内的 vdisplay client.js = `1dc4feeb…`，而仓库已是 `1c48647d…`）——即**「建过这个 ABI」不等于
    「这份快照是最新的」**，双 ABI 发布必须两个 ABI 都重出。

185. **页面「自然底边」与「可视底边」的差是真源；壳侧 IME 变量是已生效过的同一高度（2026-09-27，0.14.2-fx-1 实证）**
    **现象**：用户报「九个终端控制键仍旧会额外上抬，上抬距离还恰好是比键盘高一个键盘」。
    **真因**：壳侧 edge-to-edge 对**同一个** IME 做了两件事（`MainActivity.kt:254-279`）：
    ① 把 IME inset 施加到 WebView 自身的**布局尺寸**（`webView.setPadding(0, 0, 0, ime)`，注释自述是 #197 机制①的根治——
    让布局视口真的变短，浏览器就没有可平移的余地）；② **同时**把同一个高度推成 CSS 变量 `--dsh-android-ime-bottom`。
    插件侧旧 `computeBottomInset` 用「布局视口高 − 视觉视口高」当键盘高度，再与壳侧变量取 max ——
    吸收态下两者都等于同一个键盘高，但布局视口**已经**因此变短了，键条的自然底边早已到键盘顶，再加一份留白就是多抬一个键盘。
    CDP 实测（360 CSS 宽，键盘 300，键条高 53）：基线 `innerH=800 vvH=800 ime=0` → 键条 top 747；
    吸收态 `innerH=500 vvH=500 ime=300px` → 键条 top **147**（应 447）；抬升 600 = **两个**键盘高。
    **修法**：判据换成**自足量** `shortfall = max(0, 布局视口高 − (视觉视口高 + 视觉视口偏移))` ——
    不猜键盘多高，只描述「还差多少没让开」；视觉视口可用时壳侧 IME 变量**不参与**，只留作「视觉视口整个读不到」的兜底。
    修后同一组读数键条 top = **447**，抬升恰为 300（一个键盘高）。
    **两个必须记住的边界**（各有单测守着）：
    ① 视觉视口不可用（`height` 为 0）时**不得**算 shortfall —— `layout − 0` 会退化成「整个布局视口高」，
    那不是留白而是把内容顶到屏幕外；该分支一律交给壳侧兜底。（这一条是第一版实现漏掉的，被自己写的测试判红 `800 !== 300` 抓出。）
    ② `visualViewport.offsetTop` 必须一起读——漏掉它会在「布局视口没缩但浏览器平移了内容」的内核上留一条空白带。
    **为什么记进坑位**：两处「让开键盘」的实现分居 Kotlin 与 JS、各自看着都对，
    缺陷只在**同一个量被两侧各算一次**时出现；而症状（上抬量恰好多一个键盘）极易被误读成「留白算大了」而去调系数，
    实际是**通道重复计数**。同类形态（一个事实两条通道各自生效）值得当成一族来查。

186. **上游声明的运行期依赖没随 overlay 走：设备 boot 期 `ERR_MODULE_NOT_FOUND` 硬崩，而本地门禁结构性全绿**（2026-09-27，H-1）
    **现象**：设备 boot 期引擎硬崩，报 `ERR_MODULE_NOT_FOUND`，被依赖的模块是 `@modelcontextprotocol/client`；
    而本地全部门禁绿、打包正常 —— 缺陷只在**设备运行期**出现。
    **真因**：上游 `dsh-mcp-client` 的运行期依赖从 `@modelcontextprotocol/sdk` 换成了 `@modelcontextprotocol/client@2.0.0`（改名/拆包），
    而我们的 overlay 生成器 `scripts/gen-engine-overlay.mjs:66-90` 的 `collectPackages()` 只收 `@deepseek-ai/*`（`:90` 的 filter），
    **第三方运行期依赖根本不在它的收集面内**；`vendorTop` 在生成器里**没有任何写入点**（全文只在旧表保留逻辑里被读），
    靠人工补登 ⇒ 人工没跟上。**三条既有门禁结构性看不见**：`check-engine-overlay` 的正向闭包只对三份 `cordis.patch.yml` 的**行面**问责，
    而 `dsh-mcp-client` 正是「不在我们装配行面上」的那类宿主。
    **修法**：① `scripts/snapshot-config/engine-overlay.json` 的 `vendorTop` 补两条
    `"@modelcontextprotocol/client": "2.0.0"` / `"@modelcontextprotocol/core": "2.0.0"`（36 → 38）；
    实测该闭包 13 个包里 11 个已在快照内，只缺这两个 ⇒ 最小修法成立。
    ② 新增门禁 `scripts/check-mcp-client-deps.mjs`：判据 = `@deepseek-ai/dsh-mcp-client` 的**运行期依赖闭包**在快照内全部可解析
    （逐级读快照内 package.json，缺失即列出**引用者**）；已接进 `check-release-gates.mjs` 声明集（32 → 33）、本地链 `build-apk-013.ps1`、
    云端链 `build-apk.mjs`（两链门禁集差集实测为 0）与 `check-patch-mirror.mjs` 的 `MIRROR_TOP`。
    **为什么不动生成器**：`vendorTop` 是「构建期人工裁决」面（哪些第三方要随引擎顶层走，取决于 Node 解析面），把 npm 闭包全量自动化会引入
    几百条传递依赖的登记抖动；先补缺口 + 用门禁把「再漏」挡住。
    **复验证据**：正证（闭包完整的最小 tar）`CHECK-MCP-CLIENT-DEPS PASSED` exit=0；反证（同一 tar 删掉 `@modelcontextprotocol/client`）
    `FAILED：… 闭包在快照内不可解析 1 条: [@modelcontextprotocol/client]` exit=1；修复前现状快照同判红并逐条列出 `MISS … <- @deepseek-ai/dsh-mcp-client`。
    **同型提醒**：凡「上游改了依赖名/拆了包，而我们的清单/overlay 是人工维护的」，都要问一句「这条依赖有没有进收集面」；
    行面门禁看不见非行面宿主。

187. **「判据常态为 null」被写成否决条件 ⇒ 守卫恒触发 / 恒不触发**（2026-09-27，task-78）
    **现象**：为修 issue #274 ①（探活超时即破坏性自愈），第一版判据写成「日志里没有强证据 → HOLD」。
    跑既有回归时 `degradedHttpLadderEscalatesToRestartOnTheSixthTick` 判红：第 6 拍不再 RESTART，
    连带 `halfDeadEngineStillReachesUndoAfterTheBootWindowExpires` 的 `undoProbed` 恒为 0。
    **真因**：`WatchdogV2` 的 `logSignature` 只在日志尾部匹配到已知签名（`plugin tree failed to load` /
    `uncaught`）时才非空，**其常态就是 null**（生产亦然，不是测试注入口径）。把「缺少证据」当否决条件 ⇒
    这条守卫在**绝大多数正常路径**上都成立，等于把既有的、必需的阶梯语义整条掐死。
    **修法**：判据只认**正向证据**（指认「是慢、不是死」：本次探活 `error=timeout`；或端口非本进程持有），
    且证据是**放行**的理由而不是**前置条件**（`strongEvidenceForDestructiveRecovery` 命中时**解除**「慢」的否决）；
    对「慢」这类单次观测无法与真卡死区分的形态必须有**有界宽限**：`DEGRADED_SLOW_GRACE_TICKS`（3 倍阶梯 ≈ 90s），
    宽限用尽仍无改善即视为真卡死放行 —— 否则会制造「引擎卡死且永不重试」的死局。
    **复验证据**：既有 4 条回归全绿；新增 5 条断言（慢→HOLD / 端口他进程→HOLD / **宽限用尽→放行** /
    `refused`≠慢→放行 / 子进程已死时第 6 拍 RESTART 仍成立）。
    **同型提醒**：任何「观测到 X 就否决」的守卫，先查 X 在**正常路径上的取值分布**；常态为 null/false 的 X
    会让守卫恒触发或恒不触发，与「定义在但没接线」同族。

188. **`treeStats` 把 root 自身计入 ⇒「空目录 = 0 条目」判据永不触发，整条防线作废**（2026-09-27，task-78）
    **现象**：为 issue #273 ① 写「回滚前体检备份，空备份一律拒绝」的 `verifyPreviousForRollback`，
    并在单测里造了一份空备份期望被拒 —— 实测**判红**（没被拒）。
    **真因**：`SnapshotFs.treeStats` 的文档写「不含 root 自身」，实现却从 root 开始 `walk` ⇒ root 被计 1 条；
    于是空目录报告 `entries=1` 而非 0，`if (stats.entries == 0L)` 恒不成立，
    **「拒绝半份备份」整条判据全部作废**。这是本仓反复出现的「判据存在但无判别力」形态。
    **修法**：`treeStats` 只遍历 `dir.listFiles()`（不含 root），并单独处理「root 本身是符号链接」。
    **复验证据（判别力反证）**：把 `verifyPreviousForRollback` 的返回值硬置 null ⇒
    `rollbackRefusesAnEmptyBackupInsteadOfWipingLive` **判红**；还原后复绿。
    **同型提醒**：写「= 0 / 为空」判据时**先证明它造得出来**；造不出来或造出来判据不响，就是边界条件写错了。

189. **测试里的静默 `return` 会伪装成 PASS —— 撤掉修法照样绿（假绿）**（2026-09-27，task-78）
    **现象**：`backupKeepsSymbolicLinksAndRollbackRestoresThem` 需要建符号链接，本机（Windows，无
    `SeCreateSymbolicLinkPrivilege`）建不出来，第一版写成「建不出来就 `return`」⇒ 它显示 **PASS**。
    做判别力反证时（撤掉 A 的修法）**它照样绿**，正是这一点暴露了它：这个用例从来没验过任何东西。
    **真因**：JUnit 里「无法构造前置条件」只能报 **SKIP**，不能静默返回 —— 静默返回与「断言通过」在报告上无法区分。
    **修法**：改用 `org.junit.Assume.assumeTrue(...)`（无权限时如实进 SKIP 计数）。
    **更深一层**：环境受限的能力**不能只靠 e2e** —— 本仓既有范式是把「可能失败/不可观测的一步」做成**可注入原语**
    （`swap` 的 `move` / `delete` / `ownerProbe` / `spaceCheck`）。符号链接三动作（判链接 / 读目标 / 建链接）
    同样抽成可注入接缝后，本机即可拿到真判红：正例断言 `createLink` 被调用且目标名逐字相同；
    反例把它换成「一律当普通文件」判红；反例让 `createLink` 抛 IOException ⇒ 必须**向上冒错**而非静默跳过。
    **接缝要抽到「做判断的那一步」**：只抽下游动作、分支仍读 `attrs.isSymbolicLink`，注入的替身就**永远不会被问到**
    ⇒ 又变成「有接缝但无判别力」（本轮实测踩到并自查出）。
    **复验证据**：SKIP 如实计数（全量实跑 skip=2，含本条与另一条同型 e2e）；
    可注入判据的红/绿对照见 `SnapshotTransactionTest`（CP-A1b / CP-A1c 两条反证实测判红）。
    **同型提醒**：`return` / `if (envOk)` 这类「环境不满足就跳过」的写法，与本仓「判据无判别力」是同一件事。

190. **Kotlin 行首 `+` 是一元加号、不是续行 ⇒ 静态自审全绿但编译炸**（2026-09-27，task-78）
    **现象**：`SnapshotTransaction.kt` 里两处多行字符串拼接写成
    ```kotlin
    notes += name + "…" + relink.restored + "/" + relink.expected
      + " 条（备份缺链接，按 staged 工厂权威补回）"   // 行首 `+`
    ```
    编译报 `Unresolved reference 'unaryPlus' for operator '+'`（String 没有 `unaryPlus`）。
    **真因**：Kotlin 的续行规则是「**上一行以运算符结尾**」，不是「下一行以运算符开头」。行首 `+` 被解析成**一元加号**。
    只有**圆括号/方括号内部**的换行才无条件合法（`Log.w(...)` 那种调用实参里的行首 `+` 因此没事 —— 它在括号内）。
    **修法**：把 `+` 挪到上一行行尾，或用括号包住整个多行表达式（本次采用后者，保留可读缩进）。
    **为什么静态自审抓不到（本条的重点）**：同批改动跑过括号平衡（depth=0）、hash 核对、自写机械核对脚本 28 条全绿
    —— **没有一条能发现编译错误**。括号平衡只数括号（行首 `+` 不改变括号计数），机械核对只匹配写下的模式串。
    **静态 ≠ 编译 ≠ 运行**，三者是三个不同的证据等级。
    **复验证据**：修前编译 `Unresolved reference 'unaryPlus'`（实测）；修后用「行首 `+`/`-` 且处于圆括号/方括号深度 0」的扫描
    确认**全文件 0 处**（其余行首 `+` 全部合法地位于括号/实参内部，逐个看过上下文）。
    **同型提醒**：任何「我用脚本查过所以没问题」的结论，都必须先问「这个脚本能不能看见我要防的那类错误」。

191. **`stage/` 目录与 `snapshot.tar.xz` 不同步：门禁读了阶段树而非产物，得出与实际相反的结论**（2026-09-28，task-78）
    **现象**：`node scripts/check-boot-budget.mjs --pull <serial>` 真检里 C5 的正向对照判 SKIP，理由原文：
    `引擎树存在但未打过 P1 补丁（无 compose 探针面）：…/snapshot-013/x86_64/stage/root/…/dsh-client-modules/lib/index.js`
    同一时刻另两条事实与它矛盾：
      · `snapshot.tar.xz`（同目录，2026-09-28 01:30 重建）**tar 内该文件有 P1 marker**（47,466 B）；
      · **设备引擎树里 P1 marker 命中 4 处**（设备实际跑的就是含 P1 的树）。
    **真因**：该 stage 目录 mtime = **2026-09-08 18:21:32**，即**停留在两个月前的树**；
    而 C5 的输入面读的是 **stage 树** —— 既不是 tar、也不是设备树。重建快照只刷新了 tar，**没有回写 stage**。
    ⇒ 门禁拿到的是一个既不等于产物、也不等于运行时的第三方副本，于是结论与实际完全相反。
    **这是同一根因的第二次现身**：第一次表现为 `-Fast` 静默复用陈旧 stage 树 + boot-budget「有设备产物就真检」
    ⇒ 拿旧读数判红；这一次表现为 C5 正向对照读旧 stage 树 ⇒ 误判「无 P1」。
    **修法建议（未实施）**：① C5 的输入面改读 **tar 或设备树**（二者至少有一个是真相），不再读 stage；
    或 ② 构建链在重建快照后**同步刷新 stage**，并给 stage 树加一条「与 tar 同代」的自检（mtime/内容 hash 二选一）。
    在没有修法之前，读 stage 的正向对照**一律不可信**——它是「第三份副本」，谁都不会去核它。
    **复验证据（实测）**：
      · stage 树文件 mtime = 2026-09-08 18:21:32、P1 marker 命中 **0**；
      · 同目录 tar（01:30 重建）解出该文件 = 47,466 B、P1 marker 命中 **true**；
      · 设备 `run-as grep -c` 该文件 = **4**；
      · `grep -E 'SnapshotTransaction|SnapshotFs|UndoGate|WatchdogV2|EngineService' scripts/check-boot-budget.mjs` = **零命中**（该门禁不读壳侧 Kotlin，故三条红与 task-78 无关）。
    **同型提醒**：凡「门禁/工具读一个中间副本（stage / cache / 中间产物）而不读产物本体或运行时」，
    都要问一句「这个副本由谁负责刷新、有没有人核它」。**三份副本 = 没有真源。**

192. **自愈只挂在「快照刷新」那条链上 ⇒ 指纹已 fresh 的设备永远拿不到修复**（2026-09-28，task-78）
    **现象**：0.14.2-fx-2 的「旧单点写法归一」挂在 `FactoryProfilePatch.merge()` 入口，
    单测全绿、包里也确有该代码（dex 搜到 `normalizeLegacyAgentDefaultModel`），
    但**两台真机**装上含它的包后，冷启动**两次** `live patch` 的 md5 **一个字节都没变**，
    旧形态（`- id: agent-default-model / disabled: true` + 换 id 的 `-mobile` 块）原样保留。
    **真因**：本仓对 profile patch 有**两条**修复通道，各自有独立的门：
      · `merge()`（归一挂的这条）：只在**快照刷新**时跑（`mergePatchYamlById`），门是 `if (snapshotFresh()) return true` ⇒ 现场**已 fresh，早退**；
      · `repairProfilePatch()`：每次 `startEngine` 前的启动前置，门是 per-VERSION_NAME 标记 ⇒ 现场标记已存在，早退。`
    本仓**早已**为同类缺陷写过这条教训（`EngineManager.kt:1443-1444`，apk #214）：
    原文：「这类设备不一定再触发快照刷新（指纹未变则 merge 不跑），所以自愈必须在引擎读 profile 之前做一次，不能只依赖 refreshSnapshot。」
    新写归一代码时**只挂了 merge**，等于重蹈这个坑。
    **修法**：① 归一**同时**挂到 `repairProfilePatch` 的启动前置通道；
    ② 用**独立**幂等标记 `.profile-patch-normalize-<version>`，**不复用**退役行那个标记 ——
    复用会让「已装过同版本」的设备永远补不上这次新修复（现标记语义是「本版本已修退役行」）。
    **复验证据**：修前实测两台 cold start x2 后 md5 均不变（`a7014fab…` / `904788b5…`）；
    设备 fp == APK `assets/snapshot.sha256`（`b2c7244d…`）⇒ merge 早退成立；
    `.profile-patch-repair-<version>` 标记在场 ⇒ repair 早退成立。
    **同型提醒**：凡新增自愈/迁移代码，先问「**它依赖的那条链在这台设备上会不会跑**」。
    判据是「设备的触发条件是否已满足」，不是「代码在不在包里」——本条的假绿形态正是「包里有、跑不到」。

193. **cordis 重启 fiber 的顺序是「先跑新实例、后释放旧 effect」⇒ 单槽注册表上的 effect 每次重启即永久死亡**（2026-09-28，竖屏模拟器 5556 实锤）
    **现象**：在设置里换一次默认模型（或任何改写 `agent-default-model` 条目 config 的动作）之后：
      · `内置插件` 面板从 `196 个 0 失败` 变成 `196 个 1 个失败`，点名 `api-session-controller`；
      · 此后任何控制面动作（新建会话 / 切模型 / 会话控制流）恒得
        `typert gateway: session/create|session/control: active Service "sessionController" is unavailable`；
      · **engine.log 零痕迹**：`dsh web` 的启动审计 warn 出口是空函数（上游 `dsh-bundle-web-app/lib/index.js` 里
        `auditStartupEntries(connectionCtx.root, "dsh web", () => {})`），fiber 失败只在面板上体现，日志里一个字都没有。
    **真因**：两层叠加。
      ① 触发链：config-editor 改写 `agent-default-model` 条目 config ⇒ 该 fiber 重启 ⇒ 依赖 `agentDefaultModel` 的
         session-controller 跟着重启（cordis 的服务实现变更会刷新依赖方）。
      ② 死亡机制：`Fiber._reload()` 的顺序是 `await this._execute(runner)`（跑新实例 body）→ `_updateState()` → `_unload()`（释放旧 effect）。
         于是新 `SessionController` 构造里的 `ctx.effect(() => ctx.fileUploads.registerAgentResolver(...))` 执行时
         **旧注册还在槽里**；上游 `registerAgentResolver` 对已占用槽直接
         `throw new Error("file-upload: Agent resolver is already registered")` ⇒ 新 fiber 判 FAILED，随后旧 fiber 释放
         ⇒ 服务永久缺席（**不是 pending**，所以启动审计不拦、也不自动重试）。
    **定位手段（可复用；本次即由此拿到原始栈）**：插件失败默认无声时，把 cordis 的失败点接出来——
      `cordis/lib/index.js` 的 `_reload()` catch 里，在 `this.ctx.logger.error(reason)` 前插一行 `process.stderr.write(...)`，重启即见栈。
    **修法**：`file-upload-restart-R1`（`scripts/patches/registry.json`，scope=engine）——`registerAgentResolver` 去掉
      already-registered 守卫、改为**同槽覆盖**；disposer 保留身份判据（`if (this.agentResolver === resolve)`），
      旧 fiber 的 disposer 因此不会清掉新注册；仍只有一个槽。不选「改 session-controller 侧」的理由：单槽语义下
      替换与上游意图等价，且全文只有它一个调用方，不依赖 cordis 内部顺序。
    **复验证据（模拟器 5556，同一份运行树）**：补丁前 = 切一次模型即 `1 个失败` + 恒报 service unavailable；
      补丁后 = 冷启动 → 连切 3 次模型 → 面板 `0 失败`、控制台 0 条报错、切完模型真能改。
    **同型提醒**：凡「在插件构造函数里占住某个单槽注册表 / 全局登记处，且靠 effect 释放」的写法，在 cordis 里都经不起
      一次 fiber 重启。**判据**：问「这个注册被重复执行会怎样」——会 throw 的，重启即死。
194. **来源审计构建在 pnpm 安装后备份整个 vendor 包目录，会沿工作区符号链接递归（2026-09-27，远程 run 36261389579）**：
    **现象**：`build-apk-source` 第 9 步在 `prepare-harness-vendor-overrides.py:172` 的 `shutil.copytree(target, backup, symlinks=False)` 抛出异常；日志在 `raise Error(errors)` 后约 5 小时没有新输出，最终碰到 GitHub Actions 6 小时上限而取消，APK 步骤均未执行。此前的 Corepack 下载重试已生效，不能把本轮 6 小时归因于下载；下载完成与 Python 脚本开始之间缺少时间戳，前段耗时不能拆分。
    **真因**：冻结安装先于旧版 Cordis 源码替换，pnpm 已在 `vendor/*/node_modules` 建立工作区链接。锁文件存在 `group → cordis → loader → cordis` 的回环；`symlinks=False` 会跟随链接复制其目标，整个包目录备份因此进入循环依赖图。仅改为 `symlinks=True` 也不够：旧实现随后 `rmtree(target)` 会删掉构建仍需的 `node_modules`。
    **修法**：包根目录保持原位，只把非 `node_modules` 条目移到临时备份，再复制固定提交的源码条目；任一包失败时倒序清理新源码并移回原条目。拒绝固定源码归档顶层携带 `node_modules`。PR 与来源构建入口先跑包含循环链接和跨包回滚的单测。
    **复验证据**：本地非链接用例与回滚用例通过；新远程 run 36288879471 的 Linux 用例通过，五个旧版包在约 1 秒内替换完成，越过原 6 小时卡点。完整来源构建随后遇到锁文件声明漂移（坑 195）。

195. **固定旧版 vendor 清单替换后，构建入口会用冻结锁文件复检声明（2026-09-27，远程 run 36288879471）**：
    **现象**：旧版 Cordis 包已成功替换，但 `pnpm run build` 立即报 `ERR_PNPM_OUTDATED_LOCKFILE`，例如 `vendor/include` 的 `@deepseek-ai/cordis` 与 loader 从锁文件 `workspace:~` 变为旧清单 `workspace:^`；构建在此正常判红。
    **真因**：上游固定 Harness 提交的锁文件与其当代 vendor 清单一致，旧版源码替换也带入了旧版 `package.json`；运行 build 前的 pnpm 依赖状态检查要求 importer 的 specifier 与现有清单相同。另 `pnpm-workspace.yaml` 对 `cosmokit`、`schemastery` 强制 `link:vendor/*`，有效 importer 声明是相对 `link:../*`，不能机械写成旧清单原文 `workspace:^`（远程 run 36289257326 二次判红实锤）。
    **修法**：`reconcile-harness-vendor-lock.mjs` 只对来源报告列出的五个 importer 按工作区覆盖后的有效声明改写 specifier、移除旧清单已无的依赖条目；任何旧清单新增而锁文件没有的依赖直接拒绝，不向 registry 重新解析。原锁文件、改动清单、调整前后哈希进入来源 artifact 与策略报告。旧版源码及打包清单保持固定提交原样。
    **复验证据**：纯函数单测覆盖声明更新、`link:` 覆盖、已锁解析保留、缺失解析拒绝；完整来源构建须由后续远程 run 验证。

196. **当前 Harness 全仓类型检查不能与旧版 Cordis loader 源码混跑（2026-09-27，远程 run 36289546067）**：
    **现象**：旧版源码替换及有效锁文件对齐都完成后，`pnpm run build` 进入 TypeScript 阶段，`speech-to-text`、`llm-deepseek` 等当前包引用的 `loader/volatile-update` 事件在旧版 loader 的 `Events` 中不存在；当前测试还引用旧版 loader 没有的 `src/config/diff.ts`，全仓 `tsc -b tsconfig.host.json` 必红。
    **真因**：来源链把 0.1.7-rc.2 的其余源码与 overlay 固定的较早 Cordis 源码放进同一次全仓类型检查。两者发布时序不同，旧版包的 API 无法满足当前源码的静态检查；这不是缺失依赖或 TypeScript 缓存问题。
    **修法**：先按固定 0.1.7-rc.2 提交完成全仓与 Web UI 构建，再替换五个旧版 Cordis 包、对齐它们的锁文件 importer，单独用各包 tsconfig 和 tsdown filter 编译旧版包。打包时五个旧版 manifest 与源码仍等于固定旧提交，当前其余包来自固定 Harness 提交，不改上游源码。
    **复验证据**：远程 run 36289546067 证明锁文件复检已通过、进入全仓 TypeScript 并在上述不兼容处失败；run 36291011371 的 Harness 全仓与旧版包构建通过。

197. **插件镜像的 package-lock 根声明过期，会让来源构建在昂贵前段完成后才失败（2026-09-27，远程 run 36289938732）**：
    **现象**：Harness 源码构建与 Termux bootstrap 验证均通过后，`Build project plugins and marketplace from source` 在 `dsh-android-linux-env` 的 `npm ci` 报清单与锁文件不同；同类漂移还存在于 browser 与 file-open。
    **真因**：三个插件的 `package.json` 已钉 Harness 0.1.7-rc.2 和 Cordis 4.0.4，镜像里的 `package-lock.json` 根声明仍是 0.1.1-rc.2 / Cordis 4.0.1；旧锁文件未随清单同步。此处与工作区 pnpm 锁文件调整是两套独立依赖图。
    **修法**：按各插件现有清单重算其 npm 锁文件；在 PR 与来源构建的早期步骤运行 `check-package-lock-roots.mjs`，逐个对照所有带锁文件的插件/组件根声明，及早拒绝旧镜像。
    **复验证据**：九份锁文件根声明核对通过，九个目录的 `npm ci --dry-run --ignore-scripts --no-audit --no-fund` 通过，三个修复插件的实际 `npm ci` 与 `npm run build` 通过；远程 run 36291011371 的插件构建步骤通过。

198. **来源部署闭包中的 Linux GNU 原生文件必须逐包审计（2026-09-27，远程 run 36291011371）**：
    **现象**：Harness 与插件构建通过后，`node-pty` Android ARM64 绑定已成功交叉编译，但原生模块审计发现 trycua、ubjs、sherpa-onnx 和 node-addon-require-builtin 的 Linux ARM64/x64 `.node` 文件，报 `unreviewed native module families` 而中止。
    **真因**：`pnpm deploy` 从固定 Harness 的当前依赖图带入跨平台 Linux GNU 包；审计器只认识先前登记的 Sharp、Koffi 等包族，且把 node-addon-require-builtin 限在旧版 0.1.4，实际部署解析到 0.1.6。这些文件名和包名指向 Linux，不是 Android 绑定，不能把审计报错当作 node-pty 编译失败。
    **修法**：按实际锁定版本、包路径、文件名和架构对应关系增加四个包族的严格匹配；将外平台 payload 与原因记入审计报告，未知版本、架构错配和未知原生包继续拒绝。入口增加正反用例。
    **复验证据**：远程日志确认 node-pty Android ARM64 绑定已产出并给出 SHA-256；本地包族正反用例通过，远程 run 36291780773 的交叉编译及原生模块审计步骤通过。

199. **快照行为测试调用已删除的 boot 导出，会把上游接口更新误报成功能失败（2026-09-27，远程 run 36291780773）**：
    **现象**：Termux 基座组装完成后，快照构建器执行 `boot-pending.test.mjs`，五个用例全因 `assertEntriesActivated is not a function` 失败；这些断言均未真正进入待测启动逻辑。
    **真因**：固定 Harness 0.1.7-rc.2 的 `dsh-app-boot` 已改为导出 `auditStartupEntries`，按全局必需 entry id 判定致命错误，可选条目的 pending/failed 只告警。仓库测试仍调用旧导出，并沿用「任何 FAILED 都致命」的旧口径；旧版测试在裸 clone 上因找不到目标而跳过，未及时暴露漂移。
    **修法**：保持快照构建器的镜像脚本不动，改它调用的测试文件：直接注入 Loader 条目调用当前导出，用必需 id `webserver`、可选第三方、pending/failed 和混合状态验证当前契约；目标存在时先断言导出函数存在。
    **复验证据**：使用仓库固定的 0.1.7-rc.2 app-boot 产物夹具及已安装依赖，本地五个真实行为用例全绿；完整来源构建须由下一次远程 run 验证。

200. **来源审计链的检查器停在上一代引擎事实：预设载体断言在 pin 抬到 0.1.7-rc.2 后必然判红（2026-09-27，远程 run 36293117340）**：
    **现象**：快照成功产出（492.2 MB，sha256=e36b77b8…），pnpm 物化、运行时依赖链接、原生模块审计三个后续检查全过，紧接着 `check-dsh-source-snapshot.mjs` 抛 `source snapshot has no built-in dsh-agent-presets entries`，签名与 APK 步骤未执行。
    **真因**：该检查器是权威门禁 `check-engine-overlay.mjs` 的等价实现，而权威源在 0.14.2 追版时已把预设载体从 `@deepseek-ai/dsh-agent-presets/presets/` 重锚为 `agent-preset/skills/` + `web-app/presets/`（0.1.7 把该包拆成 agent-preset + agent-preset-registry）；等价实现没跟上。旧断言此前能通过，是因为上一版 pin 是 0.1.5-rc.1（那一代确有 `agent-presets/presets`，实测 4 项），本链把 pin 抬到 0.1.7-rc.2 后旧载体已不存在——**同一条链在换代后判红，指向的是门禁自身过期，不是产物缺失**。
    **修法**：载体清单抽成 `scripts/source-build/preset-carriers.mjs`（与权威源同口径：目录在场且递归**文件**数 ≥ 1；只断「包在场」是冗余，overlay 已覆盖包版本），检查器改为调用它并把逐载体计数记入报告；新增 `preset-carriers.test.mjs` 双向漂移守卫——它读权威源文本里的 CARRIERS 数组，比对两侧载体路径集合，权威源重锚即判红。测试接进 PR 与来源构建两处入口的早期步骤。
    **复验证据**：本地 6 例全绿；判别力反证两轮（把权威源载体路径改名 / 删掉 CARRIERS 结构）守卫均判红，还原后复绿；pin 侧实测：`packages/preset/agent-preset/skills` 15 个文件、`packages/bundle/web-app/presets` 4 个 `.patch.yml`，两者都在各自 package.json 的 `files` 里，故产物面应非空。完整来源构建须由下一次远程 run 验证。

201. **来源链摘除第一方 overlay 钉，与「按这份清单判定」的 check-contract §7 相撞（2026-09-27，远程 run 36294910834）**：
    **现象**：快照、预设载体检查与签名证书都通过后，APK 步骤的第一批门禁里 `check-contract.mjs` 第 7 节判红 `engine-overlay.json 里没有 @deepseek-ai/dsh-app-boot 钉 —— 运行时版本无从确定`，其余门禁与打包均未执行。
    **真因**：来源链要让快照构建器**不可**按登记表回拉上游发布版 tarball 覆盖已注入的源码产物（`build-snapshot-013.mjs` 的 `overlayExtract` 是整目录替换），故构建期把 `@deepseek-ai/*` 全部摘出 `engine-overlay.json`；而 §7 的运行时版本、以及「profile patch 里 `@deepseek-ai/*` 的 insert 行是否与运行时同版」都按这份清单判——后者还决定哪些挂载行会被上游 boot 期**静默禁用**。这条链此前没暴露，是因为该门禁在**拿不到 semver 时 SKIP**，而旧链的产物树恰好提供不了；本次源码产物树能提供（`dsh-shell-termux/node_modules/semver`），门禁随即真判。教训：门禁的 SKIP 分支会掩盖「判据输入本身已经不存在」这类问题，SKIP 期间被放过的东西不构成「验过」。
    **修法**：新增 `scripts/source-build/restore-overlay-pins.mjs`，在 APK 步骤按 `source-build-policy.json` 记下的摘除清单把钉并回 `engine-overlay.json`（同名不同版判红、清单缺席判红、幂等），还原事实写进 policy provenance；workflow 既有退出 trap 仍把原 overlay 覆盖回去。**不能改为在快照构建期保留**——那正是上面要防的回拉路径。
    **复验证据**：本地端到端复现——按来源链摘掉 315 个钉后 `check-contract.mjs` 复现出与 CI 逐字相同的判红；跑还原脚本后第 7 节转绿（14 条 insert 全过、0 条会被禁用，含两条按 overlay 判同版的引擎包 insert 行），工作树随后还原干净。

202. **来源链现场生成一次性签名证书，等于重新引入 e65818a 修掉的缺陷（2026-09-27，签名专项核查）**：
    **现象**：来源审计构建的 APK 签名证书与仓库内置 `keystore/debug.keystore` 不同（实测 `64:FA:4B:7E…` vs `1D:DE:9D:98…`），且两次来源构建的证书互不相同（上一版 0.1.5-rc.1 的产物是 `4642e0dc…`）。后果：产物既不能 `install -r` 覆盖已有安装（必须先卸载，卸载清数据又触发快照全量重解压），两个版本的来源包之间也互相覆盖不了。
    **真因**：workflow 的签名步骤先 `rm -f keystore/debug.keystore` 再用 keytool 现场生成一张 `CN=DSH Source Build,OU=Ephemeral` 的证书，`repoDebug` signingConfig 于是签的是这张一次性证书。而项目规范恰恰相反且是有来历的——commit `e65818a`（2026-08-20，在 upstream/main 上）：「ci: 内置 debug.keystore 固定签名（否则每次构建新密钥，用户无法覆盖安装升级）」；`gotchas` 坑 10 / `DEPENDENCIES.md` / `design.md` 三处都写着「debug.keystore 固定，否则覆盖安装失败」；`build-snapshot.yml` 就是把仓库 keystore 拷进 `ANDROID_USER_HOME` 以保证 CI 与历史发布同签名。**用一次性证书区分「审计产物 ≠ 发布」这个目的，已由 `-source` 版本后缀与独立 artifact 名达成，用换签名来达成的代价是产物直接不可用。**
    **修法**：删除该步骤的 `rm` + `keytool -genkeypair`，直接使用入库的 keystore；新增产出侧断言——构建后用 apksigner 读 APK 的 `Signer #1 certificate SHA-256 digest`，必须等于固定指纹 `1dde9d980f62b715f29c20b421063f1d3d796085adf7de7e9907dd16d845bcbd`，否则拒出包并把该指纹写入 provenance。**判据放在产出侧而不是输入侧**：只有产出能证伪「keystore 文件在、构建却用了别的密钥」，同时也挡回「再现场生成一次性证书」那种改法。
    **顺带排除的陷阱**：`keytool -list -v` 的输出**不可作为机器判据**——它随 JVM 语言变化（本机 JDK 24 直接输出德语），且在这份 keystore 上会抛 `IllegalFormatConversionException: d != java.lang.String`（`printX509Cert`/`withWeakConstraint`）。故输入侧只查文件在场，指纹一律从 apksigner 读（输出稳定、不本地化）。
    **复验证据**：正证——用入库 keystore 签出的 APK 经 apksigner 读到的指纹 `1dde9d98…45bcbd` 与断言常量逐字相等；反证——本次 run 36296811274 的产物（一次性证书 `64fa4b7e…`）与旧版产物（`4642e0dc…`）代入同一断言均判红。

203. **签名判据锚定 apksigner 的行标签：新版把它从 `Signer #1` 改成 `V3.0 Signer:`，解析取空后静默判死（2026-09-27，远程 run 36303902361）**：
    **现象**：run 36303902361 在 gradle `BUILD SUCCESSFUL`、APK 已产出之后，于 APK 步骤**静默退出 1**——日志里 `APK=` 之后一行输出都没有，分不清是清单为空、还是工具没解析到。前一轮（36300505103）同样症状。
    **真因**：签名断言用行首锚定的 `sed -n 's/^Signer #1 certificate SHA-256 digest: //p'` 取指纹，而 runner 上的 build-tools `37.0.0` 把签名者标签改成了**按签名方案版本编号**的形式：
    ```
    V3.0 Signer: certificate DN: C=US, O=Android, CN=Android Debug
    V3.0 Signer: certificate SHA-256 digest: 1dde9d98…
    ```
    标签不再是 `#1`，锚定式 sed 恒不命中 ⇒ 取到空串；空串又被 `test -n` / 字符串比较静默吃掉，于是「判据没生效」表现为「命令莫名退出 1」。探针实测定性（run 36311334613 的 PROBE A/B/C）：`--print-certs` 本身就打印 `V3.0 Signer:`，与是否加 `--verbose` 无关——**问题在标签措辞，不在输出流向**。
    **修法**：判据不再依赖任何行的前缀与措辞——抓 stdout+stderr、加 `--verbose`、去掉冒号并转小写后，只要求**期望指纹出现在输出里**；不出现就把 apksigner 原始输出整段打进日志再判红。另加构建前**自证**：用同一把 keystore 签一个探针包再读回来，验证「这条判据本身可用」，使工具/keystore 的问题在 2 分钟内暴露，而不是等 30 分钟打包跑完才在末尾判红（那两轮各烧掉约一小时，且产物被丢弃）。
    **复验证据**：探针 run 36311334613 打出 `V3.0 Signer: certificate SHA-256 digest: 1dde9d98…`（PROBE A/B/C 三种取法）；修后 run 36307651694 全链通过，日志 `签名检查 out/v0.14.2/…apk -> 1dde9d980f62b715f29c20b421063f1d3d796085adf7de7e9907dd16d845bcbd`；本地用**另一个版本**的 apksigner 独立复核同一 APK，证书 DN `C=US, O=Android, CN=Android Debug`、指纹同为 `1dde9d98…`。

204. **上游退役补丁后，来源链的期望补丁集与适配器锚点没跟上（2026-09-27，远程 run 36311846352）**：
    **现象**：合并上游 0.1.7-rc.2-fx-1（#269）后重跑来源构建，第 14 步 `Apply project patches to the source-built marketplace` 抛 `shared patch runner changed; review the source-build marketplace adapter before updating it`，构建在约 10 分钟处终止。
    **真因**：#269 让 `market-A`、`market-C` 两个市场补丁退役（上游 0.1.7 自己修好了 A 的 waterfall 崩溃；C 的置灰对象被上游 `installCheck` 过滤掉，客户端拿不到不可安装的行），共享执行器 `scripts/patches/apply-patches.mjs` 里 A 的锚点整段消失。来源链适配器 `apply-source-marketplace-patches.mjs` 仍按旧锚点做「源码构建产物专用改写」，锚点断言失败即判红——**这是守卫按设计工作**：它要求人工复核适配器，而不是静默生成一份错的执行器。同一处 workflow 的期望集 `expectedPatches` 也还写着 A、C（适配器过了下一步照样判红）。
    **修法**：按守卫要求复核后——适配器删掉已成死代码的 A 改写，只保留「把生成副本的 HERE 指回 `scripts/patches`」那一处（锚点整体失配不需要适配器兜底：共享执行器对「check 为假且 apply 零改动」本就判红并拒报 ALL OK）；workflow 期望集去掉 A/C，并**加反向断言**「退役补丁不得悄悄回到注册表」，重启退役补丁必须人工复核来源链。
    **为什么记进坑位**：来源链与主链共用同一份补丁执行器，**上游每退役一个补丁都可能同时打断两条链**——主链会自动跟随注册表，来源链却带着自己的期望集与锚点改写，属于「同一事实两处登记」的典型漂移面。
    **复验证据**：本地以 `vendor` 跑适配器（check 档）→ `apply-patches: ALL OK（13/13，changed=0）`、vendor 树零改动；期望集/退役集断言按注册表实跑通过；完整来源构建须由下一次远程 run 验证。

205. **镜像追到上游发布字节后，来源链还在重建旧源码树：市场补丁锚点必然失配（2026-09-27，远程 run 36312684359）**：
    **现象**：修掉期望集之后重跑，第 14 步改为 `[fail] market-D-server: D 插入锚点未命中——apply 函数与 export 绑定都不在场`，构建再次在约 10 分钟处终止。本地以镜像跑 check 档却全绿——**本地验的是镜像，CI 验的是源码重建产物**，两者不是同一个输入。
    **真因**：`vendor/dshmarketplace-plugin/PATCHES.md` 写得很清楚：镜像来自 **npm 发布的 `dshmarketplace-plugin-0.1.7.tgz`**（用户报障「市场从 UI 里消失」，本轮把上游字节整体追到 0.1.7），全部 market-* 补丁也随之按**发布字节**重定锚。而来源链仍钉着组件源码树 `8354d9a0…`（0.1.5），并且还会对该目录跑一次 `npm ci && npm run build` —— 用不同工具链重建出的 minified 字节与发布字节不同，补丁的 check/apply 锚点在它上面全部落空。此前没暴露，是因为适配器里有一段「源码构建专用改写」把 A 的闭合形态差异兜住了；0.1.7 退役 A 时那段改写一并消失，兜底随之失效。
    **修法**：来源链改用**固定 npm 发布产物**作为该组件的输入——`curl` 拉 0.1.7.tgz、`sha256sum --check` 对照钉在 workflow 里的哈希、解包进 `vendor/dshmarketplace-plugin`；**把它从插件源码构建循环里移除**（发布产物自带打包好的 `lib/`，重建只会换掉字节）；provenance 从「上游 commit/tree + 源码文件哈希」改为「发布 tarball URL + 哈希 + 包版本」。这条输入与 Koffi/Sharp/Canvas/Termux 同类：**可信二进制输入，显式披露并钉哈希**，不声称本地源码编译。
    **复验证据**：本地端到端复刻该流程（拉 tarball → `sha256sum --check` OK → 解包 → 按 CI 同一命令打补丁）后，`lib/index.js` 与 `lib/client.js` 与仓库镜像**逐字节一致**（LF 归一后同哈希）；这同时证明了「发布产物 + 注册表补丁 = 镜像」这条等式成立。完整来源构建须由下一次远程 run 验证。

206. **pnpm 布局下引擎补丁只打顶层副本，store 那份未打补丁 ⇒ 引擎 boot 硬崩（2026-09-27，真机 HUAWEI SGT-AL10 实测）**：
    **现象**：来源审计 APK 装机后引擎起不来，`engine.log` 首行 `dsh: host preparation failed: No usable native binding found for node-addon-require-builtin-android-arm64 (auto)`，三种候选（optional 包 / `build/nodeabi/node-v137-android-arm64` / `build/napi/napi-v9-android-arm64`）全落空，`info.txt` 记 `engine_exit: exit=1`。
    **真因**：`node-addon-require-builtin` 上游**不发布 Android 产物**，项目对策是引擎树补丁 `narb-android-N1`（把 `createEntryApi()` 包进 try/catch，回落 `require(moduleId)`，靠壳侧 `--expose-internals` 生效）。但来源链的引擎树是 **pnpm 布局**：同一包在顶层物化目录与 `node_modules/.pnpm/**` store 各有一份**物理文件**，而补丁只按登记表的顶层 target 写入 ⇒ store 副本保持原始字节；运行时按依赖查找解析到的正是 **store 那份**（设备栈路径即 `.pnpm/node-addon-require-builtin@0.1.6/...`）⇒ 加载未打补丁代码 ⇒ boot 硬崩。同批实测 **`pi-toolcall-G2`** 的 store 副本同样未打上——该补丁在设备上等于从未生效（静默功能缺失）。正常（LFS）链没有这个问题：它的引擎树是扁平 npm 布局，不存在 `.pnpm` 副本。
    **为什么 CI 全绿却发得出去**：快照检查器抽验 marker 时只看**顶层 target 那个文件**（恰好是打过补丁的那份），「同一目标的其它物理副本是否也带 marker」这条判据根本不存在。
    **修法**：新增 `scripts/source-build/reconcile-engine-patch-copies.mjs`——构建期把已打补丁那份的字节写全到「同包 + 同包内相对路径」的其余副本；目标找不到、或所有副本都缺 marker 一律判红。接进快照步骤（重打包之前），报告随 artifact 附出。同时给检查器加**副本面判据**「任何物理副本都不得缺 marker」，并在两个 workflow 的早期步骤跑新单测。
    **踩到的两个坑中坑**（都已固化成用例）：① 判据若用「路径结尾相同」匹配，`lib/bin.js` 这类短后缀会把**别的包**的同名文件误判成副本（实测把 `dsh-experimental-webworker-packer/lib/bin.js` 报成未打补丁）；引擎根包自身的文件必须**精确相等**。② 匹配器的「根」在两个调用点必须同一约定（引擎根 = `@deepseek-ai/dsh` 目录本身）——一度出现检查器传引擎根、收敛脚本传 stage root 的错位，导致精确匹配恒落空。
    **复验证据**：以真实快照的引擎树为靶——收敛前核对报 2 个目标各 1 份未打补丁副本（N1 的 872 B store 副本、G2 的 64152 B store 副本），跑收敛脚本后为 **0**，改写副本与已打补丁那份 sha256 逐字节一致；新单测 5 例全绿（含短后缀误报反证、幂等、全缺 marker 判红、目标缺失判红）。

207. **来源审计链的专有门禁不在任何清单里：新增第三条链时漏了「谁跑哪些门禁」这一步（2026-09-27）**：
    **现象**：来源链的 5 个专有门禁——`check-package-lock-roots` / `check-dsh-runtime-dependencies` / `check-android-native-runtime-packages` / `check-dsh-source-snapshot` / `check-dsh-source-snapshot-gate`——既不在 `check-release-gates.mjs` 的声明集合（32 项）、也不在 `build-apk.mjs` 的 `GATE_SCRIPTS`、也不在 `check-gate-skips.mjs` 的链枚举里；全仓只被自己那条 workflow 与 docs 引用。实跑 `node scripts/check-gate-skips.mjs` **仍然 PASSED**——盲区是隐形的。其中 `check-package-lock-roots.mjs` 最脆：单测只 import 纯函数 `checkPackageLockRoot`、不走 CLI 主块，两个 workflow 里的调用点删掉后脚本与单测都还在、三条链全绿，而门禁**从未真跑**。
    **真因**：新增一条构建链时，没把它的门禁登记进「谁跑哪些门禁」这条纪律。而 `check-gate-skips.mjs:78` 的 `CHAINS` **不能简单加第三条**：`executionSites`（:67-77）只认 `.mjs` 的 `gate('x.mjs')` 与 pwsh 的 `node … scripts\check-x.mjs` 两种形态，**没有 YAML 分支**；强行加入会让「声明集合每一项都被本链调用」这条断言对来源链必然判红（它只间接经 `build-apk.mjs` 跑）。同族的两处非递归扫描：`node --check`（`check-release-gates.mjs:251`）只列 `scripts/` 与 `scripts/lib` 两层，`scripts/source-build/` 等 5 个子目录共 **47 个 `.mjs` 从未被解析过**；SKIP 审计（`check-gate-skips.mjs:102`）的 `readdirSync` 同样非递归。
    **修法**：① `check-release-gates.mjs` 新增独立常量 `SOURCE_GATES` 与第三条链位置 `source-chain`（沿用 `ci-apk` 的 `needsApkTree` 模式；**刻意不进 `GATES`**——`ALL_GATES = GATES.map(...)`，进册会要求本地链与云端链也调用它们）；② 同文件 `node --check` 扫描面改为**递归**遍历 `scripts/` 全树；③ `check-gate-skips.mjs` 的 SKIP 审计同样改递归。
    **复验证据**：`PASS source-chain 门禁集 ⊇ 声明集合（5 项）`。判别力反证——把 workflow 里 5 个调用点全删 → 5 个全报；只删 1 个 → 精确报那一个。扫描面 75 → **122 个**、SKIP 审计 37 → **44 个**，两门禁仍 PASSED。
    **未闭合**：`CHAINS` 的反向断言（声明项必须有真实执行点）对第三条链仍无对应实现——本轮用 `source-chain` 位置覆盖了「声明了却没接线」这个主方向，其余待后续把 `executionSites` 扩到 YAML 形态。

208. **判据「空过」：空集恒真、静默 continue、地板值远低于现实（2026-09-27）**：
    **现象**：四处新判据在「输入为空」时恒真，即**因为什么都没找到而判绿**。
    ① `check-package-lock-roots.mjs` 的受检集合是**发现式**的（只收存在 `package-lock.json` 的目录），旧实现无空集守卫：删掉/改名任一锁文件它就静默退 0，打印「一致: N 个目录」。而 `build-apk-source.yml` 的插件循环按 `if [ -f package-lock.json ]` 决定 `npm ci` 还是 `npm install`——**锁一缺就从「严格按锁文件」降级成「重新解析版本区间」，产出不再可复现而全链绿**。（对照：同一 workflow 的 pnpm 侧用的是 `--frozen-lockfile`，锁不符即失败。）
    ② `check-dsh-source-snapshot.mjs` 对 engine 补丁 `if (!marker) continue`：删掉 `marker` 字段、或写成全角括号注释（`replace(/（.*$/, '')` 后为空），该补丁就**同时退出**本判据与 `reconcile-engine-patch-copies.mjs` 的副本收敛（同一过滤条件）——两条路径一起静默跳过，而原注释承诺的「新增补丁自动纳入，无需再手改本文件」随之落空。
    ③ `check-android-native-runtime-packages.mjs` 的 `unreviewed.length` 在清单为空时恒为 0；采集根只有 `node_modules/.pnpm` 一处，且 `filesUnder` 显式跳过符号链接，布局一变（物化后第一方载荷挪到顶层）就会收不到东西。
    ④ `check-dsh-runtime-dependencies.mjs` 的地板值 `packageCount < 200`——实测 316/317，**静默少掉一百多个包也照样判绿**；同一条链上 `materialize-dsh-pnpm-packages.mjs:21` 用的是 `>= 266`。
    **修法**：① 加具名目录断言（`dsh-client-ui-responsive` / `dsh-shell-termux` 不靠发现、是写死在 `packageDirectories` 里的）与空集判红；② 加 markerless 计数并在核验前判红——要么补 `marker`，要么在 registry 显式登记 `overlayCheck:false` 走豁免（豁免有留档，与「忘了写 marker」不是一回事）；③ 加 `nativeInventory.length === 0` 守卫；④ 地板抬到 **266**，与同链 `materialize` 同源。
    **复验证据**：加守卫前先实测确认现状不会误伤（9 个受检目录全有锁、13 个 engine 补丁 marker 全非空、两处原生清单均为 27 项、实际包数 317）。① 正例「一致: 9 个目录」退 0 不变；反证——空集时逐条指名并退 1。全部 6 个 `source-build` 单测保持 PASS。

209. **来源链在解压校验处写 `xz -T0`，违照明文的并行上限铁律而门禁看不见（2026-09-27）**：
    **现象**：`scripts/source-build/check-dsh-source-snapshot.mjs:74` 解压快照做校验时用 `spawn('xz', ['-d', '-T0', '-c', snapshot])`——`-T0` = 吃满全部逻辑核。
    **真因**：`check-build-parallel-cap.mjs` 的受约束清单 `CONSTRAINED` 只有 5 个既有脚本，**来源链一个都不在**；且它的第 1 节只抓 `-T0` 字面量，第 3 节的「写死数字」判据只覆盖 `build-snapshot-013.mjs` 与 `build-apk-013.ps1` 两个文件。于是这条明文铁律（「模拟器优先」，其立项理由正是『构建链原先在压缩/解压处用 `xz -T0`』）在来源链上完全不受约束。本地跑 `run-local-source-chain.mjs`（文档化入口）时会与 MuMu 抢满 16 逻辑核；CI runner 只 4 核，云端反而无害。
    **修法**：改为消费单一常量 `-T${XZ_THREADS}`（从 `scripts/lib/shell.mjs` 导入），并把该文件列入 `CONSTRAINED` 锁住回归。
    **复验证据**：`PASS scripts/source-build/check-dsh-source-snapshot.mjs 无吃满型线程参数（-T0）`；判别力反证——`-T0` 字面量判红、`-T${XZ_THREADS}` 通过；`PARALLEL-CAP SELF-TEST PASSED`。
    **未闭合**：来源链另有两处**有界**的写死线程数（`prepare-termux-bootstrap.py:168` 的 `-T4`、`build-apk-source.yml:673` 的 `-T8`）——不吃满核，但要完全符合「并行度来自单一常量」须改构建命令本身，本轮未动，已在 `CONSTRAINED` 处登记。

210. **来源链不是逐字节可复现：两个独立根因，且「哈希恒漂」会让完整性判据整个失效（2026-09-28，两次远程 run 实测）**：
    **现象**：`3ec3b68` 与 `45bf047` 两次构建——两者**只差 8 个判据文件、一个都不写快照内容**——产出的 APK sha256 却不同（`7aff2320…` vs `99f64ede…`，artifact 相差 459 B）。
    **逐层定位**（这层比"哈希不同"本身重要，因为定位方法要能复用）：229 个 APK 条目 **SHA-256 级比对 → 227 个完全相同**，只有快照本体与其 `.sha256` 随从文件不同；再把两个 `assets/snapshot.tar.xz` 解包、对 35053 个常规文件逐个 sha256 → **264 个不同**。按目录归类后发现 264 里有 **259 个是 `@deepseek-ai/*/package.json`**，且**只差对象键序**（`{"include":…,"loader":…}` 与 `{"loader":…,"include":…}`），内容逐字相同。再往上追：316 个引擎包中 **260 个的 tarball 哈希本身就不同，而 version 全部相同**。
    **两个根因**：
    **① `pnpm pack` 产出的 manifest 键序不稳定**（主因，260/316 个包）。打包点是 `export-dsh-engine.mjs:74`，而该处注释写的意图恰恰是「packed manifests stay exactly as their source commits」——**意图是确定性，结果不是**。键序不确定的具体来源（pnpm 自身还是 harness 构建阶段）未定位到，故修法取「不管根因、在产出侧钉死」。
    **② `dpkg/available` 直接写入整份活上游索引**（次因，1 个文件）。`build-snapshot-013.mjs:586` 把 `indexText`（3000+ 条）整份倒进快照，而 `status`/`status-old` 只写 `needed`（本链实际装的 79 个包）——同一个函数里唯独这一个文件例外。索引由 `prepare-termux-signed-repo.py:84` **活取**（`:87` 只做「与签名 Release 比对」，证明索引是真的，却没证明它是钉版时那一份）。实测两次运行相隔 90 分钟，索引 sha256 已从 `795749e0…` 变为 `2bf37bba…`，连签名的 Release 都换了（`0707fca9…` → `4ec8dc46…`）——上游掉了 `codon`、`ecl` 两个**与本链毫无关系**的包。
    **为什么这条比"哈希不同"严重**：本链的核心主张是可来源审计、可外部复核，而验证闭环是「重跑 → 得到同一哈希 → 于是相信产物来自那份源码」。哈希恒漂 ⇒ 闭环不成立；更隐蔽的是**它把信号也一起淹没**——「两次构建哈希不同」从此不再是信号，那么真正该被发现的问题（比如某次构建静默少了个包，见坑 207-208 同族）就失去了最廉价、最强的兜底判据。**恒亮的警报灯等于没有警报灯。**
    **修法（三段，各自独立可用）**：
    **① 语义归一化**——新增 `scripts/source-build/normalize-snapshot.mjs`：把**表示层**差异（JSON/YAML 映射键序、pnpm 的时间戳字段 `prunedAt` / `lastValidatedTimestamp`）从摘要里剔除，给出稳定的 `normalizedManifestSha256`。三条设计约束缺一不可：**规则封闭**（每条写清"为什么这个差异不可能影响行为"）、**可无依赖复算**（外部人拿产物+脚本即可重算，不引第三方包，故 YAML 自带受限块映射归一化器）、**响亮失败**（遇到不认识的形态一律 throw）。关键边界：`dpkg/available` 那类**真**差异（包数 3003 vs 3001）**刻意不归一化**——把它和键序归入同一句"反正不影响"，就是给静默失败开后门。接入 `check-dsh-source-snapshot.mjs`（并把解包从"只解引擎前缀+canvas"改为全量，与外部复核方看同一份输入）。
    **② `pnpm pack` 之后就地规范化 tarball**（`export-dsh-engine.mjs`，落在 `packed.push` 记录哈希**之前**）：解包 → `canonicalJson` 重排 → 重打包。放在这里而不是产物末端，是因为此处上游尚无任何哈希被记录、也没有签名，规范化后的字节**就是**构建产物本身，此后所有 provenance 描述的都是真正发货的东西；放到末端则要重做 tar/xz、重打 zip、**重新签名**，反而引入三个新的不确定性来源。重打包自身确定用**可移植**手段（不依赖 GNU 专有开关——本机是 bsdtar，用它就要等一小时 CI 才知道对不对）：显式递归排序的条目清单定顺序、`utimesSync` 钉 mtime、不指定属主、gzip 经管道不写名字与时间戳。
    **③ `dpkg/available` 改由 `needed` 生成**（`build-snapshot-013.mjs`）：解析索引时留「包名→原始块」映射，输出 `[...needed].sort()` 的块。按名排序是必须的——索引自身的块顺序不保证稳定，不排序等于把不确定性从"包集合"挪到"块顺序"；`status` 本来就是 `[...needed].sort()`，两者口径遂一致。
    **复验证据（A+B 之前）**：归一化器在两个真实快照上跑——**归一化后仍不同的条目数 = 1，且正是 `usr/var/lib/dpkg/available`**（即设计上刻意不归一化的那条），证明规则清单既够用（263 个表示差异确实都是表示层的）也没越界。11 个单测全绿，含**四条反证**：YAML 序列不得被排序（判红）、时间戳字段缺席不得放过（判红）、**真差异绝不能被归一化吞掉**（多一条依赖/改取值/多一个文件/非 JSON 内容变，四个变体都必须使摘要不同）、**tarball 里的真差异不得被重打包抹平**。
    **复验证据（A+B 之后，同提交 `a0d1534` 并行两次构建）**：逐文件差异从 **264 个降到 3 个**——259 个 `package.json` 键序差异全部消失（B 生效），`dpkg/available` 不再是差异（A 生效）。剩余 3 个是 **pnpm 自己在 deploy 阶段生成的状态文件**（`node_modules/.modules.yaml` 的 `prunedAt`、`node_modules/.pnpm-workspace-state-v1.json` 的 `lastValidatedTimestamp`、引擎根的 `pnpm-workspace.yaml` 键序）——它们不在 B 的射程内（B 规范化的是 `pnpm pack` 产出的 tarball，而这 3 个在其后生成），但**全部已被归一化规则覆盖**。两个 run 各自记录的归一化摘要**逐字相同**（`ca8c7b69ea471824…`），我从两个 APK 各取出快照独立跑归一化器也得到同一值（`6899f4ed3f8ff3ae…`，两次相同）⇒ **语义可复现成立**。未继续追「原始 sha256 相同」：剩下那 3 个是 pnpm 的内部状态文件，运行时 pnpm 可能读它们，改写状态文件的风险大于它买到的收益。
    **⚠️ 同批踩到的坑中坑（坑 183 同型复发，已修）**：归一化最初放在**检查器**里，而检查器看到的是 `.deploy-tmp/.../snapshot.tar.xz`——**注入前**的那份；APK 装的却是 `build-apk.mjs` 经 `inject-all.py` 生成的 `snap-final2.tar.xz`（**注入后**）。两者条目数都不同（CI 记 42443，从 APK 实测 42839，差 396）。后果是**公布的摘要描述的不是发货产物**，外部复核方（只有 APK）根本复算不出来——而「可被外部独立复核」正是这条链的核心主张。`build-apk.mjs:304-320` 那一串既有门禁**全都跑在 `snapIn`（注入后）上**，只有新加的这一处跑在注入前。**修法**：从检查器移除，改由 workflow 新步骤「Snapshot semantic normalization digest」在 `build-apk.mjs` **之后**执行——直接 `unzip -p <APK> assets/snapshot.tar.xz`、解包、归一化，即**与复核方做完全同一件事**，产出 `snapshot-normalization.json` 随 artifact 附出。教训与坑 183 一致：**凡是「公布给外部的产出侧数字」，都必须取自最终产物本身，而不是取自它之前的中途文件。**
    **未闭合（B 的确定性与剩余风险）**：A+B 是否真能让两次构建的**原始** sha256 相同，须由「同一提交并行两次构建」实测；若仍不同，则还有第四类不确定性（例如 `pnpm pack` 之外的时间戳或 harness 构建阶段）。另：`preinstall.json` 的 `targets` 仍只有包名、不带版本，`.deb` 的版本与哈希同样来自活索引——上游抬版本时会静默换包，尚未钉。

211. **来源链 APK 比正常链大 3.1 倍：完整 pnpm deploy 按 Linux 宿主平台拉进了 1.2 GB 的 Linux 原生载荷（2026-09-28）**：
    **现象**：来源审计链产出的 APK **489 MB**，而正常链的正式发布包只有 **158 MB**——同样跑 `assembleDebug`、同一把 keystore、同一个引擎版本，体积差 3.1 倍。
    **逐层定位**（这个方法可复用）：把两边的 `assets/snapshot.tar.xz` 分别取出来、`tar -tvJ` 列清单、**按目录聚合体积**——比总数差分更能指向真凶：
    ```
                         他们        我们
    解压后总计        700.1 MB   2016.8 MB
    usr/lib/node_modules  189.0 MB  1629.4 MB   ← 差异全在这里
    usr/lib/perl5          53.0 MB    53.0 MB   ✓ 逐字节相同
    usr/bin/node           43.2 MB    43.2 MB   ✓
    libicudata.so.78.3     31.6 MB    31.6 MB   ✓
    usr/lib/ruby           29.5 MB    29.6 MB   ✓
    usr/share/vim          25.6 MB    25.4 MB   ✓
    ```
    条目数我们**更少**却**体积更大** ⇒ 差异必在少数巨型文件。再对 `node_modules` 单独聚合，前几名是：`@openai/codex` 的两个 Linux musl 二进制（246.7 + 212.3 MB，另有 `codex-code-mode-host` 66.2 + 60.4 MB）、`claude-agent-sdk-linux-{x64,arm64}`（205.7 + 205.2 MB）、`cua-driver-linux-*-gnu`、`sherpa-onnx-linux-*`、`sharp-libvips-linux-*`……
    **真因**：来源链做的是**完整 `pnpm deploy`**，而 CI 跑在 **Linux** 上 ⇒ pnpm 按**宿主平台**解析 `optionalDependencies`，把 `linux-x64` / `linux-arm64` 的原生载荷一并装进引擎树；**Android 是 bionic**，这些 glibc/musl 二进制在设备上永不加载。正常链没有这个问题：它从**设备基座**出发，基座上本就没有这些 Linux 载荷——所以「正常链有没有」是一条**已被设备验证过**的可靠判据（实测这批包在正常链快照里**一个都没有**）。
    **为什么之前没被发现**：`check-android-native-runtime-packages.mjs` 早就**看见**了它们，但定性是「跨平台部署的**外平台 payload**，不视为 Android 绑定」——**只记录不拦截**；而「快照内每个包都要有来源」这条反向面判据（`check-engine-overlay.mjs` 里有）**在来源链换门禁时没有对应实现**（见坑 200 的未闭合项），于是没有任何判据要求它们离开。**记账 ≠ 防线。**
    **修法**：`snapshot-config/slim.json` 新增 `platformDeadPackages`（21 条，逐条带平台与理由），`build-snapshot-013.mjs` 在 `engineStalePackages` 之后施加。删除面覆盖 pnpm 布局下实测在场的三处：`.pnpm/<enc>@<ver>*`（实体与大文件）、`.pnpm/node_modules/<pkg>`（提升副本）、顶层物化副本。守卫沿用 `engineStalePackages` 的形态：**命中的包若已在 overlay 登记表内即中止**（防把真依赖删掉）。
    **判据的两次修正（本节最该带走的东西）**：本条的判据先后错过两次，都记在这里以免重蹈。
    **第一版：按名字。**「包名里有 `linux` 就删」——错。`@openai/codex` 与 `@vscode/ripgrep-linux-*` 是 **`-musl` 目标的静态 ELF**（实测：无 `PT_INTERP`、`GLIBC_2.*` 与 `libc.so.6` 符号各 0 命中），**Android 内核就是 Linux，静态二进制能跑**；而 `claude`、`libcua_driver_sdk.so`、`libonnxruntime.so`、`libvips-cpp.so`、`koffi.node` 才是有 `INTERP=/lib/ld-linux-aarch64.so.1` / GLIBC 符号的 glibc 件，**确实死**。判据应为**实测 ELF 的 `PT_INTERP` + GLIBC 符号**，不是名字。
    **第二版：按「与作者发布保持一致」。** 也错——**他的发布里同时含退役件与个人插件**：`dsh-attachment-formats`（PDF/Office/OCR 过渡插件，**0.13.7 用户已拍板退役**，注释原话「包体仍在基座快照内，不再装载即等于退役」）连同其 80 个依赖（mammoth/exceljs/pdfjs-dist/tesseract.js/jszip…）躺在基座里；另有 `dsh-code-diff-viewer`、`dsh-find-plugin`（他从市场装的私人插件，见 profile 的 `.package-map.json`）。**「他有我无」不构成缺口，「他有」也不构成依据。**
    **第三版（最终）：判据是「不对称」的，两个方向不能互推。**
    - **删掉「他的发布里也没有」的 ⇒ 安全。** 他的发布是**设备验证过的运行配置**：「没有这些也能跑」是实测结论，比任何静态分析都直接。本条剔除的平台件正属于这一类。ELF 实测（第一版）回答的是「**能不能跑**」，回答不了「**该不该有**」——`@openai/codex` 确实能跑（静态），但删它仍然安全，因为**他的发布里同样没有它而应用照跑**。
    - **补上「他的发布里有」的 ⇒ 不成立。** 他的基座里混着**退役件**与**个人插件**（见第二版），「他有」不构成「我们该有」的依据。
    我此前正是用后一个方向的证据去否定前一个方向，才来回翻。**结论：按「他也没有」做减法是对的（本条全 21 条照删）；按「他有」做加法是错的（那 83 个包不补）。**
    另注：profile 的 `node_modules` 本就是**给后来安装的树外插件**准备的（上游 `profile.ts`：「the hoisted linker gives **out-of-tree plugins** a flat node_modules」；`pnpm-workspace.yaml` 里 `nodeLinker: hoisted`）——故「镜像里没带、用户后续自己装」是**设计内的路径**，不是能力缺失。
    **权威清单仍是最终依据**：某条该不该删，先看 `profile-web.cordis.patch.yml` / `engine-overlay.json` 的装配行与 `slim.json` 的退役记录；产物对比只是线索。本键**分设两处**：`libreoffice-kit-wasm`（145 MB）体积可观但是 **WASM、平台无关**，必须保留；平台件另立 `platformDeadPackages`、逐条写明平台与理由。
    **方法教训（本轮付了两次假警报的代价）**：拿两份产物做「他有我无」对比时，**基座的偶然内容会一直污染结论**——退役件、个人插件、安装残留都在里面。必须先查权威清单再下结论。三次对比里**只有一次是真命中**（`usr/lib/node_modules` 我们 1614 MB vs 他 189 MB）；另两次（`home/.dsh/profiles` 我们小 101 MB、83 个包「只在他们有」）**全是上面那两类**。
    **复验证据（静态）**：用真实快照清单模拟匹配——715 个 store 目录中命中 23 个，**21/21 个包全覆盖**（另两处删除面亦确认在场）。量化：将剔除 **1210.2 MB**（未压缩），快照 2017 MB → 约 807 MB（降 60%）。
    **复验证据（远程 run 36363497221 / 36363504676 实测）**：**精简完全生效**——`归档 snapshot.tar.xz (158.3 MB)`，即 **483.5 MB → 158.3 MB**，与正常链的 153 MB 同量级；快照步骤耗时 **9.8 分钟 → 约 2.3 分钟**。
    **⚠️ 同批被安全网拦下（这正是它该有的行为）**：两条 run 都在 `Build runtime snapshot` 判红 ——
    `@deepseek-ai/dsh-subagent-codex -> @openai/codex: no installed package.json in the deploy tree`。
    定位时**已经看到**这条依赖（「被依赖 1 处，来自 `@deepseek-ai/dsh-subagent-codex`」），但当时判断「它是 musl ELF、Android 上本来就 exec 不了，删与不删功能等价」——**功能判断对，声明仍在**，所以 `check-dsh-runtime-dependencies.mjs` 判红有理。注意它与此前那几个不同：`@openai/codex` 的**包名是中性的**（不像 `-linux-x64` 那样带平台后缀），只是**内容**是 Linux 二进制。
    **修法**：让检查器认识「刻意缺席」——读同一个 `slim.json` 的 `platformDeadPackages`，命中的缺依赖**不计 failure 而单独计数**（`deliberatelyAbsentCount` / `deliberatelyAbsent[]` 进报告）。三条理由：① 该二进制在设备上本来就 exec 不了，删与不删功能等价；② **正常链的设备验证快照里同样没有它**，而正常链跑得好好的；③ 清单与判据自洽——**谁把某条从 `platformDeadPackages` 删掉，这里立刻恢复判红**。「放过不等于静默」：刻意缺席单独计数列进报告，外部复核方看得到。
    **未闭合**：`@deepseek-ai/libreoffice-kit-wasm`（145 MB）**刻意保留**——它是 WASM，「正常链没有」不足以定它的死（正常链的基座是 0.12.5-fx-1 时代抓的，该包可能只是当时还不存在）。要动它必须先做一次真机文档转换验证。另：本批未做真机启动验证，`@openai/codex` 的缺席对 `dsh-subagent-codex` 子智能体的实际表现（报错形态是否可接受）须由设备确认。

212. **来源链漏了聚合门禁的前置：调 `build-apk.mjs` 却不跑 Kotlin 单测，必然死在那条门禁上（2026-09-28，run 36365082160）**：
    **现象**：平台死重剔除修好后，来源链**第一次走到 APK 步**（此前都在快照步骤就断了，正是这一点掩盖了本条），随即判红：
    ```
    CHECK-KOTLIN-TEST-COUNT FAILED：缺 Kotlin 单测结果 …/app/build/test-results/testDebugUnitTest
      先跑 ./gradlew :app:testDebugUnitTest；无 gradle 的环境用 --allow-missing 显式 SKIP。
    ```
    **真因**：`build-apk.mjs` 是各链共用的编排器，会执行聚合门禁集，其中 `check-kotlin-test-count.mjs` **按设计**在没有 gradle 结果时判红（拒绝「一个用例都没跑」冒充通过）。上游 0.14.2-fx-2 的 G.0 ⑤ 修掉了这条结构性脱节——**去掉了 `--allow-missing`**，改为「**调用方必须先产出结果**」。本地链与发布链（`release.yml:193`）都已在 APK 步之前跑 `./gradlew :app:testDebugUnitTest`，**唯独来源链漏了这一步**。
    **为什么此前从未暴露**：来源链的失败点一直停在更早的步骤（凭据、锁文件、市场补丁锚点、平台死重…），**从没走到 APK 步**——**一个晚出现的门禁会被早出现的失败长期遮住**。而这与坑 200 同源：**新链必须逐条满足它所调用的共用编排器的全部前置，而这件事没有任何判据在守**（`check-release-gates` 只断言「声明集合被调用」，不断言「调用的前置已满足」）。
    **修法**：`build-apk-source.yml` 在 APK 步之前补「单元测试门禁前置（`:app:testDebugUnitTest` 全量）」步，与 `release.yml` 同做法；结果目录 `app/build/test-results/testDebugUnitTest` 由后续门禁就地读取并比对基线。
    **复验证据**：同一次 run 里它前面的门禁（`check-snapshot-builder-output`、`check-build-parallel-cap`）均 PASS，说明链路其余部分健康；本步补上后须由下一次远程 run 验证能否走完 APK 步。

213. **归一化摘要要求在**大小写敏感**的文件系统上复算——macOS 上会得到另一个值（2026-09-28）**：
    **现象**：来源链记的归一化摘要（`61687a40…`）与我拿同一个 APK 在 macOS 上复算的值（`0ba6a36c…`）不同，而**文件数（42783）、四条规则的命中数、跳过数（36）三项全部逐项相等**——计数全等、只有摘要不同，指向「某些条目的内容或路径串不同」。
    **排除过程**（留作方法）：① 先确认双方看的是同一份快照——APK 内 `assets/snapshot.sha256` 与我实算一致（`f8b70523…`）；② 换一个解包器（bsdtar → Python `tarfile`）得到**同一个**值，说明不是解包器差异；③ 查 tar 里有无**仅大小写不同**的路径——`tr A-Z a-z | sort | uniq -d` 命中 `usr/share/licenses/` vs `usr/share/LICENSES/`、`usr/lib/perl5/5.42.2/pod/` vs `Pod/`。
    **真因**：**macOS 的 APFS 默认大小写不敏感** ⇒ 上述两组目录在本地被**合并成一个** ⇒ 落在 `LICENSES/` 下的文件被 walk 成 `licenses/…` ⇒ manifest 里的**路径字符串**与 Linux 侧不同 ⇒ 摘要不同。**文件数不变**（合并的是目录、且无文件名冲突），这正是「三项计数全等却摘要不同」的来源。
    **结论与影响**：**链是对的，本地复算是错的**。公布的归一化摘要**确实可被外部复核**，但复算者必须在**大小写敏感的文件系统**上解包——Linux 天然满足；macOS 需挂在大小写敏感的卷上（或直接以容器/Linux 环境复算）。**同一个坑在本会话里咬了两次**（最早那次链侧 vs 我侧的摘要差异也是它）。
    **建议的复算姿势**：在 Linux（或 `--case-sensitive` 卷）上 `unzip -p <APK> assets/snapshot.tar.xz | tar -xJ`，再跑 `normalize-snapshot.mjs`；本仓的 workflow 步骤「Snapshot semantic normalization digest」即为该过程的可执行版本。
214. **两条链的 gradle 调用口径不同 ⇒ 「本地发布链」组装必失败，而开发链全绿**（2026-09-28，本机 + 5556 实测）
    **现象**：`pwsh scripts/build-release.ps1` 走到 APK 步抛 `APK build failed (arm64-v8a)`，而**日志里没有 gradle 报错**
    （该行 `2>$null | Out-Null` 把输出整个丢掉，只剩 exit code）。同一棵工作树、同一份快照，
    `pwsh scripts/build-apk-013.ps1 -Suffix ""` 两个 ABI 都 BUILD SUCCESSFUL。
    **真因**：两条链调用口径不同——
      · 开发链：项目 wrapper、**不带** `--offline`（`.\gradlew :app:assembleDebug --no-daemon -PversionNameSuffix=…`）；
      · 发布链：**系统 gradle**（`D:\tools\gradle-8.10.2`）+ `--offline --rerun-tasks`。
      系统 gradle 的依赖缓存里没有本工程的 AndroidX 产物，离线档下直接判死：
      `No cached version of androidx.webkit:webkit:1.12.1 available for offline mode`（22s 失败；core-ktx / dynamicanimation 等同因，共 7 条）。
    **定位手段（记下来）**：把 gradle 输出丢进 `$null` 的脚本，只能得到「失败」两个字。手动复跑同一条命令并保留输出才拿到真因：
      `cd dsh-mobile-apk; gradle assembleDebug --offline --no-daemon --rerun-tasks`。
    **修法**：`build-release.ps1` 与开发链同口径——`$Gradle` 缺省时改用 `.\gradlew.bat`，命令改为
      `:app:assembleDebug --no-daemon -PversionNameSuffix="$Version"`（去掉 `--offline` 与 `--rerun-tasks`）。
    **复验**：同机 `.\gradlew.bat :app:assembleDebug --no-daemon -PversionNameSuffix=""` → BUILD SUCCESSFUL in 37s；
      随后整条 `build-release.ps1` 组装通过（APK 双 ABI + 快照/插件/清单齐备）。
    **同型提醒**：凡「两条链各写一份调用」的地方，都要问「是不是同一条命令、同一份缓存口径」。
      **开发链绿 ≠ 发布链绿**——这里的差别只有一个 `--offline`。

215. **HTTP 状态不是引擎所有权证明（issue #295）**：本地 3080 上任意服务都可以返回 200、303、401 或 403；若壳侧只看状态码，会在 force/restart/update 路径把外部监听器当成自己的引擎，进而盲杀或反复 spawn。**真因**是健康探测与所有权证明混用。**修法**：`EngineProbe.check().running` 保留健康语义，但破坏性启动/停止/认证恢复必须只接受本壳托管子进程，或当前 generation 的 `engine.log` token 行；旋转日志、未知 generation、精确 origin 之外一律 fail closed。停止后及 spawn 前必须再次确认端口已释放；TOCTOU 抢占只记录一次 `PORT_FOREIGN`，不得用 `pkill -f bin.js` 兜底。

216. **启动轮询的 401 也不能绕过所有权门禁（issue #295）**：WebView 的 main-frame 401 之外，启动线程直接探测到的 401 同样可能来自外部监听器；若直接调用 `EngineAuth.handleUnauthorized`，会清理/刷新壳侧 cookie 并把非本引擎当成认证失败。**修法**：启动轮询复用精确本地 origin + owned-process/current-generation proof + main-frame policy helper，未证明归属时只记录拒绝，不触发认证恢复。

217. **自包含 release checkout 的 runtime asset 门禁不能靠目录猜测（2026-09-29，release run 36589913818）**：**现象**：release workflow 的 checkout 确实包含 `app/src/main/assets/patched/*.js`，快照双 ABI 也构建成功，但严格门禁报告 `/home/runner/work/dsh-mobile-apk/dsh-mobile-apk/dsh-mobile-apk/app/src/main/assets/patched` 不存在，双 ABI 均被拒，因而没有创建 draft Release。**真因**：`check-runtime-assets.mjs` 只用 `ROOT/dsh-mobile-apk` 是否存在来猜协调仓布局；自包含 checkout/本地来源链已通过 `DSH_APK_DIR` 明确传入 APK 根，却被忽略，布局探测把门禁指向 phantom nested path。**修法**：`DSH_APK_DIR` 存在时优先 `resolve()` 使用它，目录猜测只作兼容回退；不放宽 `--require`，不自动生成或绕过 `assets/patched`。**复验证据**：APK 仓 `node scripts/check-runtime-assets.mjs x86_64 --snapshot app/src/main/assets/snapshot.tar.xz --require` 通过（3 资产逐字节同源、2 行为回归）；协调仓 `check-patch-mirror.mjs` 通过。发布链修复后必须重新触发 workflow 并核验 draft Release 资产面。

218. **自包含 release checkout 的 APK 打包路径不能在版本解析后重新硬编码（2026-09-29，release run 36596312313）**：**现象**：修复 `DSH_APK_DIR` 后，`CHECK-RUNTIME-ASSETS PASSED（abi=arm64，核对组合 3，SKIP=0）`，但随后构建阶段把快照写到被覆盖的 nested `$apkDir`；指纹门禁仍在正确 APK 根检查，报告 `SNAPSHOT-FINGERPRINT CHECK FAILED：快照 tar 不在场（app/src/main/assets/snapshot.tar.xz）`，整链在 `build-apk-013.ps1:455` 拒绝。**真因**：脚本开头已按布局把 `$apkDir` 正确解析为协调仓的 `Root\dsh-mobile-apk` 或自包含仓的 `Root`，但版本读取和输出目录计算后又无条件赋值 `$apkDir = Join-Path $Root "dsh-mobile-apk"`；同一脚本同时支持两种布局，却在中段丢弃了前置自检测结果。**修法**：删除覆盖，保留前置解析结果；不改变协调仓布局行为。**复验证据**：`check-patch-mirror.mjs` 与 `check-build-chain-abort.mjs --self-test` 均通过；失败日志中 runtime asset 门禁已通过，下一次 release workflow 必须验证双 ABI 继续通过。

219. **跨平台发布链不能假设 PowerShell 的 `$env:TEMP` 存在（2026-09-29，release run 36599977147）**：**现象**：两处 self-contained APK 根目录修复后，arm64 与 x86_64 均完成 runtime asset 门禁、快照指纹门禁和 `assembleDebug`；导出注入后快照时，`check-snapshot-asset.ps1` 在 `build-apk-013.ps1:485` 报 `Cannot bind argument to parameter 'Path' because it is null`，双 ABI 资产未归集，因而没有创建 draft Release。**真因**：Linux GitHub Actions 的 PowerShell 运行环境未提供 `$env:TEMP`，`Join-Path $env:TEMP ...` 生成 null 临时路径；Windows 本地环境有 TEMP，因此问题此前未暴露。**修法**：用 `[IO.Path]::GetTempPath()` 获取平台运行时临时目录；不降低 APK 内嵌快照与发布快照的一致性门禁。**复验证据**：失败日志显示两 ABI 的 `SNAPSHOT-FINGERPRINT CHECK PASSED` 与 `BUILD SUCCESSFUL`，仅 snapshot asset checker 在临时路径绑定处失败；修复后必须重新触发 workflow 并核验双 ABI 资产、MANIFEST 和 draft Release。



220. **来源链的两处 `git clone` 没有「已存在则复用」守卫，本地复跑必撞（2026-09-29，本地链实测）**：
    **现象**：同一工作区第二次跑 `scripts/source-build/run-local-source-chain.mjs` 时，第 3 步直接报 `fatal: destination path '.deploy-tmp/deepseek-harness' already exists and is not an empty directory`，链在开头就停。
    **真因**：CI 每轮全新检出，`.deploy-tmp/` 恒为空，故 `git clone` 从不失败；而本地复跑时目录还在。**同一类不可重入**此前已修过两处（`bootstrap-extracted` 解包目录、NDK 的 `unzip` 无 `-o`），但 clone 这两处漏了——它们与那两处的区别只是「失败得早且直白」。
    **修法**：两处 clone 加 `if [ ! -d <dir>/.git ]; then ... fi`；保留显式 commit 的 `git fetch --depth=1`、`checkout --detach`、`rev-parse` 断言；detach 前先复位该专用源码树，避免上一轮改过的 tracked 输入提前阻断 checkout。CI 上是无操作。
    **为什么记进坑位**：有了本地链运行器（`run-local-source-chain.mjs`）之后，「链的幂等性」从 CI 的隐含前提变成**本地可观测的判据**；每加一处 `clone`/`unzip`/`tar -x` 到已有目录都要想一遍。判据不是「CI 绿」，而是「同一工作区连跑两次都绿」。

221. **两处大件下载没有「已存在则跳过」守卫：本地每轮白下 ~735 MB（2026-09-29，本地链实测）**：
    **现象**：本地链复跑时，NDK R30 Linux 归档（**704 MB**）与 Termux bootstrap（31 MB）即便已躺在 `.deploy-tmp/source-build/` 里，也每轮重新下载——两条 `curl --output` 无条件覆盖。
    **真因**：与坑 220 同源（CI 每轮全新工作区，下载步骤从未被要求幂等），属「本地跑同一条链」暴露的第二类隐含前提。
    **修法**：两处加「验哈希后跳过」守卫——NDK 先按钉死的 sha1 `--status` 校验，过则跳过下载；bootstrap 从 `prepare-termux-bootstrap.py` 的唯一 SHA-256 常量读取 cache-hit 判据，只有哈希命中才跳过，半包/坏缓存重新下载；该 Python 准备器仍在解包前无条件核验。**跳过不等于放行**：原有的哈希校验无论下载与否都照跑。
    **为什么用「验哈希」而不是「看文件在不在」**：这两个输入都钉了哈希，验过再跳过才既不重下也不放过坏文件；对没有独立校验的下载（如 17 KB 的市场产物）另说。
    **量化**：本地每轮省 ~735 MB；CI 侧无操作。Gradle 侧的一次性成本另计（发行版 + Maven 依赖，之后长期复用）。

222. **Harness 构建步不复位固定 checkout：中途被杀后复跑会在全仓类型检查处假红（2026-09-29，本地链实测）**：
    **现象**：本地链复跑时 Harness 构建步报 `packages/llm/llm-deepseek/src/host.ts(41,10): error TS2345: ... '"loader/volatile-update"' ...`（`llm-pi-ai` 同型），看着像上游源码不兼容。
    **真因**：该步的顺序是「先全仓 `tsc -b tsconfig.host.json` → 再替换五个旧版 Cordis 源码 → 再单独编译旧版包」（坑 187 定的口径）。上一轮若在**替换之后**被杀，工作区就停在替换态；这一轮的全仓检查于是拿**当前**源码去配**旧版** loader，`loader/volatile-update` 之类事件自然不在旧版 `Events` 里 ⇒ 假红。CI 每轮全新检出，所以从未暴露。
    **修法**：取源 detach 前与构建步首都复位专用 checkout（`git checkout -- .` + `git clean -fdq`，不带 `-x`，保留忽略依赖缓存）；构建步同时从本次 `GITHUB_SHA` 恢复权威 overlay 输入，避免上轮停在第一方 pin 已摘除的阶段而无法续跑。清理前验证 realpath 未脱离专用工作区。
    **为什么记进坑位**：与坑 220/221 同族——**「可被杀」是本地跑链的常态**（关机、换盘、手停），因此每个「先改后还原」的步骤都要自带复位；判据仍是「同一工作区连跑两次都绿」。此坑尤其阴：报错文本指向源码不兼容，容易误导人去查上游。

223. **`pnpm deploy` 目标目录非空，本地复跑必判红（2026-09-29，本地链实测）**：
    **现象**：Harness 构建步报 `ERR_PNPM_DEPLOY_DIR_NOT_EMPTY`，指向 `.deploy-tmp/engine-deploy`。
    **真因**：`pnpm deploy --prod <dir>` 要求目标目录为空或不存在；CI 每轮全新工作区故从不暴露，本地复跑时上一轮的部署树还在。
    **修法**：deploy 前验证非空 workspace 与 `.deploy-tmp` 的 realpath，再仅清理引号内的绝对 `engine-deploy` 目标（不清理源码、缓存或 provenance 兄弟目录）。语义上这里需要全新部署树，CI 侧为无操作。
    **同族**：坑 220（clone 无守卫）、221（大件重下）、222（构建步不复位）。四处都是同一个前提——**「工作区干净」是 CI 的隐含条件，不是链的语义**；本地跑链把这四条一次性暴露出来。判据统一为「同一工作区连跑两次都绿」。

224. **本地自组快照但漏 snapshot.sha256 ⇒ 升级装上了、运行时却永远不刷新（2026-09-30，9c2a0c45 实测）**：
    **现象**：换快照重打 APK（vc 43→44）覆盖安装并启动，引擎正常 boot、无任何报错，但
      files/.snapshot-fingerprint 停在旧值、live profile 里该更新的包原样不动——**刷新从未发生**。
    **真因**：EngineManager.bundledFingerprint() 读的是 assets/snapshot.sha256（发布链
      build-release.ps1 生成）；本地 assembleDebug 只校验 snapshot.tar.xz **在场**（缺失才报错），
      不校验 sha256 文件。文件缺席 ⇒ bundledFingerprint() 返回空串 ⇒ snapshotFresh() 走
      「legacy build：不强制重抽取」分支 ⇒ 永远判 fresh。**静默路径**：装机成功 + 引擎正常 = 无任何信号。
    **修法**（本地链）：放快照后必须同步写 app/src/main/assets/snapshot.sha256（内容＝快照
      tar.xz 的 sha256 十六进制小写、无文件名后缀）。写完重打，装机启动即见
      .snapshot-fingerprint 翻转 + 事务跑完（本机 arm64 全程 <3 分钟）。
    **复验**：补 sha256（182e7ec6…）重打 vc44 装机 → 指纹翻转、两份 profile 的
      dsh-client-ui-responsive/lib/client.js 均更新为新产物（316,708B、含 rootGrantState）。
    **上游可报**：assembleDebug 对「有 tar 无 sha256」应显式报错而不是当 legacy 放行——
      这是一条「升级了但升级内容永不生效」的静默失败路径（issue 候选）。

225. **写后回读的回包缺 `ok` ＋ 拒收码不进 CALL_REASON ⇒ 已成功的动作被渲染成「失败：原因未在本版登记」（2026-09-30，用户实测撤销同意）**：
    **现象**：设置页取消勾选「已阅读」提示「撤销同意失败：调用失败原因未在本版登记」——实际状态**已生效**（重查状态可见 consentValid=false、granted=false）。
    **真因**：①`RootGrant.setConsent` 回包只带 state 字段、**没有 `ok:true`**，而页面结算 `settleLinkCall` 只认 `answer?.ok === true`，缺字段一律走失败支；②`setGranted` 的拒收回包只有 `code/guidance`，人话翻译 `describeCallReason` 只读 `reason`，两个码（consent-required / not-root-channel）又不在 `user-copy.ts` 的 `CALL_REASON` 唯一真源里 ⇒ 落 `UNKNOWN_CALL_REASON` 兜底文案。
    **修法**：①`setConsent` 显式 `put("ok", true)`（SharedPreferences.apply 同步写，无失败支）；②`setGranted` 拒收分支同时带 `reason`（= code，code 留给 data-code/grep）；③两码登记进 CALL_REASON 表。回归钉三处：TSX「结算只认 ok===true」「拒收翻译不落兜底」+ Kotlin 源码契约（setConsent 体必须含 put("ok", true)、setGranted 体必须含 put("reason")）。
    **通则**：**凡页面用 settleLinkCall 结算的桥方法，成功回包必须显式带 ok:true；凡可能失败的 reason 码必须同步登记 CALL_REASON**——缺一样就是「静默成功 + 吓人报错」或「未登记兜底」，两者用户都读不出真相。

226. **JavaBridge 线程里创建 WebView/弹窗 ⇒ bridge 回包还能带回异常，但进程随后原生崩溃（闪退）（2026-09-30，用户实测「点免责声明闪退」）**：
    **现象**：设置页点《AI root 权限免责声明》，应用直接闪退（不是弹窗失败，是进程消失）。
    **真因**：`@JavascriptInterface` 方法在 **JavaBridge 线程**被调用；`LocalDocs.open` 在该线程直接 `WebView(activity)` + `AlertDialog.show()`。bridge 回包能带回 `IllegalStateException`（被函数内 catch 抓到、如实回 ok:false），**但 WebView 已在错误线程上被创建**，随后渲染启动 → 原生层崩溃、进程消失（CDP 复现：pid before 有值 → 调 openRootDisclaimer() 回 {"ok":false,"reason":"IllegalStateException"} → 3 秒后 pid 消失）。
    **修法**：整段 UI 组装 marshal 到主线程（`activity.runOnUiThread`），用**短闩（1.5s）**等真实结果——超时回 `ui-thread-timeout`、组装抛错回异常类名，**绝不谎报已打开**；catch 用 `Throwable`（Error 也要拦住，否则又是进程级闪退）；弹窗关闭即 `view.destroy()`（WebView 重量级，不销毁会泄漏）；静态文档 `javaScriptEnabled = false`。
    **判据（源码契约）**：`open()` 体内必须出现 `runOnUiThread`，且 `WebView(activity)` / `AlertDialog.Builder` 的构造**出现在它之后**（LocalDocsTest 钉死）。
    **通则**：**凡从 `@JavascriptInterface` 里碰 UI（WebView/对话框/View/Toast 的创建），先问「这段代码跑在哪个线程」**——`startActivity` 类调用是线程无关的，UI 对象的创建不是。同类桥方法（ExternalLinks 只做 startActivity）不受影响。

227. **root 通道写盘把文件属主变成 root:root ⇒ 应用自己读不回来（2026-09-30，主人点名「Root 属主这种 bug 也得找一找修一修」）**：
    **现象**：root 身份（Shizuku 以 root 启动的 UserService / su）写进应用数据目录的文件与 mkdirs 出的目录，属主是 `0:0`；应用侧对它的写入直接 `Permission denied`（0644 尚可读，可写面全死）⇒ watcher / 插件更新 / 引擎读写连带失败。
    **真因**：全仓**零 chown 处理**（grep 实证）——`ShizukuUserService.writeChunk` 以 uid 0 落盘、su 命令写盘同理，谁都没把属主修回来。
    **修法（两条路径都做）**：①**su 直连（主路，不依赖 Shizuku）**：`RootAccess.repairOwnership`（路径限应用数据目录内 + `find -not -user <uid> -exec chown <uid>:<uid> {} +` + restorecon）+ `execRoot` 原语 + `ShellOps` 在**通道级失败**时回退 su（命令自身 exit≠0 不重跑）；②**Shizuku 通道（AIDL v3）**：`configure(appUid, appDataDir)` 回填身份 + `writeChunk` 写后自愈（含 mkdirs 父目录）+ `repairOwnership` 有界遍历（`lchown` 不跟随符号链接、只归一到已配置的应用 uid、越界拒绝）。③启动期热点路径顶层抽查 + 页面「修复文件属主」按钮；**逐项失败必须计数暴露**（旧版只在成功时累加 ⇒ 全失败也报 ok:true 的静默形态）。
    **复验**：root 种文件/目录（属主 0:0）→ 应用侧写入 Permission denied → 跑修复 → `healed=4`、属主翻回 10241、应用侧写入 OK。
    **Kotlin 坑**：拼 shell 脚本时 `"$P"` 会被当 Kotlin 变量插值（编译期 Unresolved reference）——shell 变量必须写 `\$P`。

228. **UserService 跨应用重启存活 ⇒ 新加的 AIDL 方法「装上了却调不到」（2026-09-30 实测）**：
    **现象**：新版本 APK 装了、代码在、`repairOwnership` 却恒返回 unsupported（configure 静默失败），属主一个没修。
    **真因**：Shizuku 的 UserService 进程**由 Shizuku 管理器持有、跨应用重启存活**；`UserServiceArgs.version(...)` 取自 `BuildConfig.VERSION_CODE`，**versionCode 不变时 Shizuku 不会重建服务** ⇒ 跑的还是旧版 dex，v3 的 transaction 根本不存在。
    **修法**：①加 AIDL 面就**同时 bump versionCode**（让 Shizuku 自动重建）；②已有的出口是设置页「重置链接」（`unbindUserService(remove=true)` 强制移除后重建）；③代码侧一律 `runCatching` + 结构化 `*-unsupported` 回报，**不假装成功**。
    **复验**：vc 44→45 重装后 `configure` 生效、`repairOwnership` 返回真实计数。

229. **原 root 策略只认 su 授权/旧开关，且派发后异常回退会重复命令（0.14.3 源码修订）**：
    **真因**：应用获得 root 与授权 AI 使用 root 是两件事；原始 granted bit 在升级后仍可能为真，当前版本 consent 已失效。将所有 shizuku/root/shell 错误归为可回退又混淆派发前不可用与派发后结果不明。
    **修法**：最后执行点使用有效 RootGrant；新 consent 不复活旧开关；root Shizuku/su 为替代通道。ShellOps 仅精确派发前不可用白名单回退一次，不重跑 root-policy refusal、非零 exit、超时或 Binder 结果不明。v4 configure 加完整 UID/anchor 回读确认，绑定 version 同时编码 protocol，旧服务拒绝派发。
    **证据**：源码与 pure decision/dispatch-count 需求已补；当前维护者新 head 的构建与外部三层验收仍待收口，不沿用作者旧 head。

230. **path 型 chown 与事后 cap 不能界定维护副作用，顶层抽查漏深层启动污染（0.14.3 源码修订）**：
    **真因**：canonical/lstat 与后续路径变更之间存在替换窗口；find 先执行再数结果不能限制已发生变更；uid 归一不证明 SELinux 标签正确。
    **修法**：固定签名 APK helper 与共享 held-FD Android adapter；O_PATH/O_NOFOLLOW pin、访问前预算、深度/deadline、fstat/fchown/fstat 对照、hardlink/foreign/device/special-node 拒绝。protected_hardlinks 不明拒绝，root-origin 可被其它主体写入的 regular 拒绝。维护与本应用受控特权执行用读写栅栏，结果含失败/截断/未验证计数；明确不做 SELinux relabel，不能锁住外部特权 namespace。
    **证据**：fake walker/参数解析夹具已写但未运行；描述符策略与非原子 root 竞态限制见 ROOT-MAINTENANCE.md，待外部验证。

231. **维护放在事务恢复之后/主线程等待，既来不及自愈又可能冻结 UI（0.14.3 源码修订）**：
    **真因**：污染的 marker/stage 可能在 fresh 判定前的恢复期已被读取；同步修复回包把提交任务误报成完成。Service onStartCommand 不适合等待 root/Binder。
    **修法**：Activity/Service 的后台 startup worker 在事务恢复前进入共享 single flight，近同时启动复用5s内结算；caller 最多30s，未知结果仍保持 worker/fence，不重放。UI 请求立即返回，既有 root 状态轮询结算；仅完整计数/flags/remaining 合法才显示完成，部分/未知明确提示。
    **证据**：源码与异步 UI fixtures 已补、尚未执行；外部需验证 Binder 卡住、前后台/关闭、并发栅栏和三层实际体验。

232. **su/Binder本地超时或杀客户端不是特权后代结算，应用重启也不能清UNKNOWN（0.14.3源码修订）**：
    **真因**：root helper/远端RPC可能已写盘，destroyForcibly、pipe close、reader join只描述本地进程/管道；同boot进程重建丢内存标志会重新派发并与旧helper并行。裸读tryLock还可插队公平写者。
    **修法**：UID0真正派发前RootMaintenanceLease同步commit；Context栅栏锁前/锁内读lease，公平零毫秒timed读锁；helper只有完整JSON+确定exit0/2可finish，已确认部分信封仍ok=false。exit/drain/read/cleanup/Binder未知持续隔离新派发、维护、startup；同boot app restart/recreate不清，只有同boot-id/boot-count方案的真boot变化清。无手工清除。
    **证据**：当前源码与RPC wiring fixture在场，未执行；真实boot/late ack/commit失败与副作用反证见 [外部测试需求](<docs/0.14.3-TEST-REQUIREMENTS.md>)。不沿用旧head或声称已测安全。

233. **cleanup也能阻塞waiter；不完整capture不可当ready文件（0.14.3源码修订）**：
    **真因**：直接destroy/close可能永久等待，晚到drainer继续写让“已返回partial”变化；发布仍被writer占用的spool会把半文件交后续pull。
    **修法**：ProcIo每个kill/stream-close独立daemon、同一cleanup预算join，短内存锁仅copy immutable partial；ShizukuCaptureIo private .part只在writer/flush/close已终止且全flags完整后rename，失败spoolReady=false/路径空。transfer每chunk在RPC紧前重读实际UID/有效consent，offset仅acknowledged-bytes，unknown不重放。
    **证据**：ProcIoSettlementFixtureTest/ShizukuCaptureSettlementFixtureTest/ShizukuRpcLeaseWiringFixtureTest已写未跑；要补真实后代持管道与部分写入，不把daemon线程或本地kill当远端证明。

234. **陈旧startup finally/Service teardown会抢新flow与wake锁；后台renderer重载可循环（0.14.3源码修订）**：
    **真因**：running/generation分离、等待后不复核、全局wake句柄让旧caller取消新owner；后台冻结不是前台无响应，destroyed WebView不可能靠reload重生。
    **修法**：StartupFlowOwnership单份CAS token/generation；ServiceEpoch每次等待后复查并按owner获取/释放wake锁；销毁只中断caller不杀共享root worker，pending六次[2,4,8,16,30,30]秒后停步。ForegroundPageRecoveryPolicy后台合并、前台一次quiet retry/recreate，holder新Activity重绑，重复崩溃停native error、保留userClosed/userShutdown。
    **证据**：StartupLifecycleOwnershipTest与Foreground政策/接线fixtures在场未运行；需外验晚到副作用、关闭后不复活、后台真实任务不被中断。

235. **迁移后的settings缺席不等于缺用户配置；factory reseed与旧导出路径会抹provider（0.14.3，#304/#305）**：
    **真因**：官方import将legacy YAML改名.imported，活配置在web profile patch；旧升级把缺YAML补空factory seed，旧桥还导出这个假真源。缺/非法内嵌SHA旧legacy fallback又可能把错误包当fresh。
    **修法**：stage保留import marker并抑factory seed；SnapshotUserData选活patch、同格式原子导入/备份、导出共享key警告，只隔离已知旧blank模板。MainActivity接EngineManager，legacy ConfigTransfer不挂；SnapshotFingerprintPolicy严格64hex拒缺/坏metadata，无legacy/degraded旁路。
    **证据**：SnapshotMigrationPolicyTest/SnapshotFingerprintPolicyTest在场未跑；双ABI包与连续升级/rollback假配置外验待交接，不填造产物hash。

236. **浏览器无bridge不代表storage隔离；UI focus不是模型Session/tab（0.14.3源码修订）**：
    **真因**：cookie不按端口隔离，Default共享jar让换loopback端口也可携主cookie；currentWorkspace/activeTab异步漂移会把工具写到邻会话。raw npm pi overlay也会丢官方pnpm补丁，PTC只改host环境仍让child失败。
    **修法**：BrowserHostProfile在load/settings前验证per-session nonDefault并自有worker策略，不支持即拒不回Default；控制捕获Session/tab/modelTab与UI舞台分开，refs/identity/viewport/error均per-tab；官方MIT UI私有复用、真实tab-menu扩展。PTC A1 host/child双文件与pi streaming020六provider exact SHA/context及副本同步入runner；普通snapshot post-apply已统一runner --check复核全部companion/exact verifier，不再只搜主target marker。
    **证据**：源码/fixtures/patch登记在场，未构建/未执行；HTTP/loopback storage隔离、UA/UA-CH、模型跨会话、PTC授权不downgrade待外验。旧资产尺寸/hash不当新测量。

237. **闸门A拒启与闸门B自愈互锁：只有能spawn才会写engine.log，而拒启恰恰不spawn（0.14.3，#309）**：
    **真因**：`liveRuntimeComplete()`在spawn前拒启（且先于force/可用性判定⇒看门狗force也绕不过），而自愈判据`snapshotLinkFailure`读的是**当拍engine.log尾部**——不spawn就永不产生该文件⇒自愈条件恒为假。全仓`refreshSnapshot`调用点只有冷启动一处，拒启路径为零；UI「重试」只`clearRefreshLedger`不删指纹，指纹新鲜时是no-op。于是「live树缺一条条目」这种可自愈状态把用户永久挡在错误页（issue实测36次/47分钟零恢复）。
    **修法**：拒启时先**取证**（缺失项+确诊分级+每项size/mtime，写进boot-fail与诊断包）再**删指纹**，借既有的`if (!snapshotFresh()) refreshSnapshot(...)`冷启动分支走完整重抽取——不新增调用点。触发条件是**双闸门**：预算复用`runtimeTreeHealedThisRun`（每次运行一次，避免重抽取→再失败→再重抽取），且缺失项里至少有一条是「快照自身条目」（`START_RECOVERY_CONFIRMED_ENTRIES`）。
    **为什么`REQUIRED_LIBS`成员刻意不触发自动恢复**：issue原文明确告诫「不要贸然补全该表」——该表只列`usr/bin/node`的8条`DT_NEEDED`，**不含传递依赖**，因此它的命中可能是假阴性（真缺的可能是`libicudata.so.78`那类传递依赖）。自动放宽的代价是每次启动白付一次8-12分钟全量抽取并抹掉现场，比不修更坏；故低置信度条目只记录，用户可在错误页主按钮**显式**重做一次（放行分级、不放行预算）。
    **证据**：`Issue309StartRecoveryTest`13例本轮exit 0（含反证：只有低置信度条目时必须拒绝；注入两处变异后实测2 failed已还原）。真机/模拟器删件冷启动与「只删一个库符号链接」两条外验未做。不改闸门A判据本身，带病的树仍不被spawn。

238. **属主维护「结算过严」把启动挂成「等待属主维护」直到整机重启（2026-10-01 真机截图实锤）**：
    **现象**：已授权 Shizuku（服务端 root）的设备升级 0.14.3 后，每次启动都停在「正在等待属主维护完成…维护结果尚未结算」；重启设备只清一次，下次开机又复现。AI root 开关无关（应用维护不走 AI 门）。
    **真因**：三层叠加——①`ShizukuTransport.repairOwnership` 把 `lease.complete(definitive = verified)` 写死：拿到**完整信封**的部分修复/超预算回执（DSH files 树超 20s 预算很常见）也被判「结果不明」⇒ `markUnknown` 耐久租约；②UNKNOWN 租约无产品出口，仅整机重启（boot-id 变化）可清；③`RootAccess` 的 granted 缓存只升不降，su 已拉不起来时启动自愈仍按旧缓存判「有 root 路」反复撞隔离。
    **修法**：①信封完整（ok 布尔 + checked/healed/failures/unverifiedMutations 非负 + remaining∈{-1,0} + truncated/deadlineExceeded 布尔）⇒ 一律 `finish` 租约，部分修复如实回 `repair-incomplete`/ok=false（对齐 ROOT-MAINTENANCE.md §2 原有承诺）；②`su-exec-failed`（spawn 即失败、零副作用）按「未派发」finish 而非 markUnknown，并在 `execPrivileged` catch 里把 granted 缓存降级 denied；③`autoHealOwnershipDirect` 改用与入口**同源的三态判据**（不可用/探测不完备都不做维护，如实回 `no-root-path` / `root-channel-unknown`），**worker 内不再清算**；④**真机补的第五处（只放 worker 里不够）**：清算必须发生在 `RootOwnershipJobs.start()` **咨询租约之前**、且在**同一临界区内**（`clearWhenNoRootChannel(context, guard)`，guard＝在飞维护复核）——`start()` 的 `outstanding` 短路会绕过 worker 内的任何清算，启动照样挂死。
    **复验**：`OwnershipLeaseSettlementFixtureTest`（21 条源码契约：信封结算/未派发结算/缓存降级/worker 同源判据/入口清算前提/租约锁内 guard/入口临界区/唯一非 owner 出口/派发证据接线/切片边界反证等）＋ `RootChannelDecisionTest`（判据真值表 12 条）。**真机 A/B（小米 14 Pro，vc45 本地变体）**：注入「同 boot 残留租约」+ 撤 root 路（Shizuku 未运行、su 缓存 denied）后重启——修前 345s 无任何 boot-start、引擎 HTTP 000、租约原封不动；修后 **15s HTTP 401、租约被清空**；恢复 root 路（su granted）再启亦 15s 起、租约建完即结算。

239. **契约测试的成员边界取错 ⇒ 防线被删掉仍然绿（2026-10-02 review 指出）**：
    **现象**：新增的 `OwnershipLeaseSettlementFixtureTest` 用 `substringAfter(签名).substringBefore("\n  /**")` 切成员体，断言全绿；review 指出这个右边界是**下一个文档注释**而不是下一个成员声明 ⇒ 切片会跨进隔壁函数（实测 `body("RootAccess","fun execRoot(")` 长 3393，把 `execPrivileged` 的 `fail("su-exec-failed")` 也切了进来）⇒ 把 execRoot 自己新增的拒绝集项删掉，断言照样绿（命中的是隔壁函数里的同名片段）。
    **真因**：`/**` 不是成员边界——**没有文档注释的相邻成员会被整段吞进切片**，而「同名片段在别处也有」正是这类假绿的温床。
    **修法**：先用**扫描器**剔注释（字符串字面量整体保留、行尾 `//` 与块注释剔除），再取**下一个顶层成员声明**作右边界——边界正则覆盖前置注解与修饰符（`public/private/internal/override/suspend/inline/…`）以及 `fun|val|var|object|class|interface|enum class|companion object`（与 `RootGrantTest.kt:128` 同口径）；断言只钉代码，避免文档措辞与隔壁成员把契约测试洗绿。
    **复验**：收紧后同一断言在删除真防线时判红（本 PR 的 `suSpawnFailureIsNeverDispatchedAndSettlesLeaseInsteadOfQuarantine` 用例）。
    **通则**：凡「grep 源码片段」的契约测试，先自问**切片右边界是什么**——按字符数（`{0,900}`）、按文档注释、按空行都是错的；**只认结构**（成员声明 / 花括号配对 / 缩进）。本 PR 最终版已把边界正则扩到注解/修饰符(`suspend`/`inline`/…)与 `fun|val|var|object|class|interface|enum class`，并用**扫描器**剔注释（字符串字面量保留、行尾 `//` 与块注释剔除），另加 `memberBoundaryDoesNotCrossIntoTheNextMember` 反证用例。

240. **Shizuku 服务端 v13.6：`checkSelfPermission()` 恒 denied、`getUid()` 撤权后仍返回 0 ⇒ 用 API **分不清**「已授权」与「授权被撤」（2026-10-02 真机两轮实测）**：
    **现象**：同一台机（Shizuku 服务端在跑、uid 0）做对照——①本应用授权 granted：自检报 **false**（假阴性）；②`pm revoke` 撤权后：`getUid()` 仍返回 **0**（服务端不按该权限校验）。⇒ 依赖单一信号的判据必然在某一侧误判：以自检为准会在**已授权**时误判为「不可用」并清掉隔离租约；以 uid 为准则在**撤权**后仍判「可用」而保留租约（那个场景不会被消掉）。
    **修法（本机取舍；已被坑 241 取代，本节保留为当时的取舍记录）**：判据**保守优先**——uid 读得到就按 uid 判（服务端 root ⇒ AVAILABLE、保留租约）；只有「uid 读不到 + 自检明确未授权」才判 ABSENT；通道**确定消失**（未安装 / 服务端没跑 / 非 root / su 也撤）才清算。要真正区分需要一个**决定性**授权探测（真正尝试 bind/configure 并读回权限码），列为后续项。
    **复验**：`RootChannelDecisionTest` 真值表（含 `readableRootUidIsAvailableEvenWhenSelfCheckSaysDenied`）；真机两轮对照：授权 granted ⇒ 租约保留 ✓；撤权 ⇒ 租约同样保留（限制如实记录，不粉饰）。

241. **通道判据的权限面假阴性被当成「通道不存在」⇒ 误清隔离；且「通道不可用」不等于「旧特权任务已结束」（2026-10-02 review 复审第 1、2 点）**：
    **现象**：两件事一起出现——①本机（Shizuku 服务端 v13.6、服务端以 uid 0 在跑）上，真实存在的 root 通道被判成「不存在」，残留维护租约随之被**自动清掉**，隔离失效；②反向也被判错：租约明明已把特权工作派发出去，只要此刻通道看起来不可用，就被当成「那条工作已经结束」放行清除。
    **真因**：①旧判据把客户端权限面当成通道证据——`status.granted == false` 时**根本没尝试绑定**就直接返回「通道不存在」；而该机 `checkSelfPermission()` 有假阴性、`getUid()` 撤权后仍返回 0（坑 240 已实测），所以这条信号在两侧都会错，结论却是**肯定式**的 ABSENT ⇒ 不可逆处置做在了不可信信号上。②`RootMaintenanceLease` 的 `synchronized` 只覆盖**本进程**，它证明不了外部 su 子进程或 Shizuku UserService 已退出；「通道不可用」判的是**当下**，不能推出「已派发的那次工作已结束」。
    **修法**：①判据改为**真绑定实证**：唯一入口 `ShizukuTransport.probeRootChannel`（原始信号经可注入的 `RootProbeEnv`，生产实现 `SystemRootProbeEnv`）——su 已授权 ⇒ AVAILABLE；ping 明确 false ⇒ 服务端不在；ping 抛异常 ⇒ 不判断；其余**真去绑定 UserService**（`ensureBound(..., requestPermission = false, ignoreGranted = true)`，不弹框、绕过不可靠的客户端权限预检）。纯函数 `decideNoRootChannel` **只认三类证明**（绑上且非 root uid / 未装 Shizuku 且无 su 二进制 / 服务端明确不在或协议明确不支持）⇒ ABSENT；**权限面被拒（`BindOutcome.DENIED`）只算 UNKNOWN**，其余也一律 UNKNOWN 保留隔离。②租约新增**派发证据**：`markDispatched(context, transport)` 与 `dispatched(context)`——su 在 `RootAccess.execPrivileged` 派发前写 `"su"`，Shizuku 在 `RpcLease.beforeRpc` 拿到租约后写 `"shizuku"`（写不进即置结果不明）。自动清算走纯函数 `autoClearAllowed`，四条件缺一不可（通道 ABSENT **且** `dispatched=false` **且** `unknown=false`（租约结果可信）**且** 无在飞维护）——「没有派发证据」≠「证明没有派发」（`markDispatched` 落盘失败只置 `unknown`、`restore()` 恢复别的进程留下的租约也一律置 `unknown`，此时 `dispatched=false` 可能正意味着「证据没落盘」⇒ 一律不清）；同理 `markDispatched` 落盘失败时**两条派发路径都拒绝派发**（`root-lease-evidence-unavailable`）。锁内再复核对 `!RootMaintenanceLease.dispatched(app)` 与 `!RootMaintenanceLease.unknown(app)`；已派发**或状态不可信**的一律只能由用户在明示「终止无法证明」后走 `forceClearMaintenanceLease` 清除（锁外先给话术、**锁内**再复核 `!RootExecutionFence.maintenanceActive`，`guard` 无默认值，不带复核的调用编译期就不可能；清除后如实回 `terminationUnproven = dispatched || leaseUnknown` 并写审计）——**用户确认不等于终止证明**。③审计留痕 `files/lease-clear-probe.log`（有界 8 KiB）每次判定记 `state/serverUid/decisive/forced/dispatched/leaseUnknown/allowed/detail`，`detail` 是原始信号（`installed=… suBinary=… ping=… bind=NOT_ATTEMPTED|BOUND|DENIED|… uid=…`），让「压根没尝试绑定」一眼可见。
    **复验**：`RootChannelDecisionTest` 真值表（含权限面被拒/绑定未发生一律 UNKNOWN 的反证）与 `RootProbeEnv` 注入式离线用例；`OwnershipLeaseSettlementFixtureTest` 覆盖清算前提与派发证据接线。真机/模拟器上「已授权但自检报 denied」的机器不得再清租约、「已派发」租约不得被自动清算，两条外验待补。

242. **快照面板修复把布局树当成 DOM 树，测试又省略同一层包装节点（2026-10-03，issue #288）**：
    **现象**：华为 SGT-AL10 的会话顶部灰圆入口打开快照管理，0.14.2/0.14.3 均被会话代码块盖住；0.14.3 已包含抬升补丁仍不生效。
    **真因**：公开 0.14.3 ARM64 APK 的 renderer 给每个 `renderSlot` 常驻包 `div[data-slot]`、`display:contents`。该样式只消除布局盒，**不消除 DOM 节点**；旧 observer 却要求 header 的直接父节点是 `div[data-phase]`，配套 CSS 又用 `div[data-phase] > header`，两处均不匹配。单测手写 header 直接插根节点，省略真实包装层，故同一个错误假设能全绿通过。面板还直接挂在 header actions 内；旧内核的 `container-type:inline-size` 隐含 layout containment，标题行成为 fixed 包含块和堆叠上下文，单纯抬 z-index 仍会留下只有标题行高度的遮罩。
    **修法**：`SnapshotPanelsObserver` 严格认领 `conversation.header` / `conversation.session.header` / `conversation.session.header.actions` 三层插槽，抬升真实 header；仅给承载该面板的直接 titleRow 租赁解除包含的 class（`container-type:normal; contain:none`）。两个 class 按元素共享租约，关闭、移除、重分类和模块重载均释放本实例所有权；不搬 React 节点，不改正文 query container。测试 fixture 使用完整 renderer 包装链，并覆盖重分类、titleRow 替换、diff 与租约恢复。
    **复验证据**：公开 APK 解包确认补丁确实入包；修前真实 wrapper + 旧包含约束模拟下，窄/宽两方向 9/9 控件被盖，正常坐标点击计数 0，直接 DOM `.click()` 却计数 1。修后隔离浏览器六组（现代/旧包含约束模拟/无 container-type × 窄/宽）均验证面板和 diff 可点击、四角遮罩属于面板、完整视口尺寸、缩短视口模拟键盘及关闭后恢复；UI 全量 457 例（其中 snapshot 26 例）、typecheck/build 通过。判别力反证：同一探针在公开 0.14.3 的**原样**入包 bundle 上判红（旧包只有 header 抬升，既无 `dsh-mobile-snapshot-title-row-uncontained`，也没有带 `data-slot` 的代码级选择器），说明「补丁在包里」不能只看 `dsh-mobile-snapshot-header-raised` 这个名字。临时证据在 `.deploy-tmp/issue-288-investigation/`。本轮用户明确选择交付 APK 与离线证据，**没有设备三层验收结论**；旧包含约束模拟不冒充华为内核实测。
