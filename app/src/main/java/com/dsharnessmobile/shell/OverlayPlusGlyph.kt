package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View

/**
 * 「更多」入口的加号徽标：与发送/停止按钮同一套几何比例绘制。
 *
 * 为什么不用 TextView 的「＋」：字体字形的笔画宽度和视觉中心随字体/字号变化，
 * 与自绘箭头放在同一行时一个偏细一个偏粗，读起来像两个不同尺寸的按钮。
 * 这里按 [OverlayActionGlyphView] 的同一组比例（外圆、笔画宽度、臂长）绘制，
 * 只把填充圆改成描边圆、颜色改用次级文字色，保证左右两侧命中区与图标观感一致。
 */
internal class OverlayPlusGlyphView(context: Context) : View(context) {

  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
    color = ContextCompatColor.chip(context)
  }
  private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = ContextCompatColor.border(context)
    strokeWidth = context.resources.displayMetrics.density
  }
  private val glyphPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = ContextCompatColor.textSecondary(context)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    val side = minOf(w, h)
    val cx = w / 2f
    val cy = h / 2f
    // 与发送按钮同口径：外圆撑满控件，笔画占短边 8.5%，臂长占短边 21%。
    canvas.drawCircle(cx, cy, side / 2f, fillPaint)
    canvas.drawCircle(cx, cy, side / 2f - strokePaint.strokeWidth / 2f, strokePaint)
    val arm = side * 0.21f
    glyphPaint.strokeWidth = (side * 0.085f).coerceAtLeast(1f)
    canvas.drawLine(cx - arm, cy, cx + arm, cy, glyphPaint)
    canvas.drawLine(cx, cy - arm, cx, cy + arm, glyphPaint)
  }
}

/** 只读色板入口：避免本文件依赖 View 里的实例字段。 */
private object ContextCompatColor {
  fun chip(context: Context): Int = androidx.core.content.ContextCompat.getColor(context, R.color.ds_chip)
  fun border(context: Context): Int = androidx.core.content.ContextCompat.getColor(context, R.color.ds_border)
  fun textSecondary(context: Context): Int = androidx.core.content.ContextCompat.getColor(context, R.color.ds_text_secondary)
}
