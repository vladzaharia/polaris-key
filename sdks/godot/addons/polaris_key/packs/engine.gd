class_name PKeyPackEngine
extends RefCounted
## The pack pipeline (CONTENT §10; plans/P4-01.md §2.6, §2.9): a port of client-core
## `packs/engine.ts` (`PackEngine`) over the Godot ports — PKeyPackStorage, a PKeyPackTransport,
## PKeyPackZstd and HashingContext. For each pack id `ensure` asks for:
##
##  1. the content stamp's pin (a host without a stamp has no packs, §2.8);
##  2. the pinned pack record, fetched by hash and verified against the pinned release keys with
##     `pin: {kind: "pack", deliverable, version, seq}` (V4 §3.5 steps 12–15);
##  3. its type (a registered handler for `type` and `formatVersion`), its entitlement (a licence
##     without the flag leaves the pack out), the variant (`select_variant`);
##  4. the target files index when the layout is `tree` or a release of the pack is installed;
##     `plan_target` and `plan`, with the host's free disk and memory budget;
##  5. a journal, then each object fetched with `Range`/`If-Range` into staging, resumed from what
##     is staged (re-hashed, never trusted), checkpointed;
##  6. the applier; on a refusal, the next fallback (`full` always last);
##  7. the handler's output check (godot.pck: the header and the directory), commit (the payload
##     moves into the store after it is read back and hashed, then the state's pointer swap),
##     activation (`hot` now; `restart` at the next boot), and garbage collection.
##
## The install state is hardened exactly as P4-06's: a state read answers "missing" ONLY when
## there is no file and anything else makes the state `unreadable` (nothing is written, fetched or
## installed this process: `pack-state-unreadable`); a document that exists but does not parse is
## torn: held aside as `state.json.torn` before anything replaces it, and garbage collection waits
## (its snapshot of the store is kept as `state.json.torn.list` and reused by later loads, so the
## store stays bounded across restarts; a snapshot that cannot be read holds GC entirely) until
## `recover_state()`. An install whose payload check raised (an I/O error, not a mismatch) stays in
## the written document, out of the running set and the planner, and out of GC, for `active` and
## `previous` alike; a fresh commit over a deferred active install carries it over to `previous`,
## re-verified before a rollback uses it. A listing that fails is never planned from.
##
## Revocations (plans/P4-13.md §2.5) live in the sibling `revocations.json` (PKeyPackRevocations,
## PKeyPackStorage's `revocations_*`), never inside `state.json`. A release a verified revocation
## names is never installed, activated or mounted (`pack-revoked`), embedded baselines and pinned
## packs included, and a rollback never goes back to one. The file is written only once the first
## entry is stored (`revocationsStored: true` in `state.json` first, then the file); absent is the
## empty document. Can't-read is never missing: an unreadable file writes nothing this process and,
## with `revocationsStored` set, refuses the embedded mount of every pack the stamp pins or the host
## embeds (`pack-revoked`, detail `relearn`); a torn one is quarantined and replaced by a fresh
## document whose `relearn` holds those packs. Each entry is re-verified at load against the pinned
## release keys; a dropped entry adds its pack to `relearn` unless its key is simply no longer
## pinned. A pack in `relearn` has its embedded baseline refused at every boot (online the pack is
## fetched instead) until a fresh feed re-teaches it or `recover_state()` clears it; at most 256
## targets are kept (the oldest dropped first). A product with no revocations has no file, no flag
## and no `relearn`, so nothing here can refuse a mount: it behaves exactly as before.
##
## Every call is a coroutine returning a PKeyResult (or a Dictionary for `estimate`); calls are
## serialised. Progress: `progress(event)` with {packId, phase: download | apply | done |
## state-issue, done, total, issue?}.

signal progress(event: Dictionary)
signal _released

## The product: every record's `aud`.
var product := ""
## The PINNED release keys (`PKeyOptions.pinned_release_keys`), the only keys a pack record
## verifies against.
var release_keys := {}
## () -> Dictionary: the effective product trust set (a release key also in it is refused).
var product_trust := Callable()
## The running build's content stamp (`parse_content_stamp`'s `content`), or null: no packs.
var stamp: Variant = null
## Variant preferences: {engine: "godot-<major>.<minor>", axes: {axis: [values…]}}.
var prefs := {"engine": null, "axes": {}}
var zstd := PKeyPackZstd.new()
## `zstd-patch-from` when the engine's GDDL route is pinned and its probe passed; empty otherwise.
var patch_methods: Array = []
## The memory budget for one delta frame (`memBytes`).
var mem_budget := 256 * 1024 * 1024
## The strategies to cost (v1 lists no `chunk`).
var strategies: Array = ["delta", "file", "full"]
var transports: Array = ["pkey-cdn"]
var storage: PKeyPackStorage
var transport: PKeyPackTransport = PKeyPackTransport.new()
## () -> Dictionary used as a set of granted flags, or null when the product runs no License.
var entitlements := Callable()
## () -> int epoch seconds.
var now := Callable()
## () -> String: fresh plan ids (`[A-Za-z0-9_-]{1,64}`).
var new_plan_id := Callable()
## Write the journal every this many staged bytes.
var checkpoint_bytes := 8 << 20
## The most one buffered `full` decode may hold (the stored frame plus its payload); -1: no bound.
## Godot's decompress cannot stream, so a larger `full` candidate is dropped before planning.
var one_shot_budget := -1
## Record verifies run off the main thread (PKeyJws.verify_async).
var offload := true

var handlers := {}
## The pack releases activated in this process, by pack id.
var running := {}
## Why this load could not trust the state document: "", "torn" or "unreadable".
var state_issue := ""
## The state document, once loaded.
var doc: Variant = null
## Every pack record verified this process, by its SHA-256 (the mount reads `handler`).
var records := {}
## The sibling `revocations.json` (plans/P4-13.md §2.5). Off: revocations live in memory for the
## life of the process only.
var revocations_enabled := true
## The revocations document as loaded and updated (PKeyPackRevocations).
var rev_doc := PKeyPackRevocations.empty()
## Why `revocations.json` could not be trusted: "", "torn" (quarantined and replaced) or
## "unreadable" (nothing is written to it this process).
var rev_issue := ""

var _embedded := {}
var _unverifiable := {}
var _deferred := {"active": {}, "previous": {}}
var _gc_hold := false
var _hold_snapshot: Variant = null
var _unverified_previous := {}
var _preflight_plans := {}
var _busy := false
## Every revocation verified in this process (loaded or learned), by target.
var _rev_verified := {}
## The JWS of each revocation learned in this process, by target.
var _rev_jws := {}
## Whether `revocations.json` exists (it is never created empty).
var _rev_file := false
## The last object fetch was refused with 403 (P4-05: `delivery_gate_missing`, `not_entitled`).
var _denied := false


func _init(p_storage: PKeyPackStorage = null) -> void:
	storage = p_storage if p_storage != null else PKeyPackStorage.new()
	PKeyPackClaims.warm()
	PKeyPck.warm()
	register_handler(PKeyFilesTreeHandler.new())
	register_handler(PKeyGodotPckHandler.new())
	register_handler(PKeyGodotZipHandler.new())
	register_handler(PKeyDataJsonHandler.new())
	register_handler(PKeyL10nTableHandler.new())
	now = func() -> int: return int(Time.get_unix_time_from_system())
	new_plan_id = func() -> String: return Crypto.new().generate_random_bytes(12).hex_encode()


## Add or replace a handler for a pack type (CONTENT §4.1 custom types). False when it is not
## shaped right ({type, layout, activation, supports}).
func register_handler(handler: Object) -> bool:
	if not PKeyPackHandler.valid(handler):
		return false
	handlers[handler.get("type")] = handler
	return true


# ── Serialisation and errors ────────────────────────────────────────────────────────────────

func _enter() -> void:
	while _busy:
		await _released
	_busy = true


func _leave() -> void:
	_busy = false
	_released.emit()


static func _err(code: String, message: String, pack_id := "", extra: Dictionary = {}) -> Dictionary:
	var d := {"packId": pack_id}
	d.merge(extra)
	return {"error": {"code": code, "message": message, "detail": d}}


