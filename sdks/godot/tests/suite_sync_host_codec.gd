extends RefCounted
# The Cloud Sync host codec (U-21.8; WIRE-CONTRACT-V5 section 13.10): what `seal_push` sends, what
# `open_pull` proves, and that the machine only ever takes the host's own open result. Cases are
# client-core's `hostCodec.test.ts` as Python and Swift port them (HostCodecTests). From U-23.G3 the
# record cases (scalar values, D-2; WIRE-CONTRACT-V5 section 13.10.4) are under `_records`. HC-1 to HC-6 each
# name their test below, and each of those fails on the naive version of its rule (the comment says how).
# Mutation-checked (U-21.8): without the locked check HC-6's three checks fail; with a conflict copy opened
# against a default name instead of the mutation's own, 'a conflict with no mutations of the request reads as
# invalid' fails; without the repeated-id check, the re-blind, the NUL byte check, the alias replacement or
# the strip, the HC-1, HC-5, HC-4, HC-3 and HC-2 checks fail.

const Codec := preload("res://addons/polaris_key/core/sync/host_codec.gd")
const Host := preload("res://addons/polaris_key/services/cloud_sync/host.gd")
const C := "$settings"
const VOL := "audio.volume"
const BIND := "input.bindings"
const OPEN := "my.private.key"
const PRODUCT := "diceroll"
const SAVES := "saves"


## A codec over a fixture root with a switch for "locked" and a count of seals: the ring codec's
## surface (`locked`, `seal`, `open`, `open_any`, `blind`), so the rules are tested on their own.
class FixtureCodec:
	extends RefCounted
	var root: PackedByteArray
	var is_locked := false
	var seals := 0

	func _init(p_root: PackedByteArray) -> void:
		root = p_root

	func locked() -> bool:
		return is_locked

	func seal(collection: String, name: Variant, value: Variant) -> PackedByteArray:
		seals += 1
		return PKeySyncEnvelope.seal_value(root, collection, name, value)

	func open(collection: String, name: Variant, envelope: PackedByteArray, aliases: Array = []) -> Dictionary:
		return PKeySyncEnvelope.open_value(root, collection, name, envelope, aliases)

	func open_any(collection: String, envelope: PackedByteArray) -> Dictionary:
		return PKeySyncEnvelope.open_value_any_name(root, collection, envelope)

	func blind(kind: String, ctx: String, name: String) -> String:
		return PKeySyncBlind.blind(root, kind, ctx, name)


var _root := _bytes(32, 3, 7)
var _other_root := _bytes(32, 251, 250)
var _codec: FixtureCodec


static func _bytes(n: int, mul: int, add: int) -> PackedByteArray:
	var b := PackedByteArray()
	for i in n:
		b.append((mul * i + add) & 255)
	return b


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_codec = FixtureCodec.new(_root)
	_push(t)
	_hc6(t)
	_hc4_push(t)
	_pull_basics(t)
	_hc2(t)
	_hc5(t)
	_hc1(t)
	_hc3(t)
	_hc4_pull(t)
	_hc_misc(t)
	_records(t)
	await _into_the_machine(t)
	return true


# ── helpers ──────────────────────────────────────────────────────────────────────────────────

func _env_ct(name: Variant, value: Variant, root := PackedByteArray()) -> String:
	return PKeyB64Url.encode(PKeySyncEnvelope.seal_value(root if not root.is_empty() else _root, C, name, value))


func _bl(kind: String, ctx: String, n: String) -> String:
	return PKeySyncBlind.blind(_root, kind, ctx, n)


func _push_body(mutations: Array) -> Dictionary:
	return {"clientId": "c_x", "cursor": 0, "atomic": false, "mutations": mutations}


func _mset(id: int, setting: String, value: Variant) -> Dictionary:
	return {"mutationId": id, "target": {"setting": setting, "scope": "user"}, "op": "set", "value": value}


func _routes() -> Array:
	return [{"key": VOL}, {"key": BIND}]


func _pull(body: Dictionary, mutations: Variant = [], aliases: Variant = {}, open_keys: Array = [], codec: FixtureCodec = null, record_keys: Array = []) -> Dictionary:
	return Codec.open_pull_with(body, codec if codec != null else _codec, mutations, aliases, open_keys, record_keys)


func _changes(r: Dictionary) -> Array:
	return r["body"].get("changes", [])


func _results(r: Dictionary) -> Array:
	return r["body"].get("results", [])


func _rows(r: Dictionary) -> Array:
	return r["opened"].get("changes", [])


## The value of a number as the machine would compare it.
static func _same(a: Variant, b: Variant) -> bool:
	return PKeySyncCanonicalJson.canonicalize_value(a).get("canonical") == PKeySyncCanonicalJson.canonicalize_value(b).get("canonical")


# ── seal_push ────────────────────────────────────────────────────────────────────────────────

