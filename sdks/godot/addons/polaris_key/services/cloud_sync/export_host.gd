class_name PKeyCloudSyncExporter
extends RefCounted
## `cloud_sync.export()` (U-51.8; WIRE-CONTRACT-V5 section 13.12): everything around the export core
## (`core/sync/sync_export.gd`). A port of Python `cloud_sync/export_host.py`. It checks the preconditions,
## flushes the machine, pulls the rows as the Worker serves them, gives the core a file source over the SDK's
## transfer engine and a destination, and commits the archive.
##
##   Preconditions  Sync on (the typed `product` N/A, checked by the caller), one export at a time
##                  (`sync-export-failed`, reason `busy`), a signed-in person (`account_required`), the pin
##                  (`sync-encryption-pinned`) and the unlocked root in end-to-end mode (`sync-locked`).
##                  Nothing is read before they hold.
##   Pulls          `flush()` (bounded by the sign-out flush window), then this class's own pulls from cursor 0
##                  until `more` is false: at most `SYNC_EXPORT_MAX_PULLS`. Waits (a `Retry-After`, a retry's
##                  backoff) add up to at most `SYNC_EXPORT_MAX_WAIT_MS` and one is cut to
##                  `SYNC_EXPORT_RETRY_AFTER_MAX_MS`; past either bound the export fails with reason `network`;
##                  a cancel ends a wait at once. The rows are the Worker's, so the core opens each as the
##                  host codec opens a pull.
##   Files          Whole files by `Range` of the stored bytes (the engine's resume and `If-Match`), a chunked
##                  file by its manifest and its chunks, through the same `Transfer` engine and file routes
##                  `saves.read` uses (its retries, `Retry-After` and backoff), on a foreground transport of
##                  its own (never the bulk channel), so they spend the device's hourly file allowance. A file
##                  the Worker no longer has, or serves inconsistently, ends short and the core flags it
##                  partial.
##   Destination    A path, absolute or under `user://`. `<destination>.partial` is created empty, tightened to
##                  0600 where the OS has modes, and only then written; flushed and renamed over the
##                  destination. A stale `.partial` an earlier crash left is removed first; a destination or
##                  partial that is a directory or a link is refused (reason `destination`). An error or a
##                  cancel removes the partial and leaves the old destination as it was. What the engine
##                  cannot do (no exclusive create, no `O_NOFOLLOW`, no fsync, a replacing rename that is two
##                  steps on Windows) is in T33's residual note; the checks here stand in for them.
##
## `run` answers a PKeyResult: ok with `{path, bytes, entries, settings, records, files, skipped, unsynced}`,
## or a failure whose code is `account_required`, `sync-locked`, `sync-encryption-pinned`, `cancelled`,
## `sync-export-too-large` or `sync-export-failed` (the `reason` of the last in `detail`: `destination`,
## `network` or `busy`). Nothing here logs, or puts in a result, a value, an id or a path.
##
## `deps`: {host: Callable() -> the host Node, attach: Callable (a coroutine), flush: Callable (a coroutine, the
## status PKeyResult), subject: Callable() -> the session's subject or "", local_only: bool, now: Callable() -> ms,
## sleep: Callable(seconds) (a coroutine; tests inject one that only records)}.

const Transport := preload("res://addons/polaris_key/services/cloud_sync/transport.gd")
const FilesTransport := preload("res://addons/polaris_key/services/cloud_sync/files_transport.gd")
const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")
const TransferCodec := preload("res://addons/polaris_key/services/cloud_sync/transfer_codec.gd")
const Support := preload("res://addons/polaris_key/services/cloud_sync/transfer_support.gd")
const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

## Attempts at one request before the export gives up (reason `network`).
const MAX_ATTEMPTS := 8
const BACKOFF_BASE := 0.5
const BACKOFF_CAP := 30.0
const OWNER_RW := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER

var _deps: Dictionary
var _running := false
var _cancel: Transfer.Cancel = null


func _init(deps: Dictionary) -> void:
	_deps = deps


## True while an export runs.
func running() -> bool:
	return _running


## Cancels the export in flight (a no-op when none runs): it stops at its next step, removes the partial,
## leaves the old destination and answers `cancelled`.
func cancel() -> void:
	if _cancel != null:
		_cancel.cancelled = true


