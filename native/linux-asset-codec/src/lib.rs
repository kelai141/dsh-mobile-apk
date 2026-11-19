use liblzma::{
    bufread::XzDecoder,
    stream::{Stream, TELL_UNSUPPORTED_CHECK},
};
use std::io::{self, BufRead};

const DECODER_MEMORY_LIMIT: u64 = 64 * 1024 * 1024;

fn decoder<R: BufRead>(reader: R) -> io::Result<XzDecoder<R>> {
    let stream = Stream::new_stream_decoder(DECODER_MEMORY_LIMIT, TELL_UNSUPPORTED_CHECK)?;
    Ok(XzDecoder::new_stream(reader, stream))
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