func _push(t: PKeyTestContext) -> void:
	var body := _push_body([
		_mset(1, VOL, 0.5), _mset(2, OPEN, "secret-value"),
		{"mutationId": 3, "target": {"setting": BIND, "scope": "user"}, "op": "setMember", "member": "jump", "value": "space"},
		{"mutationId": 4, "target": {"setting": BIND, "scope": "user"}, "op": "removeMember", "member": "run"},
		{"mutationId": 5, "target": {"setting": VOL, "scope": "user"}, "op": "clear"},
	])
	var before := JSON.stringify(body)
	var r := Codec.seal_push_with(body, _codec, _routes())
	t.check("push: seals", r["ok"])
	if not r["ok"]:
		return
	var ms: Array = r["body"]["mutations"]
	t.check("push: the declared key stays, its value becomes a ct that opens", ms[0]["target"]["setting"] == VOL and not ms[0].has("value") and _opens(ms[0]["ct"], VOL, 0.5))
	t.check("push: an open key is blinded and its ct opens under its own name", ms[1]["target"]["setting"] == _bl("setting", C, OPEN) and PKeySyncBlind.is_blinded_name(ms[1]["target"]["setting"]) and _opens(ms[1]["ct"], OPEN, "secret-value"))
	t.check("push: a member is blinded under the setting and sealed under setting NUL member", ms[2]["target"]["setting"] == BIND and ms[2]["member"] == _bl("member", BIND, "jump") and _opens(ms[2]["ct"], PKeySyncEnvelope.member_name(BIND, "jump"), "space"))
	t.check("push: removeMember blinds the member and carries no ct", ms[3]["member"] == _bl("member", BIND, "run") and not ms[3].has("ct"))
	t.check("push: clear is untouched", _same(ms[4], {"mutationId": 5, "target": {"setting": VOL, "scope": "user"}, "op": "clear"}))
	var wire := JSON.stringify(r["body"])
	var leaked := false
	for plain in ["secret-value", "space", OPEN, "\"jump\"", "\"run\""]:
		leaked = leaked or wire.contains(plain)
	t.check("push: nothing in the clear leaves", not leaked)
	t.check("push: the input body is not changed", JSON.stringify(body) == before)
	var trip := Codec.seal_push_with(_push_body([_mset(1, OPEN, {"a": 1})]), _codec, _routes())
	var m: Dictionary = trip["body"]["mutations"][0]
	var back := _pull({"changes": [{"setting": m["target"]["setting"], "scope": "user", "ct": m["ct"], "version": 4}]})
	t.check("push: seal then open round-trips an open key", _changes(back)[0]["setting"] == OPEN and _same(_changes(back)[0]["value"], {"a": 1}) and _rows(back) == [{"sealed": true}])
	var member_on_open := {"mutationId": 1, "target": {"setting": OPEN, "scope": "user"}, "op": "setMember", "member": "m", "value": 1}
	t.check("push: a member op on an open key is refused", not Codec.seal_push_with(_push_body([member_on_open]), _codec, _routes())["ok"])


func _opens(ct: String, name: Variant, want: Variant) -> bool:
	var env: Variant = PKeyB64Url.decode_strict(ct)
	if env == null:
		return false
	var r := PKeySyncEnvelope.open_value(_root, C, name, env)
	return r["ok"] and _same(r["value"], want)


# HC-6: a naive port that checks `locked` only on pull, or seals before it checks, sends or seals something.
func _hc6(t: PKeyTestContext) -> void:
	var c := FixtureCodec.new(_root)
	c.is_locked = true
	var s := Codec.seal_push_with(_push_body([_mset(1, VOL, 1)]), c, _routes())
	t.check("HC-6: a locked codec refuses a push with sync-locked", not s["ok"] and s["code"] == "sync-locked")
	t.check("HC-6: and seals nothing", c.seals == 0)
	var o := Codec.open_pull_with({"changes": []}, c, [], {}, [])
	t.check("HC-6: a locked codec opens nothing (sync-locked)", not o["ok"] and o["code"] == "sync-locked")
	var record := {"mutationId": 2, "target": {"record": ["slots", "a"]}, "op": "setField", "field": "hp", "value": 1}
	var unlocked := FixtureCodec.new(_root)
	var half := Codec.seal_push_with(_push_body([_mset(1, VOL, 1), record]), unlocked, _routes())
	t.check("HC-6: a merge-record mutation is refused (invalid-options) and the valid one before it is not returned", not half["ok"] and half["code"] == "invalid-options" and not half.has("body"))
	t.check("HC-6: a value canonical JSON refuses (NaN) is refused, nothing returned", not Codec.seal_push_with(_push_body([_mset(1, VOL, NAN)]), unlocked, _routes())["ok"])
	t.check("HC-6: a mutation with a ct, field or element is refused", not Codec.seal_push_with(_push_body([{"mutationId": 1, "target": {"setting": VOL}, "op": "clear", "ct": "AAAA"}]), unlocked, _routes())["ok"])
	t.check("HC-6: an unknown operation is refused", not Codec.seal_push_with(_push_body([{"mutationId": 1, "target": {"setting": VOL}, "op": "explode"}]), unlocked, _routes())["ok"])
	t.check("HC-6: a null codec is locked", Codec.seal_push_with(_push_body([]), null, [])["code"] == "sync-locked")
	# The default port (no ring) is locked too.
	var port := Codec.new(null)
	t.check("HC-6: a codec with no ring is locked and sends nothing", port.locked() and not port.seal_push(_push_body([_mset(1, VOL, 1)]), _routes())["ok"] and not port.open_pull({}, [], {}, [])["ok"])


# HC-4 (push): a name holding U+0000 would collide in `kind NUL ctx NUL name`; compared as bytes.
func _hc4_push(t: PKeyTestContext) -> void:
	var nul_name := PackedByteArray([97, 0, 98])
	var bad := {"mutationId": 1, "target": {"setting": nul_name, "scope": "user"}, "op": "set", "value": 1}
	t.check("HC-4: a setting name that is bytes with a NUL is refused (a naive String check misses it)", Codec._has_nul(nul_name) and not Codec.seal_push_with(_push_body([bad]), _codec, _routes())["ok"])
	var bad_member := {"mutationId": 1, "target": {"setting": BIND, "scope": "user"}, "op": "setMember", "member": PackedByteArray([106, 0, 107]), "value": 1}
	t.check("HC-4: a member that is not a string is refused", not Codec.seal_push_with(_push_body([bad_member]), _codec, _routes())["ok"])
	t.check("HC-4: a character that merely looks like a NUL (U+FFFD) is a name, not a NUL", not Codec._has_nul("a�b") and Codec.seal_push_with(_push_body([_mset(1, "a�b", 1)]), _codec, _routes())["ok"])
	t.check("HC-4: UTF-8 bytes are what is compared (a combining mark after text is no NUL)", not Codec._has_nul("áb"))


