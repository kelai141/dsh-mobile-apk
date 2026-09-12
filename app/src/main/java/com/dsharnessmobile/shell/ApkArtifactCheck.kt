package com.dsharnessmobile.shell

/**
 * FX-209.E1（E-12 第二处）：启动页 APK 自更新**两条路径共用同一份产物校验**。
 *
 * 缺陷形态：缓存复用分支要求 `dest.length() == sizeBytes`（有 sha256 时还校验 sha），
 * 新下载分支只判「HTTP 200 且写盘成功」——同一份异常产物（截断/半包/被替换）在两条路径
 * 上判定相反：缓存路径更严、下载路径更松。校验强度必须由本函数唯一决定：
 *
 * 1. 文件必须存在；
 * 2. 元数据给了大小（>0）时，实际字节数必须相等（截断包/半包在此拦下）；
 * 3. 元数据给了 sha256 时，必须校验通过（缺失 sha256 资产 = 跳过该步，与既有口径一致）。
 *
 * 调用方（GuidePageRenderer 的缓存分支与新下载分支）只做一件事：用同形参数调本函数，
 * 不再各自维护「严格程度」。撤掉本函数（或让任一路径绕过它）→ ApkArtifactCheckTest 变红。
 */
internal sealed class ApkArtifactVerdict {
  data object Accept : ApkArtifactVerdict()
  data class Reject(val reason: String) : ApkArtifactVerdict()
}

/** sha256 校验入口可注入（纯逻辑单测不读真实文件；生产传入 UpdateChecker.verifySha256）。 */
internal fun verifyApkArtifact(
  fileExists: Boolean,
  actualBytes: Long,
  expectedBytes: Long,
  expectedSha256: String?,
  sha256Matches: (String) -> Boolean,
): ApkArtifactVerdict {
  if (!fileExists) return ApkArtifactVerdict.Reject("安装包不存在")
  if (expectedBytes > 0 && actualBytes != expectedBytes) {
    return ApkArtifactVerdict.Reject("大小不符（期望 ${expectedBytes} 字节，实际 ${actualBytes} 字节）")
  }
  if (expectedSha256 != null && !sha256Matches(expectedSha256)) {
    return ApkArtifactVerdict.Reject("sha256 校验不匹配")
  }
  return ApkArtifactVerdict.Accept
}
