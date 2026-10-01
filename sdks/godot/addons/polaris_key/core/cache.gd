class_name PKeyCache
extends RefCounted
## The verified cache (WIRE-CONTRACT-V3 §4.1): sdk-node `core/cache.ts` over the
## `CacheRecordV3` shape of `client-core/src/store.ts`, exactly:
##
##   {v: 3, trustJws?, docs?: {license?, config?}, etags?: {license?, config?},
##    importedBundle?: {bundleId, importedAt}, lastSyncUnauthorized?, blocked?: {reason,
##    allowedRange?}, feeds?: {<canonical channel>: pkey-feed+jws},
##    releaseRecords?: {<sha256>: pkey-release+jws}}
##
## `feeds` and `releaseRecords` are WIRE-CONTRACT-V4 §4's two additive slices (CACHE_VERSION
## stays 3): `feeds` is keyed by each feed's own `channel` claim (the canonical channel, never the
## requested name), and `releaseRecords` by lowercase hex SHA-256.
##
## SIGNED ARTIFACTS ONLY, plus ETags (non-security) and two unsigned hints that can only make the
## gate stricter. The load procedure is the security boundary:
##
##   1. a record whose `v` is not 3 is DISCARDED, never migrated (3.0 == 3: numbers are floats);
##   2. `trustJws` is re-verified against the PINS, freshness off -> the effective set;
##   3. each document is re-verified against THAT set, freshness off, full claims, `aud` and
##      the local `deviceId`;
##   4. each committed feed goes through the feed reload path (PKeyFeed.reload_feeds: steps 3–6
##      against THAT set, no freshness, its claim equal to its key) and each release record
##      through steps 12–14 with its key as the pin, kept only while a surviving feed's target
##      for this platform pins it (PKeyReleaseRecord.reload_release_records);
##   5. every derived value (the anti-replay floors, each channel's `seq` floor, the clock
##      floor, `last_verified_at`) is computed from what verified. Nothing derived is ever read
##      from the file, and unknown fields are dropped from the in-memory record. Neither a feed
##      nor a record raises the clock floor.
##
## A failing artifact is ABSENT for the session (and rewritten out on the next write), never
## half-trusted. Writes are one whole-record write per sync (`flush`), so two parallel document
## fetches can never clobber each other's slice. Nothing is double-verified on reload.

const VERSION := 3
const SLICES := ["license", "config"]
## The wire v4 update slices (WIRE-CONTRACT-V4 §4).
const UPDATE_SLICES := ["feeds", "releaseRecords"]

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
## The platform the update slices are reloaded for (a record is kept only while a committed
## feed's target for this platform pins it); set by Core before load_record().
var platform := ""
## `pinned_release_keys`: what each cached release record re-verifies against.
var release_keys: Dictionary = {}
## The committed feeds that survived the reload path: {canonical channel: {jws, feed}}.
var feeds: Dictionary = {}
## Each committed channel's `seq` floor, derived from `feeds` (never persisted): {channel:
## {seq, issuedAt}}.
var feed_floors: Dictionary = {}
## The verified release records a committed feed pins: {sha256: {jws, record}}.
var release_records: Dictionary = {}

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

	await _load_update_slices()

	imported_bundle = _record.get("importedBundle")
	last_sync_unauthorized = PKeyClaims.is_true(_record.get("lastSyncUnauthorized"))
	blocked = _record.get("blocked")
	last_verified_at = newest if newest > 0 else null


## Steps 4–5 for the update slices: re-verify, derive the floors, drop whatever failed.
func _load_update_slices() -> void:
	if not _record.has("feeds") and not _record.has("releaseRecords"):
		return
	var effective := trust.effective()
	var reloaded := await PKeyFeed.reload_feeds(_record.get("feeds"), {
		"trust": effective, "expected_aud": product, "platform": platform, "offload": true,
	})
	feeds = reloaded["feeds"]
	feed_floors = reloaded["floors"]
	var pinned := {}
	for k in feeds:
		var t = PKeyDecision.feed_target(feeds[k]["feed"]["app"]["targets"], platform)
		if t is Dictionary:
			pinned[t["release"]["sha256"]] = true
	release_records = await PKeyReleaseRecord.reload_release_records(_record.get("releaseRecords"), {
		"release_keys": release_keys, "product_trust": effective, "expected_aud": product,
		"pinned": pinned, "offload": true,
	})
	_set_update_slices(_jws_map(feeds), _jws_map(release_records))


## Commit what a decision verified (PolarisKey.update): the `feeds` and `releaseRecords` slices
## as PKeyUpdateFlow returned them, in one read-modify-write of the whole record, and the
## in-memory views beside them. Returns the store's verdict.
func apply_update(committed: Dictionary, records: Dictionary) -> bool:
	feeds = committed
	feed_floors = {}
	for k in feeds:
		feed_floors[k] = PKeyFeed.feed_floor(feeds[k]["feed"])
	release_records = records
	var f := _jws_map(feeds)
	var r := _jws_map(release_records)
	return patch({"feeds": f if not f.is_empty() else null, "releaseRecords": r if not r.is_empty() else null})


static func _jws_map(m: Dictionary) -> Dictionary:
	var out := {}
	for k in m:
		out[k] = m[k]["jws"]
	return out


func _set_update_slices(f: Dictionary, r: Dictionary) -> void:
	if f.is_empty():
		_record.erase("feeds")
	else:
		_record["feeds"] = f
	if r.is_empty():
		_record.erase("releaseRecords")
	else:
		_record["releaseRecords"] = r


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
	feeds = {}
	feed_floors = {}
	release_records = {}


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
	for slice in UPDATE_SLICES:
		if rec.get(slice) is Dictionary:
			var m := {}
			for k in rec[slice]:
				if k is String and rec[slice][k] is String:
					m[k] = rec[slice][k]
			if not m.is_empty():
				out[slice] = m
	return out
