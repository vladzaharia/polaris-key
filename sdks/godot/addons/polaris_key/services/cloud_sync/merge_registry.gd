class_name PKeyMergeRegistry
extends RefCounted
## The open MergeRequests of one Cloud Sync client, from two sources (plans/U-08.md sections 2.2 to 2.4): the
## machine's record requests (`w:<collection>/<record>`, journalled by the machine) and the saves layer's
## (`w:saves/<id>`, memory only: S5). A port of client-core's `MergeRegistry` (sync/merge.ts).
##
## `deps`:
##   machine   Callable() -> the machine, or null while the host is not up
##   poke      Callable(): deliver the machine's events and let the pump run (after a keep)
##   event     Callable(event Dictionary): {type: "conflictOpened", request} / {type: "conflictClosed", id, how}
##   audience  Callable() -> bool: whether anything but `on_conflict` listeners hears `conflictOpened`
##             (a connected signal); none: the dev notice fires once per process
##
## A listener (`on_conflict`) may return a choice ("local", "remote", "both" or {"value": v}) to decide a
## request inline; a coroutine's value is not read.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const Request := preload("res://addons/polaris_key/services/cloud_sync/merge_request.gd")


## The dev notice fires once per process.
static var _noticed := false

var _d: Dictionary
var _machine_reqs := {}
var _extra := {}
var _listeners: Array = []
var _pending := {}


func _init(deps: Dictionary = {}) -> void:
	_d = deps


func _machine() -> Variant:
	var f: Variant = _d.get("machine")
	return (f as Callable).call() if f is Callable and (f as Callable).is_valid() else null


# ── What the host calls ──────────────────────────────────────────────────────────────────────────


## The open requests in id order.
func conflicts() -> Array:
	_refresh()
	return _all()


func count() -> int:
	return conflicts().size()


## Listen for requests as they open; the ones already open are replayed. Returns the remover.
func on_conflict(fn: Callable) -> Callable:
	_listeners.append(fn)
	_refresh()
	for r: Request in _all():
		if r.state == "open":
			_offer(fn, r)
	return func() -> void: _listeners.erase(fn)


func has_listeners() -> bool:
	return not _listeners.is_empty()


## The machine's events, after `take_events`: opens, closes and settled keeps.
func feed(events: Array) -> void:
	for e: Dictionary in events:
		if e.get("type") == "conflict":
			_machine_opened(String(e["id"]))
		elif e.get("type") == "conflictClosed":
			_machine_closed(String(e["id"]), String(e["how"]))
	_settle_from_state()


# ── The saves layer ──────────────────────────────────────────────────────────────────────────────


func find(id: String) -> Variant:
	return _extra.get(id)


## Open a request, or reopen the one with that id (its sides and choices replaced). A listener may decide it
## inline. `backend` is Callable(choice) -> Dictionary (a coroutine) answering the keep.
func open(view: Dictionary, backend: Callable) -> Request:
	var have: Variant = _extra.get(view["id"])
	var r: Request = have if have != null else Request.new(view, self, backend)
	r._view = view
	_extra[view["id"]] = r
	_announce(r)
	return r


## Replace what an open request shows (a later write replaced the local copy; the state moved).
func update(id: String, view: Dictionary) -> void:
	var r: Variant = _extra.get(id)
	if r != null:
		r._view.merge(view, true)


## Tell the listeners again that a saves request is open (a keep conflicted again).
func reannounce(id: String) -> void:
	var r: Variant = _extra.get(id)
	if r != null:
		_announce(r)


## Close a saves request. No-op when it is not open.
func close(id: String, how: String) -> void:
	var r: Variant = _extra.get(id)
	if r == null:
		return
	_extra.erase(id)
	r._closed = true
	_emit({"type": PKeyConstants.MergeEvent.CONFLICTCLOSED, "id": id, "how": how})


## Drop every saves request without an event (the person's data is gone).
func clear_extra() -> void:
	for r: Request in _extra.values():
		r._closed = true
	_extra.clear()


# ── keep ─────────────────────────────────────────────────────────────────────────────────────────


static func choice_name(choice: Variant) -> String:
	if choice is Dictionary:
		return "value" if choice.has("value") else ""
	return String(choice) if Types.is_string(choice) else ""


static func _outcome_closed() -> Dictionary:
	return {"ok": false, "code": PKeyConstants.ErrorCode.SYNC_MERGE_CLOSED, "reopened": false}


static func _outcome_bad() -> Dictionary:
	return {"ok": false, "code": PKeyConstants.ErrorCode.BAD_REQUEST, "reopened": false}


## @internal: `PKeyMergeRequest.keep`.
func keep_request(r: Request, choice: Variant) -> Dictionary:
	_refresh()
	if r._closed:
		return _outcome_closed()
	if r._view["state"] == "applying":
		return _outcome_bad()
	var name := choice_name(choice)
	if not (r._view["choices"] as Array).has(name):
		return _outcome_bad()
	if r._backend.is_valid():
		return await r._backend.call(choice)
	return await _keep_machine(r, choice, name)


func _keep_machine(r: Request, choice: Variant, name: String) -> Dictionary:
	var m: Variant = _machine()
	if m == null:
		return _outcome_closed()
	var remote: Variant = r._view["remote"]
	var remote_version: Variant = remote["version"] if remote is Dictionary else null
	var res: Dictionary = m.keep(r.id, choice)
	if not res["ok"]:
		return {"ok": false, "code": String(res["error"]), "reopened": false}
	# `remote` is settled by the machine at once; the closing event arrives with the next batch.
	if name == "remote":
		r._closed = true
		_machine_reqs.erase(r.id)
		_poke()
		return {"ok": true, "kept": "remote", "version": remote_version}
	_refresh()
	var p := _Pending.new()
	_pending[r.id] = p
	_poke()
	if p.outcome == null:
		await p.settled
	return p.outcome


