extends RefCounted
# @pkey-feature sync.files
# The Cloud Sync file transfer engine, journal, chunk cache and file codecs (U-23.G4), against a fake of the
# Worker's file routes behind the transport port. A port of Python test_cloud_sync_files.py for the Godot
# lane (sequential, raw codec 0, 32 MiB cap): kill-and-resume from the journal, the Retry-After hold, the
# 410 restart, a tampered chunk or manifest -> sync-file-invalid, cache damage -> a miss, journal and cache
# names that no id can steer, and the typed unsupported over the lane cap.

const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")
const Journal := preload("res://addons/polaris_key/services/cloud_sync/journal.gd")
const Cache := preload("res://addons/polaris_key/services/cloud_sync/chunk_cache.gd")
const Codec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")

const MIB := 1048576
const NOW := 1000.0


## A fake of the Worker's file routes: parts in any order, chunks per collection, files by version.
class FakeServer:
	extends RefCounted
	var uploads := {}
	var chunks := {}
	var files := []
	var calls: Array[String] = []
	var part_puts: Array[int] = []
	var chunk_puts: Array[String] = []
	var chunk_gets: Array[String] = []
	var aborted: Array[String] = []
	var begin_requests: Array[Dictionary] = []
	var plan_sizes: Array[int] = []
	var seq := 0
	var part_bytes := 100000
	var etag := "\"e1\""
	## Breaks one kind of call: Callable(kind) -> reply Dictionary or null.
	var hook := Callable()
	var tamper_chunk := Callable()
	var tamper_file := Callable()
	## Rewrites the finalize answer: Callable(answer) -> answer (the stored file is untouched).
	var finalize_answer := Callable()

	func _h(kind: String) -> Variant:
		calls.append(kind)
		return hook.call(kind) if hook.is_valid() else null

	func begin(_target: Dictionary, r: Dictionary) -> Dictionary:
		begin_requests.append(r)
		var h: Variant = _h("begin")
		if h != null:
			return h
		seq += 1
		var id := "up%d" % seq
		var mode := "chunks" if r["format"] == "chunks" else ("single" if r["size"] <= 16 * MIB else "multipart")
		uploads[id] = {"size": r["size"], "sha256": r["sha256"], "format": r["format"], "mode": mode, "parts": {}, "manifest": null}
		var out := {"uploadId": id, "mode": mode, "expiresAt": (NOW + 86400) * 1000.0}
		if mode == "multipart":
			out["partBytes"] = part_bytes
		return Transfer.reply_ok(out)

	func status(_target: Dictionary, upload_id: String) -> Dictionary:
		var h: Variant = _h("status")
		if h != null:
			return h
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		var parts: Array = uploads[upload_id]["parts"].keys()
		parts.sort()
		return Transfer.reply_ok({"received": parts})

	func put_single(_target: Dictionary, upload_id: String, body: PackedByteArray, digest: String) -> Dictionary:
		var h: Variant = _h("put_single")
		if h != null:
			return h
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		if PKeySyncHkdf.sha256(body).hex_encode() != digest:
			return Transfer.reply_fail(400, "upload_mismatch")
		var u: Dictionary = uploads[upload_id]
		if u["mode"] == "chunks":
			u["manifest"] = body
		else:
			u["parts"][1] = body
		return Transfer.reply_ok()

	func put_part(_target: Dictionary, upload_id: String, n: int, body: PackedByteArray, digest: String) -> Dictionary:
		var h: Variant = _h("put_part")
		if h != null:
			return h
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		if PKeySyncHkdf.sha256(body).hex_encode() != digest:
			return Transfer.reply_fail(400, "upload_mismatch")
		uploads[upload_id]["parts"][n] = body
		part_puts.append(n)
		return Transfer.reply_ok()

	func abort(_target: Dictionary, upload_id: String) -> Dictionary:
		calls.append("abort")
		aborted.append(upload_id)
		uploads.erase(upload_id)
		return Transfer.reply_ok()

	func plan_chunks(_target: Dictionary, upload_id: String, request: Dictionary) -> Dictionary:
		var h: Variant = _h("plan")
		if h != null:
			return h
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		var missing := []
		var present := []
		plan_sizes.append(request["chunks"].size())
		for e in request["chunks"]:
			if chunks.has(e[0]):
				present.append([e[0], e[1]])
			else:
				missing.append(e[0])
		return Transfer.reply_ok({"missing": missing, "present": present})

	func put_chunk(_target: Dictionary, upload_id: String, chunk_id: String, body: PackedByteArray, digest: String) -> Dictionary:
		var h: Variant = _h("put_chunk")
		if h != null:
			return h
		if not uploads.has(upload_id):
			return Transfer.reply_fail(410, "upload_expired")
		if PKeySyncHkdf.sha256(body).hex_encode() != digest:
			return Transfer.reply_fail(400, "upload_mismatch")
		chunks[chunk_id] = body
		chunk_puts.append(chunk_id)
		return Transfer.reply_ok()

	func finalize(_target: Dictionary, request: Dictionary) -> Dictionary:
		var h: Variant = _h("finalize")
		if h != null:
			return h
		var u: Variant = uploads.get(request["uploadId"])
		if u == null:
			return Transfer.reply_fail(410, "upload_expired")
		var data := PackedByteArray()
		if u["mode"] == "chunks":
			if u["manifest"] == null:
				return Transfer.reply_fail(409, "upload_incomplete", -1.0, {"missing": []})
			data = u["manifest"]
		else:
			var keys: Array = u["parts"].keys()
			keys.sort()
			for k in keys:
				data.append_array(u["parts"][k])
		if PKeySyncHkdf.sha256(data).hex_encode() != u["sha256"]:
			return Transfer.reply_fail(400, "upload_mismatch")
		files.append(data)
		uploads.erase(request["uploadId"])
		var answer := {"version": files.size(), "size": u["size"], "sha256": u["sha256"], "format": u["format"]}
		return Transfer.reply_ok(finalize_answer.call(answer) if finalize_answer.is_valid() else answer)

	func get_file(_target: Dictionary, query: Dictionary) -> Dictionary:
		var h: Variant = _h("get_file")
		if h != null:
			return h
		var data: PackedByteArray = files[files.size() - 1] if query.get("version") == null else files[int(query["version"]) - 1]
		if query.get("if_match") != null and query["if_match"] != etag:
			return Transfer.reply_fail(412, "precondition_failed")
		var body := {"status": 200, "data": data, "etag": etag, "content_range": null}
		var rng: Variant = query.get("range")
		if rng is Array:
			var end := mini(data.size(), rng[1])
			body = {"status": 206, "data": data.slice(rng[0], end), "etag": etag, "content_range": [rng[0], end, data.size()]}
		if tamper_file.is_valid():
			body = tamper_file.call(query, body)
		return Transfer.reply_ok(body)

	func get_chunk(_collection: String, chunk_id: String) -> Dictionary:
		var h: Variant = _h("get_chunk")
		if h != null:
			return h
		chunk_gets.append(chunk_id)
		if not chunks.has(chunk_id):
			return Transfer.reply_fail(404, "not_found")
		var obj: PackedByteArray = chunks[chunk_id]
		return Transfer.reply_ok(tamper_chunk.call(chunk_id, obj) if tamper_chunk.is_valid() else obj)


