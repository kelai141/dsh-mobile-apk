# dsh-phone-control-core

本目录是手机控制核心的 Rust 库与 JNI 边界。Rust 拥有事实 revision、屏幕
generation、范围策略、执行计划与生命周期记录；Android 只上报事实并执行
获准的平台调用。

当前状态：策略、生命周期接线、真实文件日志、JSON/JNI 入口、status 所需的
只读状态查询及纯 Rust 视觉编码已在隔离测试中验证。Kotlin 侧 Frames、Socket、
Dispatcher、Host、A11yExecution、Facts 与 androidTest 源码已存在，但 Host
仍是隔离实现，尚未启动生产监听或切换旧路由。尚未接入 Android execution 验收、
JNI 视觉入口、图像交付到模型、模型 tool schema 或 Node 工具注册。

公开 method execute 是 Kotlin 私有 IPC 的对外名称，内部由 prepare 与 commit
两个 exchange 完成。Kotlin 不提供直接发送 prepare/commit 的公开面。

## JNI 面

类名固定：com.dsharnessmobile.shell.nativecontrol.NativeControlCore。

Kotlin 对象声明三个方法：

- initialize(stateDir: String, appUid: Int): String
- exchange(payload: String): String
- exchangeNonblocking(payload: String): String

三个入口总是返回 JSON。initialize 只接受应用私有 filesDir 下的真实目录。
Android 构建读取真实 getuid()，要求等于 appUid 且拒绝 uid 0；Windows 主机
测试会在响应里标记 identityVerified: false，这不能代替 Android 设备校验。

initialize 在进程级 CORE 锁内检查并打开目录。首次成功后，同一 canonical
stateDir 与 appUid 的重复 initialize 幂等返回现有 epoch/revision；不同路径或
UID 返回 already-initialized，绝不替换现有会话或并发打开第二份日志。父路径
symlink 被拒绝；Android 还校验 stateDir 所有者等于 appUid。

## 公开帧与内部 exchange

未来给 Kotlin 私有 IPC 的 method 只有 capabilities、execute、cancel、status。
Node 不能发送 facts、backend、caller 或 uid。publishFacts、commit、settle 与
validateDispatch 是 Kotlin/JNI 内部协议，不开放给 Node。

exchangeNonblocking 只服务 Android 主线程最终 gate。它只接受 publishFacts、
capabilities 与 validateDispatch，并先检查 262144 字节上限；其它 kind 立即返回
blocking-operation-rejected。它使用 CORE.try_lock，不能等待 journal fsync：
锁被占用返回 core-busy，锁中毒返回 core-poisoned，未初始化返回
not-initialized。返回均为 ok:false、executed:unknown 的结构化 JSON，调用方应把
它们视为禁止派发。主线程可在 SDK gate 前先 fast publish 最新 Android facts，
再 fast validate；普通测试与 durable 路径仍使用 exchange。

protocolVersion 固定为 1。请求必须是 UTF-8 JSON 对象，单次最多 262144 字节。
未知 kind、未知顶层字段、未知 args 字段会被拒绝。所有跨 JNI/Node 的 epoch、
revision、scope generation、authorization generation 与屏幕 generation 都使用
十进制字符串，也接受 0x 前缀十六进制；公开 JSON 不发送数值型大整数。

## publishFacts

~~~json
{
  "protocolVersion": 1,
  "kind": "publishFacts",
  "facts": {
    "scope": "virtual-only",
    "observedAtMs": 1760000000000,
    "screens": {
      "virtual-1": {"displayId": 41, "width": 1080, "height": 1920, "rotation": 0}
    },
    "a11y": {
      "enabled": "yes",
      "online": "yes",
      "supportedOps": {"state": "known", "ops": ["snapshot", "click", "readRegion"]},
      "displaySupport": {"state": "known", "values": {"41": true}}
    },
    "shizuku": {
      "installed": "unknown",
      "running": "unknown",
      "granted": "unknown",
      "bound": "unknown",
      "functionalReady": "unknown",
      "serverUid": {"kind": "unknown"},
      "supportedOps": {"state": "unknown"},
      "displaySupport": {"state": "unknown"}
    },
    "root": {"authorization": "unknown", "consentValid": "unknown"}
  }
}
~~~

