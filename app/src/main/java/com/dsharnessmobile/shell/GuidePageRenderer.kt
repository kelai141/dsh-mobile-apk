package com.dsharnessmobile.shell

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import java.io.File

/** 引导页（启动/测试界面）纯代码 UI：GuidePhase 状态机驱动视图渲染 + WebUI/引导页切换（自 MainActivity 拆出）。 */

internal enum class GuidePhase { Idle, Starting, Extracting, Updating, Recovering, Undoing, Error, Closed }

internal class GuidePageRenderer(private val activity: MainActivity) {

  lateinit var chrome: GuideChrome
  private lateinit var engineStatus: TextView
  /** 引擎启动流写入解压进度（EngineStartFlow）。 */
  lateinit var progressText: TextView
  private lateinit var progressBar: ProgressBar
  private lateinit var crashBanner: TextView
  private lateinit var logSummary: TextView
  /** 测试界面三段式结构块：入场 stagger 动画按块依次淡入。 */
  private lateinit var brandBlock: View
  private lateinit var cardBlock: View
  private lateinit var actionBlock: View
  var lastGuidePhase: GuidePhase = GuidePhase.Idle
    private set
  private var statusPulse: ObjectAnimator? = null

  // —— APK 自更新（0.13.8 批 H）状态：仅手动触发、同一按钮二次确认 ——
  /** 已发现的新版（非空 = 按钮停在「下载并安装 vX」二次确认态，再点才开始下载）。 */
  private var apkPending: UpdateChecker.CheckResult.Available? = null
  /** 下载完成待安装的包（授权页返回后由 settlePendingInstall 续继）。 */
  private var apkReadyToInstall: File? = null
  private var apkBusy = false

  fun buildGuideView(): LinearLayout {
    chrome = buildGuideChrome(
      activity,
      GuideCallbacks(
        onStartEngine = {
          activity.engineFlow.engineRetryCount = 0 // 手动重试归零自动重试计数
          activity.startEngineFlow()
        },
        onOpenConsole = { activity.startActivity(Intent(activity, ConsoleActivity::class.java)) },
        onCheckUpdate = { onUpdateButton() },
        onGrantStorage = { activity.dirPickerController.openAllFilesAccessSettings() },
        onCopyLog = { copyGuideLog() },
      ),
    )
    engineStatus = chrome.engineStatus
    progressText = chrome.progressText
    progressBar = chrome.progressBar
    crashBanner = chrome.crashBanner
    logSummary = chrome.logSummary
    brandBlock = chrome.brandBlock
    cardBlock = chrome.cardBlock
    actionBlock = chrome.actionBlock
    chrome.versionLabel.text = "v" + BuildConfig.VERSION_NAME
    refreshGuideMeta()
    return chrome.root
  }

  /** 测试界面入场：品牌区/状态卡/操作区依次淡入上移。仅在界面从隐藏变为可见时播放。 */
  private fun animateGuideReveal() {
    val rise = 16 * activity.resources.displayMetrics.density
    val items = listOf(brandBlock, cardBlock, actionBlock)
    items.forEachIndexed { i, v ->
      v.animate().cancel()
      v.alpha = 0f
      v.translationY = rise
      v.animate()
        .alpha(1f).translationY(0f)
        .setStartDelay(i * 80L).setDuration(480L)
        .setInterpolator(DsUi.ease).start()
    }
  }

