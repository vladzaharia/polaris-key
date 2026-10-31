extends RefCounted
## The Cloud Sync file transfer engine (U-23.G4; WIRE-CONTRACT-V5 §13.8): uploads in modes `single` and
## `multipart` (`upload`) and `chunks` (`upload_chunked`), and downloads of both formats (`download`). A
## port of Python `cloud_sync/transfer.py`, sequential (Godot's GDScript lane runs one request at a time).
## The engine owns the order of calls and the recovery rules and nothing else. The ports keep it pure:
##
##   transport  the routes of §13.8, typed (the host maps them to HTTP and never lets a server-chosen path
##              through). Every method may be a coroutine and answers a reply Dictionary:
##                begin(target, request)               status(target, upload_id)
##                put_single(target, upload_id, body, sha256)
##                put_part(target, upload_id, n, body, sha256)
##                abort(target, upload_id)             finalize(target, request)
##                plan_chunks(target, upload_id, request)
##                put_chunk(target, upload_id, chunk_id, body, sha256)
##                get_file(target, query)   query {version, range: [start, end) | null, if_match}; the
##                                          value is {status, data, etag, content_range: [s, e, total] | null}
##                get_chunk(collection, chunk_id)      the value is the object's bytes
##              `target` is {collection, record}. A reply is `reply_ok(value)` or `reply_fail(status, code,
##              retry_after, body)`; status 0 is "no answer" (the network, a timeout) and is retried.
##   journal    `journal.gd` Memory or Files; what survives a kill
##   codec      `transfer_codec.gd` E2e or Server
##   cache      `chunk_cache.gd` Memory or Files (or null)
##
## Rules (the Python port's, one Pass per upload with one hold for Retry-After):
##   * a call retries only on no answer, 408, 429 or 5xx; `Retry-After` holds every later request of the
##     pass, without it the wait doubles from 0.5 s to 30 s with jitter; 8 attempts, then retries-exhausted
##   * a 410 or 404 inside an upload restarts it (3 times, then restarts-exhausted); on `begin` or a
##     download it is a rejection; 409 is `conflict` (carrying the server's version), 400 upload_mismatch
##     is `mismatch`; the upload is aborted on a 409 at finalize
##   * a journal record of an unknown `v` or shape stops the transfer and is left as found
##   * a download checks, in order: size, sha256 hex, then per range the status, Content-Range and ETag
##     (held fixed with If-Match), the stored sha256 after the last range, then the format's own checks
##     (segment tags; chunks: manifest size and hash, open, parse, size cross-check, per chunk the cap, the
##     object's own checks and its length, last the reassembly). Anything the server could have altered is
##     `file-invalid`. The sink receives plaintext only after every check passed.
##   * Godot's lane: raw codec 0 chunks only on write, files over 32 MiB (`PKeySyncFileStream.LANE_MAX_BYTES`)
##     are refused as typed `unsupported` before anything is read or sent.
##
## Results are PKeyResult: success (`detail` the finalize answer for an upload), `sync-file-invalid`,
## `cancelled`, `unsupported`, or `sync-failed` with `detail {reason, status, code, serverVersion, detail}`.
## Nothing here puts a key, a plaintext byte or a bearer token in a result or a log line.

const Journal := preload("res://addons/polaris_key/services/cloud_sync/journal.gd")
const Codec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")

const DOWNLOAD_RANGE_BYTES := 8 * 1024 * 1024
const FEATURE := "sync.files"
const _HASH_SLICE := 1048576
const _BACKOFF_BASE := 0.5
const _BACKOFF_CAP := 30.0
const _MANIFEST_PLAIN_MAX := PKeySyncManifest.HEADER_BYTES + PKeySyncManifest.RECORD_BYTES * 16384

var transport: Object
var journal: Object
var max_attempts := 8
var max_restarts := 3
var max_retry_after := 900.0
## Seconds since the epoch; a test injects a clock.
var now: Callable = func() -> float: return Time.get_unix_time_from_system()
## `sleep(seconds)`, a coroutine; a test injects one that only records.
var sleep: Callable = Callable()
## [0, 1) for backoff jitter.
var random: Callable = func() -> float: return randf()
## Uploads of dropped records, aborted at the start of the next run (a coroutine cannot be awaited there).
var _pending_aborts := []


## A transfer's cancel flag: set `cancelled` and the transfer stops at its next step (`cancelled`); the
## journal keeps the progress.
class Cancel:
	extends RefCounted
	var cancelled := false


## A source over bytes in memory: `size` and `read(start, end)`.
class BytesSource:
	extends RefCounted
	var size := 0
	var _data := PackedByteArray()

	func _init(data: PackedByteArray) -> void:
		_data = data
		size = data.size()

	func read(start: int, end: int) -> PackedByteArray:
		return _data.slice(start, end)


