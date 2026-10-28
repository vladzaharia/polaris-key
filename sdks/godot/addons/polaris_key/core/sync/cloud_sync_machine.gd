extends RefCounted
## The Cloud Sync client state machine: a port of Python `cloud_sync/machine.py` (itself a port of
## client-core's `cloud-sync.ts`; plans/U-01.md, S-17 sections 5.4-5.6, WIRE-CONTRACT-V5 section 11.5).
##
## It does no I/O. The host derives the setting routes with `sync_routes.gd` and passes them in. The
## machine owns a fake-able clock (`advance`), queues the requests it would send (`take_requests`)
## and the events it would emit (`take_events`), and is told what the transport answered (`receive`).
## At most one request is in flight. Everything is plain JSON data, so the journal and the persisted
## state are what the corpus compares. Nothing here touches licence state.
##
## Ported in this slice (U-21.2): the local half. HLC, `value_valid`, `apply_setting_op`, journal,
## drafts, debounce, partitions, routes, `import_local`, `get_value`, `setting_state`, `status`,
## `persist`, `relaunch`, the request queue (`_kick`), sign-in and sign-out, the E2E gate (`set_root`,
## `set_discovery`). NOT ported yet: `receive` and what it drives (U-21.3 exchanges, U-21.4 blocked
## states, U-21.5 E2E bodies and the X-1 conflict-copy cursor). `receive` fails loudly until then.
##
## Godot notes: `set` and `get` are Object methods, so the value calls are `set_value`, `get_value`
## and `clear_value`. `null` is a value; `Types.ABSENT` is "no value". Compare with `Types.json_equal`.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const Canonical := preload("res://addons/polaris_key/core/sync/canonical_json.gd")

const LOCAL_PARTITION := Types.LOCAL_PARTITION
const _JOURNAL_ONLY := ["preContact", "moved", "parked"]

var _product: String
var _catalog: Dictionary
var _document: Dictionary
var _on_sign_out: String
var _new_client_id: Callable
var _app_encryption: String
var _root: bool
## What the Worker advertised this session: "e2e", "server", "omitted" or null (not yet known).
var _advertised: Variant = null
var _now: int
var _network: String
var _drafts: Dictionary = {}
var _in_flight: Variant = null
var _signing_out: Variant = null
var _need_snapshot := false
var _pull_wanted := false
var _paused := false
var _outbox: Array = []
var _events: Array = []
var _s: Dictionary
var _client_id_re: RegEx
var _hlc_re: RegEx


func _init(opts: Dictionary, persisted: Variant = null) -> void:
	_client_id_re = RegEx.create_from_string(PKeyConstants.SYNC_CLIENT_ID_PATTERN)
	_hlc_re = RegEx.create_from_string(PKeyConstants.SYNC_HLC_PATTERN)
	_product = opts["product"]
	_catalog = opts["catalog"]
	_document = opts["document"]
	var so: Variant = opts.get("onSignOut")
	_on_sign_out = String(so) if so != null and String(so) != "" else "clear"
	_new_client_id = opts["newClientId"]
	var enc: Variant = opts.get("encryption")
	_app_encryption = "e2e" if enc == null else String(enc)
	_root = opts.get("hasRoot", false) == true
	_now = opts["now"]
	var net: Variant = opts.get("network")
	_network = String(net) if net != null and String(net) != "" else "online"
	if persisted != null:
		_s = Types.clone(persisted)
	else:
		var off: Variant = opts.get("offsetMs")
		var dl: Variant = opts.get("deviceLocal")
		_s = {
			"subject": opts.get("subject"),
			"partitions": {LOCAL_PARTITION: _new_partition(null)},
			"hlc": [0, 0],
			"offsetMs": off if off != null else 0,
			"contacted": opts.get("contacted", false) == true,
			"aliases": {},
			"blocked": null,
			"deviceLocal": Types.clone(dl) if dl != null else {},
			"imported": opts.get("imported", false) == true,
		}
	if not _s["partitions"].has(LOCAL_PARTITION):
		_s["partitions"][LOCAL_PARTITION] = _new_partition(null)
	if not _s.has("e2eSeen"):
		_s["e2eSeen"] = false
	var discovery: Variant = opts.get("discovery")
	if discovery != null and not discovery.is_empty():
		var d: Variant = discovery.get("encryption")
		_advertised = String(d) if d != null and String(d) != "" else "omitted"
	if _s["subject"] != null:
		_partition_for(_s["subject"])
	_expire_partitions()
	_pull_wanted = true
	_kick()


# ── module helpers ────────────────────────────────────────────────────────────────────────────


static func _sorted(keys: Array) -> Array:
	var out: Array = keys.duplicate()
	out.sort_custom(func(a: Variant, b: Variant) -> bool: return Types.utf16_less(String(a), String(b)))
	return out


static func json_bytes(v: Variant) -> int:
	var r: Dictionary = Canonical.canonicalize_value(v)
	if not r["ok"]:
		return 1 << 40
	return (r["bytes"] as PackedByteArray).size()


static func format_hlc(physical_ms: int, counter: int) -> String:
	assert(physical_ms >= 0 and physical_ms <= 0xFFFFFFFFFFFF, "HLC physical part out of range")
	assert(counter >= 0 and counter <= 0xFFFF, "HLC counter out of range")
	return "%012x:%04x" % [physical_ms, counter]


