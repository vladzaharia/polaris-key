extends RefCounted
# @pkey-feature license.activate license.enroll
# activate_with_key and enroll against a loopback server answering like the Worker: every
# response mapped to its PKeyActivationResult kind in both error-body spellings, the request
# shapes (the key as the bearer, no bearer on enrol, the hashed fingerprint or no body at all),
# the token stored with its source and the forced sync that follows, and the refusals that
# send nothing (web enrolment, a malformed key, local-only, not started).

const S := preload("res://tests/license/support.gd")
const TOKEN := "pkeyt_ACTIVATEDACTIVATEDACTIVATEDACTIVATED000"
const KEY := "pkey_djdl_KtreuRThCpYw-7Xncutlnw"

var h: PKeyLicenseTestSupport


func run(t: PKeyTestContext) -> void:
	h = PKeyLicenseTestSupport.new()
	if not t.check("activation: fixtures present", h.ready()):
		return
	await _mapping(t)
	await _ok_and_shape(t)
	await _enroll(t)
	await _refusals(t)
	h.free_server()


## [label, answer, expected kind, expected code, extra checks Callable(res) -> bool or null].
func _cases() -> Array:
	return [
		["401 flat", S.json(401, {"error": "unauthorized"}), PKeyActivationResult.KIND_UNAUTHORIZED, &"unauthorized", null],
		["401 without a body", {"status": 401}, PKeyActivationResult.KIND_UNAUTHORIZED, &"unauthorized", null],
		["403 device_limit nested", S.json(403, {"error": {"code": "device_limit", "limit": 3, "deviceCount": 3}}), PKeyActivationResult.KIND_DEVICE_LIMIT, &"device_limit",
			func(r): return r.limit == 3 and r.device_count == 3 and r.limit is int],
		["403 device_limit flat", S.json(403, {"error": "device_limit", "message": "device limit reached", "limit": 2, "deviceCount": 1}), PKeyActivationResult.KIND_DEVICE_LIMIT, &"device_limit",
			func(r): return r.limit == 2 and r.device_count == 1 and r.message == "device limit reached"],
		["403 device_limit nested with the counts on top", S.json(403, {"error": {"code": "device_limit"}, "limit": 5, "deviceCount": 5}), PKeyActivationResult.KIND_DEVICE_LIMIT, &"device_limit",
			func(r): return r.limit == 5 and r.device_count == 5],
		["403 with no code", S.json(403, {}), PKeyActivationResult.KIND_DEVICE_LIMIT, &"device_limit", func(r): return r.limit == null and r.device_count == null],
		["403 fingerprint_required flat", S.json(403, {"error": "fingerprint_required", "message": "this tier requires a hardware fingerprint"}), PKeyActivationResult.KIND_FINGERPRINT_REQUIRED, &"fingerprint_required", null],
		["403 fingerprint_required nested", S.json(403, {"error": {"code": "fingerprint_required"}}), PKeyActivationResult.KIND_FINGERPRINT_REQUIRED, &"fingerprint_required", null],
		["403 license_disabled", S.json(403, {"error": "license_disabled"}), PKeyActivationResult.KIND_LICENSE_DISABLED, &"license_disabled", null],
		["403 another code", S.json(403, {"error": {"code": "forbidden"}}), PKeyActivationResult.KIND_ERROR, &"forbidden", null],
		["409 hardware_mismatch flat", S.json(409, {"error": "hardware_mismatch", "message": "hardware changed; re-activation required", "drift": 2, "changed": ["primaryMac", "cpuModel"]}), PKeyActivationResult.KIND_HARDWARE_MISMATCH, &"hardware_mismatch",
			func(r): return r.drift == 2 and r.changed == ["primaryMac", "cpuModel"]],
		["409 hardware_mismatch nested", S.json(409, {"error": {"code": "hardware_mismatch", "drift": 1, "changed": ["machineModel", 7]}}), PKeyActivationResult.KIND_HARDWARE_MISMATCH, &"hardware_mismatch",
			func(r): return r.drift == 1 and r.changed == ["machineModel"]],
		["429", S.json(429, {"error": "rate_limited", "message": "too many activation attempts"}), PKeyActivationResult.KIND_RATE_LIMITED, &"rate_limited", null],
		["404 on activate", S.json(404, {"error": {"code": "not_found"}}), PKeyActivationResult.KIND_ERROR, &"not_found", null],
		["500", S.json(500, {"error": "internal_error"}), PKeyActivationResult.KIND_ERROR, &"internal_error", null],
		["502 without a body", {"status": 502, "body": "bad gateway"}, PKeyActivationResult.KIND_ERROR, &"http-error", null],
		["200 without a token", S.json(200, {"schemaVersion": 1}), PKeyActivationResult.KIND_ERROR, &"invalid-response", null],
		["200 with a token that is not pkeyt_", S.json(200, {"token": "eyJ.x.y", "schemaVersion": 1}), PKeyActivationResult.KIND_ERROR, &"invalid-response", null],
	]