static func reply_ok(value: Variant = null) -> Dictionary:
	return {"ok": true, "value": value}


static func reply_fail(status: int, code := "", retry_after := -1.0, body: Variant = null) -> Dictionary:
	return {"ok": false, "status": status, "code": code, "retry_after": retry_after, "body": body}


func _init(p_transport: Object, p_journal: Object) -> void:
	transport = p_transport
	journal = p_journal


# ── Public ──────────────────────────────────────────────────────────────────────────────────────

## Upload one file's stored bytes (`single`/`multipart`) and finalize it. `req`: {id, collection, record,
## source, size, sha256, enc, base_version?, on_progress?: Callable(sent, total), cancel?: Cancel}.
func upload(req: Dictionary) -> PKeyResult:
	var size: int = req["size"]
	if not _fits(size, true):
		return _unsupported()
	if req["source"].size != size:
		return _result(_err("source-mismatch"))
	var v := _verify_source(req)
	if not v["ok"]:
		return _result(v)
	var loaded := _load_record(req)
	if not loaded["ok"]:
		return _result(loaded)
	var resume: Variant = loaded["record"]
	var restarts := 0
	while true:
		var r: Dictionary = await _run_upload(req, resume if restarts == 0 else null)
		if r.get("reason") == "_restart":
			if restarts >= max_restarts:
				return _result(_err("restarts-exhausted", 410))
			journal.delete(req["id"])
			restarts += 1
			continue
		return _result(r)
	return null


## Upload a file as a manifest over content-defined chunks and finalize it. `req`: {id, collection, record,
## source (the plaintext), codec, base_version?, on_progress?: Callable(done, total), cancel?: Cancel}.
func upload_chunked(req: Dictionary) -> PKeyResult:
	var source = req["source"]
	if source.size > PKeyConstants.SYNC_FILE_MAX_BYTES:
		return _result(_err("rejected", 0, "file_too_large"))
	if not _fits(source.size, false):
		return _unsupported()
	# Read before anything is sent: an unreadable record stops the transfer untouched. A record of an
	# earlier run only tells which server upload to release.
	var rel: Dictionary = await _release_prior(req["id"])
	if not rel["ok"]:
		return _result(rel)
	var cut := _cut(req)
	if not cut["ok"]:
		return _result(cut)
	var restarts := 0
	while true:
		var r: Dictionary = await _run_chunked(req, cut)
		if r.get("reason") == "_restart":
			if restarts >= max_restarts:
				return _result(_err("restarts-exhausted", 410))
			journal.delete(req["id"])
			restarts += 1
			continue
		return _result(r)
	return null


## Fetch one file and write its plaintext to `req.sink` (a Callable(PackedByteArray)), once every check has
## passed. `req`: {collection, record, format: "whole" | "chunks", size, sha256, codec, sink, version?,
## cache?, on_progress?: Callable(written, total), cancel?: Cancel}.
func download(req: Dictionary) -> PKeyResult:
	var size: Variant = req["size"]
	var codec = req["codec"]
	if typeof(size) != TYPE_INT or size <= 0 or size > codec.stored_size(PKeyConstants.SYNC_FILE_MAX_BYTES):
		return _result(_invalid("size"))
	if not _fits(size, true):
		return _unsupported()
	var sha: Variant = req["sha256"]
	if not (sha is String) or not Journal._hex_re.search(sha):
		return _result(_invalid("sha256"))
	var ps := _new_pass(req["collection"], req["record"], req.get("cancel"))
	var r: Dictionary
	if req["format"] == "whole":
		r = await _download_whole(ps, req)
	else:
		r = await _download_chunked(ps, req)
	return _result(r)


## Drop a transfer: abort the server's upload (best effort) and forget the record.
func cancel(id: String) -> void:
	var raw: Variant = journal.get_record(id)
	if raw == null:
		return
	var p := Journal.parse(raw)
	if not p["ok"]:
		return  # a record this build cannot read stays for the build that wrote it
	var rec: Dictionary = p["record"]
	await _abort_quietly({"collection": rec["collection"], "record": rec["record"]}, rec["uploadId"])
	journal.delete(id)


# ── Results ─────────────────────────────────────────────────────────────────────────────────────

static func _err(reason: String, status := 0, code := "", detail := "", server_version := -1) -> Dictionary:
	return {"ok": false, "reason": reason, "status": status, "code": code, "detail": detail, "server_version": server_version}


static func _invalid(detail: String) -> Dictionary:
	return _err("file-invalid", 0, "", detail)


static func _unsupported() -> PKeyResult:
	return PKeyResult.unsupported(FEATURE, PKeyConstants.UnsupportedReason.RUNTIME, "Synced files over 32 MiB are not supported on this runtime yet.")