## `[physical_ms, counter]`, or null when `hlc` is not an HLC.
func parse_hlc(hlc: Variant) -> Variant:
	if not Types.is_string(hlc) or _hlc_re.search(String(hlc)) == null:
		return null
	var h := String(hlc)
	return [h.substr(0, 12).hex_to_int(), h.substr(13).hex_to_int()]


## Whether `value` satisfies the schema subset (absent schema: anything).
static func value_valid(value: Variant, schema: Variant) -> bool:
	if schema == null or not (schema is Dictionary) or schema.is_empty():
		return true
	var t: Variant = schema.get("type")
	var ts := String(t) if Types.is_string(t) else ""
	if ts == "number" or ts == "integer":
		if not Types.is_number(value):
			return false
		if ts == "integer" and not Types.is_integer(value):
			return false
		var mn: Variant = schema.get("minimum")
		if mn != null and value < mn:
			return false
		var mx: Variant = schema.get("maximum")
		if mx != null and value > mx:
			return false
	elif ts == "string":
		if not Types.is_string(value):
			return false
	elif ts == "boolean":
		if typeof(value) != TYPE_BOOL:
			return false
	elif ts == "object":
		if not (value is Dictionary):
			return false
	var enum_v: Variant = schema.get("enum")
	if enum_v == null:
		return true
	for e in enum_v:
		if Types.json_equal(e, value):
			return true
	return false


## One setting operation applied to a value under the key's policy. `ABSENT` is "no value"; a JSON
## null is a value.
static func apply_setting_op(policy: String, base: Variant, op: Dictionary) -> Variant:
	var name: String = op["op"]
	if name == "clear":
		return Types.ABSENT
	if name == "set":
		var v: Variant = op.get("value")
		if (policy == "max" or policy == "min") and Types.is_number(base) and Types.is_number(v):
			if policy == "max":
				return base if base >= v else v
			return base if base <= v else v
		return Types.clone(v)
	if name == "setMember":
		var o: Dictionary = (base as Dictionary).duplicate() if base is Dictionary else {}
		o[op["member"]] = Types.clone(op.get("value"))
		return o
	if name == "removeMember":
		var o2: Dictionary = (base as Dictionary).duplicate() if base is Dictionary else {}
		o2.erase(op["member"])
		return o2
	return base


static func _apply_record_op(base: Variant, op: Dictionary) -> Variant:
	var name: String = op["op"]
	if name == "set":
		return Types.clone(op.get("value"))
	if name == "setMember" or name == "removeMember":
		return apply_setting_op("merge", base, op)
	if name == "add":
		var arr: Array = (base as Array).duplicate() if base is Array else []
		var found := false
		for x in arr:
			if Types.json_equal(x, op.get("element")):
				found = true
				break
		if not found:
			arr.append(Types.clone(op.get("element")))
		return arr
	if name == "remove":
		var out: Array = []
		for x in (base if base is Array else []):
			if not Types.json_equal(x, op.get("element")):
				out.append(x)
		return out
	return base


static func _record_key(c: String, i: String) -> String:
	return "%s/%s" % [c, i]


static func _rk_of(target: Dictionary) -> String:
	var r: Array = target["record"]
	return _record_key(r[0], r[1])


static func _new_partition(client_id: Variant) -> Dictionary:
	return {
		"clientId": client_id,
		"nextMutationId": 1,
		"cursor": 0,
		"pending": [],
		"held": {},
		"settings": {},
		"records": {},
		"device": {},
		"signedOutAt": null,
		"headroom": null,
	}


## The wire form of a journalled mutation (journal-only marks stripped).
static func wire_of(op: Dictionary) -> Dictionary:
	var out := {}
	for k in op:
		if not _JOURNAL_ONLY.has(k):
			out[k] = Types.clone(op[k])
	return out


static func _truthy(d: Dictionary, k: String) -> bool:
	var v: Variant = d.get(k)
	return v != null and not (typeof(v) == TYPE_BOOL and v == false)


static func _merged(a: Dictionary, b: Dictionary) -> Dictionary:
	var out := a.duplicate()
	out.merge(b, true)
	return out


# ── host surface ──────────────────────────────────────────────────────────────────────────────


func now() -> int:
	return _now


func network_state() -> String:
	return _network


## What survives a relaunch (the drafts are committed first, as the exit flush does).
func persist() -> Dictionary:
	_commit_all_drafts()
	return Types.clone(_s)


func take_requests() -> Array:
	var out := _outbox
	_outbox = []
	return out


func take_events() -> Array:
	var out := _events
	_events = []
	return out


# ── SDK calls ─────────────────────────────────────────────────────────────────────────────────


## `config.set` while Cloud Sync is on.
func set_value(key: String, value: Variant) -> Dictionary:
	return _edit(key, {"value": Types.clone(value)})


## `config.clear` while Cloud Sync is on.
func clear_value(key: String) -> Dictionary:
	return _edit(key, {"clear": true})


