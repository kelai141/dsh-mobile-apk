package com.dsharnessmobile.shell;

import android.os.ParcelFileDescriptor;
import java.io.EOFException;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream;

/** Streaming XZ reader for verified Linux archives on Android. */
final class LinuxXzInputStream extends InputStream {
    private static final int BUFFER_BYTES = 64 * 1024;

    private static final class Library {
        static final boolean AVAILABLE = available();

        private static boolean available() {
            try {
                System.loadLibrary("dsh_linux_xz");
                return true;
            } catch (UnsatisfiedLinkError unavailable) {
                return false;
            }
        }
    }

    /** The Java decoder retains compatibility with archives needing a larger native dictionary. */
    private static final class MemoryLimitException extends IOException {
        MemoryLimitException(String message) { super(message); }
    }

    private final FileInputStream source;
    private final long startPosition;
    private final ByteBuffer buffer = ByteBuffer.allocateDirect(BUFFER_BYTES);
    private long nativeState;
    private long delivered;
    private InputStream fallback;
    private boolean closed;
    private boolean eof;

    static InputStream open(InputStream source) throws IOException {
        if (!(source instanceof FileInputStream) || !"Dalvik".equals(System.getProperty("java.vm.name")) || !Library.AVAILABLE) {
            return new XZCompressorInputStream(source);
        }
        return new LinuxXzInputStream((FileInputStream) source);
    }

    private LinuxXzInputStream(FileInputStream source) throws IOException {
        this.source = source;
        startPosition = source.getChannel().position();
        buffer.limit(0);
        try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.dup(source.getFD())) {
            openNative(descriptor.getFd());
        }
    }

    private native void openNative(int descriptor) throws IOException;
    private native int fillNative(ByteBuffer buffer) throws IOException;
    private native void closeNative() throws IOException;

    private void resumeWithJavaDecoder() throws IOException {
        closeNative();
        source.getChannel().position(startPosition);
        fallback = new XZCompressorInputStream(source);
        long remaining = delivered;
        while (remaining > 0) {
            long skipped = fallback.skip(remaining);
            if (skipped > 0) {
                remaining -= skipped;
            } else if (fallback.read() >= 0) {
                remaining--;
            } else {
                throw new EOFException("XZ stream ended while restoring the decoder position");
            }
        }
    }

    private void fill() throws IOException {
        if (closed) throw new IOException("XZ stream is closed");
        if (fallback != null || buffer.hasRemaining() || eof) return;
        try {
            int count = fillNative(buffer);
            buffer.position(0);
            buffer.limit(count);
            eof = count == 0;
        } catch (MemoryLimitException limit) {
            resumeWithJavaDecoder();
        }
    }

    @Override public synchronized int read() throws IOException {
        fill();
        if (fallback != null) return fallback.read();
        if (eof) return -1;
        delivered++;
        return buffer.get() & 0xff;
    }

    @Override public synchronized int read(byte[] output, int offset, int length) throws IOException {
        if (offset < 0 || length < 0 || offset > output.length - length) {
            throw new IndexOutOfBoundsException();
        }
        if (length == 0) return 0;
        fill();
        if (fallback != null) return fallback.read(output, offset, length);
        if (eof) return -1;
        int count = Math.min(length, buffer.remaining());
        buffer.get(output, offset, count);
        delivered += count;
        return count;
    }

    @Override public synchronized void close() throws IOException {
        if (closed) return;
        closed = true;
        try {
            if (nativeState != 0) closeNative();
        } finally {
            if (fallback != null) fallback.close();
            else source.close();
        }
    }
}