static func _result(r: Dictionary) -> PKeyResult:
	if r["ok"]:
		return PKeyResult.success(r.get("value"))
	var reason: String = r["reason"]
	match reason:
		"file-invalid":
			return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.SYNC_FILE_INVALID), "A synced file failed a check.", {"reason": reason, "detail": r["detail"]})
		"aborted":
			return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.CANCELLED), "The transfer was cancelled.", {"reason": reason})
		"unsupported":
			return _unsupported()
	var text := "file transfer: " + reason
	if r["code"] != "":
		text += " (" + r["code"] + ")"
	return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.SYNC_FAILED), text, {
		"reason": reason, "status": r["status"], "code": r["code"], "serverVersion": r["server_version"], "detail": r["detail"],
	})


## Whether a stored size fits the GDScript lane (every codec's stored form of a 32 MiB file).
static func _fits(size: int, stored: bool) -> bool:
	return size >= 0 and size <= (PKeySyncFileStream.sealed_size(PKeySyncFileStream.LANE_MAX_BYTES) if stored else PKeySyncFileStream.LANE_MAX_BYTES)


static func _sha_hex(b: PackedByteArray) -> String:
	return PKeySyncHkdf.sha256(b).hex_encode()


static func _is_int(x: Variant) -> bool:
	return typeof(x) == TYPE_INT


# ── Passes and calls ────────────────────────────────────────────────────────────────────────────

func _new_pass(collection: String, record: String, cancel: Variant) -> Dictionary:
	return {"target": {"collection": collection, "record": record}, "cancel": cancel, "hold_until": 0.0, "rec": {}}


static func _is_cancelled(ps: Dictionary) -> bool:
	return ps["cancel"] != null and ps["cancel"].cancelled


func _sleep(seconds: float, ps: Dictionary) -> bool:
	if sleep.is_valid():
		await sleep.call(seconds)
		return not _is_cancelled(ps)
	var left := seconds
	var tree := Engine.get_main_loop() as SceneTree
	while left > 0.0:
		if _is_cancelled(ps):
			return false
		var step := minf(left, 0.25)
		await tree.create_timer(step).timeout
		left -= step
	return not _is_cancelled(ps)


## One request with the recovery rules. A refusal is returned as the reply; a retryable failure is waited
## out. An error Dictionary (it has "reason") is returned for a cancel or exhausted retries.
func _call(ps: Dictionary, fn: Callable) -> Dictionary:
	var attempt := 0
	while true:
		if _is_cancelled(ps):
			return _err("aborted")
		var wait: float = ps["hold_until"] - float(now.call())
		if wait > 0.0 and not await _sleep(wait, ps):
			return _err("aborted")
		var reply: Dictionary = await fn.call()
		if reply["ok"]:
			return reply
		var status: int = reply["status"]
		if not (status == 0 or status == 408 or status == 429 or status >= 500):
			return reply
		if attempt + 1 >= max_attempts:
			return _err("retries-exhausted", status, reply["code"] if status != 0 else "")
		var told: float = reply.get("retry_after", -1.0)
		var delay: float
		if told >= 0.0:
			delay = minf(told, max_retry_after)
		else:
			delay = minf(_BACKOFF_CAP, _BACKOFF_BASE * pow(2.0, attempt)) * (0.5 + float(random.call()) / 2.0)
		ps["hold_until"] = maxf(ps["hold_until"], float(now.call()) + delay)
		attempt += 1
	return {}


func _abort_quietly(target: Dictionary, upload_id: String) -> void:
	await transport.abort(target, upload_id)


## A refusal that no retry mends, as an error. A 410 or 404 starts the upload over.
static func _refuse_upload(reply: Dictionary) -> Dictionary:
	var status: int = reply["status"]
	if status == 410 or status == 404:
		return _err("_restart")
	var body: Variant = reply.get("body")
	var server: Variant = body.get("server") if body is Dictionary else null
	var v: Variant = server.get("version") if server is Dictionary else null
	if status == 409:
		return _err("conflict", 409, reply["code"], "", v if _is_int(v) else -1)
	if status == 400 and reply["code"] == "upload_mismatch":
		return _err("mismatch", 400, reply["code"])
	return _err("rejected", status, reply["code"])


# ── Journal ─────────────────────────────────────────────────────────────────────────────────────

func _read_record(id: String) -> Dictionary:
	var raw: Variant = journal.get_record(id)
	if raw == null:
		return {"ok": true, "record": null}
	var p := Journal.parse(raw)
	if not p["ok"]:
		return _err("journal-version" if p["reason"] == "version" else "journal-malformed")
	return {"ok": true, "record": p["record"]}


