class_name ContentRunner
extends SceneTree
## GDScript runner for the content vectors (pure GDScript, stock engine APIs only).
## usage: godot --headless --path runners/godot --script res://content_runner.gd -- <vector-dir>
## zstd --patch-from is applied through the engine's own delta-PCK decoder (GDDL wrapper), as in notes/A6.

const PCK_MAGIC := 0x43504447
const F_DELTA := 4
const HDR := 64
const REC := 48
const REQUEST_WEIGHT := 16384
const RANK := {"noop": 0, "platform": 1, "delta": 2, "chunk": 3, "file": 4, "full": 5}

var vroot := ""
var cache := {}
var dec := {}
var seq := 0
var err := {}  # the pending verdict error, GDScript has no exceptions
var stats := {"patch_from_calls": 0, "mounts": 0}

# ------------------------------------------------------------------ primitives

static func sha(b: PackedByteArray) -> String:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(b)
	return h.finish().hex_encode()

static func zstd(b: PackedByteArray, size: int) -> PackedByteArray:
	return b.decompress(size, FileAccess.COMPRESSION_ZSTD)

func fail(code: String, detail := {}) -> void:
	if err.is_empty():
		err = {"ok": false, "error": code}
		err.merge(detail)

## Minimal PCK v4 writer (no MD5s needed: Godot never checks them).
func write_pck(path: String, entries: Array) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	for v in [PCK_MAGIC, 4, 4, 7, 2, 2]:
		f.store_32(v)
	f.store_64(0)
	f.store_64(0)
	for i in 16:
		f.store_32(0)
	var zeros := PackedByteArray()
	zeros.resize(16)
	f.store_buffer(zeros.slice(0, (16 - f.get_position() % 16) % 16))
	var file_base := f.get_position()
	var recs := []
	for e in entries:  # [path, data, flags]
		var o := f.get_position()
		f.store_buffer(e[1])
		f.store_buffer(zeros.slice(0, (16 - f.get_position() % 16) % 16))
		recs.append([e[0], o - file_base, e[1].size(), e[2]])
	var dir_off := f.get_position()
	f.store_32(recs.size())
	for r in recs:
		var pb: PackedByteArray = r[0].to_utf8_buffer()
		pb.resize(pb.size() + (4 - pb.size() % 4) % 4)
		f.store_32(pb.size())
		f.store_buffer(pb)
		f.store_64(r[1])
		f.store_64(r[2])
		f.store_buffer(zeros)
		f.store_32(r[3])
	f.seek(24)
	f.store_64(file_base)
	f.store_64(dir_off)
	f.close()

## zstd --patch-from through the engine: host PCK exposes the base under a private path, a delta PCK
## carries the GDDL-wrapped frame for that path; reading the path decodes (ZSTD_DCtx_refPrefix, one-shot).
func patch_from(base: PackedByteArray, frame: PackedByteArray) -> PackedByteArray:
	seq += 1
	stats.patch_from_calls += 1
	var vpath := "__pkey/x%d/f.bin" % seq
	var host := "user://xl/h%d.pck" % seq
	var dp := "user://xl/d%d.pck" % seq
	var g := "GDDL".to_ascii_buffer()
	g.append(1)
	g.append_array(frame)
	write_pck(host, [[vpath, base, 0]])
	write_pck(dp, [[vpath, g, F_DELTA]])
	ProjectSettings.load_resource_pack(host, false)
	ProjectSettings.load_resource_pack(dp, false)
	stats.mounts += 2
	var f := FileAccess.open("res://" + vpath, FileAccess.READ)
	var out := PackedByteArray()
	if f != null:
		out = f.get_buffer(f.get_length())
		f.close()
	DirAccess.remove_absolute(host)
	DirAccess.remove_absolute(dp)
	return out

func mutate(b: PackedByteArray, muts) -> PackedByteArray:
	if muts == null:
		return b
	b = b.duplicate()
	for m in muts:
		match m.op:
			"truncate":
				b.resize(int(m.length))
			"xor":
				b[int(m.offset)] = b[int(m.offset)] ^ int(m.value)
			"putU16":
				b.encode_u16(int(m.offset), int(m.value))
			"putU32":
				b.encode_u32(int(m.offset), int(m.value))
			"putU64":
				b.encode_u64(int(m.offset), int(m.value))
	return b

