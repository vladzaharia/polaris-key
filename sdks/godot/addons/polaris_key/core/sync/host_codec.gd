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
##   HC-6  a locked codec seals nothing and opens nothing; a mutation that cannot be sealed (a record
##         mutation, a value canonical JSON refuses, a member op on an open key) sends nothing, and a
##         half-valid batch returns nothing.
##
## Results are Dictionaries, never exceptions: `{"ok": false, "code": <error code>}` (`sync-locked`,
## `invalid-options`, `sync-failed`) means nothing is sent or delivered. No value, root or key is in
## any result's message (there is none).
##
## Scope: the `$settings` collection, and records with a scalar value (D-2: saves are `revision`
## records; U-23.G3). A record value is sealed under its collection with `k = id`, its id travels as
## `blind("record", collection, id)`, and a pulled record opens only when the `k` inside the envelope
## re-blinds to the id on the wire (§13.10.4), so a Worker cannot place a sealed value under another
## record. A record mutation other than `set` and `delete` (a `merge` field, a `union` element), and a
## sealed `merge` or `union` change (`fields`, `elements`), are outside this codec: a mutation is
## refused (`invalid-options`) and a change reads as `invalid`.

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


## A record mutation (scalar value, D-2): `set` seals the value under the collection with `k = id`;
## `delete` carries none. Either sends the id blinded. The collection travels in the clear (§13.10.2).
static func _seal_record_mutation(m: Dictionary, target: Dictionary, codec: Object) -> Dictionary:
	var ref: Variant = _record_ref(target.get("record"))
	if ref == null:
		return _refuse()
	if m.has("ct") or m.has("field") or m.has("element") or m.has("member"):
		return _refuse()
	var collection: String = ref[0]
	var id: String = ref[1]
	var out := m.duplicate()
	match m.get("op"):
		"set":
			if not m.has("value"):
				return _refuse()
			out.erase("value")
			var env: PackedByteArray = codec.seal(collection, id, m["value"])
			if env.is_empty():
				return _refuse()
			out["ct"] = PKeyB64Url.encode(env)
		"delete":
			if m.has("value"):
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
			var pair := _open_change(c, codec, app_aliases)
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
	return [out, {"invalid": true}]


static func _plain_row(e: Dictionary) -> Array:
	var v: Variant = e.get("version")
	return [_stripped(e), {"seq": v} if Types.is_number(v) else {}]


static func _open_change(c: Dictionary, codec: Object, aliases: Dictionary) -> Array:
	if c.get("setting") is String:
		return _open_setting_change(c, codec, aliases)
	if c.has("record"):
		return _open_record_change(c, codec)
	# Neither a setting nor a record: a sealed one cannot be placed.
	if c.has("ct"):
		return _invalid_row(c)
	return _plain_row(c)


## A record change: `{record: [collection, id], ct, version}`. A sealed `merge` or `union` change
## (`fields`, `elements`) is outside the scalar codec and reads as invalid; a plaintext row is legacy
## (the machine checks its `seq` against `encryptionSince`). A sealed id is accepted only when it is
## blinded and the `k` inside the envelope re-blinds to it (HC-5), then it is replaced by the id.
static func _open_record_change(c: Dictionary, codec: Object) -> Array:
	if c.get("fields") is Array or c.get("elements") is Array:
		return _invalid_row(c)
	if not c.has("ct"):
		return _plain_row(c)
	var ref: Variant = _record_ref(c["record"])
	if ref == null or not PKeySyncBlind.is_blinded_name(ref[1]):
		return _invalid_row(c)
	var env: Variant = _from_ct(c["ct"])
	if env == null:
		return _invalid_row(c)
	var r: Dictionary = codec.open_any(ref[0], env)
	if not r["ok"] or (r["name_bytes"] as PackedByteArray).has(0):
		return _invalid_row(c)
	var id: String = r["name"]
	if id == "" or codec.blind("record", ref[0], id) != ref[1]:
		return _invalid_row(c)
	var entry := _stripped(c)
	entry["record"] = [ref[0], id]
	entry["value"] = r["value"]
	return [entry, {"sealed": true}]


## A conflict's server copy of the record `rec` (`[collection, id]` of the mutation): one `ct`, opened
## under that id. Nothing else is accepted but a plaintext copy.
static func _open_record_copy(e: Dictionary, rec: Variant, codec: Object) -> Array:
	if e.get("fields") is Array or e.get("elements") is Array:
		return _invalid_row(e)
	if not e.has("ct"):
		return _plain_row(e)
	var env: Variant = _from_ct(e["ct"])
	if env == null:
		return _invalid_row(e)
	var r: Dictionary = codec.open(rec[0], rec[1], env, [])
	if not r["ok"]:
		return _invalid_row(e)
	var entry := _stripped(e)
	entry["value"] = r["value"]
	return [entry, {"sealed": true}]


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
