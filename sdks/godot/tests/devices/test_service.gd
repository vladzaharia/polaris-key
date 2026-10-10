extends RefCounted
# @pkey-feature devices.register devices.manage devices.report
# PolarisKey.devices against a loopback server that answers like the Worker: keyless register
# (no bearer, the hashed fingerprint, the token stored with source `register`, and the outcomes
# PKeyBoot tells apart: no answer, refused, unusable), the self-only roster calls and the local
# wipe, and the report after each sync (allowlisted keys only, values from verified documents,
# none after a hard 401). No raw fingerprint value ever reaches a request body.

const TOKEN := "pkeyt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

var F: Dictionary
var plan := {}
var server: PKeyFakeServer
var allowed: Array = []


func run(t: PKeyTestContext) -> void:
	F = PKeyTestFixtures.sync_docs()
	if not t.check("devices: fixtures present", not F.is_empty()):
		return
	allowed = _allowlist()
	t.check("devices: the Worker's report allowlist is readable from the transcript mirror", allowed.has("engine") and allowed.has("outlet") and allowed.has("config") and allowed.has("caps"), str(allowed))
	server = PKeyTestFixtures.new_server(_answer)
	await _register(t)
	await _register_outcomes(t)
	await _manage(t)
	await _report(t)
	server.queue_free()


## path suffix -> Array of answers; the last one repeats.
func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	for suffix in plan:
		if path.ends_with(suffix):
			var q: Array = plan[suffix]
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
	return {"status": 404, "body": "{\"error\":{\"code\":\"not_found\"}}"}


func _json(status: int, body: Variant) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(body)}


func _sdk(store: PKeyMemoryStore, services := PackedStringArray(["config"]), tweak := Callable()) -> Node:
	var sdk := PKeyTestFixtures.new_sdk()
	var clock := [F["now"]]
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, F["product"], F["trust"], F["version"])
	opts.expected_services = services
	if tweak.is_valid():
		tweak.call(opts)
	sdk.configure(opts)
	await sdk.start()
	sdk.devices.fingerprint_host = PKeyFakeHost.load_host("linux")
	return sdk


func _requests(method: String, suffix: String) -> Array:
	return server.requests.filter(func(r): return r["method"] == method and String(r["path"]).ends_with(suffix))


static func _body(req: Dictionary) -> String:
	return (req["body"] as PackedByteArray).get_string_from_utf8()


## The allowedKeys the telemetry-report transcript holds every report to (the Worker's
## REPORT_KEYS, recorded by `pnpm gen transcripts`).
static func _allowlist() -> Array:
	var tr = PKeyTestFixtures.transcript("telemetry-report")
	if not (tr is Dictionary):
		return []
	for step in tr["steps"]:
		for x in step["exchanges"]["items"]:
			if String(x["request"]["path"]).ends_with("/devices/report"):
				return x["request"]["body"]["allowedKeys"]
	return []


# ── register ─────────────────────────────────────────────────────────────────────────────

