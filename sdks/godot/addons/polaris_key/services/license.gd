class_name PKeyLicense
extends RefCounted
## `PolarisKey.license`: the licence gate, activation, keyless enrolment, deactivation and the
## signed grants (WIRE-CONTRACT-V3 §5; sdk-node `license/client.ts`). Every call that waits is a
## coroutine.
##
##   activation()            &"token" (a pkeyt_ device token is held), &"bundle" (an imported
##                           bundle left a verified licence document), or &"". A token
##                           supersedes a bundle
##   status() / is_licensed() the gate (PKeyGate.license_state, contract order); usable means
##                           ok, grace or not-applicable
##   is_entitled(name)       true only when the entitlement's value is the boolean true AND the
##                           gate is usable (S-19 G11: false after a revocation or expiry)
##   get_entitlements()      {name: value} off the verified licence document
##   get_profile()           the signed greeting block {name?, firstName?, email?,
##                           activatedAt?}, or null
##   get_license_user()      the account signed in on this device, {subject}, or null: the
##                           verified document's `profile.user` (SP-54). A key-activated device
##                           has the holder's email and no user, so it reads null
##   get_license_id()        the verified document's licence id, or ""
##   entitled_channels()     the `channels` entitlement's string values in order, as granted
##                           (raw: not de-duplicated, `staging` not rewritten), or ["stable"]
##                           when absent or not an array: the Worker's `entitledChannels`
##   activate_with_key(key)  `POST /license/activate` -> PKeyActivationResult; on ok the token is
##                           stored (source activate) and a forced sync runs before it returns
##   enroll()                `POST /license/enroll`, keyless, the same result shape (source
##                           enroll). Unsupported on web: a browser has no machine anchor, so
##                           the server could only refuse it (`fingerprint_required`)
##   deactivate()            `POST /license/deauthorize` best-effort, then the mandatory local
##                           wipe of the token and the verified cache (the device id stays)
##
## Both mint calls send the hashed fingerprint (PolarisKey.devices.fingerprint(), P1-05) unless
## PKeyOptions.fingerprint_enabled is off, in which case the request has no body at all.
##
## THE 401 RE-ACQUIRE. `install()` gives Core's token manager the one re-acquire (§5): a 401 on
## a document fetch (or an edge-mint) gets exactly one attempt, then one retry, and every
## concurrent 401 in a sync pass shares that attempt. Which route it takes is P1b-06's rule, the
## same in every SDK (PKeyTokenManager.choose_reacquire_route):
##   - License disabled for the product, or a token this process minted by registering
##     (devices.register(), or an earlier re-register): `POST /devices/register`, keyless, no
##     Authorization, the same device id and the fingerprint when enabled
##     (PKeyDevices.request_registration, byte-identical to register());
##   - otherwise: `POST /license/token` with the current token.
## After a restart the token's source is unknown (it is held in memory only), so a device on a
## product with License on asks `license/token`. A wrong guess is safe: the server answers a
## licensed id `registration_closed` and a licence-less one 401, never evicting a seat. A 403,
## 429 or any other failure from either route ends the pass as a hard 401
## (`lastSyncUnauthorized`, the offline `revoked` signal).
##
## Platform notes. On iOS, enrolling again after every one of the vendor's apps was uninstalled
## mints a NEW free licence (the vendor id, and so the machine anchor, is reset); this client
## does not work around it. Unlocking paid digital content with an externally bought key
## conflicts with App Store 3.1.1 and Play's payments policy; the client does not enforce that.

const FEATURE_ENROLL := PKeyConstants.Feature.LICENSE_ENROLL

## Awaited after a token is minted (activate, enroll): the autoload runs a forced sync, so the
## result returns with the licence document in hand. It returns that sync's PKeySyncResult, which
## decides whether the activation counts (see `_acquire`).
var on_acquired: Callable
## Called after the local state changed without a sync (deactivate's wipe).
var on_changed: Callable
## The route the last re-acquire took (PKeyTokenManager.ROUTE_*), or "" (tests, diagnostics).
var last_reacquire_route := ""

var _core_ref: WeakRef
var _devices: PKeyDevices


func _init(core: PKeyCore, devices: PKeyDevices) -> void:
	_core_ref = weakref(core)
	_devices = devices


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## Install the §5 re-acquire into Core's token manager.
func install(core: PKeyCore) -> void:
	core.tokens.set_reacquire(_reacquire)


# ── Gate ─────────────────────────────────────────────────────────────────────────────────