## Once per install, with the legacy `config.local` contents. Synced and undeclared keys enter at
## the HLC floor, so a newer cloud value always wins; `local` keys stay on the device; locked,
## refused, invalid and over-size values are not imported. A second call does nothing.
func import_local(values: Dictionary) -> Dictionary:
	if _s["imported"]:
		return Types.ok()
	_s["imported"] = true
	var before := _value_map()
	var local: Dictionary = _s["partitions"][LOCAL_PARTITION]
	for key: String in _sorted(values.keys()):
		var value: Variant = values[key]
		var r: Variant = _route(key)
		var rr := String(r["route"]) if r != null else ""
		if r != null and (rr == "locked" or rr == "refused"):
			continue
		if r != null and rr == "synced" and not value_valid(value, r.get("schema")):
			continue
		if json_bytes(value) > PKeyConstants.SYNC_MAX_VALUE_BYTES:
			continue
		if r != null and rr == "local":
			if not _s["deviceLocal"].has(key):
				_s["deviceLocal"][key] = Types.clone(value)
			continue
		if _s["subject"] == null:
			if not local["device"].has(key):
				local["device"][key] = {"value": Types.clone(value), "editedHlc": PKeyConstants.SYNC_IMPORT_HLC}
			continue
		_enqueue_setting(_active(), key, value, PKeyConstants.SYNC_IMPORT_HLC, {"moved": true})
	_emit_changes(before, {}, "local")
	_kick()
	return Types.ok()


## Commit every debounced edit now and push.
func flush() -> Dictionary:
	_commit_all_drafts()
	_kick()
	return Types.ok()


## A licence or config document fetch succeeded: the only thing that lifts a `/sync` 401 or a
## non-`account_required` 403.
func refresh() -> Dictionary:
	var b: Variant = _s["blocked"]
	if b != null and ["unauthorized", "attestation", "forbidden"].has(String(b)):
		_s["blocked"] = null
		_kick()
	return Types.ok()


## The effective mode: E2E when the app requires it or this device has ever accepted E2E.
func encryption_mode() -> String:
	return "e2e" if _requires_e2e() else "server"


## `encryptionSince` of the active partition's last E2E pull, or null.
func encryption_since() -> Variant:
	if _s["subject"] == null:
		return null
	return _active().get("encryptionSince")


## The ring's root arrived (unlock) or went away (lock). Unlocking sends the held operations in
## `mutationId` order; locking sends and reads nothing more.
func set_root(present: bool) -> void:
	if _root == present:
		return
	_root = present
	_gate_changed()


## What discovery says about `services.sync.encryption`. A Worker that omits the member is
## `omitted`, the same refusal as `server` for an app that requires E2E. null forgets it.
func set_discovery(discovery: Variant) -> void:
	var before: Variant = _advertised
	if discovery == null:
		_advertised = null
	else:
		var d: Variant = discovery.get("encryption")
		_advertised = String(d) if d != null and String(d) != "" else "omitted"
	if _advertised == "e2e" and _requires_e2e():
		_s["e2eSeen"] = true
	if before != _advertised:
		_gate_changed()


## Write a record: compare-and-swap for `revision`, a stamped `set` for `lastWrite`, `max` and
## `min`, member operations for `merge`.
func put(collection: String, record_id: String, value: Variant) -> Dictionary:
	var decl: Variant = _collection(collection)
	if decl == null or decl["policy"] == "union":
		return Types.fail("collection-unknown")
	if _s["subject"] == null:
		return Types.fail("signed-out")
	var p := _active()
	var rk := _record_key(collection, record_id)
	var target := {"record": [collection, record_id]}
	if decl["policy"] == "revision":
		if _in_flight_touches(rk):
			p["held"][rk] = Types.clone(value)
		else:
			var queued: Variant = null
			for o: Dictionary in p["pending"]:
				if o["target"].has("record") and _rk_of(o["target"]) == rk:
					queued = o
					break
			if queued != null:
				queued["value"] = Types.clone(value)
			else:
				var row: Variant = p["records"].get(rk)
				_enqueue(p, {
					"target": target,
					"op": "set",
					"value": Types.clone(value),
					"baseVersion": row["version"] if row != null else "*",
				})
	else:
		var edited := _tick_hlc()
		var marks := {} if _s["contacted"] else {"preContact": true}
		if decl["policy"] == "merge":
			var rec: Variant = _record(collection, record_id)
			var current: Variant = rec["value"] if rec != null else null
			var cur: Dictionary = current if current is Dictionary else {}
			var nxt: Dictionary = value if value is Dictionary else {}
			for member: String in _sorted(nxt.keys()):
				if not cur.has(member) or not Types.json_equal(cur[member], nxt[member]):
					_enqueue(p, _merged({
						"target": target,
						"op": "setMember",
						"member": member,
						"value": Types.clone(nxt[member]),
						"editedHlc": edited,
					}, marks))
			for member: String in _sorted(cur.keys()):
				if not nxt.has(member):
					_enqueue(p, _merged({"target": target, "op": "removeMember", "member": member, "editedHlc": edited}, marks))
		else:
			var queued2: Variant = null
			if not _in_flight_touches(rk):
				for o: Dictionary in p["pending"]:
					if o["target"].has("record") and _rk_of(o["target"]) == rk and o["op"] == "set":
						queued2 = o
						break
			if queued2 != null:
				queued2["value"] = Types.clone(value)
				queued2["editedHlc"] = edited
			else:
				_enqueue(p, _merged({"target": target, "op": "set", "value": Types.clone(value), "editedHlc": edited}, marks))
	_kick()
	return Types.ok()


## Add to a `union` record (an OR-set).
func add(collection: String, record_id: String, element: Variant) -> Dictionary:
	return _union_op(collection, record_id, element, "add")


## Remove from a `union` record, observed at the current cursor.
func remove(collection: String, record_id: String, element: Variant) -> Dictionary:
	return _union_op(collection, record_id, element, "remove")


