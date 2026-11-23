package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Picture
import android.graphics.drawable.PictureDrawable
import androidx.core.graphics.PathParser
import org.xmlpull.v1.XmlPullParser
import android.util.Xml
import java.util.Locale

/** Shared extensions point at one bundled SVG. Extensionless and unknown files use generic. */
internal object OverlayAttachmentIcons {
  private val byExtension = """
generic:
folder:
archive:zip 7z rar tar gz tgz bz2 xz zst
pdf:pdf
document:doc docx odt
spreadsheet:xls xlsx ods
presentation:ppt pptx odp
markdown:md markdown
text:txt log
richtext:rtf
ebook:epub mobi azw azw3
csv:csv tsv
latex:tex
mindmap:xmind mm
jpeg:jpg jpeg jpe
png:png apng
webp:webp
gif:gif
svg:svg svgz
bitmap:bmp tif tiff heic heif avif
icon:ico icns
raw:dng cr2 cr3 nef arw raf
photoshop:psd
illustrator:ai eps
mp3:mp3
wav:wav wave
flac:flac
aac:aac m4a
ogg:ogg oga opus
midi:mid midi
mp4:mp4 m4v
mkv:mkv
mov:mov
avi:avi
webm:webm
subtitle:srt ass vtt ssa
javascript:js mjs cjs jsx
typescript:ts tsx mts cts
python:py pyw ipynb
rust:rs
cpp:c h cpp hpp cc cxx
java:java
kotlin:kt kts
go:go
swift:swift
shell:sh bash zsh fish ps1
html:html htm
css:css scss less sass
json:json jsonl
yaml:yaml yml
xml:xml
sql:sql db sqlite sqlite3
config:ini toml cfg conf properties env
android:apk aab
windows:exe msi msix
linux:deb rpm appimage
macos:dmg pkg
font:ttf otf woff woff2
model:obj stl glb gltf fbx
cad:dwg dxf step stp
patch:patch diff
certificate:pem crt cer pub
  """.trimIndent().lineSequence().flatMap { line ->
    val type = line.substringBefore(':')
    line.substringAfter(':').split(' ').filter { it.isNotEmpty() }.map { it to type }
  }.toMap()

  fun extension(name: String): String = name.substringAfterLast('.', "")
    .takeIf { name.lastIndexOf('.') > 0 }.orEmpty().lowercase(Locale.ROOT)

  fun type(name: String): String = if (name.endsWith('/')) "folder" else byExtension[extension(name)] ?: "generic"

  /** Keep the extension visible under Android's measured middle truncation. */
  fun fileName(name: String): String = overlaySingleLine(name.substringAfterLast('/'))

  private val pictures = HashMap<String, Picture>()

  fun drawable(context: Context, name: String): PictureDrawable? {
    val type = type(name)
    return (load(context, type) ?: load(context, "generic"))?.let(::PictureDrawable)
  }

  // Trusted assets all use the same viewport and a small, flat SVG drawing vocabulary.
  // The Android canvas replays each asset once; cards never parse user-supplied SVG files.
  private fun load(context: Context, type: String): Picture? {
    pictures[type]?.let { return it }
    return runCatching {
      context.assets.open("overlay-attachment-types/$type.svg").use { input ->
        val parser = Xml.newPullParser().apply { setInput(input, "UTF-8") }
        val picture = Picture()
        val canvas = picture.beginRecording(48, 40)
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
          if (parser.eventType == XmlPullParser.START_TAG) drawShape(parser, canvas)
        }
        picture.endRecording()
        picture.also { pictures[type] = it }
      }
    }.getOrElse {
      LogCollector.log("dsh-overlay", "attachment icon failed: $type")
      null
    }
  }

  private fun drawShape(parser: XmlPullParser, canvas: Canvas) {
    fun attr(name: String) = parser.getAttributeValue(null, name)
    fun number(name: String, fallback: Float = 0f) = attr(name)?.toFloatOrNull() ?: fallback
    val shape = when (parser.name) {
      "path" -> PathParser.createPathFromPathData(attr("d")) ?: return
      "circle" -> Path().apply { addCircle(number("cx"), number("cy"), number("r"), Path.Direction.CW) }
      "rect" -> Path().apply {
        val x = number("x")
        val y = number("y")
        val radius = number("rx")
        addRoundRect(x, y, x + number("width"), y + number("height"), radius, radius, Path.Direction.CW)
      }
      else -> return
    }
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    val fill = attr("fill") ?: "#000000"
    if (fill != "none") {
      paint.color = Color.parseColor(fill)
      canvas.drawPath(shape, paint)
    }
    attr("stroke")?.takeUnless { it == "none" }?.let { stroke ->
      paint.color = Color.parseColor(stroke)
      paint.style = Paint.Style.STROKE
      paint.strokeWidth = number("stroke-width", 1f)
      if (attr("stroke-linejoin") == "round") paint.strokeJoin = Paint.Join.ROUND
      if (attr("stroke-linecap") == "round") paint.strokeCap = Paint.Cap.ROUND
      canvas.drawPath(shape, paint)
    }
  }
}