## A source that counts reads, for the lane cap.
class CountingSource:
	extends RefCounted
	var size := 0
	var reads := 0

	func read(_s: int, _e: int) -> PackedByteArray:
		reads += 1
		return PackedByteArray()


class Sink:
	extends RefCounted
	var data := PackedByteArray()
	var writes := 0

	func put(b: PackedByteArray) -> void:
		data.append_array(b)
		writes += 1


var _sleeps: Array[float] = []


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_codecs(t)
	await _single_and_multipart(t)
	await _resume_and_restart(t)
	await _retries(t)
	await _finalize_answer(t)
	await _chunks_upload(t)
	await _downloads(t)
	await _tampering(t)
	_journal(t)
	_cache(t)
	await _lane(t)
	await _native_lane(t)
	return true


func _engine(srv: Object, journal: Object = null) -> Transfer:
	var e := Transfer.new(srv, journal if journal != null else Journal.Memory.new())
	e.now = func() -> float: return NOW
	e.random = func() -> float: return 0.5
	_sleeps.clear()
	e.sleep = func(s: float) -> void: _sleeps.append(s)
	return e


func _noise(n: int) -> PackedByteArray:
	return Crypto.new().generate_random_bytes(n)


func _sha(b: PackedByteArray) -> String:
	return PKeySyncHkdf.sha256(b).hex_encode()


func _upload_req(id: String, data: PackedByteArray, extra := {}) -> Dictionary:
	var r := {"id": id, "collection": "saves", "record": "rec1", "source": Transfer.BytesSource.new(data), "size": data.size(), "sha256": _sha(data), "enc": "none"}
	r.merge(extra, true)
	return r


## A valid upload journal record with the given members replaced.
func _rec(over := {}) -> Dictionary:
	var r := {
		"v": 1, "id": "i", "kind": "upload", "collection": "c", "record": "r", "uploadId": "u", "mode": "single",
		"partBytes": null, "done": [], "sha256": "a".repeat(64), "size": 350, "expiresAt": 5, "state": "uploading",
	}
	r.merge(over, true)
	return r


func _codecs(t: PKeyTestContext) -> void:
	var root := PackedByteArray()
	root.resize(32)
	for i in 32:
		root[i] = i + 1
	var e2e := Codec.E2e.new(root, "saves")
	var srv := Codec.Server.new()
	var plain := _noise(5000)
	for c in [e2e, srv]:
		var id: PackedByteArray = c.chunk_id(plain)
		var obj: PackedByteArray = c.seal_chunk(id, plain)
		t.check("%s: a sealed chunk is the size the plan declares" % c.enc, obj.size() == c.chunk_object_bytes(plain.size()))
		var o: Dictionary = c.open_chunk(id, obj)
		t.check("%s: a chunk opens to its plaintext" % c.enc, o["ok"] and o["plain"] == plain)
		var other: PackedByteArray = c.chunk_id(_noise(10))
		t.check("%s: a chunk under another id is refused" % c.enc, not c.open_chunk(other, obj)["ok"])
		t.check("%s: stored size and plain size agree" % c.enc, c.plain_size(c.stored_size(4096)) == 4096)
	t.check("e2e: the root is not in the codec's text", not str(e2e).contains(root.hex_encode()))
	var long_obj := PackedByteArray([0, 0])
	long_obj.resize(Codec.SERVER_CHUNK_MAX_STORED_BYTES + 1)
	t.check("server: an object over the stored cap is refused as size", srv.open_chunk(PackedByteArray(), long_obj).get("reason") == "size")
	t.check("server: an unknown codec byte is refused", srv.open_chunk(srv.chunk_id(plain), PackedByteArray([0, 9, 1, 2])).get("reason") == "codec")
	t.check("server: an unknown object version is refused", srv.open_chunk(srv.chunk_id(plain), PackedByteArray([7, 0, 1])).get("reason") == "version")
	# A zstd body declaring more than 1 MiB is refused before any decode.
	var bomb := PackedByteArray([0x28, 0xB5, 0x2F, 0xFD, 0xA0, 0, 0, 0, 0, 0])
	bomb.append_array(PackedByteArray([0, 0, 0, 0]))
	t.check("server: a zstd frame declaring a bomb is refused before decode", srv.open_chunk(srv.chunk_id(plain), PackedByteArray([0, 1]) + bomb).get("reason") in ["size", "decode"])


func _single_and_multipart(t: PKeyTestContext) -> void:
	var srv := FakeServer.new()
	var j := Journal.Memory.new()
	var e := _engine(srv, j)
	var data := _noise(50000)
	var progress := []
	var r: PKeyResult = await e.upload(_upload_req("t1", data, {"on_progress": func(a: int, b: int) -> void: progress.append([a, b])}))
	t.check("single: the upload finalizes", r.ok, str(r))
	t.check("single: the server holds the bytes", srv.files.size() == 1 and srv.files[0] == data)
	t.check("single: the journal record is gone", j.list().is_empty())
	t.check("single: progress reaches the size", progress.size() == 1 and progress[0] == [50000, 50000])

	var big := _noise(350000)
	srv = FakeServer.new()
	j = Journal.Memory.new()
	# The fake answers multipart for the request through FakeMulti.
	e = _engine(FakeMulti.new(srv), j)
	r = await e.upload(_upload_req("t2", big))
	t.check("multipart: the upload finalizes", r.ok, str(r))
	t.check("multipart: parts go in ascending order, sequentially", srv.part_puts == [1, 2, 3, 4], str(srv.part_puts))
	t.check("multipart: the stored file is the source", srv.files.size() == 1 and srv.files[0] == big)
	var mism := _engine(srv, Journal.Memory.new())
	var bad := _upload_req("t3", big)
	bad["sha256"] = _sha(_noise(10))
	srv.calls.clear()
	r = await mism.upload(bad)
	t.check("a source that is not the declared hash is refused, nothing sent", not r.ok and r.detail["reason"] == "source-mismatch" and srv.calls.is_empty())


## Makes the fake begin answer multipart for any size.
class FakeMulti:
	extends RefCounted
	var s: FakeServer

	func _init(p_s: FakeServer) -> void:
		s = p_s

	func begin(target: Dictionary, r: Dictionary) -> Dictionary:
		var out := s.begin(target, r)
		var v: Dictionary = out["value"]
		if v["mode"] == "single":
			v["mode"] = "multipart"
			v["partBytes"] = s.part_bytes
			s.uploads[v["uploadId"]]["mode"] = "multipart"
		return out

	func status(a, b): return s.status(a, b)
	func put_single(a, b, c, d): return s.put_single(a, b, c, d)
	func put_part(a, b, c, d, e): return s.put_part(a, b, c, d, e)
	func abort(a, b): return s.abort(a, b)
	func finalize(a, b): return s.finalize(a, b)
	func plan_chunks(a, b, c): return s.plan_chunks(a, b, c)
	func put_chunk(a, b, c, d, e): return s.put_chunk(a, b, c, d, e)
	func get_file(a, b): return s.get_file(a, b)
	func get_chunk(a, b): return s.get_chunk(a, b)