static func _result(e: Dictionary) -> PKeyResult:
	return PKeyResult.failure(StringName(e["code"]), e["message"], e["detail"])


func _emit(e: Dictionary) -> void:
	progress.emit(e)


func _refuse_unreadable() -> Variant:
	if doc == null:
		return _err(String(PKeyErrors.NOT_CONFIGURED), "Call load() before using packs.")
	if state_issue == "unreadable":
		return _err(PKeyConstants.ErrorCode.PACK_STATE_UNREADABLE, "The pack state could not be read, so nothing is fetched, written or installed this process.")
	return null


## Write the document: entries whose payload check raised stay in it for the next load. "" when
## written, else the code (`pack-state-unreadable` while the state is unknown, `store-failed`).
func _persist() -> String:
	if state_issue == "unreadable":
		return PKeyConstants.ErrorCode.PACK_STATE_UNREADABLE
	var out: Dictionary = doc.duplicate(true)
	var active: Dictionary = _deferred["active"].duplicate(true)
	active.merge(doc["active"], true)
	var previous: Dictionary = _deferred["previous"].duplicate(true)
	previous.merge(doc["previous"], true)
	out["active"] = active
	out["previous"] = previous
	for id in doc["active"]:
		if previous.has(id) and active.has(id) and previous[id]["recordSha256"] == active[id]["recordSha256"]:
			previous.erase(id)
	if not storage.state_replace(PKeyPackState.serialize(out)):
		return String(PKeyErrors.STORE_FAILED)
	return ""


# ── Load ────────────────────────────────────────────────────────────────────────────────────

## Load the state (re-verifying every entry), register the embedded baselines (each marker
## verified once, its bytes matched, its pin checked against the stamp), activate what this boot
## runs, persist the document and collect garbage. Run once, before `ensure`. `embedded`: the
## transport's baselines ({marker, location, payload} or {location, error}). A coroutine
## returning {refused: [{location, step}]}.
func load_state(embedded: Array = []) -> Dictionary:
	await _enter()
	var refused: Array = []
	for e in embedded:
		if e.has("error"):
			refused.append({"location": e["location"], "step": String(e["error"])})
			continue
		var r: Dictionary = await _verify_embedded(e)
		if not r["ok"]:
			refused.append({"location": e["location"], "step": r["step"]})
		else:
			_embedded[r["install"]["packId"]] = r["install"]
	storage.repair_bakes()
	# The state. A read answers "missing" only when there is no document; anything else means the
	# document is unknown, so nothing may be written over it or collected this process.
	var text = null
	var unreadable := false
	var read := storage.state_read()
	if not read["ok"]:
		unreadable = true
	else:
		text = read["text"]
	var torn: bool = not unreadable and text is String and (text as String).strip_edges() != "" and not PKeyPackState.looks_like_state(text)
	if torn and not storage.state_quarantine(text):
		unreadable = true
	var held := false
	if not unreadable:
		held = torn or storage.state_quarantined() != 0
	state_issue = "unreadable" if unreadable else ("torn" if held else "")
	_gc_hold = unreadable
	if held:
		var listed = _hold_list()
		if listed == null:
			_gc_hold = true
		else:
			var locs := {}
			var plans := {}
			for l in listed["locations"]:
				locs[l] = true
			for p in listed["plans"]:
				plans[p] = true
			_hold_snapshot = {"locations": locs, "plans": plans}
	if state_issue != "":
		_emit({"packId": "", "phase": "state-issue", "done": 0, "total": 0, "issue": state_issue})
	var parsed := PKeyPackState.parse(null if torn else text)
	var verifier := _Verifier.new(self)
	doc = await PKeyPackState.reload(parsed, verifier)
	for id in parsed["active"]:
		if verifier.deferred.has(parsed["active"][id]):
			_deferred["active"][id] = parsed["active"][id]
	for id in parsed["previous"]:
		if verifier.deferred.has(parsed["previous"][id]):
			_deferred["previous"][id] = parsed["previous"][id]
	# plans/P4-13.md §2.5: the sibling revocations, before anything mounts.
	await _load_revocations(unreadable)
	# This boot's set: every active install (restart packs mount at this boot), else the embedded
	# baseline. A revoked release never activates or mounts (`pack-revoked`).
	for id in doc["active"]:
		if not is_revoked(doc["active"][id]["recordSha256"]):
			await _activate(doc["active"][id])
	for id in _embedded:
		if not running.has(id) and not _embedded_refused(_embedded[id]):
			await _activate(_embedded[id])
	if not unreadable:
		_persist()
	_collect()
	_leave()
	return {"refused": refused}


## The reload verifier: the record re-verified, then the payload re-checked (a check that raised
## keeps the entry deferred: in the document, out of use, out of GC).
class _Verifier extends RefCounted:
	var engine: PKeyPackEngine
	var deferred: Array = []

	func _init(e: PKeyPackEngine) -> void:
		engine = e

	func install(i: Dictionary) -> bool:
		if not await engine._verify_stored_record(i["record"], i["recordSha256"], i["packId"], i):
			return false
		# An embedded baseline registered this process was measured and matched already.
		var e = engine._embedded.get(i["packId"])
		if i.get("embedded") == true and e is Dictionary and e["location"] == i["location"] and e["payloadSha256"] == i["payloadSha256"]:
			return true
		var st: int = await PKeyPackJob.run(engine.storage.verify.bind(i), "PolarisKey pack verify")
		if st < 0:
			engine._unverifiable[i["location"]] = true
			deferred.append(i)
			return false
		return st == 1

	func journal(j: Dictionary) -> bool:
		return await engine._verify_stored_record(j["record"], j["recordSha256"], j["packId"])


## The torn hold's snapshot: the saved one, else the store's listing now (saved). null when it
## cannot be known (an unreadable snapshot or listing).
func _hold_list() -> Variant:
	var saved := storage.state_read_hold_list()
	if not saved["ok"]:
		return null
	if saved["text"] is String:
		var j := JSON.new()
		if j.parse(saved["text"]) == OK and j.data is Dictionary and j.data.get("locations") is Array and j.data.get("plans") is Array:
			for x in j.data["locations"] + j.data["plans"]:
				if not (x is String):
					return null
			return j.data
		return null
	var listed = storage.list()
	if listed == null:
		return null
	if not storage.state_write_hold_list(JSON.stringify(listed)):
		return null
	return listed


# ── Queries ─────────────────────────────────────────────────────────────────────────────────

## The install state and this process's running set: {active, previous, inflight, running,
## confirmedBootSeq, bootSeq, stateIssue}. Empty before load().
func state() -> Dictionary:
	if doc == null:
		return {}
	var inflight := {}
	for id in doc["inflight"]:
		var j: Dictionary = doc["inflight"][id]
		var done := 0
		var total := 0
		for o in j["objects"]:
			done += int(o["done"])
			total += int(o["bytes"])
		inflight[id] = {"planId": j["planId"], "strategy": j["strategy"], "done": done, "total": total}
	return {
		"active": doc["active"].duplicate(true), "previous": doc["previous"].duplicate(true), "inflight": inflight,
		"running": running.duplicate(true), "confirmedBootSeq": doc["confirmedBootSeq"], "bootSeq": doc["bootSeq"],
		"stateIssue": state_issue if state_issue != "" else null,
	}


## The bytes of a pack's running install ({payload, files}), or null.
func open(pack_id: String) -> Variant:
	return storage.installed(running[pack_id]) if running.has(pack_id) else null


## `packSetId` of the running set (§2.9), for `devices/report`'s `content`.
func pack_set_id() -> Variant:
	var entries: Array = []
	for id in running:
		entries.append({"packId": id, "releaseSha256": running[id]["recordSha256"]})
	return PKeyPackClaims.pack_set_id(entries)


## The packs whose active install is not the release confirmed last time (PKeyPackState.pending).
func pending() -> PackedStringArray:
	return PKeyPackState.pending(doc) if doc != null else PackedStringArray()


# ── Commands ────────────────────────────────────────────────────────────────────────────────

