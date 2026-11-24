package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayAttachmentIconsTest {
  @Test fun typesShareAssetsAndUnknownInputsFallBack() {
    assertEquals("jpeg", OverlayAttachmentIcons.type("archive.photo.JPEG"))
    assertEquals("typescript", OverlayAttachmentIcons.type("SERVER.TSX"))
    assertEquals("spreadsheet", OverlayAttachmentIcons.type("sheet.ODS"))
    assertEquals("document", OverlayAttachmentIcons.type("notes.DOCX"))
    assertEquals("folder", OverlayAttachmentIcons.type("Pictures/"))
    assertEquals("generic", OverlayAttachmentIcons.type("no-extension"))
    assertEquals("generic", OverlayAttachmentIcons.type("mystery.bin"))
    val assets = listOf(File("src/main/assets"), File("app/src/main/assets")).first { it.isDirectory }
    val icons = assets.resolve("overlay-attachment-types").listFiles { file -> file.extension == "svg" }.orEmpty()
    assertEquals(62, icons.size)
    assertTrue(icons.all { it.readText().contains("viewBox=\"0 0 48 40\"") })
  }
}