func _register(t: PKeyTestContext) -> void:
	server.requests.clear()
	plan = {"/devices/register": [_json(200, {"token": TOKEN, "deviceId": F["device_id"]})]}
	var store := PKeyMemoryStore.new(F["device_id"])
	var sdk = await _sdk(store)
	var host: PKeyFakeHost = sdk.devices.fingerprint_host
	var r: PKeyResult = await sdk.devices.register()
	t.check("register: ok", r.ok and r.detail["kind"] == "ok" and r.detail["status"] == 200 and r.detail["answered"], str(r))
	t.check("register: the result does not carry the token", not r.detail.has("token"))
	t.check("register: the token is stored", store.token == TOKEN and sdk.core.tokens.current() == TOKEN)
	t.check("register: the token's source is register", sdk.core.tokens.source() == PKeyTokenManager.SOURCE_REGISTER, sdk.core.tokens.source())
	var reqs := _requests("POST", "/devices/register")
	if not t.check("register: one request", reqs.size() == 1, str(reqs.size())):
		return
	var req: Dictionary = reqs[0]
	t.check("register: no bearer", not req["headers"].has("authorization"))
	t.check("register: the device id header", req["headers"].get("x-pkey-device") == F["device_id"])
	t.check("register: a JSON body", String(req["headers"].get("content-type", "")).begins_with("application/json"))
	var body := PKeyJson.parse(_body(req))
	var expected_fp := PKeyFingerprint.hash_components(F["product"], host.host["expected"])
	# PX-W13 §8 Q2: the device label rides along on registration.
	t.check("register: the body is the hashed fingerprint and the device label", body["ok"] and body["value"] == {"fingerprint": expected_fp, "deviceName": "Test Device"}, _body(req))
	_no_raw(t, "register", _body(req), host)

	# A held token is never presented: re-registering asks for a FRESH credential.
	server.requests.clear()
	r = await sdk.devices.register()
	reqs = _requests("POST", "/devices/register")
	t.check("register: still no bearer while a token is held", r.ok and reqs.size() == 1 and not reqs[0]["headers"].has("authorization"))
	sdk.queue_free()

	# Fingerprinting off: the label alone.
	server.requests.clear()
	var unprinted = await _sdk(PKeyMemoryStore.new(F["device_id"]), PackedStringArray(["config"]), func(o: PKeyOptions): o.fingerprint_enabled = false)
	r = await unprinted.devices.register()
	reqs = _requests("POST", "/devices/register")
	var label_only := PKeyJson.parse(_body(reqs[0])) if reqs.size() == 1 else {"ok": false}
	t.check("register: fingerprint_enabled = false sends the label alone", r.ok and label_only["ok"] and label_only["value"] == {"deviceName": "Test Device"}, _body(reqs[0]) if reqs.size() == 1 else "")
	unprinted.queue_free()

	# Fingerprinting and the label off: no body at all.
	server.requests.clear()
	var off = await _sdk(PKeyMemoryStore.new(F["device_id"]), PackedStringArray(["config"]), func(o: PKeyOptions):
		o.fingerprint_enabled = false
		o.send_device_name = false)
	r = await off.devices.register()
	reqs = _requests("POST", "/devices/register")
	t.check("register: fingerprint and label off send no body", r.ok and reqs.size() == 1 and (reqs[0]["body"] as PackedByteArray).is_empty() and not reqs[0]["headers"].has("content-type"))
	t.check("register: fingerprint() is null when disabled", await off.devices.fingerprint() == null)
	off.queue_free()


## Every raw value the fake host could hand the fingerprint is absent from `body` (rule 7).
func _no_raw(t: PKeyTestContext, label: String, body: String, host: PKeyFakeHost) -> void:
	var leaked := PackedStringArray()
	for v in host.raw_values():
		if body.contains(v):
			leaked.append(v)
	for v in [host.host["files"]["/etc/machine-id"].strip_edges(), "a4:83:e7:1b:2c:3d", "XPS 15 9530", "8f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", ".CN1234567890.", "4C4C4544-0042-3510-8048-B4C04F4E3732"]:
		if body.contains(v):
			leaked.append(v)
	t.check("%s: no raw component value is in the request body" % label, leaked.is_empty(), str(leaked))