func sign_in(subject: String) -> Dictionary:
	if _s["subject"] == subject:
		return Types.ok()
	if _s["subject"] != null:
		_leave("signOut", false)
	_commit_all_drafts()
	var before := _value_map()
	_s["blocked"] = null
	_signing_out = null
	_expire_partitions()
	var p := _partition_for(subject)
	p["signedOutAt"] = null
	var local: Dictionary = _s["partitions"][LOCAL_PARTITION]
	var moving: Array = []
	for k: String in local["device"]:
		if _syncs(k):
			moving.append(k)
	moving = _sorted(moving)
	# A sign-in change re-sends every parked edit (R5), except one a moved local edit replaces.
	for key: String in moving:
		_drop_parked_by_local_edit(p, key)
	_unpark(p, func(_reason: String) -> bool: return true)
	for key: String in moving:
		var d: Dictionary = local["device"][key]
		var marks := {"moved": true}
		if _truthy(d, "preContact"):
			marks["preContact"] = true
		if _truthy(d, "cleared"):
			_enqueue(p, _merged({"target": _target_of(key), "op": "clear", "editedHlc": d["editedHlc"]}, marks))
		else:
			_enqueue_setting(p, key, d.get("value"), d["editedHlc"], marks)
		local["device"].erase(key)
	_s["subject"] = subject
	_pull_wanted = true
	_need_snapshot = false
	_emit_changes(before, {}, "remote")
	_kick()
	return Types.ok()


func sign_out(discard_unsynced: bool = false) -> Dictionary:
	if _s["subject"] == null:
		return Types.ok()
	_commit_all_drafts()
	var p := _active()
	if not discard_unsynced and _network == "online" and _s["blocked"] == null and _may_talk() and _sendable(p) > 0:
		_signing_out = {"deadline": _now + PKeyConstants.SYNC_SIGNOUT_FLUSH_MS, "discard": discard_unsynced}
		_kick()
	else:
		_leave("signOut", discard_unsynced)
	return Types.ok()


func set_network(state: String) -> void:
	assert(not (state == "offline" and _in_flight != null), "network: a request is in flight; respond first")
	_network = state
	if state == "online":
		_pull_wanted = true
		_kick()


## Move the clock, firing debounce commits and the sign-out flush deadline in time order.
func advance(ms: int) -> void:
	var target := _now + ms
	while true:
		var nxt := -1
		for k: String in _drafts:
			var due: int = _drafts[k]["due"]
			if due <= target and (nxt == -1 or due < nxt):
				nxt = due
		var so: Variant = _signing_out
		if so != null and so["deadline"] <= target and (nxt == -1 or so["deadline"] < nxt):
			nxt = so["deadline"]
		if nxt == -1:
			break
		_now = nxt
		if so != null and so["deadline"] == nxt:
			_in_flight = null
			_leave("signOut", so["discard"])
			continue
		var due_keys: Array = []
		for k: String in _drafts:
			if _drafts[k]["due"] == nxt:
				due_keys.append(k)
		for k: String in _sorted(due_keys):
			_commit_draft(k)
		_kick()
	_now = target


## The transport's answer to the request in flight. Ported by U-21.3 (exchanges), U-21.4 (blocked
## states and expiry) and U-21.5 (E2E bodies). Until then a scenario with a `respond` step is
## pending in the runner, and calling this fails the call rather than guess.
func receive(_res: Dictionary, _opened: Variant = null) -> void:
	assert(false, "receive: ported in U-21.3")


# ── reads ─────────────────────────────────────────────────────────────────────────────────────


func get_value(key: String) -> Dictionary:
	var doc := {"value": Types.clone(_document["values"].get(key)), "from": "document"}
	var r: Variant = _route(key)
	var rr := String(r["route"]) if r != null else ""
	# A lock beats the person's own choice, the `local` slot included.
	if _locked(key) or (r != null and (rr == "locked" or rr == "refused")):
		return doc
	if r != null and rr == "local":
		var dl: Dictionary = _s["deviceLocal"]
		return {"value": Types.clone(dl[key]), "from": "device"} if dl.has(key) else doc
	var layer: Variant = _layer(key)
	if layer == null or Types.is_absent(layer["value"]):
		return doc
	if not value_valid(layer["value"], _schema_of(key)):
		return doc
	return {"value": Types.clone(layer["value"]), "from": layer["from"]}


func setting_state(key: String) -> Dictionary:
	var r: Variant = _route(key)
	var rr := String(r["route"]) if r != null else ""
	var layer: Variant = _layer(key) if _syncs(key) else null
	var sync: String
	if _s["subject"] == null or (r != null and rr == "local"):
		sync = "local"
	elif layer != null and layer["pending"]:
		sync = "pending"
	else:
		sync = "synced"
	var invalid: bool = (layer != null and not Types.is_absent(layer["value"]) and not value_valid(layer["value"], _schema_of(key))) \
		or (_syncs(key) and _snapshot_unreadable(_alias(key)) and not (layer != null and layer["pending"]))
	return {
		"sync": sync,
		"invalid": invalid,
		"locked": _locked(key) or (r != null and rr == "locked"),
	}


func record(collection: String, record_id: String) -> Variant:
	return _record(collection, record_id)


