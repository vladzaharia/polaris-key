// .NET runner for the content vectors. net11.0: System.IO.Compression.ZstandardDecoder (SetPrefix);
// net10.0 (and net11 with ZSTD=sharp): ZstdSharp.Port (pure managed). SHA-256: System.Security.Cryptography.
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

static class Z
{
    public static string Name = "";
    public static Func<byte[], byte[]?, long, byte[]> Decode = null!;
    public static void Init()
    {
        var want = Environment.GetEnvironmentVariable("ZSTD") ?? "builtin";
#if NET11_0_OR_GREATER
        if (want == "builtin")
        {
            Name = "System.IO.Compression.ZstandardDecoder";
            Decode = (src, dict, size) =>
            {
                if (size < 0) { if (!System.IO.Compression.ZstandardDecoder.TryGetMaxDecompressedLength(src, out size)) throw new Exception("size"); }
                var dst = new byte[size];
                using var d = new System.IO.Compression.ZstandardDecoder(new System.IO.Compression.ZstandardDecompressionOptions { MaxWindowLog2 = 31 });
                if (dict != null) d.SetPrefix(dict);
                var st = d.Decompress(src, dst, out int consumed, out int written);
                if (st != System.Buffers.OperationStatus.Done || written != size) throw new Exception("zstd " + st);
                return dst;
            };
            return;
        }
#endif
        Name = "ZstdSharp.Port " + typeof(ZstdSharp.Decompressor).Assembly.GetName().Version;
        Decode = (src, dict, size) =>
        {
            using var d = new ZstdSharp.Decompressor();
            d.SetParameter(ZstdSharp.Unsafe.ZSTD_dParameter.ZSTD_d_windowLogMax, 31);
            if (dict != null) RefPrefix(d, dict);
            if (size < 0) size = (long)ZstdSharp.Decompressor.GetDecompressedSize(src);
            var dst = new byte[size];
            int n = d.Unwrap(src, dst, 0);
            if (n != size) throw new Exception("short");
            return dst;
        };
    }
    // ZstdSharp exposes LoadDictionary (auto-detect); raw-content prefix goes through the unsafe port of ZSTD_DCtx_refPrefix.
    static unsafe void RefPrefix(ZstdSharp.Decompressor d, byte[] dict)
    {
        var mode = Environment.GetEnvironmentVariable("SHARP_DICT") ?? "prefix";
        if (mode == "load") { d.LoadDictionary(dict); return; }
        var f = typeof(ZstdSharp.Decompressor).GetField("handle", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
        var h = f.GetValue(d)!;
        var dctx = (ZstdSharp.Unsafe.ZSTD_DCtx_s*)((System.Runtime.InteropServices.SafeHandle)h).DangerousGetHandle();
        // the prefix is referenced, not copied: pin for the lifetime of the decoder call (vectors hold the array alive)
        var gch = System.Runtime.InteropServices.GCHandle.Alloc(dict, System.Runtime.InteropServices.GCHandleType.Pinned);
        Pins.Add(gch);
        var r = ZstdSharp.Unsafe.Methods.ZSTD_DCtx_refPrefix(dctx, (void*)gch.AddrOfPinnedObject(), (nuint)dict.Length);
        if (ZstdSharp.Unsafe.Methods.ZSTD_isError(r)) throw new Exception("refPrefix");
    }
    public static List<System.Runtime.InteropServices.GCHandle> Pins = new();
}

class CE : Exception
{
    public JsonObject V = new() { ["ok"] = false };
    public CE(string code) : base(code) { V["error"] = code; }
    public CE With(string k, JsonNode v) { V[k] = v; return this; }
}

record Rec(string Id, long Len, long Clen, long Bundle, long Off);
record Index(long Flags, long PayloadSize, string PayloadSha256, List<Rec> Recs, List<(string sha, long size)> Bundles);

static class P
{
    const int HDR = 64, REC = 48;
    const long REQUEST_WEIGHT = 16384;
    static readonly Dictionary<string, int> RANK = new() { ["noop"] = 0, ["platform"] = 1, ["delta"] = 2, ["chunk"] = 3, ["file"] = 4, ["full"] = 5 };
    public static string Sha(ReadOnlySpan<byte> b) => Convert.ToHexStringLower(SHA256.HashData(b));

