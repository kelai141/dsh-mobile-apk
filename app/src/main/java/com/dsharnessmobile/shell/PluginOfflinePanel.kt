package com.dsharnessmobile.shell

import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import org.json.JSONObject

/**
 * 未启动引擎时的插件管理入口：直接对 live 装配清单做启停，不依赖运行中的引擎。
 *
 * 为什么必须存在：插件管理此前只能走运行中引擎的 pluginManager RPC，于是「装了会崩溃的 soft 插件
 * 导致引擎起不来」时用户没有任何出口——要先起引擎才能关掉导致起不来的插件。本类提供离线数据源
 * （[PluginPatchOffline]）的读写与原生页面，判据与风险和在线路径不同，故单独成文件而不是塞进
 * [PluginManagementRepository]（后者的变更验证依赖引擎回读）。
 *
 * 事务纪律（参照 [PluginMounts] / [SafeMode] 的既有做法）：
 * - 读：每次现读 live 清单，不缓存（用户可能刚在别处改过）；
 * - 写：先读一次核对目标当前状态 → 纯函数算出新全文 → 写临时文件 fsync 后原子替换；
 * - 写后回读校验：目标状态必须真的翻过来，否则报失败并保留原文；
 * - Hard 清单缺失/不匹配：拒绝任何写入（与启动闸门同口径，绝不猜测归属）。
 */
internal class PluginOfflineRepository(private val context: android.content.Context) {

  private fun engineHome(): File = File(context.filesDir, "home")

  /** live 装配清单（与 [PluginMounts.patchFile] 同源：`<home>/.dsh/profiles/web/cordis.patch.yml`）。 */
  internal fun patchFile(): File = File(engineHome(), ".dsh/profiles/web/cordis.patch.yml")

  internal fun hardManifest(): PluginMounts.HardManifest? =
    PluginMounts.ensureHard(context, PluginMounts.currentFingerprint(context))

  /** 离线可管理的 soft 插件；清单还没落到设备上时返回空表（不是错误，属于首启前的正常态）。 */
  internal fun rows(): List<PluginPatchOffline.Row> {
    val hard = hardManifest() ?: throw PluginManagementRepository.PluginManagementException("当前版本的插件归属清单不可用，已停止离线插件管理")
    val patch = patchFile()
    val text = runCatching { if (patch.isFile) patch.readText() else "" }.getOrDefault("")
    return PluginPatchOffline.rows(text, hard)
  }

  /**
   * 写入一次启用状态变更。
   * @return 变更后的状态（true = 已启用）。
   * @throws PluginManagementRepository.PluginManagementException 定位不到、清单不可信或回读不一致。
   */
  internal fun setEnabled(id: String, name: String?, enabled: Boolean): Boolean {
    val hard = hardManifest() ?: throw PluginManagementRepository.PluginManagementException("当前版本的插件归属清单不可用，已停止离线插件管理")
    if (hard.owns(id, name)) throw PluginManagementRepository.PluginManagementException("Hard 清单中的插件不可在离线页修改")
    val patch = patchFile()
    if (patch.exists() && (!patch.isFile || java.nio.file.Files.isSymbolicLink(patch.toPath()))) {
      throw PluginManagementRepository.PluginManagementException("装配清单不是普通文件，已拒绝写入")
    }
    val before = runCatching { if (patch.isFile) patch.readText() else "" }.getOrDefault("")
    val next = PluginPatchOffline.setEnabled(before, id, name, enabled)
      ?: throw PluginManagementRepository.PluginManagementException(if (enabled) "该插件当前已是启用状态，无需修改" else "定位不到可写入的插件条目，已拒绝修改")
    writeAtomically(patch, next)
    // 回读：写进去的东西必须真的生效（解析口径与读取侧同源），否则这次操作不算成功。
    val observed = PluginPatchOffline.rows(patch.readText(), hard).firstOrNull { it.id == id }
      ?: throw PluginManagementRepository.PluginManagementException("写入后回读不到该插件，已保留原清单内容")
    if (observed.enabled != enabled) throw PluginManagementRepository.PluginManagementException("写入后回读的状态与请求不一致，请稍后重试")
    return observed.enabled
  }

