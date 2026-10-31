class_name PKeySaves
extends RefCounted
## `PolarisKey.cloud_sync.saves` (U-23; plans D-2, D-3, D-8, D-10, D-11): a save is a record of the `saves`
## collection with one file. A port of client-core's `SavesClient` (the order of the steps, the choice of
## revision, the format check, the slot cap, conflicts) over the GDScript transfer engine (`transfer.gd`),
## and of Node's `SavesApi` (events, transfers, purge).
##
## A write runs in this order, so no save is ever torn:
##
##   1. upload the file (`begin`, bytes, `finalize`), which creates the record or bumps its version and
##      answers it;
##   2. push the metadata `set` with `baseVersion` = the version `finalize` answered.
##
## In end-to-end mode the sealed metadata carries `"$file": {sha256, size, format}` (D-3). A reader downloads
## the revision whose `sha256` the binding names and fails with `sync-file-invalid` when none matches, so a
## Worker can neither swap the files of two slots nor show a new file under old metadata. A record with no
## binding has no file there, whatever the server attaches to it. In server mode the metadata is the record's
## own value and the record's file is the file.
##
##   await saves.list()               PKeyResult, detail [{id, version, metadata, file, newer_format}]
##   await saves.read(id, opts)       PKeyResult, detail {id, version, metadata, file, bytes}; `file` is null
##                                    for a save with none. `opts`: {on_progress?, cancel?, sink?: Callable(bytes)};
##                                    with a sink `bytes` is empty. Over the app's `cloud_sync_save_format_version`
##                                    it fails with reason `newer-format` and detail {format_version, supported}
##   saves.write(id, bytes, metadata, opts)   PKeyTransfer at once (transfer_handle.gd); `bytes` is a
##                                    PackedByteArray, `metadata` a Dictionary; `opts` {base_version?: int | "*",
##                                    on_progress?: Callable(done, total)}
##   saves.resolve(conflict, keep, bytes, opts)   PKeyTransfer; `keep` is "local", "remote" or "both"
##   await saves.delete(id, base_version?)    PKeyResult, detail {id, version}
##   await saves.revisions(id)        PKeyResult, detail the kept revisions of the save's file, newest first
##   saves.transfers()                the writes in flight (running, paused, or waiting on the network)
##
## Failures are PKeyResults with a `code` of `sync-file-invalid` (a downloaded file failed a check), `sync-locked`
## (the key ring locked), `invalid-argument` (invalid-save) or `sync-failed` with detail `{reason, ...}`,
## where reason is one of not-found, newer-format, too-large, slots-full, transfer-failed, rejected, conflict.
## A write's outcome carries the same as `error: {code, detail}` with the saves code (`too-large`, `slots-full`,
## `invalid-save`, `not-found`, `transfer-failed`, `rejected`, `sync-file-invalid`, `sync-locked`,
## `unsupported`). Nothing here puts a key, a plaintext byte or a token in a result, an event or a log.
##
## The wait for the metadata write has no timeout: `cancel()`, a sign-out (the write is dropped) and the
## host's retries end it.
##
## Godot's lane (D-10): files are held whole in memory and sealed and opened on a worker thread (the
## GDScript AES-GCM runs about 1 s per MiB), at most 32 MiB each. iOS and Android wait for the native lanes
## (CC-14b, `sync.saves` is N/A there): every call answers the typed `unsupported` refusal.

const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")
const Handle := preload("res://addons/polaris_key/services/cloud_sync/transfer_handle.gd")
const Codecs := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")

const COLLECTION := "saves"
## The key of the E2E binding inside a save's sealed metadata (D-3).
const BINDING_KEY := "$file"
const DEFAULT_MAX_BYTES := 33554432

