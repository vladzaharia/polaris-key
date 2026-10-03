extends RefCounted
# @pkey-feature packs.index.chunks packs.apply.chunk packs.state
# P4-11's chunk sync in the engine (the parts no content/ corpus row can carry), a port of
# client-core's packsChunk.test.ts over the same synthetic layout: 64 KiB raw chunks, v1 = a b c d e
# f in bundle B1, v2 = a g c h i f j with B2 = g x h i y j, so v2's runs are [g], [h i], [j].
#
#   adapter   PKeyPackChunks.accepted_length (the exact Content-Range and ETag rule) and
#             chunk_range_fetch (refused bodies closed unread, accepted ones cut at the range)
#   seed      v1 installs by full, and afterwards the seed store keeps its index (index/<sha256>)
#   chunk     v2 installs by chunk: range requests == the plan's requests − 1, each with If-Range
#   refused   a server answering 200 to a range request: the install falls back and succeeds
#   resume    the 2nd range request cut mid-body: network-error (detail chunk) keeping the plan and
#             the run journal ("01"); the next process resumes, reusing run 0
#   crosspack a chunk pack B moves a chunk from pack A: it is copied from A's payload, not fetched
#   delegated a delegated tree carrying `chunks` never plans chunk (nothing staged or ranged) and its
#             writes still meet the data-only rule; no delegated byte reaches load_resource_pack
#   http      the same over HTTPClient against PKeyFakeServer: the exact Range, If-Range and
#             Accept-Encoding headers, a body dropped mid-run resumed, a wrong ETag refused, and a
#             cross-origin redirect that never carries Authorization
#
# The corpus runner (test_content.gd) reads the content/ corpus's chunkIndexCases and chunk
# applyCases; this group holds the engine and transport behaviour around them.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")
const PACK := "djdl.blob"
const K := 65536

var c := {}


func run(t: PKeyTestContext) -> void:
	for label in ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "x", "y", "z", "p", "q"]:
		c[label] = F.chunk_bytes("p4-11 chunk " + label)
	await _adapter(t)
	await _seed_and_chunk(t)
	await _refused(t)
	await _no_range(t)
	_seed_cap(t)
	await _resume(t)
	await _crosspack(t)
	await _delegated(t)
	await _http(t)


func _v1() -> Dictionary:
	return F.chunk_pack(PACK, "1.0.0", 1, [c.a, c.b, c.c, c.d, c.e, c.f], [[c.a, c.b, c.c, c.d, c.e, c.f]])


func _v2() -> Dictionary:
	return F.chunk_pack(PACK, "1.1.0", 2, [c.a, c.g, c.c, c.h, c.i, c.f, c.j], [[c.a, c.b, c.c, c.d, c.e, c.f], [c.g, c.x, c.h, c.i, c.y, c.j]])


func _engine(root: String, tr: PKeyPackTransport, packs: Array) -> PKeyPackEngine:
	var e := F.engine(root, tr, F.stamp_for(packs))
	e.register_handler(F.BlobHandler.new())
	return e


static func _ranges(calls: Array) -> Array:
	return calls.map(func(q): return [q["sha256"], int(q["offset"]), int(q["length"])])


## A root with v1 installed by full (the seed for the chunk scenarios). {root, engine}.
func _with_v1(tag: String, tr: F.FakeTransport, v1: Dictionary) -> Dictionary:
	var root := S.scratch(tag)
	var e := _engine(root, tr, [v1])
	await e.load_state([])
	var r := await e.ensure([PACK])
	return {"root": root, "engine": e, "ok": r.ok}


# ── adapter ─────────────────────────────────────────────────────────────────────────────────

