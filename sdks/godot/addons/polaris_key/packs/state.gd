class_name PKeyPackState
extends RefCounted
## The pack install-state machine (CONTENT §9 "Install state", §10; plans/P4-01.md §2.13): a port
## of client-core `packs/state.ts`. One document per product, written by atomic replace:
##
##   active            pack id → the install the next boot (and, for `hot` packs, this process) uses
##   previous          pack id → the install `active` replaced, kept for `rollback`
##   inflight          pack id → the journal of an install in progress, for resume
##   observed          what a platform transport reported (P5-08); carried, never interpreted
##   confirmedBootSeq  the last boot `confirm` marked healthy; `bootSeq` counts loads
##   confirmed         (Godot) pack id → the record SHA-256 that was RUNNING when the last boot was
##                     confirmed: the shared boot guard rolls back an active install that differs
##                     from it after two failed boots (PKeyBootGuard)
##
## The document is NEVER trusted from storage: each install and journal carries its pack record's
## compact JWS verbatim, re-verified at every load through the caller's verifier before anything
## uses it; what fails is dropped, never repaired. Pure functions: each returns a new document.

const VERSION := 1

static var _plan_id_re: RegEx = null


static func empty() -> Dictionary:
	return {"v": VERSION, "active": {}, "previous": {}, "inflight": {}, "observed": {}, "confirmedBootSeq": 0, "bootSeq": 0, "confirmed": {}}


static func _nat(v: Variant) -> bool:
	return (v is float or v is int) and is_finite(float(v)) and float(v) == floorf(float(v)) and float(v) >= 0.0 and float(v) <= 9007199254740991.0


static func _install(v: Variant, pack_id: String) -> Variant:
	if not (v is Dictionary):
		return null
	if not PKeyPackClaims.same(v.get("packId"), pack_id) or not PKeyPackClaims.is_pack_id(pack_id):
		return null
	for k in PackedStringArray(["record", "version", "type", "variant", "layout", "location"]):
		if not (v.get(k) is String):
			return null
	if not PKeyPackClaims.is_sha256(v.get("recordSha256")) or not PKeyPackClaims.is_sha256(v.get("payloadSha256")):
		return null
	if not _nat(v.get("seq")) or not _nat(v.get("payloadSize")) or not _nat(v.get("installedAt")):
		return null
	if v.has("embedded") and not (v["embedded"] is bool):
		return null
	if not PKeyPackClaims.same(v.get("activation"), "hot") and not PKeyPackClaims.same(v.get("activation"), "restart"):
		return null
	return v


static func _journal(v: Variant, pack_id: String) -> Variant:
	if not (v is Dictionary) or not PKeyPackClaims.same(v.get("packId"), pack_id) or not PKeyPackClaims.is_pack_id(pack_id):
		return null
	for k in PackedStringArray(["planId", "record", "variant", "strategy"]):
		if not (v.get(k) is String):
			return null
	if not PKeyPackClaims.is_sha256(v.get("recordSha256")):
		return null
	if v.has("delta") and not (v["delta"] is String):
		return null
	if _plan_id_re == null:
		_plan_id_re = PKeyClaims.whole("[A-Za-z0-9_-]{1,64}")
	if not PKeyClaims.matches_whole_re(_plan_id_re, v["planId"]):
		return null
	if not _nat(v.get("startedAt")) or not (v.get("objects") is Array):
		return null
	for o in v["objects"]:
		if not (o is Dictionary) or not PKeyPackClaims.is_sha256(o.get("sha256")) or not _nat(o.get("bytes")) or not _nat(o.get("done")) or float(o["done"]) > float(o["bytes"]):
			return null
	return v


## Whether stored text is at least a version-1 state document's shape (Godot's own lenient JSON:
## the document is the SDK's own file, re-verified entry by entry anyway).
static func looks_like_state(text: String) -> bool:
	var j := JSON.new()
	if j.parse(text) != OK:
		return false
	return j.data is Dictionary and PKeyPackClaims.same(j.data.get("v"), VERSION)


## Parse the stored document's shape. Anything malformed is dropped entry by entry (a document
## that does not parse at all is the empty state). Shape only: `reload` decides what is trusted.
static func parse(text: Variant) -> Dictionary:
	var out := empty()
	if not (text is String):
		return out
	var j := JSON.new()
	if j.parse(text) != OK:
		return out
	var doc = j.data
	if not (doc is Dictionary) or not PKeyPackClaims.same(doc.get("v"), VERSION):
		return out
	for slot in PackedStringArray(["active", "previous"]):
		var m = doc.get(slot)
		if not (m is Dictionary):
			continue
		for id in m:
			var i = _install(m[id], String(id))
			if i != null:
				out[slot][String(id)] = i
	if doc.get("inflight") is Dictionary:
		for id in doc["inflight"]:
			var jn = _journal(doc["inflight"][id], String(id))
			if jn != null:
				out["inflight"][String(id)] = jn
	if doc.get("observed") is Dictionary:
		out["observed"] = (doc["observed"] as Dictionary).duplicate(true)
	if _nat(doc.get("confirmedBootSeq")):
		out["confirmedBootSeq"] = int(doc["confirmedBootSeq"])
	if _nat(doc.get("bootSeq")):
		out["bootSeq"] = int(doc["bootSeq"])
	if out["confirmedBootSeq"] > out["bootSeq"]:
		out["confirmedBootSeq"] = out["bootSeq"]
	if doc.get("confirmed") is Dictionary:
		for id in doc["confirmed"]:
			if PKeyPackClaims.is_pack_id(id) and PKeyPackClaims.is_sha256(doc["confirmed"][id]):
				out["confirmed"][String(id)] = doc["confirmed"][id]
	return out