## `deps`:
##   records       saves_records.gd
##   engine       the transfer engine (transfer.gd); its transport also answers `revisions`
##   file_codec   Callable() -> a transfer_codec (Guarded E2e, or Server), or null while the key ring is locked
##   cache        Callable() -> a chunk cache or null
##   delta        bool, the collection's `files.delta` (default true: the saves template)
##   max_bytes    the collection's `files.maxBytes` (default 32 MiB)
##   format_version   the app's `save_format_version`; 0 turns the check off
##   emit         Callable(event Dictionary): transferProgress / transferDone / transferFailed
##   gate         Callable() -> null | PKeyResult (a coroutine): the refusal when the service is off or the
##                host is not up
##   supported    Callable() -> bool, whether this runtime runs the GDScript lane (default: not iOS or Android)
##   purge_files  Callable(), deletes the journal and the chunk cache of the person who left
var _d: Dictionary
var _live: Array = []
static var _key_re: RegEx
static var _hex_re: RegEx


static func _static_init() -> void:
	_key_re = RegEx.create_from_string(PKeyChannel.anchored(PKeyConstants.SYNC_KEY_PATTERN))
	_hex_re = RegEx.create_from_string(PKeyChannel.anchored("^[0-9a-f]{64}$"))


func _init(deps: Dictionary) -> void:
	_d = deps


## Whether the GDScript lane runs on this runtime at all (iOS and Android wait for CC-14b's native lanes).
static func runtime_supported() -> bool:
	return not (OS.has_feature("ios") or OS.has_feature("android"))


func _supported() -> bool:
	var s: Variant = _d.get("supported")
	return (s as Callable).call() if s is Callable and (s as Callable).is_valid() else runtime_supported()


func transfers() -> Array:
	return _live.duplicate()


# ── Results ─────────────────────────────────────────────────────────────────────────────────────

static func _err(code: String, detail: Variant = null) -> Dictionary:
	return {"code": code, "detail": detail}


## A saves error as the PKeyResult app code reads.
static func _failure(e: Dictionary) -> PKeyResult:
	var code := String(e["code"])
	var d: Dictionary = {"reason": code}
	if e.get("detail") is Dictionary:
		d.merge(e["detail"], false)
	elif e.get("detail") != null:
		d["detail"] = e["detail"]
	var result_code: StringName = PKeyConstants.ErrorCode.SYNC_FAILED
	match code:
		"sync-file-invalid":
			result_code = PKeyConstants.ErrorCode.SYNC_FILE_INVALID
		"sync-locked":
			result_code = PKeyConstants.ErrorCode.SYNC_LOCKED
		"invalid-save":
			result_code = PKeyConstants.ErrorCode.INVALID_ARGUMENT
		"unsupported":
			return PKeyResult.unsupported(PKeyConstants.Feature.SYNC_SAVES, PKeyConstants.UnsupportedReason.RUNTIME, "Synced saves wait for the native lanes on this platform.")
	return PKeyResult.failure(result_code, "saves: " + code, d)


static func _locked_result() -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.SYNC_LOCKED, "The key ring is locked.", {"reason": "sync-locked"})


static func _unsupported_result() -> PKeyResult:
	return PKeyResult.unsupported(PKeyConstants.Feature.SYNC_SAVES, PKeyConstants.UnsupportedReason.RUNTIME, "Synced saves wait for the native lanes on this platform.")


## An engine failure as a saves error, `{state: "aborted"}` for a cancel, or `{state: "conflict", ...}`.
## `codec` is read for a lock: a ring that locked mid-transfer is `sync-locked`, whatever the engine saw.
static func _from_engine(r: PKeyResult, codec: Object) -> Dictionary:
	if codec != null and codec.get("tripped") == true:
		return {"state": "failed", "error": _err("sync-locked")}
	if r.code == PKeyConstants.ErrorCode.CANCELLED:
		return {"state": "aborted"}
	if r.code == PKeyConstants.ErrorCode.SYNC_FILE_INVALID:
		var det: Variant = r.detail.get("detail") if r.detail is Dictionary else null
		return {"state": "failed", "error": _err("sync-file-invalid", det)}
	if r.code == &"unsupported":
		return {"state": "failed", "error": _err("too-large", "unsupported")}
	var info: Dictionary = r.detail if r.detail is Dictionary else {}
	if info.get("reason") == "conflict":
		var sv: Variant = info.get("serverVersion", -1)
		return {"state": "conflict", "server_version": int(sv) if sv != null and int(sv) >= 0 else null}
	var wire: Variant = info.get("code", "")
	return {"state": "failed", "error": _err("transfer-failed", String(wire) if String(wire) != "" else str(info.get("reason", "")))}