static func _failure(code: String, reason := "") -> PKeyResult:
	var detail: Variant = {"reason": reason} if reason != "" else null
	match code:
		PKeyConstants.ErrorCode.CANCELLED:
			return PKeyResult.failure(StringName(code), "The export was cancelled.", detail)
		PKeyConstants.ErrorCode.SYNC_EXPORT_TOO_LARGE:
			return PKeyResult.failure(StringName(code), "The export is too large.", detail)
		PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED:
			return PKeyResult.failure(StringName(code), "The export failed: " + reason, detail)
		PKeyConstants.ErrorCode.ACCOUNT_REQUIRED:
			return PKeyResult.failure(StringName(code), "Cloud Sync needs a signed-in account.", detail)
		PKeyConstants.ErrorCode.SYNC_LOCKED:
			return PKeyResult.failure(StringName(code), "Cloud Sync is locked: there is no root.", detail)
		PKeyConstants.ErrorCode.SYNC_ENCRYPTION_PINNED:
			return PKeyResult.failure(StringName(code), "Cloud Sync is pinned to another encryption mode.", detail)
	return PKeyResult.failure(StringName(code), "The export failed.", detail)


## One export. A coroutine.
func run(destination: String, options: Dictionary = {}) -> PKeyResult:
	if _running:
		return _failure(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "busy")
	_running = true
	_cancel = Transfer.Cancel.new()
	var out := await _run(destination, options)
	_running = false
	_cancel = null
	return out


func _run(destination: String, options: Dictionary) -> PKeyResult:
	await _deps["attach"].call()
	var host: Node = _deps["host"].call()
	var pre := _gate(host)
	if not pre["ok"]:
		return pre["failure"]
	var sink := _PartialFile.new(destination)
	if sink.prepare() != "":
		return _failure(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "destination")

	var state := {"done": 0, "total": 0, "waiting": false}
	var progress: Variant = options.get("on_progress")
	var report := func() -> void:
		if progress is Callable and (progress as Callable).is_valid():
			progress.call(state.duplicate())
	var budget := _Budget.new(_cancel, _deps.get("sleep", Callable()), func(waiting: bool) -> void:
		state["waiting"] = waiting
		report.call())
	var ctx_fn := func() -> Dictionary: return host.request_context()
	var tr := FilesTransport.make_transport(host, _deps.get("local_only", false))
	var transport := FilesTransport.new(tr, ctx_fn)
	var engine := Transfer.new(transport, null)
	engine.max_attempts = MAX_ATTEMPTS
	engine.max_retry_after = float(PKeyConstants.SYNC_EXPORT_RETRY_AFTER_MAX_MS) / 1000.0
	engine.sleep = func(seconds: float) -> void: await budget.wait(seconds)

	# Send what is waiting, then read what the Worker holds.
	var flushed: Variant = await _deps["flush"].call()
	var unsynced := 0
	if flushed is PKeyResult and flushed.ok and flushed.detail is Dictionary:
		unsynced = int(flushed.detail.get("pending", 0))
	if _cancel.cancelled:
		return _failure(PKeyConstants.ErrorCode.CANCELLED)
	var pulled: Dictionary = await _Puller.new(tr, ctx_fn, _cancel, budget).all(pre["client_id"])
	if not pulled["ok"]:
		return _failure(pulled["code"], pulled.get("reason", ""))

	var codec: Object = host.codec() if pre["e2e"] else null
	var inp := {
		"product": ctx_fn.call()["product"],
		"exported_at": _now(),
		"unsynced": unsynced,
		"include_revisions": options.get("include_revisions", false) == true,
		"changes": pulled["changes"],
		"files": _Source.new(transport, engine, _cancel, budget),
		"codec": codec,
		"file_codec": func(collection: String) -> Variant: return TransferCodec.e2e_for(codec, collection) if codec != null else TransferCodec.Server.new(),
		"cancel": _cancel,
		"on_progress": func(done: int, total: int) -> void:
			state["done"] = done
			state["total"] = total
			report.call(),
	}
	var result: Dictionary = await PKeySyncExport.run(inp, sink)
	result = _settle(result, sink, budget)
	if not result["ok"]:
		sink.discard()
		return _failure(result["code"], result.get("reason", ""))
	return PKeyResult.success({
		"path": destination, "bytes": result["bytes"], "entries": result["entries"], "settings": result["settings"],
		"records": result["records"], "files": result["files"], "skipped": result["skipped"], "unsynced": unsynced,
	})