## Mark this boot healthy (CONTENT §10 step 7): the running set becomes the confirmed one. A
## coroutine.
func confirm() -> PKeyResult:
	await _enter()
	var bad = _refuse_unreadable()
	if bad != null:
		_leave()
		return _result(bad["error"])
	var set := {}
	for id in running:
		set[id] = running[id]["recordSha256"]
	doc = PKeyPackState.confirm_boot(doc, set)
	var code := _persist()
	_leave()
	return PKeyResult.success() if code == "" else PKeyResult.failure(StringName(code), "The pack state could not be written.")


## Re-point a pack at `previous`. A hot pack switches now; a restart pack at the next boot. A
## coroutine: ok with detail true when it rolled back, false when there was nothing to roll back
## to (or the carried-over previous no longer verifies).
func rollback(pack_id: String) -> PKeyResult:
	await _enter()
	var r := await _rollback_one(pack_id)
	_leave()
	return r


func _rollback_one(pack_id: String) -> PKeyResult:
	var bad = _refuse_unreadable()
	if bad != null:
		return _result(bad["error"])
	var before = doc["active"].get(pack_id)
	var prev = doc["previous"].get(pack_id)
	# plans/P4-13.md §2.5: never back to a revoked release.
	if prev is Dictionary and is_revoked(prev["recordSha256"]):
		return PKeyResult.success(false)
	if prev is Dictionary and _unverified_previous.has(pack_id):
		var ok: bool = await _verify_stored_record(prev["record"], prev["recordSha256"], pack_id, prev)
		if ok:
			ok = await PKeyPackJob.run(storage.verify.bind(prev), "PolarisKey pack verify") == 1
		if not ok:
			return PKeyResult.success(false)
		_unverified_previous.erase(pack_id)
	var r := PKeyPackState.rollback_install(doc, pack_id)
	if not r["rolled_back"]:
		return PKeyResult.success(false)
	doc = r["state"]
	var code := _persist()
	if code != "":
		return PKeyResult.failure(StringName(code), "The pack state could not be written.")
	var now_i: Dictionary = doc["active"][pack_id]
	var h = handlers.get(now_i["type"])
	if now_i["activation"] == "hot":
		if before is Dictionary and h != null:
			h.deactivate(before)
		await _activate(now_i)
	elif h != null and h.has_method("can_activate_now") and h.can_activate_now(now_i):
		await _activate(now_i)
	return PKeyResult.success(true)


## Roll every pack in `ids` back (the shared boot guard after failed boots). A coroutine
## returning {packId: {from: install, to: install}} for the packs that rolled back.
func rollback_many(ids: PackedStringArray) -> Dictionary:
	await _enter()
	var out := {}
	for id in ids:
		var from = doc["active"].get(id) if doc != null else null
		var r := await _rollback_one(id)
		if r.ok and r.detail == true:
			# P3-10's skipVersion for packs: the bad release is held, so this boot's FETCH and any
			# later ensure keep the restored one until the stamp pins another release.
			if from is Dictionary:
				doc = PKeyPackState.hold(doc, id, from["recordSha256"])
				_persist()
			out[id] = {"from": from, "to": doc["active"][id], "count": int(doc["held"].get(id, {}).get("count", 1))}
	_leave()
	return out


## The record SHA-256 the boot guard holds for a pack (rolled back, not to be reinstalled), or "".
func held(pack_id: String) -> String:
	if doc == null:
		return ""
	var h = doc["held"].get(pack_id)
	return String(h["recordSha256"]) if h is Dictionary else ""


## Install the pinned release of each pack, in order. A coroutine: ok with detail = the installs
## (already-current packs included), or the first pack's failure (its code: `not-configured`,
## `pack-not-pinned`, `record-rejected`, `record-mismatch`, `pack-type-unsupported`,
## `pack-not-entitled`, `pack-no-variant`, a `plan-*`, applier, `pck-*` or `files-*` code, or
## `network-error`, after which the next ensure resumes the download).
func ensure(pack_ids: Array) -> PKeyResult:
	await _enter()
	var bad = _refuse_unreadable()
	if bad != null:
		_leave()
		return _result(bad["error"])
	var out: Array = []
	for id in pack_ids:
		var r: Dictionary = await _ensure_one(String(id))
		if r.has("error"):
			_leave()
			return _result(r["error"])
		out.append(r["install"])
	_leave()
	return PKeyResult.success(out)


## Install exact releases (a `packs` decision's `install`, plans/P4-13.md §2.6): each pack's named
## release ({pack, release: {sha256, seq, version}}), verified against the pinned release keys with
## that pin, instead of the stamp's pin. A coroutine with `ensure`'s answers, plus `pack-revoked`
## for a release a verified revocation names.
func ensure_releases(targets: Array) -> PKeyResult:
	await _enter()
	var bad = _refuse_unreadable()
	if bad != null:
		_leave()
		return _result(bad["error"])
	var out: Array = []
	for t in targets:
		var pack_id := String(t.get("pack", "")) if t is Dictionary else ""
		var release = t.get("release") if t is Dictionary else null
		if pack_id == "" or not (release is Dictionary):
			_leave()
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "ensure_releases needs [{pack, release: {sha256, seq, version}}].")
		var r: Dictionary = await _ensure_one(pack_id, release)
		if r.has("error"):
			_leave()
			return _result(r["error"])
		out.append(r["install"])
	_leave()
	return PKeyResult.success(out)


## Preflight each pack without downloading its payload and sum the chosen strategies' bytes: the
## size a consent dialog discloses (Apple 4.2.3(ii)). The index each tree stages is reused by
## `ensure`. A coroutine returning {bytes, packs, refused: [{packId, code}]}.
func estimate(pack_ids: Array) -> Dictionary:
	var items: Array = []
	for id in pack_ids:
		items.append({"pack": String(id)})
	return await _estimate_all(items)


## `estimate` for exact releases (a `packs` decision's `install`, plans/P4-13.md §2.6).
func estimate_releases(targets: Array) -> Dictionary:
	var items: Array = []
	for t in targets:
		if t is Dictionary:
			items.append({"pack": String(t.get("pack", "")), "release": t.get("release")})
	return await _estimate_all(items)


func _estimate_all(items: Array) -> Dictionary:
	await _enter()
	var out := {"bytes": 0, "packs": [], "refused": []}
	var bad = _refuse_unreadable()
	if bad != null:
		for it in items:
			out["refused"].append({"packId": it["pack"], "code": bad["error"]["code"]})
		_leave()
		return out
	for it in items:
		var id: String = it["pack"]
		var pre: Dictionary = await _preflight(id, it.get("release"))
		if pre.has("error"):
			out["refused"].append({"packId": id, "code": pre["error"]["code"]})
			continue
		if pre["kind"] == "current" or pre["kind"] == "held" or pre["plan"]["strategy"] == "noop":
			continue
		out["packs"].append(id)
		if pre["plan"].has("bytes"):
			out["bytes"] += int(pre["plan"]["bytes"])
	_leave()
	return out


## Operator recovery after a torn state document: drop the copy held aside and resume garbage
## collection. The installs the torn document held are not recovered; `ensure` reinstalls them.
func recover_state() -> PKeyResult:
	await _enter()
	if doc == null:
		_leave()
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call load() before using packs.")
	if state_issue == "unreadable":
		_leave()
		return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.PACK_STATE_UNREADABLE), "The pack state could not be read; restart once the store is readable.")
	storage.state_clear_quarantine()
	state_issue = ""
	_gc_hold = false
	_hold_snapshot = null
	# plans/P4-13.md §2.5: `relearn` is cleared wholesale and a quarantined `revocations.json`
	# released; revocations are re-learned from the next feed.
	if revocations_enabled and rev_issue != "unreadable":
		storage.revocations_clear_quarantine()
		if not (rev_doc["relearn"] as Array).is_empty():
			rev_doc = {"v": PKeyPackRevocations.VERSION, "revoked": rev_doc["revoked"], "relearn": []}
			if _rev_file:
				storage.revocations_replace(PKeyPackRevocations.serialize(rev_doc))
		if rev_issue == "torn":
			rev_issue = ""
	_collect()
	_leave()
	return PKeyResult.success()


# ── Revocations (plans/P4-13.md §2.5) ───────────────────────────────────────────────────────