func _mapping(t: PKeyTestContext) -> void:
	var store := PKeyMemoryStore.new(h.F["device_id"])
	var sdk = await h.sdk(store)
	for c in _cases():
		h.server.requests.clear()
		h.plan = {"/license/activate": [c[1]]}
		var r: PKeyActivationResult = await sdk.license.activate_with_key(KEY)
		var extra_ok: bool = c[4] == null or c[4].call(r)
		t.check("activation: %s -> %s" % [c[0], c[2]], not r.ok and r.kind == c[2] and r.code == c[3] and r.status == int(c[1]["status"]) and extra_ok, "%s status=%d limit=%s count=%s drift=%s changed=%s" % [r, r.status, r.limit, r.device_count, r.drift, r.changed])
		t.check("activation: %s stores no token and syncs nothing" % c[0], store.token == "" and h.requests("GET", "/license/document").is_empty() and h.requests("POST", "/license/activate").size() == 1)
	sdk.queue_free()


func _ok_and_shape(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {"/license/activate": [S.json(200, {"token": TOKEN, "schemaVersion": 2})]}
	h.serve_docs([TOKEN])
	var store := PKeyMemoryStore.new(h.F["device_id"])
	var sdk = await h.sdk(store)
	var host: PKeyFakeHost = sdk.devices.fingerprint_host
	var states: Array = []
	sdk.state_changed.connect(func(s): states.append(s["status"]))
	var synced: Array = []
	sdk.sync_finished.connect(func(sr: PKeySyncResult): synced.append(sr.documents))
	var r: PKeyActivationResult = await sdk.license.activate_with_key("  %s\n" % KEY)
	t.check("activation: 200 -> ok", r.ok and r.kind == PKeyActivationResult.KIND_OK and r.code == &"" and r.status == 200 and r.schema_version == 2 and r.stored, str(r))
	t.check("activation: the result never carries the token", not str(r).contains(TOKEN) and r.detail == null)
	t.check("activation: the token is stored with source activate", store.token == TOKEN and sdk.core.tokens.source() == PKeyTokenManager.SOURCE_ACTIVATE, sdk.core.tokens.source())
	var reqs: Array = h.requests("POST", "/license/activate")
	if t.check("activation: one request", reqs.size() == 1, str(reqs.size())):
		var req: Dictionary = reqs[0]
		t.check("activation: the trimmed key is the bearer", S.bearer(req) == KEY, S.bearer(req))
		t.check("activation: the X-PKey headers ride along", req["headers"].get("x-pkey-device") == h.F["device_id"] and req["headers"].get("x-pkey-version") == h.F["version"] and req["headers"].has("x-pkey-channel") and req["headers"].has("x-pkey-sdk"))
		var body := PKeyJson.parse(S.body_text(req))
		var expected_fp := PKeyFingerprint.hash_components(h.F["product"], host.host["expected"])
		t.check("activation: the body is the hashed fingerprint", body["ok"] and body["value"] == {"fingerprint": expected_fp}, S.body_text(req))
	var docs: Array = h.requests("GET", "/license/document")
	t.check("activation: the forced sync ran with the new token before returning", docs.size() == 1 and S.bearer(docs[0]) == TOKEN and not docs[0]["headers"].has("if-none-match"))
	t.check("activation: the licence is ok once activation returns", sdk.license.status()["status"] == "ok" and sdk.license.is_licensed() and sdk.license.activation() == &"token", "%s after %s" % [sdk.license.status(), synced])
	t.check("activation: state_changed reported ok", states.has("ok"), str(states))
	sdk.queue_free()

	# Fingerprinting off: no body and no content type, byte-identical to having nothing to send.
	h.server.requests.clear()
	h.plan["/license/activate"] = [S.json(401, {"error": "unauthorized"})]
	var off = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]), PackedStringArray(), func(o: PKeyOptions): o.fingerprint_enabled = false)
	await off.license.activate_with_key(KEY)
	reqs = h.requests("POST", "/license/activate")
	t.check("activation: fingerprint_enabled = false sends no body", reqs.size() == 1 and (reqs[0]["body"] as PackedByteArray).is_empty() and not reqs[0]["headers"].has("content-type"))
	off.queue_free()


