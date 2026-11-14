// ShizukuUserService.aidl — 0.14.0 迭代「虚拟屏」线 S2 / 0.14.0 双通道线的 Shizuku UserService
// （shell uid 2000）最小面。
//
// 背景（源文档 §4.2）：Shizuku.bindUserService 拉起的 UserService 进程以 server 身份运行
// （ADB 启动 = uid 2000 / u:r:shell:s0），可执行"只有 shell 做得到"的三件事：拉第三方 App 上屏、
// 指定屏注入输入、跨屏抓帧。官方口径：该进程不是合法应用进程（Context#registerReceiver /
// getContentResolver 等不可用，须直调隐藏 API），且不受 non-SDK API 限制。
//
// v2（0.14.0 §6「Shizuku 执行面」）：放宽超时（8s → 最长 600s）；大输出落盘 + 应用侧分块取回
// （execCapture/readChunk），把原先 16KB 内联上限的 stdout 变成「shell 侧临时文件 + binder 分块」，
// 供 screencap/uiautomator dump/shell 大输出等场景使用；文件推送（writeChunk）落地 pull/push 语义。
// 版本握手：壳侧 protocolVersion() >= 2 才走 capture 面，旧服务（v1）明确拒绝而非静默降级。

package com.dsharnessmobile.shell;

import android.os.Bundle;

interface ShizukuUserService {
    /** Shizuku-reserved transaction: service removal must terminate the remote app_process. */
    void destroy() = 16777114;

    /** 身份自证：期望 2000（ADB 启动）或 0（root/Sui）；其它值即通道异常。 */
    int uid() = 1;

    /** 协议版本握手（给「新壳配旧服务」的明确指引，先于任何能力调用）。v2 = 0.14.0 capture 面。 */
    int protocolVersion() = 2;

    /**
     * 在常驻 shell 内执行 argv（argv 直传，不经本地 shell；退出码与 stdout/stderr 原样回传）。
     * 危险命令黑名单仍在壳侧判定，不因通道变化而放宽；审计字段含 transport/uid/op。
     * 内联上限 16 KiB；更大输出用 {@link #execCapture}。
     */
    Bundle exec(in String[] argv, int timeoutMs) = 3;

    /**
     * v2：执行 argv 并把 stdout/stderr 落到 shell 侧临时文件（大输出场景）。
     * @return {ok,exitCode,inline,path,size,truncated,error}——inline 为前 inlineBytes 字节（≤16 KiB，
     *         UTF-8 替换式解码），path 供 {@link #readChunk} 分块取回；timeoutMs 上限 600000。
     */
    Bundle execCapture(in String[] argv, int timeoutMs, int inlineBytes) = 4;

    /** v2：分块读回（offset 起 length 字节；length<=0 读到 512 KiB 上限）。仅限绝对路径。
     *  返回 null = 不可读（缺失/权限），空数组 = EOF。 */
    @nullable byte[] readChunk(in String path, long offset, int length) = 5;

    /** v2：分块写（append=false 截断重建；父目录自动建立）。仅限绝对路径。 */
    Bundle writeChunk(in String path, in byte[] data, boolean append) = 6;

    /** v2：删除远端文件/目录（幂等，rm -f 语义）。仅限绝对路径。 */
    Bundle removePath(in String path) = 7;

    /**
     * v3（2026-09-30）：应用侧绑定后回填「本应用 uid + 数据目录」。
     *
     * 承重墙：root 通道（服务端以 root 启动）里 UserService 的 uid 是 0，它写的每个文件
     * 属主都是 root:root —— 落到应用数据目录（files/...）里就是**应用自己读不回来**
     * （0600 root 属主），watcher/插件更新/引擎读写随之失败。回填本方法后，
     * [writeChunk] 与 [repairOwnership] 才知道「这些文件该属于谁」。
     */
    void configure(int appUid, String appDataDir) = 8;

    /**
     * v3：把 path 的属主归一到**已配置的应用 uid**（不接受任意 uid/gid —— 这不是通用 chown，
     * 只是「把文件修回我自己的」这一件事）。有界遍历：maxEntries 上限、不跟随符号链接、
     * 超限如实回报 truncated。未 configure 时结构化拒绝。
     * @return {ok,scanned,fixed,truncated,error?}
     */
    Bundle repairOwnership(in String path, int maxEntries) = 9;

    /** v4: confirm the one-time configured full UID and trusted data anchor. */
    Bundle configuration() = 10;

    /** Optional native input contract: bit 0 is a real-display point tap. */
    int nativeInputCapabilities() = 11;

    /** Typed point tap for display 0 only. No text, argv or display override. */
    Bundle nativeTapReal(int x, int y) = 12;
}