# ── open_pull ────────────────────────────────────────────────────────────────────────────────

func _pull_basics(t: PKeyTestContext) -> void:
	var r := _pull({"changes": [
		{"setting": VOL, "scope": "user", "ct": _env_ct(VOL, 0.3), "version": 9, "editedHlc": "h"},
		{"setting": "legacy", "scope": "user", "value": 1, "version": 2}]})
	t.check("pull: a declared key opens, takes its version, drops the ct", _same(_changes(r)[0], {"setting": VOL, "scope": "user", "value": 0.3, "version": 9, "editedHlc": "h"}))
	t.check("pull: a plaintext row is legacy and its seq is its version", _same(_changes(r)[1], {"setting": "legacy", "scope": "user", "value": 1, "version": 2}))
	t.check("pull: the opened rows are sealed then seq 2", _rows(r)[0] == {"sealed": true} and _same(_rows(r)[1], {"seq": 2}))
	var rec := _pull({"changes": [{"record": ["slots", "a"], "ct": "AAAA", "version": 1}, {"record": ["slots", "b"], "version": 2}, 3]})
	t.check("pull: a record change with a ct is invalid, a plain one legacy, a non-object passes", _rows(rec)[0] == {"invalid": true} and _same(_rows(rec)[1], {"seq": 2}) and _rows(rec)[2] == null and _changes(rec)[2] == 3)
	var tomb := _pull({"tombstones": [{"setting": _bl("setting", C, OPEN), "editedHlc": "h"}, {"setting": VOL, "editedHlc": "h"}]}, [], {}, [OPEN])
	t.check("pull: a tombstone of a known open key maps back to its name, a declared one stays", tomb["body"]["tombstones"][0]["setting"] == OPEN and tomb["body"]["tombstones"][1]["setting"] == VOL)
	var tomb2 := _pull({"tombstones": [{"setting": _bl("setting", C, OPEN)}]}, [], {}, [])
	t.check("pull: a tombstone of an unknown open key stays blinded", PKeySyncBlind.is_blinded_name(tomb2["body"]["tombstones"][0]["setting"]))
	t.check("pull: a body that is not an object-of-lists passes through", _pull({"cursor": 5})["body"] == {"cursor": 5} and _pull({"cursor": 5})["opened"] == {})


# HC-2: a naive port that reads `sealed` or `seq` from the served body lets a Worker mark a plaintext
# row sealed, or set its own sequence.
func _hc2(t: PKeyTestContext) -> void:
	var r := _pull({"sealed": true, "seq": 3,
		"changes": [{"setting": "p", "scope": "user", "value": 666, "version": 50, "sealed": true, "invalid": false, "seq": 1}],
		"results": [{"mutationId": 1, "status": "ok", "version": 1, "sealed": true, "seq": 1, "ct": "x"}]})
	t.check("HC-2: the body's own sealed and seq are removed", not r["body"].has("sealed") and not r["body"].has("seq"))
	t.check("HC-2: a change loses sealed, invalid, seq", _same(_changes(r)[0], {"setting": "p", "scope": "user", "value": 666, "version": 50}))
	t.check("HC-2: a result loses sealed, seq, ct", _same(_results(r)[0], {"mutationId": 1, "status": "ok", "version": 1}))
	t.check("HC-2: the opened row comes from the codec's own read (seq 50, not sealed)", _same(_rows(r)[0], {"seq": 50}))


