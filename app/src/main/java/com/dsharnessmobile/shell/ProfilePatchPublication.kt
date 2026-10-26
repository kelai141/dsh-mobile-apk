package com.dsharnessmobile.shell

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files

/** Publishes a normalized profile only after a unique, durable rollback copy exists. */
internal object ProfilePatchPublication {
  fun normalize(
    target: File,
    original: String,
    normalized: String,
    publish: (File, File) -> Boolean = AtomicFileReplace::publish,
  ): File {
    require(FactoryProfilePatch.verifyNormalization(original, normalized) == null) {
      "profile normalization failed validation"
    }
    val backup = Files.createTempFile(
      target.absoluteFile.parentFile.toPath(),
      target.name + ".pre-" + BuildConfig.VERSION_NAME + "-",
      ".bak",
    ).toFile()
    FileOutputStream(backup).use { output ->
      output.write(original.toByteArray(Charsets.UTF_8))
      output.flush()
      output.fd.sync()
    }
    SnapshotTransaction.writeTextAtomic(target, normalized, "Profile normalization", publish) { candidate ->
      require(FactoryProfilePatch.verifyNormalization(original, candidate) == null) {
        "profile normalization failed validation"
      }
    }
    return backup
  }
}
