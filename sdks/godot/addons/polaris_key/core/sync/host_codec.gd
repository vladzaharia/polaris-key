@tool
class_name PKeySyncHostCodec
extends "res://addons/polaris_key/services/cloud_sync/codec_port.gd"
## The host codec boundary of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 §13.10, §13.10.7), the
## real codec behind the host's `codec_port.gd` seam (U-21.8). Port of `host_codec.py` and client-core's
## `hostCodec.ts`, with every SEC-SYNC-HOST fix, over `PKeySyncRing.codec`.
##
## The machine speaks plaintext. This is the one place a host turns its requests into sealed ones
## (`seal_push`) and the Worker's answers into plaintext plus the typed open result the machine trusts
## (`open_pull`). The rules, each with a test in `tests/suite_sync_host_codec.gd` that fails on the
## naive version:
##
##   HC-1  a result list that repeats a `mutationId` fails the whole answer closed (`1` and `1.0` are one
##         id, `1` and `true` are two); a conflict's server copy opens only for a mutation of the request.
##   HC-2  `sealed`, `invalid`, `seq` and `ct` members of a served body are removed, never read: the
##         opened result comes only from this module's own open, and `seq` is the change's `version`,
##         set on plaintext rows only.
##   HC-3  renames come from the app: a served `aliases` map is replaced by the app's, and a result's
##         `renamedTo` stays only when the app declares it for that mutation's setting.
##   HC-4  a name holding U+0000 is refused, on push and on pull. A `String` cannot hold NUL, so names
##         that can (the opened `k` of an envelope, a merge member's `setting NUL member`) are compared
##         as UTF-8 bytes.
##   HC-5  a `ct` that does not open is `invalid` and its row has no value; a blinded name is accepted
##         only when the `k` inside the envelope re-blinds to it; a merge member only when it is under
##         the setting's prefix, re-blinds, and appears once.
##   HC-6  a locked codec seals nothing and opens nothing; a mutation that cannot be sealed (a field or
##         element name that is empty or holds U+0000, an element or value canonical JSON refuses, a
##         member op on an open key) sends nothing, and a half-valid batch returns nothing.
##
## Results are Dictionaries, never exceptions: `{"ok": false, "code": <error code>}` (`sync-locked`,
## `invalid-options`, `sync-failed`) means nothing is sent or delivered. No value, root or key is in
## any result's message (there is none).
##
## Scope: the `$settings` collection and records of every shape (C-26 / U-46). A record's collection
## travels in the clear and its id, field and element names only blinded (`blind("record" | "field" |
## "element", c, name)`). Every sealed record value shares `K_coll(c)`, so the envelope's `k` places it:
##
##   value    k = id                              wire name blind("record", c, id)
##   field    k = id U+0000 field                 and blind("field", c, field)
##   element  k = id U+0000 canonicalJson(e)      and blind("element", c, canonicalJson(e))
##
## A pulled record opens only when the id is blinded and the `k` inside every envelope re-blinds to the
## names the row came under, so a Worker cannot place a sealed value under another record, field or
## element. A conflict copy carries no names and opens under the mutation's own record.

const Types := preload("res://addons/polaris_key/core/sync/cloud_sync_types.gd")
const SETTINGS_COLLECTION := "$settings"
const _STRIP := ["sealed", "invalid", "seq", "ct"]

var _ring: PKeySyncRing


## `ring` is the key ring whose `codec` seals and opens; `locked()` follows it.
func _init(ring: PKeySyncRing = null) -> void:
	_ring = ring


func locked() -> bool:
	return _ring == null or _ring.codec.locked()


func attach(listener: Callable) -> Callable:
	if _ring == null:
		return func() -> void: pass
	return _ring.attach(listener)


## The id a record travels under (§13.10.2): blinded under the root. "" while locked.
func blind_record(collection: String, id: String) -> String:
	return _ring.codec.blind("record", collection, id) if _ring != null else ""


## Counts every change of the held root (see ring.gd); 0 without a ring.
func root_generation() -> int:
	return _ring.codec.generation() if _ring != null else 0


## Hands the current root to `fn` (a Callable(root) -> Variant); null while locked.
func with_root(fn: Callable) -> Variant:
	return _ring.codec.with_root(fn) if _ring != null else null