# ── Reading ─────────────────────────────────────────────────────────────────────────────────────

static func _format_of(metadata: Dictionary) -> Variant:
	var v: Variant = metadata.get("formatVersion")
	if typeof(v) == TYPE_INT:
		return v
	if typeof(v) == TYPE_FLOAT and is_finite(v) and v == floorf(v) and absf(v) < 9007199254740992.0:
		return int(v)
	return null


static func _is_whole(v: Variant) -> bool:
	return typeof(v) == TYPE_INT or (typeof(v) == TYPE_FLOAT and is_finite(v) and v == floorf(v) and absf(v) < 9007199254740992.0)


## `{metadata, binding}`: the metadata without the `$file` member, and the binding when it is well formed.
static func _split(value: Dictionary) -> Dictionary:
	var metadata := value.duplicate(true)
	metadata.erase(BINDING_KEY)
	var binding: Variant = null
	var raw: Variant = value.get(BINDING_KEY)
	if raw is Dictionary:
		var sha: Variant = raw.get("sha256")
		var size: Variant = raw.get("size")
		var fmt: Variant = raw.get("format")
		if sha is String and _hex_re.search(sha) != null and _is_whole(size) and size > 0 and (fmt == "whole" or fmt == "chunks"):
			binding = {"sha256": sha, "size": int(size), "format": fmt}
	return {"metadata": metadata, "binding": binding}


## A file pointer with whole-number members as ints (the machine keeps what the wire carried).
static func _ptr(f: Variant) -> Variant:
	if not (f is Dictionary):
		return null
	return {"version": int(f["version"]), "size": int(f["size"]), "sha256": f["sha256"], "format": f["format"]}


func _e2e() -> bool:
	return _d["records"].e2e()


func _newer(metadata: Dictionary) -> bool:
	var supported: int = _d.get("format_version", 0)
	var fv: Variant = _format_of(metadata)
	return supported > 0 and fv != null and fv > supported


func _summary(rec: Dictionary) -> Dictionary:
	var s := _split(rec["value"])
	var file: Variant = _ptr(rec["file"])
	if _e2e():
		file = file if (s["binding"] != null and file != null and file["sha256"] == s["binding"]["sha256"]) else null
	return {"id": rec["id"], "version": rec["version"], "metadata": s["metadata"], "file": file, "newer_format": _newer(s["metadata"])}


## The caller's gate (the service is on, the host is up): null, or the PKeyResult that refuses.
func _gated() -> Variant:
	var g: Variant = _d.get("gate")
	if g is Callable and (g as Callable).is_valid():
		return await g.call()
	return null


## null while the ring is locked (end-to-end mode).
func _codec() -> Variant:
	return _d["file_codec"].call()


func list() -> PKeyResult:
	if not _supported():
		return _unsupported_result()
	var refused: Variant = await _gated()
	if refused != null:
		return refused
	if _codec() == null:
		return _locked_result()
	var out: Array = []
	for rec: Dictionary in _d["records"].list():
		out.append(_summary(rec))
	out.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return String(a["id"]) < String(b["id"]))
	return PKeyResult.success(out)


func revisions(id: String) -> PKeyResult:
	if not _supported():
		return _unsupported_result()
	var refused: Variant = await _gated()
	if refused != null:
		return refused
	return await _revisions(id)


func _revisions(id: String) -> PKeyResult:
	if not _id_ok(id):
		return _failure(_err("invalid-save", "id"))
	var wire: String = _d["records"].wire_id(id)
	if wire == "":
		return _locked_result()
	var reply: Dictionary = await _d["engine"].transport.revisions({"collection": COLLECTION, "record": wire})
	if not reply["ok"]:
		return _failure(_err("not-found" if reply["status"] == 404 else "rejected", {"wire_code": reply.get("code", ""), "status": reply["status"]}))
	return PKeyResult.success(reply["value"]["revisions"])


