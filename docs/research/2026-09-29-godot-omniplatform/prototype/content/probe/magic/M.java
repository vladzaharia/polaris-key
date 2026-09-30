import com.github.luben.zstd.*; import java.nio.file.*;
public class M { public static void main(String[] a) throws Exception {
  byte[] d = Files.readAllBytes(Path.of("probe/magic/d.zst")), o = Files.readAllBytes(Path.of("probe/magic/old.bin")), n = Files.readAllBytes(Path.of("probe/magic/new.bin"));
  try (ZstdDecompressCtx c = new ZstdDecompressCtx()) { c.loadDict(o); byte[] r = c.decompress(d, n.length); System.out.println("zstd-jni loadDict(byte[])    " + (java.util.Arrays.equals(r, n) ? "OK" : "WRONG")); }
  catch (Exception e) { System.out.println("zstd-jni loadDict(byte[])    ERROR " + e.getMessage()); }
  try (ZstdDecompressCtx c = new ZstdDecompressCtx()) { c.loadDict(new ZstdDictDecompress(o)); byte[] r = c.decompress(d, n.length); System.out.println("zstd-jni ZstdDictDecompress  " + (java.util.Arrays.equals(r, n) ? "OK" : "WRONG")); }
  catch (Exception e) { System.out.println("zstd-jni ZstdDictDecompress  ERROR " + e.getMessage()); }
}}
