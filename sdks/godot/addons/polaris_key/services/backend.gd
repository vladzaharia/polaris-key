class_name PKeyBackend
extends RefCounted
## `PolarisKey.backend`: the client half of a product backend (WIRE-CONTRACT-V4 §14, framework
## drop-ins §6). It sends the app's signed licence document to the app's own backend.
##
##   var h := await PolarisKey.backend.headers()          # raw: PackedStringArray for HTTPRequest
##   http_request.max_redirects = 0                        # REQUIRED with raw headers, see below
##   http_request.request(url, h)
##
##   var r := await PolarisKey.backend.request("GET", "https://api.example.com/export")
##   # r.ok: r.detail = {status, headers, body, url}; refusals below
##
## The headers are `X-PKey-License` (the compact licence JWS, when one is held) and
## `X-PKey-Device`. Never the device token, never the config document.
##
## SECURITY. `request()` and `headers_for(url)` send only to an origin in `backend_origins`
## (exact scheme, host and port; https, or http on loopback). `request()` follows redirects by
## hand and checks EVERY hop's origin BEFORE it is sent: a hop to another origin is not sent and
## the call fails with `backend-origin-not-allowed`. `headers()` is raw and checks nothing: Godot's
## HTTPRequest re-sends its headers to a redirect target, so use it only with `max_redirects = 0`
## and the URL you checked yourself (`headers_for` does the check). An error message names the
## origin only (a path or query can hold a secret).
##
## The rule is `PKeyBackend.action()` (`backend-matrix.json`'s `client` section): a document
## within REFRESH_MARGIN_SECONDS of its expiry is synced before sending; `license_stale` and
## `license_invalid` (401) force one sync and one retry; `not_entitled` and `sign_in_required`
## (403) are never retried and come back as failures with that code. Concurrent callers share one
## sync, and two forced syncs are at least 10 s apart. A failed sync hands back the backend's own
## response.

const HEADER_LICENSE := "X-PKey-License"
const HEADER_DEVICE := "X-PKey-Device"
## The least time between two forced syncs, seconds.
const FORCED_SYNC_MIN_INTERVAL_SECONDS := 10.0

const ACTION_SEND := "send"
const ACTION_REFRESH_THEN_SEND := "refresh-then-send"
const ACTION_REFRESH_AND_RETRY := "refresh-and-retry"
const ACTION_SURFACE := "surface"

## One in-flight sync, shared by concurrent callers.
class Flight:
	extends RefCounted
	signal done(ok: bool)
	var force := false
	var finished := false
	var ok := false

var _core_ref: WeakRef = null
## `func(force: bool) -> PKeySyncResult`, set by the SDK root.
var _sync: Callable = Callable()
## `func() -> float`, seconds on a clock that never goes back. Tests replace it.
var monotonic: Callable = func() -> float: return Time.get_ticks_msec() / 1000.0
var _allowed: Dictionary = {}
var _origins: PackedStringArray = PackedStringArray()
var _flight: Flight = null
var _last_forced := -1.0


## Bind to a configured Core. `sync` is `func(force: bool) -> PKeySyncResult`. `origins`:
## `PKeyOptions.backend_origins`. Fails with `invalid-options` on a malformed origin (configure()
## checks them first, so it does not).
func attach(core: PKeyCore, sync: Callable, origins: PackedStringArray) -> PKeyResult:
	var allowed := {}
	for o in origins:
		var n := normalize_origin(o)
		if n == "":
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "backend_origins: \"%s\" is not an exact origin (https://host[:port]; http only on loopback)." % o)
		allowed[n] = true
	_core_ref = weakref(core)
	_sync = sync
	_allowed = allowed
	var keys := allowed.keys()
	keys.sort()
	_origins = PackedStringArray(keys)
	_flight = null
	_last_forced = -1.0
	return PKeyResult.success()


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## The configured origins, normalised and sorted.
func origins() -> PackedStringArray:
	return _origins


## One exact origin as `scheme://host:port` (lower-cased, the default port filled in), or ""
## when `origin` is not one: a wildcard, a path, query, fragment or userinfo, http off loopback.
static func normalize_origin(origin: String) -> String:
	if origin.contains("*") or origin.ends_with("?") or origin.ends_with("#"):
		return ""
	var u := PKeyTransport.parse_url(origin)
	if u.is_empty():
		return ""
	var rest := origin.substr(origin.find("://") + 3)
	var slash := rest.find("/")
	if slash >= 0 and rest.substr(slash) != "/":
		return ""
	if rest.contains("?") or rest.contains("#") or rest.contains("@"):
		return ""
	if u["scheme"] != "https" and not PKeyTransport.LOOPBACK_HOSTS.has(u["host"]):
		return ""
	return u["origin"]


## §14.5: "send", "refresh-then-send", "refresh-and-retry" or "surface". `document`: {issuedAt,
## expiresAt} or null; `response`: {status, code} (code "" or null for none) or null before
## sending.
static func action(document: Variant, now: float, response: Variant, retried := false) -> String:
	if response == null:
		if document == null:
			return ACTION_SEND
		return ACTION_REFRESH_THEN_SEND if now > float(document["expiresAt"]) - PKeyClaims.REFRESH_MARGIN_SECONDS else ACTION_SEND
	var code := String(response.get("code")) if response.get("code") != null else ""
	if int(response["status"]) == 401 and (code == "license_stale" or code == "license_invalid") and not retried:
		return ACTION_REFRESH_AND_RETRY
	return ACTION_SURFACE


# ── The headers ────────────────────────────────────────────────────────────────────────────

