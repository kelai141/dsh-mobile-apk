use liblzma::{
    bufread::XzDecoder,
    stream::{Check, MtStreamBuilder, Stream, TELL_UNSUPPORTED_CHECK},
};
use std::io::{self, BufRead};

const DECODER_MEMORY_LIMIT: u64 = 64 * 1024 * 1024;
const THREADING_MEMORY_LIMIT: u64 = 48 * 1024 * 1024;

fn sized_crc64_blocks(header: &[u8]) -> bool {
    // An XZ block can be decoded in parallel only if its header advertises both sizes.
    // Select only a supported stream check. liblzma validates the header CRC and all blocks.
    header.starts_with(b"\xfd7zXZ\0\0\x04")
        && header.len() >= 14
        && header[12] != 0
        && header[13] & 0xc0 == 0xc0
        && Check::Crc64.is_supported()
}

fn decoder<R: BufRead>(mut reader: R) -> io::Result<XzDecoder<R>> {
    let stream = if sized_crc64_blocks(reader.fill_buf()?) {
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(4) as u32);
        MtStreamBuilder::new()
            .threads(threads)
            .memlimit_threading(THREADING_MEMORY_LIMIT)
            .memlimit_stop(DECODER_MEMORY_LIMIT)
            .decoder()?
    } else {
        Stream::new_stream_decoder(DECODER_MEMORY_LIMIT, TELL_UNSUPPORTED_CHECK)?
    };
    Ok(XzDecoder::new_stream(reader, stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use liblzma::write::XzEncoder;
    use std::io::{Read, Write};

    #[test]
    fn single_and_sized_blocks_decode_identically() {
        let source: Vec<u8> = (0..400_000).map(|n| ((n * 17) ^ (n / 64)) as u8).collect();
        let streams = [
            Stream::new_easy_encoder(1, Check::Crc64).unwrap(),
            MtStreamBuilder::new()
                .threads(2)
                .block_size(64 * 1024)
                .check(Check::Crc64)
                .encoder()
                .unwrap(),
        ];
        for (i, stream) in streams.into_iter().enumerate() {
            let mut out = XzEncoder::new_stream(Vec::new(), stream);
            out.write_all(&source).unwrap();
            let bytes = out.finish().unwrap();
            assert_eq!(sized_crc64_blocks(&bytes), i == 1);
            let mut decoded = Vec::new();
            decoder(bytes.as_slice())
                .unwrap()
                .read_to_end(&mut decoded)
                .unwrap();
            assert_eq!(decoded, source);
        }
    }

    #[test]
    fn unsupported_check_or_unsized_header_uses_the_existing_decoder() {
        let mut header = *b"\xfd7zXZ\0\0\x04\xe6\xd6\xb4\x46\x04\xc0";
        assert!(sized_crc64_blocks(&header));
        for id in [0, 1, 2, 10, 15] {
            header[7] = id;
            assert!(!sized_crc64_blocks(&header));
        }
        header[7] = 4;
        header[13] = 0x40;
        assert!(!sized_crc64_blocks(&header));
        assert!(!sized_crc64_blocks(&header[..9]));
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::decoder;
    use jni::objects::{JByteBuffer, JObject};
    use jni::sys::jint;
    use jni::JNIEnv;
    use liblzma::bufread::XzDecoder;
    use std::fs::File;
    use std::io::{self, BufReader, Read};
    use std::os::fd::FromRawFd;

    type Reader = XzDecoder<BufReader<File>>;

    #[no_mangle]
    pub extern "system" fn Java_com_dsharnessmobile_shell_LinuxXzInputStream_openNative(
        mut env: JNIEnv,
        owner: JObject,
        fd: jint,
    ) {
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            // The caller keeps its descriptor open until this independent ownership is established.
            let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if copy < 0 {
                return Err(io::Error::last_os_error().into());
            }
            let file = unsafe { File::from_raw_fd(copy) };
            let reader = decoder(BufReader::with_capacity(64 * 1024, file))?;
            // The private long field belongs to this object and is accessed only by synchronized methods.
            unsafe {
                env.set_rust_field(&owner, "nativeState", reader)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = env.throw_new("java/io/IOException", error.to_string());
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_dsharnessmobile_shell_LinuxXzInputStream_fillNative(
        mut env: JNIEnv,
        owner: JObject,
        target: JByteBuffer,
    ) -> jint {
        let result = (|| -> Result<usize, Box<dyn std::error::Error>> {
            let capacity = env.get_direct_buffer_capacity(&target)?;
            let address = env.get_direct_buffer_address(&target)?;
            // This private, writable direct buffer is live for the entire call. The owning
            // InputStream serializes fills, reads and close, and never exposes the buffer.
            let buffer = unsafe { std::slice::from_raw_parts_mut(address, capacity) };
            let mut reader = unsafe { env.get_rust_field::<_, _, Reader>(&owner, "nativeState")? };
            Ok(reader.read(buffer)?)
        })();
        match result {
            Ok(count) => count as jint,
            Err(error) => {
                let limited = error
                    .downcast_ref::<io::Error>()
                    .and_then(io::Error::get_ref)
                    .and_then(|cause| cause.downcast_ref::<liblzma::stream::Error>())
                    .is_some_and(|cause| matches!(cause, liblzma::stream::Error::MemLimit));
                let class = if limited {
                    "com/dsharnessmobile/shell/LinuxXzInputStream$MemoryLimitException"
                } else {
                    "java/io/IOException"
                };
                let _ = env.throw_new(class, error.to_string());
                -1
            }
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_dsharnessmobile_shell_LinuxXzInputStream_closeNative(
        mut env: JNIEnv,
        owner: JObject,
    ) {
        // The Java owner calls close once while holding its monitor.
        let result = unsafe { env.take_rust_field::<_, _, Reader>(&owner, "nativeState") };
        if let Err(error) = result {
            let _ = env.throw_new("java/io/IOException", error.to_string());
        }
    }
}