func _resume_and_restart(t: PKeyTestContext) -> void:
	var srv := FakeServer.new()
	var multi := FakeMulti.new(srv)
	var j := Journal.Memory.new()
	var big := _noise(350000)
	var cancel := Transfer.Cancel.new()
	# Kill after two parts: the cancel flag stands in for the process dying.
	srv.hook = func(kind: String) -> Variant:
		if kind == "put_part" and srv.part_puts.size() == 1:
			cancel.cancelled = true
		return null
	var e := _engine(multi, j)
	var r: PKeyResult = await e.upload(_upload_req("k1", big, {"cancel": cancel}))
	t.check("kill: the cancelled transfer reports cancelled", not r.ok and r.code == &"cancelled", str(r))
	var rec: Dictionary = j.get_record("k1")
	t.check("kill: the journal keeps ascending done parts", rec["done"] == [1, 2] and rec["state"] == "uploading", str(rec))
	srv.hook = Callable()
	e = _engine(multi, j)
	r = await e.upload(_upload_req("k1", big))
	t.check("resume: the second run finalizes", r.ok, str(r))
	t.check("resume: only the missing parts are sent", srv.part_puts == [1, 2, 3, 4], str(srv.part_puts))
	t.check("resume: one begin only", srv.begin_requests.size() == 1)
	t.check("resume: the stored file is the source", srv.files.size() == 1 and srv.files[0] == big)

	# A part the journal calls done but the server lost is sent again.
	srv = FakeServer.new()
	multi = FakeMulti.new(srv)
	j = Journal.Memory.new()
	cancel = Transfer.Cancel.new()
	srv.hook = func(kind: String) -> Variant:
		if kind == "put_part" and srv.part_puts.size() == 1:
			cancel.cancelled = true
		return null
	await _engine(multi, j).upload(_upload_req("k2", big, {"cancel": cancel}))
	var up_id: String = srv.uploads.keys()[0]
	srv.uploads[up_id]["parts"].erase(2)
	srv.hook = Callable()
	r = await _engine(multi, j).upload(_upload_req("k2", big))
	t.check("resume: a part the server lost is sent again", r.ok and srv.files[0] == big and srv.part_puts.count(2) == 2, str(srv.part_puts))

	# 410 inside an upload restarts it; 404 or 410 on begin is a rejection.
	srv = FakeServer.new()
	var n := [0]
	srv.hook = func(kind: String) -> Variant:
		if kind == "put_single" and n[0] == 0:
			n[0] = 1
			return Transfer.reply_fail(410, "upload_expired")
		return null
	var data := _noise(2000)
	r = await _engine(srv).upload(_upload_req("g1", data))
	t.check("410: an expired upload begins afresh and succeeds", r.ok and srv.begin_requests.size() == 2 and srv.files[0] == data, str(r))
	srv = FakeServer.new()
	srv.hook = func(kind: String) -> Variant:
		return Transfer.reply_fail(410, "upload_expired") if kind in ["put_single"] else null
	r = await _engine(srv).upload(_upload_req("g2", data))
	t.check("410: a upload that keeps vanishing ends restarts-exhausted", not r.ok and r.detail["reason"] == "restarts-exhausted" and srv.begin_requests.size() == 4, str(r))
	for status in [404, 410]:
		srv = FakeServer.new()
		srv.hook = func(kind: String) -> Variant:
			return Transfer.reply_fail(status, "gone") if kind == "begin" else null
		r = await _engine(srv).upload(_upload_req("g3", data))
		t.check("%d on begin is a rejection, not a restart" % status, not r.ok and r.detail["reason"] == "rejected" and srv.begin_requests.size() == 1, str(r))
	# 409 carries the server version; the journal record is dropped when finalize refuses.
	srv = FakeServer.new()
	srv.hook = func(kind: String) -> Variant:
		return Transfer.reply_fail(409, "revision_conflict", -1.0, {"server": {"version": 7}}) if kind == "begin" else null
	r = await _engine(srv).upload(_upload_req("g4", data, {"base_version": 3}))
	t.check("409: a stale base version carries the server's", not r.ok and r.detail["reason"] == "conflict" and r.detail["serverVersion"] == 7, str(r))
	t.check("409: the base version was sent", srv.begin_requests[0].get("baseVersion") == 3)
	# An expired record begins afresh; an unknown version is left alone.
	srv = FakeServer.new()
	j = Journal.Memory.new()
	j.put("e1", _rec({"id": "e1", "collection": "saves", "record": "rec1", "uploadId": "old", "sha256": _sha(data), "size": data.size(), "expiresAt": (NOW - 5) * 1000.0}))
	r = await _engine(srv, j).upload(_upload_req("e1", data))
	t.check("expiry: a record past expiresAt is dropped and the upload begins afresh", r.ok and srv.begin_requests.size() == 1, str(r))
	# expiresAt is milliseconds: a record live in ms is resumed (a status call), one past in ms is not, although
	# its number (995000) would read as live in seconds.
	var live := Journal.Memory.new()
	live.put("e2", _rec({"id": "e2", "collection": "saves", "record": "rec1", "uploadId": "up1", "sha256": _sha(data), "size": data.size(), "expiresAt": (NOW + 100) * 1000.0}))
	var srv_live := FakeServer.new()
	await _engine(srv_live, live).upload(_upload_req("e2", data))
	t.check("expiry: a record live in milliseconds is resumed", srv_live.calls.has("status"), str(srv_live.calls))
	t.check("expiry: ... and one past in milliseconds is not", not srv.calls.has("status"), str(srv.calls))
	j.put("v2", {"v": 2, "id": "v2", "anything": true})
	srv.calls.clear()
	r = await _engine(srv, j).upload(_upload_req("v2", data))
	t.check("journal: an unknown version stops the transfer", not r.ok and r.detail["reason"] == "journal-version" and srv.calls.is_empty(), str(r))
	t.check("journal: ... and the record is left as found", j.get_record("v2") == {"v": 2, "id": "v2", "anything": true})