func activation() -> StringName:
	var core := _core()
	return StringName(core.activation()) if core != null and core.started else &""


## {status, grace_until?, last_verified_at?, allowed_range?}.
func status() -> Dictionary:
	var core := _core()
	if core == null or not core.started:
		return {"status": "needs-activation"}
	return core.license_state()


func is_licensed() -> bool:
	return PKeyGate.is_usable(status())


# ── Reads off the verified licence document ──────────────────────────────────────────────

func _doc() -> Variant:
	var core := _core()
	if core == null or core.cache == null or core.cache.license == null:
		return null
	return core.cache.license["doc"]


func _entitlements() -> Dictionary:
	var doc = _doc()
	return doc["entitlements"] if doc is Dictionary and doc.get("entitlements") is Dictionary else {}


## S-19 G11: an entitlement counts only while the gate is usable (ok, grace, not-applicable). A
## revoked, expired or blocked licence answers false even though its last verified document still
## lists the grant; get_entitlements() keeps reading the raw values for diagnostics.
func is_entitled(name: String) -> bool:
	if not is_licensed():
		return false
	var e = _entitlements().get(name)
	return e is Dictionary and PKeyClaims.is_true(e.get("value"))


func get_entitlements() -> Dictionary:
	var out := {}
	var ents := _entitlements()
	for k in ents:
		if ents[k] is Dictionary:
			out[k] = ents[k].get("value")
	return out


func get_profile() -> Variant:
	var doc = _doc()
	return doc["profile"].duplicate(true) if doc is Dictionary and doc.get("profile") is Dictionary else null


## SP-54: the signed-in subject of the verified licence document, or null. See `license_user_of`.
func get_license_user() -> Variant:
	return license_user_of(_doc())


## Port of client-core `licenseUserOf` (WIRE-CONTRACT-V4 §3.2). `{subject}` only when `doc.profile`
## is an object, its `user` is an object and that object's `subject` is a String that WHOLLY
## matches PAIRWISE_SUBJECT_PATTERN (PKeyClaims.matches_whole: no trailing newline, ASCII classes).
## Anything else is null; unknown members of `user` are ignored. Total: never errors on any value.
static func license_user_of(doc: Variant) -> Variant:
	if not (doc is Dictionary) or not (doc.get("profile") is Dictionary):
		return null
	var user = doc["profile"].get("user")
	if not (user is Dictionary):
		return null
	var subject = user.get("subject")
	if subject is String and PKeyClaims.matches_whole(PKeyConstants.PAIRWISE_SUBJECT_PATTERN, subject):
		return {"subject": subject}
	return null


func get_license_id() -> String:
	var doc = _doc()
	return doc["licenseId"] if doc is Dictionary and doc.get("licenseId") is String else ""


func entitled_channels() -> Array:
	return PKeyChannel.granted(_entitlements())


# ── Activation ───────────────────────────────────────────────────────────────────────────

## Exchange a licence key for a device token. A coroutine.
func activate_with_key(key: String) -> PKeyActivationResult:
	var pre = _precheck()
	if pre != null:
		return pre
	var k := key.strip_edges()
	if k == "" or not _printable(k):
		return PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.INVALID_OPTIONS, "The licence key is empty or contains spaces or control characters.")
	var core := _core()
	var pair: Array = await PKeyLicenseEndpoints.activate(core, k, await _devices.fingerprint())
	return await _acquire(pair, PKeyTokenManager.SOURCE_ACTIVATE)


## Obtain a licence with no key and no sign-in, where the product offers a free tier. A
## coroutine.
func enroll() -> PKeyActivationResult:
	var pre = _precheck()
	if pre != null:
		return pre
	var supported := _core().capability_engine().supports_on(FEATURE_ENROLL, _platform())
	if not supported.ok:
		return PKeyActivationResult.from_unsupported(supported)
	var core := _core()
	var pair: Array = await PKeyLicenseEndpoints.enroll(core, await _devices.fingerprint())
	return await _acquire(pair, PKeyTokenManager.SOURCE_ENROLL)


func _acquire(pair: Array, source: String) -> PKeyActivationResult:
	var res: PKeyActivationResult = pair[0]
	if not res.ok:
		return res
	var core := _core()
	if core == null:
		return PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "The SDK was reconfigured during activation.")
	res.stored = core.tokens.set_token(pair[1], source)
	if on_acquired.is_valid():
		var synced = await on_acquired.call()
		var problem := unverified(core, synced, "the key was accepted")
		if not problem.is_empty():
			# The key was accepted, but the document it earned did not arrive or did not verify:
			# the device is not activated, whatever the answer said. The token stays, so a retry
			# after the clock or the pins are fixed needs no key.
			return PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, problem["code"], problem["message"], int(problem["status"]))
	return res