func _release_prior(id: String) -> Dictionary:
	var r := _read_record(id)
	if not r["ok"] or r["record"] == null:
		return r
	var rec: Dictionary = r["record"]
	await _abort_quietly({"collection": rec["collection"], "record": rec["record"]}, rec["uploadId"])
	journal.delete(id)
	return {"ok": true}


func _load_record(req: Dictionary) -> Dictionary:
	var r := _read_record(req["id"])
	if not r["ok"] or r["record"] == null:
		return r
	var rec: Dictionary = r["record"]
	var same: bool = rec["collection"] == req["collection"] and rec["record"] == req["record"] and rec["sha256"] == req["sha256"] and rec["size"] == req["size"]
	if same and float(rec["expiresAt"]) > float(now.call()):
		return {"ok": true, "record": rec}
	if not same:
		_pending_aborts.append([{"collection": rec["collection"], "record": rec["record"]}, rec["uploadId"]])
	journal.delete(req["id"])
	return {"ok": true, "record": null}


func _flush_aborts() -> void:
	while not _pending_aborts.is_empty():
		var a: Array = _pending_aborts.pop_back()
		await _abort_quietly(a[0], a[1])


func _update(ps: Dictionary, change: Dictionary) -> void:
	var rec: Dictionary = ps["rec"]
	rec.merge(change, true)
	journal.put(rec["id"], rec)


func _add_done(ps: Dictionary, n: int) -> void:
	var done: Array = ps["rec"]["done"]
	if not done.has(n):
		done.append(n)
		done.sort()
	journal.put(ps["rec"]["id"], ps["rec"])


func _begun(ps: Dictionary, id: String, b: Dictionary, mode: String, part_bytes: Variant, sha: String, size: int) -> void:
	ps["rec"] = {
		"v": Journal.VERSION, "id": id, "kind": "upload", "collection": ps["target"]["collection"], "record": ps["target"]["record"],
		"uploadId": b["uploadId"], "mode": mode, "partBytes": part_bytes, "done": [], "sha256": sha, "size": size,
		"expiresAt": b["expiresAt"], "state": "uploading",
	}
	_update(ps, {})


func _begin_call(ps: Dictionary, request: Dictionary) -> Dictionary:
	var reply := await _call(ps, func() -> Dictionary: return await transport.begin(ps["target"], request))
	if reply.has("reason"):
		return reply
	if not reply["ok"]:
		# A 410 or 404 here is not a stale upload, so it surfaces.
		if reply["status"] == 410 or reply["status"] == 404:
			return _err("rejected", reply["status"], reply["code"])
		return _refuse_upload(reply)
	var b: Variant = reply["value"]
	if not (b is Dictionary) or not (b.get("uploadId") is String) or b["uploadId"] == "" or not (typeof(b.get("expiresAt")) in [TYPE_INT, TYPE_FLOAT]):
		return _err("bad-reply")
	return {"ok": true, "begun": b}


## `finalize`. On 409 upload_incomplete (at most twice) `resend` (a Callable(missing) -> bool, may be a
## coroutine) sends those again; a 409 or a mismatch otherwise releases the upload.
func _finalize_call(ps: Dictionary, resend: Callable) -> Dictionary:
	var again := 0
	while true:
		var reply := await _call(ps, func() -> Dictionary: return await transport.finalize(ps["target"], {"uploadId": ps["rec"]["uploadId"]}))
		if reply.has("reason"):
			return reply
		if reply["ok"]:
			journal.delete(ps["rec"]["id"])
			return {"ok": true, "value": reply["value"]}
		var body: Variant = reply.get("body")
		var missing: Variant = body.get("missing") if body is Dictionary else null
		if reply["status"] == 409 and reply["code"] == "upload_incomplete" and again < 2:
			var res: Variant = await resend.call(missing)
			if res is Dictionary:
				return res  # the resend failed
			if res == true:
				again += 1
				continue
		if reply["status"] == 409 or (reply["status"] == 400 and reply["code"] == "upload_mismatch"):
			await _abort_quietly(ps["target"], ps["rec"]["uploadId"])
			journal.delete(ps["rec"]["id"])
		return _refuse_upload(reply)
	return {}


func _verify_source(req: Dictionary) -> Dictionary:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	var size: int = req["size"]
	var at := 0
	while at < size:
		var end := mini(size, at + _HASH_SLICE)
		var piece: PackedByteArray = req["source"].read(at, end)
		if piece.size() != end - at:
			return _err("source-mismatch")
		ctx.update(piece)
		at = end
	if ctx.finish().hex_encode() != req["sha256"]:
		return _err("source-mismatch")
	return {"ok": true}


# ── single / multipart ──────────────────────────────────────────────────────────────────────────