## `opts`: {on_progress?: Callable(done, total), cancel?: Transfer.Cancel, sink?: Callable(PackedByteArray)}.
func read(id: String, opts: Dictionary = {}) -> PKeyResult:
	if not _supported():
		return _unsupported_result()
	var refused: Variant = await _gated()
	if refused != null:
		return refused
	var tid := "saves:read:" + id
	var r := await _read(id, opts, tid)
	if r.ok:
		_emit({"type": PKeyConstants.TransferEvent.TRANSFERDONE, "id": tid, "state": "done"})
	elif r.code != PKeyConstants.ErrorCode.CANCELLED:
		var reason: Variant = r.detail.get("reason") if r.detail is Dictionary else null
		_emit({"type": PKeyConstants.TransferEvent.TRANSFERFAILED, "id": tid, "code": String(reason) if reason != null else String(r.code)})
	return r


func _read(id: String, opts: Dictionary, tid: String) -> PKeyResult:
	if not _id_ok(id):
		return _failure(_err("invalid-save", "id"))
	var codec: Variant = _codec()
	if codec == null:
		return _locked_result()
	var rec: Variant = _d["records"].get_record(id)
	if rec == null:
		return _failure(_err("not-found"))
	var s := _split(rec["value"])
	var metadata: Dictionary = s["metadata"]
	var fv: Variant = _format_of(metadata)
	var supported: int = _d.get("format_version", 0)
	if supported > 0 and fv != null and fv > supported:
		return _failure(_err("newer-format", {"format_version": fv, "supported": supported}))
	var ref: Variant
	if _e2e():
		if s["binding"] == null:
			# A malformed binding is not an absent one: the writer meant a file.
			if rec["value"].has(BINDING_KEY):
				return _failure(_err("sync-file-invalid", "binding"))
			ref = null
		else:
			var found: Dictionary = await _revision_for(id, rec, s["binding"])
			if not found["ok"]:
				return found["result"]
			ref = found["ref"]
	else:
		ref = _ptr(rec["file"])
	if ref == null:
		return PKeyResult.success({"id": id, "version": rec["version"], "metadata": metadata, "file": null, "bytes": PackedByteArray()})
	var wire: String = _d["records"].wire_id(id)
	if wire == "":
		return _locked_result()
	var sink: Variant = opts.get("sink")
	var buffer: Array = [PackedByteArray()]
	var caller_progress: Variant = opts.get("on_progress")
	var on_progress := func(done: int, total: int) -> void:
		if caller_progress is Callable:
			(caller_progress as Callable).call(done, total)
		_emit({"type": PKeyConstants.TransferEvent.TRANSFERPROGRESS, "id": tid, "done": done, "total": total})
	var request := {
		"collection": COLLECTION, "record": wire, "version": ref["version"], "format": ref["format"],
		"size": ref["size"], "sha256": ref["sha256"], "codec": codec,
		"sink": sink if sink is Callable else func(b: PackedByteArray) -> void: buffer[0] = b,
		"on_progress": on_progress, "cancel": opts.get("cancel"),
	}
	var cache: Variant = _d["cache"].call() if _d.get("cache") is Callable else null
	if cache != null:
		request["cache"] = cache
	var r: PKeyResult = await _d["engine"].download(request)
	if not r.ok:
		var mapped := _from_engine(r, codec)
		if mapped["state"] == "aborted":
			return r
		return _failure(mapped["error"]) if mapped.has("error") else _failure(_err("transfer-failed"))
	return PKeyResult.success({"id": id, "version": rec["version"], "metadata": metadata, "file": ref, "bytes": buffer[0] if not sink is Callable else PackedByteArray()})


## D-3: the revision the binding names, else a failure.
func _revision_for(id: String, rec: Dictionary, binding: Dictionary) -> Dictionary:
	var current: Variant = _ptr(rec["file"])
	if current != null and _fits(current, binding):
		return {"ok": true, "ref": current}
	var revs := await _revisions(id)
	if not revs.ok:
		return {"ok": false, "result": revs}
	for r: Variant in revs.detail:
		if r is Dictionary and _fits(r, binding):
			return {"ok": true, "ref": {"version": int(r["version"]), "size": int(r["size"]), "sha256": r["sha256"], "format": r["format"]}}
	return {"ok": false, "result": _failure(_err("sync-file-invalid", "binding"))}


