package com.dsharnessmobile.shell

/** Visual tuning only, not gesture completion thresholds. Distinct phases prevent superimposed text. */
internal data class OverlayCardMorphTextAlpha(val historyAlpha: Float, val capsuleAlpha: Float)

internal fun overlayCardMorphTextAlpha(
  progress: Float,
  historyFadeEnd: Float = 0.3f,
  capsuleFadeStart: Float = 0.5f,
): OverlayCardMorphTextAlpha {
  require(historyFadeEnd > 0f && historyFadeEnd <= capsuleFadeStart && capsuleFadeStart < 1f)
  val p = if (progress.isFinite()) progress.coerceIn(0f, 1f) else 0f
  fun smooth(value: Float): Float {
    val t = value.coerceIn(0f, 1f)
    return t * t * (3f - 2f * t)
  }
  return OverlayCardMorphTextAlpha(
    historyAlpha = 1f - smooth(p / historyFadeEnd),
    capsuleAlpha = smooth((p - capsuleFadeStart) / (1f - capsuleFadeStart)),
  )
}