func _part_count(rec: Dictionary) -> int:
	if rec["mode"] == "multipart":
		return (rec["size"] + rec["partBytes"] - 1) / rec["partBytes"]
	return 1


func _run_upload(req: Dictionary, resume: Variant) -> Dictionary:
	await _flush_aborts()
	var ps := _new_pass(req["collection"], req["record"], req.get("cancel"))
	if resume == null:
		var b := await _begin_for(ps, req)
		if not b["ok"]:
			return b
	else:
		ps["rec"] = resume
		if resume["state"] == "uploading":
			var rr := await _reconcile(ps)
			if not rr["ok"]:
				return rr
	if ps["rec"]["state"] == "uploading":
		var sent := await _send_missing(ps, req)
		if not sent["ok"]:
			return sent
		_update(ps, {"state": "finalizing"})
	var resend := func(missing: Variant) -> Variant:
		var parts := _part_count(ps["rec"])
		if not (missing is Array):
			return false
		for n in missing:
			if not _is_int(n) or n < 1 or n > parts:
				return false
		var kept := []
		for n in ps["rec"]["done"]:
			if not (n in missing):
				kept.append(n)
		_update(ps, {"state": "uploading", "done": kept})
		var again := await _send_missing(ps, req)
		if not again["ok"]:
			return again
		_update(ps, {"state": "finalizing"})
		return true
	return await _finalize_call(ps, resend)


func _begin_for(ps: Dictionary, req: Dictionary) -> Dictionary:
	var request := {"size": req["size"], "sha256": req["sha256"], "format": "whole", "enc": req["enc"]}
	if req.get("base_version") != null:
		request["baseVersion"] = req["base_version"]
	var r := await _begin_call(ps, request)
	if not r["ok"]:
		return r
	var b: Dictionary = r["begun"]
	var mode: Variant = b.get("mode")
	var part_bytes: Variant = null
	if mode == "multipart":
		part_bytes = b.get("partBytes")
		var size: int = req["size"]
		var ok: bool = _is_int(part_bytes) and part_bytes >= 1 and part_bytes <= PKeyConstants.SYNC_PART_MAX_BYTES and (size + part_bytes - 1) / part_bytes <= PKeyConstants.SYNC_MAX_PARTS
		if not ok:
			await _abort_quietly(ps["target"], b["uploadId"])
			return _err("bad-reply")
	elif mode != "single" or req["size"] > PKeyConstants.SYNC_SINGLE_PUT_MAX_BYTES:
		# `chunks` is the other upload; a file this big is never one PUT.
		await _abort_quietly(ps["target"], b["uploadId"])
		return _err("bad-reply")
	_begun(ps, req["id"], b, mode, part_bytes, req["sha256"], req["size"])
	return {"ok": true}


## The server's list of received parts replaces the journal's `done`.
func _reconcile(ps: Dictionary) -> Dictionary:
	var rec: Dictionary = ps["rec"]
	var reply := await _call(ps, func() -> Dictionary: return await transport.status(ps["target"], rec["uploadId"]))
	if reply.has("reason"):
		return reply
	if not reply["ok"]:
		return _refuse_upload(reply)
	if rec["mode"] != "multipart":
		return {"ok": true}
	var got: Variant = reply["value"].get("received") if reply["value"] is Dictionary else null
	var parts := _part_count(rec)
	var done := []
	if got is Array:
		for n in got:
			if _is_int(n) and n >= 1 and n <= parts and not done.has(n):
				done.append(n)
	done.sort()
	_update(ps, {"done": done})
	return {"ok": true}


func _send_missing(ps: Dictionary, req: Dictionary) -> Dictionary:
	var rec: Dictionary = ps["rec"]
	for n in range(1, _part_count(rec) + 1):
		if (rec["done"] as Array).has(n):
			continue
		var r := await _send_part(ps, req, n)
		if not r["ok"]:
			return r
	return {"ok": true}


func _send_part(ps: Dictionary, req: Dictionary, n: int) -> Dictionary:
	var rec: Dictionary = ps["rec"]
	var size: int = rec["size"]
	var start := 0
	var end := size
	if rec["mode"] != "single":
		var pr := PKeySyncTransferPlan.part_range({"mode": "multipart", "part_bytes": rec["partBytes"], "parts": _part_count(rec)}, size, n)
		start = pr["start"]
		end = pr["end"]
	var body: PackedByteArray = req["source"].read(start, end)
	if body.size() != end - start:
		return _err("source-mismatch")
	var digest := _sha_hex(body)
	var upload_id: String = rec["uploadId"]
	var reply: Dictionary
	if rec["mode"] == "single":
		reply = await _call(ps, func() -> Dictionary: return await transport.put_single(ps["target"], upload_id, body, digest))
	else:
		reply = await _call(ps, func() -> Dictionary: return await transport.put_part(ps["target"], upload_id, n, body, digest))
	if reply.has("reason"):
		return reply
	if not reply["ok"]:
		return _refuse_upload(reply)
	_add_done(ps, n)
	var on_progress: Variant = req.get("on_progress")
	if on_progress is Callable:
		var sent := 0
		if rec["mode"] == "single":
			sent = size
		else:
			for p in rec["done"]:
				var q := PKeySyncTransferPlan.part_range({"mode": "multipart", "part_bytes": rec["partBytes"], "parts": _part_count(rec)}, size, p)
				sent += q["end"] - q["start"]
		on_progress.call(sent, size)
	return {"ok": true}


