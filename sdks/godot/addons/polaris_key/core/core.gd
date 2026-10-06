class_name PKeyCore
extends RefCounted
## Core's live state (sdk-node `core/context.ts`): the device principal, the credential, the
## trust set, the verified cache, the monotonic clock floor, the capability map and the
## transport. Every service client is handed this object (`PolarisKey.core`).
##
## Hooks for later packages:
##   request(method, path, body, auth)  every service client's HTTP call (a PKeyResult)
##   tokens.set_reacquire(callable)     the 401 re-acquire (P1-03)
##   add_post_sync_hook(callable)       telemetry after each sync (P1-05)
##   PKeyDeviceId.set_raw_source(...)   replaces the device-id raw source (default: P1-05's
##                                      desktop sources, PKeyFingerprint.device_id_raw)

## A store operation failed: {op, path, error, message}.
signal store_error(err: Dictionary)

const DEFAULT_BASE := "https://key.plrs.im"

var options: PKeyOptions
var product := ""
var base_url := ""
var version := ""
var channel := ""
var sdk_version := ""
## The build stamp (PKeyBuildStamp.read), or null for a build without one.
var build_stamp = null
## What outlet detection reads (P3-11); the real runtime when null. Tests set a fake install.
var outlet_env: PKeyOutletEnv = null:
	set(v):
		outlet_env = v
		_detection = null
## This session's detection result, once it ran: detection runs at every launch and is never
## persisted (plans/P3-01.md §2.9).
var _detection = null
var local_only := false
var trust_refresh := true
var store: PKeyStore
var transport: PKeyTransport
var clock: PKeyClock
var trust: PKeyTrust
var tokens: PKeyTokenManager
var cache: PKeyCache
var device_id := ""
var started := false
var last_store_error: Dictionary = {}
## Callables `(core: PKeyCore, result: PKeySyncResult)`, awaited after each sync's write.
var post_sync_hooks: Array[Callable] = []
## Attest and retry (SDK parity §3.10): a coroutine `() -> PKeyResult` that runs
## PolarisKey.devices.attest(). Installed by the autoload; `with_attestation()` and every
## authenticated request() call it once on a 403 `attestation_required`, then retry once.
var attest_hook: Callable = Callable()
var _attesting := false
## The update-event queue (PKeyUpdater): pending_events() goes into the device report's `updates`
## key (P6-03) and mark_reported(ids) runs once the Worker accepted it. Null: none.
var update_events: Object = null
## PolarisKey.update.packs (P4-08): the running set's packSetId rides on devices/report.
var packs: Object = null
## The last discovery manifest this session, or null.
var discovery_manifest = null

var _expected_services = null
var _discovered_services = null
var _caps: PKeyCaps = null