func raw(name: String) -> PackedByteArray:
	if not cache.has(name):
		cache[name] = FileAccess.get_file_as_bytes(vroot.path_join("blobs").path_join(name))
	return cache[name]

func raw_mut(ref: Dictionary) -> PackedByteArray:
	return mutate(raw(ref.blob), ref.get("mutate"))

func mat(ref: Dictionary) -> PackedByteArray:
	var b := raw(ref.blob)
	if ref.get("codec") == "zstd":
		if not dec.has(ref.blob):
			dec[ref.blob] = zstd(b, int(ref.size))
		b = dec[ref.blob]
	return mutate(b, ref.get("mutate"))

# ------------------------------------------------------------------ pkey-chunks/1

func parse_index(b: PackedByteArray) -> Dictionary:
	if b.size() < HDR:
		fail("chunks.bad_length"); return {}
	if b.slice(0, 8) != "PKEYCHNK".to_ascii_buffer():
		fail("chunks.bad_magic"); return {}
	var ver := b.decode_u16(8)
	var rs := b.decode_u16(10)
	var flags := b.decode_u32(12)
	var n := b.decode_u32(16)
	var nb := b.decode_u32(20)
	var psize := b.decode_u64(24)
	if ver != 1:
		fail("chunks.unsupported_version"); return {}
	if rs != REC:
		fail("chunks.bad_record_size"); return {}
	if flags & ~1:
		fail("chunks.bad_flags"); return {}
	if b.size() != HDR + REC * (n + nb):
		fail("chunks.bad_length"); return {}
	var bundles := []
	for j in nb:
		var o := HDR + REC * (n + j)
		if b.decode_u64(o + 40) != 0:
			fail("chunks.reserved_nonzero", {"bundle": j}); return {}
		bundles.append([b.slice(o, o + 32).hex_encode(), b.decode_u64(o + 32)])
	var recs := []
	var total := 0
	for i in n:
		var o := HDR + REC * i
		var ln := b.decode_u32(o + 32)
		var cl := b.decode_u32(o + 36)
		var bi := b.decode_u32(o + 40)
		var bo := b.decode_u32(o + 44)
		if ln == 0:
			fail("chunks.zero_length", {"chunk": i}); return {}
		if cl == 0 or cl > ln:
			fail("chunks.bad_clen", {"chunk": i}); return {}
		if bi >= nb:
			fail("chunks.bad_bundle_ref", {"chunk": i}); return {}
		if bo + cl > bundles[bi][1]:
			fail("chunks.bad_bundle_range", {"chunk": i}); return {}
		total += ln
		recs.append([b.slice(o, o + 32).hex_encode(), ln, cl, bi, bo])
	if total != psize:
		fail("chunks.size_mismatch"); return {}
	return {"flags": flags, "payloadSize": psize, "payloadSha256": b.slice(32, 64).hex_encode(), "records": recs, "bundles": bundles}

func summary(ix: Dictionary) -> Dictionary:
	var r: Array = ix.records
	var uniq := {}
	var raw_n := 0
	var sum := 0
	for x in r:
		uniq[x[0]] = true
		if x[1] == x[2]:
			raw_n += 1
		sum += x[2]
	return {"ok": true, "chunkCount": r.size(), "bundleCount": ix.bundles.size(), "payloadSize": ix.payloadSize,
		"payloadSha256": ix.payloadSha256, "fileAware": (ix.flags & 1) != 0, "uniqueChunks": uniq.size(), "rawStored": raw_n,
		"sumClen": sum, "first": r[0] if r.size() else null, "last": r[-1] if r.size() else null}

# ------------------------------------------------------------------ paths

