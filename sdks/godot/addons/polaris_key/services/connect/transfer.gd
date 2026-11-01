@tool
class_name PKeyCloudTransfer
extends RefCounted
## Direct Transfer as the host sees it (CC-20b.G3; WIRE-CONTRACT-V5 section 15.11):
## `PolarisKey.cloud_connect.transfer`. Ported from sdk-node `connect/transfer.ts` and the Python
## `connect/transfer.py`; the machine is `PKeyPeerXfer`, the endpoint `PKeyPeerXferEndpoint` and the kept
## partial files are `PKeyTransferStore`.
##
##   send(peer, source, options)   offer content to a peer. `peer` is an open PKeyConnectSession, a device id
##                       (a session is opened, LAN first) or {link = id}. `source` is a path (absolute,
##                       `user://` or `res://`) or a PackedByteArray; a stream is written to a file first.
##                       `options`: `name` (display data only), `type`, `category`, `chunk`, `id`, and `on_start`
##                       (Callable(handle) run before the content is hashed, for a progress UI). ok with a
##                       PKeyTransferHandle, or a typed failure. The whole content is hashed off the main
##                       thread before the OFFER goes out. A coroutine
##   on_offer(handler)   every OFFER from a peer is put to the handler, one transfer at a time, as a
##                       PKeyTransferOffer to `accept(path)` or `decline()` at once or later. No handler, no
##                       answer within 120 s, no state directory or an unusable path declines. Setting a
##                       handler also keeps the inbound sessions that list `xfer/1` open when nobody
##                       listens to `channel`. Answers the Callable that unsets it
##   result(r)           signal: each transfer's end in either direction, {id, direction, outcome, reason?,
##                       path?, delivered}; `outcome` is `delivered`, `cancelled` or `closed` (the session
##                       ended; an incoming partial is kept to resume)
##   cancel(id)          cancel the transfer with this id, in either direction
##
## Rules this file keeps:
##  - the peer's `name` never reaches a path: a partial is named by its derived ref, and the delivered file
##    is the host's own path, written beside it and renamed, never over anything unless `overwrite` is set;
##  - a transfer is declined, not accepted, when there is no handler, no state directory or no usable
##    destination (checked before the person's answer is taken); in mode c the category is checked
##    before the person is asked;
##  - a partial is kept when a session ends and offered again when the same peer sends the same transfer (the
##    verified prefix is hashed again first, off the main thread); sign-out and removing a link delete
##    partials; a device that left the roster loses its partials;
##  - content already delivered to a peer and offered again (it never saw the last record) is answered as
##    done without a new consent: the memory is ids and hashes, in this process, for 24 hours;
##  - nothing here puts a key, a path or a name in a `str()`.

## A transfer's end, in either direction.
signal result(r: Dictionary)

const DEFAULT_CHUNK := PKeyPeerXfer.DEFAULT_CHUNK
const MAX_PENDING_META := 64
const BLOCK := 1048576

static var _type_re: RegEx
static var _cat_re: RegEx

var _store_dir: Callable
var _quota := -1
var _open_peer: Callable
var _open_link: Callable
var _links: Callable
var _offload: Callable
var _now: Callable
var _timer: Callable
var _budget_usec := PKeyPeerXferEndpoint.BUDGET_USEC
var _web: bool
var _handler: Callable
var _token := 0
var _wires: Dictionary = {}
var _store: PKeyTransferStore = null
var _store_path := ""
var _delivered := PKeyPeerXferDelivered.new()
var _sweep_cancel := Callable()
var _running := false


static func _static_init() -> void:
	_type_re = PKeyClaims.whole("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*")
	_cat_re = PKeyClaims.whole("[a-z0-9-]{1,32}")


## `opts` (all optional): `store_dir` (Callable() -> String, the partial files' directory; "" or none: no
## state directory, so incoming offers are declined), `quota` (bytes), `open_peer` (Callable(device_id),
## a coroutine answering a PKeyResult with a session), `open_link` (the same for a link id), `links`
## (Callable() -> the link ids held), `offload` (PKeyPeerPump.offload), `now` (Callable() -> epoch seconds),
## `timer` (Callable(seconds, fn) -> a Callable that cancels), `budget_usec` and `web`.
func _init(opts := {}) -> void:
	_store_dir = opts.get("store_dir", Callable())
	_quota = int(opts.get("quota", -1))
	_open_peer = opts.get("open_peer", Callable())
	_open_link = opts.get("open_link", Callable())
	_links = opts.get("links", Callable())
	_offload = opts.get("offload", Callable())
	_now = opts.get("now", Callable())
	_timer = opts.get("timer", Callable())
	_budget_usec = int(opts.get("budget_usec", PKeyPeerXferEndpoint.BUDGET_USEC))
	_web = bool(opts.get("web", OS.has_feature("web")))