## Validate `opts` and build a Core. ok with detail = the PKeyCore, or a failure:
## `insecure-base-url`, `invalid-options` (including a malformed `default_channel`; an alias is
## kept as its canonical name, PKeyChannel.header_for). Nothing touches the disk or the network.
static func create(opts: PKeyOptions, host: Node, p_sdk_version: String) -> PKeyResult:
	if opts == null:
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "No PKeyOptions given.")
	if not RegEx.create_from_string("\\A[a-z0-9][a-z0-9_-]*\\z").search(opts.product):
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "product must be a lower-case slug, got '%s'." % opts.product)
	var base := PKeyTransport.check_base_url(opts.base_url if opts.base_url != "" else DEFAULT_BASE)
	if not base.ok:
		return base
	var v := opts.resolved_version()
	if not PKeySemver.is_valid(v):
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "version must be semver (PKeyOptions.version or application/config/version), got '%s'." % v)
	for k in opts.pinned_trust_keys:
		if not (k is String and opts.pinned_trust_keys[k] is String):
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "pinned_trust_keys must map kid strings to base64url key strings.")
	var update_refusal := check_update_options(opts)
	if update_refusal != "":
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, update_refusal)
	var channel = PKeyChannel.header_for(opts.default_channel, v)
	if channel == null:
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "default_channel must be a channel name (stable, beta, pr-<n>, dev or a manual channel matching %s), got '%s'." % [PKeyConstants.CHANNEL_NAME_PATTERN, opts.default_channel])
	# The build stamp's channel wins over default_channel (P1-11); a malformed one is refused.
	var stamp = PKeyBuildStamp.read(opts.build_stamp_path)
	if stamp != null and stamp["channel"] != "":
		channel = PKeyChannel.header_for(stamp["channel"], v)
		if channel == null:
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "The build stamp (%s) names a malformed channel '%s'; fix polaris_key/channel or PKEY_BUILD_CHANNEL and export again." % [opts.build_stamp_path, stamp["channel"]])
	for s in opts.expected_services:
		if not PKeyServices.SLUGS.has(s):
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "expected_services names an unknown service '%s'." % s)
	for a in opts.pack_attachable:
		var why := PKeyPck.attachable_problem(a)
		if why != "":
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "pack_attachable entry '%s' is %s: an entry is a res:// script path, a res://…/ directory or a canonical uid://." % [a, why])
	var core := PKeyCore.new()
	core.options = opts
	core.product = opts.product
	core.base_url = base.detail
	core.version = v
	core.channel = channel
	core.build_stamp = stamp
	core.sdk_version = p_sdk_version
	core.local_only = opts.local_only
	core.trust_refresh = opts.trust_refresh
	# The platform store when its plugin is present (Keychain on iOS, P5-05; Keystore on Android,
	# P5-06), else the file store.
	core.store = opts.store if opts.store != null else PKeyKeychainStore.preferred(opts.product, opts.store_root)
	core.store.failed.connect(core._on_store_failed)
	core.transport = PKeyTransport.new(host)
	core.transport.timeout = opts.request_timeout_seconds
	core.transport.local_only = opts.local_only
	core.clock = PKeyClock.new(opts.now_source)
	core.trust = PKeyTrust.new(opts.pinned_trust_keys)
	core.tokens = PKeyTokenManager.new(core.store)
	core.tokens.core_ref = weakref(core)
	core._expected_services = opts.expected_services if not opts.expected_services.is_empty() else null
	PKeyJws.set_slice_budget_ms(opts.verify_slice_ms)
	return PKeyResult.success(core)


## The wire v4 update options (plans/P3-01.md §2.6, §2.8): "" when they are valid, else why
## `configure` refuses them (`invalid-options`). pinned_release_keys maps kid strings to keys,
## no release key is also a trust pin (compared as raw bytes, so two spellings of one key are one
## key), and no kid is a delegated `pkd1-` kid (plans/P4-19.md §2.2); the host outlet is a kind,
## an outlet id and a subkind from their vocabularies; every update method is one of `native`,
## `download`, `sidecar-pck`. An EMPTY pinned_release_keys is valid here: decide() answers
## `not-configured`.
static func check_update_options(opts: PKeyOptions) -> String:
	var trust_raw := {}
	for k in opts.pinned_trust_keys:
		var raw = PKeyB64Url.decode_lenient(String(opts.pinned_trust_keys[k]))
		trust_raw[raw.hex_encode() if raw != null else "text:" + String(opts.pinned_trust_keys[k])] = true
	for k in opts.pinned_release_keys:
		var key = opts.pinned_release_keys[k]
		if not (k is String and key is String):
			return "pinned_release_keys must map kid strings to base64url key strings."
		# plans/P4-19.md §2.2: a delegated kid is never a pinned release key.
		if PKeyReleaseRecord.is_delegated_kid(k):
			return "pinned_release_keys names the pkd1- kid '%s': a delegated content key is reached only through a delegation, never pinned." % k
		var raw = PKeyB64Url.decode_lenient(key)
		if trust_raw.has(raw.hex_encode() if raw != null else "text:" + key):
			return "pinned_release_keys['%s'] is also a trust pin: a release key is never a product key (WIRE-CONTRACT-V4 §2.6)." % k
	if PKeyDecision.resolve_update_outlet({"host": opts.host_outlet()}) == null:
		return "update_outlet must be an outlet kind (%s), update_outlet_id an outlet id (^[a-z][a-z0-9-]{0,63}$) and update_outlet_subkind one of %s; got '%s', '%s', '%s'." % [
			", ".join(PKeyConstants.OUTLET_KIND_VALUES), ", ".join(PKeyConstants.OUTLET_SUBKIND_VALUES),
			opts.update_outlet, opts.update_outlet_id, opts.update_outlet_subkind]
	for m in opts.update_methods:
		if not PKeyConstants.BINARY_METHOD_VALUES.has(m):
			return "update_methods may hold only %s; got '%s'." % [", ".join(PKeyConstants.BINARY_METHOD_VALUES), m]
	for u in [opts.update_release_url, opts.update_page_url]:
		if u != "" and not PKeyOutletAdapter.is_https(u):
			return "update_release_url and update_page_url must be https URLs; got '%s'." % u
	if opts.update_eddsa_public_key != "" and not is_eddsa_public_key(opts.update_eddsa_public_key):
		return "update_eddsa_public_key must be a raw Ed25519 public key in standard base64 (32 bytes, as Sparkle's generate_keys prints it)."
	return ""