## The stored and this process's verified revocations: {revoked: {target: {jws, pack, version,
## seq, record, issuedAt}}, verified: {target: verified revocation}, relearn: [packId], issue: ""
## | "torn" | "unreadable"}.
func revocations() -> Dictionary:
	var revoked: Dictionary = (rev_doc["revoked"] as Dictionary).duplicate(true)
	for t in _rev_verified:
		if not revoked.has(t):
			var r: Dictionary = _rev_verified[t]
			revoked[t] = {"jws": _rev_jws.get(t, ""), "pack": r["pack"], "version": r["version"], "seq": r["seq"], "record": r["record"], "issuedAt": r["issuedAt"]}
	return {"revoked": revoked, "verified": _rev_verified.duplicate(true), "relearn": (rev_doc["relearn"] as Array).duplicate(), "issue": rev_issue}


## Keep revocations a fresh check verified (plans/P4-13.md §2.5 step 11): `learned` is
## [{revocation, jws}]; each is stored when its target is new, or when newer_revocation ranks it
## above the stored one. `relearn_cleared` names the packs a fresh, network-verified feed with a
## usable `revocations` member re-taught. A revoked install stops running at once (a `hot` handler
## is deactivated; a `restart` pack is not mounted). Writes `state.json`'s `revocationsStored`
## before the sibling file the first time; writes nothing while either document is unreadable (the
## revocations still apply for the life of the process). A coroutine.
func record_revocations(learned: Array, relearn_cleared: Array = []) -> PKeyResult:
	await _enter()
	if doc == null:
		_leave()
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call load() before using packs.")
	var next: Dictionary = rev_doc
	var changed := false
	for l in learned:
		var rev: Dictionary = l["revocation"]
		var jws: String = l["jws"]
		var t: String = rev["target"]
		var prev = _rev_verified.get(t)
		if not (prev is Dictionary) or is_same(PKeyReleaseRecord.newer_revocation(rev, prev), rev):
			_rev_verified[t] = rev
			_rev_jws[t] = jws
		var r := PKeyPackRevocations.store(next, rev, jws, prev)
		next = r["doc"]
		changed = changed or r["changed"]
	var c := PKeyPackRevocations.clear_relearn(next, relearn_cleared)
	next = c["doc"]
	changed = changed or c["changed"]
	# The cap may have dropped a target: it is forgotten here too.
	for t in _rev_verified.keys():
		if not next["revoked"].has(t) and rev_doc["revoked"].has(t):
			_rev_verified.erase(t)
	rev_doc = next
	if changed:
		_persist_revocations()
	_unmount_revoked()
	_leave()
	return PKeyResult.success()


## Whether a release is revoked (stored, or verified in this process).
func is_revoked(record_sha256: Variant) -> bool:
	return record_sha256 is String and (rev_doc["revoked"].has(record_sha256) or _rev_verified.has(record_sha256))


## The embedded-baseline refusals (plans/P4-13.md §2.5): a revoked release; a pack in `relearn`;
## with an unreadable `revocations.json` and `revocationsStored` set, every pack the stamp pins or
## the host embeds. They apply at every boot and every mount, online or offline, until a fresh
## feed clears `relearn` (or recover_state()); online, the pack is fetched instead. A product with
## no revocations refuses nothing.
func _embedded_refused(e: Dictionary) -> bool:
	if is_revoked(e["recordSha256"]):
		return true
	if (rev_doc["relearn"] as Array).has(e["packId"]):
		return true
	if rev_issue == "unreadable" and doc is Dictionary and PKeyClaims.is_true(doc.get("revocationsStored")) \
			and (_stamp_packs().has(e["packId"]) or _embedded.has(e["packId"])):
		return true
	return false


## The packs the content stamp pins (Dictionary used as a set).
func _stamp_packs() -> Dictionary:
	var out := {}
	if stamp is Dictionary and stamp.get("pins") is Array:
		for p in stamp["pins"]:
			if p is Dictionary and p.get("pack") is String:
				out[p["pack"]] = true
	return out


## Load `revocations.json` (§2.5): absent is empty; unreadable writes nothing this process; torn
## is quarantined and replaced by a fresh document whose `relearn` holds the stamp's pinned and
## embedded packs; each entry is re-verified against the pinned release keys. A coroutine.
func _load_revocations(state_unreadable: bool) -> void:
	if not revocations_enabled:
		return
	var read := storage.revocations_read()
	if not read["ok"]:
		rev_issue = "unreadable"
		return
	if not (read["text"] is String):
		return
	var text: String = read["text"]
	_rev_file = true
	var parsed = PKeyPackRevocations.parse(text)
	if parsed == null:
		# Torn: held aside, then a fresh document that re-learns the stamp's packs.
		if not storage.revocations_quarantine(text):
			rev_issue = "unreadable"
			return
		rev_issue = "torn"
		var packs := _stamp_packs()
		for id in _embedded:
			packs[id] = true
		var relearn: Array = packs.keys()
		relearn.sort_custom(func(a, b): return PKeyPackClaims.compare_bytes(String(a), String(b)) < 0)
		rev_doc = {"v": PKeyPackRevocations.VERSION, "revoked": {}, "relearn": relearn}
		if not state_unreadable:
			_write_revocations()
		return
	var r: Dictionary = await PKeyPackRevocations.reload(parsed, {
		"release_keys": release_keys, "product_trust": product_trust.call() if product_trust.is_valid() else {},
		"expected_aud": product, "offload": offload,
	})
	rev_doc = r["doc"]
	for t in r["verified"]:
		_rev_verified[t] = r["verified"][t]
	if r["changed"] and not state_unreadable:
		_write_revocations()
	elif not state_unreadable and not PKeyPackRevocations.is_empty(rev_doc) and not PKeyClaims.is_true(doc.get("revocationsStored")):
		# A torn (or replaced) `state.json` lost the flag while the sibling file kept its entries:
		# set it again, so an unreadable `revocations.json` later still refuses.
		_persist_flag()


## Persist the revocations: `revocationsStored` in `state.json` first, then the sibling file. Never
## creates an empty file; never writes while a document is unreadable.
func _persist_revocations() -> void:
	if not revocations_enabled:
		return
	if rev_issue == "unreadable" or state_issue == "unreadable":
		return
	if not _rev_file and PKeyPackRevocations.is_empty(rev_doc):
		return
	_write_revocations()


func _write_revocations() -> bool:
	if not PKeyClaims.is_true(doc.get("revocationsStored")) and not _persist_flag():
		# Without the flag on disk the sibling file is not written: an unreadable file later must
		# never be read as "no revocations" while it holds some.
		return false
	if not storage.revocations_replace(PKeyPackRevocations.serialize(rev_doc)):
		return false
	_rev_file = true
	return true


## Write `revocationsStored: true` to `state.json`. The in-memory document takes the flag only once
## the write succeeded, so a failed write is retried before the next sibling write (the flag is
## never believed to be on disk when it is not).
func _persist_flag() -> bool:
	var before: Dictionary = doc
	var flagged: Dictionary = doc.duplicate(true)
	flagged["revocationsStored"] = true
	doc = flagged
	if _persist() != "":
		doc = before
		return false
	return true


## Stop running every revoked release (a hot handler is deactivated; a restart pack not yet mounted
## is withdrawn from this boot's mount; a mounted pack cannot be unmounted and stays until restart).
func _unmount_revoked() -> void:
	for id in running.keys():
		var i: Dictionary = running[id]
		if not is_revoked(i["recordSha256"]):
			continue
		var h = handlers.get(i["type"])
		if h != null:
			if i["activation"] == "hot":
				h.deactivate(i)
			elif h.has_method("withdraw"):
				h.withdraw(i)
		running.erase(id)


# ── Internals ───────────────────────────────────────────────────────────────────────────────

func _activate(i: Dictionary) -> void:
	var h = handlers.get(i["type"])
	if h != null:
		await h.activate(i)
	running[i["packId"]] = i


