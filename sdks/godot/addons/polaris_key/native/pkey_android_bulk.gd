@tool
class_name PKeyAndroidBulk
extends "res://addons/polaris_key/services/cloud_sync/bulk_channel.gd"
## The Android lane of the bulk-body channel (U-41.6b; GODOT-MOBILE-SYNC D-5, D-9): sealed PUT bodies and GET
## answers of Cloud Sync file transfers move through the `PolarisKeyAndroid` plugin's binary methods `sbOpen`,
## `sbStage`, `sbPut`, `sbGet`, `sbTake`, `sbCancel` and `sbClose` (sdks/godot/native/android, `BulkCommands`),
## so a system-scheduled job finishes them while the game is paused. `byte[]` in and out; a reply is a status
## byte, then the result (1 ok, 0 refused, 3 bad input).
##
## Shape. `put` and `fetch` are coroutines that resolve on the plugin's `sb_done` or `sb_fail` event, which the
## `PKeyAndroid` facade routes by kind to its `bulk_event` signal. This class stages the sealed body into the
## plugin's spool in pieces of at most 8 MiB, one frame apart, then queues the request by the staged file's name.
## An event is matched to a request in flight by its `req` AND its transfer; anything else (a forged or a replayed
## event, one for a request already answered or cancelled) is dropped. A request nobody answers does not return:
## the caller owns the deadline and calls `cancel`. The plugin ends a transfer's run by itself after it has been
## idle, so this class never ends a transfer.
##
## Bearer (D-9). The token enters the plugin only as the `authorization` member of one request's header, a
## buffer that lives for that call. It is never put in an event, a file, a log or the staged body, and this
## class keeps no copy once the call returns.
##
## The plugin takes a transfer id as 64 lower-case hex characters; the journal's ids (`saves:<id>`) are mapped
## to the SHA-256 of the id, here, for every call and every `keep` entry.

const SINGLETON := "PolarisKeyAndroid"
## The methods tried at create (every bulk method but sbClose).
const PROBED := ["sbOpen", "sbStage", "sbPut", "sbGet", "sbTake", "sbCancel", "sbEnd"]
const BAD_INPUT := 3
const OK := 1
## The most the plugin takes in one `sbStage` call.
const PIECE_MAX := 8 * 1048576
## The most it takes in a request body or an answer.
const BODY_MAX := 16 * 1048576
## Request headers the plugin accepts (and `x-pkey-*`); `authorization` is added here from the bearer.
const REQUEST_HEADERS := ["accept", "content-type", "content-digest", "range", "if-match"]

var _native: Object = null
var _events: Object = null
## A Callable returning `{product, origin, subject}` of the signed-in session, read at `open`.
var _context := Callable()
var _opened := false
var _origin := ""
## req -> {wait, transfer (hex), max_body}
var _pending := {}


## One request's wait: settled by the plugin's event or a cancel, whichever is first.
class _Wait:
	extends RefCounted
	signal settled
	var done := false
	var result := {}

	func settle(r: Dictionary) -> void:
		if done:
			return
		done = true
		result = r
		settled.emit()


## The channel over `native` (anything with the seven methods; tests pass a fake) and `events` (anything with a
## `bulk_event(ev: Dictionary)` signal: the `PKeyAndroid` facade), else over the Engine singleton and the shared
## facade. `context` is a Callable returning `{product, origin, subject}`. Null when the plugin or one of its
## methods is missing: there is no channel, and the transfer runs in the foreground as before.
static func create(context: Callable, native: Object = null, events: Object = null) -> PKeyAndroidBulk:
	var target: Object = native
	if target == null:
		if not Engine.has_singleton(SINGLETON):
			return null
		target = Engine.get_singleton(SINGLETON)
		if target == null:
			return null
	# A JNI singleton answers has_method() false for every plugin method (measured on an API 34 emulator,
	# Godot 4.7.2), so has_method is never asked: each method is tried with a bad input, which a present method
	# refuses with status 3 and an absent one answers with null. `sbClose` is left alone: it would close a live session.
	if not _probe(target):
		return null
	var source: Object = events if events != null else PKeyAndroid.shared()
	if source == null or not source.has_signal("bulk_event"):
		return null
	var out := PKeyAndroidBulk.new()
	out._native = target
	out._events = source
	out._context = context
	source.connect("bulk_event", out._on_event)
	return out