## What the export ends with: a cancel that came after the core finished still cancels, a wait past its bound
## raised the cancel flag (a network failure, not the app's cancel), and the commit is the last step.
func _settle(result: Dictionary, sink: _PartialFile, budget: _Budget) -> Dictionary:
	if result["ok"] and _cancel.cancelled:
		result = {"ok": false, "code": PKeyConstants.ErrorCode.CANCELLED, "reason": ""}
	if not result["ok"] and result["code"] == PKeyConstants.ErrorCode.CANCELLED and budget.exceeded:
		result = {"ok": false, "code": PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "reason": "network"}
	if result["ok"] and not sink.commit():
		result = {"ok": false, "code": PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "reason": "destination"}
	return result


func _now() -> int:
	var clock: Variant = _deps.get("now")
	if clock is Callable and (clock as Callable).is_valid():
		return clock.call()
	return int(Time.get_unix_time_from_system() * 1000.0)


## `{ok: true, e2e, client_id}` or `{ok: false, failure}`: the host runs and the preconditions hold.
func _gate(host: Node) -> Dictionary:
	if host == null or not host.is_started():
		return {"ok": false, "failure": _failure(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "network")}
	var m: Object = host.machine()
	var st: Dictionary = m.status()
	var e2e: bool = m.encryption_mode() == "e2e"
	var persisted: Dictionary = m.persist()
	var subject: Variant = persisted.get("subject")
	var refusal := _refusal(host, st, subject, e2e)
	if refusal != "":
		return {"ok": false, "failure": _failure(refusal, "network" if refusal == PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED else "")}
	var partition: Variant = (persisted.get("partitions", {}) as Dictionary).get(subject)
	var cid: Variant = (partition as Dictionary).get("clientId") if partition is Dictionary else null
	if not (cid is String) or cid == "":
		return {"ok": false, "failure": _failure(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "network")}
	return {"ok": true, "e2e": e2e, "client_id": cid}


## The error code the machine's state refuses the export with, or "".
func _refusal(host: Node, st: Dictionary, subject: Variant, e2e: bool) -> String:
	if st.get("code") == PKeyConstants.ErrorCode.SYNC_ENCRYPTION_PINNED:
		return PKeyConstants.ErrorCode.SYNC_ENCRYPTION_PINNED
	var state: Variant = st.get("state")
	var refused: bool = state == "blocked" and st.get("reason") == "account_required"
	if subject == null or state == "local" or refused:
		return PKeyConstants.ErrorCode.ACCOUNT_REQUIRED
	var current: String = _deps["subject"].call() if _deps.get("subject") is Callable else ""
	# An unknown session subject is not proof of another person.
	if current != "" and current != subject:
		return PKeyConstants.ErrorCode.ACCOUNT_REQUIRED
	if e2e and host.codec().locked():
		return PKeyConstants.ErrorCode.SYNC_LOCKED
	return PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED if state == "blocked" else ""


## Everything the export waits for, added up: past `SYNC_EXPORT_MAX_WAIT_MS` it fails (reason `network`) and
## the cancel flag is raised so every loop ends. A cancel ends a wait at once.
class _Budget:
	extends RefCounted
	var waited_ms := 0.0
	## True once a bound was passed: the export's failure is `network`, not `cancelled`.
	var exceeded := false
	var _cancel: Transfer.Cancel
	var _sleep: Callable
	var _on_wait: Callable

	func _init(cancel: Transfer.Cancel, sleep: Callable, on_wait: Callable) -> void:
		_cancel = cancel
		_sleep = sleep
		_on_wait = on_wait

	## Waits `seconds` (cut to one wait's bound). False when the budget is spent or a cancel came.
	func wait(seconds: float) -> bool:
		if _cancel.cancelled:
			return false
		seconds = maxf(0.0, minf(seconds, float(PKeyConstants.SYNC_EXPORT_RETRY_AFTER_MAX_MS) / 1000.0))
		if waited_ms + seconds * 1000.0 > float(PKeyConstants.SYNC_EXPORT_MAX_WAIT_MS):
			exceeded = true
			_cancel.cancelled = true
			return false
		waited_ms += seconds * 1000.0
		_on_wait.call(true)
		if _sleep.is_valid():
			await _sleep.call(seconds)
		else:
			var tree := Engine.get_main_loop() as SceneTree
			var left := seconds
			while left > 0.0 and not _cancel.cancelled:
				var step := minf(left, 0.25)
				await tree.create_timer(step).timeout
				left -= step
		_on_wait.call(false)
		return not _cancel.cancelled

	## The failure the export ends with once its cancel flag is up.
	func failure_code() -> Dictionary:
		if exceeded:
			return {"code": PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "reason": "network"}
		return {"code": PKeyConstants.ErrorCode.CANCELLED, "reason": ""}