## A Sparkle/WinSparkle EdDSA public key: standard base64 of exactly 32 bytes.
static func is_eddsa_public_key(text: String) -> bool:
	if not RegEx.create_from_string("\\A[A-Za-z0-9+/]{43}=\\z").search(text):
		return false
	return Marshalls.base64_to_raw(text).size() == 32


## Offline load: device id, token, and the verified cache. No network. A coroutine.
func start() -> PKeyResult:
	if not store.has_device_id():
		await PKeyDeviceId.prepare()
	device_id = store.get_device_id()
	if device_id == "":
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The store has no device id.", last_store_error)
	tokens.load_token()
	cache = PKeyCache.new(store, trust, clock, product, device_id)
	cache.platform = update_platform()
	cache.release_keys = options.pinned_release_keys
	await cache.load_record()
	started = true
	return PKeyResult.success()


func _on_store_failed(err: Dictionary) -> void:
	last_store_error = err
	store_error.emit(err)


# ── Capabilities (D-21) ────────────────────────────────────────────────────────────────────

## slug -> {"enabled": bool}: discovery this session, else expected_services, else the default.
func services() -> Dictionary:
	if _discovered_services != null:
		return _discovered_services.duplicate(true)
	if _expected_services != null:
		return PKeyDiscovery.services_from_list(_expected_services)
	return PKeyDiscovery.default_services()


## The `supports()` engine (PKeyCaps, P1b-10), reading this Core's capability map.
func capability_engine() -> PKeyCaps:
	if _caps == null:
		_caps = PKeyCaps.new(services, sdk_version)
		_caps.detectors["%s|%s" % [PKeyConstants.Feature.DEVICES_ATTEST, PKeyConstants.UnsupportedReason.OUTLET]] = PKeyDevices.attest_outlet_detail
		for problem in _caps.validate():
			push_error("PolarisKey capability table: " + problem)
	return _caps


func enabled(slug: String) -> bool:
	return PKeyClaims.is_true(services().get(slug, {}).get("enabled", false))


## null when `slug` is enabled, else a `service-unavailable` failure for the caller to return.
## The failure is the typed `product` N/A for `feature` (PARITY §2.2, P1b-10): `detail` is
## {feature, reason: "product", detail}, as supports(feature) reports it; the code stays
## `service-unavailable` so callers matching on it keep working.
func require_service(slug: String, feature: String) -> Variant:
	if enabled(slug):
		return null
	return PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "The %s service is not enabled for %s." % [slug, product], PKeyResult.product_detail(feature, slug))


## Fetch the discovery document and, when it parses, install its capability map. A coroutine.
## detail: {kind: "ok" | "not-found" | "invalid" | "error", services?, manifest?}.
func discover() -> PKeyResult:
	var r := await transport.request("GET", "%s/%s/.well-known/polaris.json" % [base_url, product.uri_encode()])
	if not r.ok:
		return PKeyResult.failure(r.code, r.message, {"kind": "error"})
	var status: int = r.detail["status"]
	if status == 404:
		return PKeyResult.failure(PKeyErrors.NOT_FOUND, "No such product.", {"kind": "not-found", "status": status})
	if status < 200 or status >= 300:
		return PKeyResult.failure(PKeyErrors.HTTP_ERROR, "Discovery answered %d." % status, {"kind": "error", "status": status})
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	if not parsed["ok"]:
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "Discovery response is not valid JSON.", {"kind": "invalid"})
	var d := PKeyDiscovery.parse(parsed["value"], product)
	if d["kind"] != "ok":
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, d["message"], d)
	_discovered_services = d["services"]
	discovery_manifest = d["manifest"]
	return PKeyResult.success(d)


# ── Transport ──────────────────────────────────────────────────────────────────────────────