    public static byte[] Mutate(byte[] b, JsonArray? muts)
    {
        if (muts == null) return b;
        b = (byte[])b.Clone();
        foreach (var m in muts)
        {
            var op = (string)m!["op"]!;
            if (op == "truncate") { Array.Resize(ref b, (int)m["length"]!); continue; }
            int off = (int)m["offset"]!;
            switch (op)
            {
                case "xor": b[off] ^= (byte)(int)m["value"]!; break;
                case "putU16": BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(off), (ushort)(int)m["value"]!); break;
                case "putU32": BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(off), (uint)(long)m["value"]!); break;
                case "putU64": BinaryPrimitives.WriteUInt64LittleEndian(b.AsSpan(off), (ulong)(long)m["value"]!); break;
                default: throw new Exception(op);
            }
        }
        return b;
    }

    public static Index Parse(byte[] b)
    {
        if (b.Length < HDR) throw new CE("chunks.bad_length");
        if (Encoding.ASCII.GetString(b, 0, 8) != "PKEYCHNK") throw new CE("chunks.bad_magic");
        var s = b.AsSpan();
        int ver = BinaryPrimitives.ReadUInt16LittleEndian(s[8..]), rs = BinaryPrimitives.ReadUInt16LittleEndian(s[10..]);
        long flags = BinaryPrimitives.ReadUInt32LittleEndian(s[12..]), n = BinaryPrimitives.ReadUInt32LittleEndian(s[16..]), nb = BinaryPrimitives.ReadUInt32LittleEndian(s[20..]);
        long psize = (long)BinaryPrimitives.ReadUInt64LittleEndian(s[24..]);
        if (ver != 1) throw new CE("chunks.unsupported_version");
        if (rs != REC) throw new CE("chunks.bad_record_size");
        if ((flags & ~1L) != 0) throw new CE("chunks.bad_flags");
        if (b.Length != HDR + REC * (n + nb)) throw new CE("chunks.bad_length");
        var bundles = new List<(string, long)>();
        for (int j = 0; j < nb; j++)
        {
            int o = (int)(HDR + REC * (n + j));
            if (BinaryPrimitives.ReadUInt64LittleEndian(s[(o + 40)..]) != 0) throw new CE("chunks.reserved_nonzero").With("bundle", j);
            bundles.Add((Convert.ToHexStringLower(s.Slice(o, 32)), (long)BinaryPrimitives.ReadUInt64LittleEndian(s[(o + 32)..])));
        }
        var recs = new List<Rec>();
        long total = 0;
        for (int i = 0; i < n; i++)
        {
            int o = HDR + REC * i;
            long ln = BinaryPrimitives.ReadUInt32LittleEndian(s[(o + 32)..]), cl = BinaryPrimitives.ReadUInt32LittleEndian(s[(o + 36)..]);
            long bi = BinaryPrimitives.ReadUInt32LittleEndian(s[(o + 40)..]), bo = BinaryPrimitives.ReadUInt32LittleEndian(s[(o + 44)..]);
            if (ln == 0) throw new CE("chunks.zero_length").With("chunk", i);
            if (cl == 0 || cl > ln) throw new CE("chunks.bad_clen").With("chunk", i);
            if (bi >= nb) throw new CE("chunks.bad_bundle_ref").With("chunk", i);
            if (bo + cl > bundles[(int)bi].Item2) throw new CE("chunks.bad_bundle_range").With("chunk", i);
            total += ln;
            recs.Add(new Rec(Convert.ToHexStringLower(s.Slice(o, 32)), ln, cl, bi, bo));
        }
        if (total != psize) throw new CE("chunks.size_mismatch");
        return new Index(flags, psize, Convert.ToHexStringLower(s.Slice(32, 32)), recs, bundles);
    }

    static JsonArray RecJ(Rec r) => new(r.Id, r.Len, r.Clen, r.Bundle, r.Off);
    public static JsonObject Summary(Index ix) => new()
    {
        ["ok"] = true, ["chunkCount"] = ix.Recs.Count, ["bundleCount"] = ix.Bundles.Count, ["payloadSize"] = ix.PayloadSize,
        ["payloadSha256"] = ix.PayloadSha256, ["fileAware"] = (ix.Flags & 1) != 0, ["uniqueChunks"] = ix.Recs.Select(r => r.Id).Distinct().Count(),
        ["rawStored"] = ix.Recs.Count(r => r.Len == r.Clen), ["sumClen"] = ix.Recs.Sum(r => r.Clen),
        ["first"] = ix.Recs.Count > 0 ? RecJ(ix.Recs[0]) : null, ["last"] = ix.Recs.Count > 0 ? RecJ(ix.Recs[^1]) : null,
    };

    static readonly HashSet<string> DEV = new(new[] { "con", "prn", "aux", "nul" }.Concat(Enumerable.Range(1, 9).SelectMany(i => new[] { "com" + i, "lpt" + i })));
    static bool PathOk(string p)
    {
        int n = Encoding.UTF8.GetByteCount(p);
        if (n < 1 || n > 1024) return false;
        foreach (var c in p) if (c < 0x20 || c > 0x7e || "\\:*?\"<>|".Contains(c)) return false;
        foreach (var seg in p.Split('/'))
        {
            if (seg is "" or "." or ".." || seg.EndsWith(' ') || seg.EndsWith('.')) return false;
            if (DEV.Contains(seg.Split('.')[0].ToLowerInvariant())) return false;
        }
        return true;
    }
    public static JsonObject CheckPaths(IEnumerable<string> paths)
    {
        var seen = new HashSet<string>(); var lower = new HashSet<string>(); var dirs = new HashSet<string>();
        foreach (var p in paths)
        {
            string? err = null; var lp = p.ToLowerInvariant(); var pre = new List<string>();
            if (!PathOk(p)) err = "files.unsafe_path";
            else if (seen.Contains(p)) err = "files.duplicate_path";
            else if (lower.Contains(lp)) err = "files.case_collision";
            else
            {
                var parts = lp.Split('/');
                for (int k = 1; k < parts.Length; k++) pre.Add(string.Join('/', parts[..k]));
                if (dirs.Contains(lp) || pre.Any(lower.Contains)) err = "files.path_conflict";
            }
            if (err != null) return new JsonObject { ["error"] = err, ["path"] = p };
            seen.Add(p); lower.Add(lp); foreach (var x in pre) dirs.Add(x);
        }
        return new JsonObject { ["ok"] = true };
    }

    public static byte[] ApplyDelta(byte[] b, JsonNode d, byte[] art, bool skip, string? path)
    {
        CE E(string c) => path == null ? new CE(c) : new CE(c).With("path", path);
        if (Sha(art) != (string)d["artifactSha256"]!) throw E("delta.artifact_mismatch");
        if (!skip && Sha(b) != (string)d["from"]!) throw E("delta.base_mismatch");
        long size = (long)d["size"]!;
        byte[] o;
        try { o = Z.Decode(art, b, size); } catch { throw E("delta.apply_failed"); }
        if (o.Length != size || Sha(o) != (string)d["to"]!) throw E("delta.apply_failed");
        return o;
    }

    static byte[] FetchRec(Index T, int i, Rec r, Func<string, long, long, byte[]> fetch)
    {
        var raw = fetch(T.Bundles[(int)r.Bundle].sha, r.Off, r.Clen);
        if (raw.Length < r.Clen) throw new CE("bundle.truncated").With("chunk", i);
        byte[] data;
        if (r.Clen == r.Len) data = raw;
        else try { data = Z.Decode(raw, null, r.Len); } catch { throw new CE("chunk.corrupt").With("chunk", i); }
        if (data.Length != r.Len || Sha(data) != r.Id) throw new CE("chunk.corrupt").With("chunk", i);
        return data;
    }

    public static JsonObject ApplyChunk(byte[] tix, List<(byte[] payload, byte[] index)> seeds, Func<string, long, long, byte[]> fetch, string expSha, long expSize, bool repair)
    {
        var T = Parse(tix);
        if (T.PayloadSha256 != expSha || T.PayloadSize != expSize) throw new CE("chunks.payload_mismatch");
        var S = new Dictionary<string, (int, long)>();
        for (int si = 0; si < seeds.Count; si++) { long off = 0; foreach (var r in Parse(seeds[si].index).Recs) { S.TryAdd(r.Id, (si, off)); off += r.Len; } }
        var o = new byte[T.PayloadSize]; var first = new Dictionary<string, long>(); var kinds = new string[T.Recs.Count];
        long fc = 0, fb = 0, req = 0, sc = 0, xc = 0, pos = 0; Rec? prev = null;
        for (int i = 0; i < T.Recs.Count; i++)
        {
            var r = T.Recs[i];
            if (S.TryGetValue(r.Id, out var s)) { var sp = seeds[s.Item1].payload; Array.Copy(sp, s.Item2, o, pos, Math.Max(0, Math.Min(r.Len, sp.Length - s.Item2))); kinds[i] = "seed"; sc++; }
            else if (first.TryGetValue(r.Id, out var f)) { Array.Copy(o, f, o, pos, r.Len); kinds[i] = "self"; xc++; }
            else
            {
                if (prev == null || r.Bundle != prev.Bundle || r.Off != prev.Off + prev.Clen) req++;
                prev = r;
                Array.Copy(FetchRec(T, i, r, fetch), 0, o, pos, r.Len); kinds[i] = "fetch"; fc++; fb += r.Clen;
            }
            first.TryAdd(r.Id, pos); pos += r.Len;
        }
        var rep = new JsonArray();
        if (Sha(o) != expSha)
        {
            if (!repair) throw new CE("payload.hash_mismatch");
            pos = 0;
            for (int i = 0; i < T.Recs.Count; i++)
            {
                var r = T.Recs[i];
                if (kinds[i] == "seed" && Sha(o.AsSpan((int)pos, (int)r.Len)) != r.Id) { Array.Copy(FetchRec(T, i, r, fetch), 0, o, pos, r.Len); rep.Add(i); }
                pos += r.Len;
            }
            if (Sha(o) != expSha) throw new CE("payload.hash_mismatch");
        }
        return new JsonObject { ["ok"] = true, ["sha256"] = expSha, ["size"] = o.Length, ["fetchedChunks"] = fc, ["fetchedBytes"] = fb, ["requests"] = req, ["seedChunks"] = sc, ["selfChunks"] = xc, ["repairedChunks"] = rep };
    }

    // ------------------------------------------------------------ case plumbing
    public static string Root = "";
    static readonly Dictionary<string, byte[]> Cache = new(), Dec = new();
    static byte[] Raw(string n) { if (!Cache.TryGetValue(n, out var b)) Cache[n] = b = File.ReadAllBytes(Path.Combine(Root, "blobs", n)); return b; }
    static byte[] RawMut(JsonNode r) => Mutate(Raw((string)r["blob"]!), r["mutate"]?.AsArray());
    static byte[] Mat(JsonNode r)
    {
        var n = (string)r["blob"]!; var b = Raw(n);
        if ((string?)r["codec"] == "zstd") { if (!Dec.TryGetValue(n, out var d)) Dec[n] = d = Z.Decode(b, null, -1); b = d; }
        return Mutate(b, r["mutate"]?.AsArray());
    }

    public static JsonNode ApplyCase(JsonNode c)
    {
        try
        {
            switch ((string)c["strategy"]!)
            {
                case "full":
                    {
                        long size = (long)c["expectedSize"]!; byte[] o;
                        try { o = Z.Decode(RawMut(c["full"]!), null, size); } catch { throw new CE("full.corrupt"); }
                        if (o.Length != size || Sha(o) != (string)c["expectedSha256"]!) throw new CE("full.corrupt");
                        return new JsonObject { ["ok"] = true, ["sha256"] = (string)c["expectedSha256"]!, ["size"] = o.Length };
                    }
                case "delta":
                    {
                        var d = c["delta"]!;
                        var o = ApplyDelta(Mat(c["base"]!), d, RawMut(d["artifact"]!), (bool?)c["skipBaseCheck"] ?? false, null);
                        return new JsonObject { ["ok"] = true, ["sha256"] = (string)d["to"]!, ["size"] = o.Length, ["artifactBytes"] = Raw((string)d["artifact"]!["blob"]!).Length };
                    }
                case "chunk":
                    {
                        var bundles = c["bundles"]!.AsObject().ToDictionary(kv => kv.Key, kv => RawMut(kv.Value!));
                        var seeds = c["seeds"]!.AsArray().Select(s => (Mat(s!["payload"]!), RawMut(s!["index"]!))).ToList();
                        return ApplyChunk(RawMut(c["target"]!["index"]!), seeds, (h, off, len) => { var b = bundles[h]; long a = Math.Min(off, b.Length), z = Math.Min(off + len, b.Length); return b[(int)a..(int)z]; },
                            (string)c["expectedSha256"]!, (long)c["expectedSize"]!, (bool)c["repair"]!);
                    }
                case "file": return ApplyFiles(c);
            }
            throw new Exception("strategy");
        }
        catch (CE e) { return e.V; }
    }

    static JsonObject ApplyFiles(JsonNode c)
    {
        var t = c["target"]!; var inst = c["installed"]!;
        var P0 = Mat(inst["payload"]!);
        var ii = JsonNode.Parse(Raw((string)inst["files"]!["blob"]!))!; var ti = JsonNode.Parse(Raw((string)t["files"]!["blob"]!))!;
        var layout = (string)t["layout"]!; var gaps = t["gaps"] != null ? Mat(t["gaps"]!) : null;
        var files = ti["files"]!.AsArray();
        var pc = CheckPaths(files.Select(f => (string)f!["path"]!));
        if (pc["ok"] == null) throw new CE((string)pc["error"]!).With("path", (string)pc["path"]!);
        long expSize = (long?)c["expectedSize"] ?? -1;
        if (layout == "container")
        {
            long pos = 0, gt = 0;
            foreach (var f in files) { long o = (long)f!["offset"]!; if (o < pos) throw new CE("files.layout_mismatch"); gt += o - pos; pos = o + (long)f["size"]!; }
            long size = (long)ti["payload"]!["size"]!;
            if (size < pos || size != expSize) throw new CE("files.layout_mismatch");
            gt += size - pos;
            if (gaps == null || gaps.Length != gt) throw new CE("files.layout_mismatch");
        }
        var H = new Dictionary<string, (long, long)>();
        foreach (var f in ii["files"]!.AsArray()) H.TryAdd((string)f!["sha256"]!, ((long)f["offset"]!, (long)f["size"]!));
        var dmap = c["fileDeltas"]!.AsArray().ToDictionary(d => (string)d!["path"]!, d => d!);
        var fbl = c["fileBlobs"]!.AsObject();
        long reused = 0, deltas = 0, blobs = 0, dl = 0;
        var datas = new List<byte[]>();
        foreach (var f in files)
        {
            string h = (string)f!["sha256"]!, path = (string)f["path"]!; long size = (long)f["size"]!;
            dmap.TryGetValue(path, out var d);
            byte[] data;
            if (H.TryGetValue(h, out var x)) { data = P0[(int)x.Item1..(int)(x.Item1 + x.Item2)]; reused++; }
            else if (d != null && (string)d["to"]! == h)
            {
                if (!H.TryGetValue((string)d["from"]!, out var y)) throw new CE("delta.base_mismatch").With("path", path);
                var art = RawMut(d["artifact"]!);
                data = ApplyDelta(P0[(int)y.Item1..(int)(y.Item1 + y.Item2)], d, art, false, path); deltas++; dl += art.Length;
            }
            else if (fbl[h] is JsonNode refn)
            {
                var rb = Raw((string)refn["blob"]!);
                try { data = (string)refn["codec"]! == "zstd" ? Z.Decode(rb, null, size) : rb; } catch { throw new CE("file.corrupt").With("path", path); }
                if (data.Length != size || Sha(data) != h) throw new CE("file.corrupt").With("path", path);
                blobs++; dl += rb.Length;
            }
            else throw new CE("file.source_missing").With("path", path);
            datas.Add(data);
        }
        var res = new JsonObject { ["ok"] = true };
        if (layout == "tree")
        {
            var lines = new SortedDictionary<string, string>(StringComparer.Ordinal); long total = 0;
            for (int k = 0; k < files.Count; k++)
            {
                var f = files[k]!;
                if (datas[k].Length != (long)f["size"]! || Sha(datas[k]) != (string)f["sha256"]!) throw new CE("file.corrupt").With("path", (string)f["path"]!);
                lines[(string)f["path"]!] = $"{(string)f["sha256"]!} {(long)f["size"]!} {(string)f["path"]!}\n"; total += (long)f["size"]!;
            }
            res["files"] = files.Count; res["bytes"] = total; res["treeDigest"] = Sha(Encoding.UTF8.GetBytes(string.Concat(lines.Values)));
        }
        else
        {
            var o = new byte[(long)ti["payload"]!["size"]!]; long pos = 0, gp = 0;
            for (int k = 0; k < files.Count; k++)
            {
                var f = files[k]!; long off = (long)f["offset"]!, g = off - pos;
                Array.Copy(gaps!, gp, o, pos, g); gp += g; Array.Copy(datas[k], 0, o, off, datas[k].Length); pos = off + (long)f["size"]!;
            }
            Array.Copy(gaps!, gp, o, pos, gaps!.Length - gp);
            if (Sha(o) != (string)c["expectedSha256"]!) throw new CE("payload.hash_mismatch");
            res["sha256"] = (string)c["expectedSha256"]!; res["size"] = o.Length;
        }
        res["reusedFiles"] = reused; res["deltaFiles"] = deltas; res["blobFiles"] = blobs; res["downloadedBytes"] = dl;
        return res;
    }

    // ------------------------------------------------------------ planner
    record Cand(string S, string? Delta, long Bytes, long Requests, int Ord);
    static bool Has(JsonNode? n) => n != null && n.GetValueKind() != JsonValueKind.Null;
    static HashSet<string> Strs(JsonNode caps, string k) => Has(caps[k]) ? caps[k]!.AsArray().Select(x => (string)x!).ToHashSet() : new();
    static List<Rec> RecsOf(JsonNode spec) => Has(spec["records"])
        ? spec["records"]!.AsArray().Select(a => new Rec((string)a![0]!, (long)a[1]!, (long)a[2]!, (long)a[3]!, (long)a[4]!)).ToList()
        : Parse(RawMut(spec["index"]!)).Recs;

    public static JsonObject Plan(JsonNode inp)
    {
        var t = inp["target"]!; var caps = inp["caps"]!; var inst = inp["installed"]!.AsArray();
        string tsha = (string)t["payload"]!["sha256"]!; long tsize = (long)t["payload"]!["size"]!;
        var have = inst.Select(i => (string)i!["payloadSha256"]!).ToHashSet();
        if (have.Contains(tsha)) return new JsonObject { ["strategy"] = "noop", ["bytes"] = 0, ["requests"] = 0, ["cost"] = 0, ["peakDisk"] = 0, ["fallbacks"] = new JsonArray() };
        if (Has(t["platform"]))
        {
            var tr = (string)t["platform"]!["transport"]!;
            return Strs(caps, "transports").Contains(tr) ? new JsonObject { ["strategy"] = "platform", ["transport"] = tr, ["fallbacks"] = new JsonArray() } : new JsonObject { ["error"] = "plan.transport_unsupported" };
        }
        var strategies = Strs(caps, "strategies"); var methods = Strs(caps, "patchMethods"); long mem = (long)caps["memBudget"]!;
        var cands = new List<Cand>();
        if (strategies.Contains("delta") && Has(t["deltas"]))
        {
            int k = 0;
            foreach (var d in t["deltas"]!.AsArray())
            {
                if (methods.Contains((string)d!["method"]!) && have.Contains((string)d["from"]!) && (long)d["memBytes"]! <= mem)
                    cands.Add(new Cand("delta", (string)d["id"]!, d["artifacts"]!.AsArray().Sum(a => (long)a!["bytes"]!), d["artifacts"]!.AsArray().Count, k));
                k++;
            }
        }
        var seeds = inst.Where(i => Has(i!["chunks"])).Select(i => i!["chunks"]!).ToList();
        if (strategies.Contains("chunk") && Has(t["chunks"]) && seeds.Count > 0)
        {
            var S = new HashSet<string>();
            foreach (var s in seeds) { if (Has(s["ids"])) foreach (var x in s["ids"]!.AsArray()) S.Add((string)x!); else foreach (var r in Parse(RawMut(s["index"]!)).Recs) S.Add(r.Id); }
            var seen = new HashSet<string>(); Rec? prev = null; long runs = 0, b = (long)t["chunks"]!["indexBytes"]!;
            foreach (var r in RecsOf(t["chunks"]!))
            {
                if (S.Contains(r.Id) || !seen.Add(r.Id)) continue;
                b += r.Clen;
                if (prev == null || r.Bundle != prev.Bundle || r.Off != prev.Off + prev.Clen) runs++;
                prev = r;
            }
            cands.Add(new Cand("chunk", null, b, 1 + runs, 0));
        }
        var instFiles = inst.Where(i => Has(i!["files"])).SelectMany(i => i!["files"]!.AsArray().Select(x => (string)x!)).ToHashSet();
        if (strategies.Contains("file") && Has(t["files"]) && inst.Any(i => Has(i!["files"])))
        {
            var tf = t["files"]!; var miss = new Dictionary<string, long>(); var order = new List<string>();
            foreach (var f in tf["files"]!.AsArray()) { var h = (string)f!["sha256"]!; if (!instFiles.Contains(h) && miss.TryAdd(h, (long)f["blobBytes"]!)) order.Add(h); }
            long gb = (long)tf["gapsBytes"]!;
            cands.Add(new Cand("file", null, (long)tf["indexBytes"]! + gb + miss.Values.Sum(), 1 + (gb > 0 ? 1 : 0) + miss.Count, 0));
        }
        if (Has(t["full"])) cands.Add(new Cand("full", null, (long)t["full"]!["bytes"]!, 1, 0));
        if (cands.Count == 0) return new JsonObject { ["error"] = "plan.no_strategy" };
        long w = Has(caps["requestWeight"]) ? (long)caps["requestWeight"]! : REQUEST_WEIGHT, free = (long)caps["freeDisk"]!;
        var feas = cands.Where(c => tsize + c.Bytes <= free).OrderBy(c => c.Bytes + w * c.Requests).ThenBy(c => RANK[c.S]).ThenBy(c => c.Ord).ToList();
        if (feas.Count == 0) return new JsonObject { ["error"] = "plan.insufficient_disk" };
        var ch = feas[0]; var rest = feas.Skip(1).Where(c => c.S != "full").Concat(feas.Skip(1).Where(c => c.S == "full"));
        JsonObject Pub(Cand c, bool full)
        {
            var o = new JsonObject { ["strategy"] = c.S };
            if (c.Delta != null) o["delta"] = c.Delta;
            o["bytes"] = c.Bytes; o["requests"] = c.Requests; o["cost"] = c.Bytes + w * c.Requests;
            if (full) o["peakDisk"] = tsize + c.Bytes;
            return o;
        }
        var res = Pub(ch, true); res["fallbacks"] = new JsonArray(rest.Select(c => (JsonNode)Pub(c, false)).ToArray());
        return res;
    }

    // canonical JSON (sorted keys, integral numbers normalised) for comparison
    public static string Canon(JsonNode? n) => n switch
    {
        null => "null",
        JsonObject o => "{" + string.Join(",", o.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => JsonSerializer.Serialize(kv.Key) + ":" + Canon(kv.Value))) + "}",
        JsonArray a => "[" + string.Join(",", a.Select(Canon)) + "]",
        JsonValue v when v.GetValueKind() == JsonValueKind.Number => decimal.Parse(v.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture).ToString(System.Globalization.CultureInfo.InvariantCulture),
        _ => n.ToJsonString(),
    };
}