# HC-5: a naive port opens any ct under the served name, or accepts the blinded name without re-blinding.
func _hc5(t: PKeyTestContext) -> void:
	var good := _env_ct(VOL, 1)
	var tampered: PackedByteArray = PKeyB64Url.decode_strict(good)
	tampered[tampered.size() - 1] ^= 1
	var cases := [_env_ct(VOL, 1, _other_root), PKeyB64Url.encode(tampered), _env_ct("other.key", 1), "not base64 !", good + "=", ""]
	var all_invalid := true
	var no_value := true
	for ct in cases:
		var r := _pull({"changes": [{"setting": VOL, "scope": "user", "ct": ct, "value": 7, "version": 3}]})
		all_invalid = all_invalid and _rows(r)[0] == {"invalid": true}
		no_value = no_value and not _changes(r)[0].has("value") and not _changes(r)[0].has("ct")
	t.check("HC-5: a ct under another root, tampered, under another name, not canonical base64url, or empty is invalid", all_invalid)
	t.check("HC-5: and the row keeps no value (not even the served plaintext) and no ct", no_value)
	var honest := _bl("setting", C, OPEN)
	var ct := _env_ct(OPEN, "v")
	var ok := _pull({"changes": [{"setting": honest, "scope": "user", "ct": ct, "version": 1}]})
	t.check("HC-5: a blinded name is replaced by the opened key when it re-blinds", _changes(ok)[0]["setting"] == OPEN and _rows(ok) == [{"sealed": true}])
	var other := _bl("setting", C, "another.key")
	var moved := _pull({"changes": [{"setting": other, "scope": "user", "ct": ct, "version": 1}]})
	t.check("HC-5: an envelope moved under another blinded name is invalid and the name stays blinded", _changes(moved)[0]["setting"] == other and not _changes(moved)[0].has("value") and _rows(moved) == [{"invalid": true}])
	var bare := _pull({"changes": [{"setting": honest, "scope": "user", "value": 1, "version": 1}]})
	t.check("HC-5: a blinded name with no ct reads as a plaintext row", _same(_rows(bare)[0], {"seq": 1}))
	var no_ct := _pull({"changes": [{"setting": honest, "scope": "user", "members": [], "version": 1}]})
	t.check("HC-5: a blinded name with members and no ct is invalid", _rows(no_ct) == [{"invalid": true}])
	# Merge members.
	var mk := func(member: String, v: Variant) -> Dictionary:
		return {"member": _bl("member", BIND, member), "ct": _env_ct(PKeySyncEnvelope.member_name(BIND, member), v), "editedHlc": "h"}
	var body := func(members: Array) -> Dictionary:
		return {"changes": [{"setting": BIND, "scope": "user", "members": members, "version": 5}]}
	var members := [mk.call("jump", "space"), mk.call("run", "shift")]
	var merged := _pull(body.call(members))
	t.check("HC-5: merge members open into one value", _same(_changes(merged)[0]["value"], {"jump": "space", "run": "shift"}) and not _changes(merged)[0].has("members") and _rows(merged) == [{"sealed": true}])
	var swapped: Dictionary = members[0].duplicate()
	swapped["member"] = members[1]["member"]
	t.check("HC-5: a member moved under another member's blinded name is invalid", _rows(_pull(body.call([swapped, members[1]]))) == [{"invalid": true}])
	var foreign := {"member": _bl("member", BIND, "jump"), "ct": _env_ct(PKeySyncEnvelope.member_name("other.merge", "jump"), 1)}
	t.check("HC-5: a member of another merge setting is invalid (the name binds the setting)", _rows(_pull(body.call([foreign]))) == [{"invalid": true}])
	t.check("HC-5: the same member twice is invalid", _rows(_pull(body.call([members[0], members[0]]))) == [{"invalid": true}])
	t.check("HC-5: a member name that is not blinded is invalid", _rows(_pull(body.call([{"member": "jump", "ct": members[0]["ct"]}]))) == [{"invalid": true}])


# HC-1: a naive port keys conflicts by id in a map and lets the second verdict overwrite the first, or
# opens a copy against whatever name it carries.
func _hc1(t: PKeyTestContext) -> void:
	var ms := [_mset(7, VOL, 1), _mset(8, OPEN, 1)]
	var r := _pull({"results": [
		{"mutationId": 7, "status": "conflict", "server": {"ct": _env_ct(VOL, 0.9), "version": 40, "sealed": true}},
		{"mutationId": 8, "status": "conflict", "server": {"ct": _env_ct("wrong.name", 1), "version": 41}},
		{"mutationId": 9, "status": "conflict", "server": {"ct": _env_ct(VOL, 1), "version": 42}},
		{"mutationId": 10, "status": "conflict", "server": {"value": 3, "version": 3, "seq": 0}}]}, ms)
	t.check("HC-1: a conflict copy opens for a mutation of the request (value, no flags)", _same(_results(r)[0]["server"], {"value": 0.9, "version": 40}))
	var cf: Dictionary = r["opened"]["conflicts"]
	t.check("HC-1: sealed for 7; invalid for 8 (wrong name) and 9 (not a mutation of this request); seq 3 for the plaintext copy", cf[7] == {"sealed": true} and cf[8] == {"invalid": true} and cf[9] == {"invalid": true} and _same(cf[10], {"seq": 3}))
	var forged := {"value": "FORGED", "version": 90}
	var real := {"ct": _env_ct(VOL, 0.9), "version": 91}
	var ms1 := [_mset(1, VOL, 1)]
	var dup_int := _pull({"results": [{"mutationId": 1, "status": "conflict", "server": forged}, {"mutationId": 1, "status": "conflict", "server": real}]}, ms1)
	t.check("HC-1: a repeated mutationId fails the whole answer closed (sync-failed)", not dup_int["ok"] and dup_int["code"] == "sync-failed")
	var dup_float := _pull({"results": [{"mutationId": 1, "status": "conflict", "server": forged}, {"mutationId": 1.0, "status": "conflict", "server": real}]}, ms1)
	t.check("HC-1: and 1 and 1.0 are the same id (a naive string or type key lets 1.0 through)", not dup_float["ok"] and dup_float["code"] == "sync-failed")
	var int_bool := _pull({"results": [{"mutationId": 1, "status": "conflict", "server": forged}, {"mutationId": true, "status": "conflict", "server": real}]}, ms1)
	t.check("HC-1: but 1 and true are two ids (a naive 1 == true treats them as one)", int_bool["ok"])
	var mixed := _pull({"results": [{"mutationId": "a", "status": "ok"}, {"mutationId": "a", "status": "ok"}]})
	t.check("HC-1: a repeated non-numeric id fails closed too", not mixed["ok"])
	var no_mutations := _pull({"results": [{"mutationId": 7, "status": "conflict", "server": {"ct": _env_ct("theme", "forged"), "version": 2}}]}, [])
	t.check("HC-1: a conflict with no mutations of the request reads as invalid", no_mutations["opened"]["conflicts"][7] == {"invalid": true})