static func serialize(state: Dictionary) -> String:
	return JSON.stringify(state)


## The reload path: every install and journal goes through `verifier` (an object with coroutines
## `install(i) -> bool` and `journal(j) -> bool`), and only what passes survives. `bootSeq` counts
## this load. A `previous` equal to its `active` is dropped. A coroutine.
static func reload(state: Dictionary, verifier: Object) -> Dictionary:
	var out := empty()
	out["observed"] = state["observed"]
	out["confirmedBootSeq"] = state["confirmedBootSeq"]
	out["bootSeq"] = int(state["bootSeq"]) + 1
	out["confirmed"] = state.get("confirmed", {})
	for id in state["active"]:
		if await verifier.install(state["active"][id]) == true:
			out["active"][id] = state["active"][id]
	for id in state["previous"]:
		var i: Dictionary = state["previous"][id]
		if out["active"].has(id) and out["active"][id]["recordSha256"] == i["recordSha256"]:
			continue
		if await verifier.install(i) == true:
			out["previous"][id] = i
	for id in state["inflight"]:
		if await verifier.journal(state["inflight"][id]) == true:
			out["inflight"][id] = state["inflight"][id]
	return out


## Start (or restart) a plan: its journal becomes the pack's `inflight`.
static func begin_install(state: Dictionary, journal: Dictionary) -> Dictionary:
	var out := state.duplicate(true)
	out["inflight"][journal["packId"]] = journal.duplicate(true)
	return out


## Record how many bytes of one staged object are done.
static func checkpoint(state: Dictionary, pack_id: String, sha256: String, done: int) -> Dictionary:
	if not state["inflight"].has(pack_id):
		return state
	var out := state.duplicate(true)
	for o in out["inflight"][pack_id]["objects"]:
		if o["sha256"] == sha256:
			o["done"] = mini(done, int(o["bytes"]))
	return out


## Abandon a plan (its staging becomes garbage).
static func abandon_install(state: Dictionary, pack_id: String) -> Dictionary:
	if not state["inflight"].has(pack_id):
		return state
	var out := state.duplicate(true)
	out["inflight"].erase(pack_id)
	return out


## Commit a verified install: the pointer swap. `active` becomes the new install, the install it
## replaces becomes `previous` (unless it is the same release), and the journal is closed.
static func commit_install(state: Dictionary, install: Dictionary) -> Dictionary:
	var out := state.duplicate(true)
	var id: String = install["packId"]
	var old = out["active"].get(id)
	if old is Dictionary and old["recordSha256"] != install["recordSha256"]:
		out["previous"][id] = old
	out["inflight"].erase(id)
	out["active"][id] = install.duplicate(true)
	return out


## Roll a pack back to `previous`: {state, rolled_back}. Unchanged when there is none.
static func rollback_install(state: Dictionary, pack_id: String) -> Dictionary:
	var prev = state["previous"].get(pack_id)
	if not (prev is Dictionary):
		return {"state": state, "rolled_back": false}
	var out := state.duplicate(true)
	out["previous"].erase(pack_id)
	out["active"][pack_id] = prev.duplicate(true)
	return {"state": out, "rolled_back": true}


## Mark this boot healthy (CONTENT §10 step 7). `running`: pack id → the record SHA-256 running
## in this process (Godot keeps it as `confirmed`, for the shared boot guard).
static func confirm_boot(state: Dictionary, running: Dictionary = {}) -> Dictionary:
	var out := state.duplicate(true)
	out["confirmedBootSeq"] = out["bootSeq"]
	out["confirmed"] = running.duplicate(true)
	return out


## The packs whose active install is not the release confirmed last time (a new set the shared
## boot guard counts and may roll back), in pack-id order.
static func pending(state: Dictionary) -> PackedStringArray:
	var out := PackedStringArray()
	var confirmed: Dictionary = state.get("confirmed", {})
	for id in state["active"]:
		if not PKeyPackClaims.same(confirmed.get(id), state["active"][id]["recordSha256"]):
			out.append(id)
	out.sort()
	return out


## `roots()` (CONTENT §4.1): the locations of every active and previous install and of every
## extra install given (embedded baselines, the running set), and the plan ids of every journal.
## {locations: Dictionary used as a set, plans: Dictionary used as a set}.
static func gc_roots(state: Dictionary, extra: Array = []) -> Dictionary:
	var locations := {}
	for id in state["active"]:
		locations[state["active"][id]["location"]] = true
	for id in state["previous"]:
		locations[state["previous"][id]["location"]] = true
	for e in extra:
		locations[e["location"]] = true
	var plans := {}
	for id in state["inflight"]:
		plans[state["inflight"][id]["planId"]] = true
	return {"locations": locations, "plans": plans}