func _record(collection: String, record_id: String) -> Variant:
	if _s["subject"] == null:
		return null
	var p := _active()
	var rk := _record_key(collection, record_id)
	var row: Variant = p["records"].get(rk)
	var value: Variant = row["value"] if row != null and not _row_unreadable(row) else Types.ABSENT
	var pending := false
	for op: Dictionary in p["pending"]:
		if op["target"].has("record") and _rk_of(op["target"]) == rk:
			value = _apply_record_op(value, op)
			pending = true
	if p["held"].has(rk):
		value = Types.clone(p["held"][rk])
		pending = true
	if Types.is_absent(value):
		return null
	return {"value": Types.clone(value), "from": "pending" if pending else "cloud"}


func status() -> Dictionary:
	var pending := _pending_count()
	if _pinned_out():
		return {"state": "unsupported", "pending": pending, "reason": "encryption", "code": PKeyConstants.ErrorCode.SYNC_ENCRYPTION_PINNED}
	if _s["blocked"] != null and String(_s["blocked"]) != "":
		return {"state": "blocked", "pending": pending, "reason": _s["blocked"]}
	if _s["subject"] == null:
		return {"state": "local", "pending": pending}
	if _locked_out():
		return {"state": "locked", "pending": pending, "reason": "keyring"}
	var parked := _parked_reason()
	var state: String
	if _network == "offline":
		state = "offline"
	elif _in_flight != null:
		state = "syncing"
	elif _paused:
		state = "paused"
	else:
		state = "pending" if pending > 0 else "idle"
	var out := {"state": state, "pending": pending}
	if parked != "":
		out["reason"] = parked
	return out


## The journal, normalised: what every SDK's journal must hold, whatever its encoding.
func journal() -> Dictionary:
	var out := {}
	for name: String in _sorted(_s["partitions"].keys()):
		var p: Dictionary = _s["partitions"][name]
		if name == LOCAL_PARTITION:
			if not p["device"].is_empty():
				out[name] = {"settings": Types.clone(p["device"])}
			continue
		var view := {
			"clientId": p["clientId"],
			"nextMutationId": p["nextMutationId"],
			"cursor": p["cursor"],
			"pending": Types.clone(p["pending"]),
		}
		if not p["held"].is_empty():
			view["held"] = Types.clone(p["held"])
		out[name] = view
	return out


# ── internals ─────────────────────────────────────────────────────────────────────────────────


## The app requires E2E, or this device has accepted it before: the pin cannot be undone.
func _requires_e2e() -> bool:
	return _app_encryption == "e2e" or _s.get("e2eSeen") == true


## The Worker's answer contradicts the mode: nothing is sent to it and nothing it says is read.
func _pinned_out() -> bool:
	if _advertised == null:
		return false
	if _requires_e2e():
		return _advertised != "e2e"
	return _advertised == "e2e"


## E2E with no root for the ring.
func _locked_out() -> bool:
	return _requires_e2e() and not _root


func _may_talk() -> bool:
	return not _pinned_out() and not _locked_out()


func _row_unreadable(row: Dictionary) -> bool:
	if row.get("bad") == true or _locked_out():
		return true
	if not row.has("plain") or not _requires_e2e():
		return false
	var since: Variant = null if _s["subject"] == null else _active().get("encryptionSince")
	return not (since != null and row["plain"] < since)


func _snapshot_unreadable(server_key: String) -> bool:
	if _s["subject"] == null:
		return false
	var row: Variant = _active()["settings"].get(server_key)
	return row != null and _row_unreadable(row)


## A lock, an unlock or a discovery answer changed what may be sent.
func _gate_changed() -> void:
	if _signing_out != null and _s["subject"] != null and not _may_talk():
		_leave("signOut", _signing_out["discard"])
		return
	_kick()


func _route(key: String) -> Variant:
	var settings: Array = _catalog["settings"]
	for d: Dictionary in settings:
		if d["key"] == key:
			return d
	var a := _alias(key)
	for d: Dictionary in settings:
		if d["key"] == a:
			return d
	return null


func _syncs(key: String) -> bool:
	var r: Variant = _route(key)
	return r == null or r["route"] == "synced"


func _policy_of(key: String) -> String:
	var r: Variant = _route(key)
	return String(r["policy"]) if r != null and r["route"] == "synced" else "lastWrite"


func _schema_of(key: String) -> Variant:
	var r: Variant = _route(key)
	return r.get("schema") if r != null and r["route"] == "synced" else null


func _target_of(key: String) -> Dictionary:
	var r: Variant = _route(key)
	return {"setting": key, "scope": r["scope"] if r != null and r["route"] == "synced" else "user"}


func _collection(name: String) -> Variant:
	var cs: Variant = _catalog.get("collections")
	if cs == null:
		return null
	for c: Dictionary in cs:
		if c["name"] == name:
			return c
	return null


func _alias(key: String) -> String:
	return String(_s["aliases"].get(key, key))


func _locked(key: String) -> bool:
	var l: Variant = _document.get("locked")
	return l != null and l.has(key)


func _active() -> Dictionary:
	var subject: Variant = _s["subject"]
	return _partition_for(LOCAL_PARTITION if subject == null else String(subject))


func _partition_for(name: String) -> Dictionary:
	var p: Variant = _s["partitions"].get(name)
	if p == null:
		p = _new_partition(null if name == LOCAL_PARTITION else _fresh_client_id())
		_s["partitions"][name] = p
	return p


func _fresh_client_id() -> String:
	var cid: String = _new_client_id.call()
	assert(_client_id_re.search(cid) != null, "bad clientId")
	return cid