func _adapter(t: PKeyTestContext) -> void:
	var b := "ab".repeat(32)
	var tag := "\"%s\"" % b
	# [status, content_range, etag, offset, length, expected bytes to read (-1 refused), why]
	var rows := [
		[206, "bytes 100-199/1000", tag, 100, 100, 100, "the exact range"],
		[206, "bytes 100-199/1000", null, 100, 100, 100, "no ETag header"],
		[206, "bytes 100-199/1000", "", 100, 100, -1, "an empty ETag"],
		[206, " bytes 100-199/1000 ", tag, 100, 100, 100, "surrounding whitespace"],
		[206, "bytes 900-999/1000", tag, 900, 200, 100, "clipped at the object's end"],
		[206, "bytes 100-199/200", tag, 100, 100, 100, "ending exactly at the end"],
		[200, "", tag, 100, 100, -1, "a 200 (Range ignored)"],
		[206, "bytes 100-199/1000", "\"%s\"" % "cd".repeat(32), 100, 100, -1, "another ETag"],
		[206, "bytes 100-199/1000", "W/" + tag, 100, 100, -1, "a weak ETag"],
		[206, "", tag, 100, 100, -1, "no Content-Range"],
		[206, "bytes 101-199/1000", tag, 100, 100, -1, "another start"],
		[206, "bytes 100-198/1000", tag, 100, 100, -1, "a short end inside the object"],
		[206, "bytes 100-200/1000", tag, 100, 100, -1, "a longer end"],
		[206, "bytes 100-199/199", tag, 100, 100, -1, "an end past the size"],
		[206, "bytes 100-199/*", tag, 100, 100, -1, "an unknown size"],
		[206, "bytes */1000", tag, 100, 100, -1, "an unsatisfied range"],
		[206, "bytes 0-1,100-199/1000", tag, 100, 100, -1, "a multi-range answer"],
		[206, "bytes 100-199/12345678901234567", tag, 100, 100, -1, "a 17-digit size"],
		[206, "items 100-199/1000", tag, 100, 100, -1, "another unit"],
		[416, "bytes */1000", tag, 100, 100, -1, "a 416"],
	]
	for row in rows:
		var got := PKeyPackChunks.accepted_length(row[0], row[1], row[2], b, row[3], row[4])
		t.check("adapter: %s → %s" % [row[6], "refused" if row[5] < 0 else "read %d" % row[5]], got == row[5], str(got))
	# chunk_range_fetch: the request it sends, a refused body closed unread, an accepted one capped.
	var sent: Array = []
	var bodies: Array = []
	var answer := {"status": 206, "content_range": "bytes 0-3/10", "etag": tag}
	var open := func(req: Dictionary) -> Dictionary:
		sent.append(req.duplicate())
		var body := PKeyPackChunks.MemoryBody.new("0123456789".to_ascii_buffer())
		bodies.append(body)
		var out: Dictionary = answer.duplicate()
		out["body"] = body
		out["error"] = ""
		return out
	var fetch := PKeyPackChunks.chunk_range_fetch(open)
	var res: Dictionary = await fetch.call(b, 0, 4)
	S.check_same(t, "adapter: one request with the bounded range and If-Range \"<bundle sha256>\"", sent, [{"sha256": b, "offset": 0, "length": 4, "if_range": tag}])
	var first = await res["body"].take(10) if res.get("status") == "ok" else null
	t.check("adapter: an exact 206 is read, cut at the range's length", first is PackedByteArray and (first as PackedByteArray).get_string_from_ascii() == "0123" and bodies[0].closed, str(first))
	answer["status"] = 200
	answer["content_range"] = ""
	res = await fetch.call(b, 0, 4)
	t.check("adapter: a 200 is refused and its body closed unread", res.get("status") == "refused" and bodies[1].closed and bodies[1].at == 0, S.canon(res.keys()))
	var failing := PKeyPackChunks.chunk_range_fetch(func(_req: Dictionary) -> Dictionary: return {"status": 0, "content_range": "", "etag": "", "error": "network-error", "body": null})
	res = await failing.call(b, 0, 4)
	t.check("adapter: a transport failure before the head is an error (the applier's interrupted)", res.get("status") == "error", S.canon(res))
	t.check("adapter: read_u64 saturates at 2^53 and never reads 64 bits natively", PKeyPackChunks.read_u64(PackedByteArray([1, 0, 0, 0, 0, 0, 32, 0]), 0) == 9007199254740992 and PKeyPackChunks.read_u64(PackedByteArray([255, 255, 255, 255, 255, 255, 31, 0]), 0) == 9007199254740991 and PKeyPackChunks.read_u64(PackedByteArray([7, 0, 0, 0, 255, 255, 255, 255]), 0) == 9007199254740992)


# ── seed and chunk ──────────────────────────────────────────────────────────────────────────

