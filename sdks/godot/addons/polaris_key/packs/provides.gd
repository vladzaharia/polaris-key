class_name PKeyPackProvides
extends RefCounted
## Save compatibility on the device (P4-20, CONTENT §6.7 item 8, PARITY `packs.provides`): which
## content ids a pack release provides, read from its signed record's record-level `provides`. A
## port of client-core `packs/provides.ts` and of PackEngine's `isAvailable`, `packFor`,
## `factsOf` and `targetFacts`, kept beside PKeyPackEngine (it reads the engine and never changes
## what it installs).
##
## `provides` is a member WIRE-CONTRACT-V4 §2.5.1 reserves on the pack record ("ignored by v1"):
## it is never a claim, so a record that carries a malformed list still verifies. The reader is
## the one interpretation every SDK shares:
##
##   absent                                       → provides nothing;
##   an Array of 0–MAX_PROVIDES unique Strings, each a content id (printable ASCII without the
##   space, 1–128 characters)                     → those ids;
##   anything else                                → provides nothing.
##
## Facts are read from the record the engine verified this process (`PKeyPackEngine.records`,
## parsed by the strict JWS path), else from the stored JWS of an install the engine verified at
## load, decoded with PKeyJson (never Godot's lenient parser). A target release that no install
## holds is fetched by hash and verified exactly as preflight step 2 does.
##
##   provides_of(record)          Dictionary used as a set (empty when absent or unusable)
##   facts(record)                {provides, entitlement (String or null)}
##   is_available(content_id)     bool: the running set provides it (entitled)
##   pack_for(content_id, targets = null)
##                                a coroutine: {packId, release: {sha256, seq, version}} or null

## The most ids one `provides` list may hold.
const MAX_PROVIDES := 4096
## The longest content id, in characters (= bytes: ids are ASCII).
const MAX_CONTENT_ID := 128
## The most record facts the memo keeps before it starts over.
const MAX_MEMO := 1024

var engine: PKeyPackEngine
## Facts of verified records, by record SHA-256.
var _memo := {}


func _init(e: PKeyPackEngine) -> void:
	engine = e


## One content id: a String of 1–128 bytes, each 0x21..0x7E (checked on the bytes, no locale API).
static func is_content_id(id: Variant) -> bool:
	if not (id is String):
		return false
	var s: String = id
	var n := s.length()
	if n < 1 or n > MAX_CONTENT_ID:
		return false
	var b := s.to_utf8_buffer()
	if b.size() != n:
		return false
	for x in b:
		if x < 0x21 or x > 0x7E:
			return false
	return true


## A record payload's `provides`, as a set {id: true} in list order (empty when absent or
## unusable).
static func provides_of(record: Variant) -> Dictionary:
	if not (record is Dictionary):
		return {}
	var list = (record as Dictionary).get("provides")
	if not (list is Array) or (list as Array).size() > MAX_PROVIDES:
		return {}
	var out := {}
	for id in list:
		if not is_content_id(id) or out.has(id):
			return {}
		out[id] = true
	return out


## The payload of a compact JWS the engine has ALREADY verified (a stored install, an embedded
## marker's record), decoded strictly and never re-verified here; null when it does not decode.
static func verified_payload_of(jws: Variant) -> Variant:
	if not (jws is String):
		return null
	var parts := (jws as String).split(".")
	if parts.size() != 3:
		return null
	var bytes = PKeyB64Url.decode_strict(parts[1])
	if bytes == null:
		return null
	var parsed := PKeyJson.parse_bytes(bytes)
	return parsed["value"] if parsed["ok"] else null


## What save compatibility reads from one verified record: {provides, entitlement}. A licence
## without the entitlement hides the pack (CONTENT §6.7 item 9).
static func facts(record: Variant) -> Dictionary:
	var e = (record as Dictionary).get("entitlement") if record is Dictionary else null
	return {"provides": provides_of(record), "entitlement": e if e is String else null}


## Whether the licence lets a pack answer: ungated, no License service (null), or the flag granted.
static func entitled(f: Dictionary, granted: Variant) -> bool:
	return f["entitlement"] == null or not (granted is Dictionary) or (granted as Dictionary).has(f["entitlement"])


## Whether a pack release in the RUNNING set provides `content_id`: restart packs mounted at this
## boot, hot packs active, embedded baselines included (a revoked release is never in it). A pack
## whose entitlement the licence lacks never answers. False before the engine loads.
func is_available(content_id: String) -> bool:
	if engine == null or engine.doc == null:
		return false
	var granted = _granted()
	for i in engine.running.values():
		var f := _facts_of_install(i)
		if f["provides"].has(content_id) and entitled(f, granted):
			return true
	return false


