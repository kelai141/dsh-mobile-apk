package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** Deterministic fake-inode tests for external testers. No Android/root/device execution required. */
class OwnershipRepairCoreTest {
  private val uid = 110_123
  private val anchor = "/data/user/1/com.dsharnessmobile.shell"
  private class Clock(var now: Long = 0) : OwnershipRepairCore.NanoClock {
    override fun nanoTime(): Long = now
  }
  private class Node(
    val inode: Long,
    val kind: OwnershipRepairCore.Kind = OwnershipRepairCore.Kind.REGULAR,
    var owner: Int = 0,
    var group: Int = 0,
    var links: Long = 1,
    var device: Long = 7,
    val symlink: Boolean = false,
  ) {
    val children = linkedMapOf<String, Node>()
    var statCalls = 0
    var failStatAt = -1
    var failChown = false
    var ignoreChown = false
    var failListing = false
    var failIteration = false
    var generatedWidth = 0
  }
  private class Fake(val root: Node) : OwnershipRepairCore.Backend {
    var liveHandles = 0
    var maxLiveHandles = 0
    var liveListings = 0
    var maxLiveListings = 0
    var opens = 0
    var namesRead = 0
    val mutations = mutableListOf<Long>()
    var afterOpen: ((Node, String, Node) -> Unit)? = null
    var afterStat: ((Node) -> Unit)? = null
    var afterChown: ((Node) -> Unit)? = null
    var failAnchor: Exception? = null

    private inner class Held(val node: Node) : OwnershipRepairCore.Handle {
      private var closed = false
      init { liveHandles++; maxLiveHandles = maxOf(maxLiveHandles, liveHandles) }
      override fun close() {
        check(!closed) { "double-close" }
        closed = true
        liveHandles--
      }
    }
    private fun node(handle: OwnershipRepairCore.Handle): Node = (handle as Held).node
    override fun openAnchor(dataDir: String): OwnershipRepairCore.Handle {
      opens++
      failAnchor?.let { throw it }
      return Held(root)
    }
    override fun openChild(
      directory: OwnershipRepairCore.Handle,
      name: String,
      directoryOnly: Boolean,
    ): OwnershipRepairCore.OpenResult {
      check(OwnershipRepairCore.isValidName(name))
      val parent = node(directory)
      val child = parent.children[name] ?: if (parent.generatedWidth > 0)
        Node(1000L + name.removePrefix("entry-").toInt()) else throw IOException("missing")
      opens++
      if (child.symlink) return OwnershipRepairCore.OpenResult.Symlink
      if (directoryOnly && child.kind != OwnershipRepairCore.Kind.DIRECTORY) throw IOException("not-directory")
      val held = Held(child)
      afterOpen?.invoke(parent, name, child)
      return OwnershipRepairCore.OpenResult.Opened(held)
    }
    override fun stat(handle: OwnershipRepairCore.Handle): OwnershipRepairCore.Stat {
      val node = node(handle)
      node.statCalls++
      if (node.statCalls == node.failStatAt) throw IOException("stat")
      val result = OwnershipRepairCore.Stat(node.device, node.inode, node.kind, node.owner, node.group, node.links)
      afterStat?.invoke(node)
      return result
    }
    override fun chown(handle: OwnershipRepairCore.Handle, uid: Int, gid: Int) {
      val node = node(handle)
      if (node.failChown) throw IOException("chown")
      mutations.add(node.inode)
      if (!node.ignoreChown) { node.owner = uid; node.group = gid }
      afterChown?.invoke(node)
    }
    override fun list(directory: OwnershipRepairCore.Handle): OwnershipRepairCore.Listing {
      val node = node(directory)
      if (node.failListing) throw IOException("listing")
      val fixed = node.children.keys.iterator()
      var index = 0
      liveListings++
      maxLiveListings = maxOf(maxLiveListings, liveListings)
      return object : OwnershipRepairCore.Listing {
        private var closed = false
        override fun hasNext(): Boolean {
          if (node.failIteration) throw IOException("iteration")
          return if (node.generatedWidth > 0) index < node.generatedWidth else fixed.hasNext()
        }
        override fun nextName(): String {
          namesRead++
          return if (node.generatedWidth > 0) "entry-" + index++ else fixed.next()
        }
        override fun close() { check(!closed); closed = true; liveListings-- }
      }
    }
  }