func _seed_and_chunk(t: PKeyTestContext) -> void:
	var v1 := _v1()
	var v2 := _v2()
	var tr := F.FakeTransport.new().add(v1).add(v2)
	var base := await _with_v1("chunks-seed", tr, v1)
	var root: String = base["root"]
	var e: PKeyPackEngine = base["engine"]
	t.check("seed: v1 installs by full (no seed yet)", base["ok"] and tr.calls.map(func(q): return q["sha256"]).has(v1["fullSha256"]) and tr.range_calls.is_empty(), S.canon(tr.calls))
	var kept = e.storage.seed_index_get(v1["indexSha256"])
	t.check("seed: afterwards the seed store keeps v1's index at index/<sha256>", kept is PackedByteArray and F.sha(kept) == v1["indexSha256"] and FileAccess.file_exists(root.path_join("index").path_join(v1["indexSha256"])))

	tr.calls.clear()
	var e2 := _engine(root, tr, [v2])
	await e2.load_state([])
	var pre: Dictionary = await e2._preflight(PACK)
	var plan: Dictionary = pre.get("plan", {})
	t.check("chunk: v2 plans chunk from v1's seed (index + 3 runs: 4 requests)", plan.get("strategy") == "chunk" and int(plan.get("requests", 0)) == 4, S.canon(plan))
	var started := Time.get_ticks_usec()
	var r := await e2.ensure([PACK])
	var ms := (Time.get_ticks_usec() - started) / 1000.0
	var b2: String = v2["bundles"][1]
	S.check_same(t, "chunk: one single-range request per run, the plan's requests − 1 ([g], [h i], [j])", _ranges(tr.range_calls), [[b2, 0, K], [b2, 2 * K, 2 * K], [b2, 5 * K, K]])
	t.check("chunk: every range request carries If-Range \"<bundle sha256>\"", tr.range_calls.all(func(q): return q["if_range"] == "\"%s\"" % q["sha256"]))
	t.check("chunk: v2 commits, and the installed payload hashes to v2", r.ok and e2.doc["active"][PACK]["recordSha256"] == v2["recordSha256"] and F.sha(FileAccess.get_file_as_bytes(e2.storage.container_path(v2["payloadSha256"]))) == v2["payloadSha256"], str(r))
	t.check("chunk: neither v2's full object nor a bundle was fetched whole", not tr.calls.map(func(q): return q["sha256"]).has(v2["fullSha256"]) and tr.calls.filter(func(q): return v2["bundles"].has(q["sha256"])).is_empty(), S.canon(tr.calls))
	t.check("chunk: v2's index joins the seed store; v1's stays while v1 is previous", e2.storage.seed_index_get(v2["indexSha256"]) != null and e2.storage.seed_index_get(v1["indexSha256"]) != null)
	t.check("chunk: nothing left in staging or in flight", e2.doc["inflight"].is_empty() and (e2.storage.list()["plans"] as Array).is_empty())
	t.info("chunk: v1→v2 by chunk in %.1f ms (%d bytes)" % [ms, v2["payload"].size()])
	# GC: once v1 is neither active nor previous, its kept index goes.
	var v3 := F.chunk_pack(PACK, "1.2.0", 3, [c.a, c.g, c.p], [[c.a, c.g, c.p]])
	tr.add(v3)
	var e3 := _engine(root, tr, [v3])
	await e3.load_state([])
	r = await e3.ensure([PACK])
	t.check("seed gc: after v3 (v1 dropped from previous), v1's kept index is collected; v2's and v3's stay", r.ok and e3.storage.seed_index_get(v1["indexSha256"]) == null and e3.storage.seed_index_get(v2["indexSha256"]) != null and e3.storage.seed_index_get(v3["indexSha256"]) != null, str(r))
	S.remove_tree(root)


# ── refused ─────────────────────────────────────────────────────────────────────────────────

func _refused(t: PKeyTestContext) -> void:
	var v1 := _v1()
	var v2 := _v2()
	var tr := F.FakeTransport.new().add(v1).add(v2)
	var base := await _with_v1("chunks-refused", tr, v1)
	var root: String = base["root"]
	tr.calls.clear()
	tr.range_ignored = true
	var e := _engine(root, tr, [v2])
	await e.load_state([])
	var r := await e.ensure([PACK])
	t.check("refused: a 200 to a range request stops the chunk strategy after one request", tr.range_calls.size() == 1, S.canon(_ranges(tr.range_calls)))
	t.check("refused: the install falls back to another strategy and succeeds", r.ok and e.doc["active"][PACK]["recordSha256"] == v2["recordSha256"] and tr.calls.map(func(q): return q["sha256"]).has(v2["fullSha256"]) and F.sha(FileAccess.get_file_as_bytes(e.storage.container_path(v2["payloadSha256"]))) == v2["payloadSha256"], "%s %s" % [r, S.canon(tr.calls)])
	t.check("refused: nothing left in staging or in flight", e.doc["inflight"].is_empty() and (e.storage.list()["plans"] as Array).is_empty())
	S.remove_tree(root)