## The pulls: from cursor 0 until `more` is false, bounded.
class _Puller:
	extends RefCounted
	var _tr: PKeyTransport
	var _ctx: Callable
	var _cancel: Transfer.Cancel
	var _budget: _Budget

	func _init(tr: PKeyTransport, ctx: Callable, cancel: Transfer.Cancel, budget: _Budget) -> void:
		_tr = tr
		_ctx = ctx
		_cancel = cancel
		_budget = budget

	func _stopped() -> Dictionary:
		var f := _budget.failure_code()
		f["ok"] = false
		return f

	static func _net_fail() -> Dictionary:
		return {"ok": false, "code": PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "reason": "network"}

	## One request: `{status, body, told}` (status 0: no answer), or a failure `{ok: false, ...}` that no retry mends.
	func _once(path: String) -> Dictionary:
		var ctx: Dictionary = _ctx.call()
		var token: String = ctx["token"]
		if token == "":
			return {"ok": false, "code": PKeyConstants.ErrorCode.ACCOUNT_REQUIRED, "reason": ""}
		if not Transport.is_sync_path(ctx["product"], path):
			return _net_fail()
		var headers: Dictionary = ctx["headers"].call({"authorization": "Bearer " + token, "accept": "application/json"})
		var r: PKeyResult = await _tr.request("GET", ctx["url"].call(path), headers, PackedByteArray(), {"follow_redirects": false})
		if r.ok:
			return {"status": int(r.detail["status"]), "body": r.detail["body"], "told": FilesTransport.retry_after_seconds((r.detail["headers"] as Dictionary).get("retry-after"))}
		if r.code == PKeyErrors.LOCAL_ONLY:
			return _net_fail()
		return {"status": 0, "body": PackedByteArray(), "told": -1.0}

	## The answer of an attempt as a result, or `{}` when it is worth another try.
	static func _verdict(got: Dictionary) -> Dictionary:
		var status: int = got["status"]
		var body: PackedByteArray = got["body"]
		if status == 200:
			var parsed := Types.load_json_bytes(body)
			return {"ok": true, "body": parsed["value"]} if parsed["ok"] and parsed["value"] is Dictionary else _net_fail()
		if status == 403 and body.get_string_from_utf8().contains(PKeyConstants.ErrorCode.ACCOUNT_REQUIRED):
			return {"ok": false, "code": PKeyConstants.ErrorCode.ACCOUNT_REQUIRED, "reason": ""}
		if status != 0 and status != 408 and status != 429 and status < 500:
			return _net_fail()
		return {}

	## One `GET` of a sync route with bounded retries: `{ok: true, body}` or `{ok: false, code, reason}`.
	func _get_json(path: String) -> Dictionary:
		for attempt in MAX_ATTEMPTS:
			if _cancel.cancelled:
				return _stopped()
			var got := await _once(path)
			if got.has("ok"):
				return got
			var verdict := _verdict(got)
			if not verdict.is_empty():
				return verdict
			if attempt + 1 >= MAX_ATTEMPTS:
				break
			var told: float = got["told"]
			var delay := told if told >= 0.0 else minf(BACKOFF_CAP, BACKOFF_BASE * pow(2.0, attempt))
			if not await _budget.wait(delay):
				return _stopped()
		return _net_fail()

	static func _row_ref(c: Dictionary) -> Variant:
		var r: Variant = c.get("record")
		if r is Array and (r as Array).size() >= 2 and r[0] is String and r[1] is String:
			return JSON.stringify([r[0], r[1]])
		return null

	## `{ok: true, changes}`: the rows the Worker holds, as served (a later row replaces an earlier one, a
	## tombstone removes it), or a failure.
	func all(client_id: String) -> Dictionary:
		var product: String = _ctx.call()["product"]
		var settings := {}
		var records := {}
		var cursor := 0
		for _page in PKeyConstants.SYNC_EXPORT_MAX_PULLS:
			var got := await _get_json("/%s/sync?cursor=%d&clientId=%s" % [product, cursor, client_id])
			if not got["ok"]:
				return got
			var body: Dictionary = got["body"]
			if body.get("changes") is Array:
				for c in body["changes"]:
					if not (c is Dictionary):
						continue
					if c.get("setting") is String:
						settings[c["setting"]] = c
					else:
						var key: Variant = _row_ref(c)
						if key != null:
							records[key] = c
			if body.get("tombstones") is Array:
				for t in body["tombstones"]:
					if not (t is Dictionary):
						continue
					if t.get("setting") is String:
						settings.erase(t["setting"])
					var tkey: Variant = _row_ref(t)
					if tkey != null:
						records.erase(tkey)
			if body.get("more") != true:
				var out: Array = settings.values()
				out.append_array(records.values())
				return {"ok": true, "changes": out}
			var next: Variant = body.get("cursor")
			if not Types.is_number(next) or float(next) <= float(cursor):
				return {"ok": false, "code": PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "reason": "network"}
			cursor = int(next)
		# More pages than the bound allows: the export does not wait for ever on a Worker that never ends.
		return {"ok": false, "code": PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "reason": "network"}