# HC-3: a naive port keeps a served `aliases` map and `renamedTo`, so a Worker could swap values.
func _hc3(t: PKeyTestContext) -> void:
	var ct := _env_ct("old.name", 1)
	var served := {"changes": [{"setting": "new.name", "scope": "user", "ct": ct, "version": 1}], "aliases": {"old.name": "new.name"}}
	t.check("HC-3: a served alias opens nothing without the app's declaration", _rows(_pull(served))[0] == {"invalid": true})
	t.check("HC-3: with the app's alias the old name opens", _rows(_pull(served, [], {"old.name": "new.name"}))[0] == {"sealed": true})
	var ms := [_mset(1, "old.k", 1), _mset(2, "x.k", 1)]
	var body := {"aliases": {"foo": "bar"}, "results": [
		{"mutationId": 1, "status": "ok", "version": 1, "renamedTo": "new.k"},
		{"mutationId": 2, "status": "ok", "version": 2, "renamedTo": "evil"}]}
	var r := _pull(body, ms, {"old.k": "new.k"})
	t.check("HC-3: the served aliases are replaced by the app's", _same(r["body"]["aliases"], {"old.k": "new.k"}))
	t.check("HC-3: a renamedTo the app declares for that mutation's setting stays, any other goes", _results(r)[0].get("renamedTo") == "new.k" and not _results(r)[1].has("renamedTo"))
	t.check("HC-3: with no declared aliases the body's aliases are empty", _pull(body)["body"]["aliases"] == {})
	t.check("HC-3: a body with no aliases gets none", not _pull({"cursor": 1})["body"].has("aliases"))


# HC-4 (pull): a naive port trusts the name inside the envelope as a String, which silently drops NUL.
func _hc4_pull(t: PKeyTestContext) -> void:
	# An open key sealed with a NUL by a hostile peer: the name's UTF-8 bytes hold 0 although a String cannot.
	var nul_bytes := PackedByteArray([97, 0, 98])
	var blinded := PKeySyncBlind.blind(_root, "setting", C, "a")
	var env := PKeyB64Url.encode(PKeySyncEnvelope.seal_value(_root, C, nul_bytes, 1))
	var r := _pull({"changes": [{"setting": blinded, "scope": "user", "ct": env, "version": 1}]})
	t.check("HC-4: an open key whose envelope name holds U+0000 is invalid (compared as bytes)", _rows(r) == [{"invalid": true}])
	# The naive String comparison reads the NUL name as "a" (a String stops at the NUL) and re-blinds to the served name: show it would pass.
	var opened := PKeySyncEnvelope.open_value_any_name(_root, C, PKeySyncEnvelope.seal_value(_root, C, nul_bytes, 1))
	t.check("HC-4: (the naive String path would accept it: the name reads back as a and re-blinds)", opened["ok"] and opened["name"] == "a" and PKeySyncBlind.blind(_root, "setting", C, opened["name"]) == blinded)
	# A merge member with a NUL, sealed under the setting prefix.
	var member_bytes := PackedByteArray([106, 0, 107])
	var name := BIND.to_utf8_buffer()
	name.append(0)
	name.append_array(member_bytes)
	var mr := _pull({"changes": [{"setting": BIND, "scope": "user", "version": 1, "members": [{"member": _bl("member", BIND, "jk"), "ct": PKeyB64Url.encode(PKeySyncEnvelope.seal_value(_root, C, name, 1))}]}]})
	t.check("HC-4: a merge member name holding U+0000 is invalid", _rows(mr) == [{"invalid": true}])
	t.check("HC-4: a served setting name with U+FFFD is a name (the engine's JSON reads U+0000 as U+FFFD) and is not invalid by itself", _rows(_pull({"changes": [{"setting": "a�b", "value": 1, "version": 2}]})) == [{"seq": 2}])


func _hc_misc(t: PKeyTestContext) -> void:
	# The port surface over a real ring: locked until a root, then it seals and opens.
	var ring := PKeySyncRing.new(PRODUCT, "dev_a", func(_m: String, _p: String, _b: Variant) -> PKeyResult: return PKeyResult.success({"status": 201, "body": PackedByteArray()}), PKeyDeviceKeyStore.new(PRODUCT, PKeyTestFixtures.scratch_dir("host-codec-keys"), false, false), PKeySyncRingVault.new(PRODUCT, "user://pkey", true))
	var port := Codec.new(ring)
	var seen: Array = []
	var detach := port.attach(func(present: bool) -> void: seen.append(present))
	t.check("port: locked before a root, and the listener is told", port.locked() and seen == [false])
	t.check("port: a locked port refuses", not port.seal_push(_push_body([_mset(1, VOL, 1)]), _routes())["ok"])
	detach.call()


# ── records (U-23.G3): scalar values, WIRE-CONTRACT-V5 section 13.10.4 ───────────────────────────

func _rec_ct(collection: String, id: Variant, value: Variant, root := PackedByteArray()) -> String:
	return PKeyB64Url.encode(PKeySyncEnvelope.seal_value(root if not root.is_empty() else _root, collection, id, value))


## The envelope name of a merge field (id, U+0000, field) as bytes: a String cannot hold the NUL.
func _field_name(id: String, field: String) -> PackedByteArray:
	var b := id.to_utf8_buffer()
	b.append(0)
	b.append_array(field.to_utf8_buffer())
	return b


func _mrec(mid: int, op: String, collection: String, id: String, value: Variant = null) -> Dictionary:
	var m := {"mutationId": mid, "target": {"record": [collection, id]}, "op": op, "baseVersion": 3}
	if op == "set":
		m["value"] = value
	return m