## What stopped a just-minted token from earning a usable licence document: {} when nothing did,
## else {code, message, status} with code `invalid-response`: the Worker answered with a document
## that did not verify (an unpinned signer, a clock outside its window), so the activation does not
## count. A document that did not arrive (no answer, a 5xx) is not this: the token is good and the
## next sync fetches it.
static func unverified(core: PKeyCore, synced: Variant, what := "the token was minted") -> Dictionary:
	if core == null or not core.enabled("license") or not (synced is PKeySyncResult):
		return {}
	var s: PKeySyncResult = synced
	var kind := String(s.documents.get("license", ""))
	if kind != "error":
		return {}
	var e: Dictionary = s.errors.get("license", {"status": 0, "code": ""})
	var status := int(e.get("status", 0))
	var code := String(e.get("code", ""))
	if status == 200 or code == String(PKeyErrors.INVALID_RESPONSE):
		push_error("Polaris Key: %s but the license document did not verify. Check that the pinned trust keys (pinned_trust_keys, polaris_key.tres) are the product's signing keys and that this device's clock is right (a document is only valid inside its window)." % what)
		return {"code": PKeyErrors.INVALID_RESPONSE, "message": "The license document did not verify.", "status": 200}
	return {}


func _precheck() -> Variant:
	var core := _core()
	if core == null or not core.started:
		return PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "Call start() first.")
	if core.local_only:
		return PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.LOCAL_ONLY, "This client is local-only; activation is refused.")
	return null


## The platform the fingerprint reads (the devices host, which tests replace).
func _platform() -> String:
	var host: PKeyHostIo = _devices.fingerprint_host if _devices != null and _devices.fingerprint_host != null else PKeyHostIo.new()
	return host.platform()


## Visible ASCII only: a key goes into a header, so whitespace and control characters (a header
## injection) are refused before anything is sent.
static func _printable(s: String) -> bool:
	for i in s.length():
		var c := s.unicode_at(i)
		if c < 0x21 or c > 0x7e:
			return false
	return true


# ── Deactivation ─────────────────────────────────────────────────────────────────────────

## Release this device's seat (best-effort) and wipe the token and the verified cache (always;
## the device id stays). ok when the server confirmed and the wipe succeeded. Otherwise a wipe
## failure wins (`store-failed`: it is returned, never swallowed), then the server's failure (its
## code, or the transport's: `network-error`, `timeout`, `local-only`, …). detail:
## {remote_attempted, remote_ok, wiped}. Without a token nothing is sent. A coroutine.
func deactivate() -> PKeyResult:
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call start() first.")
	var token := core.tokens.current()
	var remote: PKeyResult = null
	if token != "":
		remote = await PKeyLicenseEndpoints.deauthorize(core, token)
	var wiped := core.tokens.clear()
	wiped = core.cache.clear() and wiped
	if on_changed.is_valid():
		on_changed.call()
	var detail := {"remote_attempted": remote != null, "remote_ok": remote != null and remote.ok, "wiped": wiped}
	if not wiped:
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The local credential or cache could not be removed.", detail)
	if remote != null and not remote.ok:
		return PKeyResult.failure(remote.code, remote.message, detail)
	return PKeyResult.success(detail)


# ── The §5 re-acquire ────────────────────────────────────────────────────────────────────

## PKeyTokenManager's re-acquire callable: one attempt on the route P1b-06's rule picks.
## {token, source} on success, "" on any failure.
func _reacquire(core: PKeyCore, current: String) -> Variant:
	if core == null:
		return ""
	var route := PKeyTokenManager.choose_reacquire_route(core.enabled("license"), core.tokens.source())
	last_reacquire_route = route
	if route == PKeyTokenManager.ROUTE_DEVICES_REGISTER:
		var r: PKeyResult = await _devices.request_registration()
		return {"token": r.detail["token"], "source": PKeyTokenManager.SOURCE_REGISTER} if r.ok else ""
	var pair: Array = await PKeyLicenseEndpoints.token(core, current)
	return {"token": pair[1], "source": PKeyTokenManager.SOURCE_REACQUIRE} if (pair[0] as PKeyActivationResult).ok else ""