## The core's file source over the file routes and the transfer engine.
class _Source:
	extends RefCounted
	## `{code, reason}` once the source failed beyond recovery (the core stops with it).
	var error: Dictionary = {}
	var _transport: FilesTransport
	var _engine: Transfer
	var _cancel: Transfer.Cancel
	var _budget: _Budget

	func _init(transport: FilesTransport, engine: Transfer, cancel: Transfer.Cancel, budget: _Budget) -> void:
		_transport = transport
		_engine = engine
		_cancel = cancel
		_budget = budget

	func fail(code: String, reason := "") -> void:
		if error.is_empty():
			error = {"code": code, "reason": reason}

	## One route call with the engine's recovery rules. null is "the Worker has none" (a path the routes refuse to
	## build, a 404, a 410); any other refusal sets `error` (and answers null).
	func _call(collection: String, record: String, fn: Callable) -> Variant:
		var ps := _engine._new_pass(collection, record, _cancel)
		var reply: Dictionary = await _engine._call(ps, fn)
		if reply.has("reason"):
			var why := String(reply["reason"])
			if why == "aborted":
				var f := _budget.failure_code()
				fail(f["code"], f["reason"])
			else:
				fail(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "network")
			return null
		if reply["ok"]:
			return reply
		var status: int = reply["status"]
		if status == 404 or status == 410 or (status == 400 and reply.get("code") == "bad_path"):
			return null
		if status == 403 and reply.get("code") == PKeyConstants.ErrorCode.ACCOUNT_REQUIRED:
			fail(PKeyConstants.ErrorCode.ACCOUNT_REQUIRED)
			return null
		fail(PKeyConstants.ErrorCode.SYNC_EXPORT_FAILED, "network")
		return null

	func pointers(collection: String, record: String) -> Array:
		var target := {"collection": collection, "record": record, "transfer": ""}
		var reply: Variant = await _call(collection, record, func() -> Dictionary: return await _transport.revisions(target))
		if reply == null or not (reply["value"] is Dictionary):
			return []
		var revs: Variant = reply["value"].get("revisions")
		var out: Array = []
		if revs is Array:
			for r in revs:
				if r is Dictionary:
					out.append(r)
		return out

	func open_stored(ref: Dictionary) -> Variant:
		return _StoredReader.new(self, ref)

	func chunk(collection: String, id_hex: String) -> Variant:
		var reply: Variant = await _call(collection, "", func() -> Dictionary: return await _transport.get_chunk(collection, id_hex, ""))
		if reply == null or not (reply["value"] is PackedByteArray):
			return null
		return reply["value"]

	## One ranged read of a stored object: `{status, data, etag, content_range}` or null.
	func get_range(ref: Dictionary, query: Dictionary) -> Variant:
		var target := {"collection": ref["collection"], "record": ref["record"], "transfer": ""}
		var reply: Variant = await _call(ref["collection"], ref["record"], func() -> Dictionary: return await _transport.get_file(target, query))
		return reply["value"] if reply != null and reply["value"] is Dictionary else null