func _records(t: PKeyTestContext) -> void:
	# Push: a set seals under the collection with k = id and sends the id blinded; a delete only blinds.
	var before := JSON.stringify(_push_body([_mrec(1, "set", SAVES, "slot-1", {"hp": 10}), _mrec(2, "delete", SAVES, "slot-2")]))
	var body := _push_body([_mrec(1, "set", SAVES, "slot-1", {"hp": 10}), _mrec(2, "delete", SAVES, "slot-2")])
	var r := Codec.seal_push_with(body, _codec, _routes())
	t.check("records push: seals", r["ok"])
	if not r["ok"]:
		return
	var ms: Array = r["body"]["mutations"]
	var s_id := _bl("record", SAVES, "slot-1")
	t.check("records push: a set sends the blinded id, keeps the collection and the baseVersion, and drops the value", ms[0]["target"]["record"] == [SAVES, s_id] and PKeySyncBlind.is_blinded_name(s_id) and ms[0]["baseVersion"] == 3 and not ms[0].has("value"))
	var env: Variant = PKeyB64Url.decode_strict(ms[0]["ct"])
	var ok1 := PKeySyncEnvelope.open_value(_root, SAVES, "slot-1", env)
	t.check("records push: the ct opens under the collection and k = id, and under no other collection or id", ok1["ok"] and _same(ok1["value"], {"hp": 10}) and not PKeySyncEnvelope.open_value(_root, SAVES, "slot-2", env)["ok"] and not PKeySyncEnvelope.open_value(_root, "other", "slot-1", env)["ok"])
	t.check("records push: a delete blinds the id and carries no ct", ms[1]["target"]["record"] == [SAVES, _bl("record", SAVES, "slot-2")] and not ms[1].has("ct") and not ms[1].has("value"))
	t.check("records push: nothing in the clear leaves", not JSON.stringify(r["body"]).contains("slot-1") and not JSON.stringify(r["body"]).contains("slot-2") and not JSON.stringify(r["body"]).contains("\"hp\""))
	t.check("records push: the input body is not changed", JSON.stringify(body) == before)
	var mixed := Codec.seal_push_with(_push_body([_mset(1, VOL, 0.5), _mrec(2, "set", SAVES, "a", 1)]), _codec, _routes())
	t.check("records push: a setting and a record seal in one batch", mixed["ok"] and mixed["body"]["mutations"][0]["target"]["setting"] == VOL and mixed["body"]["mutations"][1]["target"]["record"][1] == _bl("record", SAVES, "a"))
	# Refused: merge and union operations, a value on a delete, a missing value, a ct, bad references.
	var refused := {
		"setField": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "setField", "field": "hp", "value": 1},
		"removeField": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "removeField", "field": "hp"},
		"add": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "add", "element": "e", "value": 1},
		"remove": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "remove", "element": "e", "observedSeq": 1},
		"clear": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "clear"},
		"delete with a value": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "delete", "value": 1},
		"set with no value": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "set"},
		"set with a ct": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "set", "value": 1, "ct": "AAAA"},
		"set with a field": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "set", "value": 1, "field": "f"},
		"set with a member": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "set", "value": 1, "member": "m"},
		"a one-element reference": {"mutationId": 1, "target": {"record": [SAVES]}, "op": "set", "value": 1},
		"a non-string id": {"mutationId": 1, "target": {"record": [SAVES, 7]}, "op": "set", "value": 1},
		"an id that is bytes": {"mutationId": 1, "target": {"record": [SAVES, PackedByteArray([97, 0, 98])]}, "op": "set", "value": 1},
		"an empty id": {"mutationId": 1, "target": {"record": [SAVES, ""]}, "op": "set", "value": 1},
		"an empty collection": {"mutationId": 1, "target": {"record": ["", "a"]}, "op": "set", "value": 1},
		"the settings namespace": {"mutationId": 1, "target": {"record": [C, "a"]}, "op": "set", "value": 1},
		"a value canonical JSON refuses": {"mutationId": 1, "target": {"record": [SAVES, "a"]}, "op": "set", "value": NAN},
	}
	for name in refused:
		var f := Codec.seal_push_with(_push_body([refused[name]]), _codec, _routes())
		t.check("records push: %s is refused with invalid-options" % name, not f["ok"] and f["code"] == "invalid-options" and not f.has("body"))
	var lk := FixtureCodec.new(_root)
	lk.is_locked = true
	var lr := Codec.seal_push_with(_push_body([_mrec(1, "set", SAVES, "a", 1)]), lk, _routes())
	t.check("records push: a locked codec refuses with sync-locked and seals nothing", not lr["ok"] and lr["code"] == "sync-locked" and lk.seals == 0)

	# Pull: a sealed change opens to the plaintext id and value; the version is not taken as a seq.
	var served := _bl("record", SAVES, "slot-1")
	var pulled := _pull({"changes": [
		{"record": [SAVES, served], "ct": _rec_ct(SAVES, "slot-1", {"hp": 10}), "version": 8, "editedHlc": "h", "value": "FORGED", "sealed": true, "seq": 1},
		{"record": [SAVES, "legacy"], "value": {"hp": 1}, "version": 2}]})
	t.check("records pull: a sealed change opens to the id and value, the ct, flags and the served value go", _same(_changes(pulled)[0], {"record": [SAVES, "slot-1"], "value": {"hp": 10}, "version": 8, "editedHlc": "h"}))
	t.check("records pull: the rows are sealed, then a plaintext row's seq is its version", _rows(pulled)[0] == {"sealed": true} and _same(_rows(pulled)[1], {"seq": 2}))
	# Hostile: every one reads as invalid with no value, no ct and the id left as served.
	var good := _rec_ct(SAVES, "slot-1", 1)
	var tampered: PackedByteArray = PKeyB64Url.decode_strict(good)
	tampered[tampered.size() - 1] ^= 1
	var nul_id := PackedByteArray([115, 0, 49])
	var hostile := {
		"another id (swapped)": {"record": [SAVES, _bl("record", SAVES, "slot-2")], "ct": good},
		"another collection": {"record": ["other", served], "ct": good},
		"the settings namespace": {"record": [C, served], "ct": good},
		"an id that is not blinded": {"record": [SAVES, "slot-1"], "ct": good},
		"another root": {"record": [SAVES, served], "ct": _rec_ct(SAVES, "slot-1", 1, _other_root)},
		"a tampered ct": {"record": [SAVES, served], "ct": PKeyB64Url.encode(tampered)},
		"a ct that is not canonical": {"record": [SAVES, served], "ct": good + "="},
		"an empty ct": {"record": [SAVES, served], "ct": ""},
		"a field envelope served as a value": {"record": [SAVES, served], "ct": PKeyB64Url.encode(PKeySyncEnvelope.seal_value(_root, SAVES, _field_name("slot-1", "hp"), 1))},
		"an id holding NUL": {"record": [SAVES, PKeySyncBlind.blind(_root, "record", SAVES, "s")], "ct": PKeyB64Url.encode(PKeySyncEnvelope.seal_value(_root, SAVES, nul_id, 1))},
		"sealed fields": {"record": [SAVES, served], "fields": [], "version": 1},
		"sealed elements": {"record": [SAVES, served], "elements": [], "version": 1},
		"a malformed reference": {"record": [SAVES], "ct": good},
	}
	for name in hostile:
		var h: Dictionary = hostile[name].duplicate()
		h["version"] = 4
		h["value"] = "FORGED"
		var hr := _pull({"changes": [h]})
		var c0: Dictionary = _changes(hr)[0]
		t.check("records pull: %s is invalid, with no value and no ct" % name, _rows(hr) == [{"invalid": true}] and not c0.has("value") and not c0.has("ct"))
	var swapped := _pull({"changes": [{"record": [SAVES, _bl("record", SAVES, "slot-2")], "ct": good, "version": 4}]})
	t.check("records pull: a swapped envelope leaves the served blinded id", _changes(swapped)[0]["record"][1] == _bl("record", SAVES, "slot-2"))
	# Two records of one collection cannot trade values.
	var two := _pull({"changes": [
		{"record": [SAVES, _bl("record", SAVES, "slot-1")], "ct": _rec_ct(SAVES, "slot-1", "one"), "version": 1},
		{"record": [SAVES, _bl("record", SAVES, "slot-2")], "ct": _rec_ct(SAVES, "slot-2", "two"), "version": 2}]})
	t.check("records pull: each record keeps its own value", _changes(two)[0]["value"] == "one" and _changes(two)[1]["value"] == "two" and _changes(two)[1]["record"][1] == "slot-2")
	# Round trip through the push.
	var trip := Codec.seal_push_with(_push_body([_mrec(1, "set", SAVES, "slot-9", {"gold": 3})]), _codec, _routes())
	var tm: Dictionary = trip["body"]["mutations"][0]
	var back := _pull({"changes": [{"record": tm["target"]["record"], "ct": tm["ct"], "version": 5}]})
	t.check("records: seal then open round-trips", _changes(back)[0]["record"] == [SAVES, "slot-9"] and _same(_changes(back)[0]["value"], {"gold": 3}) and _rows(back) == [{"sealed": true}])

	# Tombstones map back only for records the machine holds.
	var tb := _pull({"tombstones": [{"record": [SAVES, _bl("record", SAVES, "slot-1")], "editedHlc": "h"}, {"record": [SAVES, _bl("record", SAVES, "unknown")], "editedHlc": "h"}, {"record": ["other", _bl("record", SAVES, "slot-1")]}]}, [], {}, [], null, [[SAVES, "slot-1"], [SAVES, 3], [C, "x"]])
	var tombs: Array = tb["body"]["tombstones"]
	t.check("records tombstone: a held record maps back, an unknown or other-collection one stays blinded", tombs[0]["record"] == [SAVES, "slot-1"] and tombs[0]["editedHlc"] == "h" and tombs[1]["record"][1] == _bl("record", SAVES, "unknown") and tombs[2]["record"][0] == "other" and PKeySyncBlind.is_blinded_name(tombs[2]["record"][1]))

	# Conflict copies open against the mutation's own record.
	var ms2 := [_mrec(7, "set", SAVES, "slot-1", 1), _mrec(8, "set", SAVES, "slot-1", 1), _mrec(9, "delete", SAVES, "slot-3"), _mset(10, VOL, 1)]
	var cr := _pull({"results": [
		{"mutationId": 7, "status": "conflict", "server": {"ct": _rec_ct(SAVES, "slot-1", {"hp": 99}), "version": 40, "editedHlc": "h", "sealed": true}},
		{"mutationId": 8, "status": "conflict", "server": {"ct": _rec_ct(SAVES, "slot-2", {"hp": 98}), "version": 41}},
		{"mutationId": 9, "status": "conflict", "server": {"ct": _rec_ct(SAVES, "slot-3", "x"), "version": 42}},
		{"mutationId": 10, "status": "conflict", "server": {"ct": _rec_ct(SAVES, "slot-1", 1), "version": 43}},
		{"mutationId": 11, "status": "conflict", "server": {"ct": _rec_ct(SAVES, "slot-1", 1), "version": 44}},
		{"mutationId": 12, "status": "conflict", "server": {"value": {"hp": 5}, "version": 3}}]}, ms2)
	var cf: Dictionary = cr["opened"]["conflicts"]
	t.check("records conflict: a copy opens under the mutation's own record id", _same(_results(cr)[0]["server"], {"value": {"hp": 99}, "version": 40, "editedHlc": "h"}) and cf[7] == {"sealed": true})
	t.check("records conflict: another record's value is invalid (the name binds the record)", cf[8] == {"invalid": true} and not _results(cr)[1]["server"].has("value"))
	t.check("records conflict: a delete's conflict opens under the deleted record", cf[9] == {"sealed": true} and _results(cr)[2]["server"]["value"] == "x")
	t.check("records conflict: a setting mutation's copy is not opened as a record, and an unknown mutation reads as invalid", cf[10] == {"invalid": true} and cf[11] == {"invalid": true})
	t.check("records conflict: a plaintext copy is legacy with its seq", _same(cf[12], {"seq": 3}))
	var fcopy := _pull({"results": [{"mutationId": 7, "status": "conflict", "server": {"fields": [], "version": 3}}]}, ms2)
	t.check("records conflict: a sealed fields copy is invalid", fcopy["opened"]["conflicts"][7] == {"invalid": true})
	t.check("records: the locked codec opens nothing", not Codec.open_pull_with({"changes": []}, lk, [], {}, [], [])["ok"])


