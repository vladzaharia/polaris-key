class_name PKeyDevices
extends RefCounted
## `PolarisKey.devices`: the device principal's own surface (WIRE-CONTRACT-V3 §6; sdk-node
## `devices/client.ts` and `core/telemetry.ts`). Every call that waits is a coroutine returning
## a PKeyResult.
##
##   fingerprint()        the hashed fingerprint {components, hwid}, or null (web, opted out,
##                        nothing readable). The capture runs off the main thread, once a session
##   register()           keyless `POST /devices/register`: no bearer even when a token is held,
##                        the fingerprint when enabled; the token is stored with source
##                        `register`. Refused for four causes with one body
##                        (`registration_closed`) and limited to 10 a minute per IP: never retry it
##                        in a loop
##   get_current_device() this device from local state, no network
##   list()               `GET /devices`: the roster this credential can see
##   rename(label)        `PATCH /devices/<this device>`: self-only (server R3-09)
##   deauthorize()        `DELETE /devices/<this device>`, then the local wipe (token and cache),
##                        as license.deactivate does
##   report()             `POST /devices/report`, built from RE-VERIFIED documents (R4-05); also
##                        sent automatically after every sync (Core's post-sync hook), and skipped
##                        after a hard 401 with nothing applied
##   attest()             raise this device to trust level `attested` (P6-02): App Attest on an
##                        App Store or TestFlight install, Play Integrity on a Google Play install,
##                        through the native plugins; Unsupported elsewhere (see attest())
##
## register()'s detail keeps the three outcomes PKeyBoot must tell apart (P1-09 plan §2.2):
## {kind, status, answered} where `kind` is `ok`, `no-answer` (status 0: DNS, connect, TLS,
## reset or the request deadline), `registration-closed` (403), `rate-limited` (429),
## `not-configured` (404), `error` (any other status, or a 200 without a usable token), or
## `local-only`.

## The report's top-level keys, all on the Worker's allowlist (core/devices.ts REPORT_KEYS).
const REPORT_KEYS := ["os", "hardware", "runtime", "locale", "timezone", "probes", "sdk", "sdkVersion", "appVersion", "platform", "arch", "gate", "config", "entitlements", "engine", "outlet", "content", "caps"]
## The roster's wire fields and the names this API returns them under.
const DEVICE_FIELDS := {
	"id": "id",
	"licenseId": "license_id",
	"label": "label",
	"status": "status",
	"current": "current",
	"firstSeen": "first_seen",
	"lastSeen": "last_seen",
	"userAgent": "user_agent",
	"platform": "platform",
	"arch": "arch",
	"appVersion": "app_version",
	"sdkName": "sdk_name",
	"sdkVersion": "sdk_version",
}
const MAX_LABEL := 120
## The Keychain account (service `pkey:<product>`) holding this device's App Attest key id.
const APP_ATTEST_ACCOUNT := "app_attest_key"
## Distributor signals that are an App Store or TestFlight install (PolarisKeyPlatform's raw signals).
const STORE_SIGNALS := ["appStore", "testFlight"]

## A fingerprint host to read instead of this machine (tests). Null: this machine.
var fingerprint_host: PKeyHostIo = null
## Called after deauthorize() wiped the local state (the autoload re-emits its state).
var on_wiped: Callable
## The platform attest() answers for ("" means PKeyHeaders.platform()). Tests set it.
var attest_platform := ""
## The native facades attest() uses (null: PKeyApple.shared() / PKeyAndroid.shared()). Tests set them.
var apple: PKeyApple = null
var android: PKeyAndroid = null

var _core_ref: WeakRef


func _init(core: PKeyCore) -> void:
	_core_ref = weakref(core)


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## Install the automatic report after each sync (Core's post-sync hook).
func install(core: PKeyCore) -> void:
	core.add_post_sync_hook(_after_sync)


func _after_sync(_core_in: PKeyCore, _result: PKeySyncResult) -> void:
	await report()


