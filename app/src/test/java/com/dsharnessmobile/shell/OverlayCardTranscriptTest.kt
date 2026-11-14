package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** 真正文/身份差异/跟随规则纯判据与生产接线；不冒充WMS、滚动与像素设备验收。 */
class OverlayCardTranscriptTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  @Test fun idleCardCarriesRealUserAndAssistantMultilineContent() {
    val rows = listOf(
      OverlayTranscriptRow("user-1", "user", "第一行\n第二行\n  保留空白"),
      OverlayTranscriptRow("assistant-1", "assistant", "真实回答\n" + "long body ".repeat(100)),
    )
    val data = OverlayCardData("空闲", "", 0, emptyList(), "", emptyList(), false, rows)
    val plan = overlayTranscriptMergePlan(emptyList(), data.transcript)
    assertFalse(data.running)
    assertEquals(rows, plan.rows)
    assertTrue(plan.rows.last().text.length > 120)
    assertTrue(plan.rows.first().text.contains("\n  保留空白"))
    assertTrue(OverlayCardData("Idle", "", 0, emptyList(), "", emptyList(), false).transcript.isEmpty())
  }

  @Test fun repeatedSnapshotProducesNoTextUpdatesOrRemovals() {
    val rows = listOf(OverlayTranscriptRow("a", "user", "question"), OverlayTranscriptRow("b", "assistant", "answer"))
    val plan = overlayTranscriptMergePlan(rows, rows.map { it.copy() })
    assertEquals(rows, plan.rows)
    assertTrue(plan.changedIds.isEmpty())
    assertTrue(plan.removedIds.isEmpty())
  }

  @Test fun streamedMessageKeepsItsStableIdAndOnlyChangesThatBody() {
    val previous = listOf(OverlayTranscriptRow("u", "user", "question"), OverlayTranscriptRow("a", "assistant", "ans"))
    val next = listOf(previous.first(), previous.last().copy(text = "answer\ncontinued"))
    val plan = overlayTranscriptMergePlan(previous, next)
    assertEquals(setOf("a"), plan.changedIds)
    assertTrue(plan.removedIds.isEmpty())
    assertEquals(listOf("u", "a"), plan.rows.map { it.id })
  }

  @Test fun insertionReorderingAndHeadEvictionDoNotRebindUnchangedIds() {
    val a = OverlayTranscriptRow("a", "user", "a")
    val b = OverlayTranscriptRow("b", "assistant", "b")
    val c = OverlayTranscriptRow("c", "user", "c")
    val plan = overlayTranscriptMergePlan(listOf(a, b), listOf(b, a, c))
    assertEquals(listOf("b", "a", "c"), plan.rows.map { it.id })
    assertEquals(setOf("c"), plan.changedIds)
    val many = (0..44).map { OverlayTranscriptRow("r$it", if (it % 2 == 0) "user" else "assistant", "text$it") }
    val capped = overlayTranscriptMergePlan(listOf(a), many)
    assertEquals(40, capped.rows.size)
    assertEquals("r5", capped.rows.first().id)
    assertEquals("r44", capped.rows.last().id)
    assertEquals(setOf("a"), capped.removedIds)
  }

  @Test fun unknownToolRolesCannotMasqueradeAsAssistantAndDuplicateIdUsesLastSnapshot() {
    val latest = OverlayTranscriptRow("a", "assistant", "new\nbody")
    val plan = overlayTranscriptMergePlan(emptyList(), listOf(
      OverlayTranscriptRow("a", "assistant", "old"), OverlayTranscriptRow("tool", "tool", "not dialogue"),
      OverlayTranscriptRow("", "user", "missing identity"), latest,
    ))
    assertEquals(listOf(latest), plan.rows)
  }

  @Test fun followingRequiresPriorBottomPositionAndNoActiveUserTouch() {
    assertTrue(overlayTranscriptShouldFollow(600, 400, 1000, false, 16))
    assertTrue(overlayTranscriptShouldFollow(590, 400, 1000, false, 16))
    assertFalse(overlayTranscriptShouldFollow(100, 400, 1000, false, 16))
    assertFalse(overlayTranscriptShouldFollow(600, 400, 1000, true, 16))
    assertTrue(overlayTranscriptShouldFollow(0, 0, 0, false, 16))
    assertFalse(overlayTranscriptShouldFollow(0, 400, 1000, false, -1))
  }

  @Test fun actualRendererUsesStableHoldersAndFullMultilineBodiesWithoutRebuildingTheColumn() {
    val source = source("OverlayCardView.kt")
    val render = source.substringAfter("private fun renderTranscript(").substringBefore("private fun bindTranscriptRow(")
    assertRendererContract(render)
    assertTrue(render.contains("if (plan.rows == transcriptRows) return"))
    assertTrue(render.contains("if (row.id in plan.changedIds) bindTranscriptRow(holder, row)"))
    val bind = source.substringAfter("private fun bindTranscriptRow(").substringBefore("private fun markdownSpans(")
    assertTrue(bind.contains("OverlayMarkdown.parse(row.text)"))
    assertTrue(bind.contains("holder.body.text = markdownSpans(document)"))
    assertTrue(bind.contains("holder.body.setTextIfChanged(row.text)"))
    assertTrue(render.contains("transcriptColumn.indexOfChild(holder.root) != index"))
    assertFalse(render.contains("overlaySingleLine"))
    assertFalse(render.contains("data.running"))
    val create = source.substringAfter("private fun createTranscriptRow()").substringBefore("private fun captureTranscriptScroll()")
    assertTrue(create.contains("setSingleLine(false)"))
    // The invariant is about message bodies, not chrome: body/argument/result text must never be
    // capped or ellipsized. A tool header line may be one line, so the check is scoped to the
    // literal body factory instead of the whole holder (which also builds the header row).
    val bodyFactory = create.substringAfter("fun literalBody(").substringBefore("fun bodyParams()")
    assertFalse(bodyFactory.contains("maxLines"))
    assertFalse(bodyFactory.contains("ellipsize"))
    // Tool detail must start collapsed so one long run cannot bury the conversation.
    assertTrue(create.contains("visibility = View.GONE"))
    assertTrue(create.contains("val detail = LinearLayout(context)"))
    assertTrue(bind.contains("UiText.t(context, \"你\", \"You\")"))
    assertTrue(bind.contains("UiText.t(context, \"助手\", \"Assistant\")"))
  }

  @Test fun scrollingRestoresStableAnchorOnceAndCancelsWhenTheUserTouchesOrViewDetaches() {
    val source = source("OverlayCardView.kt")
    val scroll = source.substringAfter("private fun scheduleTranscriptScroll()").substringBefore("/** 工具行增量")
    assertTrue(scroll.contains("ViewTreeObserver.OnPreDrawListener"))
    assertTrue(scroll.contains("saved.interaction == scrollInteraction"))
    assertTrue(scroll.contains("transcriptHolders[it]?.root"))
    assertTrue(scroll.contains("anchor.top - saved.offset"))
    assertTrue(scroll.contains("scrollView.scrollTo(0, target.coerceAtLeast(0))"))
    assertFalse(scroll.contains("smoothScroll"))
    assertTrue(scroll.contains("removeOnPreDrawListener(callback)"))
    val detach = source.substringAfter("override fun onViewDetachedFromWindow(v: View)").substringBefore("    })")
    assertTrue(detach.contains("cancelTranscriptScroll()"))
    assertTrue(detach.contains("view.alpha = 1f"))
    assertTrue(detach.contains("view.translationY = 0f"))
  }

  @Test fun transcriptParticipatesInNaturalHeightAndRemainsAnIndependentScrollingSection() {
    val source = source("OverlayCardView.kt")
    assertTrue(source.contains("if (transcriptColumn.visibility != View.GONE) total += childHeightWithMargins(transcriptColumn, width)"))
    val body = source.substringAfter("private val scrollBody").substringBefore("private val scrollView")
    assertTrue(body.contains("addView(transcriptColumn,"))
    assertTrue(body.contains("addView(pendingColumn,"))
    val render = source.substringAfter("fun render(data: OverlayCardData)").substringBefore("private fun TextView.setTextIfChanged")
    assertTrue(render.contains("renderTranscript(data.transcript)"))
    assertFalse(render.contains("if (data.running) renderTranscript"))
  }

  @Test fun controlledNegativeRejectsClearingTheTranscriptOnEveryStreamUpdate() {
    val render = source("OverlayCardView.kt").substringAfter("private fun renderTranscript(").substringBefore("private fun bindTranscriptRow(")
    val mutated = render.replace("    val plan =", "    transcriptColumn.removeAllViews()\n    val plan =")
    assertNotEquals(render, mutated)
    var rejected = false
    try { assertRendererContract(mutated) } catch (_: AssertionError) { rejected = true }
    assertTrue("相同id流更新不能通过清空重建冒充增量", rejected)
  }

  @Test fun genuineToolCallUpdatesInPlaceWithoutBecomingAssistantText() {
    val called = OverlayTranscriptRow("call-1", "tool", "", "read", "{\"path\":\"notes.md\"}", state = OverlayToolRowState.RUNNING)
    val completed = called.copy(result = "# literal tool result\n<script>not executed</script>", state = OverlayToolRowState.DONE)
    val plan = overlayTranscriptMergePlan(listOf(called), listOf(completed))
    assertEquals(setOf("call-1"), plan.changedIds)
    assertTrue(plan.removedIds.isEmpty())
    assertEquals("", plan.rows.single().text)
    assertEquals("tool", plan.rows.single().role)
    val renderer = source("OverlayCardView.kt")
    val bind = renderer.substringAfter("private fun bindTranscriptRow(").substringBefore("private fun markdownSpans(")
    assertTrue(bind.contains("if (row.role == \"assistant\")"))
    assertTrue(bind.contains("holder.arguments.setTextIfChanged(if (tool) row.arguments else \"\")"))
    assertTrue(bind.contains("row.result.ifEmpty"))
    assertTrue(bind.contains("holder.boundary.visibility = if (row.truncated || markdownTruncated)"))
    assertFalse(bind.contains("OverlayMarkdown.parse(row.result)"))
    assertFalse(bind.contains("OverlayMarkdown.parse(row.arguments)"))
  }

  @Test fun toolStatusIsTextualAndHeaderHasNoRemovedButtonViewsOrHotspots() {
    val renderer = source("OverlayCardView.kt")
    for (removed in listOf("overlay-card-close", "overlay-card-hide", "overlay-card-entry-style", "hideButton", "styleButton", "closeButton")) {
      assertFalse("Removed action must not survive as view/hit region: " + removed, renderer.contains(removed))
    }
    val header = renderer.substringAfter("private val headerRow").substringBefore("private val thinkingLine")
    assertFalse(header.contains("setOnClickListener"))
    assertFalse(header.contains("MIN_TOUCH_TARGET_DP"))
    assertTrue(renderer.contains("UiText.t(context, \"进行中\", \"Running\")"))
    assertTrue(renderer.contains("UiText.t(context, \"已完成\", \"Done\")"))
    assertTrue(renderer.contains("UiText.t(context, \"失败\", \"Failed\")"))
  }

  @Test fun nativeRenderingHasNoHtmlNetworkOrExecutableLinkPipeline() {
    val renderer = source("OverlayCardView.kt")
    val parser = source("OverlayMarkdown.kt")
    for (forbidden in listOf("Html.fromHtml", "WebView(", "URLSpan(", "ClickableSpan(", "setMovementMethod(", "startActivity(", "ImageSpan(")) {
      assertFalse(forbidden, renderer.contains(forbidden) || parser.contains(forbidden))
    }
    assertTrue(renderer.contains("linksClickable = false"))
    assertTrue(renderer.contains("autoLinkMask = 0"))
  }

  @Test fun cardMorphOnlyClipsAndDrawsWithoutRemeasuringHistoryOrResizingWindows() {
    val renderer = source("OverlayCardView.kt")
    val morph = renderer.substringAfter("fun applyMorph(").substringBefore("fun resetMorph()")
    for (forbidden in listOf("requestLayout(", ".measure(", "layoutParams", "updateViewLayout", "removeView", "renderTranscript(")) assertFalse(forbidden, morph.contains(forbidden))
    assertTrue(morph.contains("progress.isFinite()"))
    assertTrue(morph.contains("view.invalidateOutline()"))
    assertTrue(morph.contains("val textAlpha = overlayCardMorphTextAlpha(morphProgress)"))
    assertTrue(morph.contains("val historyAlpha = textAlpha.historyAlpha"))
    assertTrue(morph.contains("morphCapsuleAlpha = textAlpha.capsuleAlpha"))
    assertTrue(morph.contains("scrollView.alpha = historyAlpha"))
    assertFalse(morph.contains("val historyAlpha = 1f - morphProgress"))
    assertTrue(renderer.contains("clipToOutline = true"))
    assertTrue(renderer.contains("foreground = capsuleOutput"))
    val detach = renderer.substringAfter("override fun onViewDetachedFromWindow(v: View)").substringBefore("    })")
    assertTrue(detach.contains("resetMorph()"))
  }

  @Test fun collapsedToolRowSummarisesOneLineAndNeverDumpsWholeArguments() {
    val row = OverlayTranscriptRow(
      "tool-1", "tool", "",
      toolName = "Write",
      arguments = "{\"path\":\"/data/data/com.dsharnessmobile.shell/files/home/demo-report.md\",\"content\":\"# Demo Report\\n- a\\n- b\"}",
      result = "ok", state = OverlayToolRowState.DONE,
    )
    val hint = OverlayToolSummary.hint(row.arguments)
    assertTrue("Hint must name the target path", hint.contains("demo-report.md"))
    assertTrue("Hint shows a path tail, not the whole app-private path", !hint.contains("/data/data/"))
    assertEquals("home/demo-report.md", hint)
    assertFalse("Hint must not inline the whole body", hint.contains("# Demo Report"))
    assertFalse("Hint never keeps raw JSON braces", hint.contains("{"))
    assertTrue("Hint is bounded for one line", hint.length <= OverlayToolSummary.MAX_SUMMARY_CHARS)
    // Unknown shapes degrade to a bounded literal head, never to an empty unscoped row.
    assertTrue(OverlayToolSummary.hint("{\"unknown\":\" value\"}").isNotEmpty())
    assertEquals("", OverlayToolSummary.hint("   "))
  }

  @Test fun toolRowsStartCollapsedAndOnlyTapExpandsTheirDetail() {
    val source = source("OverlayCardView.kt")
    val create = source.substringAfter("private fun createTranscriptRow()").substringBefore("private fun captureTranscriptScroll()")
    assertTrue("Detail container must exist", create.contains("val detail = LinearLayout(context)"))
    assertTrue("Detail starts hidden", create.contains("visibility = View.GONE"))
    val bind = source.substringAfter("private fun bindTranscriptRow(").substringBefore("private fun markdownSpans(")
    assertTrue(bind.contains("holder.detail.visibility = if (tool && holder.expanded) View.VISIBLE else View.GONE"))
    assertTrue("Tap toggles the row", bind.contains("holder.expanded = !holder.expanded"))
    assertTrue("Chevron communicates the affordance", bind.contains("\"\\u25BE \"") && bind.contains("\"\\u25B8 \""))
    assertTrue("Collapsed line carries a summary hint", bind.contains("OverlayToolSummary.hint(row.arguments)"))
    assertTrue("Non-tool rows are not clickable", bind.contains("holder.root.setOnClickListener(null)"))
  }

  private fun assertRendererContract(render: String) {
    assertTrue(render.contains("transcriptHolders.getOrPut(row.id)"))
    assertFalse(render.contains("removeAllViews"))
    assertFalse(render.contains("ValueAnimator"))
    assertFalse(render.contains("animate()"))
  }
}
