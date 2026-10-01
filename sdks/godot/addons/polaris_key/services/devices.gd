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
##
## register()'s detail keeps the three outcomes PKeyBoot must tell apart (P1-09 plan §2.2):
## {kind, status, answered} where `kind` is `ok`, `no-answer` (status 0: DNS, connect, TLS,
## reset or the request deadline), `registration-closed` (403), `rate-limited` (429),
## `not-configured` (404), `error` (any other status, or a 200 without a usable token), or
## `local-only`.

## The report's top-level keys, all on the Worker's allowlist (core/devices.ts REPORT_KEYS).
const REPORT_KEYS := ["os", "hardware", "runtime", "locale", "timezone", "probes", "sdk", "sdkVersion", "appVersion", "platform", "arch", "gate", "config", "entitlements", "engine", "outlet"]
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

## A fingerprint host to read instead of this machine (tests). Null: this machine.
var fingerprint_host: PKeyHostIo = null
## Called after deauthorize() wiped the local state (the autoload re-emits its state).
var on_wiped: Callable

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
## plus `engine` and, when the build was stamped with one, `outlet`.
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
	var outlet := core.outlet()
	if outlet != "":
		out["outlet"] = outlet
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
	var r := await core.request("POST", "devices/report", snapshot(), true)
	return r.ok