func _pending_count() -> int:
	var drafts := _drafts.size()
	if _s["subject"] == null:
		return drafts
	var p := _active()
	return drafts + p["pending"].size() + p["held"].size()


## What a push can still carry: every journalled operation that is not parked, plus held.
func _sendable(p: Dictionary) -> int:
	var n: int = p["held"].size()
	for o: Dictionary in p["pending"]:
		if not _truthy(o, "parked"):
			n += 1
	return n


func _parked_reason() -> String:
	if _s["subject"] == null:
		return ""
	var quota := false
	var entitlement := false
	for o: Dictionary in _active()["pending"]:
		var k: Variant = o.get("parked")
		quota = quota or k == "quota"
		entitlement = entitlement or k == "entitlement"
	if quota:
		return "quota"
	if entitlement:
		return "entitlement"
	return ""


func _tick_hlc() -> String:
	var physical: int = _now + int(_s["offsetMs"])
	var hlc: Array = _s["hlc"]
	if physical > hlc[0]:
		_s["hlc"] = [physical, 0]
	else:
		_s["hlc"] = [hlc[0], hlc[1] + 1]
	return format_hlc(_s["hlc"][0], _s["hlc"][1])


func _layer(key: String) -> Variant:
	if not _syncs(key):
		return null
	var policy := _policy_of(key)
	var target := _alias(key)
	var value: Variant = Types.ABSENT
	var has := false
	var pending := false
	var p := _active()
	if _s["subject"] != null:
		var snap: Variant = p["settings"].get(target)
		if snap != null and not _row_unreadable(snap):
			value = Types.clone(snap["value"])
			has = true
		for op: Dictionary in p["pending"]:
			if op["target"].has("setting") and _alias(op["target"]["setting"]) == target:
				value = apply_setting_op(policy, value, op)
				pending = true
	else:
		for k: String in p["device"]:
			if _alias(k) == target:
				var d: Dictionary = p["device"][k]
				value = Types.ABSENT if _truthy(d, "cleared") else Types.clone(d.get("value"))
				has = true
	for k: String in _drafts:
		if _alias(k) == target:
			var dr: Dictionary = _drafts[k]
			if _truthy(dr, "clear"):
				value = Types.ABSENT
			elif policy == "merge":
				value = Types.clone(dr.get("value"))
			else:
				value = apply_setting_op(policy, value, {"op": "set", "value": dr.get("value")})
			pending = true
	if not has and not pending:
		return null
	var origin: String
	if pending:
		origin = "pending"
	else:
		origin = "cloud" if _s["subject"] != null else "device"
	return {"value": value, "from": origin, "pending": pending}


func _open_keys() -> Array:
	var keys := {}
	if _s["subject"] != null:
		var p := _active()
		for k: String in p["settings"]:
			if _route(k) == null:
				keys[k] = true
		for op: Dictionary in p["pending"]:
			if op["target"].has("setting") and _route(op["target"]["setting"]) == null:
				keys[op["target"]["setting"]] = true
	else:
		for k: String in _s["partitions"][LOCAL_PARTITION]["device"]:
			if _route(k) == null:
				keys[k] = true
	for k: String in _drafts:
		if _route(k) == null:
			keys[k] = true
	return keys.keys()


func _value_map() -> Dictionary:
	var m := {}
	for r: Dictionary in _catalog["settings"]:
		if r["route"] == "synced" or r["route"] == "local":
			m[r["key"]] = get_value(r["key"])["value"]
	for k: String in _open_keys():
		m[k] = get_value(k)["value"]
	return m


func _emit_changes(before: Dictionary, overrides: Dictionary, origin: String) -> void:
	var after := _value_map()
	var groups := {}
	var all: Array = before.keys()
	for k: String in after:
		if not before.has(k):
			all.append(k)
	for k: String in all:
		# A key known on one side only read as the document's value on the other.
		var was: Variant = before[k] if before.has(k) else _document["values"].get(k)
		var is_: Variant = after[k] if after.has(k) else get_value(k)["value"]
		if Types.json_equal(was, is_):
			continue
		var o: String = overrides.get(k, origin)
		if not groups.has(o):
			groups[o] = []
		groups[o].append(k)
	for o: String in ["local", "remote", "merge", "migration"]:
		if groups.has(o):
			_events.append({"type": "change", "keys": _sorted(groups[o]), "origin": o})


## `set` and `clear`, journalling nothing on a refusal: a declared `secret` or `flag` is
## `bad_request`; a catalog lock or a lock in the current document is `managed_by_admin`; a value
## that fails the key's schema, or is over `SYNC_MAX_VALUE_BYTES`, is `bad_request`. A `local` key
## is written to `deviceLocal`; anything else is drafted, an undeclared key as an open setting.
func _edit(key: String, change: Dictionary) -> Dictionary:
	var r: Variant = _route(key)
	var rr := String(r["route"]) if r != null else ""
	if r != null and rr == "refused":
		return Types.fail("bad_request")
	if (r != null and rr == "locked") or _locked(key):
		return Types.fail("managed_by_admin")
	if not _truthy(change, "clear"):
		var value: Variant = change["value"]
		if r != null and rr == "synced" and not value_valid(value, r.get("schema")):
			return Types.fail("bad_request")
		if json_bytes(value) > PKeyConstants.SYNC_MAX_VALUE_BYTES:
			return Types.fail("bad_request")
	var before := _value_map()
	if r != null and rr == "local":
		if _truthy(change, "clear"):
			_s["deviceLocal"].erase(key)
		else:
			_s["deviceLocal"][key] = Types.clone(change["value"])
		_emit_changes(before, {}, "local")
		return Types.ok()
	var draft := _merged(change, {"editedHlc": _tick_hlc()})
	if not _s["contacted"]:
		draft["preContact"] = true
	draft["due"] = _now + PKeyConstants.SYNC_DEBOUNCE_MS
	_drafts[key] = draft
	_emit_changes(before, {}, "local")
	return Types.ok()