# ── chunks ──────────────────────────────────────────────────────────────────────────────────────

## Pass one over the plaintext: cut it, name the chunks, hash it and write the manifest.
func _cut(req: Dictionary) -> Dictionary:
	var source = req["source"]
	var codec = req["codec"]
	var chunker := PKeySyncCdc.Chunker.new()
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	var records := []
	var offsets := []
	var at := 0
	var cancel: Variant = req.get("cancel")
	var frm := 0
	var pending: Array = []
	while true:
		var done: bool = frm >= source.size
		if not done:
			if cancel != null and cancel.cancelled:
				return _err("aborted")
			var end := mini(source.size, frm + _HASH_SLICE)
			var piece: PackedByteArray = source.read(frm, end)
			if piece.size() != end - frm:
				return _err("source-mismatch")
			ctx.update(piece)
			pending = chunker.push(piece)
			frm = end
		else:
			pending = chunker.finish()
		for c in pending:
			if records.size() >= PKeyConstants.SYNC_MAX_CHUNKS_PER_FILE:
				return _err("rejected", 0, "file_too_large")
			var id: PackedByteArray = codec.chunk_id(c)
			if id.is_empty():
				return _err("invalid")
			records.append({"id": id, "plain_len": (c as PackedByteArray).size()})
			offsets.append(at)
			at += (c as PackedByteArray).size()
		if done:
			break
	var manifest := PKeySyncManifest.encode({"plain_size": source.size, "plain_sha256": ctx.finish(), "records": records})
	if manifest.is_empty():
		return _err("rejected", 0, "file_too_large")
	return {"ok": true, "records": records, "offsets": offsets, "manifest": manifest, "plain_size": source.size}


func _run_chunked(req: Dictionary, cut: Dictionary) -> Dictionary:
	var ps := _new_pass(req["collection"], req["record"], req.get("cancel"))
	var codec = req["codec"]
	var records: Array = cut["records"]
	# hex id -> the first record that has it
	var unique := {}
	for i in records.size():
		var hex: String = (records[i]["id"] as PackedByteArray).hex_encode()
		if not unique.has(hex):
			unique[hex] = i
	var st := {"done": 0}
	# begin: a sealed manifest differs every run, so it is sealed per begin
	var stored: PackedByteArray = codec.seal_manifest(cut["manifest"])
	if stored.is_empty():
		return _err("invalid")
	var stored_sha := _sha_hex(stored)
	var size: int = codec.stored_size(cut["plain_size"])
	var request := {"size": size, "sha256": stored_sha, "format": "chunks", "enc": codec.enc}
	if req.get("base_version") != null:
		request["baseVersion"] = req["base_version"]
	var br := await _begin_call(ps, request)
	if not br["ok"]:
		return br
	var b: Dictionary = br["begun"]
	if b.get("mode") != "chunks":
		await _abort_quietly(ps["target"], b["uploadId"])
		return _err("bad-reply")
	_begun(ps, req["id"], b, "chunks", null, stored_sha, size)
	_chunk_progress(req, st, 0, cut["plain_size"])
	# plan: every id sent is answered exactly once or the reply is refused
	var ids: Array = unique.keys()
	var missing := {}
	var at := 0
	while at < ids.size():
		var batch: Array = ids.slice(at, at + PKeyConstants.SYNC_CHUNK_PLAN_MAX_IDS)
		at += PKeyConstants.SYNC_CHUNK_PLAN_MAX_IDS
		var asked := {}
		var entries := []
		for i in batch:
			asked[i] = true
			entries.append([i, codec.chunk_object_bytes(records[unique[i]]["plain_len"])])
		var upload_id: String = ps["rec"]["uploadId"]
		var reply := await _call(ps, func() -> Dictionary: return await transport.plan_chunks(ps["target"], upload_id, {"chunks": entries}))
		if reply.has("reason"):
			return reply
		if not reply["ok"]:
			return _refuse_upload(reply)
		var lists: Variant = reply["value"]
		if not (lists is Dictionary) or not (lists.get("missing") is Array) or not (lists.get("present") is Array):
			return await _bad_reply(ps)
		var said := {}
		for i in lists["missing"]:
			if not (i is String) or not asked.has(i) or said.has(i):
				return await _bad_reply(ps)
			said[i] = true
			missing[i] = true
		for entry in lists["present"]:
			var i: Variant = entry[0] if entry is Array and not entry.is_empty() else null
			if not (i is String) or not asked.has(i) or said.has(i):
				return await _bad_reply(ps)
			said[i] = true
			_chunk_progress(req, st, records[unique[i]]["plain_len"], cut["plain_size"])
		if said.size() != asked.size():
			return await _bad_reply(ps)
	# send the missing chunks, in file order
	for id in ids:
		if missing.has(id):
			var sent := await _send_chunk(ps, req, cut, unique, id, st)
			if not sent["ok"]:
				return sent
	# the manifest, then finalize
	var up: String = ps["rec"]["uploadId"]
	var mr := await _call(ps, func() -> Dictionary: return await transport.put_single(ps["target"], up, stored, stored_sha))
	if mr.has("reason"):
		return mr
	if not mr["ok"]:
		return _refuse_upload(mr)
	_update(ps, {"state": "finalizing"})
	var resend := func(lost: Variant) -> Variant:
		if not (lost is Array):
			return false
		for i in lost:
			if not (i is String) or not unique.has(i):
				return false
		for i in lost:
			var r := await _send_chunk(ps, req, cut, unique, i, st)
			if not r["ok"]:
				return r
		return true
	return await _finalize_call(ps, resend)