# ── Fingerprint ──────────────────────────────────────────────────────────────────────────

## This device's hashed fingerprint {components, hwid}, or null when collection is disabled
## (PKeyOptions.fingerprint_enabled), unsupported (web) or nothing could be read. Raw values
## never leave PKeyFingerprint. A coroutine.
func fingerprint() -> Variant:
	var core := _core()
	if core == null or not core.options.fingerprint_enabled:
		return null
	return await PKeyFingerprint.collect(core.product, fingerprint_host)


# ── Registration ─────────────────────────────────────────────────────────────────────────

## Keyless registration; on success the token replaces any held one, with source `register`.
## ok with detail {kind: "ok", status: 200, answered: true, device_id, stored}; `stored` is false
## when the store could not write the token (it is still held for this session, and
## `store_error` fired). A coroutine.
func register() -> PKeyResult:
	var r := await request_registration()
	if not r.ok:
		return r
	var core := _core()
	var token: String = r.detail["token"]
	var stored := core.tokens.set_token(token, PKeyTokenManager.SOURCE_REGISTER)
	r.detail.erase("token")
	r.detail["stored"] = stored
	return r


## The registration request alone, without storing the token: register() stores it; P1-03's
## re-register on 401 hands it to the token manager instead, so the request is byte-identical on
## both paths. ok with detail {kind: "ok", status, answered, token, device_id}. A coroutine.
func request_registration() -> PKeyResult:
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call start() before register().", {"kind": "error", "status": 0, "answered": false})
	if core.local_only:
		return PKeyResult.failure(PKeyErrors.LOCAL_ONLY, "This client is local-only; registration is refused.", {"kind": "local-only", "status": 0, "answered": false})
	var fp = await fingerprint()
	var body = {"fingerprint": fp} if fp is Dictionary else null
	# PX-W13 §8 Q2: the device label rides along, seeding the device's name in the lists.
	var label := PKeyDeviceLabel.resolve("", core.options)
	if label != "":
		if body == null:
			body = {}
		body["deviceName"] = label
	var r := await core.request("POST", "devices/register", body, false)
	var status := _status(r)
	if status == 0:
		return PKeyResult.failure(r.code, r.message, {"kind": "no-answer", "status": 0, "answered": false})
	if r.ok:
		var parsed := PKeyJson.parse_bytes(r.detail["body"])
		var v = parsed["value"] if parsed["ok"] else null
		if status == 200 and v is Dictionary and v.get("token") is String and String(v["token"]).begins_with("pkeyt_"):
			return PKeyResult.success({
				"kind": "ok", "status": status, "answered": true, "token": v["token"],
				"device_id": v["deviceId"] if v.get("deviceId") is String else core.device_id,
			})
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "Registration answered %d without a usable token." % status, {"kind": "error", "status": status, "answered": true})
	var kind := "error"
	var code := r.code
	match status:
		403:
			kind = "registration-closed"
			code = PKeyErrors.REGISTRATION_CLOSED
		429:
			kind = "rate-limited"
			code = PKeyErrors.RATE_LIMITED
		404:
			kind = "not-configured"
			code = PKeyErrors.NOT_FOUND
	return PKeyResult.failure(code, r.message, {"kind": kind, "status": status, "answered": true})


static func _status(r: PKeyResult) -> int:
	return int(r.detail.get("status", 0)) if r.detail is Dictionary else 0


# ── Management ───────────────────────────────────────────────────────────────────────────

## This device from local state: {id, current: true, status, license_id?, last_verified_at?}.
func get_current_device() -> Dictionary:
	var core := _core()
	if core == null:
		return {}
	var out := {"id": core.device_id, "current": true}
	if not core.started:
		out["status"] = "needs-activation"
		return out
	out["status"] = core.license_state()["status"]
	if core.cache.license != null:
		out["license_id"] = core.cache.license["doc"]["licenseId"]
	if core.cache.last_verified_at != null:
		out["last_verified_at"] = core.cache.last_verified_at
	return out