func _to_string() -> String:
	return "PKeyCloudTransfer(sessions=%d)" % _wires.size()


# -- the host's API -----------------------------------------------------------------------------------


## Set (or, with an invalid Callable, clear) the one handler for incoming offers. Answers the unset.
func on_offer(handler: Callable) -> Callable:
	_handler = handler
	_token += 1
	var mine := _token
	return func() -> void:
		if _token == mine:
			_handler = Callable()


## The partial files' quota in bytes; applies to the next store made (none while sessions are open).
func set_quota(bytes: int) -> void:
	_quota = bytes
	if _wires.is_empty():
		_store = null
		_store_path = ""


## True while an offer handler is set: inbound sessions that list `xfer/1` are kept open.
func listening() -> bool:
	return _handler.is_valid()


## True when this inbound session has a transfer port (and so is worth keeping with a handler set).
func wants(session: PKeyConnectSession) -> bool:
	return listening() and _wires.has(session.get_instance_id())


## Cancel the transfer with this id, in either direction (nothing for an id that is not live).
func cancel(id: String) -> void:
	for w: Wire in _wires.values():
		if w.endpoint != null:
			w.endpoint.cancel(id)


## Offer `source` to `peer`. A coroutine; see the file header.
func send(peer: Variant, source: Variant, options := {}) -> PKeyResult:
	var prep := _prepare(source, options)
	if not prep.ok:
		return prep
	var src: Source = prep.detail["src"]
	var opened := await _session_of(peer)
	if not opened.ok:
		src.close()
		return opened
	var begun := _begin(opened.detail, src, options)
	if not begun.ok:
		src.close()
		return begun
	var wire: Wire = begun.detail["wire"]
	var handle: PKeyTransferHandle = begun.detail["handle"]
	var id := handle.id
	var on_start: Variant = options.get("on_start")
	if on_start is Callable and (on_start as Callable).is_valid():
		(on_start as Callable).call(handle)
	var sha: String = await _worker(func() -> String: return src.hash_all())
	var session: PKeyConnectSession = opened.detail
	if sha == "" or session.is_closed() or wire.endpoint == null or wire.endpoint.is_dead():
		wire.out.erase(id)
		wire.sources.erase(id)
		src.close()
		if sha == "":
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "The source cannot be read.", {"reason": "source"})
		return PKeyConnectErrors.lan("closed", "The session is closed.")
	var args := {"id": id, "size": src.size, "chunk": begun.detail["chunk"], "sha256": sha}
	if options.has("category"):
		args["cat"] = options["category"]
	if prep.detail["shown"] != null:
		args["name"] = prep.detail["shown"]
	if options.has("type"):
		args["type"] = options["type"]
	wire.endpoint.offer(args)
	return PKeyResult.success(handle)


## The arguments of a send that need no session: ok with {src, shown}, the source and the name offered.
func _prepare(source: Variant, options: Dictionary) -> PKeyResult:
	var bad := _check_options(options)
	if bad != null:
		return bad
	var src := Source.open(source)
	if src == null:
		return _invalid("The source is not a readable path or a PackedByteArray.")
	var shown: Variant = options.get("name", src.file_name if src.file_name != "" else null)
	if shown != null and (shown as String).to_utf8_buffer().size() > 255:
		return _invalid("The name is longer than 255 bytes.")
	if src.size > PKeyPeerXfer.MAX_SIZE:
		return _invalid("The content is larger than 2^40 bytes.")
	return PKeyResult.success({"src": src, "shown": shown})