const BAD := "\\:*?\"<>|"
static func path_ok(p: String) -> bool:
	var n := p.to_utf8_buffer().size()
	if n < 1 or n > 1024:
		return false
	for i in p.length():
		var c := p.unicode_at(i)
		if c < 0x20 or c > 0x7e or BAD.contains(p[i]):
			return false
	var dev := ["con", "prn", "aux", "nul"]
	for d in range(1, 10):
		dev.append("com%d" % d)
		dev.append("lpt%d" % d)
	for s in p.split("/"):
		if s == "" or s == "." or s == ".." or s.ends_with(" ") or s.ends_with("."):
			return false
		if s.split(".")[0].to_lower() in dev:
			return false
	return true

static func check_paths(paths: Array) -> Dictionary:
	var seen := {}
	var lower := {}
	var dirs := {}
	for p in paths:
		if not path_ok(p):
			return {"error": "files.unsafe_path", "path": p}
		if seen.has(p):
			return {"error": "files.duplicate_path", "path": p}
		var lp: String = p.to_lower()
		if lower.has(lp):
			return {"error": "files.case_collision", "path": p}
		var parts := lp.split("/")
		var pre := []
		for k in range(1, parts.size()):
			pre.append("/".join(parts.slice(0, k)))
		var conflict := dirs.has(lp)
		for x in pre:
			if lower.has(x):
				conflict = true
		if conflict:
			return {"error": "files.path_conflict", "path": p}
		seen[p] = true
		lower[lp] = true
		for x in pre:
			dirs[x] = true
	return {"ok": true}

# ------------------------------------------------------------------ apply

func apply_delta(base: PackedByteArray, d: Dictionary, art: PackedByteArray, skip: bool, detail := {}) -> PackedByteArray:
	if sha(art) != d.artifactSha256:
		fail("delta.artifact_mismatch", detail); return PackedByteArray()
	if not skip and sha(base) != d.from:
		fail("delta.base_mismatch", detail); return PackedByteArray()
	var out := patch_from(base, art)
	if out.size() != int(d.size) or sha(out) != d.to:
		fail("delta.apply_failed", detail); return PackedByteArray()
	return out

func fetch_rec(T: Dictionary, i: int, r: Array, bundles: Dictionary) -> PackedByteArray:
	var b: PackedByteArray = bundles[T.bundles[r[3]][0]]
	var raw_b := b.slice(r[4], r[4] + r[2])
	if raw_b.size() < r[2]:
		fail("bundle.truncated", {"chunk": i}); return PackedByteArray()
	var data := raw_b if r[2] == r[1] else zstd(raw_b, r[1])
	if data.size() != r[1] or sha(data) != r[0]:
		fail("chunk.corrupt", {"chunk": i}); return PackedByteArray()
	return data

func apply_chunk(c: Dictionary) -> Dictionary:
	var bundles := {}
	for h in c.bundles:
		bundles[h] = raw_mut(c.bundles[h])
	var T := parse_index(raw_mut(c.target.index))
	if err: return err
	if T.payloadSha256 != c.expectedSha256 or T.payloadSize != int(c.expectedSize):
		fail("chunks.payload_mismatch"); return err
	var seeds := []
	var S := {}
	for sd in c.seeds:
		var payload := mat(sd.payload)
		var I := parse_index(raw_mut(sd.index))
		if err: return err
		var off := 0
		for r in I.records:
			if not S.has(r[0]):
				S[r[0]] = [seeds.size(), off]
			off += r[1]
		seeds.append(payload)
	var out := PackedByteArray()
	var first := {}
	var kinds := []
	var st := {"fetchedChunks": 0, "fetchedBytes": 0, "requests": 0, "seedChunks": 0, "selfChunks": 0}
	var prev = null
	var pos := 0
	var recs: Array = T.records
	for i in recs.size():
		var r: Array = recs[i]
		var data: PackedByteArray
		if S.has(r[0]):
			var s: Array = S[r[0]]
			data = seeds[s[0]].slice(s[1], s[1] + r[1])
			kinds.append("seed"); st.seedChunks += 1
		elif first.has(r[0]):
			data = out.slice(first[r[0]], first[r[0]] + r[1])
			kinds.append("self"); st.selfChunks += 1
		else:
			if prev == null or r[3] != prev[3] or r[4] != prev[4] + prev[2]:
				st.requests += 1
			prev = r
			data = fetch_rec(T, i, r, bundles)
			if err: return err
			kinds.append("fetch"); st.fetchedChunks += 1; st.fetchedBytes += r[2]
		if not first.has(r[0]):
			first[r[0]] = pos
		out.append_array(data)  # records are in payload order, so the output only ever grows
		pos += r[1]
	var repaired := []
	if sha(out) != c.expectedSha256:
		if not c.repair:
			fail("payload.hash_mismatch"); return err
		pos = 0
		var fixed := PackedByteArray()
		for i in recs.size():
			var r: Array = recs[i]
			var part := out.slice(pos, pos + r[1])
			if kinds[i] == "seed" and sha(part) != r[0]:
				part = fetch_rec(T, i, r, bundles)
				if err: return err
				repaired.append(i)
			fixed.append_array(part)
			pos += r[1]
		out = fixed
		if sha(out) != c.expectedSha256:
			fail("payload.hash_mismatch"); return err
	var v := {"ok": true, "sha256": c.expectedSha256, "size": out.size(), "repairedChunks": repaired}
	v.merge(st)
	return v