  /** 原子写入：同目录临时文件 → 逐字节校验 → 替换；失败不留下半份清单。 */
  private fun writeAtomically(target: File, text: String) {
    val dir = target.absoluteFile.parentFile ?: throw PluginManagementRepository.PluginManagementException("装配清单目录不可用")
    if (!dir.exists() && !dir.mkdirs()) throw PluginManagementRepository.PluginManagementException("无法创建装配清单目录")
    val tmp = File.createTempFile(".cordis-patch-", ".tmp", dir)
    try {
      tmp.writeText(text)
      val written = tmp.readText()
      if (written != text) throw PluginManagementRepository.PluginManagementException("清单写入校验失败，未替换原文件")
      java.nio.file.Files.move(
        tmp.toPath(), target.toPath(),
        java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
      )
    } finally {
      if (tmp.exists()) tmp.delete()
    }
  }
}

/**
 * 启动页「插件管理」在引擎未启动时使用的离线面板。
 *
 * 页面结构刻意与在线页（[PluginManagementPage]）同构：列表 + 开关 + 详情说明，方便用户在两态之间
 * 迁移时不用重学。差异只有一条但很重要：离线态**不提供配置编辑**（配置事务要求引擎的 settings
 * 服务），并在页首明示「重启引擎后生效」。
 */
internal class PluginOfflinePanel(private val activity: MainActivity) {

  private val repository = PluginOfflineRepository(activity)
  private val black = activity.getColor(R.color.ds_bg)
  private val white = activity.getColor(R.color.ds_text_primary)
  private val gray1 = activity.getColor(R.color.ds_text_secondary)
  private val gray3 = activity.getColor(R.color.ds_text_tertiary)
  private val gray4 = activity.getColor(R.color.ds_surface)
  private val accent = activity.getColor(R.color.ds_accent)
  private val textOnAccent = activity.getColor(R.color.ds_text_on_accent)