## The X-PKey-* headers every product-scoped call carries.
func headers(extra: Dictionary = {}) -> Dictionary:
	var h := PKeyHeaders.build(device_id, version, channel, sdk_version)
	h.merge(extra, true)
	return h


## `<base_url>/<product>/<path>`.
func url(path: String) -> String:
	return "%s/%s/%s" % [base_url, product, path]


## One product-scoped call. `body`: a Dictionary or Array (sent as JSON), a String, or null.
## `auth`: send the device token as a bearer. ok for a 2xx or 304; otherwise `code` is the
## server's error code (either spelling) or `http-error`, and `detail` always carries
## {status, headers, body, error?}. Transport failures keep the transport's code. A coroutine.
func request(method: String, path: String, body: Variant = null, auth := false, extra_headers: Dictionary = {}) -> PKeyResult:
	if not auth:
		return await _request_once(method, path, body, auth, extra_headers)
	return await with_attestation(func() -> PKeyResult: return await _request_once(method, path, body, auth, extra_headers))


## Run `call` (a coroutine `() -> PKeyResult`); when it answers 403 `attestation_required` and
## this runtime can attest (PKeyOptions.auto_attest on, the hook installed, not already
## attesting), attest once and retry once (SDK parity §3.10: edge-mint, gated delivery and the
## commerce claim). A failed attestation leaves the original refusal, with
## detail.attestation = the attest result's code. A coroutine.
func with_attestation(call: Callable) -> PKeyResult:
	var r: PKeyResult = await call.call()
	if r.ok or String(r.code) != PKeyConstants.ErrorCode.ATTESTATION_REQUIRED:
		return r
	if _attesting or not attest_hook.is_valid() or options == null or not options.auto_attest:
		return r
	_attesting = true
	var a: PKeyResult = await attest_hook.call()
	_attesting = false
	if not a.ok:
		if r.detail is Dictionary:
			r.detail["attestation"] = String(a.code)
		return r
	var again: PKeyResult = await call.call()
	if again.detail is Dictionary:
		again.detail["attested_retry"] = true
	return again


func _request_once(method: String, path: String, body: Variant, auth: bool, extra_headers: Dictionary) -> PKeyResult:
	var h := headers(extra_headers)
	if auth:
		if not tokens.has_token():
			return PKeyResult.failure(PKeyErrors.NO_TOKEN, "No device token is held.")
		h["Authorization"] = "Bearer %s" % tokens.current()
	var bytes := PackedByteArray()
	if body is Dictionary or body is Array:
		bytes = PKeyJson.stringify(body).to_utf8_buffer()
		h["Content-Type"] = "application/json"
	elif body is String:
		bytes = (body as String).to_utf8_buffer()
	elif body is PackedByteArray:
		bytes = body
	var r := await transport.request(method, url(path), h, bytes)
	if not r.ok:
		return r
	var status: int = r.detail["status"]
	if (status >= 200 and status < 300) or status == 304:
		return r
	var e := PKeyErrors.read_body(r.detail["body"])
	r.detail["error"] = e
	var code: String = e["code"] if e["code"] != "" else String(PKeyErrors.HTTP_ERROR)
	return PKeyResult.failure(StringName(code), e["message"] if e["message"] != "" else "HTTP %d" % status, r.detail)


## GET one signed document with If-None-Match, mapped onto the §5 taxonomy:
## {kind: "ok", jws, etag} | {kind: "not-modified"} | {kind: "unauthorized"} |
## {kind: "blocked", blocked: {reason, allowedRange?}} | {kind: "rate-limited", ...} |
## {kind: "error", status, message}. Verification is NOT here. A coroutine.
func get_document(path: String, token: String, etag: String) -> Dictionary:
	var h := headers({"Authorization": "Bearer %s" % token})
	if etag != "":
		h["If-None-Match"] = etag
	var r := await transport.request("GET", url(path), h)
	if not r.ok:
		return {"kind": "error", "status": 0, "message": r.message, "code": r.code}
	var status: int = r.detail["status"]
	var body: PackedByteArray = r.detail["body"]
	match status:
		304:
			return {"kind": "not-modified"}
		401:
			return {"kind": "unauthorized"}
		429:
			var e := PKeyErrors.read_body(body)
			return {"kind": "rate-limited", "limit": e["body"].get("limit"), "deviceCount": e["body"].get("deviceCount")}
		403:
			# v3 nests the code and keeps allowedRange at the top level; a pre-nesting body is read
			# flat; a body that says nothing (or names an unknown reason) is the stricter block.
			var e := PKeyErrors.read_body(body)
			var reason: String = e["reason"]
			if not PKeyGate.BLOCK_REASONS.has(reason):
				reason = "channel-not-entitled" if e["code"] == "channel_not_allowed" else "version-too-old"
			var blocked := {"reason": reason}
			if e["body"].get("allowedRange") is Dictionary:
				blocked["allowedRange"] = e["body"]["allowedRange"]
			return {"kind": "blocked", "blocked": PKeyGate.sanitize_blocked(blocked)}
		200:
			return {"kind": "ok", "jws": body.get_string_from_utf8(), "etag": r.detail["headers"].get("etag", "")}
	return {"kind": "error", "status": status, "message": body.get_string_from_utf8().left(200)}