## True when every bulk method answers a bad input with the plugin's refusal (status 3). A call, not has_method.
static func _probe(target: Object) -> bool:
	var empty := PackedByteArray()
	for m in PROBED:
		var reply = target.call(m, empty, empty) if m == "sbStage" else target.call(m, empty)
		if _status(reply) != BAD_INPUT:
			return false
	return true


## The origin (`https://host[:port]`) and the path with its query of an absolute URL; `{}` when it has a
## userinfo, a fragment or no path. The plugin checks them again.
static func split_url(url: String) -> Dictionary:
	var sep := url.find("://")
	if sep < 1:
		return {}
	var rest := url.substr(sep + 3)
	var slash := rest.find("/")
	if slash < 1:
		return {}
	var authority := rest.substr(0, slash)
	var path := rest.substr(slash)
	if authority.contains("@") or path.contains("#"):
		return {}
	return {"origin": url.substr(0, sep + 3) + authority, "path": path}


## The plugin's transfer id for a journal id ("" is the unscoped tag the transport uses).
static func transfer_key(id: String) -> String:
	return (id if id != "" else "unscoped").sha256_text()


func available() -> bool:
	return _native != null


## Pin the origin and the owner at the plugin, and reconcile its spool with the journaled ids. `resume` is always
## empty: the plugin keeps no ledger (D-7), so the engine finds what to send again from the server's `received`
## list or a fresh plan.
func open(keep_ids: Array) -> Dictionary:
	var none := {"resume": [], "cancelled": 0, "swept": 0}
	if _native == null or not _context.is_valid():
		return none
	var ctx: Dictionary = _context.call()
	var subject := str(ctx.get("subject", ""))
	if subject == "":
		return none
	var keep: Array = []
	for id in keep_ids:
		keep.append(transfer_key(str(id)))
	var header := {"product": str(ctx.get("product", "")), "origin": str(ctx.get("origin", "")), "subject": subject, "keep": keep}
	var reply = _native.call("sbOpen", _json(header))
	if _status(reply) != OK:
		_opened = false
		return none
	_origin = str(ctx.get("origin", ""))
	_opened = true
	return none


func put(head: Dictionary, body: PackedByteArray) -> Dictionary:
	return await _request("PUT", head, body)


func fetch(head: Dictionary) -> Dictionary:
	return await _request("GET", head, PackedByteArray())


func cancel(what: Variant) -> void:
	if _native == null:
		return
	if what is int:
		var req: int = what
		if not _pending.has(req):
			return
		var p: Dictionary = _pending[req]
		_pending.erase(req)
		(p["wait"] as _Wait).settle({"fail": "network"})
		_native.call("sbCancel", _json({"transfer": p["transfer"], "req": req}))
		return
	var id: String = transfer_key(str(what))
	for req in _pending.keys():
		if _pending[req]["transfer"] == id:
			(_pending[req]["wait"] as _Wait).settle({"fail": "network"})
			_pending.erase(req)
	_native.call("sbCancel", _json({"transfer": id}))


func close() -> void:
	for req in _pending.keys():
		(_pending[req]["wait"] as _Wait).settle({"fail": "network"})
	_pending.clear()
	_opened = false
	if _native != null:
		_native.call("sbClose")


# ── a request ───────────────────────────────────────────────────────────────────────────────────

func _request(method: String, head: Dictionary, body: PackedByteArray) -> Dictionary:
	var fail := {"fail": "network"}
	var req := int(head.get("req", 0))
	var transfer := str(head.get("transfer", ""))
	var bearer := str(head.get("bearer", ""))
	var max_body := int(head.get("max_body", -1))
	var parts := split_url(str(head.get("url", "")))
	var headers: Variant = _request_headers(head.get("headers", {}))
	var refused := not _opened or req < 1 or req > 2147483647 or _pending.has(req) or transfer == "" or bearer == ""
	refused = refused or max_body < 0 or max_body > BODY_MAX or parts.is_empty() or body.size() > BODY_MAX
	if refused or parts["origin"] != _origin or headers == null:
		return fail
	var id := transfer_key(transfer)
	var wait := _Wait.new()
	_pending[req] = {"wait": wait, "transfer": id, "max_body": max_body}
	var q := {"transfer": id, "req": req, "path": parts["path"], "headers": headers, "max_body": max_body, "user_initiated": true}
	if method == "PUT":
		var file := await _stage(id, body)
		if file == "" or wait.done:
			# Failed, or cancelled while staging: nothing is queued.
			_pending.erase(req)
			return fail
		q["file"] = file
	# The token joins the header for this one call and is cleared with it (D-9).
	(q["headers"] as Dictionary)["authorization"] = "Bearer " + bearer
	var raw := _json(q)
	(q["headers"] as Dictionary).clear()
	var reply = _native.call("sbPut" if method == "PUT" else "sbGet", raw)
	raw.fill(0)
	if _status(reply) != OK:
		_pending.erase(req)
		return fail
	if not wait.done:
		await wait.settled
	_pending.erase(req)
	return wait.result