  private val root = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    setBackgroundColor(black)
    layoutParams = ViewGroup.LayoutParams(-1, -1)
  }
  private val rowsHost = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
  private val countLabel = TextView(activity).apply { textSize = 12f; setTextColor(gray3) }
  private val error = TextView(activity).apply {
    textSize = 14f
    setTextColor(white)
    setPadding(dp(14), dp(10), dp(14), dp(10))
    background = DsUi.roundRect(activity.getColor(R.color.ds_danger_soft), dp(8).toFloat())
    visibility = View.GONE
    isFocusable = true
  }

  val view: View get() = root

  init {
    // 错误条固定在顶部（写入失败的原因必须一直在视野里，不能被滚走）。
    root.addView(error, LinearLayout.LayoutParams(-1, -2))
    // 标题、说明、列表、计数**同处一个滚动区**（2026-10-18 横屏实测）：
    // 旧实现把标题与说明做固定头部，横屏（720 高）里它们与计数一起把视口占满，
    // 列表只剩不到一行高——插件行被裁成半行、计数标签贴着断口，用户既看不全也点不准。
    // 现在头部随内容一起滚：矮视口下先看到说明，往下滚就是完整的一行行条目。
    val content = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      addView(LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(18), dp(15), dp(18), dp(9))
        addView(TextView(activity).apply {
          text = "离线插件管理"
          textSize = 18f
          setTextColor(white)
          typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        })
        addView(TextView(activity).apply {
          text = "引擎未启动也能改：改动写入装配清单，下次启动引擎生效。Hard 清单里的产品插件不在列表内。"
          textSize = 13f
          setTextColor(gray1)
          setLineSpacing(0f, 1.25f)
          setPadding(0, dp(6), 0, 0)
        })
      })
      addView(rowsHost, LinearLayout.LayoutParams(-1, -2))
      addView(countLabel, LinearLayout.LayoutParams(-1, -2).apply {
        topMargin = dp(4)
        leftMargin = dp(18)
        rightMargin = dp(18)
        bottomMargin = dp(9)
      })
    }
    root.addView(ScrollView(activity).apply {
      isFillViewport = true
      addView(content, ViewGroup.LayoutParams(-1, -2))
    }, LinearLayout.LayoutParams(-1, 0, 1f))
    reload()
  }

  /**
   * 重读清单并重绘列表；失败时把真因写进错误条（不静默）。
   *
   * @param keepError 写入失败后调用时为真：此时错误条里是**这次写入**的真因，必须留着。
   *   旧签名无条件清除，调用方先 showError() 紧接着 reload()，就会把自己刚写的失败原因抹掉——
   *   用户只看到「没变化」，一个字的解释都没有。
   */
  fun reload(keepError: Boolean = false) {
    if (!keepError) error.visibility = View.GONE
    rowsHost.removeAllViews()
    val rows = try {
      repository.rows()
    } catch (t: Throwable) {
      showError(t.message ?: "读取装配清单失败")
      countLabel.text = ""
      return
    }
    countLabel.text = if (rows.isEmpty()) "当前装配清单里没有可管理的第三方插件" else rows.size.toString() + " 个第三方插件"
    rows.forEach { rowsHost.addView(rowView(it)) }
  }

  private fun rowView(row: PluginPatchOffline.Row): View {
    val card = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(18), dp(12), dp(18), dp(12))
      minimumHeight = dp(76)
    }
    val text = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
      setPadding(0, 0, dp(10), 0)
    }
    text.addView(TextView(activity).apply {
      this.text = row.name ?: row.id
      textSize = 15f
      setTextColor(white)
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    })
    text.addView(TextView(activity).apply {
      this.text = row.id + if (row.enabled) " · 已启用" else " · 已停用（下次启动生效）"
      textSize = 12f
      setTextColor(gray3)
      setPadding(0, dp(4), 0, 0)
    })
    val toggle = Button(activity).apply {
      this.text = if (row.enabled) "停用" else "启用"
      isAllCaps = false
      textSize = 13f
      minimumHeight = dp(44)
      stateListAnimator = null
      setTextColor(if (row.enabled) white else textOnAccent)
      background = DsUi.ripple(
        DsUi.roundRect(if (row.enabled) gray4 else accent, dp(10).toFloat()),
        activity.getColor(R.color.ds_accent_pressed),
      )
      contentDescription = (row.name ?: row.id) + if (row.enabled) "，停用插件" else "，启用插件"
      setOnClickListener { apply(row, this) }
    }
    card.addView(text)
    card.addView(toggle, LinearLayout.LayoutParams(dp(84), dp(44)))
    return card
  }

  private fun apply(row: PluginPatchOffline.Row, button: Button) {
    button.isEnabled = false
    Thread {
      val result = runCatching { repository.setEnabled(row.id, row.name, !row.enabled) }
      activity.runOnUiThread {
        if (button.isAttachedToWindow) button.isEnabled = true
        result.onSuccess { enabled ->
          reload()
          android.widget.Toast.makeText(
            activity,
            (row.name ?: row.id) + if (enabled) " 已启用，重启引擎后生效" else " 已停用，重启引擎后生效",
            android.widget.Toast.LENGTH_SHORT,
          ).show()
        }.onFailure { failure ->
          // 先重绘（此时数据可能已被写坏到读不出来），再把真因覆盖到错误条上。
          reload(keepError = true)
          showError(failure.message ?: "修改失败")
        }
      }
    }.start()
  }

  private fun showError(message: String) {
    error.text = message
    error.visibility = View.VISIBLE
  }

  private fun dp(value: Int): Int = (value * activity.resources.displayMetrics.density + 0.5f).toInt()
}
