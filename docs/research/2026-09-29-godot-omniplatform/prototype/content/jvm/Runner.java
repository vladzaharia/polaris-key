// JVM runner for the content vectors (the API surface a Kotlin/Android SDK would use): zstd-jni + MessageDigest.
// usage: java -cp lib/*:. Runner <vector-dir>
import com.github.luben.zstd.ZstdDecompressCtx;
import com.google.gson.*;
import java.nio.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

public class Runner {
    static final int HDR = 64, REC = 48, REQUEST_WEIGHT = 16384;
    static final Map<String, Integer> RANK = Map.of("noop", 0, "platform", 1, "delta", 2, "chunk", 3, "file", 4, "full", 5);

    static class CE extends RuntimeException {
        final JsonObject v = new JsonObject();
        CE(String code) { super(code); v.addProperty("ok", false); v.addProperty("error", code); }
        CE with(String k, Object val) { if (val instanceof Number n) v.addProperty(k, n); else v.addProperty(k, (String) val); return this; }
    }

    // ---------------------------------------------------------------- primitives
    static String sha(byte[] b) { return sha(b, 0, b.length); }
    static String sha(byte[] b, int o, int n) {
        try { MessageDigest md = MessageDigest.getInstance("SHA-256"); md.update(b, o, n); return hex(md.digest(), 0, 32); }
        catch (Exception e) { throw new RuntimeException(e); }
    }
    static String hex(byte[] b, int o, int n) {
        StringBuilder s = new StringBuilder(n * 2);
        for (int i = o; i < o + n; i++) s.append(Character.forDigit((b[i] >> 4) & 15, 16)).append(Character.forDigit(b[i] & 15, 16));
        return s.toString();
    }
    /** zstd one-shot decode; dict = raw content (loadDict -> ZSTD_DCtx_loadDictionary). size = exact output size. */
    static byte[] zstd(byte[] src, byte[] dict, long size) {
        try (ZstdDecompressCtx d = new ZstdDecompressCtx()) {
            if (dict != null) d.loadDict(dict);
            if (size < 0) size = com.github.luben.zstd.Zstd.getFrameContentSize(src);
            if (size < 0) throw new RuntimeException("unknown size");
            byte[] out = d.decompress(src, (int) size);
            return out;
        }
    }

    static byte[] mutate(byte[] b, JsonArray muts) {
        if (muts == null) return b;
        b = b.clone();
        for (JsonElement e : muts) {
            JsonObject m = e.getAsJsonObject();
            String op = m.get("op").getAsString();
            if (op.equals("truncate")) { b = Arrays.copyOf(b, m.get("length").getAsInt()); continue; }
            int off = m.get("offset").getAsInt();
            ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
            switch (op) {
                case "xor" -> b[off] ^= (byte) m.get("value").getAsInt();
                case "putU16" -> bb.putShort(off, (short) m.get("value").getAsInt());
                case "putU32" -> bb.putInt(off, (int) m.get("value").getAsLong());
                case "putU64" -> bb.putLong(off, m.get("value").getAsLong());
                default -> throw new RuntimeException(op);
            }
        }
        return b;
    }

    // ---------------------------------------------------------------- pkey-chunks/1
    record Rec(String id, long len, long clen, long bundle, long off) {}
    record Index(long flags, long payloadSize, String payloadSha256, List<Rec> recs, List<String> bsha, List<Long> bsize) {}