func _register_outcomes(t: PKeyTestContext) -> void:
	var cases := [
		[_json(403, {"error": {"code": "registration_closed", "message": "Registration is closed."}}), "registration-closed", "registration_closed", 403],
		[_json(429, {"error": {"code": "rate_limited"}}), "rate-limited", "rate_limited", 429],
		[_json(404, {"error": {"code": "not_found"}}), "not-configured", "not_found", 404],
		[_json(500, {"error": "internal"}), "error", "internal", 500],
		[_json(200, {"deviceId": "x"}), "error", "invalid-response", 200],
		[{"status": 200, "body": "not json"}, "error", "invalid-response", 200],
	]
	for c in cases:
		server.requests.clear()
		plan = {"/devices/register": [c[0]]}
		var store := PKeyMemoryStore.new(F["device_id"], "pkeyt_held")
		var sdk = await _sdk(store)
		var r: PKeyResult = await sdk.devices.register()
		t.check("register %d: %s / %s, answered" % [c[3], c[1], c[2]], not r.ok and r.detail["kind"] == c[1] and String(r.code) == c[2] \
				and r.detail["status"] == c[3] and r.detail["answered"] == true, "%s %s" % [r, r.detail])
		t.check("register %d: the held token is untouched" % c[3], store.token == "pkeyt_held")
		t.check("register %d: one request, no retry" % c[3], _requests("POST", "/devices/register").size() == 1)
		sdk.queue_free()

	# No answer at all: a closed port, and a server that never answers within the deadline.
	var closed := PKeyTestFixtures.new_server(func(_r): return {"status": 200})
	var closed_url := closed.base_url()
	closed.stop()
	closed.queue_free()
	var sdk := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(closed_url, PKeyMemoryStore.new(F["device_id"]), [F["now"]], F["product"], F["trust"], F["version"])
	sdk.configure(opts)
	await sdk.start()
	sdk.devices.fingerprint_host = PKeyFakeHost.load_host("linux")
	var r: PKeyResult = await sdk.devices.register()
	t.check("register: a refused connection is no-answer, status 0", not r.ok and r.detail["kind"] == "no-answer" and r.detail["status"] == 0 and r.detail["answered"] == false, "%s %s" % [r, r.detail])
	sdk.queue_free()

	server.requests.clear()
	plan = {"/devices/register": [{"hang": true}]}
	var slow = await _sdk(PKeyMemoryStore.new(F["device_id"]), PackedStringArray(["config"]), func(o: PKeyOptions): o.request_timeout_seconds = 0.5)
	r = await slow.devices.register()
	t.check("register: the request deadline is no-answer (timeout), status 0", not r.ok and r.code == PKeyErrors.TIMEOUT and r.detail["kind"] == "no-answer" and r.detail["status"] == 0, "%s %s" % [r, r.detail])
	slow.queue_free()

	server.requests.clear()
	var local = await _sdk(PKeyMemoryStore.new(F["device_id"]), PackedStringArray(["config"]), func(o: PKeyOptions): o.local_only = true)
	r = await local.devices.register()
	t.check("register: local-only is refused before the network", not r.ok and r.code == PKeyErrors.LOCAL_ONLY and r.detail["kind"] == "local-only" and server.requests.is_empty())
	local.queue_free()


# ── list / rename / deauthorize ──────────────────────────────────────────────────────────