  private fun directory(inode: Long, owner: Int = uid, group: Int = owner): Node =
    Node(inode, OwnershipRepairCore.Kind.DIRECTORY, owner, group, links = 2)

  private fun repair(fake: Fake, target: String = "", cap: Int = 100, clock: Clock = Clock(), depth: Int = 64): OwnershipRepairCore.Result =
    OwnershipRepairCore(fake, clock).repair(OwnershipRepairCore.Request(anchor, target, uid, cap, 10, depth))

  /** 诊断回归：锚点打开失败必须带出底层消息，否则设备上只剩一句无从下手的话。 */
  @Test fun anchorOpenFailureCarriesTheUnderlyingErrno() {
    val fake = Fake(Node(1L, OwnershipRepairCore.Kind.DIRECTORY))
    fake.failAnchor = IOException("errno=EACCES")
    val result = repair(fake, target = "home")
    assertFalse(result.ok)
    assertEquals(1, result.failures)
    assertEquals("anchor-open-failed:errno=EACCES", result.errors.first())
  }

  /** 没有底层消息时退回裸码，避免拼出以冒号结尾的空诊断。 */
  @Test fun anchorOpenFailureWithoutMessageStaysBare() {
    val fake = Fake(Node(1L, OwnershipRepairCore.Kind.DIRECTORY))
    fake.failAnchor = IOException()
    val result = repair(fake, target = "home")
    assertEquals("anchor-open-failed", result.errors.first())
  }

  private fun assertClosed(fake: Fake) {
    assertEquals("all handles must close", 0, fake.liveHandles)
    assertEquals("all lazy listings must close", 0, fake.liveListings)
  }

  @Test fun capStopsBeforeOpeningOrMutatingTheNextEntryOfAHugeDirectory() {
    val root = directory(1).also { it.generatedWidth = 1_000_000 }
    val fake = Fake(root)
    val result = repair(fake, cap = 2)
    assertFalse(result.ok)
    assertTrue(result.entryCapReached)
    assertTrue(result.truncated)
    assertEquals(2, result.checked)
    assertEquals(1, result.healed)
    assertEquals(1, result.mutations)
    assertEquals(1, fake.namesRead)
    assertEquals(2, fake.opens)
    assertTrue(fake.maxLiveHandles <= 2)
    assertTrue(fake.maxLiveListings <= 1)
    assertClosed(fake)
  }

  @Test fun exactCapDoesNotFalselyTruncateAnExhaustedTree() {
    val root = directory(1).also { it.children["only"] = Node(2) }
    val fake = Fake(root)
    val result = repair(fake, cap = 2)
    assertTrue(result.ok)
    assertFalse(result.truncated)
    assertEquals(2, result.checked)
    assertEquals(1, result.healed)
    assertClosed(fake)
  }

  @Test fun symlinkLeafIsCountedButNeverOpenedOrTraversed() {
    val external = Node(999)
    val link = Node(2, symlink = true).also { it.children["outside"] = external }
    val fake = Fake(directory(1).also { it.children["link"] = link })
    val result = repair(fake)
    assertTrue(result.ok)
    assertEquals(2, result.checked)
    assertEquals(1, result.symlinksSkipped)
    assertEquals(0, result.mutations)
    assertEquals(0, external.owner)
    assertClosed(fake)
  }