成功响应：

~~~json
{"protocolVersion":1,"ok":true,"code":"facts-published","executed":"no"}
~~~

scope 只接受 virtual-only、real-only、all；缺省或损坏值按 virtual-only。
三态只接受 unknown、yes、no。省略事实保持 unknown，不折平成 false。
screens 是本次已知屏幕的完整集合：消失的 alias 视为销毁，重建会分配新
generation；displayId、宽高或 rotation 变化也分配新 generation。仅刷新
observedAtMs 不增加 revision。

rotation 的单位是 Android Surface 旋转枚举值，不是角度：0、1、2、3 依次对应
Surface.ROTATION_0、ROTATION_90、ROTATION_180、ROTATION_270（即 0、90、180、
270 度）。Kotlin 必须发送整数 0..3；Rust 不会接收 90、180、270 这样的角度值。
rotation 是屏幕不可变事实的一部分，变化时屏幕 generation 会递增。

prepare 的请求指纹包含 protocolVersion、kind、operation、规范化后的实际
screenId 与 generation、epoch 与 args，不包含 callId。Android 屏幕省略 screenId
时固定为 real；省略 generation 时取当前注册屏的实际 generation，并在 plan 前
仍校验显式 generation。相同操作即使换 callId、有无显式 screenId 或 generation，
也不能绕过在途或 unknown 防重。Lifecycle 仍使用调用方传入的独立 callId。

click 与 longClick 的 args 严格只接受成对的整数 x、y，缺省或附加其它字段会被
拒绝。其它 op 的完整 args 设计尚未接入，留待 M2。

虚拟屏 alias 是 virtual-N：N 为非零、无前导零、无正负号的十进制，长度不超过
20 且可由 u64 解析。没有 999 上限；alias 是否可用仍取决于它已出现在 screens
注册表中。

supportedOps 形状为 {"state":"unknown"} 或
{"state":"known","ops":[...]}；displaySupport 形状为 {"state":"unknown"} 或
{"state":"known","values":{"41":true}}。serverUid 只接受
{"kind":"unknown"}、{"kind":"shell2000"}、{"kind":"root0"}、
{"kind":"other","uid":1234}。uid 2000 与 uid 0 不互换；基础屏幕控制不得
静默使用 uid 0。

## capabilities

请求：{"protocolVersion":1,"kind":"capabilities"}。

~~~json
{
  "protocolVersion": 1,
  "ok": true,
  "code": "capabilities",
  "executed": "no",
  "epoch": "1865592545886209",
  "revision": "7",
  "scope": "virtual-only",
  "screens": [
    {
      "screenId": "virtual-1",
      "displayId": 41,
      "width": 1080,
      "height": 1920,
      "rotation": 0,
      "generation": "3"
    }
  ],
  "channels": {
    "a11y": {
      "enabled": "yes",
      "online": "yes",
      "supportedOps": {"state":"known","ops":["click","snapshot"]},
      "displaySupport": {"state":"known","values":{"41":true}}
    },
    "shizuku": {
      "installed": "unknown",
      "running": "unknown",
      "granted": "unknown",
      "bound": "unknown",
      "functionalReady": "unknown",
      "serverUid": {"kind":"unknown"},
      "supportedOps": {"state":"unknown"},
      "displaySupport": {"state":"unknown"}
    },
    "root": {"authorization":"unknown","consentValid":"unknown"}
  },
  "lifecycleRecords": 0
}
~~~

## prepare 与 execute

内部 prepare 请求：

~~~json
{
  "protocolVersion": 1,
  "kind": "prepare",
  "callId": "call-001",
  "operation": "readRegion",
  "screenId": "virtual-1",
  "generation": "3",
  "epoch": "1865592545886209",
  "args": {"x1":0,"y1":0,"x2":540,"y2":960}
}
~~~

args 只接受整数 x、y、x1、y1、x2、y2。点必须落在原始逻辑尺寸内；区域是
半开矩形 (x1,y1,x2,y2)，也必须落在原始逻辑尺寸内。调用方不能指定 backend。

