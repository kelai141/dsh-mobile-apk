package com.dsharnessmobile.shell

import android.util.Log
import java.security.SecureRandom

/**
 * pick token 的「第二层」凭据（issue #686）。
 *
 * 背景
 * ----
 * 设备实测证明跨源子帧能调 getPickToken() 并拿到**真实 token 值**。整对象封死（见
 * BridgeOriginGuard）之后这条路已断，但 token 一类凭据一旦泄露即长期有效，值得再加一层。
 *
 * 为什么不能「仅顶层帧可签发」
 * ------------------------
 * Java 侧拿不到调用者帧——@JavascriptInterface 的方法签名没有帧参数，这正是 #686 的根因，
 * 因此「判顶层帧」在 Kotlin 里无法实现。改为**持有式凭据**：由 document-start 守卫在主帧
 * 闭包里生成并注入一段只给主帧的 secret（不可枚举、不可写），getPickToken 必须带上它才返回真值。
 *
 * 语义
 * ----
 * - getPickToken(secret) 与 secret 匹配 → 返回真实 token；
 * - 不匹配或缺失 → 返回 null，并写一条审计日志（可观测，不静默）；
 * - 零参重载保留：**WebView 的 JS 桥按实参个数匹配 Java 方法**（本文件同类先例见
 *   AndroidBridge.browserHostShow 的两个重载），删掉零参会让所有既有调用点抛
 *   Method not found。零参调用走「无凭据」分支：返回 null 并记审计。
 */
internal object BridgePickToken {

    private const val TAG = "dsh-bridge-token"

    private val secret: String by lazy {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        bytes.joinToString("") { b -> "%02x".format(b) }
    }

    /** 当前进程的 secret；由 document-start 守卫注入主帧。 */
    fun current(): String = secret

    /** 校验调用方带来的凭据；失败时记审计并返回 false。 */
    fun verify(candidate: String?): Boolean {
        val ok = candidate != null && candidate == secret
        if (!ok) {
            // 审计：缺凭据或凭据不对。这条是设备验收的断言对象（必须能观测到）。
            Log.w(TAG, "pick token refused: missing or mismatched frame secret")
        }
        return ok
    }
}