func _retries(t: PKeyTestContext) -> void:
	var data := _noise(3000)
	var srv := FakeServer.new()
	var n := [0]
	srv.hook = func(kind: String) -> Variant:
		if kind == "begin" and n[0] < 2:
			n[0] += 1
			return Transfer.reply_fail(429, "rate_limited", 7.0)
		return null
	var r: PKeyResult = await _engine(srv).upload(_upload_req("r1", data))
	t.check("retry-after: the engine waits the told time, twice", r.ok and _sleeps.size() >= 1 and _sleeps[0] == 7.0, str(_sleeps))
	# The hold is the pass's: after a Retry-After on one call, the next request of the pass waits too.
	srv = FakeServer.new()
	n = [0]
	var clock := [NOW]
	srv.hook = func(kind: String) -> Variant:
		if kind == "put_single" and n[0] == 0:
			n[0] = 1
			return Transfer.reply_fail(503, "unavailable", 4.0)
		return null
	var e := _engine(srv)
	e.now = func() -> float: return clock[0]
	e.sleep = func(s: float) -> void:
		_sleeps.append(s)
		clock[0] += s
	r = await e.upload(_upload_req("r2", data))
	t.check("retry: a 503 is retried after its Retry-After", r.ok and _sleeps == [4.0], str(_sleeps))
	# Without Retry-After the wait doubles with jitter; a 400-class refusal is never retried.
	srv = FakeServer.new()
	srv.hook = func(kind: String) -> Variant: return Transfer.reply_fail(0, "") if kind == "begin" else null
	r = await _engine(srv).upload(_upload_req("r3", data))
	t.check("no answer: retried, then retries-exhausted", not r.ok and r.detail["reason"] == "retries-exhausted" and srv.begin_requests.size() == 8, str(r))
	t.check("backoff: starts at 0.375 (0.5 s, half jitter) and doubles", _sleeps.size() == 7 and is_equal_approx(_sleeps[0], 0.375) and is_equal_approx(_sleeps[1], 0.75), str(_sleeps))
	srv = FakeServer.new()
	srv.hook = func(kind: String) -> Variant: return Transfer.reply_fail(403, "forbidden") if kind == "begin" else null
	r = await _engine(srv).upload(_upload_req("r4", data))
	t.check("403 is a rejection, not retried", not r.ok and r.detail["reason"] == "rejected" and srv.begin_requests.size() == 1)
	srv = FakeServer.new()
	srv.hook = func(kind: String) -> Variant: return Transfer.reply_fail(400, "upload_mismatch") if kind == "finalize" else null
	r = await _engine(srv).upload(_upload_req("r5", data))
	t.check("upload_mismatch surfaces and releases the upload", not r.ok and r.detail["reason"] == "mismatch" and srv.aborted.size() == 1, str(r))


func _finalize_answer(t: PKeyTestContext) -> void:
	var lies := {
		"size": func(a: Dictionary) -> Dictionary: return a.merged({"size": a["size"] + 1}, true),
		"sha256": func(a: Dictionary) -> Dictionary: return a.merged({"sha256": "ab".repeat(32)}, true),
		"format": func(a: Dictionary) -> Dictionary: return a.merged({"format": "chunks" if a["format"] == "whole" else "whole"}, true),
		"version": func(a: Dictionary) -> Dictionary: return a.merged({"version": 0}, true),
	}
	for name: String in lies:
		for data: PackedByteArray in [_noise(100), _noise(350000)]:
			var srv := FakeServer.new()
			srv.finalize_answer = lies[name]
			var r: PKeyResult = await _engine(FakeMulti.new(srv)).upload(_upload_req("f-" + name, data))
			t.check("finalize answer: a different %s is refused, nothing adopted (%d bytes)" % [name, data.size()], not r.ok and r.detail["reason"] == "file-invalid" and r.detail["detail"] == "finalize", str(r))
		var csrv := FakeServer.new()
		csrv.finalize_answer = lies[name]
		var cr: PKeyResult = await _engine(csrv).upload_chunked(_chunked_req("fc-" + name, _noise(200000), Codec.Server.new()))
		t.check("finalize answer: a different %s is refused for a chunked file" % name, not cr.ok and cr.detail["reason"] == "file-invalid" and cr.detail["detail"] == "finalize", str(cr))
	var bsrv := FakeServer.new()
	bsrv.finalize_answer = func(a: Dictionary) -> Dictionary: return a.merged({"version": 3}, true)
	var br: PKeyResult = await _engine(bsrv).upload(_upload_req("f-base", _noise(100), {"base_version": 3}))
	t.check("finalize answer: a version that is not newer than the base is refused", not br.ok and br.detail["reason"] == "file-invalid", str(br))


func _chunked_req(id: String, data: PackedByteArray, codec: Object, extra := {}) -> Dictionary:
	var r := {"id": id, "collection": "saves", "record": "rec1", "source": Transfer.BytesSource.new(data), "codec": codec}
	r.merge(extra, true)
	return r


