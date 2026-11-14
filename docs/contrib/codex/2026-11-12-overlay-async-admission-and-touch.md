# 悬浮重构：触摸顺序与异步受理

## 外部触摸先收卡片、入口延迟单击又重开

现象：单击可打开卡片，第二次点入口却不收；重复开合压测在第1次收起超时。真因是WATCH_OUTSIDE_TOUCH可先于入口DOWN关闭卡片，而双击裁决结束后按当前可见态toggle又打开。修法是按同downTime记录outside前的卡片态，入口DOWN捕获目标动作，延迟TAP不再重新读已经变化的可见态；不改双击/长按/拖动语义。纯反证覆盖原本可见、同DOWN先关闭、原本不可见三种，真实10cycle+10tap+3s拖动复验，失败旧日志保留。

## 隐藏WebView不能依赖下一绘制帧提交附件

现象：附件提交在后台pending，回本体才真正发。公开Conversation.sendSession为普通composer主动等待nextPaint；后台页面RAF停顿不是可靠业务受理时钟。附件分支改复用公开serializeDraftAttachments+精确Session.prompt、固定requestId；只有literal ok/accepted才释放本批registry，正文及新草稿不动。真实Remote把carrier异常折成ok:false/gateway/internal，不仅throw才unknown；gateway/cancelled/缺code也保UNKNOWN，不能恢复再点生成新requestId重复提交。operation重查只读state.queue.rpcId/user-message source.rpcId正证，缺证据不重发；准备阶段可有deadline，调用后超时不等拒绝。

## 来件timeout必须区分只读与取票事务

list GET/json与receipt GET/json无deadline会占住单飞，complete ACK也可能阻后续poll。给安全读和幂等ACK4s总界限、保pendingAcks及admittedEntries。不能把相同wrapper泛化到claim/content：claim服务端先删除持久记录才回ticket，Promise.race丢迟到结果会丢票；content慢读不能直接complete removed。保原attempt/票据等待，反证跨4s晚回仍一次入稿，不能blind再claim；当前未实现耐久outbox，明确保限制。fetching标记在ACK前写且失败后可残留，不能单凭它断言GET正挂起。

## 证据边界

当前命令/设备/哈希/全量/性能和未通过项只在[测试报告](<../../overlay-refactor-2026-11/test-report-phase2.md>)维护。开发APK+热推不是最终同源快照双ABI，未完成门槛不得写成通过；灰色块/文件名不是图片预览，必须有真实彩色图像/宽高比/actual frame/删除结果。
