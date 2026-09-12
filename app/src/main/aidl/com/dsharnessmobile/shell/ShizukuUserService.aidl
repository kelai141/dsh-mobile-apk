// ShizukuUserService.aidl — 0.14.0 迭代「虚拟屏」线 S2：Shizuku UserService（shell uid 2000）的最小面。
//
// 背景（源文档 §4.2）：Shizuku.bindUserService 拉起的 UserService 进程以 server 身份运行
// （ADB 启动 = uid 2000 / u:r:shell:s0），可执行"只有 shell 做得到"的三件事：拉第三方 App 上屏、
// 指定屏注入输入、跨屏抓帧。官方口径：该进程不是合法应用进程（Context#registerReceiver /
// getContentResolver 等不可用，须直调隐藏 API），且不受 non-SDK API 限制。
//
// 落地状态：本文件当前惰性——AGP 需在 app/build.gradle.kts 打开
//   android { buildFeatures { aidl = true } }
// 才生成 ShizukuUserService.Stub；在打开之前仓库里没有任何 Kotlin 代码引用该 Stub，
// 因此构建不受影响。Stub 实现（ShizukuUserServiceBridge）与 bindUserService 绑定属 S5
// （依赖 + provider 声明落地后，见 P0-2/P0-3）。

package com.dsharnessmobile.shell;

import android.os.Bundle;

interface ShizukuUserService {
    /** 身份自证：期望 2000（ADB 启动）或 0（root/Sui）；其它值即通道异常。 */
    int uid();

    /** 协议版本握手（给「新壳配旧服务」的明确指引，先于任何能力调用）。 */
    int protocolVersion();

    /**
     * 在常驻 shell 内执行 argv（argv 直传，不经本地 shell；退出码与 stdout/stderr 原样回传）。
     * 危险命令黑名单仍在壳侧判定，不因通道变化而放宽；审计字段含 transport/uid/op。
     */
    Bundle exec(in String[] argv, int timeoutMs);
}
