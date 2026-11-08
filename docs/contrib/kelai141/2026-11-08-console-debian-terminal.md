# 控制台接入 Debian guest shell：宿主环境、启动描述与渲染面

日期：2026-11-08

## 现象

把控制台从快照 Termux bash 切到 bionilux 的 Debian guest bash 后，中继起来即退出，stderr：

```
Could not find a PHDR: broken executable?
```

同一组启动参数在设备 shell 里手工执行正常；渲染面则是另一种假象：Debian guest 能起，但 vim/top 全屏程序只看到一行行滚动文本（页面是纯文本容器，控制序列在壳侧被剥离）。

## 真因

1. **宿主环境泄漏进 guest**：引擎进程带着宿主 Termux 的 `TERMUX__PREFIX` / `TERMUX__ROOTFS` 等变量，bionilux launcher 以它们反推前缀，于是把宿主路径当成 guest 根，exec 到宿主侧二进制后报 PHDR。
2. **启动参数被拆成三个环境变量**（`DSH_CONSOLE_SHELL` / `ARGS` / `CWD`），等于把「启动什么」耦合进中继实现；换 PTY 底层就要重写一遍。
3. **渲染面缺失**：页面只 append 文本，壳侧 `ConsoleAnsiStripper` 把 CSI/OSC 全剥掉，TUI 无从显示；键盘也只有整行提交，方向键与 Ctrl 组合不可达。

## 修法

- 覆盖条目支持 `unset`：先删除宿主键，再铺 `env`；`unset` 与 `env` 都在描述里，由底层 spawn 前应用。
- 启动参数收敛成单通道描述 `DSH_CONSOLE_LAUNCH`（schemaVersion / shell / argv / cwd / env / unset），`ConsoleLaunch` 是唯一生产者，中继只消费描述。
- 页面改用 xterm.js（MIT，随资产分发）渲染 VT/ANSI；真 PTY 路径原样转发字节，`ConsoleAnsiStripper` 只留非 PTY 降级。
- xterm `onData` 逐字节编码成 `ConsoleKeyCodec` 认得的串经 `writeKeys` 写入 PTY（先按 UTF-8 取字节，避免非 ASCII 被按 UTF-16 码元切坏）。

## 复验证据

- 单测：`ConsoleShellOverrideTest`（含 `unset` 与非法输入负控）、`ConsoleLaunchTest`（描述字段与省略规则）。
- 设备（MuMu x86_64）：tty=/dev/pts/0、job control monitor on、后台作业 Running、Ctrl-C 中断 sleep、`stty size` 18x140（旋屏后 40x78）、`/etc/os-release` = Debian 13 trixie。
- 渲染：term 134x23；`ls --color=always /` 70 个非默认色单元格；`top` 在 Termux 与 Debian 下均全屏；注入 `q`（真实 keyDown/keyUp → onData → writeKeys）后 top 退出。
- 干净安装（dev-fast APK + release 快照资产，无手工补包/热推）：引擎 0 failed plugins，Linux 0.5.1 安装 healthy，控制台直出 `root@localhost:~#`。

## 环境侧的坑（与产品无关但会误判）

- 重装后应用 uid 会变；手工 push 的 `home/.dsh` 配置必须按新 uid `chown`，否则表现为凭据插件加载失败 → sessionController 不可用，看起来像产品缺陷。
- adb 非 root 时无法启动非导出 Activity（ConsoleActivity），会让人以为控制台起不来。
- force-stop 后 MuMu 可能把 Activity 放到副屏（display 17/18），`screencap` 主屏看起来是桌面；重启设备后回到 display 0。

## Termux 控制台回归（与 Debian 覆盖同批验证，release 也走同一条渲染路径）

- 长输出：`seq 1 20000` 后提示符正常返回，滚动缓冲保留最近约 5000 行，页面无卡死（约 5 秒内渲染完）。
- Ctrl 键：`sleep 100` 进行中点 Ctrl-C，输出 `^C` 并回到提示符。
- 中文输入：输入框写入 `echo 中文输入测试` 并发送，guest 原样回显（桥接按 UTF-8 字节编码）。
- 复制：终端选中文本后点「复制」，壳侧返回 true 并显示「已复制」；系统剪贴板读取受 Android 15 隐私限制，shell 侧读不到内容，改为以桥返回值与按钮态判定。
- 会话关闭：`exit` 后状态显示「bash 已退出（code 0）」，按钮变「重连」，输入框仍可用。
- 横竖屏：竖屏网格 72x52、转回横屏 133x21，guest `stty size` 跟随页面网格（旋屏触发 SIGWINCH）。