func _poke() -> void:
	var f: Variant = _d.get("poke")
	if f is Callable and (f as Callable).is_valid():
		(f as Callable).call()


# ── machine requests ─────────────────────────────────────────────────────────────────────────────


static func _machine_view(c: Dictionary) -> Dictionary:
	return {
		"id": c["id"], "cause": c["cause"], "collection": c["collection"], "record": c["record"],
		"local": _side(c["local"]), "remote": _side(c["remote"]),
		"choices": (c["choices"] as Array).duplicate(), "state": c["state"], "error": c["error"],
	}


static func _side(s: Variant) -> Variant:
	if not (s is Dictionary):
		return null
	return {"value": Types.clone(s["value"]), "version": s["version"], "saved_at": s["savedAt"], "device": s["device"], "file": Types.clone(s["file"])}


## Bring the machine's requests in line with its state (a request that vanished is closed).
func _refresh() -> void:
	var m: Variant = _machine()
	if m == null:
		for r: Request in _machine_reqs.values():
			r._closed = true
		_machine_reqs.clear()
		return
	var live := {}
	for c: Dictionary in m.conflicts():
		live[c["id"]] = c
	for id: String in _machine_reqs.keys():
		var r: Request = _machine_reqs[id]
		if live.has(id):
			r._view = _machine_view(live[id])
		else:
			r._closed = true
			_machine_reqs.erase(id)
	for id: String in live:
		if not _machine_reqs.has(id):
			_machine_reqs[id] = Request.new(_machine_view(live[id]), self)


func _all() -> Array:
	var out: Array = _machine_reqs.values() + _extra.values()
	out.sort_custom(func(a: Request, b: Request) -> bool: return a.id < b.id)
	return out


func _machine_opened(id: String) -> void:
	var m: Variant = _machine()
	if m == null:
		return
	var found: Variant = null
	for c: Dictionary in m.conflicts():
		if c["id"] == id:
			found = c
	if found == null:
		return
	var r: Variant = _machine_reqs.get(id)
	if r != null:
		r._view = _machine_view(found)
	else:
		r = Request.new(_machine_view(found), self)
		_machine_reqs[id] = r
	# A keep of this request conflicted again: it reopens for the person.
	var p: Variant = _pending.get(id)
	if p != null:
		_pending.erase(id)
		p.resolve({"ok": false, "code": "conflict", "reopened": true})
	_announce(r)


func _machine_closed(id: String, how: String) -> void:
	var r: Variant = _machine_reqs.get(id)
	if r != null:
		r._closed = true
		_machine_reqs.erase(id)
	var p: Variant = _pending.get(id)
	if p != null:
		_pending.erase(id)
		if how == "superseded":
			p.resolve(_outcome_closed())
		else:
			p.resolve({"ok": true, "kept": how, "version": _version_of(r._view["collection"], r._view["record"]) if r != null else null})
	_emit({"type": PKeyConstants.MergeEvent.CONFLICTCLOSED, "id": id, "how": how})


func _version_of(collection: String, record: String) -> Variant:
	var m: Variant = _machine()
	if m == null:
		return null
	for row: Dictionary in m.records(collection):
		if row["id"] == record:
			return row["version"]
	return null


## A keep whose set was refused for good reopens the request with the failure code.
func _settle_from_state() -> void:
	if _pending.is_empty():
		return
	_refresh()
	for id: String in _pending.keys():
		var p: _Pending = _pending[id]
		var r: Variant = _machine_reqs.get(id)
		if r == null:
			_pending.erase(id)
			p.resolve(_outcome_closed())
		elif r._view["state"] == "open":
			_pending.erase(id)
			var err: Variant = r._view["error"]
			p.resolve({"ok": false, "code": String(err) if err != null else "conflict", "reopened": true})


# ── announcing ───────────────────────────────────────────────────────────────────────────────────


func _announce(r: Request) -> void:
	_emit({"type": PKeyConstants.MergeEvent.CONFLICTOPENED, "request": r})
	var audience: Variant = _d.get("audience")
	var heard: bool = (audience as Callable).call() if audience is Callable and (audience as Callable).is_valid() else false
	if _listeners.is_empty():
		if not heard and not _noticed:
			_noticed = true
			push_warning(
					"Cloud Sync: a conflict (%s) is waiting for an answer and nothing listens. " % r.id
					+ "Connect PolarisKey.cloud_sync.conflict_opened or call cloud_sync.on_conflict(), then request.keep(...)."
			)
		return
	for fn: Callable in _listeners.duplicate():
		if r._view["state"] != "open" or r._closed:
			break
		_offer(fn, r)


## Hand a request to a listener; a returned choice decides it at once.
func _offer(fn: Callable, r: Request) -> void:
	if not fn.is_valid():
		return
	var answer: Variant = fn.call(r)
	if answer is Dictionary or answer is String:
		keep_request(r, answer)


func _emit(e: Dictionary) -> void:
	var f: Variant = _d.get("event")
	if f is Callable and (f as Callable).is_valid():
		(f as Callable).call(e)


class _Pending:
	extends RefCounted
	signal settled
	var outcome: Variant = null

	func resolve(o: Dictionary) -> void:
		if outcome == null:
			outcome = o
			settled.emit()
