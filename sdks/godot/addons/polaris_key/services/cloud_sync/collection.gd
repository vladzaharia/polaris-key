class_name PKeyCollection
extends RefCounted
## The records handle of a Cloud Sync collection (plans/C-26 D-2, U-46): `await PolarisKey.cloud_sync.
## collection(name)` over the host's machine. A port of client-core's `SyncCollection`
## (`packages/client-core/src/sync/collection.ts`). The catalog checks are made before anything is
## journalled, so a refused call changes nothing and sends nothing. A refusal is returned, never
## raised: a failed `PKeyResult` whose code is `collection_unknown` (a name the catalog does not
## declare), `op_invalid_for_policy` (a verb the collection's policy does not allow), `value_invalid`
## (a value or name over a cap) or `signed_out` (local only; nobody is signed in).
##
##   get_record(id)             {value, from} or null: pending edits over the cloud copy
##   ids()                      the ids a person holds, in byte order, pending creates included
##   put(id, value, if_version) lastWrite, max, min: a stamped write; revision: a write based on the
##                              version held, or on `if_version` (an int, or "*" to create only) as an
##                              exact compare-and-set, whose ticket is `detail.mutation_id` and whose
##                              outcome arrives on `outcome`
##   update(id, changes)        merge: `{"set": {field: value}, "remove": [field]}`; other fields stay
##   add(id, element) / remove(id, element)    union: an element is at most 1 KiB of canonical JSON
##   delete(id, if_version)     any policy; for revision a compare-and-set (default: the version held)
##
## Observers are signals. `changed` fires for this device's own writes (origin "local") and for what a
## pull brought (origin "remote"); `outcome` carries the result of a compare-and-set `put` or `delete`
## under the ticket it returned.

## These records changed (ids in byte order); `origin` is "local" or "remote".
signal changed(ids: Array, origin: String)
## A compare-and-set's result: `{mutationId, status: "ok" | "conflict" | "rejected" | "dropped", ...}`.
signal outcome(result: Dictionary)

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")

## A merge field name: non-empty, at most 1 KiB (V5 section 13.3).
const MAX_FIELD_BYTES := 1024
const SIGNED_OUT := &"signed_out"
const _PUT_POLICIES := ["lastWrite", "max", "min", "revision"]

var name: String

var _host: Node
var _tickets := {}
var _off_tap: Callable = Callable()


func _init(p_name: String, host: Node) -> void:
	name = p_name
	_host = host
	_host.events.connect(_on_events)
	var m: Object = _machine()
	if m != null:
		m.watch_records(name, true)
		_off_tap = m.tap_outcomes(_on_outcome)


## Stops watching: the signals fall silent and the machine computes nothing for this collection.
func close() -> void:
	if _host != null and is_instance_valid(_host):
		if _host.events.is_connected(_on_events):
			_host.events.disconnect(_on_events)
		var m: Object = _machine()
		if m != null:
			m.watch_records(name, false)
			if _off_tap.is_valid():
				_off_tap.call()
	_off_tap = Callable()
	_host = null


func _machine() -> Object:
	return _host.machine() if _host != null and is_instance_valid(_host) and _host.is_started() else null


# ── reads ─────────────────────────────────────────────────────────────────────────────────────


## The policy the catalog declares for this name ("lastWrite", "max", "min", "revision", "merge" or
## "union"), or "" when it declares none.
func policy() -> String:
	var d: Variant = _decl()
	return String(d["policy"]) if d != null else ""


## The effective value and where it came from, `{value, from: "pending" | "cloud"}`, or null. An
## undeclared name is null; stored JSON comes back untouched, so a field this version does not know
## survives.
func get_record(id: String) -> Variant:
	var m := _machine()
	if m == null or m.collection_decl(name) == null:
		return null
	_host.catch_up()
	return m.record(name, id)


## The ids of the records a person holds, in byte order, pending creates included.
func ids() -> Array:
	var m := _machine()
	if m == null or m.collection_decl(name) == null:
		return []
	_host.catch_up()
	var e2e: bool = m.encryption_mode() == "e2e"
	var out: Array = []
	# E2E: a record that holds a file and no value is listed under its wire id; it has no name.
	for id: String in m.record_ids(name):
		if not (e2e and PKeySyncBlind.is_blinded_name(id)):
			out.append(id)
	return out


# ── writes ────────────────────────────────────────────────────────────────────────────────────


func put(id: String, value: Variant, if_version: Variant = null) -> PKeyResult:
	var d: Variant = _check(id, func(p: String) -> bool: return _PUT_POLICIES.has(p))
	if d is PKeyResult:
		return d
	if if_version != null:
		if d["policy"] != "revision":
			return _refuse(PKeyConstants.ErrorCode.OP_INVALID_FOR_POLICY)
		var base: Variant = _version_of(if_version)
		if base == null:
			return _refuse(PKeyConstants.ErrorCode.VALUE_INVALID)
		_prepare()
		var r: Dictionary = _machine().put_at(name, id, value, base)
		return _ticketed(r)
	_prepare()
	return _done(_machine().put(name, id, value))