  @Test fun symlinkAncestorCannotMakeAnUnvisitedSubpathSuccessful() {
    val fake = Fake(directory(1).also { it.children["link"] = Node(2, symlink = true) })
    val result = repair(fake, "link/leaf")
    assertFalse(result.ok)
    assertEquals(1, result.symlinksSkipped)
    assertEquals(1, result.failures)
    assertEquals(0, result.checked)
    assertClosed(fake)
  }

  @Test fun explicitlyRequestedSymlinkIsSkippedButNotReportedAsRepaired() {
    val fake = Fake(directory(1).also { it.children["link"] = Node(2, symlink = true) })
    val result = repair(fake, "link")
    assertFalse(result.ok)
    assertEquals(1, result.checked)
    assertEquals(1, result.symlinksSkipped)
    assertEquals("symlink-target", result.reason)
    assertEquals(0, result.mutations)
    assertClosed(fake)
  }

  @Test fun renamedAncestorUsesTheHeldDirectoryAndCannotRedirectChown() {
    val original = Node(3)
    val external = Node(999)
    val parent = directory(2).also { it.children["leaf"] = original }
    val root = directory(1).also { it.children["parent"] = parent }
    val fake = Fake(root)
    fake.afterOpen = { dir, name, _ ->
      if (dir === root && name == "parent") root.children["parent"] =
        Node(99, symlink = true).also { it.children["leaf"] = external }
    }
    val result = repair(fake, "parent/leaf")
    assertTrue(result.ok)
    assertEquals(uid, original.owner)
    assertEquals(0, external.owner)
    assertEquals(listOf(3L), fake.mutations)
    assertEquals(2, result.ancestorsChecked)
    assertClosed(fake)
  }

  @Test fun rootOwnedRegularHardlinkIsRejectedBeforeMutation() {
    val linked = Node(2, links = 2)
    val fake = Fake(directory(1).also { it.children["linked"] = linked })
    val result = repair(fake)
    assertFalse(result.ok)
    assertEquals(1, result.hardlinksRejected)
    assertEquals(1, result.failures)
    assertEquals(0, result.mutations)
    assertEquals(0, linked.owner)
    assertClosed(fake)
  }

  @Test fun linkCountIsRecheckedImmediatelyBeforeMutation() {
    val leaf = Node(2)
    val fake = Fake(directory(1).also { it.children["leaf"] = leaf })
    fake.afterStat = { node -> if (node === leaf && node.statCalls == 1) node.links = 2 }
    val result = repair(fake)
    assertFalse(result.ok)
    assertEquals(1, result.hardlinksRejected)
    assertEquals(0, result.mutations)
    assertClosed(fake)
  }

  @Test fun lateLinkAfterChownIsAnUnverifiedFailureNotAHealing() {
    val leaf = Node(2)
    val fake = Fake(directory(1).also { it.children["leaf"] = leaf })
    fake.afterChown = { node -> node.links = 2 }
    val result = repair(fake)
    assertFalse(result.ok)
    assertEquals(1, result.mutations)
    assertEquals(0, result.healed)
    assertEquals(1, result.unverifiedMutations)
    assertEquals(1, result.failures)
    assertClosed(fake)
  }

  @Test fun alreadyAppOwnedHardlinkAndRootGroupDoNotTriggerMutation() {
    val owned = Node(2, owner = uid, group = uid, links = 2)
    val rootGroup = Node(3, owner = uid, group = 0)
    val fake = Fake(directory(1).also { it.children["owned"] = owned; it.children["root-group"] = rootGroup })
    val result = repair(fake)
    assertTrue(result.ok)
    assertEquals(0, result.hardlinksRejected)
    // An app-owned inode is not evidence of root origin merely because its gid is zero.
    assertEquals(0, result.healed)
    assertEquals(0, rootGroup.group)
    assertTrue(fake.mutations.isEmpty())
    assertClosed(fake)
  }