# ── no range ────────────────────────────────────────────────────────────────────────────────

func _no_range(t: PKeyTestContext) -> void:
	var v1 := _v1()
	var v2 := _v2()
	var tr := F.FakeTransport.new().add(v1).add(v2)
	tr.ranges = false
	var base := await _with_v1("chunks-norange", tr, v1)
	var root: String = base["root"]
	t.check("no range: the base transport refuses ranges (supports_range false, open_range a 501)", not PKeyPackTransport.new().supports_range() and int(PKeyPackTransport.new().open_range({}).get("status", 0)) == 501)
	t.check("no range: v1 installs and its index is still kept as a seed", base["ok"] and base["engine"].storage.seed_index_get(v1["indexSha256"]) != null)
	tr.calls.clear()
	var e := _engine(root, tr, [v2])
	await e.load_state([])
	var pre: Dictionary = await e._preflight(PACK)
	var staged: Array = tr.calls.map(func(q): return q["sha256"])
	var r := await e.ensure([PACK])
	t.check("no range: a transport without range support never plans chunk (its target index is not staged)", pre.get("plan", {}).get("strategy") != "chunk" and not staged.has(v2["indexSha256"]), S.canon(pre.get("plan")))
	t.check("no range: v2 installs by another strategy, with no range request and no network-error", r.ok and tr.range_calls.is_empty() and F.sha(FileAccess.get_file_as_bytes(e.storage.container_path(v2["payloadSha256"]))) == v2["payloadSha256"], str(r))
	S.remove_tree(root)


# ── seed cap ────────────────────────────────────────────────────────────────────────────────

func _seed_cap(t: PKeyTestContext) -> void:
	var root := S.scratch("chunks-seedcap")
	var st := PKeyPackStorage.new(root)
	var small := "11".repeat(32)
	var big := "22".repeat(32)
	S.write_file(st.seed_index_path(small), PackedByteArray([1, 2, 3]))
	var over := PackedByteArray()
	over.resize(PKeyConstants.MAX_CHUNK_INDEX_BYTES + 1)
	S.write_file(st.seed_index_path(big), over)
	var exact := "33".repeat(32)
	over.resize(PKeyConstants.MAX_CHUNK_INDEX_BYTES)
	S.write_file(st.seed_index_path(exact), over)
	t.check("seed cap: a kept index within the bound is read", st.seed_index_get(small) == PackedByteArray([1, 2, 3]))
	var at_cap = st.seed_index_get(exact)
	t.check("seed cap: one of exactly MAX_CHUNK_INDEX_BYTES is read", at_cap is PackedByteArray and (at_cap as PackedByteArray).size() == PKeyConstants.MAX_CHUNK_INDEX_BYTES)
	t.check("seed cap: one above MAX_CHUNK_INDEX_BYTES is absent (null), never read", st.seed_index_get(big) == null)
	t.check("seed cap: put refuses an index above the bound", not st.seed_index_put(big, _oversized()))
	S.remove_tree(root)


static func _oversized() -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(PKeyConstants.MAX_CHUNK_INDEX_BYTES + 1)
	return b


# ── resume ──────────────────────────────────────────────────────────────────────────────────