static func _fits(r: Dictionary, binding: Dictionary) -> bool:
	return r.get("sha256") == binding["sha256"] and int(r.get("size", -1)) == binding["size"] and r.get("format") == binding["format"]


# ── Writing ─────────────────────────────────────────────────────────────────────────────────────

static func _id_ok(id: Variant) -> bool:
	return id is String and id != "." and id != ".." and _key_re.search(id) != null


## Write a save. Returns at once; `await transfer.wait()` settles on the outcome.
func write(id: String, bytes: PackedByteArray, metadata: Dictionary, opts: Dictionary = {}) -> PKeyTransfer:
	return _run(id, bytes, metadata, opts, null)


## Settle a conflict (the `conflict` of a transfer's outcome). `remote` keeps the server's copy and writes
## nothing; `local` writes this device's save on top of the server's version; `both` writes it as a new save
## in a free slot.
func resolve(conflict: Dictionary, keep: String, bytes: PackedByteArray, opts: Dictionary = {}) -> PKeyTransfer:
	var id: String = conflict["id"]
	if keep == "remote":
		return _tracked(Handle.settled(id, {"state": "done", "id": id, "kept": "remote", "version": conflict.get("server_version")}))
	if keep == "both" and not conflict.get("both_available", false):
		return _tracked(Handle.settled(id, {"state": "failed", "error": _err("slots-full")}))
	if keep != "local" and keep != "both":
		return _tracked(Handle.settled(id, {"state": "failed", "error": _err("invalid-save", "keep")}))
	var sv: Variant = conflict.get("server_version")
	var mode: Variant = {"copy": true} if keep == "both" else {"base_version": sv if sv != null else "*"}
	return _run(id, bytes, conflict["local"]["metadata"], opts, mode)


func delete(id: String, base_version: Variant = null) -> PKeyResult:
	if not _supported():
		return _unsupported_result()
	var refused: Variant = await _gated()
	if refused != null:
		return refused
	if not _id_ok(id):
		return _failure(_err("invalid-save", "id"))
	if _codec() == null:
		return _locked_result()
	var base: Variant = base_version
	if base == null:
		var rec: Variant = _d["records"].get_record(id)
		if rec == null:
			return _failure(_err("rejected", {"wire_code": "not_found"}))
		base = rec["version"]
	var r: Dictionary = await _d["records"].delete_record(id, int(base))
	if r["ok"]:
		return PKeyResult.success({"id": id, "version": r["version"]})
	if r["reason"] == "conflict":
		var server: Variant = r["server"]
		return PKeyResult.failure(PKeyConstants.ErrorCode.SYNC_FAILED, "saves: conflict", {"reason": "conflict", "server": _summary(server) if server is Dictionary else null})
	return _failure(_err("rejected", {"wire_code": r.get("code", "")}))


func _run(id: String, bytes: PackedByteArray, metadata: Dictionary, opts: Dictionary, mode: Variant) -> PKeyTransfer:
	if not _supported():
		return _tracked(Handle.settled(id, {"state": "failed", "error": _err("unsupported", {"feature": PKeyConstants.Feature.SYNC_SAVES, "reason": PKeyConstants.UnsupportedReason.RUNTIME})}))
	var transfer_id := "saves:" + id
	var progress := {"done": 0, "total": bytes.size()}
	var meta := metadata.duplicate(true)
	# The sealed form of a whole file is made once: a fresh seal has a fresh salt, so a resume after a pause
	# would not match the journal.
	var sealed: Array = [null]
	var attempt := func(soft: Transfer.Cancel, hard: Transfer.Cancel) -> Dictionary:
		return await _attempt(id, transfer_id, bytes, meta, opts, mode, progress, soft, hard, sealed)
	var release := func() -> void:
		await _d["engine"].cancel(transfer_id)
	return _tracked(Handle.start(transfer_id, progress, attempt, release))