func _bad_reply(ps: Dictionary) -> Dictionary:
	await _abort_quietly(ps["target"], ps["rec"]["uploadId"])
	journal.delete(ps["rec"]["id"])
	return _err("bad-reply")


func _chunk_progress(req: Dictionary, st: Dictionary, add: int, total: int) -> void:
	st["done"] += add
	var cb: Variant = req.get("on_progress")
	if cb is Callable:
		cb.call(st["done"], total)


func _send_chunk(ps: Dictionary, req: Dictionary, cut: Dictionary, unique: Dictionary, id: String, st: Dictionary) -> Dictionary:
	if not unique.has(id):
		return _err("bad-reply")
	var i: int = unique[id]
	var rec: Dictionary = cut["records"][i]
	var start: int = cut["offsets"][i]
	var codec = req["codec"]
	var plain: PackedByteArray = req["source"].read(start, start + rec["plain_len"])
	# The file may have changed since it was cut: what is sent must still be the chunk named.
	if plain.size() != rec["plain_len"] or not PKeySyncAesGcm.equal_constant_time(codec.chunk_id(plain), rec["id"]):
		return _err("source-mismatch")
	var obj: PackedByteArray = codec.seal_chunk(rec["id"], plain)
	if obj.is_empty():
		return _err("invalid")
	var digest := _sha_hex(obj)
	var upload_id: String = ps["rec"]["uploadId"]
	var reply := await _call(ps, func() -> Dictionary: return await transport.put_chunk(ps["target"], upload_id, id, obj, digest))
	if reply.has("reason"):
		return reply
	if not reply["ok"]:
		return _refuse_upload(reply)
	_chunk_progress(req, st, rec["plain_len"], cut["plain_size"])
	return {"ok": true}


# ── downloads ───────────────────────────────────────────────────────────────────────────────────

static func _refuse_download(reply: Dictionary) -> Dictionary:
	# Nothing here restarts: a 404 or 410 means the revision is gone.
	return _err("rejected", reply["status"], reply["code"])


func _download_whole(ps: Dictionary, req: Dictionary) -> Dictionary:
	var codec = req["codec"]
	var size: int = req["size"]
	var plain_size: int = codec.plain_size(size)
	if plain_size < 0:
		return _invalid("size")
	var stored := PackedByteArray()
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	var etag: Variant = null
	var at := 0
	while at < size:
		var end := mini(size, at + DOWNLOAD_RANGE_BYTES)
		var ask := at
		var query := {"version": req.get("version"), "range": [ask, end], "if_match": etag}
		var reply := await _call(ps, func() -> Dictionary: return await transport.get_file(ps["target"], query))
		if reply.has("reason"):
			return reply
		if not reply["ok"]:
			return _refuse_download(reply)
		var body: Dictionary = reply["value"]
		var data: PackedByteArray = body["data"]
		if etag != null and body.get("etag") != null and body["etag"] != etag:
			return _err("bad-reply", 0, "", "etag")
		if etag == null:
			etag = body.get("etag")
		if body["status"] == 206:
			var cr: Variant = body.get("content_range")
			if not (cr is Array) or cr.size() != 3 or cr[0] != ask or cr[2] != size or cr[1] <= cr[0] or cr[1] > end or data.size() != cr[1] - cr[0]:
				return _err("bad-reply", 0, "", "content-range")
		elif body["status"] == 200:
			# A server that ignores Range sends the whole file, which only fits from the start.
			if ask != 0 or data.size() != size:
				return _err("bad-reply", 0, "", "status")
		else:
			return _err("bad-reply", 0, "", "status")
		ctx.update(data)
		stored.append_array(data)
		at += data.size()
	if ctx.finish().hex_encode() != req["sha256"]:
		return _invalid("sha256")
	var opened: Dictionary = codec.open_whole(stored)
	if not opened["ok"]:
		return _invalid(opened["reason"])
	var plain: PackedByteArray = opened["plain"]
	if plain.size() != plain_size:
		return _invalid("size")
	if _is_cancelled(ps):
		return _err("aborted")
	_emit(req, plain, plain_size)
	return {"ok": true}