  fun applyGuidePhase(phase: GuidePhase, title: String, hint: String? = null) {
    lastGuidePhase = phase
    engineStatus.text = title
    val resolvedHint = hint ?: defaultHint(phase)
    chrome.statusHint.text = resolvedHint
    chrome.statusHint.visibility = if (resolvedHint.isBlank()) View.GONE else View.VISIBLE

    val busy = phase == GuidePhase.Starting ||
      phase == GuidePhase.Extracting ||
      phase == GuidePhase.Updating ||
      phase == GuidePhase.Recovering ||
      phase == GuidePhase.Undoing
    val lockPrimary = phase == GuidePhase.Starting ||
      phase == GuidePhase.Extracting ||
      phase == GuidePhase.Updating ||
      phase == GuidePhase.Undoing
    chrome.primaryButton.isEnabled = !lockPrimary
    chrome.primaryButton.alpha = if (lockPrimary) 0.55f else 1f
    chrome.primaryButton.text = when (phase) {
      GuidePhase.Closed -> activity.getString(R.string.ds_restart)
      GuidePhase.Error, GuidePhase.Recovering -> activity.getString(R.string.ds_retry)
      GuidePhase.Starting, GuidePhase.Extracting -> activity.getString(R.string.ds_starting)
      GuidePhase.Updating -> activity.getString(R.string.ds_updating)
      GuidePhase.Undoing -> activity.getString(R.string.ds_undoing)
      GuidePhase.Idle -> activity.getString(R.string.ds_start_engine)
    }

    val showProgress = busy
    progressBar.visibility = if (showProgress) View.VISIBLE else View.GONE
    progressBar.isIndeterminate = true
    if (phase != GuidePhase.Extracting) progressText.visibility = View.GONE

    val dotColor = when (phase) {
      GuidePhase.Error, GuidePhase.Closed -> activity.getColor(R.color.ds_danger)
      GuidePhase.Updating, GuidePhase.Extracting -> activity.getColor(R.color.ds_warn)
      GuidePhase.Starting, GuidePhase.Recovering, GuidePhase.Undoing -> activity.getColor(R.color.ds_accent)
      GuidePhase.Idle -> activity.getColor(R.color.ds_text_tertiary)
    }
    chrome.statusDot.background = DsUi.oval(dotColor)
    setStatusPulse(busy)
    refreshGuideMeta()
  }

  private fun defaultHint(phase: GuidePhase): String = when (phase) {
    GuidePhase.Starting -> "首次启动会解压内嵌运行时，请保持应用在前台。"
    GuidePhase.Extracting -> "正在写入内嵌 Termux 环境，约 700MB，需数分钟，请勿关闭应用。"
    GuidePhase.Updating -> "下载并校验快照后会自动切换运行时。"
    GuidePhase.Recovering -> "看门狗正在拉起引擎，通常几秒内恢复。"
    GuidePhase.Undoing -> "正在把配置/插件回滚到最后良好快照（自动回撤）。"
    GuidePhase.Error -> "可打开控制台查看 engine.log，或点击重试。"
    GuidePhase.Closed -> "引擎已停止，不会自动恢复。"
    GuidePhase.Idle -> "引擎就绪后将进入 DeepCode。"
  }

  private fun setStatusPulse(on: Boolean) {
    if (on) {
      val anim = statusPulse ?: ObjectAnimator.ofFloat(chrome.statusDot, View.ALPHA, 1f, 0.28f).apply {
        duration = 900
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
        interpolator = DsUi.ease
        statusPulse = this
      }
      if (!anim.isStarted) anim.start()
    } else {
      statusPulse?.cancel()
      chrome.statusDot.alpha = 1f
    }
  }

  /** 取消状态点脉冲动画（onDestroy 兜底，自 MainActivity.onDestroy 迁入）。 */
  fun cancelPulse() {
    statusPulse?.cancel()
    statusPulse = null
  }

  fun refreshGuideMeta() {
    if (!::chrome.isInitialized) return
    val runtimeReady = try { activity.engineManager.engineReady } catch (_: Exception) { false }
    chrome.runtimeChip.text = if (runtimeReady) {
      activity.getString(R.string.ds_runtime_ready)
    } else {
      activity.getString(R.string.ds_runtime_pending)
    }
    val storageOk = Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()
    chrome.storageChip.text = if (storageOk) {
      activity.getString(R.string.ds_storage_granted)
    } else {
      activity.getString(R.string.ds_storage_needed)
    }
    chrome.storageChip.setTextColor(
      activity.getColor(if (storageOk) R.color.ds_text_secondary else R.color.ds_accent),
    )
  }

  /** 测试界面「检查更新」按钮：手动检查 APK 自更新（用户拍板：不自动检查）。
   *  同按钮三态 = 检查 → （发现新版）二次确认 → 下载安装；已有下载好的包则直接续继安装。 */
  private fun onUpdateButton() {
    if (apkBusy) return
    apkReadyToInstall?.let { continueInstall(); return }
    apkPending?.let { downloadAndInstall(it); return }
    checkApkUpdate()
  }