    static Index parse(byte[] b) {
        if (b.length < HDR) throw new CE("chunks.bad_length");
        if (!new String(b, 0, 8, java.nio.charset.StandardCharsets.ISO_8859_1).equals("PKEYCHNK")) throw new CE("chunks.bad_magic");
        ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
        int ver = bb.getShort(8) & 0xffff, rs = bb.getShort(10) & 0xffff;
        long flags = bb.getInt(12) & 0xffffffffL, n = bb.getInt(16) & 0xffffffffL, nb = bb.getInt(20) & 0xffffffffL, psize = bb.getLong(24);
        if (ver != 1) throw new CE("chunks.unsupported_version");
        if (rs != REC) throw new CE("chunks.bad_record_size");
        if ((flags & ~1L) != 0) throw new CE("chunks.bad_flags");
        if (b.length != HDR + REC * (n + nb)) throw new CE("chunks.bad_length");
        List<String> bsha = new ArrayList<>(); List<Long> bsize = new ArrayList<>();
        for (int j = 0; j < nb; j++) {
            int o = (int) (HDR + REC * (n + j));
            if (bb.getLong(o + 40) != 0) throw new CE("chunks.reserved_nonzero").with("bundle", j);
            bsha.add(hex(b, o, 32)); bsize.add(bb.getLong(o + 32));
        }
        List<Rec> recs = new ArrayList<>();
        long total = 0;
        for (int i = 0; i < n; i++) {
            int o = HDR + REC * i;
            long ln = bb.getInt(o + 32) & 0xffffffffL, cl = bb.getInt(o + 36) & 0xffffffffL, bi = bb.getInt(o + 40) & 0xffffffffL, bo = bb.getInt(o + 44) & 0xffffffffL;
            if (ln == 0) throw new CE("chunks.zero_length").with("chunk", i);
            if (cl == 0 || cl > ln) throw new CE("chunks.bad_clen").with("chunk", i);
            if (bi >= nb) throw new CE("chunks.bad_bundle_ref").with("chunk", i);
            if (bo + cl > bsize.get((int) bi)) throw new CE("chunks.bad_bundle_range").with("chunk", i);
            total += ln;
            recs.add(new Rec(hex(b, o, 32), ln, cl, bi, bo));
        }
        if (total != psize) throw new CE("chunks.size_mismatch");
        return new Index(flags, psize, hex(b, 32, 32), recs, bsha, bsize);
    }

    static JsonArray recJson(Rec r) {
        JsonArray a = new JsonArray(); a.add(r.id); a.add(r.len); a.add(r.clen); a.add(r.bundle); a.add(r.off); return a;
    }