func _resume(t: PKeyTestContext) -> void:
	var v1 := _v1()
	var v2 := _v2()
	var tr := F.FakeTransport.new().add(v1).add(v2)
	var base := await _with_v1("chunks-resume", tr, v1)
	var root: String = base["root"]
	tr.range_cut_nth = 2
	tr.range_cut_bytes = K + 1000
	var e := _engine(root, tr, [v2])
	await e.load_state([])
	var r := await e.ensure([PACK])
	t.check("resume: the 2nd range request cut mid-body fails the ensure with network-error (detail chunk)", not r.ok and r.code == PKeyErrors.NETWORK and r.detail.get("detail") == "chunk", str(r))
	var j = e.doc["inflight"].get(PACK)
	t.check("resume: the plan stays in flight as a chunk plan", j is Dictionary and j["strategy"] == "chunk", S.canon(j))
	var plan_id: String = j["planId"] if j is Dictionary else ""
	var journal = S.read_json(e.storage.run_journal_path(plan_id))
	S.check_same(t, "resume: the run journal records run 0 done (bitmap \"01\")", journal, {"v": 1, "index": v2["indexSha256"], "runs": 3, "bitmap": "01"})
	# A new process resumes: run 0 is re-hashed from the output and reused.
	tr.range_calls.clear()
	tr.range_cut_nth = -1
	var e2 := _engine(root, tr, [v2])
	await e2.load_state([])
	r = await e2.ensure([PACK])
	var b2: String = v2["bundles"][1]
	S.check_same(t, "resume: only runs 1 and 2 are requested again", _ranges(tr.range_calls), [[b2, 2 * K, 2 * K], [b2, 5 * K, K]])
	t.check("resume: the resumed install commits whole", r.ok and F.sha(FileAccess.get_file_as_bytes(e2.storage.container_path(v2["payloadSha256"]))) == v2["payloadSha256"] and e2.doc["inflight"].is_empty(), str(r))
	# A journalled run whose bytes changed on disk is fetched again (re-hashed, never trusted).
	var root2 := (await _with_v1("chunks-resume-tamper", tr, v1))["root"] as String
	tr.range_calls.clear()
	tr.range_cut_nth = 2
	var e3 := _engine(root2, tr, [v2])
	await e3.load_state([])
	await e3.ensure([PACK])
	var pid: String = e3.doc["inflight"][PACK]["planId"]
	var out_file := e3.storage.out_dir(pid).path_join(PKeyPackStorage.CONTAINER_FILE)
	var f := FileAccess.open(out_file, FileAccess.READ_WRITE)
	f.seek(K + 7)
	f.store_8(0x5A)
	f.close()
	tr.range_calls.clear()
	tr.range_cut_nth = -1
	var e4 := _engine(root2, tr, [v2])
	await e4.load_state([])
	r = await e4.ensure([PACK])
	S.check_same(t, "resume: a journalled run whose output no longer hashes is requested again", _ranges(tr.range_calls), [[b2, 0, K], [b2, 2 * K, 2 * K], [b2, 5 * K, K]])
	t.check("resume: …and the install is whole", r.ok and F.sha(FileAccess.get_file_as_bytes(e4.storage.container_path(v2["payloadSha256"]))) == v2["payloadSha256"], str(r))
	S.remove_tree(root)
	S.remove_tree(root2)


# ── crosspack ───────────────────────────────────────────────────────────────────────────────

func _crosspack(t: PKeyTestContext) -> void:
	var a := F.chunk_pack("djdl.a", "1.0.0", 1, [c.y, c.z], [[c.y, c.z]])
	var b1 := F.chunk_pack("djdl.b", "1.0.0", 1, [c.a, c.b, c.c], [[c.a, c.b, c.c]])
	var b2 := F.chunk_pack("djdl.b", "1.1.0", 2, [c.a, c.y, c.c, c.d], [[c.a, c.b, c.c], [c.d, c.y]])
	var tr := F.FakeTransport.new().add(a).add(b1).add(b2)
	var root := S.scratch("chunks-crosspack")
	var e := _engine(root, tr, [a, b1])
	await e.load_state([])
	var r := await e.ensure(["djdl.a", "djdl.b"])
	t.check("crosspack: A and B v1 install (by full) and both indexes are kept", r.ok and e.storage.seed_index_get(a["indexSha256"]) != null and e.storage.seed_index_get(b1["indexSha256"]) != null, str(r))
	tr.range_calls.clear()
	var e2 := _engine(root, tr, [a, b2])
	await e2.load_state([])
	r = await e2.ensure(["djdl.b"])
	S.check_same(t, "crosspack: B v2 fetches only d (y, moved from A, is copied from A's payload)", _ranges(tr.range_calls), [[b2["bundles"][1], 0, K]])
	t.check("crosspack: B v2 commits whole", r.ok and e2.doc["active"]["djdl.b"]["recordSha256"] == b2["recordSha256"] and F.sha(FileAccess.get_file_as_bytes(e2.storage.container_path(b2["payloadSha256"]))) == b2["payloadSha256"], str(r))
	S.remove_tree(root)


# ── delegated ───────────────────────────────────────────────────────────────────────────────