成功响应：

~~~json
{
  "protocolVersion": 1,
  "ok": true,
  "code": "prepared",
  "executed": "no",
  "screenId": "virtual-1",
  "plan": {
    "operation": "readRegion",
    "epoch": "1865592545886209",
    "revision": "7",
    "backend": "a11y",
    "target": "androidScreen",
    "screenId": "virtual-1",
    "displayId": 41,
    "width": 1080,
    "height": 1920,
    "rotation": 0,
    "generation": "3",
    "scopeGeneration": "4",
    "authorizationGeneration": "2"
  }
}
~~~

prepare 进入 Lifecycle begin。相同 callId 与相同请求在途时返回
call-in-progress；同 ID 不同请求返回 call-id-conflict；存在未结算 unknown 时
不会重新派发。

内部 commit 请求是 {"protocolVersion":1,"kind":"commit","callId":"call-001"}。
commit 再次核对当前 scope、屏幕 generation、epoch 与通道授权，成功写耐久派发
证据后才返回执行许可：

~~~json
{
  "protocolVersion": 1,
  "ok": true,
  "code": "dispatched",
  "executed": "no",
  "dispatch": "permitted",
  "callId": "call-001",
  "screenId": "virtual-1",
  "plan": {}
}
~~~

## status 与 operationStatus

内部 operationStatus 请求是
{"protocolVersion":1,"kind":"operationStatus","callId":"call-001"}。status 用它
读取生命周期：

~~~json
{
  "protocolVersion": 1,
  "ok": true,
  "code": "clicked",
  "executed": "yes",
  "screenId": "virtual-1",
  "callId": "call-001",
  "phase": "settled",
  "terminal": true,
  "receipt": {"ok":true,"code":"clicked","executed":"yes","screenId":"virtual-1"}
}
~~~

phase 是 missing、prepared、dispatching、settled、unknown 或 cancelled。在途但
没有终态回执时，executed 为 unknown；未找到时 ok:false、phase:"missing"。
unknown 不会因 status 查询被清除。

## validateDispatch

请求：{"protocolVersion":1,"kind":"validateDispatch","callId":"call-001"}。
它在 commit 完成耐久写入后、Kotlin 实际 Android 调用前执行只读检查：phase
必须仍为 dispatching，目标、scope 与授权必须仍有效。它不写磁盘，也不改生命
周期。

成功响应：

~~~json
{
  "protocolVersion": 1,
  "ok": false,
  "code": "dispatch-validated",
  "executed": "no",
  "screenId": "virtual-1",
  "callId": "call-001",
  "phase": "dispatching",
  "valid": true,
  "dispatch": "permitted",
  "settleHint": null,
  "plan": {}
}
~~~

拒绝响应：

~~~json
{
  "protocolVersion": 1,
  "ok": false,
  "code": "scope-generation-mismatch",
  "executed": "no",
  "screenId": "virtual-1",
  "callId": "call-001",
  "phase": "dispatching",
  "valid": false,
  "dispatch": "forbidden",
  "settleHint": {
    "ok": false,
    "code": "scope-generation-mismatch",
    "executed": "no",
    "screenId": "virtual-1"
  }
}
~~~

拒绝发生在 platform action 之前，Kotlin 应直接用 settleHint settle 为
executed:no，不执行 Android 动作，也不做 fallback。cancel 与 validateDispatch
共用进程级 core 锁。prepared 被取消后，后续 validate 看到 cancelled；
dispatching 被取消后，后续 validate 看到 unknown 且没有 settleHint，不能继续
派发。

Host 不得把 validateDispatch 的 ok 当作放行判据。唯一放行条件是
valid == true 且 dispatch == "permitted"；其余组合一律视为禁止。

## settle

~~~json
{
  "protocolVersion": 1,
  "kind": "settle",
  "callId": "call-001",
  "receipt": {
    "ok": true,
    "code": "region-read",
    "executed": "yes",
    "screenId": "virtual-1"
  }
}
~~~

executed 只接受 yes、no、unknown。unknown 不能 ok，不能 fallback 或重放。
响应沿用 Receipt 的稳定 ok/code/executed/screenId，并补 protocolVersion 与
callId。