func _enroll(t: PKeyTestContext) -> void:
	var cases := [
		["404 enroll_disabled", S.json(404, {"error": "enroll_disabled", "message": "enrollment is disabled"}), PKeyActivationResult.KIND_ENROLL_DISABLED, &"enroll_disabled"],
		["404 without a body", {"status": 404}, PKeyActivationResult.KIND_ENROLL_DISABLED, &"enroll_disabled"],
		["403 enroll_claimed", S.json(403, {"error": "enroll_claimed", "message": "this machine's free license has been claimed; sign in to use it"}), PKeyActivationResult.KIND_ENROLL_CLAIMED, &"enroll_claimed"],
		["403 enroll_claimed nested", S.json(403, {"error": {"code": "enroll_claimed"}}), PKeyActivationResult.KIND_ENROLL_CLAIMED, &"enroll_claimed"],
		["403 license_disabled", S.json(403, {"error": "license_disabled"}), PKeyActivationResult.KIND_LICENSE_DISABLED, &"license_disabled"],
		["403 fingerprint_required", S.json(403, {"error": "fingerprint_required"}), PKeyActivationResult.KIND_FINGERPRINT_REQUIRED, &"fingerprint_required"],
		["429", S.json(429, {"error": "rate_limited"}), PKeyActivationResult.KIND_RATE_LIMITED, &"rate_limited"],
	]
	var store := PKeyMemoryStore.new(h.F["device_id"])
	var sdk = await h.sdk(store)
	for c in cases:
		h.server.requests.clear()
		h.plan = {"/license/enroll": [c[1]]}
		var r: PKeyActivationResult = await sdk.license.enroll()
		t.check("enroll: %s -> %s" % [c[0], c[2]], not r.ok and r.kind == c[2] and r.code == c[3], str(r))
		t.check("enroll: %s stores no token" % c[0], store.token == "")
	sdk.queue_free()

	h.server.requests.clear()
	h.plan = {"/license/enroll": [S.json(200, {"token": TOKEN, "schemaVersion": 1, "device": {}, "license": {}})]}
	h.serve_docs([TOKEN])
	store = PKeyMemoryStore.new(h.F["device_id"])
	sdk = await h.sdk(store)
	var host: PKeyFakeHost = sdk.devices.fingerprint_host
	var r: PKeyActivationResult = await sdk.license.enroll()
	t.check("enroll: 200 -> ok", r.ok and r.kind == PKeyActivationResult.KIND_OK, str(r))
	t.check("enroll: the token is stored with source enroll", store.token == TOKEN and sdk.core.tokens.source() == PKeyTokenManager.SOURCE_ENROLL)
	var reqs: Array = h.requests("POST", "/license/enroll")
	if t.check("enroll: one request", reqs.size() == 1):
		t.check("enroll: keyless, no Authorization", not reqs[0]["headers"].has("authorization"))
		var body := PKeyJson.parse(S.body_text(reqs[0]))
		t.check("enroll: the body is the hashed fingerprint", body["ok"] and body["value"] == {"fingerprint": PKeyFingerprint.hash_components(h.F["product"], host.host["expected"])}, S.body_text(reqs[0]))
	t.check("enroll: the forced sync ran", h.requests("GET", "/license/document").size() == 1 and sdk.license.status()["status"] == "ok")
	sdk.queue_free()