## Registers the transfer on the session's wire: ok with {wire, handle, chunk}.
func _begin(session: PKeyConnectSession, src: Source, options: Dictionary) -> PKeyResult:
	var wire: Wire = _wires.get(session.get_instance_id())
	if wire == null or wire.endpoint == null or wire.endpoint.is_dead():
		return PKeyResult.failure(PKeyConstants.ErrorCode.PEER_NOT_ALLOWED, "The peer did not offer Direct Transfer (xfer/1) on this session.", {"reason": "not_allowed"})
	var peer_max := int(session.hello.get("max_message", PKeyPeerPayload.DEFAULT_MAX_MESSAGE))
	var chunk := mini(mini(int(options.get("chunk", DEFAULT_CHUNK)), PKeyPeerXfer.MAX_CHUNK), peer_max - PKeyPeerXfer.CHUNK_HEAD)
	if chunk < 1:
		return _invalid("The chunk size is too small.")
	var id: String = String(options["id"]) if options.has("id") else PKeyB64Url.encode(Crypto.new().generate_random_bytes(16))
	if not PKeyPeerXfer.is_xfer_id(id) or wire.out.has(id):
		return _invalid("The id is not usable.")
	var handle := PKeyTransferHandle.new(id, Callable(self, "cancel"))
	wire.out[id] = handle
	wire.sources[id] = src
	return PKeyResult.success({"wire": wire, "handle": handle, "chunk": chunk})


## Delete every kept partial and forget what was delivered (sign-out, deactivation). Ends the transfers
## in flight and closes their sessions. Fails when a file could not be deleted.
func purge() -> PKeyResult:
	for w: Wire in _wires.values():
		if w.endpoint != null:
			w.endpoint.closed()
		w.session.close()
	_delivered.clear()
	var store := _get_store()
	if store == null:
		return PKeyResult.success()
	return store.purge()


## Delete the kept partials of one peer key (a removed link, a device that left the roster).
func forget_peer(peer_key: PackedByteArray) -> void:
	_delivered.forget(peer_key)
	var store := _get_store()
	if store != null:
		store.purge(peer_key)


## Cloud Connect started: the hourly sweep of old partials begins.
func begin() -> void:
	_running = true
	_arm_sweep()


## Cloud Connect stopped.
func end() -> void:
	_running = false
	var c := _sweep_cancel
	_sweep_cancel = Callable()
	if c.is_valid():
		c.call()
	if _store != null:
		_store.close()


func _arm_sweep() -> void:
	if not _running:
		return
	var tm := _timer
	if not tm.is_valid():
		tm = Callable(self, "_scene_timer")
	var cancel: Variant = tm.call(PKeyTransferStore.SWEEP_EVERY, Callable(self, "_sweep"))
	_sweep_cancel = cancel if cancel is Callable else Callable()


func _sweep() -> void:
	_sweep_cancel = Callable()
	var store := _get_store()
	if store != null:
		store.sweep()
	_arm_sweep()


func _scene_timer(seconds: float, fn: Callable) -> Callable:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return Callable()
	var live := [true]
	tree.create_timer(seconds).timeout.connect(func() -> void:
		if live[0]:
			fn.call())
	return func() -> void: live[0] = false


# -- the sessions --------------------------------------------------------------------------------------


## Called as a session is made, before any record can follow the HELLO (the `xfer` hook of the LAN and relay
## services): when both sides listed `xfer/1`, take the session's transfer port.
func attach(session: PKeyConnectSession) -> void:
	if not session.caps.has(PKeyPeerXfer.CAP) or session.peer_static.size() != 32:
		return
	var wire := Wire.new()
	wire.session = session
	wire.peer_key = session.peer_static.duplicate()
	var write := session.attach_xfer(Callable(wire, "on_record"))
	if not write.is_valid():
		return
	wire.hub = self
	wire.store = _get_store()
	var store := wire.store
	var partials: Array = []
	if store != null:
		partials = store.partials(wire.peer_key)
		wire.epoch = store.epoch(wire.peer_key)
	var eo := {
		"send": write,
		"close": func(code: StringName) -> void: session.close(code),
		"read": func(id: String, offset: int, length: int) -> Variant: return _read(wire, id, offset, length),
		"apply": func(effect: Dictionary) -> Variant: return _apply(wire, effect),
		"events": {
			"ask": func(a: Dictionary) -> void: _on_ask(wire, a),
			"withdraw": func(id: String) -> void: _on_withdraw(wire, id),
			"result": func(r: Dictionary) -> void: _on_result(wire, r),
			"refused": func(id: String, why: String) -> void: _on_refused(wire, id, why),
			"error": func(_why: String) -> void: _on_error(wire),
			"finished": func() -> void: _on_finished(wire),
		},
		"offload": _offload,
		"now": _now,
		"budget_usec": _budget_usec,
	}
	if _timer.is_valid():
		eo["timer"] = _timer
	wire.endpoint = PKeyPeerXferEndpoint.new(eo)
	var categories: Array = []
	if session.contact is Dictionary:
		categories = (session.contact as Dictionary).get("categories", [])
	var machine := PKeyPeerXfer.Machine.new({
		"mode": "c" if session.contact != null else "a",
		"caps": session.caps,
		"max_message": PKeyPeerPayload.DEFAULT_MAX_MESSAGE,
		"peer_key": wire.peer_key,
		"handler": func(_ask: Dictionary) -> String: return "ask" if wire.receiving and _handler.is_valid() else "decline",
		"categories": categories,
		"free": func() -> int: return store.free_bytes() if store != null else -1,
		"partials": partials,
		"rehash": func(ref: String, offset: int) -> Variant: return store.rehash(ref, offset, wire) if store != null else null,
		"delivered": _delivered.for_peer(wire.peer_key),
	})
	wire.receiving = store != null
	_wires[session.get_instance_id()] = wire
	wire.endpoint.bind(machine)
	session.closed.connect(_on_session_closed.bind(wire))