## `X-PKey-License` and `X-PKey-Device` as "Name: value" lines, raw. A document within the refresh
## margin of its expiry is synced first. Without a licence only `X-PKey-Device`. A coroutine.
func headers() -> PackedStringArray:
	if _core() == null:
		return PackedStringArray()
	await _freshen()
	return _lines(_build())


## `headers()` for `url`: ok with detail = the lines, or `backend-origin-not-allowed` (nothing is
## synced, nothing is built). A coroutine.
func headers_for(url: String) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var refused := _check(url)
	if refused != null:
		return refused
	return PKeyResult.success(await headers())


func _build() -> Dictionary:
	var core := _core()
	var out := {}
	var held = core.cache.license
	if held != null:
		out[HEADER_LICENSE] = String(held["jws"])
	out[HEADER_DEVICE] = core.device_id
	return out


func _lines(h: Dictionary) -> PackedStringArray:
	var lines := PackedStringArray()
	for k in h:
		lines.append("%s: %s" % [k, h[k]])
	return lines


func _document() -> Variant:
	var held = _core().cache.license
	if held == null:
		return null
	return {"issuedAt": held["doc"]["issuedAt"], "expiresAt": held["doc"]["expiresAt"]}


func _freshen() -> void:
	if action(_document(), _core().clock.now(), null) == ACTION_REFRESH_THEN_SEND:
		await _shared(false)


# ── One shared sync ────────────────────────────────────────────────────────────────────────

## One sync for every concurrent caller; a forced caller joins only a forced one. True when the
## licence document is now current (applied or unchanged).
func _shared(force: bool) -> bool:
	var live := _flight
	if live != null and (live.force or not force):
		if live.finished:
			return live.ok
		return await live.done
	if force:
		var at: float = monotonic.call()
		if _last_forced >= 0.0 and at - _last_forced < FORCED_SYNC_MIN_INTERVAL_SECONDS:
			return false
		_last_forced = at
	var mine := Flight.new()
	mine.force = force
	_flight = mine
	var ok := false
	if _sync.is_valid():
		var r = await _sync.call(force)
		ok = r is PKeySyncResult and r.ok and not r.unauthorized and ["applied", "unchanged"].has(r.documents.get("license", ""))
	mine.ok = ok
	mine.finished = true
	if _flight == mine:
		_flight = null
	mine.done.emit(ok)
	return ok


# ── request() ──────────────────────────────────────────────────────────────────────────────

## One request to an allowed origin with the licence headers attached; redirects followed by
## hand, each hop's origin checked before it is sent. `headers` (name -> value) are yours;
## `Authorization` passes through untouched. ok: detail = {status, headers, body, url} for any
## status the backend answered, including a 401 left after the one retry. Fails with
## `backend-origin-not-allowed`, `not_entitled`, `sign_in_required` or the transport's code. A
## coroutine.
func request(method: String, url: String, headers: Dictionary = {}, body: PackedByteArray = PackedByteArray()) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var refused := _check(url)
	if refused != null:
		return refused
	await _freshen()
	var r := await _send(core, method, url, headers, body)
	if not r.ok:
		return r
	var code := _problem_code(r.detail)
	if action(_document(), core.clock.now(), {"status": r.detail["status"], "code": code}) == ACTION_REFRESH_AND_RETRY:
		if await _shared(true):
			r = await _send(core, method, url, headers, body)
			if not r.ok:
				return r
			code = _problem_code(r.detail)
	if int(r.detail["status"]) == 403 and (code == "not_entitled" or code == "sign_in_required"):
		return PKeyResult.failure(StringName(code), core.copy.message(code), {"status": 403})
	return r


## Every hop is checked before it is sent; the transport itself follows none.
func _send(core: PKeyCore, method: String, url: String, headers: Dictionary, body: PackedByteArray) -> PKeyResult:
	var m := method.to_upper()
	var h := headers.duplicate()
	for k in _build():
		h[k] = _build()[k]
	var b := body
	var current := url
	for hop in PKeyTransport.MAX_REDIRECTS + 1:
		var refused := _check(current)
		if refused != null:
			return refused
		var r := await core.transport.request(m, current, h, b, {"follow_redirects": false})
		if not r.ok:
			return r
		var location: String = String(r.detail["headers"].get("location", ""))
		if not [301, 302, 303, 307, 308].has(int(r.detail["status"])) or location == "":
			return r
		current = PKeyTransport.resolve(current, location)
		if int(r.detail["status"]) == 303 or ([301, 302].has(int(r.detail["status"])) and m == "POST"):
			m = "GET"
			b = PackedByteArray()
			for k in h.keys():
				if String(k).to_lower() == "content-type":
					h.erase(k)
	return PKeyResult.failure(PKeyErrors.TOO_MANY_REDIRECTS, "More than %d redirects." % PKeyTransport.MAX_REDIRECTS)


## null when `url` is on an allowed origin, else the refusal (the origin only).
func _check(url: String) -> PKeyResult:
	var u := PKeyTransport.parse_url(url)
	var origin: String = u.get("origin", "")
	if origin != "" and _allowed.has(origin):
		return null
	var core := _core()
	var copy: PKeyCopy = core.copy if core != null else PKeyCopy.shared()
	var shown := origin if origin != "" else "an unreadable URL"
	return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.BACKEND_ORIGIN_NOT_ALLOWED), copy.message(PKeyConstants.ErrorCode.BACKEND_ORIGIN_NOT_ALLOWED, {}, shown))


func _problem_code(d: Dictionary) -> String:
	var status := int(d["status"])
	if status != 401 and status != 403:
		return ""
	var parsed := PKeyJson.parse_bytes(d["body"])
	if parsed["ok"] and parsed["value"] is Dictionary and parsed["value"].get("code") is String:
		return parsed["value"]["code"]
	return ""
