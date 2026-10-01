class_name PKeyCache
extends RefCounted
## The verified cache (WIRE-CONTRACT-V3 §4.1): sdk-node `core/cache.ts` over the
## `CacheRecordV3` shape of `client-core/src/store.ts`, exactly:
##
##   {v: 3, trustJws?, docs?: {license?, config?}, etags?: {license?, config?},
##    importedBundle?: {bundleId, importedAt}, lastSyncUnauthorized?, blocked?: {reason,
##    allowedRange?}}
##
## SIGNED ARTIFACTS ONLY, plus ETags (non-security) and two unsigned hints that can only make the
## gate stricter. The load procedure is the security boundary:
##
##   1. a record whose `v` is not 3 is DISCARDED, never migrated (3.0 == 3: numbers are floats);
##   2. `trustJws` is re-verified against the PINS, freshness off -> the effective set;
##   3. each document is re-verified against THAT set, freshness off, full claims, `aud` and
##      the local `deviceId`;
##   4. every derived value (the anti-replay floors, the clock floor, `last_verified_at`) is
##      computed from what verified. Nothing derived is ever read from the file, and unknown
##      fields are dropped from the in-memory record.
##
## A failing artifact is ABSENT for the session (and rewritten out on the next write), never
## half-trusted. Writes are one whole-record write per sync (`flush`), so two parallel document
## fetches can never clobber each other's slice. Nothing is double-verified on reload.

const VERSION := 3
const SLICES := ["license", "config"]

var store: PKeyStore
var trust: PKeyTrust
var clock: PKeyClock
var product := ""
var device_id := ""

## {jws, doc} of the verified licence document, or null.
var license = null
## {jws, doc} of the verified config document, or null.
var config = null
## {bundleId, importedAt} when this install was activated from an offline bundle, or null.
var imported_bundle = null
var last_sync_unauthorized := false
## {reason, allowedRange?} from the last 403 build block, or null.
var blocked = null
## Epoch seconds of the last verification: the newest verified document's signed `issuedAt` at
## load, then the time of each successful authenticated exchange (200 or 304). null: never.
var last_verified_at = null

var _record = null


func _init(p_store: PKeyStore, p_trust: PKeyTrust, p_clock: PKeyClock, p_product: String, p_device_id: String) -> void:
	store = p_store
	trust = p_trust
	clock = p_clock
	product = p_product
	device_id = p_device_id


## The record as it would be written now (a copy), or null.
func record() -> Variant:
	return _record.duplicate(true) if _record is Dictionary else null


## The ETag held for a slice, or "". Non-security: a forged one buys an unnecessary 200.
func etag(slice: String) -> String:
	if _record is Dictionary and _record.get("etags") is Dictionary:
		var e = _record["etags"].get(slice)
		return e if e is String else ""
	return ""


## Re-verify the whole record and derive everything from it. A coroutine.
func load_record() -> void:
	trust.reset()
	_reset_loaded()
	var rec = store.read_cache()
	if not (rec is Dictionary) or not PKeyClaims.is_number(rec.get("v")) or float(rec["v"]) != VERSION:
		_record = null
		return
	_record = _normalize(rec)
	var now := clock.system_now()

	if _record.has("trustJws"):
		var issued := await trust.load_cached(_record["trustJws"], product, now)
		if issued < 0:
			_record.erase("trustJws")
		else:
			clock.raise(issued)

	var reload := {
		"trust": trust.effective(), "expected_aud": product, "device_id": device_id, "now": now,
		"check_freshness": false,
	}
	var newest := 0.0
	var docs: Dictionary = _record.get("docs", {})
	if docs.has("license"):
		var doc = await PKeyVerify.verify_license_doc(docs["license"], reload)
		if doc != null:
			license = {"jws": docs["license"], "doc": doc}
			clock.raise(float(doc["issuedAt"]))
			newest = maxf(newest, float(doc["issuedAt"]))
		else:
			_drop_slice("license")
	if docs.has("config"):
		var doc = await PKeyVerify.verify_config_doc(docs["config"], reload)
		if doc != null:
			config = {"jws": docs["config"], "doc": doc}
			clock.raise(float(doc["issuedAt"]))
			newest = maxf(newest, float(doc["issuedAt"]))
		else:
			_drop_slice("config")

	imported_bundle = _record.get("importedBundle")
	last_sync_unauthorized = PKeyClaims.is_true(_record.get("lastSyncUnauthorized"))
	blocked = _record.get("blocked")
	last_verified_at = newest if newest > 0 else null