## Register a handle: it is in `transfers()` until it settles, and its end is an event.
func _tracked(t: PKeyTransfer) -> PKeyTransfer:
	if t.outcome == null:
		_live.append(t)
		t.finished.connect(_on_finished.bind(t), CONNECT_ONE_SHOT)
	else:
		_note_outcome(t)
	return t


func _on_finished(_out: Dictionary, t: PKeyTransfer) -> void:
	_live.erase(t)
	_note_outcome(t)


func _note_outcome(t: PKeyTransfer) -> void:
	var out: Dictionary = t.outcome
	if out["state"] == "failed":
		_emit({"type": PKeyConstants.TransferEvent.TRANSFERFAILED, "id": t.id, "code": out["error"]["code"]})
	else:
		_emit({"type": PKeyConstants.TransferEvent.TRANSFERDONE, "id": t.id, "state": out["state"]})


func _emit(event: Dictionary) -> void:
	var cb: Variant = _d.get("emit")
	if cb is Callable and (cb as Callable).is_valid():
		cb.call(event)


func _precheck(id: String, size: int, metadata: Dictionary) -> Variant:
	if not _id_ok(id):
		return _err("invalid-save", "id")
	if metadata.has(BINDING_KEY):
		return _err("invalid-save", "reserved-key")
	var max_bytes: int = _d.get("max_bytes") if _d.get("max_bytes") != null else DEFAULT_MAX_BYTES
	if size > max_bytes or size > PKeySyncFileStream.LANE_MAX_BYTES or size > PKeyConstants.SYNC_FILE_MAX_BYTES:
		return _err("too-large")
	if size <= 0:
		return _err("invalid-save", "empty")
	return null


func _attempt(
	id: String,
	transfer_id: String,
	bytes: PackedByteArray,
	metadata: Dictionary,
	opts: Dictionary,
	mode: Variant,
	progress: Dictionary,
	soft: Transfer.Cancel,
	hard: Transfer.Cancel,
	sealed: Array
) -> Dictionary:
	var bad: Variant = _precheck(id, bytes.size(), metadata)
	if bad != null:
		return {"state": "failed", "error": bad}
	var refused: Variant = await _gated()
	if refused != null:
		return {"state": "failed", "error": _err(String(refused.code), refused.message)}
	var codec: Variant = _codec()
	if codec == null:
		return {"state": "failed", "error": _err("sync-locked")}
	var records = _d["records"]
	var target_id := id
	var base: Variant = null
	if mode != null and mode.has("copy"):
		var free: Variant = _free_id(id)
		if free == null:
			return {"state": "failed", "error": _err("slots-full")}
		target_id = free
		base = "*"
	elif mode != null:
		base = mode["base_version"]
	elif opts.get("base_version") != null:
		base = opts["base_version"]
	else:
		var existing: Variant = records.get_record(id)
		if existing == null:
			if records.list().size() >= PKeyConstants.SYNC_SAVE_SLOTS:
				return {"state": "failed", "error": _err("slots-full")}
			base = "*"
		else:
			base = existing["version"]
	var wire: String = records.wire_id(target_id)
	if wire == "":
		return {"state": "failed", "error": _err("sync-locked")}
	var caller_progress: Variant = opts.get("on_progress")
	var on_progress := func(done: int, total: int) -> void:
		progress["done"] = done
		progress["total"] = total
		if caller_progress is Callable:
			(caller_progress as Callable).call(done, total)
		_emit({"type": PKeyConstants.TransferEvent.TRANSFERPROGRESS, "id": transfer_id, "done": done, "total": total})
	var common := {
		"id": transfer_id, "collection": COLLECTION, "record": wire, "base_version": base,
		"on_progress": on_progress, "cancel": soft,
	}
	var stored: int = codec.stored_size(bytes.size())
	var plan := PKeySyncTransferPlan.plan(stored, bool(_d.get("delta", true)))
	if stored < 0:
		return {"state": "failed", "error": _err("sync-locked")}
	if plan.is_empty() or plan["mode"] == PKeySyncTransferPlan.MODE_TOO_LARGE:
		return {"state": "failed", "error": _err("too-large")}
	var r: PKeyResult
	if plan["mode"] == PKeySyncTransferPlan.MODE_CHUNKS:
		var chunked := common.duplicate()
		chunked["source"] = Transfer.BytesSource.new(bytes)
		chunked["codec"] = codec
		r = await _d["engine"].upload_chunked(chunked)
	else:
		if sealed[0] == null:
			sealed[0] = await _seal(codec, bytes)
		var stored_bytes: PackedByteArray = sealed[0]
		if soft.cancelled:
			return {"state": "aborted"}
		if stored_bytes.is_empty():
			sealed[0] = null
			return {"state": "failed", "error": _err("sync-locked") if codec.get("tripped") == true else _err("too-large")}
		var up := common.duplicate()
		up["source"] = Transfer.BytesSource.new(stored_bytes)
		up["size"] = stored_bytes.size()
		up["sha256"] = PKeySyncHkdf.sha256(stored_bytes).hex_encode()
		up["enc"] = codec.enc
		r = await _d["engine"].upload(up)
	if not r.ok:
		var mapped := _from_engine(r, codec)
		if mapped["state"] == "conflict":
			return _conflict(id, metadata, bytes.size(), mapped["server_version"], null, false)
		return mapped
	var file: Dictionary = r.detail
	var value := metadata.duplicate(true)
	if _e2e():
		value[BINDING_KEY] = {"sha256": file["sha256"], "size": file["size"], "format": file["format"]}
	var set_r: Dictionary = await records.set_record(target_id, value, int(file["version"]), hard)
	if set_r["ok"]:
		var done := {"state": "done", "id": id, "version": set_r["version"], "file": file}
		if target_id != id:
			done["copy_id"] = target_id
		return done
	if set_r["reason"] == "aborted":
		return {"state": "aborted"}
	if set_r["reason"] == "conflict":
		var server: Variant = set_r["server"]
		return _conflict(id, metadata, bytes.size(), server["version"] if server != null else null, server, true)
	return {"state": "failed", "error": _err("rejected", set_r.get("code", ""))}


