class_name PKeyPackRevocations
extends RefCounted
## The device's revocations (plans/P4-13.md §2.5 "Persistence"): a port of client-core
## `packs/revocations.ts`. A sibling document, `revocations.json`, beside the pack state and never
## inside it, so an unparseable `state.json` cannot lose revocations and a lost revocation file
## cannot touch the install state:
##
##   {v: 1, revoked: {targetSha256: {jws, pack, version, seq, record, issuedAt}}, relearn: [packId]}
##
## Each entry holds the winning revocation's compact JWS verbatim, the pin it was verified with
## (the feed entry's `pack`, `version`, `seq`), its record hash and its `issuedAt`. The document is
## NEVER trusted from storage: `reload` re-verifies every entry against the currently pinned
## release keys and the stored pin, and a failing entry is dropped alone. A key that is no longer
## pinned forgets its target (the key-rotation recovery lever for a stolen release key); any other
## failure adds the entry's pack to `relearn`, cleared only by a fresh, network-verified feed whose
## `revocations` member is present and usable, or by `recover_state()`.
##
## Pure functions over the document: each returns a new document and changes nothing in place.
## PKeyPackEngine owns the I/O (PKeyPackStorage's `revocations_*`), the `revocationsStored` flag in
## `state.json` and the mount refusals. Nothing here indexes a const Array.

const VERSION := 1
## A device keeps at most this many revoked targets; beyond it the oldest by `issuedAt` (then the
## lower record hash) is dropped first, and its pack is NOT added to `relearn`: dropping at the cap
## is deliberate.
const MAX_STORED_REVOCATIONS := 256


static func empty() -> Dictionary:
	return {"v": VERSION, "revoked": {}, "relearn": []}


## True when the document holds nothing (the state a product with no revocations is in).
static func is_empty(doc: Dictionary) -> bool:
	return (doc["revoked"] as Dictionary).is_empty() and (doc["relearn"] as Array).is_empty()


static func _nat(v: Variant) -> bool:
	return (v is float or v is int) and is_finite(float(v)) and float(v) == floorf(float(v)) and float(v) >= 0.0 and float(v) <= 9007199254740991.0


static func _sorted(list: Array) -> Array:
	var out := list.duplicate()
	out.sort_custom(func(a, b): return PKeyPackClaims.compare_bytes(String(a), String(b)) < 0)
	return out


## Parse the stored text's shape (Godot's own JSON, like the state document: the file is the
## SDK's own, re-verified entry by entry anyway). null when it does not parse as the document at
## all (a torn file, which the engine quarantines). Entries of the wrong shape are dropped with
## their pack (if it can be read) added to `relearn`: shape only, `reload` decides what is trusted.
static func parse(text: Variant) -> Variant:
	if not (text is String) or (text as String).strip_edges() == "":
		return null
	var j := JSON.new()
	if j.parse(text) != OK:
		return null
	var doc = j.data
	if not (doc is Dictionary) or not PKeyPackClaims.same(doc.get("v"), VERSION):
		return null
	if not (doc.get("revoked") is Dictionary) or not (doc.get("relearn") is Array):
		return null
	var out := empty()
	var relearn := {}
	for p in doc["relearn"]:
		if PKeyPackClaims.is_pack_id(p):
			relearn[p] = true
	for target in doc["revoked"]:
		var e = doc["revoked"][target]
		var ok: bool = PKeyPackClaims.is_sha256(target) and e is Dictionary and e.get("jws") is String \
				and PKeyPackClaims.is_pack_id(e.get("pack")) and e.get("version") is String \
				and _nat(e.get("seq")) and float(e["seq"]) >= 1.0 and PKeyPackClaims.is_sha256(e.get("record")) \
				and _nat(e.get("issuedAt"))
		if ok:
			out["revoked"][target] = {
				"jws": e["jws"], "pack": e["pack"], "version": e["version"], "seq": int(e["seq"]),
				"record": e["record"], "issuedAt": int(e["issuedAt"]),
			}
		elif e is Dictionary and PKeyPackClaims.is_pack_id(e.get("pack")):
			relearn[e["pack"]] = true
	out["relearn"] = _sorted(relearn.keys())
	return out


static func serialize(doc: Dictionary) -> String:
	return JSON.stringify(doc)


## The protected header's `kid`, read without trusting anything else; null when there is none.
static func kid_of(jws: String) -> Variant:
	var raw = PKeyB64Url.decode_lenient(jws.get_slice(".", 0))
	if not (raw is PackedByteArray):
		return null
	var parsed := PKeyJson.parse_bytes(raw)
	if not parsed["ok"] or not (parsed["value"] is Dictionary) or not (parsed["value"].get("kid") is String):
		return null
	return parsed["value"]["kid"]