    static JsonObject summary(Index ix) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true); o.addProperty("chunkCount", ix.recs.size()); o.addProperty("bundleCount", ix.bsha.size());
        o.addProperty("payloadSize", ix.payloadSize); o.addProperty("payloadSha256", ix.payloadSha256); o.addProperty("fileAware", (ix.flags & 1) != 0);
        o.addProperty("uniqueChunks", ix.recs.stream().map(Rec::id).distinct().count());
        o.addProperty("rawStored", ix.recs.stream().filter(r -> r.len == r.clen).count());
        o.addProperty("sumClen", ix.recs.stream().mapToLong(Rec::clen).sum());
        if (ix.recs.isEmpty()) { o.add("first", JsonNull.INSTANCE); o.add("last", JsonNull.INSTANCE); }
        else { o.add("first", recJson(ix.recs.get(0))); o.add("last", recJson(ix.recs.get(ix.recs.size() - 1))); }
        return o;
    }

    // ---------------------------------------------------------------- paths
    static final Set<String> DEV = new HashSet<>(List.of("con", "prn", "aux", "nul"));
    static { for (int i = 1; i <= 9; i++) { DEV.add("com" + i); DEV.add("lpt" + i); } }
    static boolean pathOk(String p) {
        int n = p.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        if (n < 1 || n > 1024) return false;
        for (int i = 0; i < p.length(); i++) { char c = p.charAt(i); if (c < 0x20 || c > 0x7e || "\\:*?\"<>|".indexOf(c) >= 0) return false; }
        for (String s : p.split("/", -1)) {
            if (s.isEmpty() || s.equals(".") || s.equals("..") || s.endsWith(" ") || s.endsWith(".")) return false;
            if (DEV.contains(s.split("\\.", -1)[0].toLowerCase(Locale.ROOT))) return false;
        }
        return true;
    }
    static JsonObject checkPaths(List<String> paths) {
        Set<String> seen = new HashSet<>(), lower = new HashSet<>(), dirs = new HashSet<>();
        for (String p : paths) {
            String err = null;
            String lp = p.toLowerCase(Locale.ROOT);
            List<String> pre = new ArrayList<>();
            if (!pathOk(p)) err = "files.unsafe_path";
            else if (seen.contains(p)) err = "files.duplicate_path";
            else if (lower.contains(lp)) err = "files.case_collision";
            else {
                String[] parts = lp.split("/", -1);
                for (int k = 1; k < parts.length; k++) pre.add(String.join("/", Arrays.copyOfRange(parts, 0, k)));
                if (dirs.contains(lp) || pre.stream().anyMatch(lower::contains)) err = "files.path_conflict";
            }
            if (err != null) { JsonObject o = new JsonObject(); o.addProperty("error", err); o.addProperty("path", p); return o; }
            seen.add(p); lower.add(lp); dirs.addAll(pre);
        }
        JsonObject o = new JsonObject(); o.addProperty("ok", true); return o;
    }

    // ---------------------------------------------------------------- apply
    static byte[] applyDelta(byte[] base, JsonObject d, byte[] art, boolean skip, String path) {
        java.util.function.Function<String, CE> E = c -> path == null ? new CE(c) : new CE(c).with("path", path);
        if (!sha(art).equals(d.get("artifactSha256").getAsString())) throw E.apply("delta.artifact_mismatch");
        if (!skip && !sha(base).equals(d.get("from").getAsString())) throw E.apply("delta.base_mismatch");
        byte[] out;
        long size = d.get("size").getAsLong();
        try { out = zstd(art, base, size); } catch (CE ce) { throw ce; } catch (Exception ex) { throw E.apply("delta.apply_failed"); }
        if (out.length != size || !sha(out).equals(d.get("to").getAsString())) throw E.apply("delta.apply_failed");
        return out;
    }

    interface Fetch { byte[] get(String bundle, long off, long len); }

    static JsonObject applyChunk(byte[] tix, List<byte[][]> seeds, Fetch fetch, String expSha, long expSize, boolean repair) {
        Index T = parse(tix);
        if (!T.payloadSha256.equals(expSha) || T.payloadSize != expSize) throw new CE("chunks.payload_mismatch");
        Map<String, long[]> S = new HashMap<>();
        for (int si = 0; si < seeds.size(); si++) {
            long off = 0;
            for (Rec r : parse(seeds.get(si)[1]).recs) { S.putIfAbsent(r.id, new long[]{si, off}); off += r.len; }
        }
        byte[] out = new byte[(int) T.payloadSize];
        Map<String, Integer> first = new HashMap<>();
        String[] kinds = new String[T.recs.size()];
        long fetched = 0, fbytes = 0, requests = 0, seedC = 0, selfC = 0;
        Rec prev = null;
        int pos = 0;
        for (int i = 0; i < T.recs.size(); i++) {
            Rec r = T.recs.get(i);
            int ln = (int) r.len;
            if (S.containsKey(r.id)) {
                long[] s = S.get(r.id); byte[] sp = seeds.get((int) s[0])[0];
                System.arraycopy(sp, (int) s[1], out, pos, Math.max(0, Math.min(ln, sp.length - (int) s[1])));
                kinds[i] = "seed"; seedC++;
            } else if (first.containsKey(r.id)) {
                System.arraycopy(out, first.get(r.id), out, pos, ln); kinds[i] = "self"; selfC++;
            } else {
                if (prev == null || r.bundle != prev.bundle || r.off != prev.off + prev.clen) requests++;
                prev = r;
                System.arraycopy(fetchRec(T, i, r, fetch), 0, out, pos, ln);
                kinds[i] = "fetch"; fetched++; fbytes += r.clen;
            }
            first.putIfAbsent(r.id, pos);
            pos += ln;
        }
        JsonArray repaired = new JsonArray();
        if (!sha(out).equals(expSha)) {
            if (!repair) throw new CE("payload.hash_mismatch");
            pos = 0;
            for (int i = 0; i < T.recs.size(); i++) {
                Rec r = T.recs.get(i);
                if (kinds[i].equals("seed") && !sha(out, pos, (int) r.len).equals(r.id)) {
                    System.arraycopy(fetchRec(T, i, r, fetch), 0, out, pos, (int) r.len); repaired.add(i);
                }
                pos += (int) r.len;
            }
            if (!sha(out).equals(expSha)) throw new CE("payload.hash_mismatch");
        }
        JsonObject o = new JsonObject();
        o.addProperty("ok", true); o.addProperty("sha256", expSha); o.addProperty("size", out.length);
        o.addProperty("fetchedChunks", fetched); o.addProperty("fetchedBytes", fbytes); o.addProperty("requests", requests);
        o.addProperty("seedChunks", seedC); o.addProperty("selfChunks", selfC); o.add("repairedChunks", repaired);
        return o;
    }

    static byte[] fetchRec(Index T, int i, Rec r, Fetch fetch) {
        byte[] raw = fetch.get(T.bsha.get((int) r.bundle), r.off, r.clen);
        if (raw.length < r.clen) throw new CE("bundle.truncated").with("chunk", i);
        byte[] data;
        if (r.clen == r.len) data = raw;
        else try { data = zstd(raw, null, r.len); } catch (Exception e) { throw new CE("chunk.corrupt").with("chunk", i); }
        if (data.length != r.len || !sha(data).equals(r.id)) throw new CE("chunk.corrupt").with("chunk", i);
        return data;
    }

    // ---------------------------------------------------------------- case plumbing
    static Path root;
    static final Map<String, byte[]> cache = new HashMap<>(), dec = new HashMap<>();
    static byte[] raw(String n) { return cache.computeIfAbsent(n, k -> { try { return Files.readAllBytes(root.resolve("blobs").resolve(k)); } catch (Exception e) { throw new RuntimeException(e); } }); }
    static JsonArray muts(JsonObject ref) { return ref.has("mutate") ? ref.getAsJsonArray("mutate") : null; }
    static byte[] rawMut(JsonObject ref) { return mutate(raw(ref.get("blob").getAsString()), muts(ref)); }
    static byte[] mat(JsonObject ref) {
        String n = ref.get("blob").getAsString();
        byte[] b = raw(n);
        if (ref.has("codec") && ref.get("codec").getAsString().equals("zstd")) b = dec.computeIfAbsent(n, k -> zstd(raw(k), null, -1));
        return mutate(b, muts(ref));
    }

    static JsonElement applyCase(JsonObject c) {
        try {
            String s = c.get("strategy").getAsString();
            JsonObject o = new JsonObject();
            switch (s) {
                case "full" -> {
                    long size = c.get("expectedSize").getAsLong();
                    byte[] out;
                    try { out = zstd(rawMut(c.getAsJsonObject("full")), null, size); } catch (Exception e) { throw new CE("full.corrupt"); }
                    if (out.length != size || !sha(out).equals(c.get("expectedSha256").getAsString())) throw new CE("full.corrupt");
                    o.addProperty("ok", true); o.addProperty("sha256", c.get("expectedSha256").getAsString()); o.addProperty("size", out.length);
                    return o;
                }
                case "delta" -> {
                    JsonObject d = c.getAsJsonObject("delta");
                    byte[] out = applyDelta(mat(c.getAsJsonObject("base")), d, rawMut(d.getAsJsonObject("artifact")), c.has("skipBaseCheck") && c.get("skipBaseCheck").getAsBoolean(), null);
                    o.addProperty("ok", true); o.addProperty("sha256", d.get("to").getAsString()); o.addProperty("size", out.length);
                    o.addProperty("artifactBytes", raw(d.getAsJsonObject("artifact").get("blob").getAsString()).length);
                    return o;
                }
                case "chunk" -> {
                    Map<String, byte[]> bundles = new HashMap<>();
                    for (var e : c.getAsJsonObject("bundles").entrySet()) bundles.put(e.getKey(), rawMut(e.getValue().getAsJsonObject()));
                    List<byte[][]> seeds = new ArrayList<>();
                    for (JsonElement e : c.getAsJsonArray("seeds")) seeds.add(new byte[][]{mat(e.getAsJsonObject().getAsJsonObject("payload")), rawMut(e.getAsJsonObject().getAsJsonObject("index"))});
                    return applyChunk(rawMut(c.getAsJsonObject("target").getAsJsonObject("index")), seeds,
                        (h, off, len) -> { byte[] b = bundles.get(h); int a = (int) Math.min(off, b.length), z = (int) Math.min(off + len, b.length); return Arrays.copyOfRange(b, a, z); },
                        c.get("expectedSha256").getAsString(), c.get("expectedSize").getAsLong(), c.get("repair").getAsBoolean());
                }
                case "file" -> { return applyFiles(c); }
            }
            throw new RuntimeException(s);
        } catch (CE e) { return e.v; }
    }

    static JsonObject applyFiles(JsonObject c) {
        JsonObject t = c.getAsJsonObject("target"), inst = c.getAsJsonObject("installed");
        byte[] P = mat(inst.getAsJsonObject("payload"));
        JsonObject ii = JsonParser.parseString(new String(raw(inst.getAsJsonObject("files").get("blob").getAsString()))).getAsJsonObject();
        JsonObject ti = JsonParser.parseString(new String(raw(t.getAsJsonObject("files").get("blob").getAsString()))).getAsJsonObject();
        String layout = t.get("layout").getAsString();
        byte[] gaps = t.has("gaps") ? mat(t.getAsJsonObject("gaps")) : null;
        JsonArray files = ti.getAsJsonArray("files");
        List<String> paths = new ArrayList<>();
        for (JsonElement f : files) paths.add(f.getAsJsonObject().get("path").getAsString());
        JsonObject pc = checkPaths(paths);
        if (!pc.has("ok")) throw new CE(pc.get("error").getAsString()).with("path", pc.get("path").getAsString());
        long expSize = c.has("expectedSize") ? c.get("expectedSize").getAsLong() : -1;
        if (layout.equals("container")) {
            long pos = 0, gt = 0;
            for (JsonElement fe : files) { JsonObject f = fe.getAsJsonObject(); long o = f.get("offset").getAsLong(); if (o < pos) throw new CE("files.layout_mismatch"); gt += o - pos; pos = o + f.get("size").getAsLong(); }
            long size = ti.getAsJsonObject("payload").get("size").getAsLong();
            if (size < pos || size != expSize) throw new CE("files.layout_mismatch");
            gt += size - pos;
            if (gaps == null || gaps.length != gt) throw new CE("files.layout_mismatch");
        }
        Map<String, long[]> H = new HashMap<>();
        for (JsonElement fe : ii.getAsJsonArray("files")) { JsonObject f = fe.getAsJsonObject(); H.putIfAbsent(f.get("sha256").getAsString(), new long[]{f.get("offset").getAsLong(), f.get("size").getAsLong()}); }
        Map<String, JsonObject> dmap = new HashMap<>();
        for (JsonElement d : c.getAsJsonArray("fileDeltas")) dmap.put(d.getAsJsonObject().get("path").getAsString(), d.getAsJsonObject());
        JsonObject fb = c.getAsJsonObject("fileBlobs");
        long reused = 0, deltas = 0, blobs = 0, dl = 0;
        List<byte[]> datas = new ArrayList<>();
        for (JsonElement fe : files) {
            JsonObject f = fe.getAsJsonObject();
            String h = f.get("sha256").getAsString(), path = f.get("path").getAsString();
            long size = f.get("size").getAsLong();
            JsonObject d = dmap.get(path);
            byte[] data;
            if (H.containsKey(h)) { long[] x = H.get(h); data = Arrays.copyOfRange(P, (int) x[0], (int) (x[0] + x[1])); reused++; }
            else if (d != null && d.get("to").getAsString().equals(h)) {
                if (!H.containsKey(d.get("from").getAsString())) throw new CE("delta.base_mismatch").with("path", path);
                long[] x = H.get(d.get("from").getAsString());
                byte[] art = rawMut(d.getAsJsonObject("artifact"));
                data = applyDelta(Arrays.copyOfRange(P, (int) x[0], (int) (x[0] + x[1])), d, art, false, path);
                deltas++; dl += art.length;
            } else if (fb.has(h)) {
                JsonObject ref = fb.getAsJsonObject(h);
                byte[] rb = raw(ref.get("blob").getAsString());
                try { data = ref.get("codec").getAsString().equals("zstd") ? zstd(rb, null, size) : rb; } catch (Exception e) { throw new CE("file.corrupt").with("path", path); }
                if (data.length != size || !sha(data).equals(h)) throw new CE("file.corrupt").with("path", path);
                blobs++; dl += rb.length;
            } else throw new CE("file.source_missing").with("path", path);
            datas.add(data);
        }
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        if (layout.equals("tree")) {
            TreeMap<String, String> lines = new TreeMap<>();
            long total = 0;
            for (int k = 0; k < files.size(); k++) {
                JsonObject f = files.get(k).getAsJsonObject();
                if (datas.get(k).length != f.get("size").getAsLong() || !sha(datas.get(k)).equals(f.get("sha256").getAsString())) throw new CE("file.corrupt").with("path", f.get("path").getAsString());
                lines.put(f.get("path").getAsString(), f.get("sha256").getAsString() + " " + f.get("size").getAsLong() + " " + f.get("path").getAsString() + "\n");
                total += f.get("size").getAsLong();
            }
            o.addProperty("files", files.size()); o.addProperty("bytes", total);
            o.addProperty("treeDigest", sha(String.join("", lines.values()).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } else {
            byte[] out = new byte[(int) ti.getAsJsonObject("payload").get("size").getAsLong()];
            int pos = 0, gp = 0;
            for (int k = 0; k < files.size(); k++) {
                JsonObject f = files.get(k).getAsJsonObject();
                int off = f.get("offset").getAsInt(), g = off - pos;
                System.arraycopy(gaps, gp, out, pos, g); gp += g;
                System.arraycopy(datas.get(k), 0, out, off, datas.get(k).length);
                pos = off + f.get("size").getAsInt();
            }
            System.arraycopy(gaps, gp, out, pos, gaps.length - gp);
            if (!sha(out).equals(c.get("expectedSha256").getAsString())) throw new CE("payload.hash_mismatch");
            o.addProperty("sha256", c.get("expectedSha256").getAsString()); o.addProperty("size", out.length);
        }
        o.addProperty("reusedFiles", reused); o.addProperty("deltaFiles", deltas); o.addProperty("blobFiles", blobs); o.addProperty("downloadedBytes", dl);
        return o;
    }

    // ---------------------------------------------------------------- planner
    static List<Rec> recsOf(JsonObject spec) {
        if (spec.has("records")) {
            List<Rec> l = new ArrayList<>();
            for (JsonElement e : spec.getAsJsonArray("records")) { JsonArray a = e.getAsJsonArray(); l.add(new Rec(a.get(0).getAsString(), a.get(1).getAsLong(), a.get(2).getAsLong(), a.get(3).getAsLong(), a.get(4).getAsLong())); }
            return l;
        }
        return parse(rawMut(spec.getAsJsonObject("index"))).recs;
    }

    static JsonObject plan(JsonObject in) {
        JsonObject t = in.getAsJsonObject("target"), caps = in.getAsJsonObject("caps");
        JsonArray inst = in.getAsJsonArray("installed");
        String tsha = t.getAsJsonObject("payload").get("sha256").getAsString();
        long tsize = t.getAsJsonObject("payload").get("size").getAsLong();
        Set<String> have = new HashSet<>();
        for (JsonElement i : inst) have.add(i.getAsJsonObject().get("payloadSha256").getAsString());
        JsonObject r = new JsonObject();
        if (have.contains(tsha)) {
            r.addProperty("strategy", "noop"); for (String k : List.of("bytes", "requests", "cost", "peakDisk")) r.addProperty(k, 0); r.add("fallbacks", new JsonArray()); return r;
        }
        Set<String> transports = strs(caps, "transports"), strategies = strs(caps, "strategies"), methods = strs(caps, "patchMethods");
        if (t.has("platform") && !t.get("platform").isJsonNull()) {
            String tr = t.getAsJsonObject("platform").get("transport").getAsString();
            if (transports.contains(tr)) { r.addProperty("strategy", "platform"); r.addProperty("transport", tr); r.add("fallbacks", new JsonArray()); }
            else r.addProperty("error", "plan.transport_unsupported");
            return r;
        }
        record Cand(String strategy, String delta, long bytes, long requests, int ord) {}
        List<Cand> cands = new ArrayList<>();
        long mem = caps.get("memBudget").getAsLong();
        if (strategies.contains("delta") && t.has("deltas")) {
            int k = 0;
            for (JsonElement de : t.getAsJsonArray("deltas")) {
                JsonObject d = de.getAsJsonObject();
                if (methods.contains(d.get("method").getAsString()) && have.contains(d.get("from").getAsString()) && d.get("memBytes").getAsLong() <= mem) {
                    long b = 0; for (JsonElement a : d.getAsJsonArray("artifacts")) b += a.getAsJsonObject().get("bytes").getAsLong();
                    cands.add(new Cand("delta", d.get("id").getAsString(), b, d.getAsJsonArray("artifacts").size(), k));
                }
                k++;
            }
        }
        List<JsonObject> seeds = new ArrayList<>();
        for (JsonElement i : inst) { JsonElement ch = i.getAsJsonObject().get("chunks"); if (ch != null && !ch.isJsonNull()) seeds.add(ch.getAsJsonObject()); }
        if (strategies.contains("chunk") && t.has("chunks") && !t.get("chunks").isJsonNull() && !seeds.isEmpty()) {
            Set<String> S = new HashSet<>();
            for (JsonObject s : seeds) {
                if (s.has("ids")) for (JsonElement e : s.getAsJsonArray("ids")) S.add(e.getAsString());
                else for (Rec x : parse(rawMut(s.getAsJsonObject("index"))).recs) S.add(x.id);
            }
            Set<String> seen = new HashSet<>();
            Rec prev = null; long runs = 0, b = t.getAsJsonObject("chunks").get("indexBytes").getAsLong();
            for (Rec x : recsOf(t.getAsJsonObject("chunks"))) {
                if (S.contains(x.id) || seen.contains(x.id)) continue;
                seen.add(x.id); b += x.clen;
                if (prev == null || x.bundle != prev.bundle || x.off != prev.off + prev.clen) runs++;
                prev = x;
            }
            cands.add(new Cand("chunk", null, b, 1 + runs, 0));
        }
        List<JsonArray> instFiles = new ArrayList<>();
        for (JsonElement i : inst) { JsonElement f = i.getAsJsonObject().get("files"); if (f != null && !f.isJsonNull()) instFiles.add(f.getAsJsonArray()); }
        if (strategies.contains("file") && t.has("files") && !t.get("files").isJsonNull() && !instFiles.isEmpty()) {
            Set<String> H = new HashSet<>();
            for (JsonArray a : instFiles) for (JsonElement e : a) H.add(e.getAsString());
            JsonObject tf = t.getAsJsonObject("files");
            LinkedHashMap<String, Long> miss = new LinkedHashMap<>();
            for (JsonElement fe : tf.getAsJsonArray("files")) { JsonObject f = fe.getAsJsonObject(); String h = f.get("sha256").getAsString(); if (!H.contains(h)) miss.putIfAbsent(h, f.get("blobBytes").getAsLong()); }
            long gb = tf.get("gapsBytes").getAsLong(), b = tf.get("indexBytes").getAsLong() + gb;
            for (long v : miss.values()) b += v;
            cands.add(new Cand("file", null, b, 1 + (gb > 0 ? 1 : 0) + miss.size(), 0));
        }
        if (t.has("full") && !t.get("full").isJsonNull()) cands.add(new Cand("full", null, t.getAsJsonObject("full").get("bytes").getAsLong(), 1, 0));
        if (cands.isEmpty()) { r.addProperty("error", "plan.no_strategy"); return r; }
        long w = caps.has("requestWeight") ? caps.get("requestWeight").getAsLong() : REQUEST_WEIGHT, free = caps.get("freeDisk").getAsLong();
        List<Cand> feas = new ArrayList<>();
        for (Cand c : cands) if (tsize + c.bytes <= free) feas.add(c);
        if (feas.isEmpty()) { r.addProperty("error", "plan.insufficient_disk"); return r; }
        feas.sort(Comparator.comparingLong((Cand c) -> c.bytes + w * c.requests).thenComparingInt(c -> RANK.get(c.strategy)).thenComparingInt(c -> c.ord));
        Cand ch = feas.get(0);
        List<Cand> rest = new ArrayList<>();
        for (Cand c : feas.subList(1, feas.size())) if (!c.strategy.equals("full")) rest.add(c);
        for (Cand c : feas.subList(1, feas.size())) if (c.strategy.equals("full")) rest.add(c);
        r.addProperty("strategy", ch.strategy); if (ch.delta != null) r.addProperty("delta", ch.delta);
        r.addProperty("bytes", ch.bytes); r.addProperty("requests", ch.requests); r.addProperty("cost", ch.bytes + w * ch.requests); r.addProperty("peakDisk", tsize + ch.bytes);
        JsonArray fbk = new JsonArray();
        for (Cand c : rest) {
            JsonObject o = new JsonObject(); o.addProperty("strategy", c.strategy); if (c.delta != null) o.addProperty("delta", c.delta);
            o.addProperty("bytes", c.bytes); o.addProperty("requests", c.requests); o.addProperty("cost", c.bytes + w * c.requests); fbk.add(o);
        }
        r.add("fallbacks", fbk);
        return r;
    }
    static Set<String> strs(JsonObject o, String k) { Set<String> s = new HashSet<>(); if (o.has(k)) for (JsonElement e : o.getAsJsonArray(k)) s.add(e.getAsString()); return s; }

    // ---------------------------------------------------------------- main
    interface Thunk { Object run() throws Exception; }
    static double best(Thunk t, int reps) throws Exception { double b = 1e18; for (int i = 0; i < reps; i++) { long s = System.nanoTime(); t.run(); b = Math.min(b, (System.nanoTime() - s) / 1e6); } return b; }
    static String mbs(double ms, long n) { return String.format("%.0f ms, %.0f MB/s", ms, n / 1e6 / (ms / 1e3)); }

    static void bench(JsonObject doc) throws Exception {
        long n2 = doc.getAsJsonObject("payloads").getAsJsonObject("v2").get("size").getAsLong();
        byte[] full2 = raw("payload/v2.full.zst");
        byte[] v2 = zstd(full2, null, n2);
        Map<String, JsonObject> cs = new HashMap<>();
        for (JsonElement e : doc.getAsJsonArray("applyCases")) cs.put(e.getAsJsonObject().get("id").getAsString(), e.getAsJsonObject());
        for (int warm = 0; warm < 2; warm++) { zstd(full2, null, n2); sha(v2); }
        Map<String, String> out = new LinkedHashMap<>();
        out.put("zstd_decompress", mbs(best(() -> zstd(full2, null, n2), 5), n2));
        out.put("sha256", mbs(best(() -> { MessageDigest md = MessageDigest.getInstance("SHA-256"); for (int o = 0; o < v2.length; o += 1 << 20) md.update(v2, o, Math.min(1 << 20, v2.length - o)); return md.digest(); }, 5), n2));
        JsonObject dc = cs.get("delta-whole-v1-to-v2"), d = dc.getAsJsonObject("delta");
        byte[] v1 = mat(dc.getAsJsonObject("base")), art = raw(d.getAsJsonObject("artifact").get("blob").getAsString());
        out.put("delta_decode_only", mbs(best(() -> zstd(art, v1, n2), 5), n2));
        out.put("delta_apply_verified", mbs(best(() -> applyDelta(v1, d, art, false, null), 5), n2));
        JsonObject cc = cs.get("chunk-v1-to-v2");
        out.put("chunk_reassembly", mbs(best(() -> applyCase(cc), 5), n2));
        JsonObject fc = cs.get("file-delta-v1-to-v2");
        out.put("file_delta_rebuild", mbs(best(() -> applyCase(fc), 5), n2));
        byte[] tix = raw("chunks/v2.pkc");
        out.put("parse_chunk_index_1531", String.format("%.2f ms", best(() -> parse(tix), 20)));
        System.out.println(new GsonBuilder().setPrettyPrinting().create().toJson(out));
    }

    public static void main(String[] a) throws Exception {
        root = Paths.get(a[0]);
        JsonObject doc = JsonParser.parseString(Files.readString(root.resolve("cases.json"))).getAsJsonObject();
        if (a.length > 1 && a[1].equals("bench")) { bench(doc); return; }
        int n = 0, bad = 0;
        for (var e : doc.getAsJsonObject("blobs").entrySet())
            if (!sha(raw(e.getKey())).equals(e.getValue().getAsJsonObject().get("sha256").getAsString())) { System.out.println("VECTOR INTEGRITY FAIL " + e.getKey()); bad++; }
        long t0 = System.nanoTime();
        JsonObject results = new JsonObject();
        for (String g : List.of("chunkIndexCases", "applyCases", "planCases", "pathCases")) {
            for (JsonElement ce : doc.getAsJsonArray(g)) {
                JsonObject c = ce.getAsJsonObject();
                JsonElement got;
                switch (g) {
                    case "chunkIndexCases" -> { JsonElement v; try { v = summary(parse(rawMut(c.getAsJsonObject("index")))); } catch (CE x) { v = x.v; } got = v; }
                    case "applyCases" -> got = applyCase(c);
                    case "planCases" -> got = plan(c.getAsJsonObject("input"));
                    default -> { List<String> ps = new ArrayList<>(); for (JsonElement p : c.getAsJsonArray("paths")) ps.add(p.getAsString()); got = checkPaths(ps); }
                }
                n++;
                results.add(c.get("id").getAsString(), got);
                if (!got.equals(c.get("expected"))) { bad++; System.out.println("FAIL " + g + "/" + c.get("id").getAsString() + "\n  got      " + got + "\n  expected " + c.get("expected")); }
            }
        }
        System.out.printf("java %s [zstd-jni %s, libzstd %s]: %d/%d cases match, %d ms%n", System.getProperty("java.version"),
            com.github.luben.zstd.util.ZstdVersion.VERSION, com.github.luben.zstd.Zstd.class.getPackage().getImplementationVersion(), n - bad, n, (System.nanoTime() - t0) / 1000000);
        if (System.getenv("DUMP") != null) Files.writeString(Paths.get(System.getenv("DUMP")), results.toString());
        System.exit(bad == 0 ? 0 : 1);
    }
}
