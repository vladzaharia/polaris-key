class_name PKeyAppleBulk
extends "res://addons/polaris_key/services/cloud_sync/bulk_channel.gd"
## The iOS bulk-body channel of Cloud Sync file transfers (U-41.5c; GODOT-MOBILE-SYNC D-5, D-7, D-9): the
## port of services/cloud_sync/bulk_channel.gd over the binary entry of the `PolarisKeyApple` plugin
## (`PKeyApple.cmd_bin` and `poll_bin("sb_")`; sdks/swift PolarisKeyPlatform/SyncBulkOps.swift). The sealed
## bodies travel on a background `URLSession`, so the system finishes them while the game is suspended.
##
##   open       `sb_open {product, origin, state_dir, keep}`, then the `sb_reconciled` event: the transfers
##              whose native tasks were lost (they are sent again by the journal's own resume).
##   put        the body is staged into the spool in pieces of at most 8 MiB (`sb_stage`), then `sb_put` with
##              a header of at most 16 KiB (the head and the spool name). The answer is the `sb_done` or
##              `sb_fail` event of its request, routed by kind and request id.
##   fetch      `sb_get` with the same header, no spool.
##   cancel     `sb_cancel` by request or by transfer; final: a late event for it is dropped.
##   close      `sb_close`; every request in flight answers a failure.
##
## The platform keeps 300 tasks at most, so at most 300 requests are in flight here; the rest wait for a free
## place. The bearer (D-9) is read from the head of one request, written into that request's header and
## nowhere else: not into a field of this object, a spool file, an event or a log line. The header buffer is
## zeroed after the call. Nothing here keeps a ledger of finished work: the journal and the server are the
## truth.
##
## Where the platform's hook runs the system's completion handler: the engine's own application delegate
## calls it right after forwarding the event (native/ios/pkey_apple.m), so a relaunch for finished
## transfers is handled, but the system is told "done" before this object has read the events.

## A place under the task bound was freed, or a waiting request was cancelled.
signal slot_freed

const OK_BYTE := 1
## The platform's task bound (SyncBulkPolicy.maxTasks).
const MAX_TASKS := 300
## One `sb_stage` piece, and the most a staged file may hold (SyncBulkPolicy.pieceMax, stagedMax).
const PIECE_BYTES := 8 * 1048576
const STAGED_MAX := 16 * 1048576
const HEADER_MAX := 16 * 1024
const KEEP_MAX := 1024
const ID_MAX := 256
## The id a request with no journal transfer carries (FilesTransport.UNSCOPED).
const UNSCOPED := "unscoped"

## How long `open` waits for the reconcile report before it assumes every kept transfer lost its tasks.
var open_timeout_s := 10.0

var _apple: PKeyApple = null
var _product := ""
var _origin := ""
var _state_dir := ""
var _open := false
var _refused := false
var _reconciled: Variant = null
var _pumping := false
## req -> _Call: every request not yet answered, including those waiting for a place.
var _pending := {}
## req -> true: the requests holding one of the platform's places (staging or queued natively).
var _slots := {}


## One request's wait: settled by its event, a cancel or the close, whichever is first.
class _Call:
	extends RefCounted
	signal settled
	var done := false
	var result := {}
	var transfer := ""

	func settle(r: Dictionary) -> void:
		if done:
			return
		done = true
		result = r
		settled.emit()


## The channel for `product` at `origin` (scheme://host[:port], the default port left out), or null where
## there is none: off iOS, without the plugin or in a build that predates the bulk ops. `state_dir` holds the
## spool. `apple` is a PKeyApple over a fake native in tests; the process's shared one otherwise.
static func create(p_product: String, p_origin: String, p_state_dir: String, apple: PKeyApple = null) -> PKeyAppleBulk:
	if p_product.is_empty() or p_origin.is_empty() or p_state_dir.is_empty():
		return null
	if apple == null:
		if PKeyHeaders.update_platform() != PKeyConstants.Platform.IOS or not ClassDB.class_exists(PKeyApple.NATIVE_CLASS):
			return null
		apple = PKeyApple.shared()
	var platform := apple.platform if apple.platform != "" else PKeyHeaders.update_platform()
	if platform != PKeyConstants.Platform.IOS or not apple.binary_available():
		return null
	var out := PKeyAppleBulk.new()
	out._apple = apple
	out._product = p_product
	out._origin = p_origin
	out._state_dir = p_state_dir
	return out


## The origin of a base URL as the native side pins it: scheme://host, with a port only when it is not the
## scheme's default. "" for a URL that is not absolute http(s).
static func origin_of(base_url: String) -> String:
	var u := PKeyTransport.parse_url(base_url)
	if u.is_empty():
		return ""
	var default_port := 443 if u["scheme"] == "https" else 80
	var host: String = u["host"]
	if host.contains(":"):
		host = "[" + host + "]"
	return "%s://%s%s" % [u["scheme"], host, "" if int(u["port"]) == default_port else ":%d" % int(u["port"])]