func apply_files(c: Dictionary) -> Dictionary:
	var t: Dictionary = c.target
	var P := mat(c.installed.payload)
	var ii = JSON.parse_string(raw(c.installed.files.blob).get_string_from_utf8())
	var ti = JSON.parse_string(raw(t.files.blob).get_string_from_utf8())
	var layout: String = t.layout
	var gaps := mat(t.gaps) if t.has("gaps") else PackedByteArray()
	var files: Array = ti.files
	var paths := []
	for f in files:
		paths.append(f.path)
	var pc := check_paths(paths)
	if not pc.has("ok"):
		fail(pc.error, {"path": pc.path}); return err
	if layout == "container":
		var p0 := 0
		var gt := 0
		for f in files:
			if int(f.offset) < p0:
				fail("files.layout_mismatch"); return err
			gt += int(f.offset) - p0
			p0 = int(f.offset) + int(f.size)
		var size := int(ti.payload.size)
		if size < p0 or size != int(c.get("expectedSize", -1)):
			fail("files.layout_mismatch"); return err
		gt += size - p0
		if not t.has("gaps") or gaps.size() != gt:
			fail("files.layout_mismatch"); return err
	var H := {}
	for f in ii.files:
		if not H.has(f.sha256):
			H[f.sha256] = [int(f.offset), int(f.size)]
	var dmap := {}
	for d in c.fileDeltas:
		dmap[d.path] = d
	var fb: Dictionary = c.fileBlobs
	var st := {"reusedFiles": 0, "deltaFiles": 0, "blobFiles": 0, "downloadedBytes": 0}
	var datas := []
	for f in files:
		var h: String = f.sha256
		var path: String = f.path
		var size := int(f.size)
		var d = dmap.get(path)
		var data: PackedByteArray
		if H.has(h):
			data = P.slice(H[h][0], H[h][0] + H[h][1])
			st.reusedFiles += 1
		elif d != null and d.to == h:
			if not H.has(d.from):
				fail("delta.base_mismatch", {"path": path}); return err
			var art := raw_mut(d.artifact)
			data = apply_delta(P.slice(H[d.from][0], H[d.from][0] + H[d.from][1]), d, art, false, {"path": path})
			if err: return err
			st.deltaFiles += 1; st.downloadedBytes += art.size()
		elif fb.has(h):
			var rb := raw(fb[h].blob)
			data = zstd(rb, size) if fb[h].codec == "zstd" else rb
			if data.size() != size or sha(data) != h:
				fail("file.corrupt", {"path": path}); return err
			st.blobFiles += 1; st.downloadedBytes += rb.size()
		else:
			fail("file.source_missing", {"path": path}); return err
		datas.append(data)
	var v := {"ok": true}
	if layout == "tree":
		var lines := {}
		var total := 0
		for k in files.size():
			var f: Dictionary = files[k]
			if datas[k].size() != int(f.size) or sha(datas[k]) != f.sha256:
				fail("file.corrupt", {"path": f.path}); return err
			lines[f.path] = "%s %d %s\n" % [f.sha256, int(f.size), f.path]
			total += int(f.size)
		var keys := lines.keys()
		keys.sort()
		var s := ""
		for k in keys:
			s += lines[k]
		v.merge({"files": files.size(), "bytes": total, "treeDigest": sha(s.to_utf8_buffer())})
	else:
		var out := PackedByteArray()
		var pos := 0
		var gp := 0
		for k in files.size():
			var off := int(files[k].offset)
			out.append_array(gaps.slice(gp, gp + off - pos))
			gp += off - pos
			out.append_array(datas[k])
			pos = off + int(files[k].size)
		out.append_array(gaps.slice(gp))
		if sha(out) != c.expectedSha256:
			fail("payload.hash_mismatch"); return err
		v.merge({"sha256": c.expectedSha256, "size": out.size()})
	v.merge(st)
	return v