## `GET /devices`. ok with detail {current_device_id, devices: [ {id, license_id?, label?,
## status, current, first_seen?, last_seen?, platform?, arch?, app_version?, sdk_name?,
## sdk_version?} ]}. Without a token there is no roster to fetch: ok with this device alone and
## `roster: false`, the honest offline answer. A coroutine.
func list() -> PKeyResult:
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call start() first.")
	if not core.tokens.has_token():
		return PKeyResult.success({"current_device_id": core.device_id, "devices": [get_current_device()], "roster": false})
	var r := await core.request("GET", "devices", null, true)
	if not r.ok:
		return r
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "The device list is not a JSON object.", {"status": _status(r)})
	var v: Dictionary = parsed["value"]
	var devices: Array = []
	var roster: Array = v["devices"] if v.get("devices") is Array else []
	for d in roster:
		if d is Dictionary:
			devices.append(_device(d))
	var current_id: String = v["currentDeviceId"] if v.get("currentDeviceId") is String else core.device_id
	return PKeyResult.success({"current_device_id": current_id, "devices": devices, "roster": true})


## A roster entry with this API's field names; unknown fields are dropped.
static func _device(d: Dictionary) -> Dictionary:
	var out := {}
	for k in DEVICE_FIELDS:
		if d.has(k) and d[k] != null:
			out[DEVICE_FIELDS[k]] = d[k]
	return out


## `PATCH /devices/<this device>` with {label}. `label` is a String (the server trims it and
## keeps 120 characters) or null to clear it. ok with detail {device}. A coroutine.
func rename(label: Variant) -> PKeyResult:
	var core := _core()
	var pre = _require_token(core)
	if pre != null:
		return pre
	if not (label == null or label is String):
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "label must be a String or null.")
	var r := await core.request("PATCH", "devices/%s" % core.device_id.uri_encode(), {"label": label}, true)
	if not r.ok:
		return r
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var device = parsed["value"].get("device") if parsed["ok"] and parsed["value"] is Dictionary else null
	return PKeyResult.success({"device": _device(device) if device is Dictionary else {}})


## `DELETE /devices/<this device>`, then the local wipe (the token and the verified cache),
## whatever the server answered: the wipe is mandatory, as in license.deactivate. ok when the
## server confirmed and the wipe succeeded; otherwise the server's code (or `store-failed`), with
## detail {remote_ok, wiped}. A coroutine.
func deauthorize() -> PKeyResult:
	var core := _core()
	var pre = _require_token(core)
	if pre != null:
		return pre
	var r := await core.request("DELETE", "devices/%s" % core.device_id.uri_encode(), null, true)
	var wiped := core.tokens.clear()
	wiped = core.cache.clear() and wiped
	if on_wiped.is_valid():
		on_wiped.call()
	var detail := {"remote_ok": r.ok, "wiped": wiped}
	if not r.ok:
		return PKeyResult.failure(r.code, r.message, detail)
	if not wiped:
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The local credential or cache could not be removed.", detail)
	return PKeyResult.success(detail)


func _require_token(core: PKeyCore) -> Variant:
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call start() first.")
	if not core.tokens.has_token():
		return PKeyResult.failure(PKeyErrors.DEVICE_MANAGEMENT_UNSUPPORTED, "Activate or register before managing this device.")
	return null


# ── Telemetry ────────────────────────────────────────────────────────────────────────────