  private fun setUpdateButton(label: String, enabled: Boolean) {
    // 固定高按钮 + 长版本号（v0.13.7fx-1）会换行截断（device 实测）——单行 + 省略号
    chrome.updateButton.maxLines = 1
    chrome.updateButton.ellipsize = android.text.TextUtils.TruncateAt.END
    chrome.updateButton.text = label
    chrome.updateButton.isEnabled = enabled
    chrome.updateButton.alpha = if (enabled) 1f else 0.55f
  }

  private fun apkHint(msg: String) {
    chrome.statusHint.text = msg
    chrome.statusHint.visibility = View.VISIBLE
  }

  private fun sizeText(bytes: Long): String =
    if (bytes <= 0) "" else "%.1f MB".format(bytes / 1048576.0)

  /** 手动检查（不自动检查）：失败如实报原因，且不阻断既有引擎快照更新检查。
   *  发现新版时不自动进入下载——由用户再点同一按钮二次确认（169MB 下载不做误触启动）。 */
  private fun checkApkUpdate() {
    apkBusy = true
    setUpdateButton(activity.getString(R.string.ds_apk_checking), enabled = false)
    Thread {
      val r = UpdateChecker.checkLatest()
      activity.runOnUiThread {
        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
        apkBusy = false
        when (r) {
          is UpdateChecker.CheckResult.UpToDate -> {
            val v = "v" + UpdateChecker.currentVersion()
            setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
            apkHint(activity.getString(R.string.ds_apk_latest, v))
            toast(activity.getString(R.string.ds_apk_latest, v))
            // 外层的壳已是最新 → 继续既有引擎快照检查（保持本按钮原有语义不失）
            activity.engineFlow.startUpdateCheck()
          }
          is UpdateChecker.CheckResult.Available -> {
            apkPending = r
            setUpdateButton(activity.getString(R.string.ds_apk_confirm, r.tag), enabled = true)
            apkHint(activity.getString(R.string.ds_apk_available, r.tag, "v" + UpdateChecker.currentVersion(), sizeText(r.sizeBytes)))
          }
          is UpdateChecker.CheckResult.Failed -> {
            setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
            apkHint(r.reason)
            toast(r.reason)
            activity.engineFlow.startUpdateCheck()
          }
        }
      }
    }.start()
  }

  /** 二次确认后的下载：镜像链 + .tmp→rename 原子落盘（有 .sha256 资产则校验）；完成后自动拉起安装。 */
  private fun downloadAndInstall(r: UpdateChecker.CheckResult.Available) {
    apkBusy = true
    val dest = File(UpdateChecker.updatesDir(activity), r.name)
    setUpdateButton(activity.getString(R.string.ds_apk_downloading, 0), enabled = false)
    apkHint(activity.getString(R.string.ds_apk_download_hint, r.name, sizeText(r.sizeBytes)))
    Thread {
      var fail: String? = null
      var ok = false
      try {
        val expected = r.sha256Url?.let { UpdateChecker.downloadText(it) }
        // 上次下载完成但未安装（授权中断/安装取消）→ 复用已验证的包，不重复拉 169MB
        val cached = dest.exists() && dest.length() == r.sizeBytes &&
          (expected == null || UpdateChecker.verifySha256(dest, expected))
        if (cached) {
          ok = true
        } else {
          val used = UpdateChecker.download(r.apkUrl, dest) { pct ->
            activity.runOnUiThread {
              if (apkBusy && !activity.isFinishing && !activity.isDestroyed) {
                setUpdateButton(activity.getString(R.string.ds_apk_downloading, pct), enabled = false)
              }
            }
          }
          if (used == null) {
            fail = "下载失败：镜像链全部不可用（直连/GitHub 加速镜像均失败）"
          } else if (expected != null && !UpdateChecker.verifySha256(dest, expected)) {
            dest.delete()
            fail = "下载失败：sha256 校验不匹配（文件已删除，请重试）"
          } else {
            ok = true
          }
        }
      } catch (e: Exception) {
        fail = "下载失败：" + (e.message ?: e.javaClass.simpleName)
      }
      val result = fail
      activity.runOnUiThread {
        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
        apkBusy = false
        if (ok) {
          apkReadyToInstall = dest
          continueInstall()
        } else {
          // 保持二次确认态：同一按钮变「重试下载并安装」，再点即重试
          setUpdateButton(activity.getString(R.string.ds_apk_retry, r.tag), enabled = true)
          apkHint(result ?: "下载失败")
          toast(result ?: "下载失败")
        }
      }
    }.start()
  }