func seal_push(body: Dictionary, routes: Array) -> Dictionary:
	return seal_push_with(body, _ring.codec if _ring != null else null, routes)


func open_pull(body: Dictionary, mutations: Variant, aliases: Variant, open_keys: Array, record_keys: Array = []) -> Dictionary:
	return open_pull_with(body, _ring.codec if _ring != null else null, mutations, aliases, open_keys, record_keys)


# ── Push ─────────────────────────────────────────────────────────────────────────────────────

## Seals a push body with `codec` (the ring's codec, or anything with its `locked`, `seal`, `open`,
## `open_any` and `blind`). `routes` is the catalog's setting list: a key it names is declared and stays
## in the clear; any other key is an open setting and is blinded. The body is not changed. `{ok: true,
## body}` or `{ok: false, code}`.
static func seal_push_with(body: Dictionary, codec: Object, routes: Array) -> Dictionary:
	if codec == null or codec.locked():
		return _fail(PKeyConstants.ErrorCode.SYNC_LOCKED)
	if not (body.get("mutations") is Array):
		return {"ok": true, "body": body}
	var declared := {}
	for r in routes:
		if r is Dictionary and r.get("key") is String:
			declared[r["key"]] = true
	var out_mutations: Array = []
	for m in body["mutations"]:
		if not (m is Dictionary):
			return _refuse()
		var s := _seal_mutation(m, codec, declared)
		if not s["ok"]:
			return s
		out_mutations.append(s["mutation"])
	var out := body.duplicate()
	out["mutations"] = out_mutations
	return {"ok": true, "body": out}


static func _seal_mutation(m: Dictionary, codec: Object, declared: Dictionary) -> Dictionary:
	var target: Variant = m.get("target")
	if target is Dictionary and target.has("record"):
		return _seal_record_mutation(m, target, codec)
	if not (target is Dictionary) or not (target.get("setting") is String):
		return _refuse()
	if m.has("ct") or m.has("field") or m.has("element"):
		return _refuse()
	var setting: String = target["setting"]
	var member: Variant = m.get("member")
	if _has_nul(setting) or (member is String and _has_nul(member)) or (m.has("member") and not (member is String)):
		return _refuse()
	var open_key := not declared.has(setting)
	var out := m.duplicate()
	if open_key:
		var t: Dictionary = (target as Dictionary).duplicate()
		var blinded: String = codec.blind("setting", SETTINGS_COLLECTION, setting)
		if blinded == "":
			return _refuse()
		t["setting"] = blinded
		out["target"] = t
	match m.get("op"):
		"set":
			if not m.has("value") or m.has("member"):
				return _refuse()
			out.erase("value")
			var env: PackedByteArray = codec.seal(SETTINGS_COLLECTION, setting, m["value"])
			if env.is_empty():
				return _refuse()
			out["ct"] = PKeyB64Url.encode(env)
		"setMember":
			if open_key or not (member is String) or not m.has("value"):
				return _refuse()
			out.erase("value")
			out["member"] = codec.blind("member", setting, member)
			var env: PackedByteArray = codec.seal(SETTINGS_COLLECTION, PKeySyncEnvelope.member_name(setting, member), m["value"])
			if env.is_empty() or out["member"] == "":
				return _refuse()
			out["ct"] = PKeyB64Url.encode(env)
		"removeMember":
			if open_key or not (member is String) or m.has("value"):
				return _refuse()
			out["member"] = codec.blind("member", setting, member)
			if out["member"] == "":
				return _refuse()
		"clear":
			if m.has("value") or m.has("member"):
				return _refuse()
		_:
			return _refuse()
	return {"ok": true, "mutation": out}


## The envelope name of a record field: the id, U+0000, the field.
static func field_name(record_id: String, field: String) -> PackedByteArray:
	return PKeySyncEnvelope.member_name(record_id, field)


## The envelope name of a union element: the id, U+0000, the element's canonical JSON.
static func element_name(record_id: String, canonical: String) -> PackedByteArray:
	return PKeySyncEnvelope.member_name(record_id, canonical)