## The channel the host uses (D-10): the one the app or glue set, else on iOS the Apple one when the app
## opted in. Null: none, and the transfer runs as before.
static func pick(opts: PKeyOptions, product: String, base_url: String, state_dir: String, apple: PKeyApple = null) -> Object:
	if opts == null or not opts.cloud_sync_background_transfers:
		return null
	if opts.cloud_sync_bulk_channel != null:
		return opts.cloud_sync_bulk_channel
	return create(product, origin_of(base_url), state_dir, apple)


func available() -> bool:
	return _apple != null and not _refused and _apple.binary_available()


func open(keep_ids: Array) -> Dictionary:
	var none := {"resume": [], "cancelled": 0, "swept": 0}
	if not available():
		return none
	var keep: Array = []
	var extra: Array = []
	for id in keep_ids:
		var s := str(id)
		if s.is_empty() or s.to_utf8_buffer().size() > ID_MAX or keep.size() >= KEEP_MAX:
			extra.append(s)
		else:
			keep.append(s)
	# What a session before this one left in the native queue is not for this one.
	_apple.poll_bin("sb_")
	var r := _apple.cmd_bin("sb_open", JSON.stringify({"product": _product, "origin": _origin, "state_dir": ProjectSettings.globalize_path(_state_dir), "keep": keep}).to_utf8_buffer())
	if r.is_empty() or r[0] != OK_BYTE:
		# The platform will not carry bodies for this session: the usual transport takes over.
		_refused = true
		return none
	_open = true
	_reconciled = null
	var tree := Engine.get_main_loop() as SceneTree
	var t0 := Time.get_ticks_msec()
	while _open:
		_drain()
		if _reconciled != null or tree == null or Time.get_ticks_msec() - t0 > int(open_timeout_s * 1000.0):
			break
		await tree.process_frame
	var report: Dictionary = _reconciled if _reconciled is Dictionary else {}
	var resume: Array = []
	if _reconciled == null:
		# No report: take every kept transfer for lost. The journal and the server decide what is left to send.
		resume = keep.duplicate()
	else:
		for id in report.get("resume", []):
			if id is String:
				resume.append(id)
	resume.append_array(extra)
	return {"resume": resume, "cancelled": int(report.get("cancelled", 0)), "swept": int(report.get("swept", 0))}


func put(head: Dictionary, body: PackedByteArray) -> Dictionary:
	return await _request(head, body, true)


func fetch(head: Dictionary) -> Dictionary:
	return await _request(head, PackedByteArray(), false)


func cancel(what: Variant) -> void:
	if not _open:
		return
	if what is String:
		var transfer: String = UNSCOPED if what == "" else what
		for req in _pending.keys():
			if (_pending[req] as _Call).transfer == transfer:
				_forget(req, "network")
		_native_cancel({"transfer": transfer})
	elif what is int:
		_forget(what, "network")
		_native_cancel({"req": what})


func close() -> void:
	if _apple != null and _apple.binary_available():
		_apple.cmd_bin("sb_close", PackedByteArray())
	_open = false
	_refused = false
	_reconciled = null
	for req in _pending.keys():
		_forget(req, "network")


# ── One request ──────────────────────────────────────────────────────────────────────────────────

func _request(head: Dictionary, body: PackedByteArray, is_put: bool) -> Dictionary:
	var fail := {"fail": "network"}
	var req := int(head.get("req", 0))
	if not _open or req <= 0 or _pending.has(req) or (is_put and body.size() > STAGED_MAX):
		return fail
	var entry := _Call.new()
	var transfer := str(head.get("transfer", ""))
	entry.transfer = UNSCOPED if transfer == "" else transfer
	_pending[req] = entry
	# A place under the platform's task bound.
	while _slots.size() >= MAX_TASKS and not entry.done:
		await slot_freed
	if entry.done:
		return _finish(req, entry)
	_slots[req] = true
	var spool := ""
	if is_put:
		spool = await _stage(entry, body)
		if entry.done or spool == "":
			if spool != "":
				_native_cancel({"spool": spool})
			return _finish(req, entry, fail)
	var header := _header(head, req, entry.transfer, spool)
	var reply := PackedByteArray()
	if not header.is_empty():
		reply = _apple.cmd_bin("sb_put" if is_put else "sb_get", header)
	header.fill(0)
	if reply.is_empty() or reply[0] != OK_BYTE:
		# The platform did not take it: a staged file that no task owns goes with it.
		if spool != "":
			_native_cancel({"spool": spool})
		return _finish(req, entry, fail)
	_ensure_pump()
	if not entry.done:
		await entry.settled
	return _finish(req, entry)