func _on_session_closed(_code: StringName, _by_peer: bool, wire: Wire) -> void:
	if wire.endpoint != null:
		wire.endpoint.closed()


## The endpoint is over: let go of the session's holds and sources.
func _on_finished(wire: Wire) -> void:
	_wires.erase(wire.session.get_instance_id())
	if wire.store != null:
		wire.store.release_owner(wire)
	for s: Source in wire.sources.values():
		s.close()
	wire.sources.clear()
	for h: PKeyTransferHandle in wire.out.values():
		h._finish({"id": h.id, "direction": "out", "outcome": "closed", "delivered": false})
	wire.out.clear()
	wire.pending.clear()
	wire.dests.clear()
	wire.meta.clear()
	wire.endpoint = null


func _session_of(peer: Variant) -> PKeyResult:
	if peer is PKeyConnectSession:
		return PKeyResult.success(peer)
	if peer is String:
		if not _open_peer.is_valid():
			return PKeyConnectErrors.lan("not_started", "Cloud Connect is not started.")
		var r: PKeyResult = await _open_peer.call(peer)
		return r
	if peer is Dictionary and (peer as Dictionary).get("link") is String:
		var link_id: String = peer["link"]
		if not _links.is_valid() or not (_links.call() as Array).has(link_id) or not _open_link.is_valid():
			return PKeyResult.failure(PKeyConstants.ErrorCode.LINK_UNKNOWN, "That link is not held on this device.")
		var r2: PKeyResult = await _open_link.call(link_id)
		return r2
	return _invalid("The peer is a session, a device id or {link = id}.")


# -- the store and the sender's source -------------------------------------------------------------------


## The partial-file store, made on first use; null when there is no state directory.
func _get_store() -> PKeyTransferStore:
	var dir := String(_store_dir.call()) if _store_dir.is_valid() else ""
	if dir == "":
		return null
	if _store == null or _store_path != dir:
		var o := {}
		if _quota >= 0:
			o["quota"] = _quota
		if _now.is_valid():
			o["clock"] = _now
		_store = PKeyTransferStore.new(dir, o)
		_store_path = dir
	return _store


func _read(wire: Wire, id: String, offset: int, length: int) -> Variant:
	var s: Source = wire.sources.get(id)
	return s.read(offset, length) if s != null else null


func _worker(work: Callable) -> Variant:
	if _offload.is_valid():
		return await _offload.call(work)
	return work.call()


# -- the receiver --------------------------------------------------------------------------------------


## The machine asked (on the main thread): the host's handler, which answers now or later.
func _on_ask(wire: Wire, ask: Dictionary) -> void:
	var id: String = ask["id"]
	var s := wire.session
	var offer := PKeyTransferOffer.new(id, int(ask["size"]), func(o: PKeyTransferOffer, to: String, overwrite: bool) -> void: _answer(wire, o, to, overwrite))
	offer.name = String(ask.get("name", ""))
	offer.type = String(ask.get("type", ""))
	offer.category = String(ask.get("cat", ""))
	offer.from = {"kind": "device", "id": s.peer_device_id, "label": String(s.hello.get("label", ""))}
	if s.contact is Dictionary:
		offer.from = {"kind": "link", "id": String((s.contact as Dictionary).get("id", "")), "label": String((s.contact as Dictionary).get("label", ""))}
	wire.pending[id] = offer
	if not _handler.is_valid():
		offer.decline()
		return
	_handler.call(offer)