## Re-verify every entry against the currently pinned release keys and its stored pin (`target` =
## the map key, `record` = the stored hash). A failing entry is dropped alone: a key that is no
## longer pinned forgets the target; any other failure adds the entry's pack to `relearn`.
## `opts`: {release_keys, product_trust, expected_aud, offload?}. A coroutine returning
## {doc, verified: {target: verified revocation}, changed}.
static func reload(doc: Dictionary, opts: Dictionary) -> Dictionary:
	var out := {"v": VERSION, "revoked": {}, "relearn": (doc["relearn"] as Array).duplicate()}
	var verified := {}
	var changed := false
	var relearn := {}
	for p in out["relearn"]:
		relearn[p] = true
	var keys: Dictionary = opts.get("release_keys", {}) if opts.get("release_keys") is Dictionary else {}
	for target in doc["revoked"]:
		var e: Dictionary = doc["revoked"][target]
		var r: Dictionary = await PKeyReleaseRecord.verify_revocation(e["jws"], {
			"release_keys": keys, "product_trust": opts.get("product_trust", {}),
			"expected_aud": opts.get("expected_aud", ""), "offload": opts.get("offload", false),
			"entry": {"record": e["record"], "pack": e["pack"], "target": target, "version": e["version"], "seq": e["seq"]},
		})
		if r["ok"]:
			out["revoked"][target] = e
			verified[target] = r["revocation"]
			continue
		changed = true
		var kid = kid_of(e["jws"])
		var rotated: bool = r["step"] == PKeyReleaseRecord.STEP_JWS and kid is String and not keys.has(kid)
		if not rotated:
			relearn[e["pack"]] = true
	out["relearn"] = _sorted(relearn.keys())
	return {"doc": out, "verified": verified, "changed": changed}


## Store a verified revocation (plans/P4-13.md §2.5 step 11): kept when its target is new, or when
## newer_revocation ranks it above the stored one (a superseding revocation). Then the cap.
## `stored`: the verified revocation stored for the target, when known (else the stored entry's
## record and issuedAt rank it). Returns {doc, changed}.
static func store(doc: Dictionary, revocation: Dictionary, jws: String, stored: Variant = null) -> Dictionary:
	var target: String = revocation["target"]
	var prev = doc["revoked"].get(target)
	if prev is Dictionary:
		if prev["record"] == revocation["record"]:
			return {"doc": doc, "changed": false}
		var other: Dictionary = stored if stored is Dictionary else {"issuedAt": prev["issuedAt"], "record": prev["record"]}
		if not is_same(PKeyReleaseRecord.newer_revocation(revocation, other), revocation):
			return {"doc": doc, "changed": false}
	var revoked: Dictionary = (doc["revoked"] as Dictionary).duplicate()
	revoked[target] = {
		"jws": jws, "pack": revocation["pack"], "version": revocation["version"], "seq": int(revocation["seq"]),
		"record": revocation["record"], "issuedAt": int(revocation["issuedAt"]),
	}
	var next := {"v": VERSION, "revoked": revoked, "relearn": (doc["relearn"] as Array).duplicate()}
	return {"doc": cap(next), "changed": true}


## Keep at most MAX_STORED_REVOCATIONS targets: the oldest by `issuedAt` (then the lower record
## hash) is dropped first, without adding its pack to `relearn`.
static func cap(doc: Dictionary) -> Dictionary:
	var revoked: Dictionary = doc["revoked"]
	if revoked.size() <= MAX_STORED_REVOCATIONS:
		return doc
	var targets: Array = revoked.keys()
	targets.sort_custom(func(a, b):
		var x: Dictionary = revoked[a]
		var y: Dictionary = revoked[b]
		if float(x["issuedAt"]) != float(y["issuedAt"]):
			return float(x["issuedAt"]) > float(y["issuedAt"])
		return PKeyPackClaims.compare_bytes(String(x["record"]), String(y["record"])) > 0)
	var keep := {}
	for i in MAX_STORED_REVOCATIONS:
		keep[targets[i]] = revoked[targets[i]]
	return {"v": VERSION, "revoked": keep, "relearn": (doc["relearn"] as Array).duplicate()}


## Clear `relearn` for the given packs: {doc, changed}.
static func clear_relearn(doc: Dictionary, packs: Array) -> Dictionary:
	if packs.is_empty():
		return {"doc": doc, "changed": false}
	var relearn: Array = []
	for p in doc["relearn"]:
		if not packs.has(p):
			relearn.append(p)
	if relearn.size() == (doc["relearn"] as Array).size():
		return {"doc": doc, "changed": false}
	return {"doc": {"v": VERSION, "revoked": doc["revoked"], "relearn": relearn}, "changed": true}