func _chunks_upload(t: PKeyTestContext) -> void:
	var codec := Codec.Server.new()
	var srv := FakeServer.new()
	var j := Journal.Memory.new()
	var data := _noise(2 * MIB + 12345)
	var r: PKeyResult = await _engine(srv, j).upload_chunked(_chunked_req("c1", data, codec))
	t.check("chunks: the upload finalizes", r.ok, str(r))
	t.check("chunks: begin asked for format chunks with the manifest's hash", srv.begin_requests[0]["format"] == "chunks" and srv.begin_requests[0]["enc"] == "none")
	var first_puts := srv.chunk_puts.size()
	t.check("chunks: several chunks were cut and sent", first_puts >= 4, str(first_puts))
	t.check("chunks: the journal record is gone", j.list().is_empty())
	# A second version with one byte changed sends only the changed chunk(s).
	var edited := data.duplicate()
	edited[MIB + 5] = (edited[MIB + 5] + 1) % 256
	srv.chunk_puts.clear()
	r = await _engine(srv, j).upload_chunked(_chunked_req("c2", edited, codec))
	t.check("delta: the second version finalizes", r.ok, str(r))
	t.check("delta: only the changed chunks are sent", srv.chunk_puts.size() >= 1 and srv.chunk_puts.size() < first_puts, "%d of %d" % [srv.chunk_puts.size(), first_puts])
	srv.chunk_puts.clear()
	r = await _engine(srv, j).upload_chunked(_chunked_req("c3", edited, codec))
	t.check("delta: an identical reupload sends no chunk at all", r.ok and srv.chunk_puts.is_empty())
	# Plan: ids once each, at most 1,024 a call.
	t.check("plan: every call is within 1,024 ids", srv.plan_sizes.all(func(n: int) -> bool: return n <= 1024))
	# A kill leaves a chunks record; the next run releases that upload and reuses the chunks.
	var srv2 := FakeServer.new()
	var j2 := Journal.Memory.new()
	var cancel := Transfer.Cancel.new()
	srv2.hook = func(kind: String) -> Variant:
		if kind == "put_chunk" and srv2.chunk_puts.size() == 1:
			cancel.cancelled = true
		return null
	r = await _engine(srv2, j2).upload_chunked(_chunked_req("c4", data, codec, {"cancel": cancel}))
	t.check("kill: the chunked transfer reports cancelled", not r.ok and r.code == &"cancelled")
	var rec: Variant = j2.get_record("c4")
	t.check("kill: the journal holds a chunks record with no parts", rec is Dictionary and rec["mode"] == "chunks" and rec["done"] == [])
	srv2.hook = Callable()
	var sent_before := srv2.chunk_puts.size()
	r = await _engine(srv2, j2).upload_chunked(_chunked_req("c4", data, codec))
	t.check("resume: the next run finalizes", r.ok, str(r))
	t.check("resume: the previous upload was aborted", srv2.aborted.size() == 1)
	t.check("resume: chunks already stored are not sent again", srv2.chunk_puts.size() - sent_before == first_puts - sent_before, "%d vs %d" % [srv2.chunk_puts.size(), first_puts])
	# A plan that names an id it was not asked is refused and the upload released.
	var srv3 := FakeServer.new()
	srv3.hook = func(kind: String) -> Variant:
		return Transfer.reply_ok({"missing": ["f".repeat(64)], "present": []}) if kind == "plan" else null
	r = await _engine(srv3).upload_chunked(_chunked_req("c5", _noise(200000), codec))
	t.check("plan: an unasked id is a bad reply", not r.ok and r.detail["reason"] == "bad-reply" and srv3.aborted.size() == 1, str(r))
	# A begin that does not answer chunks is refused.
	var srv4 := FakeServer.new()
	srv4.hook = func(kind: String) -> Variant:
		return Transfer.reply_ok({"uploadId": "x", "mode": "single", "expiresAt": (NOW + 5) * 1000.0}) if kind == "begin" else null
	r = await _engine(srv4).upload_chunked(_chunked_req("c6", _noise(1000), codec))
	t.check("begin: a mode other than chunks is a bad reply", not r.ok and r.detail["reason"] == "bad-reply")
	# End to end: the server holds sealed chunks (never the plaintext) and a sealed manifest.
	var root := PackedByteArray()
	root.resize(32)
	root.fill(9)
	var e2e := Codec.E2e.new(root, "saves")
	var small := _noise(180000)
	var srv5 := FakeServer.new()
	r = await _engine(srv5).upload_chunked(_chunked_req("c7", small, e2e))
	t.check("e2e: the chunked upload finalizes", r.ok and srv5.begin_requests[0]["enc"] == "e2e", str(r))
	var plain_seen := false
	for obj in srv5.chunks.values():
		plain_seen = plain_seen or _contains(obj, small.slice(1000, 1064))
	t.check("e2e: no stored chunk carries the plaintext", not plain_seen)
	# A file edited after it was cut is refused before a wrong chunk is sent.
	var shifty := ShiftySource.new(_noise(300000))
	var srv6 := FakeServer.new()
	r = await _engine(srv6).upload_chunked(_chunked_req("c8", shifty.data, codec, {"source": shifty}))
	t.check("source-mismatch: a file changed after cutting is refused", not r.ok and r.detail["reason"] == "source-mismatch", str(r))


class ShiftySource:
	extends RefCounted
	var data: PackedByteArray
	var size := 0
	var reads := 0

	func _init(d: PackedByteArray) -> void:
		data = d
		size = d.size()

	func read(start: int, end: int) -> PackedByteArray:
		reads += 1
		var out := data.slice(start, end)
		# The cut pass reads in 1 MiB slices (one here); later reads see a changed file.
		if reads > 1 and out.size() > 0:
			out[0] = (out[0] + 1) % 256
		return out


func _contains(hay: PackedByteArray, needle: PackedByteArray) -> bool:
	return hay.hex_encode().contains(needle.hex_encode())