## Fetch and accept the signed trust manifest (against the pins only). Returns the compact JWS
## to persist, or "" when nothing acceptable arrived (the old set stays). A coroutine.
func refresh_trust() -> String:
	var r := await transport.request("GET", url(".well-known/polaris-trust.jws"), {"Accept": "application/jose"})
	if not r.ok or r.detail["status"] != 200:
		return ""
	var jws: String = (r.detail["body"] as PackedByteArray).get_string_from_utf8().strip_edges()
	var issued := await trust.accept_network(jws, product, clock.system_now(), true)
	if issued < 0:
		return ""
	clock.raise(issued)
	return jws


## The build stamp, or the fallback for a build without one (PKeyBuildStamp.fallback: this
## Core's channel and version, no outlet).
func build_info() -> Dictionary:
	if build_stamp != null:
		return build_stamp.duplicate(true)
	return PKeyBuildStamp.fallback(channel, product, version)


## The platform the update decision runs for: the stamp's, else this device's.
func update_platform() -> String:
	var p = build_info().get("platform")
	return p if p is String and p != "" else PKeyHeaders.platform()


## The stamped outlet id, or "" for a build without a stamp. What the build says, not what it
## is: update_outlet() is the outlet the decision uses.
func outlet() -> String:
	return build_stamp["outlet"] if build_stamp != null else ""


## The build stamp, else (for an export that lost build.json) the stamp its
## `pkey_outlet_<kind>` feature tag implies. PKeyOptions.build_stamp_path = "" means no stamp at
## all, so no tag stands in for it either.
func _stamp_or_tag() -> Variant:
	if build_stamp != null:
		return build_stamp
	if options == null or options.build_stamp_path == "":
		return null
	return PKeyOutletSignals.feature_tag_stamp(outlet_env)


## The stamp outlet detection reads: the build stamp (or its feature tag), else the synthesised
## `web` stamp on a web export, else null.
func detection_stamp() -> Variant:
	var stamp = _stamp_or_tag()
	if stamp == null and (outlet_env.platform() if outlet_env != null else PKeyHeaders.platform()) == "web":
		return PKeyOutlet.WEB_STAMP.duplicate(true)
	return PKeyOutlet.detection_stamp(stamp)


## The detection result (PKeyOutlet.detect_outlet over PKeyOutletSignals and detection_stamp()),
## or null when PKeyOptions.update_outlet names the outlet or update_detect is off. Computed once
## per session.
func detected_outlet() -> Variant:
	if options == null or options.host_outlet() != null or not options.update_detect:
		return null
	if _detection == null:
		var stamp = detection_stamp()
		var ids: Dictionary = stamp["outletIds"] if stamp is Dictionary else {}
		_detection = PKeyOutlet.detect_outlet(stamp, PKeyOutletSignals.read_outlet_signals(outlet_env, ids))
	return _detection.duplicate()


## The outlet the update decision uses: PKeyDecision.resolve_update_outlet over the host option,
## the stamp (or the feature-tag stamp) and detected_outlet(). {id, kind, subkind}.
func update_outlet() -> Dictionary:
	var stamp = _stamp_or_tag()
	var resolved = PKeyDecision.resolve_update_outlet({
		"host": options.host_outlet() if options != null else null,
		"stamp": stamp,
		"detected": detected_outlet(),
	})
	if resolved == null:
		return {"id": null, "kind": PKeyDecision.OUTLET_UNKNOWN, "subkind": null}
	return resolved