func apply_case(c: Dictionary) -> Dictionary:
	err = {}
	match c.strategy:
		"full":
			var out := zstd(raw_mut(c.full), int(c.expectedSize))
			if out.size() != int(c.expectedSize) or sha(out) != c.expectedSha256:
				fail("full.corrupt"); return err
			return {"ok": true, "sha256": c.expectedSha256, "size": out.size()}
		"delta":
			var d: Dictionary = c.delta
			var out := apply_delta(mat(c.base), d, raw_mut(d.artifact), c.get("skipBaseCheck", false))
			if err: return err
			return {"ok": true, "sha256": d.to, "size": out.size(), "artifactBytes": raw(d.artifact.blob).size()}
		"chunk":
			return apply_chunk(c)
		"file":
			return apply_files(c)
	return {"error": "unknown strategy"}

# ------------------------------------------------------------------ planner

func plan(inp: Dictionary) -> Dictionary:
	err = {}
	var t: Dictionary = inp.target
	var caps: Dictionary = inp.caps
	var inst: Array = inp.installed
	var tsize := int(t.payload.size)
	var have := {}
	for i in inst:
		have[i.payloadSha256] = true
	if have.has(t.payload.sha256):
		return {"strategy": "noop", "bytes": 0, "requests": 0, "cost": 0, "peakDisk": 0, "fallbacks": []}
	if t.get("platform") != null:
		if t.platform.transport in caps.get("transports", []):
			return {"strategy": "platform", "transport": t.platform.transport, "fallbacks": []}
		return {"error": "plan.transport_unsupported"}
	var strategies: Array = caps.get("strategies", [])
	var cands := []
	if "delta" in strategies:
		var k := 0
		for d in t.get("deltas", []):
			if d.method in caps.get("patchMethods", []) and have.has(d.from) and int(d.memBytes) <= int(caps.memBudget):
				var b := 0
				for a in d.artifacts:
					b += int(a.bytes)
				cands.append({"strategy": "delta", "delta": d.id, "bytes": b, "requests": d.artifacts.size(), "ord": k})
			k += 1
	var seeds := []
	for i in inst:
		if i.get("chunks") != null:
			seeds.append(i.chunks)
	if "chunk" in strategies and t.get("chunks") != null and seeds.size():
		var S := {}
		for s in seeds:
			if s.has("ids"):
				for x in s.ids:
					S[x] = true
			else:
				for r in parse_index(raw_mut(s.index)).records:
					S[r[0]] = true
		var recs: Array
		if t.chunks.has("records"):
			recs = []
			for r in t.chunks.records:
				recs.append([r[0], int(r[1]), int(r[2]), int(r[3]), int(r[4])])
		else:
			recs = parse_index(raw_mut(t.chunks.index)).records
		var seen := {}
		var prev = null
		var runs := 0
		var b := int(t.chunks.indexBytes)
		for r in recs:
			if S.has(r[0]) or seen.has(r[0]):
				continue
			seen[r[0]] = true
			b += r[2]
			if prev == null or r[3] != prev[3] or r[4] != prev[4] + prev[2]:
				runs += 1
			prev = r
		cands.append({"strategy": "chunk", "bytes": b, "requests": 1 + runs, "ord": 0})
	var inst_files := {}
	var any_files := false
	for i in inst:
		if i.get("files") != null:
			any_files = true
			for h in i.files:
				inst_files[h] = true
	if "file" in strategies and t.get("files") != null and any_files:
		var miss := {}
		var mb := 0
		for f in t.files.files:
			if not inst_files.has(f.sha256) and not miss.has(f.sha256):
				miss[f.sha256] = true
				mb += int(f.blobBytes)
		var gb := int(t.files.gapsBytes)
		cands.append({"strategy": "file", "bytes": int(t.files.indexBytes) + gb + mb, "requests": 1 + (1 if gb > 0 else 0) + miss.size(), "ord": 0})
	if t.get("full") != null:
		cands.append({"strategy": "full", "bytes": int(t.full.bytes), "requests": 1, "ord": 0})
	if cands.is_empty():
		return {"error": "plan.no_strategy"}
	var w := int(caps.get("requestWeight", REQUEST_WEIGHT))
	var feas := []
	for c in cands:
		c.cost = c.bytes + w * c.requests
		c.peakDisk = tsize + c.bytes
		if c.peakDisk <= int(caps.freeDisk):
			feas.append(c)
	if feas.is_empty():
		return {"error": "plan.insufficient_disk"}
	feas.sort_custom(func(a, b):
		if a.cost != b.cost: return a.cost < b.cost
		if RANK[a.strategy] != RANK[b.strategy]: return RANK[a.strategy] < RANK[b.strategy]
		return a.ord < b.ord)
	var rest := []
	for c in feas.slice(1):
		if c.strategy != "full":
			rest.append(c)
	for c in feas.slice(1):
		if c.strategy == "full":
			rest.append(c)
	var res := pub(feas[0], true)
	var fbs := []
	for c in rest:
		fbs.append(pub(c, false))
	res.fallbacks = fbs
	return res