## A record mutation (V5 section 13.10.4). `set` seals the value under `k = id`; `setField` under
## `id U+0000 field`; `add` seals the element under `id U+0000 canonicalJson(e)`. `delete`,
## `removeField` and `remove` carry no value. Every name goes blinded, the collection in the clear.
static func _seal_record_mutation(m: Dictionary, target: Dictionary, codec: Object) -> Dictionary:
	var ref: Variant = _record_ref(target.get("record"))
	if ref == null or m.has("ct"):
		return _refuse()
	var collection: String = ref[0]
	var id: String = ref[1]
	var out := m.duplicate()
	var op: Variant = m.get("op")
	match op:
		"set":
			if not m.has("value") or _has_any(m, ["field", "element", "member"]):
				return _refuse()
			out.erase("value")
			var env: PackedByteArray = codec.seal(collection, id, m["value"])
			if env.is_empty():
				return _refuse()
			out["ct"] = PKeyB64Url.encode(env)
		"delete":
			if _has_any(m, ["value", "field", "element", "member"]):
				return _refuse()
		"setField":
			var f: Variant = _field_of(m)
			if f == null or not m.has("value") or _has_any(m, ["element", "member"]):
				return _refuse()
			out.erase("value")
			out["field"] = codec.blind("field", collection, f)
			var env: PackedByteArray = codec.seal(collection, field_name(id, f), m["value"])
			if env.is_empty() or out["field"] == "":
				return _refuse()
			out["ct"] = PKeyB64Url.encode(env)
		"removeField":
			var f2: Variant = _field_of(m)
			if f2 == null or _has_any(m, ["value", "element", "member"]):
				return _refuse()
			out["field"] = codec.blind("field", collection, f2)
			if out["field"] == "":
				return _refuse()
		"add":
			if not m.has("element") or _has_any(m, ["value", "field", "member"]):
				return _refuse()
			var canon: Variant = _canonical(m["element"])
			if canon == null:
				return _refuse()
			out["element"] = codec.blind("element", collection, canon)
			var env: PackedByteArray = codec.seal(collection, element_name(id, canon), m["element"])
			if env.is_empty() or out["element"] == "":
				return _refuse()
			out["ct"] = PKeyB64Url.encode(env)
		"remove":
			if not m.has("element") or _has_any(m, ["value", "field", "member"]):
				return _refuse()
			var canon2: Variant = _canonical(m["element"])
			if canon2 == null:
				return _refuse()
			out["element"] = codec.blind("element", collection, canon2)
			if out["element"] == "":
				return _refuse()
		_:
			return _refuse()
	var blinded: String = codec.blind("record", collection, id)
	if blinded == "":
		return _refuse()
	var t := target.duplicate()
	t["record"] = [collection, blinded]
	out["target"] = t
	return {"ok": true, "mutation": out}


static func _has_any(m: Dictionary, names: Array) -> bool:
	for n: String in names:
		if m.has(n):
			return true
	return false


## The field of a `setField` / `removeField`: a non-empty String with no U+0000, else null.
static func _field_of(m: Dictionary) -> Variant:
	var f: Variant = m.get("field")
	if not (f is String) or f == "" or _has_nul(f):
		return null
	return f


## The canonical JSON of an element, or null when canonical JSON refuses it.
static func _canonical(e: Variant) -> Variant:
	var r := PKeySyncCanonicalJson.canonicalize_value(e)
	return r["canonical"] if r["ok"] else null


## `[collection, id]` when `v` is a pair of non-empty strings that can name a record: no U+0000 (the blind
## input has no length prefix) and not the settings collection's namespace (`$`), or null.
static func _record_ref(v: Variant) -> Variant:
	if not (v is Array) or (v as Array).size() != 2:
		return null
	var c: Variant = v[0]
	var id: Variant = v[1]
	if not (c is String) or not (id is String) or c == "" or id == "" or _has_nul(c) or _has_nul(id) or (c as String).begins_with("$"):
		return null
	return [c, id]


# ── Pull ─────────────────────────────────────────────────────────────────────────────────────