func _answer(wire: Wire, offer: PKeyTransferOffer, to: String, overwrite: bool) -> void:
	if wire.pending.get(offer.id) != offer:
		return  # answered, withdrawn or ended already
	wire.pending.erase(offer.id)
	var ok := to != "" and wire.store != null and wire.store.destination_ok(to, overwrite)
	if ok:
		var m: Dictionary = wire.meta.get(offer.id, {})
		if m.is_empty():
			ok = false
		else:
			offer.path = to
			wire.dests[offer.id] = {
				"dest": to, "overwrite": overwrite,
				"ref": PKeyPeerXfer.partial_path(wire.peer_key, offer.id, String(m["sha256"])),
			}
	if wire.endpoint != null:
		wire.endpoint.consent(offer.id, "accept" if ok else "decline")


func _on_withdraw(wire: Wire, id: String) -> void:
	var o: PKeyTransferOffer = wire.pending.get(id)
	wire.pending.erase(id)
	wire.dests.erase(id)
	wire.meta.erase(id)
	if o != null:
		o.withdrawn = true


func _on_refused(wire: Wire, id: String, why: String) -> void:
	# Too many live transfers on this session (or a bad argument): the handle ends, nothing was sent.
	_on_result(wire, {"id": id, "outcome": "cancelled", "reason": "busy" if why == "busy" else "cancelled"})


## A store or session port failed: the transfer being delivered, if any, ends `closed`.
func _on_error(wire: Wire) -> void:
	if wire.finalizing != "":
		var id := wire.finalizing
		wire.finalizing = ""
		wire.delivered_to.erase(id)
		_on_result(wire, {"id": id, "outcome": "closed"})


## Performs one effect: the store applies it. A `finalize` is a job for a worker thread, resolved here (on the main
## thread) to plain values first.
func _apply(wire: Wire, eff: Dictionary) -> Variant:
	var store := wire.store
	if store == null:
		return PKeyResult.failure(PKeyConstants.ErrorCode.STORE_FAILED, "There is no state directory.", {"reason": "no_store"})
	if eff.has("finalize"):
		var ref: String = eff["finalize"]
		var d := wire.dest_for(ref)
		if d.is_empty():
			return PKeyResult.failure(PKeyConstants.ErrorCode.STORE_FAILED, "There is no destination.", {"reason": "destination"})
		wire.finalizing = d["id"]
		wire.delivered_to[d["id"]] = d["dest"]
		return func() -> PKeyResult: return store.deliver(ref, d["dest"], d["overwrite"], wire)
	var meta: Dictionary = eff.get("meta", {})
	return store.apply(wire.peer_key, eff, meta, wire, wire.epoch)


## The machine's result (on the main thread): the handle and the `result` signal.
func _on_result(wire: Wire, r: Dictionary) -> void:
	var id: String = r["id"]
	var handle: PKeyTransferHandle = wire.out.get(id)
	var src: Source = wire.sources.get(id)
	wire.out.erase(id)
	wire.sources.erase(id)
	wire.pending.erase(id)
	wire.meta.erase(id)
	var dest: String = String(wire.delivered_to.get(id, ""))
	wire.delivered_to.erase(id)
	var dest_info: Variant = wire.dests.get(id)
	wire.dests.erase(id)
	if wire.finalizing == id:
		wire.finalizing = ""
	if src != null:
		src.close()
	var out_r := r.duplicate()
	# A re-offer answered from the memory: the host is told nothing and no content moved.
	if r["outcome"] == "delivered" and r.get("again", false) == true:
		return
	if r["outcome"] == "delivered" and handle == null and dest == "" and dest_info is Dictionary and wire.store != null:
		# A transfer of zero bytes keeps no partial: the empty file is placed here.
		var placed := wire.store.deliver("", (dest_info as Dictionary)["dest"], (dest_info as Dictionary)["overwrite"], wire)
		if placed.ok:
			dest = (dest_info as Dictionary)["dest"]
		else:
			out_r = {"id": id, "outcome": "closed"}
	var res := {"id": id, "direction": "out" if handle != null else "in", "outcome": out_r["outcome"], "delivered": out_r["outcome"] == "delivered"}
	if out_r.has("reason"):
		res["reason"] = out_r["reason"]
	if out_r["outcome"] == "delivered" and dest != "":
		res["path"] = dest
	result.emit(res)
	if handle != null:
		handle._finish(res)


static func _invalid(message: String) -> PKeyResult:
	return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_ARGUMENT, message)