static func _emit(req: Dictionary, plain: PackedByteArray, total: int) -> void:
	req["sink"].call(plain)
	var cb: Variant = req.get("on_progress")
	if cb is Callable:
		cb.call(plain.size(), total)


func _download_chunked(ps: Dictionary, req: Dictionary) -> Dictionary:
	var codec = req["codec"]
	var cache: Variant = req.get("cache")
	var query := {"version": req.get("version"), "range": null, "if_match": null}
	var reply := await _call(ps, func() -> Dictionary: return await transport.get_file(ps["target"], query))
	if reply.has("reason"):
		return reply
	if not reply["ok"]:
		return _refuse_download(reply)
	var body: Dictionary = reply["value"]
	var stored: PackedByteArray = body["data"]
	if body["status"] != 200:
		return _err("bad-reply", 0, "", "status")
	if stored.size() > codec.stored_size(_MANIFEST_PLAIN_MAX):
		return _invalid("manifest-size")
	if _sha_hex(stored) != req["sha256"]:
		return _invalid("sha256")
	var opened: Dictionary = codec.open_manifest(stored)
	if not opened["ok"]:
		return _invalid("manifest-" + str(opened["reason"]))
	var parsed := PKeySyncManifest.parse(opened["plain"])
	if not parsed["ok"]:
		return _invalid("manifest-" + str(parsed["reason"]))
	var manifest: Dictionary = parsed["manifest"]
	# The record's size and the manifest's must agree.
	if codec.stored_size(manifest["plain_size"]) != req["size"]:
		return _invalid("size")
	var total: int = manifest["plain_size"]
	if not _fits(total, false):
		return _unsupported_err()
	var reassembly := PKeySyncFileStream.Reassembly.new(total, manifest["plain_sha256"])
	if reassembly.error != "":
		return _invalid(reassembly.error)
	var out := PackedByteArray()
	for rec in manifest["records"]:
		if _is_cancelled(ps):
			return _err("aborted")
		var f := await _fetch_one(ps, req, codec, cache, rec)
		if not f["ok"]:
			return f
		var plain: PackedByteArray = f["plain"]
		var why := reassembly.push(plain)
		if why != "":
			return _invalid(why)
		out.append_array(plain)
	var fin := reassembly.finish()
	if fin != "":
		return _invalid(fin)
	_emit(req, out, total)
	return {"ok": true}


static func _unsupported_err() -> Dictionary:
	return _err("unsupported")


func _fetch_one(ps: Dictionary, req: Dictionary, codec, cache: Variant, rec: Dictionary) -> Dictionary:
	var id: String = (rec["id"] as PackedByteArray).hex_encode()
	if cache != null:
		var held: Variant = cache.get_object(id)
		if held is PackedByteArray:
			var o: Dictionary = codec.open_chunk(rec["id"], held)
			if o["ok"] and (o["plain"] as PackedByteArray).size() == rec["plain_len"]:
				return {"ok": true, "plain": o["plain"]}
			cache.delete(id)  # damage costs a fetch
	var collection: String = req["collection"]
	var got := await _call(ps, func() -> Dictionary: return await transport.get_chunk(collection, id))
	if got.has("reason"):
		return got
	if not got["ok"]:
		return _refuse_download(got)
	var obj: PackedByteArray = got["value"]
	if obj.size() > Codec.SERVER_CHUNK_MAX_STORED_BYTES:
		return _invalid("chunk-size")
	var opened: Dictionary = codec.open_chunk(rec["id"], obj)
	if not opened["ok"]:
		return _invalid("chunk-" + str(opened["reason"]))
	if (opened["plain"] as PackedByteArray).size() != rec["plain_len"]:
		return _invalid("chunk-length")
	if cache != null:
		cache.put(id, obj)
	return {"ok": true, "plain": opened["plain"]}
