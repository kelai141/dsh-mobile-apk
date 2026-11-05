# UI 验收两件事：横屏不接管移动导航层、热推后先确认设备上是目标代码

写于 2026-10-26，来自 #589（关于入口恢复与返回焦点）的三层验收过程。

## 一、横屏不接管移动导航层，别在横屏找那条路径

`MobileSettingsNav` 只在**手机形态**下接管设置面板。判据是页面自加 `data-dsh-mobile-form`，也就是
`innerWidth <= 767`（`MOBILE_FORM_MAX_WIDTH`）。横屏 1067x600 时这个标记不存在，于是：

- `data-dsh-settings-level` 为 null，没有 home/detail 层级；
- 不存在「列表 → 二级页 → 返回列表 + 焦点回落」这套机制。

所以「返回后焦点落在哪个导航行」这条判据**在横屏根本不存在**，不是没测，是设计边界。横屏能验的是
入口与目标页本身可用（本次实测：真实 tap 内联「关于」入口 → `aboutPage: true`、`DeepCode: true`；
真实返回 → 回到设置）。

做 UI 验收时按这个顺序判：先读 `innerWidth` 与 `data-dsh-mobile-form`，确认当前形态，再决定哪些判据
适用。不要把竖屏的判据直接搬到横屏跑，那样得到的「红」是环境不适用，不是缺陷；得到的「绿」也没有意义。

## 二、热推后先 grep 确认设备上是目标代码，再开始验

`scripts/hot-push.mjs` 只负责把 `lib/**` 拷进两个 profile 的 `node_modules/@dsh-android/<pkg>` 并重启。
它不校验内容、不比对版本。设备上原本就有一份随应用发布的 npm 包，推送失败或推到错目录时，页面照样
能跑起来——**看起来一切正常，验的却是旧包**。

本次踩到过：本地 `npm ci` 之后注入的 `lib/client.js` 来自已发布 npm 版本，#589 的新代码根本不在里面，
`grep -c ensureEntry` 为 0。补推之后才变成 3。

固定动作，推完先跑这两条再动验收脚本：

```powershell
$p = "/data/data/com.dsharnessmobile.shell/files/home/.dsh/profiles/web/node_modules/@dsh-android/<pkg>/lib/client.js"
adb -s <serial> shell "run-as com.dsharnessmobile.shell grep -c <本 PR 新增的标识符> $p"
adb -s <serial> shell "run-as com.dsharnessmobile.shell grep -c <本 PR 新增的 data 属性> $p"
```

挑**本 PR 独有**的标识符（新函数名、新 `data-*` 属性），不要挑本来就在旧包里的名字。计数为 0 就是没推
上去，此时任何验收结论都不作数。

推完还要重新解析 CDP 目标：`--restart` 会换主进程 pid，`webview_devtools_remote_<pid>` 跟着变，
旧 forward 直接失效（表现为 `fetch failed / SocketError`）。重取 pid 再 forward。

## 附：本次设备验收的真实路径

竖屏 600x1067 下用真实 `input tap` / `input keyevent 4` 走通：入口移除后自愈（`before:1 → 0 → recovered:1`）、
进关于页（`level:detail`）、返回列表（`level:home`，焦点落到可见的「通用设置」）。

「激活行不可见时焦点回落」这一条真机上没有自然触发路径（入口一被移除，`syncNavRow` 会立刻重建入口并
收起导航行，两个状态不会同时停留），只能用 CDP 直接构造 `aria-current` + `display:none`。构造态能证明
「该函数在设备上按判据工作」，不能证明「真机有自然路径触发它」——这两句话在 PR 描述里要分开写。
