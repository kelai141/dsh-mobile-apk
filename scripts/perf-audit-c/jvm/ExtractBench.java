import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream;

/**
 * ExtractBench — 复刻 SnapshotExtractor 的解压循环，量化 191MB xz 的真实吞吐与成本归属。
 *
 * 变体梯（每一级只加一件事，用相邻两级之差归因，而不是靠猜）：
 *   digest   = SnapshotBundledAsset.digest 的复刻（流式 SHA-256 / 64KB 缓冲 / 不解码）
 *   nullsink = xz 解码 + tar 解析，不落盘                    → 纯 CPU
 *   mkdirwrite = nullsink + mkdirs + 逐文件建流写字节        → + 目录元数据 + 写盘
 *   noperms  = mkdirwrite + deleteIfExists                   → + 覆盖保护（删除旧文件）
 *   full     = SnapshotExtractor.extractEntries 的逐行复刻
 *              （再加 resolveEntry 的 canonicalPath 校验 + 三次 setXxx）
 *                                                             → + 逐文件权限 syscall + 路径规范化
 *
 * 用法： java -cp "<cp>" ExtractBench <archive> <variant> <destDir>
 * 输出一行： variant=<v> entries=<n> regular=<n> symlink=<n> dir=<n> bytes=<n> ms=<n> mbps=<x>
 */
public final class ExtractBench {
  public static void main(String[] args) throws Exception {
    if (args.length < 3) { System.err.println("usage: <archive> <variant> <destDir>"); System.exit(2); }
    File archive = new File(args[0]);
    String variant = args[1];
    File dest = new File(args[2]);

    if (variant.equals("digest")) {
      long t0 = System.nanoTime();
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      long bytes = 0;
      try (InputStream in = new FileInputStream(archive)) {
        byte[] buf = new byte[64 * 1024];
        while (true) { int n = in.read(buf); if (n < 0) break; if (n > 0) { md.update(buf, 0, n); bytes += n; } }
      }
      long ms = (System.nanoTime() - t0) / 1_000_000L;
      StringBuilder hex = new StringBuilder(); for (byte b : md.digest()) hex.append(String.format("%02x", b));
      System.out.printf("variant=digest entries=0 regular=0 symlink=0 dir=0 bytes=%d ms=%d mbps=%.1f sha256=%s%n",
          bytes, ms, bytes / 1048576.0 / (ms / 1000.0), hex);
      return;
    }

    boolean toDisk  = !variant.equals("nullsink");
    // 每一级都必须真的能跑通，否则「差值」里混进的是异常而不是成本。
    boolean makeDir = !variant.equals("nullsink");
    boolean delOld  = variant.equals("noperms") || variant.equals("full");
    boolean permOps = variant.equals("full");
    boolean canon   = variant.equals("full");

    long entries = 0, regular = 0, symlink = 0, dirs = 0, total = 0;
    String destCanon = dest.getCanonicalPath();
    long t0 = System.nanoTime();
    try (InputStream fin = new FileInputStream(archive)) {
      XZCompressorInputStream xz = new XZCompressorInputStream(fin);
      TarArchiveInputStream tar = new TarArchiveInputStream(xz);
      TarArchiveEntry entry = tar.getNextEntry();
      while (entry != null) {
        entries++;
        if (entry.isDirectory()) dirs++;
        else if (entry.isSymbolicLink()) symlink++;
        else regular++;
        total += Math.max(0, entry.getSize());
        if (toDisk) {
          File target = canon ? resolveEntry(dest, destCanon, entry) : new File(dest, entry.getName());
          if (target == null) { entry = tar.getNextEntry(); continue; }
          if (entry.isDirectory()) {
            if (makeDir) target.mkdirs();
          } else if (entry.isSymbolicLink()) {
            if (makeDir) {
              if (target.getParentFile() != null) target.getParentFile().mkdirs();
              if (delOld) Files.deleteIfExists(target.toPath());
              try { Files.createSymbolicLink(target.toPath(), Paths.get(entry.getLinkName())); }
              catch (IOException e) { /* Windows 无建链权限：与 Android 同形地吞掉，只影响符号链接分支 */ }
            }
          } else {
            if (makeDir) {
              if (target.getParentFile() != null) target.getParentFile().mkdirs();
              if (delOld) Files.deleteIfExists(target.toPath());
            }
            try (OutputStream out = new FileOutputStream(target)) {
              byte[] buf = new byte[64 * 1024];
              int n = tar.read(buf);
              while (n >= 0) { out.write(buf, 0, n); n = tar.read(buf); }
            }
            if (permOps) {
              target.setReadable(false, false);
              target.setReadable(true, true);
              target.setWritable(true, true);
              target.setExecutable(false, true);
            }
          }
        }
        entry = tar.getNextEntry();
      }
      tar.close(); xz.close();
    }
    long ms = (System.nanoTime() - t0) / 1_000_000L;
    System.out.printf("variant=%s entries=%d regular=%d symlink=%d dir=%d bytes=%d ms=%d mbps=%.1f%n",
        variant, entries, regular, symlink, dirs, total, ms, total / 1048576.0 / (ms / 1000.0));
  }

  private static File resolveEntry(File dest, String destCanon, TarArchiveEntry entry) throws IOException {
    String name = entry.getName().replace('\\', '/');
    while (name.startsWith("/")) name = name.substring(1);
    if (name.isEmpty() || name.contains("..")) return null;
    File target = new File(dest, name);
    File parent = target.getParentFile();
    String parentCanon = parent != null ? parent.getCanonicalPath() : destCanon;
    if (parentCanon.startsWith(destCanon + File.separator) || parentCanon.equals(destCanon)) return target;
    return null;
  }
}