## Opens a pull or push answer: `{ok: true, body, opened}` or `{ok: false, code}` (locked, or an answer
## that repeats a `mutationId`: nothing is delivered). `mutations` are the plaintext mutations of the
## request the answer belongs to (a conflict's server copy carries no name, so it opens against the
## mutation's own setting); `aliases` are the renames the app declares, never taken from the body;
## `open_keys` are the open-setting keys the machine already holds (a tombstone names a key blinded,
## and only these can be mapped back); `record_keys` are the `[collection, id]` pairs of the records the
## machine already holds (a record tombstone names its id blinded, likewise). `opened` is `{changes: [row|null], conflicts: {mutationId: row}}`
## with a row of `{seq}`, `{sealed: true}`, `{invalid: true}` or `{}`.
static func open_pull_with(body: Dictionary, codec: Object, mutations: Variant, aliases: Variant, open_keys: Array, record_keys: Array = []) -> Dictionary:
	if codec == null or codec.locked():
		return _fail(PKeyConstants.ErrorCode.SYNC_LOCKED)
	var app_aliases: Dictionary = aliases if aliases is Dictionary else {}
	var out := body.duplicate()
	var opened := {}

	if body.get("changes") is Array:
		var changes: Array = []
		var rows: Array = []
		for c in body["changes"]:
			if not (c is Dictionary):
				changes.append(c)
				rows.append(null)
				continue
			var pair := _open_change(c, codec, app_aliases, record_keys)
			changes.append(pair[0])
			rows.append(pair[1])
		out["changes"] = changes
		opened["changes"] = rows

	if body.get("tombstones") is Array:
		var names := _open_key_names(codec, open_keys)
		var records := _record_key_names(codec, record_keys)
		var tombs: Array = []
		for t in body["tombstones"]:
			if t is Dictionary and t.get("setting") is String and names.has(t["setting"]):
				var u: Dictionary = (t as Dictionary).duplicate()
				u["setting"] = names[t["setting"]]
				tombs.append(u)
			elif t is Dictionary and _record_ref_served(t.get("record")) != null and records.has(_record_ref_served(t["record"])):
				var u: Dictionary = (t as Dictionary).duplicate()
				u["record"] = [t["record"][0], records[_record_ref_served(t["record"])]]
				tombs.append(u)
			else:
				tombs.append(t)
		out["tombstones"] = tombs

	# Renames come from the app only; a served map or `renamedTo` could swap values between keys.
	if body.has("aliases"):
		out["aliases"] = app_aliases.duplicate()

	if body.get("results") is Array:
		var results: Array = []
		var seen := {}
		var conflicts := {}
		for r in body["results"]:
			if not (r is Dictionary):
				results.append(r)
				continue
			# One verdict per mutation: a second result for an id would overwrite the first verdict in
			# `conflicts` while the machine reads the first body entry. Fail closed.
			var key := _id_key(r.get("mutationId"))
			if seen.has(key):
				return _fail(PKeyConstants.ErrorCode.SYNC_FAILED)
			seen[key] = true
			var clean := _stripped(r)
			if clean.has("renamedTo"):
				var frm: Variant = _conflict_setting(mutations, r.get("mutationId"))
				if frm == null or app_aliases.get(frm) != clean["renamedTo"]:
					clean.erase("renamedTo")
			if r.get("status") == "conflict" and r.get("server") is Dictionary:
				var mid: Variant = r.get("mutationId")
				var expect: Variant = _conflict_setting(mutations, mid)
				var rec: Variant = _conflict_record(mutations, mid)
				# Only a conflict for a mutation of this request opens: without one there is no name to
				# open against and the copy reads as invalid.
				var pair := _open_record_copy(r["server"], rec, codec) if rec != null else _open_copy(r["server"], expect, codec, app_aliases)
				clean["server"] = pair[0]
				if _is_whole(mid):
					conflicts[int(mid)] = pair[1]
			results.append(clean)
		out["results"] = results
		if not conflicts.is_empty():
			opened["conflicts"] = conflicts

	for k in _STRIP:
		out.erase(k)
	return {"ok": true, "body": out, "opened": opened}


## The plaintext setting name of mutation `mid`, or null when the host did not say.
static func _conflict_setting(ms: Variant, mid: Variant) -> Variant:
	if not _is_whole(mid) or not (ms is Array):
		return null
	for m in ms:
		if m is Dictionary and _is_whole(m.get("mutationId")) and int(m["mutationId"]) == int(mid):
			var target: Variant = m.get("target")
			if target is Dictionary and target.get("setting") is String:
				return target["setting"]
			return null
	return null