func _commit_all_drafts() -> void:
	for k: String in _sorted(_drafts.keys()):
		_commit_draft(k)


func _commit_draft(key: String) -> void:
	var d: Variant = _drafts.get(key)
	if d == null:
		return
	var policy := _policy_of(key)
	var marks := {"preContact": true} if _truthy(d, "preContact") else {}
	if _s["subject"] == null:
		# The local partition keeps one value per key, its policy already applied.
		var local: Dictionary = _s["partitions"][LOCAL_PARTITION]
		var prior: Variant = local["device"].get(key)
		_drafts.erase(key)
		if _truthy(d, "clear"):
			local["device"][key] = _merged({"cleared": true, "editedHlc": d["editedHlc"]}, marks)
		else:
			var base: Variant = prior.get("value") if prior != null and not _truthy(prior, "cleared") else Types.ABSENT
			var value: Variant
			if policy == "merge":
				value = Types.clone(d.get("value"))
			else:
				value = apply_setting_op(policy, base, {"op": "set", "value": d.get("value")})
			local["device"][key] = _merged({"value": value, "editedHlc": d["editedHlc"]}, marks)
		return
	var p := _active()
	_drafts.erase(key)
	_drop_parked_by_local_edit(p, key)
	if _truthy(d, "clear"):
		_enqueue(p, _merged({"target": _target_of(key), "op": "clear", "editedHlc": d["editedHlc"]}, marks))
		return
	_enqueue_setting(p, key, d.get("value"), d["editedHlc"], marks)


## Journal a whole value for `key`: one `set`, or, for a `merge` key, one member operation per
## member that differs from the current view (the view without this edit).
func _enqueue_setting(p: Dictionary, key: String, value: Variant, edited_hlc: String, marks: Dictionary) -> void:
	var target := _target_of(key)
	if _policy_of(key) != "merge" or not (value is Dictionary):
		_enqueue(p, _merged({"target": target, "op": "set", "value": Types.clone(value), "editedHlc": edited_hlc}, marks))
		return
	var layer: Variant = null if _s["subject"] == null else _layer(key)
	var current: Variant = layer["value"] if layer != null else null
	var cur: Dictionary = current if current is Dictionary else {}
	var val: Dictionary = value
	for member: String in _sorted(val.keys()):
		if not cur.has(member) or not Types.json_equal(cur[member], val[member]):
			_enqueue(p, _merged({
				"target": target,
				"op": "setMember",
				"member": member,
				"value": Types.clone(val[member]),
				"editedHlc": edited_hlc,
			}, marks))
	for member: String in _sorted(cur.keys()):
		if not val.has(member):
			_enqueue(p, _merged({"target": target, "op": "removeMember", "member": member, "editedHlc": edited_hlc}, marks))


func _enqueue(p: Dictionary, op: Dictionary) -> Dictionary:
	var full := {"mutationId": p["nextMutationId"]}
	full.merge(op, true)
	p["nextMutationId"] += 1
	p["pending"].append(full)
	return full


## A newer local edit of a `lastWrite` or `merge` key replaces its parked edits (R5). A `max` or
## `min` key keeps them: the server decides by value, so the older edit may still win.
func _drop_parked_by_local_edit(p: Dictionary, key: String) -> void:
	var pol := _policy_of(key)
	if pol != "lastWrite" and pol != "merge":
		return
	var target := _alias(key)
	var keep: Array = []
	for o: Dictionary in p["pending"]:
		if not (_truthy(o, "parked") and o["target"].has("setting") and _alias(o["target"]["setting"]) == target):
			keep.append(o)
	p["pending"] = keep


## Re-send parked edits as NEW mutations with their original clock (a processed mutationId is
## never resent).
func _unpark(p: Dictionary, which: Callable) -> void:
	var parked: Array = []
	var keep: Array = []
	for o: Dictionary in p["pending"]:
		if _truthy(o, "parked") and which.call(String(o["parked"])):
			parked.append(o)
		else:
			keep.append(o)
	if parked.is_empty():
		return
	p["pending"] = keep
	for o: Dictionary in parked:
		var op := {}
		for k in o:
			if k != "mutationId" and k != "parked":
				op[k] = o[k]
		_enqueue(p, op)


func _union_op(collection: String, record_id: String, element: Variant, op: String) -> Dictionary:
	var decl: Variant = _collection(collection)
	if decl == null or decl["policy"] != "union":
		return Types.fail("collection-unknown")
	if _s["subject"] == null:
		return Types.fail("signed-out")
	var p := _active()
	var target := {"record": [collection, record_id]}
	if op == "add":
		_enqueue(p, {"target": target, "op": op, "element": Types.clone(element)})
	else:
		_enqueue(p, {"target": target, "op": op, "element": Types.clone(element), "observedSeq": p["cursor"]})
	_kick()
	return Types.ok()