## The request headers the plugin accepts, lower-cased; null when one is not a string pair it takes. The bearer is
## never one of them.
func _request_headers(raw: Variant) -> Variant:
	var out := {}
	if not (raw is Dictionary):
		return null
	for k in (raw as Dictionary):
		var name := str(k).to_lower()
		var value: Variant = (raw as Dictionary)[k]
		if not (value is String) or name == "authorization" or not (REQUEST_HEADERS.has(name) or name.begins_with("x-pkey-")):
			return null
		out[name] = value
	return out


## Stage `body` into the plugin's spool in pieces of at most 8 MiB, a frame apart; the staged file's name, or "".
func _stage(id: String, body: PackedByteArray) -> String:
	var name := ""
	var at := 0
	var tree := Engine.get_main_loop() as SceneTree
	while true:
		var n := mini(PIECE_MAX, body.size() - at)
		var q := {"transfer": id}
		if name != "":
			q["file"] = name
		var reply = _native.call("sbStage", _json(q), body.slice(at, at + n))
		if _status(reply) != OK:
			return ""
		var info = JSON.parse_string(_body(reply).get_string_from_utf8())
		if not (info is Dictionary) or not (info.get("file") is String):
			return ""
		name = info["file"]
		at += n
		if at >= body.size():
			return name
		if tree != null:
			await tree.process_frame
	return name


# ── events ──────────────────────────────────────────────────────────────────────────────────────

## `sb_done {transfer, req, status, headers, body_len}` or `sb_fail {transfer, req, reason}` from the facade.
func _on_event(ev: Dictionary) -> void:
	var kind := str(ev.get("ev", ""))
	var req_v: Variant = ev.get("req")
	if (kind != "sb_done" and kind != "sb_fail") or not (req_v is int or req_v is float):
		return
	var req := int(req_v)
	var p: Variant = _pending.get(req)
	# A forged or a replayed event: no such request in flight, or it belongs to another transfer.
	if p == null or str(ev.get("transfer", "")) != p["transfer"] or (p["wait"] as _Wait).done:
		return
	(p["wait"] as _Wait).settle(_failed(ev) if kind == "sb_fail" else _answer(ev, req, int(p["max_body"])))


## The result of an `sb_fail` event.
static func _failed(ev: Dictionary) -> Dictionary:
	match str(ev.get("reason", "")):
		"oversize":
			return {"fail": "oversize"}
		"redirect":
			# Answered as it is: the transport refuses a 3xx, and the bearer never left the origin.
			return {"status": 302, "headers": {}, "body": PackedByteArray()}
	return {"fail": "network"}


## The result of an `sb_done` event: the status, the lower-cased headers and the body taken from the plugin.
func _answer(ev: Dictionary, req: int, max_body: int) -> Dictionary:
	var status_v: Variant = ev.get("status")
	var body_len := int(ev.get("body_len", 0))
	if not (status_v is int or status_v is float):
		return {"fail": "network"}
	if body_len < 0 or body_len > max_body:
		return {"fail": "oversize"}
	var body := PackedByteArray()
	if body_len > 0:
		var reply = _native.call("sbTake", _json({"req": req}))
		if _status(reply) != OK:
			return {"fail": "network"}
		body = _body(reply)
		if body.size() > max_body:
			return {"fail": "oversize"}
	var headers := {}
	var raw_headers: Variant = ev.get("headers", {})
	if raw_headers is Dictionary:
		for k in (raw_headers as Dictionary):
			headers[str(k).to_lower()] = str((raw_headers as Dictionary)[k])
	return {"status": int(status_v), "headers": headers, "body": body}


# ── replies ─────────────────────────────────────────────────────────────────────────────────────

static func _json(o: Dictionary) -> PackedByteArray:
	return JSON.stringify(o).to_utf8_buffer()


static func _status(reply: Variant) -> int:
	if not (reply is PackedByteArray) or (reply as PackedByteArray).is_empty():
		return -1
	return (reply as PackedByteArray)[0]


static func _body(reply: Variant) -> PackedByteArray:
	if _status(reply) != OK:
		return PackedByteArray()
	return (reply as PackedByteArray).slice(1)