## The `[collection, id]` of record mutation `mid`, or null when the host did not say.
static func _conflict_record(ms: Variant, mid: Variant) -> Variant:
	if not _is_whole(mid) or not (ms is Array):
		return null
	for m in ms:
		if m is Dictionary and _is_whole(m.get("mutationId")) and int(m["mutationId"]) == int(mid):
			var target: Variant = m.get("target")
			if target is Dictionary:
				return _record_ref(target.get("record"))
			return null
	return null


## The lookup key of a served `[collection, blinded id]`, or null when it is not a pair of strings.
static func _record_ref_served(v: Variant) -> Variant:
	if v is Array and (v as Array).size() == 2 and v[0] is String and v[1] is String:
		return JSON.stringify([v[0], v[1]])
	return null


## Blinded record id (with its collection) to plaintext id, for the records the machine holds.
static func _record_key_names(codec: Object, keys: Array) -> Dictionary:
	var out := {}
	for k in keys:
		var ref: Variant = _record_ref(k)
		if ref != null:
			out[JSON.stringify([ref[0], codec.blind("record", ref[0], ref[1])])] = ref[1]
	return out


static func _open_key_names(codec: Object, keys: Array) -> Dictionary:
	var out := {}
	for k in keys:
		out[codec.blind("setting", SETTINGS_COLLECTION, String(k))] = String(k)
	return out


static func _aliases_of(name: String, aliases: Dictionary) -> Array:
	var out: Array = []
	for frm in aliases:
		if aliases[frm] == name:
			out.append(frm)
	return out


static func _stripped(e: Dictionary) -> Dictionary:
	var out := e.duplicate()
	for k in _STRIP:
		out.erase(k)
	return out


static func _invalid_row(e: Dictionary) -> Array:
	var out := _stripped(e)
	out.erase("value")
	out.erase("members")
	out.erase("fields")
	out.erase("elements")
	return [out, {"invalid": true}]


static func _plain_row(e: Dictionary) -> Array:
	# Sealed cells with no `ct` are not a plaintext row: only the host's open can read them.
	if e.get("fields") is Array or e.get("elements") is Array:
		return _invalid_row(e)
	var v: Variant = e.get("version")
	return [_stripped(e), {"seq": v} if Types.is_number(v) else {}]


static func _open_change(c: Dictionary, codec: Object, aliases: Dictionary, record_keys: Array = []) -> Array:
	if c.get("setting") is String:
		return _open_setting_change(c, codec, aliases)
	if c.has("record"):
		return _open_record_change(c, codec, record_keys)
	# Neither a setting nor a record: a sealed one cannot be placed.
	if c.has("ct"):
		return _invalid_row(c)
	return _plain_row(c)


## The sealed shape of a record row: "ct", "fields", "elements", "plain" (none), or "" (more than one).
static func _shape(e: Dictionary) -> String:
	var shapes: Array = []
	if e.has("ct"):
		shapes.append("ct")
	if e.get("fields") is Array:
		shapes.append("fields")
	if e.get("elements") is Array:
		shapes.append("elements")
	if shapes.is_empty():
		return "plain"
	return shapes[0] if shapes.size() == 1 else ""


static func _sealed_record(e: Dictionary, record: Array, value: Variant) -> Array:
	var entry := _stripped(e)
	entry.erase("fields")
	entry.erase("elements")
	entry["record"] = record
	entry["value"] = value
	return [entry, {"sealed": true}]


## A record change. A plaintext row is legacy (the machine judges its `seq`, section 13.10.7). A sealed
## one needs a blinded id and opens only when every envelope's `k` re-blinds to the names the row came
## under; the row then carries the plaintext id and the opened value (a `merge` record's object, a
## `union` record's array in the served order) (HC-5).
static func _open_record_change(c: Dictionary, codec: Object, record_keys: Array = []) -> Array:
	var shape := _shape(c)
	if shape == "plain":
		return _plain_row(c)
	var ref: Variant = _record_ref(c.get("record"))
	if shape == "" or ref == null or not PKeySyncBlind.is_blinded_name(ref[1]):
		return _invalid_row(c)
	var collection: String = ref[0]
	var served: String = ref[1]
	if shape == "ct":
		var env: Variant = _from_ct(c["ct"])
		if env == null:
			return _invalid_row(c)
		var r: Dictionary = codec.open_any(collection, env)
		if not r["ok"] or (r["name_bytes"] as PackedByteArray).has(0):
			return _invalid_row(c)
		var id: String = r["name"]
		if id == "" or codec.blind("record", collection, id) != served:
			return _invalid_row(c)
		return _sealed_record(c, [collection, id], r["value"])
	var cells: Variant = _open_cells(c, shape, collection, null, codec)
	if cells == null:
		return _invalid_row(c)
	var rid: Variant = cells["id"]
	if rid == null:
		# No cell names the record, so the id comes from a record the machine holds, if any.
		rid = _record_key_names(codec, record_keys).get(JSON.stringify([collection, served]))
	elif codec.blind("record", collection, rid) != served:
		return _invalid_row(c)
	return _sealed_record(c, [collection, rid if rid != null else served], cells["value"])