func _in_flight_touches(rk: String) -> bool:
	var f: Variant = _in_flight
	if f == null or f["kind"] != "push":
		return false
	var p: Variant = _s["partitions"].get(f["partition"])
	if p == null:
		return false
	for o: Dictionary in p["pending"]:
		if f["mutationIds"].has(o["mutationId"]) and o["target"].has("record") and _rk_of(o["target"]) == rk:
			return true
	return false


## Send the next request, if one is due and allowed.
func _kick() -> void:
	if _in_flight != null or _s["subject"] == null or (_s["blocked"] != null and String(_s["blocked"]) != ""):
		return
	if _network != "online":
		return
	# Pinned out or locked: nothing is sent, pulled or read, and the journal waits.
	if not _may_talk():
		return
	var name: String = _s["subject"]
	var p := _active()
	# E2E: a push waits for the Worker to be confirmed `e2e` this session, by discovery or by a
	# pull. A pull carries nothing of ours.
	var unconfirmed: bool = _requires_e2e() and _advertised != "e2e"
	if not _s["contacted"] or _need_snapshot or unconfirmed:
		var cursor: int = 0 if _need_snapshot else p["cursor"]
		_in_flight = {"kind": "pull", "partition": name, "cursor": cursor, "mutationIds": []}
		_outbox.append({"method": "GET", "path": _pull_path(p, cursor)})
		return
	var batch: Array = []
	for o: Dictionary in p["pending"]:
		if not _truthy(o, "parked"):
			batch.append(o)
	batch = batch.slice(0, PKeyConstants.SYNC_MAX_MUTATIONS)
	if not batch.is_empty():
		var ids: Array = []
		var muts: Array = []
		for o: Dictionary in batch:
			ids.append(o["mutationId"])
			muts.append(_send_form(p, o))
		_in_flight = {"kind": "push", "partition": name, "cursor": p["cursor"], "mutationIds": ids}
		_outbox.append({
			"method": "POST",
			"path": "/%s/sync/ops" % _product,
			"body": {"clientId": p["clientId"], "cursor": p["cursor"], "atomic": false, "mutations": muts},
		})
		return
	if _signing_out != null:
		_leave("signOut", _signing_out["discard"])
		return
	if _pull_wanted:
		_in_flight = {"kind": "pull", "partition": name, "cursor": p["cursor"], "mutationIds": []}
		_outbox.append({"method": "GET", "path": _pull_path(p, p["cursor"])})


func _pull_path(p: Dictionary, cursor: int) -> String:
	return "/%s/sync?cursor=%d&clientId=%s" % [_product, cursor, p["clientId"]]


## The wire form of a pending operation. In E2E mode a `max`/`min` setting is a compare-and-swap
## register on the server, so its `set` names the version it was made against.
func _send_form(p: Dictionary, op: Dictionary) -> Dictionary:
	var wire := wire_of(op)
	if _requires_e2e() and wire["op"] == "set" and not wire.has("baseVersion") and wire["target"].has("setting") \
			and _client_decides(_policy_of(wire["target"]["setting"])):
		var row: Variant = p["settings"].get(_alias(wire["target"]["setting"]))
		wire["baseVersion"] = row["version"] if row != null else "*"
	return wire


## `max` and `min` are decided by the client in E2E mode.
func _client_decides(policy: String) -> bool:
	return _requires_e2e() and (policy == "max" or policy == "min")


## Sign-out, and every principal change handled like it.
func _leave(reason: String, discard: bool) -> void:
	var name: Variant = _s["subject"]
	if name == null:
		return
	_commit_all_drafts()
	var before := _value_map()
	var p := _active()
	var unsynced: int = p["pending"].size() + p["held"].size()
	if discard:
		p["pending"] = []
		p["held"] = {}
	if _on_sign_out == "clear" or reason != "signOut":
		p["settings"] = {}
		p["records"] = {}
		p["cursor"] = 0
	p["signedOutAt"] = _now
	_s["subject"] = null
	_signing_out = null
	_in_flight = null
	_need_snapshot = false
	_pull_wanted = false
	_events.append({"type": "signedOut", "reason": reason, "unsynced": unsynced})
	if unsynced > 0 and not discard:
		_events.append({"type": "unsyncedData", "count": unsynced})
	_emit_changes(before, {}, "remote")


func _expire_partitions() -> void:
	for name: String in _s["partitions"].keys():
		if name == LOCAL_PARTITION or name == _s["subject"]:
			continue
		var p: Dictionary = _s["partitions"][name]
		if p["signedOutAt"] != null and _now - int(p["signedOutAt"]) >= PKeyConstants.SYNC_PENDING_DAYS * Types.DAY_MS:
			_s["partitions"].erase(name)


## Relaunch: persist, then restore with the same host options (`lost` drops the journal; the
## device binding, `subject`, is device state and survives, and so does the `config.local` store
## behind `deviceLocal`).
static func relaunch(machine: Object, opts: Dictionary, journal_mode: String = "kept") -> Object:
	var saved: Dictionary = machine.persist()
	var script: GDScript = machine.get_script()
	var o := opts.duplicate()
	o["now"] = machine.now()
	o["network"] = machine.network_state()
	if journal_mode == "lost":
		o["offsetMs"] = 0
		o["contacted"] = false
		o["subject"] = saved["subject"]
		o["deviceLocal"] = saved["deviceLocal"]
		o["imported"] = saved["imported"]
		return script.new(o)
	return script.new(o, saved)
