package com.dsharnessmobile.shell.nativecontrol

/** JNI 使用固定构造签名 (String, byte[])；元数据与 JPEG 均由 Rust 产生。 */
internal class NativeImageResult(val metadata: String, val jpeg: ByteArray?)
