# 灵枢手机端测试指引（dsh-mobile-apk · feat/lingshu）

## 已交付

| 产物 | 路径 | 说明 |
|---|---|---|
| 灵枢快照 | `app/src/main/assets/snapshot.tar.xz`（96.8MB） | 官方快照 + python3.14 + aeis 核心包 + wisdom + dsh-memory 插件 |
| APK | `app/build/outputs/apk/debug/app-debug.apk`（100.7MB） | 内嵌灵枢快照，装完即有灵枢 |
| 构建工具 | `tools/build_lingshu_snapshot.py` | 流式保真重打包（原快照 symlink 结构完整保留） |

## 快照注入内容

- **python 3.14.6**（Termux aarch64 deb：`usr/bin/python3` + `libpython3.14.so` + 标准库）
- **aeis 核心包**（`usr/lib/python3.14/site-packages/aeis/`，裁剪设备层 body/vision/world3d/web/swarm，保留记忆/认知/对话/MCP 全链路，纯标准库）
- **wisdom 包**（`site-packages/wisdom/` 全部：语义引擎 + 智慧之书 db + 直答表）
- **dsh-memory 插件**（`web` + `headless` profile 的 node_modules，+ peer 依赖 cordis/dsh-tools/dsh-session/schemastery）
- **cordis.patch.yml 追加**：`lingshu-memory` 插件注册（python=/files/usr/bin/python3，db=/files/home/.dsh/lingshu.db）

## 手机端测试步骤

1. **安装 APK**：`app-debug.apk`（100.7MB）传到手机（数据线/网盘/微信文件传输），允许「安装未知来源应用」后安装
2. **首次启动**：自动解压快照（约 1-2 分钟），引擎启动后 WebView 加载 dsh web UI
3. **验证灵枢**：引擎日志出现 `dsh-memory: 灵枢插件激活`；agent 工具列表含 `lingshu_*`（71 个 MCP 工具）
4. **测试记忆**：对话让 agent 调用 `lingshu_remember` 写入 → 重启引擎（看门狗/设置里重启）→ 问 agent 是否记得（跨重启持久）

## 验收清单

- [ ] 首启解压成功、引擎 3080 端口可达
- [ ] `dsh-memory: 灵枢插件激活` 日志出现（python 进程正常拉起）
- [ ] agent 可调用 `lingshu_remember / recall / search` 等工具
- [ ] 记忆写入 → 引擎重启 → 记忆仍在（SQLite 持久）
- [ ] 白箱回答（实践智慧直答）可用

## 已知限制（手机版裁剪）

- `web_search / ingest_url` 等外部工具不可用（web.py 裁剪，需网络 key）
- 视觉/音频设备工具不可用（body 层裁剪）
- LLM 兜底（openai）不可用——白箱直答为主

## 故障排查

- **`spawn .../usr/bin/python3 EACCES`（灵枢子进程起不来）**：python deb 注入时丢失
  执行位（mode 设成 0o644）导致 spawn 被拒。已修复：构建脚本保留 deb 原始 mode
  （`usr/bin/*` 0o755）。**已装的旧 APK 可 `chmod +x` 修复**（重启后仍有效），
  新构建的 APK 开箱即用。
- **`ensureSymlink ... exists and is not a symlink` 崩溃**：dsh-app-boot 启动时
  `healProfilesModuleFallback` 要求 `profiles/node_modules` 下是 symlink（自动指向引擎
  包）；若快照里误注入实体目录会触发该错误。修复：不注入 @deepseek-ai 实体（官方预建
  symlink 已含 schemastery/cordis/dsh-tools 等 dsh-memory peer 依赖）。升级时**卸载
  旧版重装**（清掉旧解压目录的残留实体）。

## 上游贡献点（后续）

- `UpdateManager.manifestUrl` 写死 `10.0.2.2:8899`（模拟器），真机无法在线更新——建议改为可配置（SharedPreferences/字符串资源），这是对上游的有价值贡献
- 快照体积优化：wisdom db 23MB + neural_index 6.7MB 可裁剪（按需加载）
