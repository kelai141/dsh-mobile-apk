package com.dsharnessmobile.shell.nativecontrol

/**
 * Rust 核心的进程内边界。能力、策略与操作状态由 Rust 持有。
 *
 * initialize 只接受宿主 Context 提供的私有目录和实际应用 UID；不能转发 IPC 的同名参数。
 * exchange 是 Kotlin 内部协议，不能把它直接挂成 Node 或 WebView 的任意调用入口。
 * 当前没有生产接线；隔离测试以外的路径不引用本对象。
 */
internal object NativeControlCore {
  init {
    System.loadLibrary("dsh_phone_control_core")
  }

  @JvmStatic
  external fun initialize(stateDir: String, appUid: Int): String

  @JvmStatic
  external fun exchange(payload: String): String

  /** 仅内存事实与最终派发检查；争锁立即拒绝，不能在 UI 回调里等待日志落盘。 */
  @JvmStatic
  external fun exchangeNonblocking(payload: String): String
}
