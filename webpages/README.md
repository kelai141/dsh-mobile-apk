# webpages — 静态下载站

下载页部署到 GitHub Pages。安装包仍由 GitHub Releases 托管，页面不下载整包到内存，也不托管或修改 APK。

## 用户入口

- 首页概括：文档、编程、手机控制、深度研究，口袋里全部搞定。
- 主操作只有下载安装包；版本、架构、实际大小合并显示。
- 来源只显示“官方源”和“镜像加速源”。默认自动路由；点击紧凑的“切换”入口可手动固定来源类别。
- 镜像类别内仍自动选择节点。节点域名可通过状态提示或实际下载地址查看，不再铺成四个大按钮。
- 探测在后台进行，点击下载不等待探测。超时只表示未确认，不禁用来源；全部失败时仍保留下载与手动切换入口。
- 架构识别只是推荐，始终提供更换架构。桌面端先选择安装设备，不把电脑架构当作手机架构。
- 界面支持即时中英文切换，保留架构和来源选择。明暗主题跟随系统。

## 发布数据与同步

浏览器只使用构建时内联的数据，解析失败才读取同站、同次部署的 `data/releases.json`。**浏览器不请求 GitHub API，也不动态判断最新版。** 不启用 Service Worker。

```text
release.yml 上传已验证资产并完成 publish
    → sync-pages 调用可复用 pages.yml
    → 同步当前公开正式版与官方 MANIFEST.txt
    → 构建完整静态站
    → 上传 Pages artifact 并部署

草稿转为公开发布 → release: published → 同一 Pages 流程
站点源码合入 main / 手动 dispatch → 同一 Pages 流程
```

发布流程目前保留草稿审核。因此 publish 后的同步只会展示已有公开正式版，不提前展示草稿。人工公开草稿后，发布事件再次同步新正式版。使用 GITHUB_TOKEN 创建草稿不会自动触发另一条发布事件工作流，所以 release.yml 显式调用 Pages；参见 [GitHub 文档](https://docs.github.com/en/actions/concepts/security/github_token)。

CI 使用认证请求读取当前公开正式版；不按触发事件的旧 tag 构建，预发布版不进入正式入口。Pages 并发组串行部署。API 或官方清单读取失败、双 ABI 缺件、清单重复、校验值或字节数不合法，构建直接失败，保留上一份完整部署。可单独重跑 Pages，无需重新构建 APK。

普通本地构建完全离线。只有显式 `--refresh` 才访问发布源；失败不静默回落旧清单。刷新结果同时写入内联数据、部署目录的静态 JSON 和本地清单，HTML 与 JSON 不分别部署。仓内清单是本地离线基线，CI 刷新工作区不直接推送 main。

## 线路检测边界

`release.js` 维护真实发布资产名匹配、架构识别和镜像前缀。`routing.js` 维护类别筛选和排序；`app.js` 负责浏览器交互。

健康探针沿用小文件 `releases/latest/download/MANIFEST.txt`；不会用脚本标签加载整个 APK。健康确认后才比较实际资产的响应头延迟，拿到响应头即中止。无 CORS 的不透明响应不能证明 HTTP 成功，因此测速不能代替健康检查。超时不作为确认失败。

测量的是首字节延迟，无法保证下载吞吐量。自动路由尽力选择已确认的线路，手动来源切换用于兜底。下载始终使用普通资产链接，保留浏览器原生下载器和续传能力。

## 本地验证

```bash
node webpages/tools/build.mjs --self-test   # 行为回归及受控负控
node webpages/tools/build.mjs               # 零网络构建
node webpages/tools/build.mjs --refresh     # 显式同步公开正式版；可用 GH_TOKEN 认证
node --test "webpages/tests/*.test.mjs"      # 同一套完整回归
```

`build.mjs` 生成 `dist/`，内联样式、版本数据、静态直链、JSON-LD，并一起生成 robots 与 sitemap。无 JavaScript 时仍有双 ABI 固定版本下载链接。模板占位符残留与 HTML 体积超过 120 KiB 都会判红。

PR Gate 执行下载站自检和离线构建。站点独立于 APK、快照、Kotlin 与桥协议；无需重出 APK。本轮未做设备验证，采用代码回归、真实浏览器交互与多视口截图作为网页替代证据；具体见 [本轮记录](../docs/contrib/kelai141/2026-10-20-download-page-static-sync.md)。