## Steps 12–15 again over a stored record, with its own pack id as the pin (and, for an install,
## its version, seq, variant, payload and type as stored). A coroutine.
func _verify_stored_record(jws: Variant, sha256: Variant, pack_id: String, install: Variant = null) -> bool:
	if not (jws is String) or not (sha256 is String):
		return false
	var r: Dictionary = await PKeyReleaseRecord.verify_release_record(jws, {
		"release_keys": release_keys, "product_trust": product_trust.call() if product_trust.is_valid() else {},
		"expected_aud": product, "expected_hash": sha256, "offload": offload,
	})
	if not r["ok"]:
		return false
	var rec: Dictionary = r["record"]
	if not PKeyPackClaims.same(rec.get("kind"), "pack") or not PKeyPackClaims.same(rec.get("deliverable"), pack_id):
		return false
	records[sha256] = rec
	if install is Dictionary:
		if not PKeyPackClaims.same(rec["version"], install["version"]) or not PKeyPackClaims.same(rec["seq"], install["seq"]):
			return false
		var v = null
		for x in rec["variants"]:
			if PKeyPackClaims.variant_key(x["variant"]) == install["variant"]:
				v = x
				break
		if v == null or not PKeyPackClaims.same(v["payload"]["sha256"], install["payloadSha256"]):
			return false
		if not PKeyPackClaims.same(v["payload"]["size"], install["payloadSize"]) or not PKeyPackClaims.same(rec["type"], install["type"]):
			return false
	return true


func _activation_of(record: Dictionary) -> String:
	var h = record.get("handler")
	var a = h.get("activation") if h is Dictionary else null
	if PKeyPackClaims.same(a, "hot") or PKeyPackClaims.same(a, "restart"):
		return a
	var handler = handlers.get(record.get("type"))
	return handler.activation if handler != null else "restart"


func _known_activation(record: Dictionary) -> bool:
	var h = record.get("handler")
	if not (h is Dictionary) or not h.has("activation"):
		return true
	return PKeyPackClaims.same(h["activation"], "hot") or PKeyPackClaims.same(h["activation"], "restart")


func _verify_embedded(e: Dictionary) -> Dictionary:
	var m: Dictionary = await PKeyPackMarker.verify_marker(e["marker"], {
		"release_keys": release_keys, "product_trust": product_trust.call() if product_trust.is_valid() else {},
		"expected_aud": product, "offload": offload,
	})
	if not m["ok"]:
		return {"ok": false, "step": m["step"]}
	var match := PKeyPackMarker.match_embedded(m, e["payload"], stamp)
	if not match["ok"]:
		return {"ok": false, "step": match["step"]}
	var rec: Dictionary = m["record"]
	records[m["recordSha256"]] = rec
	var v: Dictionary = rec["variants"][match["variant"]]
	return {"ok": true, "install": {
		"packId": m["packId"], "record": m["release"], "recordSha256": m["recordSha256"], "version": m["version"],
		"seq": rec["seq"], "type": rec["type"], "variant": PKeyPackClaims.variant_key(v["variant"]),
		"layout": v["files"]["layout"], "payloadSha256": v["payload"]["sha256"], "payloadSize": v["payload"]["size"],
		"activation": _activation_of(rec), "location": e["location"], "embedded": true, "installedAt": rec["issuedAt"],
	}}


## The installs of a pack the planner can reuse: active, the embedded copy and previous.
func _installs_of(pack_id: String) -> Array:
	var out: Array = []
	var seen := {}
	for i in [doc["active"].get(pack_id), _embedded.get(pack_id), doc["previous"].get(pack_id)]:
		if i is Dictionary and not seen.has(i["location"]):
			seen[i["location"]] = true
			out.append(i)
	return out


func _stamp_pin(pack_id: String) -> Variant:
	if not (stamp is Dictionary):
		return null
	for p in stamp.get("pins", []):
		if PKeyPackClaims.same(p.get("pack"), pack_id):
			return p
	return null


## Steps 1–4 for one pack: what is already current, or the verified record, the variant, the
## seeds, the index and the plan. `want` ({sha256, seq, version}): an exact release (a `packs`
## decision's target) instead of the stamp's pin. A coroutine.
func _preflight(pack_id: String, want: Variant = null) -> Dictionary:
	if not (stamp is Dictionary):
		return _err(String(PKeyErrors.NOT_CONFIGURED), "This build ships no content stamp, so it has no packs.", pack_id)
	var pin = {"pack": pack_id, "release": want} if want is Dictionary else _stamp_pin(pack_id)
	if pin == null:
		return _err(PKeyConstants.ErrorCode.PACK_NOT_PINNED, "The content stamp pins no release of %s." % pack_id, pack_id)
	if not PKeyPackClaims.is_sha256(pin["release"].get("sha256")):
		return _err(String(PKeyErrors.INVALID_OPTIONS), "%s's release is not a record SHA-256." % pack_id, pack_id)
	var pin_sha: String = pin["release"]["sha256"]
	# plans/P4-13.md §2.5: a revoked release is never installed, activated or mounted.
	if is_revoked(pin_sha):
		return _err(PKeyConstants.ErrorCode.PACK_REVOKED, "%s@%s was revoked by its developer." % [pack_id, str(pin["release"].get("version"))], pack_id)
	var current = doc["active"].get(pack_id)
	if current is Dictionary and current["recordSha256"] == pin_sha:
		return {"kind": "current", "install": current}
	var emb = _embedded.get(pack_id)
	if emb is Dictionary and _embedded_refused(emb):
		emb = null
	if emb is Dictionary and emb["recordSha256"] == pin_sha and not (current is Dictionary):
		return {"kind": "current", "install": emb}
	# A release the boot guard rolled back is not installed again while the stamp still pins it;
	# the restored install (or the embedded baseline) stands in for it.
	if held(pack_id) == pin_sha:
		var stand_in = current if current is Dictionary else emb
		if stand_in is Dictionary:
			return {"kind": "held", "install": stand_in}

	# 2. The pinned record, by hash, against the pinned release keys.
	var got: Dictionary = await transport.fetch_record(pin_sha)
	if not got["ok"]:
		return _err(String(got["code"]), "Fetching %s's record failed (%s)." % [pack_id, got["code"]], pack_id)
	var body = got["body"]
	var v: Dictionary = await PKeyReleaseRecord.verify_release_record(body, {
		"release_keys": release_keys, "product_trust": product_trust.call() if product_trust.is_valid() else {},
		"expected_aud": product, "expected_hash": pin_sha, "offload": offload,
		"pin": {"kind": "pack", "deliverable": pack_id, "version": pin["release"]["version"], "seq": pin["release"]["seq"]},
	})
	if not v["ok"]:
		if v["step"] == "cross-check":
			return _err(String(PKeyErrors.RECORD_MISMATCH), "%s's record is not the pinned release." % pack_id, pack_id)
		return _err(String(PKeyErrors.RECORD_REJECTED), "%s's record was refused at %s." % [pack_id, v["step"]], pack_id, {"step": v["step"]})
	var record: Dictionary = v["record"]
	records[pin_sha] = record
	var body_text: String = body.get_string_from_ascii() if body is PackedByteArray else String(body)

	# 3. Type, entitlement, variant.
	var handler = handlers.get(record["type"])
	if handler == null or not handler.supports(int(record["formatVersion"])) or not _known_activation(record):
		return _err(PKeyConstants.ErrorCode.PACK_TYPE_UNSUPPORTED, "%s is a %s v%d pack, which this SDK cannot hold." % [pack_id, record["type"], int(record["formatVersion"])], pack_id)
	var granted = entitlements.call() if entitlements.is_valid() else null
	if record.has("entitlement") and granted is Dictionary and not granted.has(record["entitlement"]):
		return _err(PKeyConstants.ErrorCode.PACK_NOT_ENTITLED, "%s needs the %s entitlement." % [pack_id, record["entitlement"]], pack_id)
	var sel := PKeyPackSelect.select_variant(record["variants"], prefs)
	if sel.has("error"):
		return _err(PKeyConstants.ErrorCode.PACK_NO_VARIANT, "No variant of %s is eligible here." % pack_id, pack_id)
	var variant: Dictionary = record["variants"][sel["index"]]
	if not PKeyPackClaims.same(variant["files"]["layout"], handler.layout):
		return _err(PKeyConstants.ErrorCode.PACK_TYPE_UNSUPPORTED, "%s's variant is a %s, not a %s." % [pack_id, variant["files"]["layout"], handler.layout], pack_id)

	# 4. The index (a tree, or any installed release), the target, the plan. Only installs whose
	# bytes can be opened count: the planner must not choose a delta from an unreadable base.
	var seeds := {}
	var installs: Array = []
	for i in _installs_of(pack_id):
		var p = await PKeyPackJob.run(storage.installed.bind(i), "PolarisKey pack seeds")
		if p is Dictionary:
			seeds[i["location"]] = p
			installs.append(i)
	var prior = doc["inflight"].get(pack_id)
	var early = _preflight_plans.get(pack_id)
	var plan_id := ""
	if prior is Dictionary and prior["recordSha256"] == pin_sha and prior["variant"] == PKeyPackClaims.variant_key(variant["variant"]):
		plan_id = prior["planId"]
	elif early is Dictionary and early["recordSha256"] == pin_sha:
		plan_id = early["planId"]
	else:
		plan_id = new_plan_id.call()
	_preflight_plans[pack_id] = {"planId": plan_id, "recordSha256": pin_sha}
	var index = null
	var need_index: bool = variant["files"]["layout"] == "tree"
	for loc in seeds:
		if seeds[loc]["files"] != null:
			need_index = true
	var index_ok: bool = PKeyPackSelect.index_readable(variant["files"]) and float(variant["files"]["bytes"]) <= float(PKeyConstants.MAX_FILES_INDEX_BYTES)
	if need_index and not index_ok and variant["files"]["layout"] == "tree":
		return _err(PKeyPackFiles.FILES_INDEX_INVALID, "%s's files index is unreadable here or over the size limit." % pack_id, pack_id)
	if need_index and index_ok:
		var ok: bool = await _download(plan_id, pack_id, {"sha256": variant["files"]["sha256"], "bytes": int(variant["files"]["bytes"])}, null)
		if ok:
			var stored := PKeyByteSource.read_all(storage.staged_source(plan_id, variant["files"]["sha256"]))
			var r := PKeyPackFiles.parse_files_index(stored, variant["files"], variant["payload"], zstd.decode)
			if r["ok"]:
				index = r["index"]
			elif variant["files"]["layout"] == "tree":
				return _err(r["error"], "%s's files index was refused." % pack_id, pack_id, {"path": r.get("path", "")})
		elif variant["files"]["layout"] == "tree":
			return _err(_fetch_code(), "Fetching %s's files index failed." % pack_id, pack_id)
	var target := PKeyPackSelect.plan_target(variant, pin_sha, index)
	if one_shot_budget >= 0 and target["full"] != null and float(variant["full"]["bytes"]) + float(variant["full"]["size"]) > float(one_shot_budget):
		target["full"] = null
	var planner_installed: Array = []
	for i in installs:
		var files = seeds[i["location"]]["files"]
		var hashes = null
		if files is Array:
			hashes = []
			for f in files:
				hashes.append(f["sha256"])
		planner_installed.append({"release": i["recordSha256"], "payloadSha256": i["payloadSha256"], "files": hashes})
	var caps := {
		"strategies": strategies, "patchMethods": patch_methods, "transports": transports,
		"memBudget": mem_budget, "freeDisk": storage.free_disk(),
	}
	var p := PKeyPackSelect.plan({"target": target, "installed": planner_installed, "caps": caps})
	if p.has("error"):
		return _err(p["error"], "No way to install %s: %s." % [pack_id, p["error"]], pack_id)
	return {
		"kind": "plan", "body": body_text, "recordSha256": pin_sha, "record": record, "variant": variant,
		"installs": installs, "seeds": seeds, "planId": plan_id, "index": index, "plan": p,
	}


