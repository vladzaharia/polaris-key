import com.github.luben.zstd.*; import java.nio.file.*;
public class BW { public static void main(String[] a) throws Exception {
  String B = System.getenv().getOrDefault("PACKS_DIR", "../patching/out"); // run from content/
  byte[] o = Files.readAllBytes(Path.of(B, "big_old.bin")), d = Files.readAllBytes(Path.of(B, "big.pf.zst"));
  long t = System.nanoTime();
  try (ZstdDecompressCtx c = new ZstdDecompressCtx()) { c.loadDict(o); byte[] r = c.decompress(d, 160253600);
    var md = java.security.MessageDigest.getInstance("SHA-256"); String h = java.util.HexFormat.of().formatHex(md.digest(r));
    System.out.println("zstd-jni one-shot decompress(byte[],size) " + (h.startsWith("085b1d1a") ? "OK" : "WRONG") + " " + (System.nanoTime() - t) / 1000000 + " ms"); }
  catch (Exception e) { System.out.println("zstd-jni one-shot ERROR " + e.getMessage()); }
  try (var in = new ZstdInputStream(new java.io.ByteArrayInputStream(d))) { in.setDict(o); byte[] r = in.readAllBytes(); System.out.println("zstd-jni ZstdInputStream default window " + r.length); }
  catch (Exception e) { System.out.println("zstd-jni ZstdInputStream default window ERROR " + e.getMessage()); }
  try (var in = new ZstdInputStream(new java.io.ByteArrayInputStream(d))) { in.setDict(o); in.setLongMax(31); byte[] r = in.readAllBytes(); System.out.println("zstd-jni ZstdInputStream setLongMax(31) OK " + r.length); }
  catch (Exception e) { System.out.println("zstd-jni ZstdInputStream setLongMax(31) ERROR " + e.getMessage()); }
}}
