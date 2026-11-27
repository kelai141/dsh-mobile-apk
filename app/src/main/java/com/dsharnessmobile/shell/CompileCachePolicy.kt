package com.dsharnessmobile.shell

import java.io.File

/**
 * Snapshot-generational lifecycle and self-healing policy for `NODE_COMPILE_CACHE`.
 *
 * Separating engine V8 compile cache directories per snapshot fingerprint prevents stale
 * bytecode blobs from accumulating across APK/runtime upgrades and avoids mtime-based LRU
 * eviction discarding active core modules in favor of one-off console/tool entries.
 */
internal object CompileCachePolicy {

  const val ROOT_DIR_NAME = ".node-compile-cache"
  const val GENERATION_PREFIX = "snap-"
  const val FINGERPRINT_PREFIX_LEN = 12

  private val FINGERPRINT_HEX = Regex("^[0-9a-f]{64}$")

  /** Returns the generation subdirectory name for a valid 64-hex snapshot fingerprint, or null. */
  fun generationDirName(fingerprint: String?): String? {
    val fp = fingerprint?.trim()?.lowercase(java.util.Locale.ROOT) ?: return null
    if (!FINGERPRINT_HEX.matches(fp)) return null
    return GENERATION_PREFIX + fp.substring(0, FINGERPRINT_PREFIX_LEN)
  }

  /** Resolves the main engine's `NODE_COMPILE_CACHE` directory under [dshHome]. */
  fun resolveEngineCacheDir(dshHome: File, fingerprint: String?): File {
    val root = File(dshHome, ROOT_DIR_NAME)
    val genName = generationDirName(fingerprint) ?: return root
    return File(root, genName)
  }

  /**
   * Removes stale `snap-*` generations and legacy un-scoped top-level cache entries under
   * [cacheRoot] while preserving [activeGenerationName] and never following symlinks.
   */
  fun pruneStaleGenerations(cacheRoot: File, activeGenerationName: String?): Int {
    if (activeGenerationName == null) return 0
    if (!cacheRoot.isDirectory || SnapshotFs.isSymbolicLink(cacheRoot)) return 0
    val children = cacheRoot.listFiles() ?: return 0
    var removed = 0
    for (child in children) {
      if (SnapshotFs.isSymbolicLink(child)) continue
      if (child.name == activeGenerationName) continue
      SnapshotFs.deletePath(child)
      if (!SnapshotFs.exists(child)) removed += 1
    }
    return removed
  }

  /**
   * Clears [cacheDir] contents without following symlinks and recreates the empty directory.
   * Returns true if at least one child entry was removed (or the directory itself was cleared).
   */
  fun clearGeneration(cacheDir: File): Boolean {
    if (SnapshotFs.isSymbolicLink(cacheDir)) return false
    if (!cacheDir.exists()) return false
    if (!cacheDir.isDirectory) {
      SnapshotFs.deletePath(cacheDir)
      return !SnapshotFs.exists(cacheDir)
    }
    val hadChildren = (cacheDir.listFiles()?.isNotEmpty()) == true
    val children = cacheDir.listFiles() ?: emptyArray()
    var removedAny = false
    for (child in children) {
      if (SnapshotFs.isSymbolicLink(child)) continue
      SnapshotFs.deletePath(child)
      if (!SnapshotFs.exists(child)) removedAny = true
    }
    if (!cacheDir.exists()) cacheDir.mkdirs()
    return removedAny || !hadChildren
  }

  /**
   * Self-healing fuse: after the first failed startup attempt in a session, purge the active
   * compile cache once before retrying so corrupted V8 bytecode can never brick startup.
   */
  fun shouldPurgeOnRetry(retryCount: Int, alreadyPurgedThisSession: Boolean): Boolean =
    retryCount >= 1 && !alreadyPurgedThisSession
}