## The whole file's stored form, sealed on a worker thread (the GDScript lane takes about a second a MiB).
## Empty when the ring locked before or during the seal.
func _seal(codec: Object, plain: PackedByteArray) -> PackedByteArray:
	var out: PackedByteArray = await Transfer.off_thread(func() -> PackedByteArray: return codec.seal_whole(plain), plain.size())
	# The ring may have locked while the thread ran: nothing sealed under it is sent.
	if codec.has_method("locked") and codec.locked():
		return PackedByteArray()
	return out


## The first `<id>.copy`, `<id>.copy2`, ... that is not a save; null when all 16 slots are in use.
func _free_id(id: String) -> Variant:
	var all: Array = _d["records"].list()
	if all.size() >= PKeyConstants.SYNC_SAVE_SLOTS:
		return null
	var taken := {}
	for r: Dictionary in all:
		taken[r["id"]] = true
	for n in range(1, 1000):
		var cand := "%s.copy%s" % [id.substr(0, 120), "" if n == 1 else str(n)]
		if not taken.has(cand):
			return cand
	return null


func _conflict(id: String, metadata: Dictionary, size: int, server_version: Variant, known: Variant, has_known: bool) -> Dictionary:
	var rec: Variant = known if has_known else _d["records"].get_record(id)
	var slots: int = _d["records"].list().size()
	var rv: Variant = rec["version"] if rec != null else server_version
	return {"state": "conflict", "conflict": {
		"id": id,
		"local": {"metadata": metadata, "size": size},
		"remote": _summary(rec) if rec != null else null,
		"server_version": rv,
		"both_available": slots < PKeyConstants.SYNC_SAVE_SLOTS,
	}}


## The person's data is gone: cancel what runs, settle waiting writes, delete the journal and the chunk
## cache. Each step is tried whatever the other did.
func purge() -> void:
	var running := _live.duplicate()
	_live.clear()
	_d["records"].drop_all()
	for t: PKeyTransfer in running:
		await t.cancel()
	var files: Variant = _d.get("purge_files")
	if files is Callable and (files as Callable).is_valid():
		files.call()
