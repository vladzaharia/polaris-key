import com.github.luben.zstd.*; import java.nio.file.*;
public class DZ { public static void main(String[] a) throws Exception {
  byte[] d = Files.readAllBytes(Path.of(a[0])), o = Files.readAllBytes(Path.of(a[1])), n = Files.readAllBytes(Path.of(a[2]));
  try (ZstdDecompressCtx c = new ZstdDecompressCtx()) { c.loadDict(o); byte[] r = c.decompress(d, n.length); System.out.println("zstd-jni " + a[0] + ": " + (java.util.Arrays.equals(r, n) ? "OK" : "WRONG " + r.length)); }
  catch (Exception e) { System.out.println("zstd-jni " + a[0] + ": ERROR " + e.getMessage()); }
}}
