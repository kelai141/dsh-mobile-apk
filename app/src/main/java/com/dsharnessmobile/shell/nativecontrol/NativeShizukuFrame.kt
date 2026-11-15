package com.dsharnessmobile.shell.nativecontrol

import android.os.ParcelFileDescriptor
import android.os.SystemClock
import org.json.JSONObject
import android.os.Parcel
import android.os.SharedMemory

/** Consumes a finite read-only shared frame. Binder never carries the multi-megabyte pixels. */
internal object NativeShizukuFrame {
  private const val MAX_RAW_BYTES = 32 * 1024 * 1024

  fun read(descriptor: ParcelFileDescriptor, target: NativeAccessibilityPlatform.RawTarget,
    deadlineMs: Long): NativeAccessibilityPlatform.RawFrame? {
    val parcel = Parcel.obtain()
    try {
      descriptor.use { parcel.writeFileDescriptor(it.fileDescriptor) }
      parcel.setDataPosition(0)
      SharedMemory.CREATOR.createFromParcel(parcel).use { memory ->
      val input = memory.mapReadOnly()
      try {
      val fileBytes = memory.size.toLong()
      if (fileBytes !in 9L..(MAX_RAW_BYTES + 4104L) || SystemClock.elapsedRealtime() >= deadlineMs) return null
      if (input.int != 0x44534846) return null
      val metadataBytes = input.int
      if (metadataBytes !in 1..4096) return null
      val metadata = ByteArray(metadataBytes).also { input.get(it) }
      val info = JSONObject(String(metadata, Charsets.UTF_8))
      val width = info.getInt("width")
      val height = info.getInt("height")
      val stride = info.getInt("rowStride")
      val size = info.getLong("bytes")
      if (width !in 1..8192 || height !in 1..8192 || stride.toLong() < width * 4L ||
        stride > 8192 * 4 || size != stride.toLong() * height || size !in 1L..MAX_RAW_BYTES.toLong() ||
        fileBytes != 8L + metadataBytes + size) return null
      val transform = NativeRawGeometry.transformFor(width, height, target.logicalWidth, target.logicalHeight)
        ?: run {
          android.util.Log.w("dsh-native-control", "frame geometry mismatch raw=${width}x${height} logical=${target.logicalWidth}x${target.logicalHeight}")
          return null
        }
      val pixels = ByteArray(size.toInt()).also { input.get(it) }
      if (SystemClock.elapsedRealtime() >= deadlineMs) return null
      return NativeAccessibilityPlatform.RawFrame(target, width, height, stride, pixels, transform,
        "sRGB", info.getBoolean("premultipliedAlpha"), SystemClock.elapsedRealtime())
      } finally { SharedMemory.unmap(input) }
      }
    } finally { parcel.recycle() }
  }
}