## The stored bytes of one version in pieces: a whole file by `Range` (8 MiB at a time, `If-Match` on the first
## ETag), a manifest in one unranged read. An answer that is inconsistent (another file, another range, a 200 for a
## range) ends the stream there: the core flags what it read as partial.
class _StoredReader:
	extends RefCounted
	var _src: _Source
	var _ref: Dictionary
	var _at := 0
	var _etag: Variant = null
	var _done := false

	func _init(src: _Source, ref: Dictionary) -> void:
		_src = src
		_ref = ref

	func close() -> void:
		_done = true

	func read_piece() -> PackedByteArray:
		var empty := PackedByteArray()
		var version: Variant = Support.whole(_ref.get("version"))
		if _done or version == null:
			_done = true
			return empty
		if _ref["format"] == "chunks":
			_done = true
			var whole: Variant = await _src.get_range(_ref, {"version": version, "range": null, "if_match": null})
			return whole["data"] if whole != null and whole["status"] == 200 else empty
		var size: int = _ref["size"]
		if _at >= size:
			_done = true
			return empty
		var ask := _at
		var body: Variant = await _src.get_range(_ref, {"version": version, "range": [ask, mini(size, ask + Transfer.DOWNLOAD_RANGE_BYTES)], "if_match": _etag})
		if body == null or not _consistent(body, ask, size):
			_done = true
			return empty
		_at += (body["data"] as PackedByteArray).size()
		return body["data"]

	## Whether a ranged answer is the range asked of the same file (the ETag held, `Content-Range` where it
	## belongs, a whole 200 only for a read from the start).
	func _consistent(body: Dictionary, ask: int, size: int) -> bool:
		var data: PackedByteArray = body["data"]
		if _etag != null and body.get("etag") != null and body["etag"] != _etag:
			return false
		if _etag == null:
			_etag = body.get("etag")
		if body["status"] == 206:
			var cr: Variant = body.get("content_range")
			var end := mini(size, ask + Transfer.DOWNLOAD_RANGE_BYTES)
			return cr is Array and cr.size() == 3 and cr[0] == ask and cr[2] == size and cr[1] > cr[0] and cr[1] <= end and data.size() == cr[1] - cr[0]
		return body["status"] == 200 and ask == 0 and data.size() == size


## The path destination as the core's sink. Nothing is created until the first write (a refused export leaves
## nothing); `commit` renames, `discard` removes the partial this object created, and only that.
class _PartialFile:
	extends RefCounted
	var dest := ""
	var partial := ""
	var _f: FileAccess = null
	var _created := false

	func _init(destination: Variant) -> void:
		if not (destination is String):
			return
		var path: String = destination
		# A String cannot hold NUL; a path is absolute or under user://, never res://, never up a tree.
		if path == "" or path.get_file() == "" or path.begins_with("res://") or path.contains("\u0000"):
			return
		if not (path.is_absolute_path() or path.begins_with("user://")):
			return
		if path.simplify_path().get_file() == "..":
			return
		dest = path
		partial = path + ".partial"

	static func _is_link(path: String) -> bool:
		var parent := DirAccess.open(path.get_base_dir())
		return parent != null and parent.is_link(path.get_file())

	static func _exists(path: String) -> bool:
		return FileAccess.file_exists(path) or DirAccess.dir_exists_absolute(path) or _is_link(path)

	## "" when the destination can be used; else "destination". A destination or a partial that is a directory or a
	## link is refused; a stale regular partial is removed.
	func prepare() -> String:
		if dest == "" or not DirAccess.dir_exists_absolute(dest.get_base_dir()):
			return "destination"
		if DirAccess.dir_exists_absolute(dest) or _is_link(dest):
			return "destination"
		if _exists(partial):
			if DirAccess.dir_exists_absolute(partial) or _is_link(partial):
				return "destination"
			if DirAccess.remove_absolute(partial) != OK:
				return "destination"
		return ""

	## Creates the partial empty, tightens its mode, then opens it for writing: no data is ever in a file with the
	## mode the umask gave.
	func _open() -> bool:
		var made := FileAccess.open(partial, FileAccess.WRITE)
		if made == null:
			return false
		_created = true
		made.close()
		if _is_link(partial) or DirAccess.dir_exists_absolute(partial):
			return false
		if OS.has_feature("macos") or OS.has_feature("linuxbsd"):
			if FileAccess.set_unix_permissions(partial, OWNER_RW) != OK:
				return false
		_f = FileAccess.open(partial, FileAccess.READ_WRITE)
		return _f != null

	func write(data: PackedByteArray) -> bool:
		if _f == null and not _open():
			return false
		_f.store_buffer(data)
		return _f.get_error() == OK

	## Flush and rename over the destination (replacing it). False leaves the partial for `discard`.
	func commit() -> bool:
		if _f == null and not _open():
			return false
		_f.flush()
		var ok := _f.get_error() == OK
		_f.close()
		_f = null
		if not ok:
			return false
		if DirAccess.dir_exists_absolute(dest) or _is_link(dest):
			return false
		if DirAccess.rename_absolute(partial, dest) != OK:
			return false
		_created = false
		return true

	## Close and remove the partial; the destination is left as it was.
	func discard() -> void:
		if _f != null:
			_f.close()
			_f = null
		if _created:
			_created = false
			DirAccess.remove_absolute(partial)