  @Test fun unknownListingStatChownAndVerificationNeverBecomeSuccess() {
    for (failure in 0..4) {
      val leaf = Node(2)
      val root = directory(1).also { it.children["leaf"] = leaf }
      when (failure) {
        0 -> root.failListing = true
        1 -> root.failIteration = true
        2 -> leaf.failStatAt = 1
        3 -> leaf.failChown = true
        4 -> leaf.ignoreChown = true
      }
      val fake = Fake(root)
      val result = repair(fake)
      assertFalse("failure mode " + failure, result.ok)
      assertEquals(1, result.failures)
      assertEquals(0, result.healed)
      if (failure == 4) assertEquals(1, result.unverifiedMutations)
      assertClosed(fake)
    }
  }

  @Test fun failedPostChownStatIsNotCountedAsHealed() {
    val leaf = Node(2).also { it.failStatAt = 3 }
    val fake = Fake(directory(1).also { it.children["leaf"] = leaf })
    val result = repair(fake)
    assertFalse(result.ok)
    assertEquals(1, result.mutations)
    assertEquals(1, result.unverifiedMutations)
    assertEquals(0, result.healed)
    assertClosed(fake)
  }

  @Test fun deadlineBeforeMutationStopsWithoutChownAndClosesEverything() {
    val clock = Clock()
    val leaf = Node(2)
    val fake = Fake(directory(1).also { it.children["leaf"] = leaf })
    fake.afterStat = { node -> if (node === leaf && node.statCalls == 2) clock.now = 10_000_000 }
    val result = repair(fake, clock = clock)
    assertFalse(result.ok)
    assertTrue(result.deadlineExceeded)
    assertEquals(1, result.deadlineHits)
    assertEquals(0, result.mutations)
    assertClosed(fake)
  }

  @Test fun deadlineAfterChownReportsAnUnverifiedMutationNotAHealing() {
    val clock = Clock()
    val fake = Fake(directory(1).also { it.children["leaf"] = Node(2) })
    fake.afterChown = { clock.now = 10_000_000 }
    val result = repair(fake, clock = clock)
    assertFalse(result.ok)
    assertEquals(1, result.mutations)
    assertEquals(1, result.unverifiedMutations)
    assertEquals(0, result.healed)
    assertTrue(result.deadlineExceeded)
    assertClosed(fake)
  }

  @Test fun deadlineUsesWrapSafeMonotonicElapsedTime() {
    val clock = Clock(Long.MAX_VALUE - 1_000_000)
    val fake = Fake(directory(1))
    fake.afterStat = { clock.now += 11_000_000 }
    val result = repair(fake, clock = clock)
    assertFalse(result.ok)
    assertTrue(result.deadlineExceeded)
    assertClosed(fake)
  }

  @Test fun depthBoundIsAnExplicitIncompleteResultAndDoesNotFetchGrandchildren() {
    val grandchild = Node(3)
    val child = directory(2, owner = 0).also { it.children["grandchild"] = grandchild }
    val fake = Fake(directory(1).also { it.children["child"] = child })
    val result = repair(fake, depth = 1)
    assertFalse(result.ok)
    assertTrue(result.truncated)
    assertEquals(1, result.depthLimitHits)
    assertEquals(2, result.checked)
    assertEquals(1, fake.namesRead)
    assertEquals(0, grandchild.owner)
    assertClosed(fake)
  }

  @Test fun foreignOwnersAndCrossDeviceNodesAreNeverMutatedOrTraversed() {
    val foreign = directory(2, owner = 110_124).also { it.children["hidden"] = Node(4) }
    val mounted = directory(3, owner = 0).also { it.device = 8; it.children["hidden"] = Node(5) }
    val fake = Fake(directory(1).also { it.children["foreign"] = foreign; it.children["mounted"] = mounted })
    val result = repair(fake)
    assertFalse(result.ok)
    assertEquals(1, result.foreignOwners)
    assertEquals(1, result.crossDeviceSkipped)
    assertEquals(2, result.failures)
    assertEquals(3, result.checked)
    assertEquals(0, result.mutations)
    assertClosed(fake)
  }