func update(id: String, changes: Dictionary) -> PKeyResult:
	var d: Variant = _check(id, func(p: String) -> bool: return p == "merge")
	if d is PKeyResult:
		return d
	var sets: Variant = changes.get("set", {})
	var removes: Variant = changes.get("remove", [])
	if not (sets is Dictionary) or not (removes is Array):
		return _refuse(PKeyConstants.ErrorCode.VALUE_INVALID)
	var seen := {}
	for n in (sets as Dictionary).keys() + (removes as Array):
		if not (n is String) or n == "" or n.to_utf8_buffer().size() > MAX_FIELD_BYTES or seen.has(n):
			return _refuse(PKeyConstants.ErrorCode.VALUE_INVALID)
		seen[n] = true
	if seen.is_empty():
		return _refuse(PKeyConstants.ErrorCode.VALUE_INVALID)
	_prepare()
	return _done(_machine().update(name, id, {"set": sets, "remove": removes}))


func add(id: String, element: Variant) -> PKeyResult:
	return _element(id, element, true)


func remove(id: String, element: Variant) -> PKeyResult:
	return _element(id, element, false)


func delete(id: String, if_version: Variant = null) -> PKeyResult:
	var d: Variant = _check(id, func(_p: String) -> bool: return true)
	if d is PKeyResult:
		return d
	_prepare()
	var m := _machine()
	if d["policy"] == "revision":
		var base: Variant = "*"
		if if_version != null:
			base = _version_of(if_version)
			if base == null:
				return _refuse(PKeyConstants.ErrorCode.VALUE_INVALID)
		else:
			for r: Dictionary in m.records(name):
				if r["id"] == id:
					base = r["version"]
		return _ticketed(m.remove_at(name, id, base))
	if if_version != null:
		return _refuse(PKeyConstants.ErrorCode.OP_INVALID_FOR_POLICY)
	return _done(m.delete(name, id))


# ── internals ─────────────────────────────────────────────────────────────────────────────────


func _decl() -> Variant:
	var m := _machine()
	return m.collection_decl(name) if m != null else null


## The declaration when the call may go on, else the refusal.
func _check(id: String, allowed: Callable) -> Variant:
	var m := _machine()
	if m == null:
		return _refuse(SIGNED_OUT)
	var d: Variant = m.collection_decl(name)
	if d == null:
		return _refuse(PKeyConstants.ErrorCode.COLLECTION_UNKNOWN)
	if not allowed.call(String(d["policy"])):
		return _refuse(PKeyConstants.ErrorCode.OP_INVALID_FOR_POLICY)
	if id == "":
		return _refuse(PKeyConstants.ErrorCode.VALUE_INVALID)
	return d


func _element(id: String, element: Variant, adding: bool) -> PKeyResult:
	var d: Variant = _check(id, func(p: String) -> bool: return p == "union")
	if d is PKeyResult:
		return d
	var c := PKeySyncCanonicalJson.canonicalize_value(element)
	if not c["ok"] or (c["bytes"] as PackedByteArray).size() > PKeyConstants.SYNC_MAX_UNION_ELEMENT_BYTES:
		return _refuse(PKeyConstants.ErrorCode.VALUE_INVALID)
	_prepare()
	var m := _machine()
	return _done(m.add(name, id, element) if adding else m.remove(name, id, element))


## An int, or "*" (create only); null for anything else.
static func _version_of(v: Variant) -> Variant:
	if v is String and v == "*":
		return "*"
	if (v is int and typeof(v) != TYPE_BOOL) or (v is float and Types.is_integer(v)):
		return int(v)
	return null


func _prepare() -> void:
	_host.ensure_current()
	_host.catch_up()


static func _refuse(code: Variant) -> PKeyResult:
	return PKeyResult.failure(StringName(code), "The collection call was refused; nothing was sent.")


## A machine answer to a plain verb: the host reports the events and the pump runs.
func _done(r: Dictionary) -> PKeyResult:
	if not r["ok"]:
		return _failed(String(r["error"]))
	_touch()
	return PKeyResult.success()


## A machine answer to a compare-and-set: the ticket is kept so its outcome reaches `outcome`.
func _ticketed(r: Dictionary) -> PKeyResult:
	if not r["ok"]:
		return _failed(String(r["error"]))
	_tickets[int(r["mutationId"])] = true
	_touch()
	return PKeyResult.success({"mutation_id": int(r["mutationId"])})


static func _failed(error: String) -> PKeyResult:
	if error == "signed-out":
		return _refuse(SIGNED_OUT)
	return _refuse(PKeyConstants.ErrorCode.COLLECTION_UNKNOWN)


func _touch() -> void:
	_host.deliver_events()
	_host.touch()


func _on_events(batch: Array) -> void:
	for e: Dictionary in batch:
		if e.get("type") == "records" and e.get("collection") == name:
			changed.emit(e["ids"], e["origin"])


func _on_outcome(o: Dictionary) -> void:
	var ticket := int(o["mutationId"])
	if not _tickets.has(ticket):
		return
	_tickets.erase(ticket)
	outcome.emit(o)