## Stage `body` into the spool, piece by piece, a frame apart. The native file name, or "" when it did not
## take (or the request was cancelled meanwhile).
func _stage(entry: _Call, body: PackedByteArray) -> String:
	var tree := Engine.get_main_loop() as SceneTree
	var name := ""
	var off := 0
	while true:
		var n := mini(PIECE_BYTES, body.size() - off)
		var data := PackedByteArray([0] if name.is_empty() else [36])
		if not name.is_empty():
			data.append_array(name.to_ascii_buffer())
		data.append_array(body.slice(off, off + n))
		var r := _apple.cmd_bin("sb_stage", data)
		if r.size() != 37 or r[0] != OK_BYTE:
			if not name.is_empty():
				_native_cancel({"spool": name})
			return ""
		name = r.slice(1).get_string_from_ascii()
		off += n
		if off >= body.size():
			return name
		if tree != null:
			await tree.process_frame
		if entry.done:
			return name
	return name


## The framed header of one request, or an empty array if it does not fit.
func _header(head: Dictionary, req: int, transfer: String, spool: String) -> PackedByteArray:
	var h := {
		"req": req, "transfer": transfer, "url": str(head.get("url", "")), "headers": head.get("headers", {}),
		"bearer": str(head.get("bearer", "")), "max_body": int(head.get("max_body", 0)), "part": int(head.get("part", 0)),
	}
	if spool != "":
		h["spool"] = spool
	var json := JSON.stringify(h).to_utf8_buffer()
	h.clear()
	if json.is_empty() or json.size() > HEADER_MAX:
		json.fill(0)
		return PackedByteArray()
	var out := PackedByteArray()
	out.resize(4)
	out[0] = (json.size() >> 24) & 0xff
	out[1] = (json.size() >> 16) & 0xff
	out[2] = (json.size() >> 8) & 0xff
	out[3] = json.size() & 0xff
	out.append_array(json)
	json.fill(0)
	return out


## End a request: free its place, drop it from the table, and answer.
func _finish(req: int, entry: _Call, otherwise: Dictionary = {"fail": "network"}) -> Dictionary:
	_pending.erase(req)
	if _slots.erase(req):
		slot_freed.emit()
	return entry.result if entry.done else otherwise


## Answer a request with a failure and free its place (a cancel, or the close).
func _forget(req: int, code: String) -> void:
	var entry: Variant = _pending.get(req)
	if entry == null:
		return
	_slots.erase(req)
	slot_freed.emit()
	(entry as _Call).settle({"fail": code})


func _native_cancel(q: Dictionary) -> void:
	if _apple != null and _apple.binary_available():
		_apple.cmd_bin("sb_cancel", JSON.stringify(q).to_utf8_buffer())


# ── Events ───────────────────────────────────────────────────────────────────────────────────────

func _ensure_pump() -> void:
	if _pumping:
		return
	_pumping = true
	var tree := Engine.get_main_loop() as SceneTree
	while _open and tree != null and not _pending.is_empty():
		_drain()
		if _pending.is_empty():
			break
		await tree.process_frame
	_pumping = false


func _drain() -> void:
	for e in _apple.poll_bin("sb_"):
		_route(e[0], e[1])


func _route(kind: String, data: PackedByteArray) -> void:
	if kind == "sb_done":
		_done(data)
		return
	var j := JSON.new()
	if j.parse(data.get_string_from_utf8()) != OK or not (j.data is Dictionary):
			return
	var d: Dictionary = j.data
	if kind == "sb_fail":
		_answer(int(d.get("req", 0)), {"fail": "oversize" if d.get("code") == "oversize" else "network"})
	elif kind == "sb_reconciled":
		_reconciled = d


## `u32be length ‖ JSON {req, status, headers} ‖ body`.
func _done(data: PackedByteArray) -> void:
	if data.size() < 4:
		return
	var n := (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]
	if n <= 0 or 4 + n > data.size():
		return
	var j := JSON.new()
	if j.parse(data.slice(4, 4 + n).get_string_from_utf8()) != OK or not (j.data is Dictionary):
		return
	var d: Dictionary = j.data
	var headers := {}
	if d.get("headers") is Dictionary:
		for k in d["headers"]:
			if d["headers"][k] is String:
				headers[String(k).to_lower()] = d["headers"][k]
	_answer(int(d.get("req", 0)), {"status": int(d.get("status", 0)), "headers": headers, "body": data.slice(4 + n)})


## Hand an answer to its request. An event for a request nobody waits for (cancelled, closed) is dropped.
func _answer(req: int, answer: Dictionary) -> void:
	if not _slots.has(req):
		return
	var entry: Variant = _pending.get(req)
	if entry == null:
		return
	if _slots.erase(req):
		slot_freed.emit()
	(entry as _Call).settle(answer)