## A conflict's server copy of the record `rec` (`[collection, id]` of the mutation): opened under that
## id. Nothing else is accepted but a plaintext copy.
static func _open_record_copy(e: Dictionary, rec: Variant, codec: Object) -> Array:
	var shape := _shape(e)
	if shape == "plain":
		return _plain_row(e)
	if shape == "":
		return _invalid_row(e)
	var collection: String = rec[0]
	var rid: String = rec[1]
	var value: Variant
	if shape == "ct":
		var env: Variant = _from_ct(e["ct"])
		if env == null:
			return _invalid_row(e)
		var r: Dictionary = codec.open(collection, rid, env, [])
		if not r["ok"]:
			return _invalid_row(e)
		value = r["value"]
	else:
		var cells: Variant = _open_cells(e, shape, collection, rid, codec)
		if cells == null:
			return _invalid_row(e)
		value = cells["value"]
	var entry := _stripped(e)
	entry.erase("fields")
	entry.erase("elements")
	entry["value"] = value
	return [entry, {"sealed": true}]


## Opens the sealed cells of a `merge` record (`fields`) or a `union` record (`elements`). Each envelope's
## `k` splits at its first U+0000 into the id and the cell name; the cell's blinded name must be what the
## row carries (and, for an element, the opened value must spell the name), and every cell must name the
## same id (`expect_id`, when the caller knows it). `{id, value}` (`id` null for a record with no cells), or
## null.
static func _open_cells(e: Dictionary, shape: String, collection: String, expect_id: Variant, codec: Object) -> Variant:
	var kind := "field" if shape == "fields" else "element"
	var rid: Variant = expect_id
	var names := {}
	var fields := {}
	var elements: Array = []
	for cell in e[shape]:
		if not (cell is Dictionary):
			return null
		var wire: Variant = cell.get(kind)
		if not (wire is String) or not PKeySyncBlind.is_blinded_name(wire):
			return null
		var env: Variant = _from_ct(cell.get("ct"))
		if env == null:
			return null
		var r: Dictionary = codec.open_any(collection, env)
		if not r["ok"]:
			return null
		var nb: PackedByteArray = r["name_bytes"]
		var at := nb.find(0)
		if at <= 0:
			return null
		var cell_id := nb.slice(0, at).get_string_from_utf8()
		var rest := nb.slice(at + 1)
		if rest.is_empty() or rest.has(0):
			return null
		var name := rest.get_string_from_utf8()
		if rid != null and cell_id != rid:
			return null
		rid = cell_id
		if codec.blind(kind, collection, name) != wire or names.has(name):
			return null
		names[name] = true
		if kind == "field":
			fields[name] = r["value"]
		else:
			if _canonical(r["value"]) != name:
				return null
			elements.append(r["value"])
	return {"id": rid, "value": fields if kind == "field" else elements}


static func _open_setting_change(c: Dictionary, codec: Object, aliases: Dictionary) -> Array:
	var served: String = c["setting"]
	if _has_nul(served):
		return _invalid_row(c)
	if not c.has("ct") and not (c.get("members") is Array):
		return _plain_row(c)
	if PKeySyncBlind.is_blinded_name(served):
		# An open key: the name is inside the envelope and must re-blind to the served name.
		if not c.has("ct"):
			return _invalid_row(c)
		var env: Variant = _from_ct(c["ct"])
		if env == null:
			return _invalid_row(c)
		var r: Dictionary = codec.open_any(SETTINGS_COLLECTION, env)
		if not r["ok"] or (r["name_bytes"] as PackedByteArray).has(0):
			return _invalid_row(c)
		var name: String = r["name"]
		if codec.blind("setting", SETTINGS_COLLECTION, name) != served:
			return _invalid_row(c)
		var entry := _stripped(c)
		entry["setting"] = name
		entry["value"] = r["value"]
		return [entry, {"sealed": true}]
	return _open_copy(c, served, codec, aliases)