func _refusals(t: PKeyTestContext) -> void:
	# Web: no machine anchor, so enrolment is unsupported and nothing is sent.
	h.server.requests.clear()
	h.plan = {"/license/enroll": [S.json(200, {"token": TOKEN})], "/license/activate": [S.json(401, {"error": "unauthorized"})]}
	var web = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]))
	web.devices.fingerprint_host = PKeyFakeHost.load_host("web")
	var r: PKeyActivationResult = await web.license.enroll()
	t.check("enroll: on web -> unsupported with reason runtime", not r.ok and r.kind == PKeyActivationResult.KIND_UNSUPPORTED and r.code == PKeyErrors.UNSUPPORTED and r.detail == {"feature": "license.enroll", "reason": "runtime"}, str(r))
	t.check("enroll: on web nothing is sent", h.requests("POST", "/license/enroll").is_empty())
	r = await web.license.activate_with_key(KEY)
	var reqs: Array = h.requests("POST", "/license/activate")
	t.check("activation: on web the key still goes, without a fingerprint body", r.kind == PKeyActivationResult.KIND_UNAUTHORIZED and reqs.size() == 1 and (reqs[0]["body"] as PackedByteArray).is_empty())
	web.queue_free()

	h.server.requests.clear()
	var sdk = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]))
	for bad in ["", "   ", "pkey djdl", "pkey_djdl\r\nX-Evil: 1", "pkey_djé"]:
		r = await sdk.license.activate_with_key(bad)
		t.check("activation: key %s is refused before sending" % JSON.stringify(bad), r.kind == PKeyActivationResult.KIND_ERROR and r.code == PKeyErrors.INVALID_OPTIONS)
	t.check("activation: a refused key sends nothing", h.requests("POST", "/license/activate").is_empty())
	sdk.queue_free()

	var local = await h.sdk(PKeyMemoryStore.new(h.F["device_id"]), PackedStringArray(), func(o: PKeyOptions): o.local_only = true)
	r = await local.license.activate_with_key(KEY)
	t.check("activation: local-only is refused", r.code == PKeyErrors.LOCAL_ONLY and r.kind == PKeyActivationResult.KIND_ERROR)
	r = await local.license.enroll()
	t.check("enroll: local-only is refused", r.code == PKeyErrors.LOCAL_ONLY)
	local.queue_free()

	var cold := PKeyTestFixtures.new_sdk()
	cold.configure(PKeyTestFixtures.options(h.server.base_url(), PKeyMemoryStore.new(h.F["device_id"]), [h.F["now"]]))
	r = await cold.license.activate_with_key(KEY)
	t.check("activation: before start() is refused", r.code == PKeyErrors.NOT_CONFIGURED)
	cold.queue_free()

	# No answer at all: the transport's code, status 0.
	var dead := PKeyTestFixtures.new_server(func(_req): return {"status": 200})
	var url := dead.base_url()
	dead.stop()
	dead.queue_free()
	var gone := PKeyTestFixtures.new_sdk()
	gone.configure(PKeyTestFixtures.options(url, PKeyMemoryStore.new(h.F["device_id"]), [h.F["now"]], h.F["product"], h.F["trust"]))
	await gone.start()
	gone.devices.fingerprint_host = PKeyFakeHost.load_host("linux")
	r = await gone.license.activate_with_key(KEY)
	t.check("activation: no answer -> error with the transport's code", r.kind == PKeyActivationResult.KIND_ERROR and r.status == 0 and (r.code == PKeyErrors.NETWORK or r.code == PKeyErrors.TIMEOUT), str(r))
	gone.queue_free()