func _downloads(t: PKeyTestContext) -> void:
	var srv := FakeServer.new()
	var data := _noise(3000)
	var e := _engine(srv)
	await e.upload(_upload_req("d1", data))
	var sink := Sink.new()
	var req := {"collection": "saves", "record": "rec1", "format": "whole", "size": data.size(), "sha256": _sha(data), "codec": Codec.Server.new(), "sink": sink.put}
	var r: PKeyResult = await e.download(req)
	t.check("whole: the download delivers the plaintext", r.ok and sink.data == data, str(r))
	# Ranged: more than one range, ETag held with If-Match.
	var big := _noise(9 * MIB)
	var srv2 := FakeServer.new()
	await _engine(srv2).upload(_upload_req("d2", big))
	var seen: Array = []
	srv2.tamper_file = func(q: Dictionary, b: Dictionary) -> Dictionary:
		seen.append(q.duplicate())
		return b
	sink = Sink.new()
	req = {"collection": "saves", "record": "rec1", "format": "whole", "size": big.size(), "sha256": _sha(big), "codec": Codec.Server.new(), "sink": sink.put}
	r = await _engine(srv2).download(req)
	t.check("ranges: the file arrives in two ranges", r.ok and sink.data == big and seen.size() == 2, str(seen.size()))
	t.check("ranges: the second range holds the first answer's ETag", seen.size() == 2 and seen[0]["if_match"] == null and seen[1]["if_match"] == "\"e1\"")
	# An ETag that changes between ranges is refused.
	var flip := [0]
	srv2.tamper_file = func(_q: Dictionary, b: Dictionary) -> Dictionary:
		flip[0] += 1
		if flip[0] == 2:
			b["etag"] = "\"e2\""
		return b
	sink = Sink.new()
	req["sink"] = sink.put
	r = await _engine(srv2).download(req)
	t.check("ranges: a changed ETag is refused", not r.ok and r.detail["reason"] == "bad-reply" and sink.writes == 0, str(r))
	# A short 206 and a Content-Range that does not match are refused.
	srv2.tamper_file = func(_q: Dictionary, b: Dictionary) -> Dictionary:
		if b["status"] == 206:
			b["data"] = (b["data"] as PackedByteArray).slice(0, 10)
		return b
	r = await _engine(srv2).download(req)
	t.check("ranges: a short 206 is refused", not r.ok and r.detail["reason"] == "bad-reply")
	srv2.tamper_file = func(_q: Dictionary, b: Dictionary) -> Dictionary:
		if b["status"] == 206:
			b["content_range"] = [b["content_range"][0] + 1, b["content_range"][1], b["content_range"][2]]
		return b
	r = await _engine(srv2).download(req)
	t.check("ranges: a Content-Range that does not match is refused", not r.ok and r.detail["reason"] == "bad-reply")
	# 200 from a server that ignores Range is taken from the start only.
	srv2.tamper_file = func(_q: Dictionary, b: Dictionary) -> Dictionary: return {"status": 200, "data": big, "etag": b["etag"], "content_range": null}
	sink = Sink.new()
	req["sink"] = sink.put
	r = await _engine(srv2).download(req)
	t.check("ranges: a 200 for the whole file is taken from the start", r.ok and sink.data == big, str(r))
	srv2.tamper_file = func(q: Dictionary, b: Dictionary) -> Dictionary: return {"status": 200, "data": big.slice(0, 5), "etag": b["etag"], "content_range": null} if q["range"][0] == 0 else b
	r = await _engine(srv2).download(req)
	t.check("ranges: a short 200 is refused", not r.ok and r.detail["reason"] == "bad-reply", str(r))
	# Stored bytes that do not hash to the record: file-invalid, nothing delivered.
	var bad := req.duplicate()
	bad["sha256"] = _sha(_noise(4))
	srv2.tamper_file = Callable()
	sink = Sink.new()
	bad["sink"] = sink.put
	r = await _engine(srv2).download(bad)
	t.check("whole: stored bytes that do not hash are sync-file-invalid", not r.ok and r.code == &"sync-file-invalid" and sink.writes == 0, str(r))
	bad = req.duplicate()
	bad["sha256"] = "XYZ"
	r = await _engine(srv2).download(bad)
	t.check("whole: a sha256 that is not hex is sync-file-invalid", not r.ok and r.code == &"sync-file-invalid")
	bad = req.duplicate()
	bad["size"] = 0
	r = await _engine(srv2).download(bad)
	t.check("whole: a zero size is sync-file-invalid", not r.ok and r.code == &"sync-file-invalid")
	# A 404 on a download is a rejection.
	var srv3 := FakeServer.new()
	await _engine(srv3).upload(_upload_req("d3", data))
	srv3.hook = func(kind: String) -> Variant: return Transfer.reply_fail(404, "not_found") if kind == "get_file" else null
	r = await _engine(srv3).download({"collection": "saves", "record": "rec1", "format": "whole", "size": data.size(), "sha256": _sha(data), "codec": Codec.Server.new(), "sink": Sink.new().put})
	t.check("whole: 404 on a download is a rejection", not r.ok and r.detail["reason"] == "rejected" and srv3.begin_requests.size() == 1)
	# E2E whole: a flipped byte fails its tag.
	var root := PackedByteArray()
	root.resize(32)
	root.fill(3)
	var e2e := Codec.E2e.new(root, "saves")
	var plain := _noise(20000)
	var stored := e2e.seal_whole(plain)
	var srv4 := FakeServer.new()
	await _engine(srv4).upload(_upload_req("d4", stored, {"enc": "e2e"}))
	var ereq := {"collection": "saves", "record": "rec1", "format": "whole", "size": stored.size(), "sha256": _sha(stored), "codec": e2e, "sink": Callable()}
	sink = Sink.new()
	ereq["sink"] = sink.put
	r = await _engine(srv4).download(ereq)
	t.check("e2e whole: the plaintext round-trips", r.ok and sink.data == plain, str(r))
	var tampered := stored.duplicate()
	tampered[tampered.size() - 40] = (tampered[tampered.size() - 40] + 1) % 256
	srv4.files[0] = tampered
	ereq["sha256"] = _sha(tampered)
	sink = Sink.new()
	ereq["sink"] = sink.put
	r = await _engine(srv4).download(ereq)
	t.check("e2e whole: a flipped byte is sync-file-invalid (tag) and nothing is delivered", not r.ok and r.code == &"sync-file-invalid" and sink.writes == 0, str(r))
	# Chunked: round trip; the cache fills; a second read needs no chunk.
	var codec := Codec.Server.new()
	var cdata := _noise(2 * MIB + 77)
	var srv5 := FakeServer.new()
	await _engine(srv5).upload_chunked(_chunked_req("d5", cdata, codec))
	var manifest: PackedByteArray = srv5.files[0]
	var cache := Cache.Memory.new()
	var creq := {"collection": "saves", "record": "rec1", "format": "chunks", "size": cdata.size(), "sha256": _sha(manifest), "codec": codec, "cache": cache, "sink": Callable()}
	sink = Sink.new()
	creq["sink"] = sink.put
	r = await _engine(srv5).download(creq)
	t.check("chunks: the download delivers the plaintext", r.ok and sink.data == cdata, str(r))
	var fetched := srv5.chunk_gets.size()
	t.check("chunks: every chunk was fetched once", fetched >= 4)
	sink = Sink.new()
	creq["sink"] = sink.put
	r = await _engine(srv5).download(creq)
	t.check("chunks: a second read is served from the cache", r.ok and sink.data == cdata and srv5.chunk_gets.size() == fetched)
	# A cache that holds garbage under a real id is a miss: the chunk is fetched and the entry replaced.
	var first_id: String = srv5.chunks.keys()[0]
	cache.put(first_id, _noise(500))
	sink = Sink.new()
	creq["sink"] = sink.put
	r = await _engine(srv5).download(creq)
	t.check("cache damage: a damaged entry is a miss, the download still passes", r.ok and sink.data == cdata and srv5.chunk_gets.size() == fetched + 1, str(r))
	t.check("cache damage: the entry was replaced by the good object", (cache.get_object(first_id) as PackedByteArray) == srv5.chunks[first_id])


func _tampering(t: PKeyTestContext) -> void:
	var codec := Codec.Server.new()
	var cdata := _noise(MIB + 4321)
	var srv := FakeServer.new()
	await _engine(srv).upload_chunked(_chunked_req("x1", cdata, codec))
	var manifest: PackedByteArray = srv.files[0]
	var base := {"collection": "saves", "record": "rec1", "format": "chunks", "size": cdata.size(), "sha256": _sha(manifest), "codec": codec}
	var sink := Sink.new()
	var req := base.duplicate()
	req["sink"] = sink.put
	# A flipped byte in a chunk: the id of the plaintext no longer matches.
	srv.tamper_chunk = func(_id: String, obj: PackedByteArray) -> PackedByteArray:
		var o := obj.duplicate()
		o[o.size() - 1] = (o[o.size() - 1] + 1) % 256
		return o
	var r: PKeyResult = await _engine(srv).download(req)
	t.check("tampered chunk (server): sync-file-invalid, nothing delivered", not r.ok and r.code == &"sync-file-invalid" and sink.writes == 0, str(r))
	# An object over the stored cap is refused before opening.
	srv.tamper_chunk = func(_id: String, obj: PackedByteArray) -> PackedByteArray:
		var o := obj.duplicate()
		o.resize(Codec.SERVER_CHUNK_MAX_STORED_BYTES + 1)
		return o
	r = await _engine(srv).download(req)
	t.check("chunk over the stored cap: sync-file-invalid (chunk-size)", not r.ok and r.code == &"sync-file-invalid" and r.detail["detail"] == "chunk-size", str(r))
	# One chunk swapped for another of the same file: its id does not match.
	var keys: Array = srv.chunks.keys()
	srv.tamper_chunk = func(id: String, obj: PackedByteArray) -> PackedByteArray:
		return srv.chunks[keys[1]] if id == keys[0] else obj
	r = await _engine(srv).download(req)
	t.check("swapped chunk: sync-file-invalid", not r.ok and r.code == &"sync-file-invalid", str(r))
	srv.tamper_chunk = Callable()
	# The manifest: a flipped byte fails the declared hash; a wrong declared size fails the cross-check.
	var tm := manifest.duplicate()
	tm[12] = 1  # the flags word of the header
	srv.files[0] = tm
	r = await _engine(srv).download(req)
	t.check("tampered manifest: sync-file-invalid (sha256)", not r.ok and r.code == &"sync-file-invalid" and r.detail["detail"] == "sha256", str(r))
	srv.files[0] = tm
	var req2 := req.duplicate()
	req2["sha256"] = _sha(tm)
	r = await _engine(srv).download(req2)
	t.check("tampered manifest with a matching hash: still sync-file-invalid (the manifest's own checks)", not r.ok and r.code == &"sync-file-invalid", str(r))
	srv.files[0] = manifest
	var req3 := req.duplicate()
	req3["size"] = cdata.size() + 1
	r = await _engine(srv).download(req3)
	t.check("manifest size disagreeing with the record: sync-file-invalid (size)", not r.ok and r.code == &"sync-file-invalid" and r.detail["detail"] == "size", str(r))
	# E2E: a flipped chunk byte fails the tag.
	var root := PackedByteArray()
	root.resize(32)
	root.fill(5)
	var e2e := Codec.E2e.new(root, "saves")
	var small := _noise(120000)
	var srv2 := FakeServer.new()
	await _engine(srv2).upload_chunked(_chunked_req("x2", small, e2e))
	var ereq := {"collection": "saves", "record": "rec1", "format": "chunks", "size": e2e.stored_size(small.size()), "sha256": _sha(srv2.files[0]), "codec": e2e}
	sink = Sink.new()
	ereq["sink"] = sink.put
	r = await _engine(srv2).download(ereq)
	t.check("e2e chunks: round trip", r.ok and sink.data == small, str(r))
	srv2.tamper_chunk = func(_id: String, obj: PackedByteArray) -> PackedByteArray:
		var o := obj.duplicate()
		o[o.size() - 20] = (o[o.size() - 20] + 1) % 256
		return o
	sink = Sink.new()
	ereq["sink"] = sink.put
	r = await _engine(srv2).download(ereq)
	t.check("e2e chunks: a flipped chunk byte is sync-file-invalid (tag)", not r.ok and r.code == &"sync-file-invalid" and sink.writes == 0, str(r))