## Stage a freshly verified licence document (memory only; `flush` persists).
func apply_license(jws: String, doc: Dictionary, p_etag: String) -> void:
	license = {"jws": jws, "doc": doc}
	clock.raise(float(doc["issuedAt"]))
	_stage("license", jws, p_etag)


func apply_config(jws: String, doc: Dictionary, p_etag: String) -> void:
	config = {"jws": jws, "doc": doc}
	clock.raise(float(doc["issuedAt"]))
	_stage("config", jws, p_etag)


## A successful authenticated exchange, 304 included (freshness renewed, §5).
func mark_verified(at_seconds := -1.0) -> void:
	last_verified_at = at_seconds if at_seconds >= 0 else clock.system_now()


## Read-modify-write the WHOLE record: the only mutation path. A key whose value is null is
## removed. Returns the store's verdict; a failure is surfaced by the store.
func patch(changes: Dictionary) -> bool:
	if not (_record is Dictionary):
		_record = {"v": VERSION}
	for k in changes:
		if changes[k] == null:
			_record.erase(k)
		else:
			_record[k] = changes[k]
	if changes.has("lastSyncUnauthorized"):
		last_sync_unauthorized = PKeyClaims.is_true(changes["lastSyncUnauthorized"])
	if changes.has("blocked"):
		blocked = PKeyGate.sanitize_blocked(changes["blocked"])
	if changes.has("importedBundle"):
		imported_bundle = changes["importedBundle"]
	return store.write_cache(_record)


## Persist whatever `apply_*` staged, with `changes` folded into the same single write.
func flush(changes: Dictionary = {}) -> bool:
	return patch(changes)


## Replace the record wholesale (only a bundle import does this, §7 step 5).
func replace(rec: Dictionary) -> bool:
	_record = rec.duplicate(true)
	return store.write_cache(_record)


## Wipe everything, in memory and on disk, the floor with it.
func clear() -> bool:
	_record = null
	_reset_loaded()
	trust.reset()
	clock.reset()
	return store.clear_cache()


func _reset_loaded() -> void:
	license = null
	config = null
	imported_bundle = null
	last_sync_unauthorized = false
	blocked = null
	last_verified_at = null


func _stage(slice: String, jws: String, p_etag: String) -> void:
	if not (_record is Dictionary):
		_record = {"v": VERSION}
	var docs: Dictionary = _record.get("docs", {})
	docs[slice] = jws
	_record["docs"] = docs
	var etags: Dictionary = _record.get("etags", {})
	if p_etag != "":
		etags[slice] = p_etag
	else:
		etags.erase(slice)
	if etags.is_empty():
		_record.erase("etags")
	else:
		_record["etags"] = etags


func _drop_slice(slice: String) -> void:
	for k in ["docs", "etags"]:
		if _record.get(k) is Dictionary:
			_record[k].erase(slice)
			if _record[k].is_empty():
				_record.erase(k)


## Only the CacheRecordV3 fields, each with its type; everything else is dropped.
static func _normalize(rec: Dictionary) -> Dictionary:
	var out := {"v": VERSION}
	if rec.get("trustJws") is String:
		out["trustJws"] = rec["trustJws"]
	for k in ["docs", "etags"]:
		if rec.get(k) is Dictionary:
			var m := {}
			for slice in SLICES:
				if rec[k].get(slice) is String:
					m[slice] = rec[k][slice]
			if not m.is_empty():
				out[k] = m
	var ib = rec.get("importedBundle")
	if ib is Dictionary and ib.get("bundleId") is String and PKeyClaims.is_number(ib.get("importedAt")):
		out["importedBundle"] = {"bundleId": ib["bundleId"], "importedAt": ib["importedAt"]}
	if PKeyClaims.is_true(rec.get("lastSyncUnauthorized")):
		out["lastSyncUnauthorized"] = true
	var b = PKeyGate.sanitize_blocked(rec.get("blocked"))
	if b != null:
		out["blocked"] = b
	return out