## The report body: this device's facts, the SDK and build, the gate verdict, and the VALUES of
## the documents Core re-verified this session (never anything read back from disk unverified),
## plus `engine` and `outlet`: PKeyCore.reported_outlet(), the detected outlet id (the stamped
## outlet refined by on-device detection, P3-11), when there is one, and `caps`: the feature ids
## `PolarisKey.supports()` answers ok for right now (P1b-10). Every report carries `caps`, because
## the Worker keeps only the latest report.
func snapshot() -> Dictionary:
	var core := _core()
	var out := {}
	var facts := PKeyFacts.collect(core.options.probes if core != null else [])
	for k in facts:
		out[k] = facts[k]
	if core == null:
		return out
	out["sdk"] = PKeyHeaders.SDK_NAME
	out["sdkVersion"] = core.sdk_version
	out["appVersion"] = core.version
	if PKeyHeaders.platform() != "":
		out["platform"] = PKeyHeaders.platform()
	if PKeyHeaders.arch() != "":
		out["arch"] = PKeyHeaders.arch()
	out["gate"] = {"status": core.license_state()["status"]}
	out["config"] = _values(core.cache.config["doc"].get("config") if core.cache.config != null else null)
	out["entitlements"] = _values(core.cache.license["doc"].get("entitlements") if core.cache.license != null else null)
	out["engine"] = PKeyFacts.engine()
	var outlet := core.reported_outlet()
	if outlet != "":
		out["outlet"] = outlet
	out["caps"] = core.capability_engine().caps()
	# plans/P4-01.md §2.11: the running pack set's packSetId (embedded baselines included), once
	# packs have started.
	if core.packs != null and core.packs.has_method("pack_set_id"):
		var set_id = core.packs.pack_set_id()
		if set_id is String:
			out["content"] = {"packSetId": set_id}
	# P6-03: the updater's queued update events (update_downloaded, update_applied,
	# update_confirmed, boot_rolled_back), at most 16; dropped from the queue once reported.
	if core.update_events != null:
		var ev: Array = core.update_events.pending_events()
		if not ev.is_empty():
			out["updates"] = ev
	return out


## {key: value} from a signed `{key: {value, …}}` map.
static func _values(m: Variant) -> Dictionary:
	var out := {}
	if m is Dictionary:
		for k in m:
			if m[k] is Dictionary and m[k].has("value"):
				out[k] = m[k]["value"]
	return out


## `POST /devices/report`, best-effort: true when the server accepted it. Never fails a sync and
## never raises; false without a token or on any failure. A coroutine.
func report() -> bool:
	var core := _core()
	if core == null or not core.started or core.local_only or not core.tokens.has_token():
		return false
	var body := snapshot()
	var r := await core.request("POST", "devices/report", body, true)
	if r.ok and body.get("updates") is Array and core.update_events != null:
		core.update_events.mark_reported(body["updates"].map(func(e): return e["eventId"]))
	return r.ok


# ── Attestation (P6-02) ──────────────────────────────────────────────────────────────────