func _journal(t: PKeyTestContext) -> void:
	var dir := "user://u23g4_journal_%s" % Crypto.new().generate_random_bytes(4).hex_encode()
	var j := Journal.Files.new(dir)
	var evil := "../../etc/passwd"
	var rec := _rec({"id": evil, "mode": "multipart", "partBytes": 100, "done": [1, 2]})
	j.put(evil, rec)
	var d := DirAccess.open(j.dir)
	var names: Array = d.get_files() if d != null else []
	t.check("journal path: an id with dots and slashes is a file named by a hash", names.size() == 1 and names[0] == Journal.file_name(evil) and names[0].length() == 69, str(names))
	t.check("journal path: nothing is written outside the journal directory", not FileAccess.file_exists(dir.path_join("../../etc/passwd")))
	t.check("journal: the record reads back", j.get_record(evil) == rec)
	t.check("journal: parse accepts it", Journal.parse(j.get_record(evil))["ok"])
	t.check("journal: list returns the id", j.list() == [evil])
	# Strangers in the directory are ignored by list.
	var f := FileAccess.open(j.dir.path_join("evil.json"), FileAccess.WRITE)
	f.store_string("{}")
	f.close()
	var liar := Journal.file_name("someone-else")
	f = FileAccess.open(j.dir.path_join(liar), FileAccess.WRITE)
	f.store_string(JSON.stringify(rec))
	f.close()
	t.check("journal: list keeps only a record in the file its own id names", j.list() == [evil], str(j.list()))
	# Garbage reads as a miss; a foreign version is returned as found and refused by parse.
	f = FileAccess.open(j.dir.path_join(Journal.file_name("junk")), FileAccess.WRITE)
	f.store_string("not json")
	f.close()
	t.check("journal: a file that is not JSON is a miss", j.get_record("junk") == null)
	var foreign := {"v": 9, "id": "fv"}
	j.put("fv", foreign)
	t.check("journal: a foreign version is returned as found and parse refuses it", j.get_record("fv") == foreign and Journal.parse(foreign)["reason"] == "version")
	var multi := {"mode": "multipart", "partBytes": 100}
	for bad in [{"v": 1}, "x", null, [1], _rec(multi.merged({"done": [2, 1]})), _rec(multi.merged({"done": [9]})), _rec({"mode": "chunks", "done": [1]})]:
		t.check("journal: parse refuses a malformed record", not Journal.parse(bad)["ok"])
	t.check("journal: a record holds ids, counts and hashes only", not JSON.stringify(rec).contains("token") and not JSON.stringify(rec).contains("key\""))
	j.delete(evil)
	t.check("journal: delete removes the record", j.get_record(evil) == null)
	j.clear()
	t.check("journal: clear purges every record", j.list().is_empty() and (DirAccess.open(j.dir) == null or DirAccess.open(j.dir).get_files().is_empty()))
	_rm(dir)


func _cache(t: PKeyTestContext) -> void:
	var id := "ab".repeat(32)
	var m := Cache.Memory.new(100)
	t.check("cache: names are hex ids only", Cache.is_id(id) and not Cache.is_id("../x") and not Cache.is_id(id + "0") and not Cache.is_id(id.to_upper()))
	m.put("../escape", PackedByteArray([1]))
	t.check("cache: a bad id is never stored", m.get_object("../escape") == null)
	m.put(id, PackedByteArray([1, 2, 3]))
	t.check("cache: memory returns what was put", m.get_object(id) == PackedByteArray([1, 2, 3]))
	var a := "01".repeat(32)
	var b := "02".repeat(32)
	var c := "03".repeat(32)
	var lru := Cache.Memory.new(10)
	lru.put(a, _noise(4))
	lru.put(b, _noise(4))
	lru.get_object(a)
	lru.put(c, _noise(4))
	t.check("cache: the least recently used goes first", lru.get_object(b) == null and lru.get_object(a) != null and lru.get_object(c) != null)
	t.check("cache: an object over the budget is not kept", Cache.Memory.new(3).get_object(a) == null)
	t.check("cache: the budget is the larger of 256 MiB and twice the largest save", Cache.budget(0) == 256 * MIB and Cache.budget(300 * MIB) == 600 * MIB)
	var dir := "user://u23g4_cache_%s" % Crypto.new().generate_random_bytes(4).hex_encode()
	var dir_a := Cache.dir_for(dir, "subject-a", "saves")
	var dir_b := Cache.dir_for(dir, "subject-b", "saves")
	t.check("cache: one person's directory is not another's, and a collection cannot climb", dir_a != dir_b and not Cache.dir_for(dir, "s", "../../x").contains(".."))
	var fc := Cache.Files.new(dir_a, 1000)
	var obj := _noise(400)
	fc.put(a, obj)
	t.check("cache: a file entry is named by its id and reads back", FileAccess.file_exists(dir_a.path_join(a)) and fc.get_object(a) == obj)
	fc.put(b, _noise(400))
	fc.put(c, _noise(400))
	t.check("cache: the file cache keeps the newest within its budget", fc.get_object(a) == null and fc.get_object(c) != null)
	# Damage on disk: a truncated entry and a stranger are a miss / ignored.
	var f := FileAccess.open(dir_a.path_join(c), FileAccess.WRITE)
	f.store_buffer(PackedByteArray([1, 2]))
	f.close()
	t.check("cache damage: a truncated entry is a miss", fc.get_object(c) == null)
	var fresh := Cache.Files.new(dir_a, 1000)
	f = FileAccess.open(dir_a.path_join("stranger.txt"), FileAccess.WRITE)
	f.store_string("x")
	f.close()
	t.check("cache: a fresh scan keeps only the entries named by ids", fresh.get_object(b) != null and fresh.get_object("stranger.txt") == null)
	fc.clear()
	t.check("cache: clear purges the entries", fc.get_object(b) == null)
	_rm(dir)


