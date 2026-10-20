package com.dsharnessmobile.shell

import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.view.Gravity
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout

/**
 * Full-screen startup video drawn above the guide page.
 *
 * TextureView (not SurfaceView) keeps the layer inside the normal view hierarchy, so it
 * fades with the Activity and needs no window punch-through. The player is muted and
 * looping; every failure path removes the view instead of leaving a black rectangle on
 * top of the retry button.
 */
internal class SplashOverlay(
  private val container: FrameLayout,
  private val onFailure: (String) -> Unit,
) {
  private var textureView: TextureView? = null
  private var player: MediaPlayer? = null
  private var surface: android.view.Surface? = null
  private var dismissed = false
  private var prepared = false

  val isActive: Boolean get() = !dismissed && textureView != null

  /**
   * Show the configured video. Returns false when there is nothing playable, so the
   * caller can leave the guide page untouched.
   */
  fun play(path: String): Boolean {
    if (isActive) return true
    dismissed = false
    prepared = false
    val view = TextureView(container.context).apply {
      layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      isOpaque = true
      // Opaque black before the first frame: the guide page behind must not flash through.
      setBackgroundColor(android.graphics.Color.BLACK)
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      isClickable = false
    }
    textureView = view
    container.addView(view)
    // 后挂的宿主占位（BrowserHost / VdisplayHost 的 1x1 view）也会 addView；
    // 视频必须始终在最上层，否则会被无声地盖住。
    view.bringToFront()
    view.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        if (dismissed) return
        startPlayer(path, surface)
      }

      override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        applyCover()
      }

      override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        releasePlayer()
        return true
      }

      override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
    }
    return true
  }

  /** Fade out and remove. Idempotent; safe to call before the first frame arrives. */
  fun dismiss(animate: Boolean = true, onDone: (() -> Unit)? = null) {
    if (dismissed) { onDone?.invoke(); return }
    dismissed = true
    val view = textureView
    textureView = null
    if (view == null) { releasePlayer(); onDone?.invoke(); return }
    if (!animate) {
      releasePlayer()
      container.removeView(view)
      onDone?.invoke()
      return
    }
    // Keep the last frame on screen while it fades; releasing first would flash black.
    view.animate().alpha(0f).setDuration(FADE_MS).withEndAction {
      releasePlayer()
      container.removeView(view)
      onDone?.invoke()
    }.start()
  }

  /** Stop decoding while the app is not visible; the view stays mounted. */
  fun pause() {
    try {
      player?.takeIf { prepared && it.isPlaying }?.pause()
    } catch (_: Throwable) {
    }
  }

  fun resume() {
    try {
      player?.takeIf { prepared && !it.isPlaying }?.start()
    } catch (_: Throwable) {
    }
  }

  private fun startPlayer(path: String, surface: SurfaceTexture) {
    val media = MediaPlayer()
    player = media
    try {
      val holder = android.view.Surface(surface)
      this.surface = holder
      media.setSurface(holder)
      media.setDataSource(path)
      media.isLooping = true
      // Silent by contract: the startup video is decoration, it must not fight the
      // user's music or ask for audio focus while the engine boots.
      media.setVolume(0f, 0f)
      media.setOnVideoSizeChangedListener { _, width, height ->
        applyCover(width, height)
      }
      media.setOnPreparedListener {
        if (dismissed) { releasePlayer(); return@setOnPreparedListener }
        prepared = true
        it.start()
        applyCover(it.videoWidth, it.videoHeight)
      }
      media.setOnErrorListener { _, what, extra ->
        fail("decode") // The caller falls back to the guide page.
        true
      }
      media.prepareAsync()
    } catch (t: Throwable) {
      fail("io")
    }
  }

  private fun fail(code: String) {
    if (dismissed) return
    dismissed = true
    releasePlayer()
    textureView?.let { container.removeView(it) }
    textureView = null
    onFailure(code)
  }

  private fun releasePlayer() {
    val media = player
    player = null
    prepared = false
    if (media == null) return
    try {
      media.setOnPreparedListener(null)
      media.setOnErrorListener(null)
      media.setOnVideoSizeChangedListener(null)
      if (media.isPlaying) media.stop()
    } catch (_: Throwable) {
    }
    try {
      media.reset()
      media.release()
    } catch (_: Throwable) {
    }
    try {
      surface?.release()
    } catch (_: Throwable) {
    }
    surface = null
  }

  private fun applyCover() {
    val media = player ?: return
    applyCover(media.videoWidth, media.videoHeight)
  }

  /** CENTER_CROP: fill the screen without letterboxing, cropping the longer axis. */
  private fun applyCover(videoWidth: Int, videoHeight: Int) {
    val view = textureView ?: return
    if (videoWidth <= 0 || videoHeight <= 0) return
    val viewWidth = view.width.toFloat()
    val viewHeight = view.height.toFloat()
    if (viewWidth <= 0f || viewHeight <= 0f) return
    val scale = maxOf(viewWidth / videoWidth, viewHeight / videoHeight)
    val dx = (viewWidth - videoWidth * scale) / 2f
    val dy = (viewHeight - videoHeight * scale) / 2f
    val matrix = Matrix()
    matrix.setScale(scale, scale)
    matrix.postTranslate(dx, dy)
    view.setTransform(matrix)
  }

  companion object {
    private const val FADE_MS = 260L
  }
}