func _manage(t: PKeyTestContext) -> void:
	var me: String = F["device_id"]
	var other := "OTHERDEVICE000000000000000000001"
	server.requests.clear()
	plan = {
		"/devices": [_json(200, {"currentDeviceId": me, "devices": [
			{"id": me, "licenseId": "lic_1", "label": null, "status": "active", "current": true, "firstSeen": 1, "lastSeen": 2, "platform": "linux", "arch": "x86_64", "appVersion": "1.0.0", "sdkName": "polaris-key-godot", "sdkVersion": "0.1.0", "userAgent": "ua", "secret": "dropped"},
			{"id": other, "label": "Laptop", "status": "active", "current": false},
		]})],
		"/devices/%s" % me: [func(req: Dictionary) -> Dictionary:
			if req["method"] == "PATCH":
				var b := PKeyJson.parse(_body(req))
				return _json(200, {"ok": true, "device": {"id": me, "label": b["value"]["label"], "current": true, "status": "active"}})
			return _json(200, {"ok": true})],
	}
	var store := PKeyMemoryStore.new(me, F["token"])
	var sdk = await _sdk(store, PackedStringArray())
	var r: PKeyResult = await sdk.devices.list()
	t.check("list: ok with the roster", r.ok and r.detail["roster"] and r.detail["current_device_id"] == me and r.detail["devices"].size() == 2, str(r.detail))
	if r.ok and r.detail["devices"].size() == 2:
		var mine: Dictionary = r.detail["devices"][0]
		t.check("list: snake_case fields, unknown ones dropped", mine.get("license_id") == "lic_1" and mine.get("app_version") == "1.0.0" and mine.get("sdk_name") == "polaris-key-godot" \
				and mine.get("first_seen") == 1.0 and not mine.has("secret") and not mine.has("label"), JSON.stringify(mine))
	var lr := _requests("GET", "/devices")
	t.check("list: bearer", lr.size() == 1 and lr[0]["headers"].get("authorization") == "Bearer %s" % F["token"])

	r = await sdk.devices.rename("Desk rig")
	var patches := _requests("PATCH", "/devices/%s" % me)
	t.check("rename: PATCHes this device only", r.ok and patches.size() == 1 and String(patches[0]["path"]) == "/%s/devices/%s" % [F["product"], me], str(patches.map(func(p): return p["path"])))
	t.check("rename: the body is {label}", patches.size() == 1 and PKeyJson.parse(_body(patches[0]))["value"] == {"label": "Desk rig"})
	t.check("rename: the result carries the device", r.ok and r.detail["device"].get("label") == "Desk rig", str(r.detail))
	r = await sdk.devices.rename(null)
	patches = _requests("PATCH", "/devices/%s" % me)
	t.check("rename: null clears the label", r.ok and patches.size() == 2 and _body(patches[1]) == "{\"label\":null}", _body(patches[1]) if patches.size() == 2 else "")
	r = await sdk.devices.rename(42)
	t.check("rename: a non-string label is refused locally", not r.ok and r.code == PKeyErrors.INVALID_OPTIONS and _requests("PATCH", "").size() == 2)
	t.check("manage: no request ever names another device", server.requests.all(func(q): return not String(q["path"]).contains(other)))

	var cur: Dictionary = sdk.devices.get_current_device()
	t.check("current: this device from local state", cur.get("id") == me and cur.get("current") == true and cur.get("status") is String, str(cur))

	var wiped := [0]
	var emit_state: Callable = sdk.devices.on_wiped
	t.check("deauthorize: the autoload listens for the wipe", emit_state.is_valid() and emit_state.get_object() == sdk)
	sdk.devices.on_wiped = func() -> void:
		wiped[0] += 1
		emit_state.call()
	sdk.core.cache.patch({"lastSyncUnauthorized": true})
	r = await sdk.devices.deauthorize()
	var deletes := _requests("DELETE", "/devices/%s" % me)
	t.check("deauthorize: DELETEs this device only", r.ok and deletes.size() == 1 and String(deletes[0]["path"]) == "/%s/devices/%s" % [F["product"], me])
	t.check("deauthorize: the token is wiped", store.token == "" and not sdk.core.tokens.has_token())
	t.check("deauthorize: the cache is wiped", store.cache == null and sdk.core.cache.record() == null)
	t.check("deauthorize: the wipe is announced once", wiped[0] == 1, str(wiped))
	t.check("deauthorize: the licence state is needs-activation after the wipe", sdk.status()["status"] == "needs-activation", str(sdk.status()))
	r = await sdk.devices.rename("again")
	t.check("rename: without a token is device-management-unsupported, no request", not r.ok and r.code == PKeyErrors.DEVICE_MANAGEMENT_UNSUPPORTED and _requests("PATCH", "").size() == 2)
	r = await sdk.devices.deauthorize()
	t.check("deauthorize: without a token is device-management-unsupported", not r.ok and r.code == PKeyErrors.DEVICE_MANAGEMENT_UNSUPPORTED)
	server.requests.clear()
	r = await sdk.devices.list()
	t.check("list: without a token is this device alone, no request", r.ok and not r.detail["roster"] and r.detail["devices"].size() == 1 and r.detail["devices"][0]["id"] == me and server.requests.is_empty())
	sdk.queue_free()

	# The server refuses: the local wipe still happens, and the result says what the server said.
	plan = {"/devices/%s" % me: [_json(500, {"error": "boom"})]}
	var store2 := PKeyMemoryStore.new(me, F["token"])
	var sdk2 = await _sdk(store2)
	r = await sdk2.devices.deauthorize()
	t.check("deauthorize: a refused DELETE still wipes locally", not r.ok and r.detail == {"remote_ok": false, "wiped": true} and store2.token == "", "%s %s" % [r, r.detail])
	sdk2.queue_free()


# ── report ───────────────────────────────────────────────────────────────────────────────