## Opens a row (or a conflict's server copy) whose setting name is `name`: one `ct`, or a merge
## setting's sealed `members`. `name` null (a conflict the host cannot place) reads as invalid.
static func _open_copy(e: Dictionary, name: Variant, codec: Object, aliases: Dictionary) -> Array:
	var has_ct := e.has("ct")
	var members: Variant = e.get("members")
	if not has_ct and not (members is Array):
		# Plaintext: legacy only if the machine finds its `seq` below `encryptionSince`.
		return _plain_row(e)
	if not (name is String) or _has_nul(name):
		return _invalid_row(e)
	var setting: String = name
	if has_ct:
		var env: Variant = _from_ct(e["ct"])
		if env == null:
			return _invalid_row(e)
		var r: Dictionary = codec.open(SETTINGS_COLLECTION, setting, env, _aliases_of(setting, aliases))
		if not r["ok"]:
			return _invalid_row(e)
		var entry := _stripped(e)
		entry.erase("members")
		entry["value"] = r["value"]
		return [entry, {"sealed": true}]
	var value := {}
	var prefix := setting.to_utf8_buffer()
	prefix.append(0)
	for m in members:
		if not (m is Dictionary) or not (m.get("member") is String):
			return _invalid_row(e)
		var env: Variant = _from_ct(m.get("ct"))
		if env == null or not PKeySyncBlind.is_blinded_name(m["member"]):
			return _invalid_row(e)
		var r: Dictionary = codec.open_any(SETTINGS_COLLECTION, env)
		if not r["ok"]:
			return _invalid_row(e)
		var nb: PackedByteArray = r["name_bytes"]
		if nb.size() <= prefix.size() or nb.slice(0, prefix.size()) != prefix:
			return _invalid_row(e)
		var member_bytes := nb.slice(prefix.size())
		if member_bytes.has(0):
			return _invalid_row(e)
		var member := member_bytes.get_string_from_utf8()
		if codec.blind("member", setting, member) != m["member"]:
			return _invalid_row(e)
		if value.has(member):
			return _invalid_row(e)
		value[member] = r["value"]
	var entry := _stripped(e)
	entry.erase("members")
	entry["value"] = value
	return [entry, {"sealed": true}]


# ── helpers ──────────────────────────────────────────────────────────────────────────────────

## The blind input has no length prefix (`kind NUL ctx NUL name`), so a name holding a NUL could
## collide with another (setting, member) pair: no name may hold one. Compared as bytes.
static func _has_nul(s: Variant) -> bool:
	if s is String:
		return (s as String).to_utf8_buffer().has(0)
	if s is PackedByteArray:
		return (s as PackedByteArray).has(0)
	return false


## The envelope of a served `ct`, or null for anything but canonical base64url.
static func _from_ct(ct: Variant) -> Variant:
	if not (ct is String) or ct == "":
		return null
	return PKeyB64Url.decode_strict(ct)


## A whole JSON number that is not a bool (a mutation id).
static func _is_whole(v: Variant) -> bool:
	return Types.is_integer(v) and typeof(v) != TYPE_BOOL


## A hashable identity for a served `mutationId`, as JavaScript's `Set` sees it: `1` and `1.0` are one,
## `1` and `true` are two.
static func _id_key(v: Variant) -> String:
	if typeof(v) == TYPE_BOOL:
		return "b:%s" % v
	if Types.is_number(v):
		return "n:%s" % (str(int(v)) if Types.is_integer(v) else str(v))
	return "j:" + JSON.stringify(v, "", true)


static func _fail(code: String) -> Dictionary:
	return {"ok": false, "code": code}


static func _refuse() -> Dictionary:
	return _fail(PKeyConstants.ErrorCode.INVALID_OPTIONS)