static func pub(c: Dictionary, full: bool) -> Dictionary:
	var o := {"strategy": c.strategy}
	if c.has("delta"):
		o.delta = c.delta
	o.bytes = c.bytes
	o.requests = c.requests
	o.cost = c.cost
	if full:
		o.peakDisk = c.peakDisk
	return o

# ------------------------------------------------------------------ comparison + main

static func canon(v) -> String:
	match typeof(v):
		TYPE_DICTIONARY:
			var m := {}
			for k in v.keys():
				m[str(k)] = v[k]  # dot-assigned keys are StringName; normalise before sorting
			var keys: Array = m.keys()
			keys.sort()
			var parts := []
			for k in keys:
				parts.append(JSON.stringify(k) + ":" + canon(m[k]))
			return "{" + ",".join(parts) + "}"
		TYPE_ARRAY:
			var parts := []
			for x in v:
				parts.append(canon(x))
			return "[" + ",".join(parts) + "]"
		TYPE_FLOAT:
			return str(int(v)) if v == floor(v) else JSON.stringify(v)
		TYPE_INT:
			return str(v)
		TYPE_BOOL:
			return "true" if v else "false"
		TYPE_NIL:
			return "null"
	return JSON.stringify(v)

func best(fn: Callable, reps := 3) -> float:
	var b := 1e18
	for i in reps:
		var t := Time.get_ticks_usec()
		fn.call()
		b = minf(b, (Time.get_ticks_usec() - t) / 1000.0)
	return b