Kotlin 调用 platform 时遇到 generic Java exception、线程中断、JNI bridge 失败或
任何无法证明副作用是否发生的情况，必须上报 executed:unknown；只有平台明确证实
动作尚未开始时才可上报 executed:no。JNI 入口自身失败也统一返回 unknown。

## cancel

请求：{"protocolVersion":1,"kind":"cancel","callId":"call-001"}。

prepared 调用会撤销为 cancelled，返回 executed:no：

~~~json
{
  "protocolVersion": 1,
  "ok": false,
  "code": "withdrawn-before-dispatch",
  "executed": "no",
  "callId": "call-001"
}
~~~

dispatching 调用不能宣称撤销已经发生的动作。它会保守转为 unknown，并返回双
重拒绝口径：executed:unknown、ok:false、code:cancel-after-dispatch。这个状态
使仍在等待的主线程回调在 validateDispatch 处被拒绝；即使真实动作尚未开始，
系统也无法证明，因此不报告成功取消。

~~~json
{
  "protocolVersion": 1,
  "ok": false,
  "code": "cancel-after-dispatch",
  "executed": "unknown",
  "callId": "call-001"
}
~~~

settled 或 cancelled 的调用只回读已保存回执，并带 replayed:true。unknown 的
再次 cancel 也只回读 unknown，不会转成 cancelled，不会清空记录。没有任意 clear
接口。

实现说明：cancel 的 dispatching 分支直接调用 Lifecycle 的 mark_unknown 路径，语义与
settle(receipt.executed=unknown) 一致；两种路径都会记录 settle 原因，都会阻止
后续 fallback、重放与 validateDispatch 派发。

迟到的真实平台回执目前没有安全 reconcile 路径。M1 只能保留 unknown，等待人工
处置；由 M2 在持有同一原始 permit/operationId 的前提下实现受控回执归并。不得
通过任意 clear、重新 prepare 或新 callId 绕过该限制。

## fallback

~~~json
{
  "protocolVersion": 1,
  "kind": "fallback",
  "callId": "call-001",
  "reason": "service-offline"
}
~~~

只允许 prepared、同一目标、A11y 到 Shizuku。reason 只接受 service-offline、
permission-missing、op-unsupported、target-unsupported。node-not-found、
timeout、unknown、error 不能兜底；已派发与 unknown 也不能 fallback。

## 文件日志与容量边界

stateDir 只由 Kotlin 的 app 私有 filesDir 指定，不能经 RPC 修改。日志仅接受
state-<20 位序号>.json 与 .json.tmp，不跟随 symlink，不递归删除目录。写入使用
create_new、write_all、sync_all、rename 与目录 sync，保留最多两份已完成快照，
永不覆盖旧序号。最高序号快照是唯一权威状态；损坏、超限或读取失败时不会回退
旧快照，控制器失败关闭。临时文件不视为已提交状态。

当前 M1 的安全规则是满容量拒绝新调用，不驱逐任何记录。尚无经过原生 epoch 与
有效期校验的可信过期/GC 策略，因此不能宣称长时间无限运行已完成。安全清收留到
M2 与原生 epoch、deadline、授权一起实现；不存在清空 unknown 或任意 clear 的
绕行入口。

epoch 由 OS 随机源生成非零 u64。Windows 使用 BCryptGenRandom；Linux/Android
优先 getrandom 系统调用并回退 /dev/urandom。全零或读取失败均拒绝，不使用时间、
PID 或进程内计数推测唯一性。旧 epoch 的屏幕 generation 不会被重建会话复活。

## 测试

~~~text
cargo +stable-x86_64-pc-windows-gnu test --offline --manifest-path native/phone-control-core/Cargo.toml
~~~

覆盖 controller 状态机、operationStatus、只读 validateDispatch、真实临时目录
日志写读与恢复、最高序号损坏、半成品、Unix symlink、日志失败阻断 commit、
重复 call、撤权/旋转拒绝、unknown 禁止 fallback，以及既有 policy 与 lifecycle
行为测试。