static func _check_options(o: Dictionary) -> PKeyResult:
	if o.has("type") and (not o["type"] is String or (o["type"] as String).length() > 127 or not PKeyClaims.matches_whole_re(_type_re, o["type"])):
		return _invalid("The type is not a media type.")
	if o.has("category") and not PKeyClaims.matches_whole_re(_cat_re, o["category"]):
		return _invalid("The category is not a data category.")
	if o.has("chunk") and (not o["chunk"] is int or int(o["chunk"]) < 1):
		return _invalid("The chunk size is not a positive integer.")
	if o.has("name") and not o["name"] is String:
		return _invalid("The name is not a string.")
	if o.has("id") and not PKeyPeerXfer.is_xfer_id(o["id"]):
		return _invalid("The id is not usable.")
	return null


## The state of Direct Transfer on one session. Everything here is touched on the main thread, except that a
## worker reads `receiving` through the machine's handler.
class Wire extends RefCounted:
	var hub: PKeyCloudTransfer
	var session: PKeyConnectSession
	var peer_key := PackedByteArray()
	var store: PKeyTransferStore
	var endpoint: PKeyPeerXferEndpoint
	var epoch := 0
	var receiving := false
	## id -> PKeyTransferHandle, id -> Source (the sender's side)
	var out := {}
	var sources := {}
	## id -> PKeyTransferOffer waiting for the host's answer
	var pending := {}
	## id -> {dest, overwrite, ref}
	var dests := {}
	## id -> {sha256, size, chunk} of an OFFER seen on the wire (bounded)
	var meta := {}
	var delivered_to := {}
	var finalizing := ""


	func _to_string() -> String:
		return "PKeyCloudTransfer.Wire()"


	## The session's record port: an OFFER's members are remembered for the partial's name, then the endpoint
	## takes the record.
	func on_record(type: int, body: PackedByteArray) -> void:
		if type == PKeyPeerXfer.OFFER:
			var o := PKeyPeerXfer.parse_offer(body, PKeyPeerPayload.DEFAULT_MAX_MESSAGE)
			if o["ok"]:
				var f: Dictionary = o["offer"]
				meta[f["id"]] = {"sha256": f["sha256"], "size": f["size"], "chunk": f["chunk"]}
				while meta.size() > PKeyCloudTransfer.MAX_PENDING_META:
					meta.erase(meta.keys()[0])
		if endpoint != null:
			endpoint.receive(type, body)


	## {id, dest, overwrite} of the accepted transfer whose partial is `ref`, or {}.
	func dest_for(ref: String) -> Dictionary:
		for id: String in dests:
			if dests[id]["ref"] == ref:
				return {"id": id, "dest": dests[id]["dest"], "overwrite": dests[id]["overwrite"]}
		return {}


## The sender's content: a path or bytes, read by offset. The hash is taken once, off the main thread.
class Source extends RefCounted:
	var size := 0
	var file_name := ""
	var _bytes := PackedByteArray()
	var _path := ""
	var _file: FileAccess = null


	## A Source for a path (absolute, `user://` or `res://`) or a PackedByteArray; null when it cannot be read.
	static func open(src: Variant) -> Source:
		var s := Source.new()
		if src is PackedByteArray:
			s._bytes = src
			s.size = (src as PackedByteArray).size()
			return s
		if src is String and ((src as String).is_absolute_path() or (src as String).begins_with("user://") or (src as String).begins_with("res://")):
			var f := FileAccess.open(src, FileAccess.READ)
			if f == null:
				return null
			s._path = src
			s._file = f
			s.size = f.get_length()
			s.file_name = (src as String).get_file()
			return s
		return null


	func _to_string() -> String:
		return "PKeyCloudTransfer.Source()"


	## `length` bytes at `offset`, or null when the source is short or unreadable.
	func read(offset: int, length: int) -> Variant:
		if _path == "":
			if offset < 0 or offset + length > _bytes.size():
				return null
			return _bytes.slice(offset, offset + length)
		if _file == null:
			return null
		_file.seek(offset)
		var b := _file.get_buffer(length)
		return b if b.size() == length else null


	## The hex SHA-256 of the whole content, or "" when it cannot be read. Safe on a worker thread: a path
	## is opened again, not shared with `read`.
	func hash_all() -> String:
		var h := HashingContext.new()
		h.start(HashingContext.HASH_SHA256)
		if _path == "":
			h.update(_bytes)
			return h.finish().hex_encode()
		var f := FileAccess.open(_path, FileAccess.READ)
		if f == null:
			return ""
		var left := size
		while left > 0:
			var b := f.get_buffer(mini(PKeyCloudTransfer.BLOCK, left))
			if b.is_empty():
				return ""
			h.update(b)
			left -= b.size()
		return h.finish().hex_encode()


	func close() -> void:
		_file = null