## The pack whose TARGET release provides `content_id`, so a game can `estimate` and `ensure` it.
## `targets`: a packs decision's install list ([{pack, release: {sha256, seq, version}}]), else
## the content stamp's pins in stamp order. Each target's facts come from an install or embedded
## baseline of that release, else from its record fetched by hash and verified as `ensure`
## verifies it. The first target, in order, that provides the id and is entitled answers. A target
## that cannot be fetched or verified, or is revoked, is skipped. A coroutine returning
## {packId, release: {sha256, seq, version}} or null. Serialised with the engine's calls.
func pack_for(content_id: String, targets: Variant = null) -> Variant:
	if engine == null:
		return null
	await engine._enter()
	var out = null
	if engine.doc != null:
		var list: Array = []
		if targets is Array:
			list = targets
		elif engine.stamp is Dictionary and engine.stamp.get("pins") is Array:
			list = engine.stamp["pins"]
		var granted = _granted()
		for t in list:
			if not _target_ok(t):
				continue
			var rel: Dictionary = t["release"]
			if _revoked(String(rel["sha256"])):
				continue
			var f = await _target_facts(t)
			if f is Dictionary and f["provides"].has(content_id) and entitled(f, granted):
				out = {"packId": String(t["pack"]), "release": {"sha256": String(rel["sha256"]), "seq": rel["seq"], "version": rel["version"]}}
				break
	engine._leave()
	return out


# ── Internals ───────────────────────────────────────────────────────────────────────────────

func _granted() -> Variant:
	return engine.entitlements.call() if engine.entitlements.is_valid() else null


## A revocation seam: the engine answers through `is_revoked(sha256)` once it holds revocations
## (P4-24); until then no release is revoked.
func _revoked(sha256: String) -> bool:
	return engine.has_method("is_revoked") and engine.call("is_revoked", sha256) == true


static func _target_ok(t: Variant) -> bool:
	if not (t is Dictionary) or not (t.get("pack") is String) or not (t.get("release") is Dictionary):
		return false
	var r: Dictionary = t["release"]
	return r.get("sha256") is String and r.has("seq") and r.has("version")


## Memoise a verified record's facts by its hash, with the pack it belongs to (`deliverable`), so
## a memo hit never answers for a target that names the hash under another pack.
func _remember(sha256: String, rec: Variant) -> Dictionary:
	var f := facts(rec)
	var d = (rec as Dictionary).get("deliverable") if rec is Dictionary else null
	f["pack"] = d if d is String else ""
	if _memo.size() >= MAX_MEMO:
		_memo.clear()
	_memo[sha256] = f
	return f


## The facts of an install the engine verified: its verified record, else its stored JWS decoded.
func _facts_of_install(i: Dictionary) -> Dictionary:
	var sha := String(i.get("recordSha256", ""))
	if _memo.has(sha):
		return _memo[sha]
	var rec = engine.records.get(sha)
	if not (rec is Dictionary):
		rec = verified_payload_of(i.get("record"))
	return _remember(sha, rec)


## A target's facts: from an install or embedded baseline of that release, else its record
## fetched and verified; null when that fails. A coroutine.
func _target_facts(t: Dictionary) -> Variant:
	var pack_id: String = t["pack"]
	var rel: Dictionary = t["release"]
	var sha: String = rel["sha256"]
	if _memo.has(sha) and _memo[sha]["pack"] == pack_id:
		return _memo[sha]
	for i in [engine.doc["active"].get(pack_id), engine.doc["previous"].get(pack_id), engine.running.get(pack_id), engine._embedded.get(pack_id)]:
		if i is Dictionary and i.get("recordSha256") == sha and i.get("packId") == pack_id:
			return _facts_of_install(i)
	var rec = await _fetch_verified(pack_id, rel)
	if rec == null:
		return null
	return _remember(sha, rec)


## Preflight step 2 for one target: the record fetched by hash and verified against the pinned
## release keys with `pin: {kind: "pack", deliverable, version, seq}`. The verified record, or null.
func _fetch_verified(pack_id: String, rel: Dictionary) -> Variant:
	var sha: String = rel["sha256"]
	var got: Dictionary = await engine.transport.fetch_record(sha)
	if not got.get("ok", false):
		return null
	var v: Dictionary = await PKeyReleaseRecord.verify_release_record(got["body"], {
		"release_keys": engine.release_keys, "product_trust": engine.product_trust.call() if engine.product_trust.is_valid() else {},
		"expected_aud": engine.product, "expected_hash": sha, "offload": engine.offload,
		"pin": {"kind": "pack", "deliverable": pack_id, "version": rel["version"], "seq": rel["seq"]},
	})
	if not v["ok"]:
		return null
	engine.records[sha] = v["record"]
	return v["record"]