static class Program
{
    static int Main(string[] a)
    {
        Z.Init();
        if (a[0] == "probe")
        {
            // a[1]=delta a[2]=old a[3]=new
            byte[] d = File.ReadAllBytes(a[1]), o = File.ReadAllBytes(a[2]), nw = File.ReadAllBytes(a[3]);
            var sw0 = System.Diagnostics.Stopwatch.StartNew();
            try { var r = Z.Decode(d, o, nw.Length); Console.WriteLine($"{Z.Name} {Environment.GetEnvironmentVariable("SHARP_DICT")}: {(r.AsSpan().SequenceEqual(nw) ? "OK" : "WRONG")} {sw0.ElapsedMilliseconds} ms"); }
            catch (Exception e) { Console.WriteLine($"{Z.Name} {Environment.GetEnvironmentVariable("SHARP_DICT")}: ERROR {e.Message}"); }
#if NET11_0_OR_GREATER
            try { using var dict = System.IO.Compression.ZstandardDictionary.Create(o); using var dec = new System.IO.Compression.ZstandardDecoder(dict); var dst = new byte[nw.Length]; dec.Decompress(d, dst, out _, out int w); Console.WriteLine($"ZstandardDictionary.Create: {(dst.AsSpan().SequenceEqual(nw) ? "OK" : "WRONG")}"); }
            catch (Exception e) { Console.WriteLine($"ZstandardDictionary.Create: ERROR {e.Message}"); }
            try { var dst = new byte[nw.Length]; using var dec = new System.IO.Compression.ZstandardDecoder(); dec.SetPrefix(o); var st = dec.Decompress(d, dst, out _, out int w); Console.WriteLine($"ZstandardDecoder default window + SetPrefix: {st} {(dst.AsSpan().SequenceEqual(nw) ? "OK" : "WRONG")}"); }
            catch (Exception e) { Console.WriteLine($"ZstandardDecoder default window + SetPrefix: ERROR {e.Message}"); }
#endif
            return 0;
        }
        P.Root = a[0];
        var doc = JsonNode.Parse(File.ReadAllText(Path.Combine(a[0], "cases.json")))!;
        if (a.Length > 1 && a[1] == "bench") { Bench.Run(doc); return 0; }
        int n = 0, bad = 0;
        foreach (var kv in doc["blobs"]!.AsObject())
            if (P.Sha(File.ReadAllBytes(Path.Combine(a[0], "blobs", kv.Key))) != (string)kv.Value!["sha256"]!) { Console.WriteLine("VECTOR INTEGRITY FAIL " + kv.Key); bad++; }
        var sw = System.Diagnostics.Stopwatch.StartNew();
        foreach (var g in new[] { "chunkIndexCases", "applyCases", "planCases", "pathCases" })
            foreach (var c in doc[g]!.AsArray())
            {
                JsonNode got;
                switch (g)
                {
                    case "chunkIndexCases": try { got = P.Summary(P.Parse(P.Mutate(File.ReadAllBytes(Path.Combine(a[0], "blobs", (string)c!["index"]!["blob"]!)), c["index"]!["mutate"]?.AsArray()))); } catch (CE e) { got = e.V; } break;
                    case "applyCases": got = P.ApplyCase(c!); break;
                    case "planCases": got = P.Plan(c!["input"]!); break;
                    default: got = P.CheckPaths(c!["paths"]!.AsArray().Select(x => (string)x!)); break;
                }
                n++;
                if (P.Canon(got) != P.Canon(c!["expected"])) { bad++; Console.WriteLine($"FAIL {g}/{(string)c["id"]!}\n  got      {P.Canon(got)[..Math.Min(400, P.Canon(got).Length)]}\n  expected {P.Canon(c["expected"])[..Math.Min(400, P.Canon(c["expected"]).Length)]}"); }
            }
        Console.WriteLine($"{System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription} [{Z.Name}]: {n - bad}/{n} cases match, {sw.ElapsedMilliseconds} ms");
        return bad == 0 ? 0 : 1;
    }
}