func _report(t: PKeyTestContext) -> void:
	server.requests.clear()
	plan = {
		"polaris-trust.jws": [{"status": 200, "body": F["trust_jws"]}],
		"/license/document": [{"status": 200, "headers": {"ETag": F["license_etag"]}, "body": F["license"]}],
		"/config/document": [{"status": 200, "headers": {"ETag": F["config_etag"]}, "body": F["config"]}],
		"/devices/report": [_json(200, {"ok": true})],
	}
	var store := PKeyMemoryStore.new(F["device_id"], F["token"])
	var sdk = await _sdk(store, PackedStringArray())
	var sr: PKeySyncResult = await sdk.sync()
	var reports := _requests("POST", "/devices/report")
	t.check("report: one report after the sync", sr.applied and reports.size() == 1, "%s %d" % [sr.documents, reports.size()])
	if reports.size() != 1:
		sdk.queue_free()
		return
	var req: Dictionary = reports[0]
	t.check("report: bearer and JSON", req["headers"].get("authorization") == "Bearer %s" % F["token"] and String(req["headers"].get("content-type", "")).begins_with("application/json"))
	var parsed := PKeyJson.parse(_body(req))
	if not t.check("report: the body is a JSON object", parsed["ok"] and parsed["value"] is Dictionary):
		sdk.queue_free()
		return
	var body: Dictionary = parsed["value"]
	var outside: Array = body.keys().filter(func(k): return not allowed.has(k))
	t.check("report: only allowlisted keys", outside.is_empty(), str(outside))
	var lic: Dictionary = sdk.core.cache.license["doc"]
	var cfg: Dictionary = sdk.core.cache.config["doc"]
	var want_ent := {}
	for k in lic["entitlements"]:
		want_ent[k] = lic["entitlements"][k]["value"]
	var want_cfg := {}
	for k in cfg["config"]:
		want_cfg[k] = cfg["config"][k]["value"]
	t.check("report: entitlements are the verified licence's values", body.get("entitlements") == want_ent, JSON.stringify(body.get("entitlements")))
	t.check("report: config is the verified config's values", body.get("config") == want_cfg, JSON.stringify(body.get("config")))
	t.check("report: no secrets", not _body(req).contains("secrets"))
	t.check("report: sdk, sdkVersion, appVersion", body.get("sdk") == PKeyHeaders.SDK_NAME and body.get("sdkVersion") == sdk.SDK_VERSION and body.get("appVersion") == F["version"])
	t.check("report: the gate verdict", body.get("gate") == {"status": "ok"}, JSON.stringify(body.get("gate")))
	t.check("report: engine facts", body.get("engine") is Dictionary and String(body["engine"].get("id", "")).begins_with("godot-"), JSON.stringify(body.get("engine")))
	t.check("report: runtime is godot", body.get("runtime", {}).get("name") == "godot")
	t.check("report: no outlet without a build stamp", not body.has("outlet"), str(body.get("outlet")))
	# @pkey-feature core.caps
	t.check("report: caps is the supported feature list (P1b-10)", body.get("caps") == sdk.caps() and (body["caps"] as Array).has(PKeyConstants.Feature.CONFIG_RESOLVE) and not (body["caps"] as Array).has(PKeyConstants.Feature.UPDATE_DECIDE), JSON.stringify(body.get("caps")))
	_no_raw(t, "report", _body(req), PKeyFakeHost.load_host("linux"))

	var ok: bool = await sdk.devices.report()
	t.check("report: report() posts again and returns true", ok and _requests("POST", "/devices/report").size() == 2)

	# A failing report never fails the sync.
	plan["/devices/report"] = [_json(500, {"error": "boom"})]
	sr = await sdk.sync()
	t.check("report: a refused report does not fail the sync", sr.ok and _requests("POST", "/devices/report").size() == 3)
	t.check("report: report() is false when refused", not await sdk.devices.report())
	sdk.queue_free()

	# A hard 401 with nothing applied: no report.
	server.requests.clear()
	plan = {
		"polaris-trust.jws": [{"status": 200, "body": F["trust_jws"]}],
		"/license/document": [_json(401, {"error": "unauthorized"})],
		"/config/document": [_json(401, {"error": "unauthorized"})],
		"/devices/report": [_json(200, {"ok": true})],
	}
	var revoked = await _sdk(PKeyMemoryStore.new(F["device_id"], F["token"]), PackedStringArray())
	sr = await revoked.sync()
	t.check("report: skipped after a hard 401", sr.unauthorized and not sr.applied and _requests("POST", "/devices/report").is_empty(), "%s %d" % [sr.documents, _requests("POST", "/devices/report").size()])
	revoked.queue_free()

	# No token: nothing to report with, zero requests.
	server.requests.clear()
	var bare = await _sdk(PKeyMemoryStore.new(F["device_id"]), PackedStringArray())
	t.check("report: false without a token", not await bare.devices.report() and server.requests.is_empty())
	bare.queue_free()