## The outlet id a device report carries (P1-05's `outlet`): the decision's outlet id, else its
## kind, else "" when it is unknown. Raw signal values are never reported.
func reported_outlet() -> String:
	var o := update_outlet()
	if o.get("id") is String and o["id"] != "":
		return o["id"]
	return o["kind"] if o.get("kind") is String and o["kind"] != PKeyDecision.OUTLET_UNKNOWN else ""


# ── Sync, bundles, state ───────────────────────────────────────────────────────────────────

func sync(force := false) -> PKeySyncResult:
	return await PKeySync.run(self, force)


func add_post_sync_hook(hook: Callable) -> void:
	post_sync_hooks.append(hook)


## Verify and install an offline bundle (§7), all-or-nothing; no token is created. ok with
## detail {bundle_id, imported: ["license"?, "config"?]}, or the refusing step as `code`.
## Works local-only. A coroutine.
func import_bundle(text: String, now := -1.0) -> PKeyResult:
	if not started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call start() before import_bundle().")
	var at := now if now >= 0 else clock.system_now()
	var r := await PKeyBundle.inspect(text.strip_edges(), {
		"pinned": trust.pinned(), "product": product, "device_id": device_id, "now": at,
	})
	if not r["ok"]:
		return PKeyResult.failure(StringName(r["reason"]), _bundle_message(r["reason"]), {"reason": r["reason"]})
	var b: Dictionary = r["bundle"]
	var docs := {}
	var imported: Array = []
	for slice in ["license", "config"]:
		if b["docs"].has(slice):
			docs[slice] = b["docs"][slice]["jws"]
			imported.append(slice)
	var record := {
		"v": PKeyCache.VERSION,
		"trustJws": b["trust_jws"],
		"docs": docs,
		"importedBundle": {"bundleId": b["bundle_id"], "importedAt": int(at)},
	}
	# The committed feeds and records are not the bundle's to drop: keeping them keeps each
	# channel's `seq` floor. The reload below re-verifies them against the bundle's trust set.
	var held = cache.record()
	if held is Dictionary:
		for slice in PKeyCache.UPDATE_SLICES:
			if held.has(slice):
				record[slice] = held[slice]
	if not cache.replace(record):
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The verified bundle could not be written.", last_store_error)
	# Re-run the normal load over what was written: the import reaches exactly the state a
	# restart would.
	await cache.load_record()
	return PKeyResult.success({"bundle_id": b["bundle_id"], "imported": imported})


static func _bundle_message(reason: String) -> String:
	match reason:
		PKeyBundle.JWS_REJECTED:
			return "The bundle's signature, type or size was not acceptable."
		PKeyBundle.CLAIMS_REJECTED:
			return "The bundle is not addressed to this device, or its import window has closed."
		PKeyBundle.TRUST_REJECTED:
			return "The trust manifest inside the bundle was rejected against the pinned keys."
	return "A document inside the bundle failed verification; nothing was imported."


## "token" when a device token is held, else "bundle" when an imported bundle left a verified
## licence document, else "".
func activation() -> String:
	if tokens != null and tokens.has_token():
		return "token"
	if cache != null and cache.imported_bundle != null and cache.license != null:
		return "bundle"
	return ""


## The licence gate's view now (PKeyGate.license_state).
func license_state() -> Dictionary:
	return PKeyGate.license_state({
		"license_service_enabled": enabled("license"),
		"activation": activation(),
		"doc": cache.license["doc"] if cache != null and cache.license != null else null,
		"now": clock.system_now(),
		"high_water_mark": clock.high_water(),
		"last_sync_unauthorized": cache != null and cache.last_sync_unauthorized,
		"blocked": cache.blocked if cache != null else null,
		"last_verified_at": cache.last_verified_at if cache != null else null,
	})


## One snapshot of everything a UI renders from (sdk-node `getSyncState`).
func sync_state() -> Dictionary:
	return {
		"activation": activation(),
		"doc": cache.license["doc"] if cache != null and cache.license != null else null,
		"last_sync_unauthorized": cache != null and cache.last_sync_unauthorized,
		"blocked": cache.blocked if cache != null else null,
		"last_verified_at": cache.last_verified_at if cache != null else null,
		"high_water_mark": clock.high_water(),
	}


func store_status() -> Dictionary:
	return store.status()