static class Bench
{
    static double Best(Func<object> f, int reps = 5) { double b = 1e18; for (int i = 0; i < reps; i++) { var sw = System.Diagnostics.Stopwatch.StartNew(); f(); b = Math.Min(b, sw.Elapsed.TotalMilliseconds); } return b; }
    static string Mbs(double ms, long n) => $"{ms:F0} ms, {n / 1e6 / (ms / 1e3):F0} MB/s";
    public static void Run(JsonNode doc)
    {
        long n2 = (long)doc["payloads"]!["v2"]!["size"]!;
        var blobs = Path.Combine(P.Root, "blobs");
        var full2 = File.ReadAllBytes(Path.Combine(blobs, "payload/v2.full.zst"));
        var v2 = Z.Decode(full2, null, n2);
        var cs = doc["applyCases"]!.AsArray().ToDictionary(c => (string)c!["id"]!, c => c!);
        for (int w = 0; w < 2; w++) { Z.Decode(full2, null, n2); P.Sha(v2); P.ApplyCase(cs["chunk-v1-to-v2"]); }
        var o = new Dictionary<string, string>();
        o["zstd_decompress"] = Mbs(Best(() => Z.Decode(full2, null, n2)), n2);
        o["sha256"] = Mbs(Best(() => { using var h = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); for (int i = 0; i < v2.Length; i += 1 << 20) h.AppendData(v2, i, Math.Min(1 << 20, v2.Length - i)); return h.GetHashAndReset(); }), n2);
        var dc = cs["delta-whole-v1-to-v2"]; var d = dc["delta"]!;
        var v1 = Z.Decode(File.ReadAllBytes(Path.Combine(blobs, "payload/v1.full.zst")), null, (long)dc["base"]!["size"]!);
        var art = File.ReadAllBytes(Path.Combine(blobs, (string)d["artifact"]!["blob"]!));
        o["delta_decode_only"] = Mbs(Best(() => Z.Decode(art, v1, n2)), n2);
        o["delta_apply_verified"] = Mbs(Best(() => P.ApplyDelta(v1, d, art, false, null)), n2);
        o["chunk_reassembly"] = Mbs(Best(() => P.ApplyCase(cs["chunk-v1-to-v2"])), n2);
        o["file_delta_rebuild"] = Mbs(Best(() => P.ApplyCase(cs["file-delta-v1-to-v2"])), n2);
        var tix = File.ReadAllBytes(Path.Combine(blobs, "chunks/v2.pkc"));
        o["parse_chunk_index_1531"] = $"{Best(() => P.Parse(tix), 20):F2} ms";
        Console.WriteLine($"{System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription} [{Z.Name}]");
        foreach (var kv in o) Console.WriteLine($"  {kv.Key}: {kv.Value}");
    }
}
