extends RefCounted
## The record layer under the saves (U-22.5, U-23): the port `saves.gd` writes metadata and lists through,
## bound to the Cloud Sync host's machine. A port of client-core's `SaveRecords` (Node `MachineRecords`).
##
##   wire_id(id)               the id a record travels under: blinded in end-to-end mode (§13.10.2), else `id`
##   list()                    [{id, version, value: Dictionary, file: Dictionary | null}] by id
##   get_record(id)            one record or null
##   set_record(id, value, base_version, cancel?)    {ok: true, version} | {ok: false, reason: "conflict",
##                             server: record | null} | {ok: false, reason: "rejected", code} |
##                             {ok: false, reason: "aborted"}
##   delete_record(id, base_version)                 the same, without the cancel
##
## A write is the machine's `put_at` / `remove_at`: the record's `baseVersion` is exact (the version
## `finalize` answered), it is never coalesced with a queued edit nor rebased on a conflict, the codec seals
## it in E2E mode like any other push, and the call waits for that one mutation's outcome (ok, conflict with
## the server copy, rejected, or dropped by a sign-out). There is no timeout: a cancel, a sign-out drop and
## the host's own retries end the wait. The outcome listener must not call back into the machine; it only
## files the outcome under its ticket.

const COLLECTION := "saves"

var _host: Node
var _blind: Callable
## ticket -> {done: bool, outcome: Dictionary}
var _waiting := {}


## `blind` is `Callable(collection, id) -> String` (the codec's `blind_record`).
func _init(host: Node, blind: Callable) -> void:
	_host = host
	_blind = blind
	host.on_outcome(_on_outcome)


func _on_outcome(o: Dictionary) -> void:
	var w: Variant = _waiting.get(int(o["mutationId"]))
	if w is Dictionary and not w["done"]:
		w["done"] = true
		w["outcome"] = o


## Settle every write still waiting as dropped (the person and their data are gone).
func drop_all() -> void:
	for ticket: int in _waiting.keys():
		var w: Dictionary = _waiting[ticket]
		if not w["done"]:
			w["done"] = true
			w["outcome"] = {"mutationId": ticket, "status": "dropped"}


func _machine() -> Object:
	return _host.machine() if _host != null and is_instance_valid(_host) and _host.is_started() else null


func e2e() -> bool:
	var m := _machine()
	return m != null and m.encryption_mode() == "e2e"


## "" while the codec is locked (end-to-end mode only).
func wire_id(id: String) -> String:
	if not e2e():
		return id
	return _blind.call(COLLECTION, id)


static func _meta(v: Variant) -> Dictionary:
	return (v as Dictionary).duplicate(true) if v is Dictionary else {}


static func _record(row: Dictionary, id: String) -> Dictionary:
	return {"id": id, "version": int(row["version"]), "value": _meta(row.get("value")), "file": row.get("file")}


func _rows() -> Array:
	var m := _machine()
	return m.records(COLLECTION) if m != null else []


func list() -> Array:
	var hide := e2e()
	var out: Array = []
	for r: Dictionary in _rows():
		if hide and PKeySyncBlind.is_blinded_name(r["id"]):
			continue
		out.append(_record(r, r["id"]))
	return out


func get_record(id: String) -> Variant:
	var rows := _rows()
	for r: Dictionary in rows:
		if r["id"] == id:
			return _record(r, id)
	# A record that has a file and no value comes back under its wire id (the host cannot place its
	# blinded id without a value).
	if e2e():
		var wire := wire_id(id)
		if wire != "":
			for r: Dictionary in rows:
				if r["id"] == wire:
					return _record(r, id)
	return null


## Start the exact write `start` (a Callable() -> machine result) and wait for its one outcome.
func _wait(start: Callable, cancel: Variant) -> Dictionary:
	var m := _machine()
	if m == null:
		return {"ok": false, "reason": "rejected", "code": "sync-not-started"}
	_host.catch_up()
	var started: Dictionary = start.call(m)
	if not started["ok"]:
		return {"ok": false, "reason": "rejected", "code": str(started["error"])}
	var ticket := int(started["mutationId"])
	var w := {"done": false, "outcome": null}
	_waiting[ticket] = w
	_host.deliver_events()
	_host.touch()
	var tree := Engine.get_main_loop() as SceneTree
	# No timeout: a cancel, a sign-out drop (`drop_all`) and the host's retries end the wait.
	while not w["done"]:
		if cancel != null and cancel.cancelled:
			_waiting.erase(ticket)
			return {"ok": false, "reason": "aborted"}
		await tree.process_frame
	_waiting.erase(ticket)
	var o: Dictionary = w["outcome"]
	match o["status"]:
		"ok":
			return {"ok": true, "version": int(o["version"])}
		"conflict":
			var server: Variant = o.get("server")
			if server is Dictionary:
				server = {"id": "", "version": int(server["version"]), "value": _meta(server.get("value")), "file": server.get("file")}
			return {"ok": false, "reason": "conflict", "server": server}
		"rejected":
			return {"ok": false, "reason": "rejected", "code": str(o.get("code", "rejected"))}
	# dropped
	return {"ok": false, "reason": "rejected", "code": "signed-out"}


static func _with_id(r: Dictionary, id: String) -> Dictionary:
	if not r["ok"] and r["reason"] == "conflict" and r["server"] is Dictionary:
		r["server"]["id"] = id
	return r


## `cancel` is a Transfer.Cancel: when its flag is set the wait ends with `aborted` (a pause does not
## set this one; only the handle's cancel does).
func set_record(id: String, value: Dictionary, base_version: Variant, cancel: Variant = null) -> Dictionary:
	return _with_id(await _wait(func(m: Object) -> Dictionary: return m.put_at(COLLECTION, id, value, base_version), cancel), id)


func delete_record(id: String, base_version: int) -> Dictionary:
	return _with_id(await _wait(func(m: Object) -> Dictionary: return m.remove_at(COLLECTION, id, base_version), null), id)