## Prove this is a genuine store install and raise the device to trust level `attested`
## (`POST /devices/attest/challenge`, then `POST /devices/attest`). The device token and the signed
## documents do not change; the Worker records the level. A coroutine.
##
## ok with detail {trust_level: "attested", kind: "app-attest" | "play-integrity", attested_at}.
## Unsupported (PARITY §2.2; the device simply stays `basic`, which is expected, not suspicious):
##   `runtime`  linux, macos, windows and web: no attestation service the Worker verifies; also an
##              iOS device where App Attest does not run (the simulator)
##   `outlet`   an iOS install that is not from the App Store or TestFlight (AppDistributor, or an
##              embedded provisioning profile), an Android install Google Play did not make or the
##              direct build of the plugin, and a mobile build without the native plugin
## Otherwise a failure carries the server's code verbatim (`unauthorized`, `rate_limited` — a few
## per hour per device —, `attestation_unavailable` when the product is not set up for this kind,
## `attestation_rejected` when verification failed), or `platform-error` / `timeout` from the
## plugin with its reply as detail, `no-token`/`device-management-unsupported` before
## registration, `local-only`, `invalid-response`.
##
## iOS keeps the App Attest key id in the Keychain (account `app_attest_key`) and reuses it; a key
## the system no longer knows (reinstall, device migration, restore from a backup) is dropped and a
## fresh one attested in the same call. Android requests a standard Play Integrity token for the
## cloud project number in the challenge (`play.cloudProjectNumber`), else
## PKeyOptions.play_cloud_project_number.
func attest() -> PKeyResult:
	var feature := PKeyConstants.Feature.DEVICES_ATTEST
	var platform := attest_platform if attest_platform != "" else PKeyHeaders.platform()
	if platform != PKeyConstants.Platform.IOS and platform != PKeyConstants.Platform.ANDROID:
		return PKeyResult.unsupported(feature, PKeyConstants.UnsupportedReason.RUNTIME, "Device attestation needs an iOS or Android store install; a %s build stays at the basic trust level." % (platform if platform != "" else "desktop"))
	var gate: PKeyResult
	if platform == PKeyConstants.Platform.IOS:
		gate = await _apple_gate()
	else:
		gate = _android_gate()
	if not gate.ok:
		return gate
	var core := _core()
	var pre = _require_token(core)
	if pre != null:
		return pre
	if core.local_only:
		return PKeyResult.failure(PKeyErrors.LOCAL_ONLY, "This client is local-only; attestation is refused.")

	var ch := await core.request("POST", "devices/attest/challenge", null, true)
	if not ch.ok:
		return ch
	var parsed := PKeyJson.parse_bytes(ch.detail["body"])
	var v = parsed["value"] if parsed["ok"] else null
	if not (v is Dictionary and v.get("challenge") is String and v.get("requestHash") is String and v["challenge"] != "" and v["requestHash"] != ""):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "The attestation challenge has no challenge or requestHash.", {"status": _status(ch)})
	var challenge: String = v["challenge"]
	var request_hash: String = v["requestHash"]

	var body := {}
	if platform == PKeyConstants.Platform.IOS:
		var a := await _app_attest(core, request_hash)
		if not a.ok:
			return a
		body = {"kind": "app-attest", "keyId": a.detail["keyId"], "attestation": a.detail["attestation"], "challenge": challenge}
	else:
		var project := core.options.play_cloud_project_number
		if project == "" and v.get("play") is Dictionary and v["play"].get("cloudProjectNumber") is String:
			project = v["play"]["cloudProjectNumber"]
		if not project.is_valid_int() or project.begins_with("-") or project.begins_with("+") or int(project) <= 0:
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "No Play Integrity cloud project number: the operator has not configured one on the Worker and PKeyOptions.play_cloud_project_number is %s." % ("empty" if project == "" else "not digits"))
		var t := await _android().integrity_token(project, request_hash)
		if not t.ok:
			return t
		if not (t.detail.get("token") is String) or t.detail["token"] == "":
			return PKeyResult.failure(PKeyErrors.PLATFORM_ERROR, "The Android platform plugin answered no Play Integrity token.", t.detail)
		body = {"kind": "play-integrity", "token": t.detail["token"], "challenge": challenge}

	var r := await core.request("POST", "devices/attest", body, true)
	if not r.ok:
		return r
	parsed = PKeyJson.parse_bytes(r.detail["body"])
	var out = parsed["value"] if parsed["ok"] else null
	if not (out is Dictionary and out.get("trustLevel") is String):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "The attestation answer has no trustLevel.", {"status": _status(r)})
	return PKeyResult.success({
		"trust_level": out["trustLevel"],
		"kind": out["kind"] if out.get("kind") is String else body["kind"],
		"attested_at": int(out["attestedAt"]) if (out.get("attestedAt") is float or out.get("attestedAt") is int) else 0,
	})


func _apple() -> PKeyApple:
	return apple if apple != null else PKeyApple.shared()


func _android() -> PKeyAndroid:
	return android if android != null else PKeyAndroid.shared()


## iOS: the plugin is present, the install is from the App Store or TestFlight, and App Attest runs.
func _apple_gate() -> PKeyResult:
	var feature := PKeyConstants.Feature.DEVICES_ATTEST
	var a := _apple()
	if a.unsupported_reason() != "":
		return PKeyResult.unsupported(feature, PKeyConstants.UnsupportedReason.OUTLET, "The Apple platform plugin is not in this build, so it cannot attest; it stays at the basic trust level.")
	# This launch's AppDistributor read when it has arrived, else one now (raced against 2 s).
	var d = PKeyApple.launch_distributor()
	if not (d is Dictionary):
		var r := await a.distributor()
		if not r.ok:
			return r
		d = r.detail
	var why := _not_store_install(d)
	if why != "":
		return PKeyResult.unsupported(feature, PKeyConstants.UnsupportedReason.OUTLET, why)
	return a.app_attest_supported()