func bench() -> void:
	var doc = JSON.parse_string(FileAccess.get_file_as_string(vroot.path_join("cases.json")))
	var n2 := int(doc.payloads.v2.size)
	var full2 := raw("payload/v2.full.zst")
	var v2 := zstd(full2, n2)
	var mbs := func(ms: float) -> String: return "%.0f ms, %.0f MB/s" % [ms, n2 / 1e6 / (ms / 1e3)]
	var out := {}
	out.zstd_decompress = mbs.call(best(func(): zstd(full2, n2)))
	out.sha256_stream = mbs.call(best(func():
		var h := HashingContext.new(); h.start(HashingContext.HASH_SHA256)
		var o := 0
		while o < v2.size():
			h.update(v2.slice(o, o + (1 << 20))); o += 1 << 20
		h.finish()))
	var cases := {}
	for c in doc.applyCases:
		cases[c.id] = c
	mat(cases["delta-whole-v1-to-v2"].base)  # warm the seed cache
	out.chunk_reassembly = mbs.call(best(func(): err = {}; apply_chunk(cases["chunk-v1-to-v2"])))
	var d: Dictionary = cases["delta-whole-v1-to-v2"].delta
	var v1 := mat(cases["delta-whole-v1-to-v2"].base)
	var art := raw(d.artifact.blob)
	out.delta_apply_verified = mbs.call(best(func(): err = {}; apply_delta(v1, d, art, false)))
	out.delta_engine_decode_only = mbs.call(best(func(): patch_from(v1, art)))
	out.file_delta_rebuild = mbs.call(best(func(): err = {}; apply_files(cases["file-delta-v1-to-v2"])))
	var tix := raw("chunks/v2.pkc")
	out.parse_chunk_index_1531 = "%.2f ms" % best(func(): err = {}; parse_index(tix), 5)
	var pd := {}
	for c in doc.planCases:
		pd[c.id] = c
	out.plan_real_case = "%.2f ms" % best(func(): plan(pd["plan-real-v1-v2"].input), 5)
	out.engine = Engine.get_version_info().string
	out.debug_build = OS.is_debug_build()
	print(JSON.stringify(out, " "))

func _init() -> void:
	vroot = OS.get_cmdline_user_args()[0]
	DirAccess.make_dir_recursive_absolute("user://xl")
	if vroot == "probe":  # probe <delta> <old> <new>: engine patch-from on arbitrary inputs
		var a := OS.get_cmdline_user_args()
		var out := patch_from(FileAccess.get_file_as_bytes(a[2]), FileAccess.get_file_as_bytes(a[1]))
		var want := FileAccess.get_file_as_bytes(a[3])
		print("godot engine patch-from %s: %s (%d bytes)" % [a[1].get_file(), "OK" if out == want else "FAIL", out.size()])
		quit(0)
		return
	if OS.get_cmdline_user_args().size() > 1 and OS.get_cmdline_user_args()[1] == "bench":
		bench()
		quit(0)
		return
	var doc = JSON.parse_string(FileAccess.get_file_as_string(vroot.path_join("cases.json")))
	var n := 0
	var bad := 0
	for name in doc.blobs:
		if sha(raw(name)) != doc.blobs[name].sha256:
			print("VECTOR INTEGRITY FAIL ", name)
			bad += 1
	var t0 := Time.get_ticks_msec()
	var timings := {}
	for g in ["chunkIndexCases", "applyCases", "planCases", "pathCases"]:
		for c in doc[g]:
			var t1 := Time.get_ticks_usec()
			var got
			match g:
				"chunkIndexCases":
					err = {}
					var ix := parse_index(raw_mut(c.index))
					got = err if err else summary(ix)
				"applyCases":
					got = apply_case(c)
				"planCases":
					got = plan(c.input)
				_:
					got = check_paths(c.paths)
			timings[c.id] = (Time.get_ticks_usec() - t1) / 1000.0
			n += 1
			if canon(got) != canon(c.expected):
				bad += 1
				print("FAIL %s/%s\n  got      %s\n  expected %s" % [g, c.id, canon(got).left(400), canon(c.expected).left(400)])
			elif OS.get_environment("VERBOSE") != "":
				print("ok   %s/%s %.1f ms" % [g, c.id, timings[c.id]])
	var vi := Engine.get_version_info()
	print("godot %s [engine zstd via PackedByteArray.decompress + GDDL delta PCK; %d patch-from calls, %d mounts]: %d/%d cases match, %d ms" % [
		vi.string, stats.patch_from_calls, stats.mounts, n - bad, n, Time.get_ticks_msec() - t0])
	quit(1 if bad else 0)