func _ensure_one(pack_id: String, target: Variant = null) -> Dictionary:
	var r: Dictionary = await _ensure_one_inner(pack_id, target)
	if not r.has("error"):
		return r
	# plans/P4-13.md §2.5: when the only copy is an embedded baseline refused for `relearn` (or for
	# `revocationsStored` with an unreadable `revocations.json`) and the fetch cannot proceed, the
	# typed refusal is `pack-revoked` with detail `relearn`.
	var code := String(r["error"]["code"])
	var want = target["sha256"] if target is Dictionary else null
	if want == null:
		var pin = _stamp_pin(pack_id)
		want = pin["release"]["sha256"] if pin is Dictionary else null
	var emb = _embedded.get(pack_id)
	if code != PKeyConstants.ErrorCode.PACK_REVOKED and emb is Dictionary and PKeyPackClaims.same(emb["recordSha256"], want) \
			and not is_revoked(emb["recordSha256"]) and _embedded_refused(emb):
		return _err(PKeyConstants.ErrorCode.PACK_REVOKED, "%s's embedded copy is refused until a fresh feed re-teaches its revocations, and it cannot be fetched (%s)." % [pack_id, code], pack_id, {"detail": "relearn"})
	return r


func _ensure_one_inner(pack_id: String, target: Variant) -> Dictionary:
	var pre: Dictionary = await _preflight(pack_id, target)
	if pre.has("error"):
		return pre
	if pre["kind"] == "held":
		return _err(PKeyConstants.ErrorCode.PACK_ROLLED_BACK, "%s's pinned release was rolled back after failed boots; %s stays active until the build pins another release." % [pack_id, pre["install"]["version"]], pack_id, {"install": pre["install"]})
	if pre["kind"] == "current":
		var current: Dictionary = pre["install"]
		if current.get("embedded") != true and not running.has(pack_id) and current["activation"] == "hot":
			await _activate(current)
		return {"install": current}
	var record: Dictionary = pre["record"]
	var variant: Dictionary = pre["variant"]
	var seeds: Dictionary = pre["seeds"]
	var plan_id: String = pre["planId"]
	var index = pre["index"]
	var p: Dictionary = pre["plan"]
	_preflight_plans.erase(pack_id)
	if p["strategy"] == "noop":
		var same = null
		for i in pre["installs"]:
			if i["payloadSha256"] == variant["payload"]["sha256"]:
				same = i
				break
		return await _commit(pack_id, pre["body"], pre["recordSha256"], record, variant, same["location"], plan_id, true)
	if p["strategy"] == "platform":
		return _err(PKeyConstants.ErrorCode.PLAN_TRANSPORT_UNSUPPORTED, "%s is platform-bound." % pack_id, pack_id)

	# 5–6. Each candidate in turn: journal, fetch, apply.
	var first_failure = null
	var candidates: Array = [p]
	candidates.append_array(p["fallbacks"])
	for cand in candidates:
		var objects = _objects_for(cand["strategy"], cand.get("delta"), variant, index, seeds)
		if objects == null:
			continue
		var journal_objects: Array = []
		var total := 0
		for o in objects:
			journal_objects.append({"sha256": o["sha256"], "bytes": int(o["bytes"]), "done": 0})
			total += int(o["bytes"])
		var journal := {
			"planId": plan_id, "packId": pack_id, "record": pre["body"], "recordSha256": pre["recordSha256"],
			"variant": PKeyPackClaims.variant_key(variant["variant"]), "strategy": cand["strategy"],
			"objects": journal_objects, "startedAt": int(now.call()),
		}
		if cand.has("delta"):
			journal["delta"] = cand["delta"]
		doc = PKeyPackState.begin_install(doc, journal)
		var code := _persist()
		if code != "":
			return _err(code, "The pack state could not be written.", pack_id)
		var prog := {"done": 0, "total": total}
		_emit({"packId": pack_id, "phase": "download", "done": 0, "total": total})
		for o in objects:
			if not await _download(plan_id, pack_id, o, prog):
				# The journal and what is staged stay for the next ensure, which resumes them.
				return _err(_fetch_code(), "Fetching %s's objects failed; the next ensure resumes." % pack_id, pack_id)
		_emit({"packId": pack_id, "phase": "apply", "done": total, "total": total})
		var result: Dictionary = await _apply(plan_id, pack_id, cand["strategy"], cand.get("delta"), variant, seeds)
		if result["verdict"]["ok"]:
			# The handler's check over the verified output (godot.pck: header and directory).
			var handler = handlers.get(record["type"])
			if handler != null and variant["files"]["layout"] == "container":
				var out_file := storage.out_dir(plan_id).path_join(PKeyPackStorage.CONTAINER_FILE)
				var src := PKeyByteSource.file(out_file)
				var chk: Dictionary = await PKeyPackJob.run(handler.check_output.bind(src, record, variant), "PolarisKey pack check")
				if not chk["ok"]:
					doc = PKeyPackState.abandon_install(doc, pack_id)
					_persist()
					storage.remove_staging(plan_id)
					return _err(chk["code"], "%s was refused before mounting: %s" % [pack_id, chk.get("detail", "")], pack_id, {"path": chk.get("path", ""), "step": cand["strategy"]})
				if chk.get("warning", "") != "":
					push_warning("PolarisKey: %s: %s" % [pack_id, chk["warning"]])
			elif handler != null and handler.has_method("check_tree"):
				var tchk: Dictionary = await PKeyPackJob.run(handler.check_tree.bind(storage.out_dir(plan_id), record, variant), "PolarisKey pack check")
				if not tchk["ok"]:
					doc = PKeyPackState.abandon_install(doc, pack_id)
					_persist()
					storage.remove_staging(plan_id)
					return _err(tchk["code"], "%s was refused before it committed: %s" % [pack_id, tchk.get("detail", "")], pack_id, {"path": tchk.get("path", ""), "step": cand["strategy"]})
			var location: String = await PKeyPackJob.run(storage.commit.bind(plan_id, pack_id, variant["payload"]["sha256"], variant["files"]["layout"], result.get("index", index)), "PolarisKey pack commit")
			if location == "":
				if first_failure == null:
					first_failure = _err(String(PKeyErrors.STORE_FAILED), "%s could not be committed to the store." % pack_id, pack_id, {"step": cand["strategy"]})
				storage.remove_staging(plan_id)
				continue
			var c: Dictionary = await _commit(pack_id, pre["body"], pre["recordSha256"], record, variant, location, plan_id, false)
			_emit({"packId": pack_id, "phase": "done", "done": total, "total": total})
			return c
		var f: Dictionary = result["verdict"]
		if first_failure == null:
			first_failure = _err(f["error"], "Installing %s by %s failed: %s." % [pack_id, cand["strategy"], f["error"]], pack_id, {"path": f.get("path", ""), "step": cand["strategy"]})
		storage.remove_staging(plan_id)
	doc = PKeyPackState.abandon_install(doc, pack_id)
	_persist()
	storage.remove_staging(plan_id)
	if first_failure != null:
		return first_failure
	return _err(PKeyConstants.ErrorCode.PLAN_NO_STRATEGY, "No way to install %s." % pack_id, pack_id)