## "" when a distributor answer is an App Store or TestFlight install, else why not. `unavailable`
## is no evidence (below iOS 17.4, or AppDistributor did not answer): without an embedded
## provisioning profile the build is an App Store or TestFlight one (Distributor.swift).
static func _not_store_install(d: Dictionary) -> String:
	var sig := str(d.get("signal", ""))
	var provisioned: bool = d.get("provisioned") == true
	if (sig in STORE_SIGNALS or sig == "unavailable") and not provisioned:
		return ""
	return "Only an App Store or TestFlight install can attest (distributor %s%s); it stays at the basic trust level." % [sig, ", provisioned" if provisioned else ""]


## The capability engine's detector for devices.attest's `outlet` N/A (PolarisKey.supports and the
## report's `caps`): "" when this install may attest, else why not. Synchronous and offline: the
## plugin's presence, this launch's distributor read on iOS (none yet: no evidence against), and
## the plugin flavour and installer on Android.
static func attest_outlet_detail() -> String:
	match PKeyHeaders.platform():
		PKeyConstants.Platform.IOS:
			var a := PKeyApple.shared()
			if a.unsupported_reason() != "":
				return "The Apple platform plugin is not in this build, so it cannot attest."
			var d = PKeyApple.launch_distributor()
			return _not_store_install(d) if d is Dictionary else ""
		PKeyConstants.Platform.ANDROID:
			var a := PKeyAndroid.shared()
			if a.unsupported_reason() != "":
				return "The Android platform plugin is not in this build, so it cannot attest."
			var r := a.integrity_availability()
			return "" if r.ok else r.message
	return ""


## Android: the plugin is present, it is the play build, and Google Play installed the app.
func _android_gate() -> PKeyResult:
	var a := _android()
	if a.unsupported_reason() != "":
		return PKeyResult.unsupported(PKeyConstants.Feature.DEVICES_ATTEST, PKeyConstants.UnsupportedReason.OUTLET, "The Android platform plugin is not in this build, so it cannot attest; it stays at the basic trust level.")
	return a.integrity_availability()


## App Attest with the stored key id, re-attesting with a fresh key when the stored one is gone.
func _app_attest(core: PKeyCore, request_hash: String) -> PKeyResult:
	var a := _apple()
	var stored := ""
	var kr := a.keychain_get(core.product, APP_ATTEST_ACCOUNT)
	if kr.ok and kr.detail.get("value") is String:
		stored = kr.detail["value"]
	var r := await a.app_attest(request_hash, stored)
	if not r.ok and stored != "" and r.detail is Dictionary and r.detail.get("error") == "invalid_key":
		# The key died with a reinstall, a device migration or a restore: expected, not fraud.
		a.keychain_delete(core.product, APP_ATTEST_ACCOUNT)
		stored = ""
		r = await a.app_attest(request_hash, "")
	# Keep a key that exists now: the attested one, or a generated one whose attestation Apple's
	# service could not serve yet (retried later with the same key, as Apple advises).
	var key = r.detail.get("keyId") if r.detail is Dictionary else null
	var keep: bool = r.ok or (r.detail is Dictionary and r.detail.get("error") == "server_unavailable")
	if keep and key is String and key != "" and key != stored:
		a.keychain_set(core.product, APP_ATTEST_ACCOUNT, key)
	if r.ok and not (r.detail.get("keyId") is String and r.detail.get("attestation") is String):
		return PKeyResult.failure(PKeyErrors.PLATFORM_ERROR, "The Apple platform plugin answered no key id or attestation.", r.detail)
	return r

