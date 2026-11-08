# Better Sidebar 文件浏览的设备对照

使用已初始化的独立调试模拟器和固定版本 `dsh-better-sidebar@0.30.1`。
制品 SHA-256 为 `3b3deafd3096fdf42b271c4cda0f0e70f024d4f8ef55ffd523b42c6e6d79b41e`；
设备的 pnpm 锁文件登记了与 npm 制品相同的完整性摘要。该插件是补充 UI 样本。

先在隔离工作区创建 `dsh-sidecar-fixture-20261108.txt`，内容为
`dsh sidebar verification marker 20261108` 加换行。切到该工作区，打开底部
Files 面板，关闭已打开的同名编辑器。对基线与候选分别运行：

```sh
node scripts/verify-third-party-sidebar.mjs --serial "$SERIAL" --out "$EVIDENCE"
```

脚本先核对客户端条目和当前页面，然后使用 Android 触摸刷新文件列表、点开对应文件。
它检查编辑器的文件名及正文，留存文件列表、正文截图和 `result.json`。编辑器不能预先
显示该文件；这样重启恢复旧页不会误算成新打开。脚本不自动装插件或改写文件。

实测为同一台 x86_64 Android 35 AVD、WebView 124.0.6367.219，覆盖安装保留同一
插件、工作区和快照。快照指纹为
`ee4170b102613ee1492914687e5843dc398f232c035e5a20fd2a9457eb76dc00`。

| 制品 | APK SHA-256 | 观察结果 |
| --- | --- | --- |
| 无 Rust 中继的调试基线 | `16121800ae9311f9edab44d7650fa854cba71d57b547b210cf2dafc34321d7a7` | 文件出现在列表，触摸打开后标题和正文匹配 |
| 含 Rust 中继的调试包 | `c1ce83acd556e8a9faf8e180bb855950fb263f795e84d1e2a9352234623dcc8e` | 文件出现在列表，触摸打开后标题和正文匹配 |

留档：[候选文件列表](evidence/better-sidebar-device/file-tree.png)、
[候选编辑器正文](evidence/better-sidebar-device/file-content.png)。
负控：删除夹具后执行同样的刷新，脚本以 1 退出并报告文件不在可见列表。

本用例只覆盖文件浏览和读取。未覆盖编辑保存、其他侧栏功能、热启停或 arm64。