## The objects a strategy fetches, in order; null when the strategy cannot run here.
func _objects_for(strategy: String, delta: Variant, variant: Dictionary, index: Variant, seeds: Dictionary) -> Variant:
	var files: Dictionary = variant["files"]
	var idx := {"sha256": files["sha256"], "bytes": int(files["bytes"])}
	var gaps: Array = []
	if files["layout"] == "container" and files.get("gaps") is Dictionary:
		gaps.append({"sha256": files["gaps"]["sha256"], "bytes": int(files["gaps"]["bytes"])})
	if strategy == "full":
		var full := {"sha256": variant["full"]["sha256"], "bytes": int(variant["full"]["bytes"])}
		return [idx, full] if files["layout"] == "tree" else [full]
	if strategy == "delta":
		var d = _find_delta(variant, delta)
		if d == null:
			return null
		if d["scope"] == "payload":
			return [{"sha256": d["artifact"]["sha256"], "bytes": int(d["artifact"]["bytes"])}]
		var out: Array = [idx]
		out.append_array(gaps)
		out.append({"sha256": d["patch"]["sha256"], "bytes": int(d["patch"]["bytes"])})
		out.append({"sha256": d["data"]["sha256"], "bytes": int(d["data"]["bytes"])})
		return out
	if strategy == "file":
		if not (index is Dictionary):
			return null
		var held := {}
		for loc in seeds:
			var fs = seeds[loc]["files"]
			if fs is Array:
				for f in fs:
					held[f["sha256"]] = true
		var blobs := {}
		var order: Array = []
		for f in index["files"]:
			if not held.has(f["sha256"]) and not blobs.has(f["blob"]["sha256"]):
				blobs[f["blob"]["sha256"]] = int(f["blob"]["bytes"])
				order.append(f["blob"]["sha256"])
		var out: Array = [idx]
		out.append_array(gaps)
		for h in order:
			out.append({"sha256": h, "bytes": blobs[h]})
		return out
	return null


static func _find_delta(variant: Dictionary, id: Variant) -> Variant:
	var deltas = variant.get("deltas", [])
	if not (deltas is Array):
		return null
	for x in deltas:
		if PKeyPackClaims.same(x.get("scope"), "payload") and x["artifact"]["sha256"] == id:
			return x
		if PKeyPackClaims.same(x.get("scope"), "files") and x["patch"]["sha256"] == id:
			return x
	return null


static func _find_delta_index(variant: Dictionary, id: Variant) -> int:
	var deltas = variant.get("deltas", [])
	for k in deltas.size():
		var x = deltas[k]
		if (PKeyPackClaims.same(x.get("scope"), "payload") and x["artifact"]["sha256"] == id) or (PKeyPackClaims.same(x.get("scope"), "files") and x["patch"]["sha256"] == id):
			return k
	return -1


## Run the applier for one candidate over the staged objects. Full and file run on a worker
## thread; a delta (which mounts the engine's decoder packs) on the main thread. A coroutine.
func _apply(plan_id: String, pack_id: String, strategy: String, delta: Variant, variant: Dictionary, seeds: Dictionary) -> Dictionary:
	var st := storage
	var objects := func(sha256: String) -> Variant:
		var n := st.staged_size(plan_id, sha256)
		if n > 0 or (n == 0 and sha256 == PKeyPackStorage.EMPTY_SHA256):
			return st.staged_source(plan_id, sha256)
		return null
	var out := storage.output(plan_id, variant["files"]["layout"])
	if out.is_empty():
		return {"verdict": {"ok": false, "error": String(PKeyErrors.STORE_FAILED)}}
	var ports := {"objects": objects, "zstd": zstd}
	ports.merge(out)
	var installed: Array = []
	for loc in seeds:
		var fs = seeds[loc]["files"]
		if fs is Array:
			installed.append_array(fs)
	var r: Dictionary
	if strategy == "full":
		r = await PKeyPackJob.run(PKeyPackApply.apply_full.bind(variant, ports), "PolarisKey pack apply")
	elif strategy == "file":
		r = await PKeyPackJob.run(PKeyPackApply.apply_file.bind(variant, -1, installed, ports), "PolarisKey pack apply")
	else:
		var k := _find_delta_index(variant, delta)
		var d = variant["deltas"][k] if k >= 0 else null
		if d == null:
			r = {"verdict": {"ok": false, "error": PKeyPackApply.DELTA_ARTIFACT_MISMATCH}}
		elif d["scope"] == "files":
			zstd.on_bake = _bake_note.bind(plan_id)
			r = PKeyPackApply.apply_file(variant, k, installed, ports)
			zstd.on_bake = Callable()
		else:
			var base: PKeyByteSource = null
			for i in _installs_of(pack_id):
				var s = seeds.get(i["location"])
				if base == null and i["payloadSha256"] == d["from"] and s is Dictionary and s["payload"] != null:
					base = s["payload"]
			if base == null:
				r = {"verdict": {"ok": false, "error": PKeyPackApply.DELTA_BASE_MISMATCH}}
			else:
				zstd.on_bake = _bake_note.bind(plan_id)
				r = PKeyPackApply.apply_delta(variant, k, base, ports)
				zstd.on_bake = Callable()
	for sink_key in ["sink", "tree"]:
		if out.has(sink_key) and not out[sink_key].close() and r["verdict"]["ok"]:
			r = {"verdict": {"ok": false, "error": String(PKeyErrors.STORE_FAILED)}}
	return r