  /** 已下载完成：权限不足先拉「安装未知应用」授权页（onResume 结算续继），否则直接唤起系统安装器。 */
  private fun continueInstall() {
    val apk = apkReadyToInstall ?: return
    if (!apk.exists()) {
      apkReadyToInstall = null
      setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
      apkHint("安装包已不存在，请重新检查更新")
      return
    }
    if (!UpdateChecker.canInstall(activity)) {
      apkHint(activity.getString(R.string.ds_apk_need_permission))
      UpdateChecker.requestInstallPermission(activity)
      return
    }
    if (UpdateChecker.invokeInstaller(activity, apk)) {
      apkHint(activity.getString(R.string.ds_apk_installing))
      apkPending = null
      apkReadyToInstall = null
      setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
    } else {
      setUpdateButton(activity.getString(R.string.ds_apk_retry_install), enabled = true)
      apkHint("安装器拉起失败，请再点按钮重试")
    }
  }

  /** 从「安装未知应用」授权页返回（MainActivity.onResume 调用）：已授权则自动续继安装。 */
  fun settlePendingInstall() {
    if (apkReadyToInstall == null || apkBusy) return
    if (UpdateChecker.canInstall(activity)) continueInstall()
    else apkHint(activity.getString(R.string.ds_apk_permission_denied))
  }

  private fun toast(msg: String) {
    android.widget.Toast.makeText(activity, msg, android.widget.Toast.LENGTH_LONG).show()
  }

  private fun copyGuideLog() {
    val text = logSummary.text?.toString().orEmpty()
    if (text.isBlank()) return
    activity.copyTextNative(text)
    android.widget.Toast.makeText(activity, "日志已复制", android.widget.Toast.LENGTH_SHORT).show()
  }

  fun showWeb() {
    activity.guideView.visibility = View.GONE
    activity.webView.visibility = View.VISIBLE
    // Preserve the existing WebView session across a liveness transition. Only
    // a documented engine-origin load error requires a fresh navigation.
    if (activity.enginePageFailed) {
      activity.enginePageFailed = false
      activity.webView.reload()
    }
  }

  /** 进入测试界面（引擎失败/未就绪回退）：状态 + 崩溃横幅 + engine.log 摘要。 */
  fun showGuide() {
    val becomingVisible = activity.guideView.visibility != View.VISIBLE
    activity.webView.visibility = View.GONE
    activity.guideView.visibility = View.VISIBLE
    if (becomingVisible) animateGuideReveal()
    val crash = activity.crashInfo
    if (crash != null) {
      crashBanner.visibility = View.VISIBLE
      crashBanner.text = "上次异常退出：$crash"
    } else {
      crashBanner.visibility = View.GONE
    }
    val tail = tailEngineLog(8)
    if (tail.isNotEmpty()) {
      logSummary.text = tail
      chrome.logSection.visibility = View.VISIBLE
    } else {
      chrome.logSection.visibility = View.GONE
    }
    refreshGuideMeta()
  }

  /** engine.log 尾部摘要（测试界面诊断用；缺失/不可读返回空）。
   *  展示出口脱敏（0.13.8 #184）：用户截图上报即外发，令牌行不得进入。 */
  private fun tailEngineLog(lines: Int): String {
    val f = File(activity.filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      java.io.RandomAccessFile(f, "r").use { file ->
        val start = (file.length() - 16 * 1024).coerceAtLeast(0)
        file.seek(start)
        val bytes = ByteArray((file.length() - start).toInt())
        file.readFully(bytes)
        val tail = java.util.ArrayDeque<String>(lines)
        String(bytes, Charsets.UTF_8).lineSequence().forEach { line ->
          if (tail.size == lines) tail.removeFirst()
          tail.addLast(line)
        }
        EngineAuth.redact(tail.joinToString("\n"))
      }
    } catch (_: Exception) {
      ""
    }
  }
}