func _delegated(t: PKeyTestContext) -> void:
	var v1 := _v1()
	var key := F.content_key("djdl-events-2026")
	var g := F.delegation_for(key, "djdl.events", ["files.tree"])
	var chunks := {"format": "pkey-chunks/1", "sha256": v1["indexSha256"], "bytes": v1["objects"][v1["indexSha256"]].size(), "size": v1["objects"][v1["indexSha256"]].size(), "codec": "none"}
	var d := F.tree_pack("djdl.events.halloween", "1.0.0", 1, {"a.json": "{\"k\": \"GDScript\"}"}, null, {"signer": g["signer"], "chunks": chunks})
	var tr := F.FakeTransport.new().add(v1).add(d)
	tr.records[g["sha256"]] = g["jws"]
	var base := await _with_v1("chunks-delegated", tr, v1)
	var root: String = base["root"]
	var e: PKeyPackEngine = base["engine"]
	t.check("delegated: a seed exists (v1's kept index)", base["ok"] and e.storage.seed_index_get(v1["indexSha256"]) != null)
	tr.calls.clear()
	tr.range_calls.clear()
	var mounts: int = e.zstd.stats["mounts"]
	var r := await e.ensure_releases([{"pack": d["packId"], "release": {"sha256": d["recordSha256"], "seq": d["seq"], "version": d["version"]}}])
	t.check("delegated: a delegated tree carrying chunks is still refused by the data-only rule while writing (content, a.json)", not r.ok and String(r.code) == PKeyConstants.ErrorCode.PACK_NOT_DATA_ONLY and r.detail.get("detail") == "content" and r.detail.get("path") == "a.json", str(r))
	t.check("delegated: chunk was never planned: no range request, its chunk index never staged", tr.range_calls.is_empty() and not tr.calls.map(func(q): return q["sha256"]).has(v1["indexSha256"]), S.canon(tr.calls))
	t.check("delegated: no helper pack was mounted for it (no delegated byte reaches load_resource_pack)", int(e.zstd.stats["mounts"]) == mounts and not e.running.has(d["packId"]))
	S.remove_tree(root)


# ── http ────────────────────────────────────────────────────────────────────────────────────

## A transport over PKeyPackHttp (the CDN transport's object calls, without discovery): records
## from memory, objects at `<base>/blobs/<sha256>` with a bearer.
class HttpTransport extends PKeyPackTransport:
	var base := ""
	var records := {}

	func id() -> String:
		return "pkey-cdn"

	func supports_range() -> bool:
		return true

	func fetch_record(sha256: String) -> Dictionary:
		return {"ok": true, "body": String(records[sha256]).to_utf8_buffer()} if records.has(sha256) else {"ok": false, "code": "network-error"}

	func fetch_object(req: Dictionary, on_response: Callable, on_chunk: Callable) -> Dictionary:
		return await PKeyPackHttp.fetch(null, base + "/blobs/" + String(req["sha256"]), {"Authorization": "Bearer t0k"}, int(req.get("offset", 0)), String(req.get("if_range", "")), on_response, on_chunk, 30.0)

	func open_range(req: Dictionary) -> Dictionary:
		return await PKeyPackHttp.open_range(null, base + "/blobs/" + String(req["sha256"]), {"Authorization": "Bearer t0k"}, int(req["offset"]), int(req["length"]), String(req.get("if_range", "")), 30.0)


var _objects := {}
var _mode := ""
var _ranged := 0
var _other: PKeyFakeServer = null