# ── openPull into the machine, through the host ───────────────────────────────────────────────

func _into_the_machine(t: PKeyTestContext) -> void:
	var ring := PKeySyncRing.new(PRODUCT, "dev_a", func(_m: String, _p: String, _b: Variant) -> PKeyResult: return PKeyResult.success({"status": 201, "body": PackedByteArray()}), PKeyDeviceKeyStore.new(PRODUCT, PKeyTestFixtures.scratch_dir("host-codec-keys2"), false, false), PKeySyncRingVault.new(PRODUCT, "user://pkey", true))
	var made := await ring.create(false)
	if not t.check("machine: the ring is created", made.ok, str(made)):
		return
	var port := Codec.new(ring)
	t.check("machine: the port is unlocked with the ring", not port.locked())
	var mode := ["sealed"]
	var served_ct := [PKeyB64Url.encode(ring.codec.seal(C, "a.x", "dark"))]
	var handler := func(req: Dictionary) -> Dictionary:
		if String(req["path"]).begins_with("/%s/sync?" % PRODUCT):
			match mode[0]:
				"sealed":
					return {"status": 200, "body": JSON.stringify({"encryption": "e2e", "cursor": 5, "serverNow": 1760000000000, "changes": [{"setting": "a.x", "scope": "user", "version": 5, "ct": served_ct[0]}], "tombstones": []})}
				"bad":
					return {"status": 200, "body": JSON.stringify({"encryption": "e2e", "cursor": 6, "serverNow": 1760000000000, "changes": [{"setting": "a.x", "scope": "user", "version": 6, "ct": "AAAA", "value": "FORGED"}], "tombstones": []})}
				"plain":
					return {"status": 200, "body": JSON.stringify({"encryption": "e2e", "cursor": 7, "serverNow": 1760000000000, "changes": [{"setting": "a.x", "scope": "user", "version": 7, "value": "FORGED-PLAIN", "sealed": true}], "tombstones": []})}
		return {"status": 200, "body": "{}"}
	var server := PKeyTestFixtures.new_server(handler)
	var dir := PKeyTestFixtures.scratch_dir("host_codec_machine")
	var clock := [1760000000000]
	var host: Node = Host.new()
	(Engine.get_main_loop() as SceneTree).root.add_child(host)
	var deps := {
		"product": PRODUCT, "state_dir": dir, "sealer": PKeyFakeSealer.new(),
		"token": func() -> String: return "pkeyt_secret",
		"session_subject": func() -> Variant: return null,
		"headers": func(x: Dictionary) -> Dictionary: return x,
		"url": func(path: String) -> String: return server.base_url() + path,
		"discovery": func() -> Variant: return {"services": {"sync": {"enabled": true, "encryption": "e2e"}}},
		"fetch_schema": func() -> Variant: return null,
		"document": func() -> Dictionary: return {"values": {}, "locked": []},
		"clock": func() -> int: return clock[0],
		"codec": port,
	}
	var catalog := {"schemaVersion": 1, "entries": [{"key": "a.x", "kind": "config", "label": "x", "schema": {"type": "string"}}]}
	host.configure(deps, {"encryption": "e2e", "catalog": catalog})
	await host.start()
	host.sign_in("sub_a")
	await _settle(host)
	t.check("machine: a sealed row from the ring opens into the machine's value", host.machine().get_value("a.x").get("value") == "dark", str(host.machine().get_value("a.x")))
	t.check("machine: and it is not marked invalid", host.machine().setting_state("a.x").get("invalid") == false, str(host.machine().setting_state("a.x")))
	mode[0] = "bad"
	await _repull(host)
	t.check("machine: an unopenable ct is invalid and the served plaintext value is never taken", host.machine().setting_state("a.x").get("invalid") == true and host.machine().get_value("a.x").get("value") != "FORGED", str(host.machine().setting_state("a.x")))
	mode[0] = "plain"
	await _repull(host)
	t.check("machine: a plaintext row claiming sealed is not trusted once the ring has sealed rows", host.machine().get_value("a.x").get("value") != "FORGED-PLAIN", str(host.machine().get_value("a.x")))
	ring.lock()
	var before: int = server.requests.size()
	await _repull(host)
	t.check("machine: a locked ring sends and reads nothing", server.requests.size() == before)
	host.close()
	host.queue_free()
	server.stop()
	PKeyTestFixtures.remove_tree(dir)


func _settle(host: Node) -> void:
	host.touch()
	await host.idle()


func _repull(host: Node) -> void:
	await host.idle()
	var m: Variant = host.machine()
	m.set_network("offline")
	m.set_network("online")
	await _settle(host)
