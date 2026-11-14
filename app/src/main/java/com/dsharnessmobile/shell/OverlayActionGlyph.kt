package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View

/**
 * 发送/停止按钮的自绘图形：蓝色圆底 + 白色上箭头或白色圆角方块。
 *
 * 为什么自绘：这个按钮只有 44dp，用文字（"发送"/"停止"）在 12sp 下中英文宽度差很多，
 * 看起来总是偏一点；箭头和方块是几何图形，可以按圆心精确摆正，不依赖字体度量。
 *
 * 两种形态由调用方的语义决定，本类只负责画：
 * - [Glyph.SEND]：上箭头，表示"发出去"；
 * - [Glyph.STOP]：圆角方块，表示"停下当前这轮"。
 */
internal class OverlayActionGlyphView(context: Context) : View(context) {

  internal enum class Glyph { SEND, STOP }

  private val circlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
    color = ACCENT_BLUE
  }
  private val glyphPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    color = Color.WHITE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val squarePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
    color = Color.WHITE
  }

  private val arrowPath = Path()
  private val squareRect = RectF()
  private var glyph = Glyph.STOP

  /** 箭头需要多少笔画宽度：按控件短边等比缩放，任何尺寸下粗细观感一致。 */
  private var strokeWidthPx = 0f

  fun setGlyph(next: Glyph) {
    if (glyph == next) return
    glyph = next
    buildGeometry()
    invalidate()
  }

  fun currentGlyph(): Glyph = glyph

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    buildGeometry()
  }

  /**
   * 一次性把两套几何都算好。
   *
   * 为什么不用 onDraw 里现算：箭头路径每帧重建会产生垃圾，而这个按钮在输入过程中
   * 会被频繁 requestLayout（行数变化），按尺寸缓存更稳。
   */
  private fun buildGeometry() {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    val side = minOf(w, h)
    val cx = w / 2f
    val cy = h / 2f

    strokeWidthPx = (side * 0.085f).coerceAtLeast(1f)
    glyphPaint.strokeWidth = strokeWidthPx

    // 箭头：竖杆 + 两侧斜肩，整体占圆直径的 42%。
    val arm = side * 0.21f
    val top = cy - side * 0.20f
    val bottom = cy + side * 0.20f
    arrowPath.reset()
    arrowPath.moveTo(cx, bottom)
    arrowPath.lineTo(cx, top)
    arrowPath.moveTo(cx - arm, top + arm)
    arrowPath.lineTo(cx, top)
    arrowPath.lineTo(cx + arm, top + arm)

    // 方块：边长为圆直径的 30%，圆角同样按比例，避免小尺寸下看起来是硬直角。
    val halfSide = side * 0.15f
    squareRect.set(cx - halfSide, cy - halfSide, cx + halfSide, cy + halfSide)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    val radius = minOf(w, h) / 2f
    canvas.drawCircle(w / 2f, h / 2f, radius, circlePaint)
    when (glyph) {
      Glyph.SEND -> canvas.drawPath(arrowPath, glyphPaint)
      Glyph.STOP -> {
        val corner = squareRect.width() * 0.28f
        canvas.drawRoundRect(squareRect, corner, corner, squarePaint)
      }
    }
  }

  private companion object {
    /** 与设计稿取自同一处取色：参考图的圆底是 #7AAAFF，箭头与方块是纯白。 */
    const val ACCENT_BLUE = 0xFF7AAAFF.toInt()
  }
}