func _serve(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	if path.begins_with("/blobs/") and _mode == "redirect" and req["headers"].has("range"):
		return {"status": 302, "headers": {"Location": _other.base_url() + "/cdn/" + path.get_file()}}
	var h := path.get_file()
	if not _objects.has(h):
		return {"status": 404}
	var b: PackedByteArray = _objects[h]
	var tag := "\"%s\"" % h
	var headers := {"Content-Type": "application/octet-stream", "ETag": tag}
	var r := String(req["headers"].get("range", ""))
	var m := RegEx.create_from_string("^bytes=(\\d+)-(\\d+)$").search(r)
	if m == null or req["headers"].get("if-range") != tag or _mode == "ignore":
		return {"status": 200, "headers": headers, "body": b}
	_ranged += 1
	var o := m.get_string(1).to_int()
	var e := mini(m.get_string(2).to_int(), b.size() - 1)
	headers["Content-Range"] = "bytes %d-%d/%d" % [o, e, b.size()]
	if _mode == "etag":
		headers["ETag"] = "\"%s\"" % "0".repeat(64)
	var body := b.slice(o, e + 1)
	if _mode == "cut" and _ranged == 2:
		headers["Content-Length"] = str(body.size())
		return {"status": 206, "headers": headers, "body": body.slice(0, K + 1000), "truncate": true}
	return {"status": 206, "headers": headers, "body": body}


func _http(t: PKeyTestContext) -> void:
	var v1 := _v1()
	var v2 := _v2()
	for p in [v1, v2]:
		_objects.merge(p["objects"])
	var server := PKeyTestFixtures.new_server(_serve)
	_other = PKeyTestFixtures.new_server(_serve)
	var tr := HttpTransport.new()
	tr.base = server.base_url()
	tr.records = {v1["recordSha256"]: v1["jws"], v2["recordSha256"]: v2["jws"]}
	var b2: String = v2["bundles"][1]
	var tag := "\"%s\"" % b2
	for mode in ["", "cut", "etag", "redirect"]:
		_mode = ""
		var root := S.scratch("chunks-http")
		var e := _engine(root, tr, [v1])
		await e.load_state([])
		var r := await e.ensure([PACK])
		if not t.check("http %s: v1 installs over HTTP" % mode, r.ok, str(r)):
			continue
		_mode = mode
		_ranged = 0
		server.requests.clear()
		_other.requests.clear()
		var e2 := _engine(root, tr, [v2])
		await e2.load_state([])
		r = await e2.ensure([PACK])
		var ranged: Array = server.requests.filter(func(q): return q["headers"].has("range"))
		var payload_ok := func(eng: PKeyPackEngine) -> bool: return F.sha(FileAccess.get_file_as_bytes(eng.storage.container_path(v2["payloadSha256"]))) == v2["payloadSha256"]
		match mode:
			"":
				S.check_same(t, "http: v2 by chunk sends exactly Range: bytes=o-e per run (never a multi-range)", ranged.map(func(q): return [String(q["path"]).get_file(), q["headers"]["range"]]), [[b2, "bytes=0-65535"], [b2, "bytes=131072-262143"], [b2, "bytes=327680-393215"]])
				t.check("http: …each with If-Range \"<bundle sha256>\" and Accept-Encoding: identity", ranged.all(func(q): return q["headers"].get("if-range") == tag and q["headers"].get("accept-encoding") == "identity"))
				t.check("http: …and installs v2 whole", r.ok and payload_ok.call(e2), str(r))
			"cut":
				t.check("http cut: a body dropped mid-run is network-error (detail chunk)", not r.ok and r.code == PKeyErrors.NETWORK and r.detail.get("detail") == "chunk", str(r))
				_mode = ""
				server.requests.clear()
				var e3 := _engine(root, tr, [v2])
				await e3.load_state([])
				r = await e3.ensure([PACK])
				ranged = server.requests.filter(func(q): return q["headers"].has("range"))
				S.check_same(t, "http cut: the next process resumes, requesting only runs 1 and 2", ranged.map(func(q): return q["headers"]["range"]), ["bytes=131072-262143", "bytes=327680-393215"])
				t.check("http cut: …and installs v2 whole", r.ok and payload_ok.call(e3), str(r))
			"etag":
				t.check("http etag: a 206 carrying another ETag is refused after one request, and the install falls back", r.ok and ranged.size() == 1 and payload_ok.call(e2) and server.requests.any(func(q): return String(q["path"]).get_file() == v2["fullSha256"] and not q["headers"].has("range")), "%s %s" % [r, S.canon(server.requests.map(func(q): return q["path"]))])
			"redirect":
				var cdn: Array = _other.requests
				t.check("http redirect: range requests behind a cross-origin redirect install v2", r.ok and payload_ok.call(e2) and cdn.size() == 3, "%s %d" % [r, cdn.size()])
				t.check("http redirect: …the Range and If-Range follow, Authorization never does", cdn.all(func(q): return not q["headers"].has("authorization") and q["headers"].get("if-range") == tag and String(q["headers"].get("range", "")).begins_with("bytes=")) and ranged.all(func(q): return q["headers"].get("authorization") == "Bearer t0k"), S.canon(cdn.map(func(q): return q["headers"])))
		S.remove_tree(root)
	server.queue_free()
	_other.queue_free()