  @Test fun unsupportedNodesAndDirectoryCyclesAreFailuresWithoutMutation() {
    val root = directory(1)
    root.children["special"] = Node(2, kind = OwnershipRepairCore.Kind.OTHER)
    root.children["cycle"] = root
    val fake = Fake(root)
    val result = repair(fake)
    assertFalse(result.ok)
    assertEquals(1, result.unsupportedNodes)
    assertEquals(1, result.cyclesRejected)
    assertEquals(2, result.failures)
    assertEquals(0, result.mutations)
    assertClosed(fake)
  }

  @Test fun invalidRequestedNamesFailBeforeAnyFilesystemAccess() {
    for (target in listOf("..", "files/../secret", "files/./leaf", "files//leaf", "files/", "/outside", "a\\b", "bad\u0000name")) {
      val fake = Fake(directory(1))
      val result = repair(fake, target)
      assertFalse(target, result.ok)
      assertEquals(0, fake.opens)
      assertEquals(0, result.checked)
      assertClosed(fake)
    }
  }

  @Test fun invalidListedNamesCountAsFailuresWithoutOpeningThem() {
    val fake = Fake(directory(1).also { it.children[".."] = Node(2) })
    val result = repair(fake)
    assertFalse(result.ok)
    assertEquals(2, result.checked)
    assertEquals(1, fake.opens)
    assertEquals(1, result.failures)
    assertClosed(fake)
  }

  @Test fun invalidBoundsAndAppIdsFailBeforeOpeningAnchor() {
    for (request in listOf(
      OwnershipRepairCore.Request(anchor, "", uid, 0, 10),
      OwnershipRepairCore.Request(anchor, "", uid, OwnershipRepairCore.MAX_ENTRIES + 1, 10),
      OwnershipRepairCore.Request(anchor, "", uid, 1, 0),
      OwnershipRepairCore.Request(anchor, "", uid, 1, OwnershipRepairCore.MAX_TIMEOUT_MS + 1),
      OwnershipRepairCore.Request(anchor, "", 100_000, 1, 10),
      OwnershipRepairCore.Request(anchor, "", uid, 1, 10, 65),
    )) {
      val fake = Fake(directory(1))
      assertFalse(OwnershipRepairCore(fake, Clock()).repair(request).ok)
      assertEquals(0, fake.opens)
    }
    assertTrue(OwnershipRepairCore.isAppUid(uid))
    assertTrue(OwnershipRepairCore.isAppUid(10_123))
    assertFalse(OwnershipRepairCore.isAppUid(2000))
  }

  @Test fun rootEntrypointAcceptsOnlyItsFixedBoundedSchemaAndFullProfileUid() {
    val good = arrayOf(uid.toString(), anchor, "files/usr", "20000", "20000")
    assertEquals(uid, RootRepairMain.parse(good)?.uid)
    assertTrue(RootRepairMain.parse(good.copyOf().also { it[2] = "" }) != null)
    assertTrue(RootRepairMain.parse(good.copyOf().also { it[2] = "/outside" }) == null)
    assertTrue(RootRepairMain.parse(good.copyOf().also { it[2] = "files/../outside" }) == null)
    assertTrue(RootRepairMain.parse(good.copyOf().also { it[1] = "/data/user/0/com.dsharnessmobile.shell" }) == null)
    assertTrue(RootRepairMain.parse(good.copyOf().also { it[1] = "/data/user/1/other.package" }) == null)
    assertTrue(RootRepairMain.parse(good.copyOf().also { it[0] = "010123" }) == null)
    assertTrue(RootRepairMain.parse(good.copyOf().also { it[3] = "200001" }) == null)
    assertTrue(RootRepairMain.parse(good.copyOf().also { it[4] = "120001" }) == null)
    assertTrue(RootRepairMain.parse(good + "ignored") == null)
  }
}