func _bake_note(file: String, size: int, plan_id: String) -> bool:
	return storage.note_bake(plan_id, file, size)


## Commit: the pointer swap, activation, garbage collection. A coroutine.
func _commit(pack_id: String, record_jws: String, record_sha256: String, record: Dictionary, variant: Dictionary, location: String, staging_plan: String, reused: bool) -> Dictionary:
	var install := {
		"packId": pack_id, "record": record_jws, "recordSha256": record_sha256, "version": record["version"],
		"seq": record["seq"], "type": record["type"], "variant": PKeyPackClaims.variant_key(variant["variant"]),
		"layout": variant["files"]["layout"], "payloadSha256": variant["payload"]["sha256"],
		"payloadSize": variant["payload"]["size"], "activation": _activation_of(record), "location": location,
		"installedAt": int(now.call()),
	}
	if _embedded.has(pack_id) and _embedded[pack_id]["location"] == location:
		install["embedded"] = true
	# A fresh commit supersedes this pack's entries whose check could not run; an active one
	# becomes `previous`, re-verified before a rollback uses it.
	var carried = _deferred["active"].get(pack_id)
	_deferred["active"].erase(pack_id)
	_deferred["previous"].erase(pack_id)
	var before = running.get(pack_id)
	doc = PKeyPackState.commit_install(doc, install)
	if carried is Dictionary and carried["recordSha256"] != install["recordSha256"]:
		doc["previous"][pack_id] = carried
		_unverified_previous[pack_id] = true
	else:
		_unverified_previous.erase(pack_id)
	var code := _persist()
	if code != "":
		return _err(code, "The pack state could not be written.", pack_id)
	if not reused:
		storage.remove_staging(staging_plan)
	var h = handlers.get(record["type"])
	if install["activation"] == "hot":
		if before is Dictionary and before["location"] != location and h != null:
			h.deactivate(before)
		await _activate(install)
	elif h != null and h.has_method("can_activate_now") and h.can_activate_now(install):
		# A restart pack whose id has not been mounted in this process (the boot's FETCH, before
		# MOUNT) is mounted at this boot: nothing of an older version is loaded yet.
		await _activate(install)
	_collect()
	return {"install": install}


## Remove every stored location and staging area no root holds (never while a hold is on, never
## from a partial listing; the running set and unverifiable locations are roots).
func _collect() -> void:
	if _gc_hold or doc == null:
		return
	var extra: Array = []
	for id in _embedded:
		extra.append(_embedded[id])
	for id in running:
		extra.append(running[id])
	var roots := PKeyPackState.gc_roots(doc, extra)
	for loc in _unverifiable:
		roots["locations"][loc] = true
	for slot in ["active", "previous"]:
		for id in _deferred[slot]:
			roots["locations"][_deferred[slot][id]["location"]] = true
	var listed = storage.list()
	if listed == null:
		return
	var held = _hold_snapshot
	for loc in listed["locations"]:
		if not roots["locations"].has(loc) and not (held is Dictionary and held["locations"].has(loc)):
			storage.remove(loc)
	for plan in listed["plans"]:
		if not roots["plans"].has(plan) and not (held is Dictionary and held["plans"].has(plan)):
			storage.remove_staging(plan)


## Stage one object: resume from what is staged (its bytes re-hashed, never trusted), fetch the
## rest with Range and If-Range, checkpoint the journal. True when the staged object then has the
## ref's length and SHA-256; a mismatch resets it and refetches once from the start. A coroutine.
func _download(plan_id: String, pack_id: String, ref: Dictionary, prog: Variant) -> bool:
	var sha: String = ref["sha256"]
	var bytes := int(ref["bytes"])
	_denied = false
	for attempt in 2:
		var have := storage.staged_size(plan_id, sha)
		if have < 0:
			return false
		if have > bytes:
			storage.staged_reset(plan_id, sha)
			have = 0
		var hasher := HashingContext.new()
		hasher.start(HashingContext.HASH_SHA256)
		if have > 0:
			var src := storage.staged_source(plan_id, sha)
			var at := 0
			while at < have:
				var chunk := src.read(at, mini(PKeyByteSource.READ_CHUNK, have - at))
				if chunk.is_empty():
					break
				hasher.update(chunk)
				at += chunk.size()
			if at != have:
				return false
		var counted := have if prog is Dictionary else 0
		if prog is Dictionary:
			prog["done"] += counted
			_emit({"packId": pack_id, "phase": "download", "done": prog["done"], "total": prog["total"]})
		var outcome := ""
		if have < bytes:
			# One request: the head decides how its body is read (client-core: a 200 to a resume
			# starts over, a 206 must start at the offset), then every chunk is appended, hashed
			# and checkpointed.
			var ctx := {"have": have, "since": 0, "write_failed": false, "overrun": false, "hasher": hasher, "refused": false}
			var on_response := func(status: int, content_range: String) -> bool:
				if status == 200 and ctx["have"] > 0:
					if prog is Dictionary:
						prog["done"] -= counted
					storage.staged_reset(plan_id, sha)
					var fresh := HashingContext.new()
					fresh.start(HashingContext.HASH_SHA256)
					ctx["hasher"] = fresh
					ctx["have"] = 0
					return true
				if status == 206 and ctx["have"] > 0 and _range_starts_at(content_range, ctx["have"]):
					return true
				if status == 200:
					return true
				if status == 403:
					_denied = true
				ctx["refused"] = true
				return false
			var on_chunk := func(chunk: PackedByteArray) -> bool:
				if ctx["have"] + chunk.size() > bytes:
					ctx["overrun"] = true
					return false
				if not storage.staged_append(plan_id, sha, chunk):
					ctx["write_failed"] = true
					return false
				ctx["hasher"].update(chunk)
				ctx["have"] += chunk.size()
				ctx["since"] += chunk.size()
				if prog is Dictionary:
					prog["done"] += chunk.size()
					_emit({"packId": pack_id, "phase": "download", "done": prog["done"], "total": prog["total"]})
				if ctx["since"] >= checkpoint_bytes:
					ctx["since"] = 0
					_save_checkpoint(pack_id, plan_id, sha, ctx["have"])
				return true
			var req := {"sha256": sha, "offset": have, "if_range": ("\"%s\"" % sha) if have > 0 else ""}
			var res: Dictionary = await transport.fetch_object(req, on_response, on_chunk)
			var status := int(res.get("status", 0))
			if ctx["refused"] or (status != 200 and status != 206):
				return false
			_save_checkpoint(pack_id, plan_id, sha, int(ctx["have"]))
			if ctx["overrun"]:
				outcome = "mismatch"
			elif ctx["write_failed"]:
				return false
			elif String(res.get("error", "")) != "" or int(ctx["have"]) < bytes:
				# An interrupted transfer keeps what is staged for the next resume.
				return false
			else:
				outcome = "ok" if ctx["hasher"].finish().hex_encode() == sha else "mismatch"
		else:
			outcome = "ok" if hasher.finish().hex_encode() == sha else "mismatch"
		if outcome == "ok":
			return true
		if prog is Dictionary:
			prog["done"] -= mini(maxi(storage.staged_size(plan_id, sha), 0), bytes)
		storage.staged_reset(plan_id, sha)
	return false


## A failed object fetch's code: `pack-not-entitled` when the blob route refused with 403 (the
## delivery gate or the entitlement, P4-05), else `network-error` (the next ensure resumes).
func _fetch_code() -> String:
	return PKeyConstants.ErrorCode.PACK_NOT_ENTITLED if _denied else String(PKeyErrors.NETWORK)


func _save_checkpoint(pack_id: String, plan_id: String, sha: String, have: int) -> void:
	var j = doc["inflight"].get(pack_id) if doc != null else null
	if not (j is Dictionary) or j["planId"] != plan_id:
		return
	doc = PKeyPackState.checkpoint(doc, pack_id, sha, have)
	_persist()


static func _range_starts_at(content_range: String, offset: int) -> bool:
	var m := RegEx.create_from_string("^bytes (\\d+)-\\d+/\\d+$").search(content_range.strip_edges())
	return m != null and m.get_string(1) == str(offset)