func _lane(t: PKeyTestContext) -> void:
	var srv := FakeServer.new()
	var src := CountingSource.new()
	src.size = 33 * MIB
	var e := _engine(srv)
	var r: PKeyResult = await e.upload_chunked({"id": "l1", "collection": "saves", "record": "r", "source": src, "codec": Codec.Server.new()})
	t.check("lane: a chunked upload over 32 MiB is typed unsupported", not r.ok and r.code == &"unsupported" and r.detail["feature"] == "sync.files" and r.detail["reason"] == "runtime", str(r))
	t.check("lane: ... before anything is read or sent", src.reads == 0 and srv.calls.is_empty())
	src.size = PKeySyncFileStream.sealed_size(32 * MIB) + 1
	r = await e.upload({"id": "l2", "collection": "saves", "record": "r", "source": src, "size": src.size, "sha256": "a".repeat(64), "enc": "e2e"})
	t.check("lane: a whole upload over the sealed 32 MiB is typed unsupported, nothing read", not r.ok and r.code == &"unsupported" and src.reads == 0 and srv.calls.is_empty())
	r = await e.download({"collection": "saves", "record": "r", "format": "whole", "size": 40 * MIB, "sha256": "a".repeat(64), "codec": Codec.Server.new(), "sink": Callable()})
	t.check("lane: a download over 32 MiB is typed unsupported before any request", not r.ok and r.code == &"unsupported" and srv.calls.is_empty())
	r = await e.download({"collection": "saves", "record": "r", "format": "whole", "size": 2 * 1024 * MIB, "sha256": "a".repeat(64), "codec": Codec.Server.new(), "sink": Callable()})
	t.check("lane: a size beyond the wire limit is file-invalid, not a lane matter", not r.ok and r.code == &"sync-file-invalid")
	# cancel(): aborts the server's upload and forgets the record.
	var j := Journal.Memory.new()
	srv = FakeServer.new()
	j.put("z", _rec({"id": "z", "uploadId": "upX", "size": 5, "expiresAt": (NOW + 9) * 1000.0}))
	await _engine(srv, j).cancel("z")
	t.check("cancel: aborts the upload and forgets the record", srv.aborted == ["upX"] and j.get_record("z") == null)


## A native-lane stand-in with no real cipher (the tag is 16 zero bytes), fast enough for 32 MiB. It records
## which thread called it and lets a test act on a seal.
class QuickLane:
	extends PKeyPeerCrypto
	var seals := 0
	var opens := 0
	var off_main := 0
	var on_seal := Callable()

	func lane_name() -> String:
		return "quick-native"

	func sync_native() -> bool:
		return true

	func sync_max_bytes() -> int:
		return 1048576

	func sync_seal(_k: PackedByteArray, _n: PackedByteArray, _a: PackedByteArray, p: PackedByteArray) -> PackedByteArray:
		seals += 1
		if OS.get_thread_caller_id() != OS.get_main_thread_id():
			off_main += 1
		if on_seal.is_valid():
			on_seal.call(seals)
		var out := p.duplicate()
		out.append_array(PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
		return out

	func sync_open(_k: PackedByteArray, _n: PackedByteArray, _a: PackedByteArray, s: PackedByteArray) -> Variant:
		opens += 1
		if OS.get_thread_caller_id() != OS.get_main_thread_id():
			off_main += 1
		if s.size() < 16 or s.slice(s.size() - 16) != PackedByteArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]):
			return null
		return s.slice(0, s.size() - 16)


func _native_lane(t: PKeyTestContext) -> void:
	var root := PackedByteArray()
	root.resize(32)
	for i in 32:
		root[i] = i + 3
	var lane := QuickLane.new()
	PKeySyncAead.use_lane_for_tests(lane)
	var plain := PackedByteArray()
	plain.resize(32 * MIB)
	var codec := Codec.E2e.new(root, "saves")
	var frames := Engine.get_process_frames()
	var stored: PackedByteArray = await Transfer.codec_off(codec, "seal_whole", [plain], plain.size(), PackedByteArray())
	var yielded := Engine.get_process_frames() - frames
	t.check("native lane: a 32 MiB seal answers the stored size", stored.size() == PKeySyncFileStream.sealed_size(plain.size()))
	t.check("native lane: ... every segment sealed inline on the main thread", lane.seals == 32 and lane.off_main == 0, "%d seals, %d off main" % [lane.seals, lane.off_main])
	t.check("native lane: ... with a frame yield every 4 MiB", yielded >= 7, "%d frames" % yielded)
	var opened: Dictionary = await Transfer.codec_off(codec, "open_whole", [stored], stored.size(), {"ok": false, "reason": "locked"})
	t.check("native lane: it opens again the same way", opened.get("ok", false) and (opened["plain"] as PackedByteArray) == plain and lane.off_main == 0)
	# A root replaced mid-seal discards the result.
	var flag := [false]
	var guarded := Codec.Guarded.new(Codec.E2e.new(root, "saves"), func() -> bool: return flag[0])
	var before := lane.seals
	lane.on_seal = func(_n: int) -> void:
		if lane.seals - before == 5:
			flag[0] = true
	var dropped: PackedByteArray = await Transfer.codec_off(guarded, "seal_whole", [plain], plain.size(), PackedByteArray())
	t.check("native lane: a root replaced mid-seal discards the result and stops sealing", dropped.is_empty() and guarded.tripped and lane.seals - before < 8, "%d" % (lane.seals - before))
	# The chunk cut runs on a worker thread even then.
	var cut_src := Transfer.BytesSource.new(_noise(3 * MIB))
	var cut: Dictionary = await _engine(FakeServer.new())._cut({"source": cut_src, "codec": Codec.Server.new()})
	t.check("native lane: the chunk cut still answers", cut["ok"] and cut["plain_size"] == 3 * MIB)
	PKeySyncAead.use_lane_for_tests(null)


func _rm(path: String) -> void:
	var d := DirAccess.open(path)
	if d == null:
		return
	for name in d.get_files():
		DirAccess.remove_absolute(path.path_join(name))
	for sub in d.get_directories():
		_rm(path.path_join(sub))
	DirAccess.remove_absolute(path)
