extends RefCounted
# @pkey-feature core.backend
# PolarisKey.backend (WIRE-CONTRACT-V4 §14.5, framework drop-ins §6): the `client` rows of
# backend-matrix.json, the origin allow-list on the request and on every redirect hop (checked
# BEFORE the hop is sent), the shared pre-sync, one forced retry with a 10 s floor, and the typed
# 403 failures. Two loopback servers play "the backend" and "another origin"; a third answers the
# Worker's sync.

const MATRIX := "res://tests/corpus/v2/backend-matrix.json"

var h: PKeyLicenseTestSupport
var api: PKeyFakeServer
var other: PKeyFakeServer
var api_plan: Array = []
var syncs: Array = []


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_matrix(t)
	_origins(t)
	h = PKeyLicenseTestSupport.new()
	if not t.check("backend: fixtures present", h.ready()):
		return true
	api = PKeyTestFixtures.new_server(_api_answer)
	other = PKeyTestFixtures.new_server(func(_r): return {"status": 200, "body": "other"})
	await _headers(t)
	await _request(t)
	await _redirects(t)
	await _retry(t)
	await _typed(t)
	await _shared(t)
	await _configure(t)
	api.queue_free()
	other.queue_free()
	h.free_server()
	return true


func _api_answer(_req: Dictionary) -> Dictionary:
	if api_plan.is_empty():
		return {"status": 200, "body": "ok"}
	return api_plan[0] if api_plan.size() == 1 else api_plan.pop_front()


static func _problem(status: int, code: String) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/problem+json"}, "body": JSON.stringify({"code": code})}


func _matrix(t: PKeyTestContext) -> void:
	var m = PKeyTestFixtures.read_json(MATRIX)
	if not t.check("backend: the matrix mirror reads", m is Dictionary and m.get("backendMatrixVersion") == 1):
		return
	var rows: Array = m["client"]
	t.check("backend: client rows present", rows.size() >= 17, str(rows.size()))
	for row in rows:
		var i: Dictionary = row["input"]
		var got := PKeyBackend.action(i["document"], float(i["now"]), i["response"], bool(i["retried"]))
		t.check("backend: matrix %s" % row["id"], got == row["expect"]["action"], "%s != %s" % [got, row["expect"]["action"]])


func _origins(t: PKeyTestContext) -> void:
	t.check("backend: origin default port dropped into the canonical form", PKeyBackend.normalize_origin("HTTPS://API.Example.com") == "https://api.example.com:443")
	t.check("backend: a trailing slash is fine", PKeyBackend.normalize_origin("https://a.example:8443/") == "https://a.example:8443")
	t.check("backend: loopback http is allowed", PKeyBackend.normalize_origin("http://127.0.0.1:3000") == "http://127.0.0.1:3000" and PKeyBackend.normalize_origin("http://localhost") == "http://localhost:80")
	for bad in ["http://api.example.com", "https://*.example.com", "https://a.example/path", "https://a.example?x=1", "https://a.example#f", "https://u:p@a.example", "api.example.com", "ftp://a.example", "https://a.example?", ""]:
		t.check("backend: %s is not an origin" % bad, PKeyBackend.normalize_origin(bad) == "")


func _sdk(store: PKeyStore, clock: Array, origins: PackedStringArray) -> Node:
	var s := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(h.server.base_url(), store, clock, h.F["product"], h.F["trust"], h.F["version"])
	opts.expected_services = PackedStringArray(["license"])
	opts.backend_origins = origins
	var r: PKeyResult = s.configure(opts)
	if not r.ok:
		return s
	await s.start()
	return s


## A synced SDK allowed to reach `api`; `clock` is its cell; `mono` the backend's monotonic cell.
func _ready_sdk(t: PKeyTestContext, clock: Array, mono: Array) -> Node:
	h.serve_docs([h.F["token"]])
	var store := PKeyMemoryStore.new(h.F["device_id"], h.F["token"])
	var s := await _sdk(store, clock, PackedStringArray([api.base_url()]))
	await s.sync()
	t.check("backend: the SDK holds a licence", s.core.cache.license != null)
	s.backend.monotonic = func() -> float: return mono[0]
	# A forced sync is answered with a re-signed document (a later issuedAt), as the Worker does.
	var held: Dictionary = s.core.cache.license["doc"].duplicate()
	var n := [0]
	h.plan["/license/document"] = [func(_req: Dictionary) -> Dictionary:
		n[0] += 1
		var d := held.duplicate()
		d["issuedAt"] = int(held["issuedAt"]) + 10 * n[0]
		d["expiresAt"] = int(held["expiresAt"]) + 10 * n[0]
		return PKeyLicenseTestSupport.ok_doc(PKeyPacksFixtures.sign_with(d, "pkey-test-prod-2026", "pkey-license+jws"))]
	api.requests.clear()
	other.requests.clear()
	h.server.requests.clear()
	return s


func _headers(t: PKeyTestContext) -> void:
	var clock := [h.F["now"]]
	var s := await _ready_sdk(t, clock, [0.0])
	var lines: PackedStringArray = await s.backend.headers()
	t.check("backend: headers() is the licence and the device", lines.size() == 2 and lines[0] == "X-PKey-License: %s" % s.core.cache.license["jws"] and lines[1] == "X-PKey-Device: %s" % h.F["device_id"], str(lines))
	t.check("backend: headers() never carries the token", not " ".join(lines).contains(h.F["token"]))
	t.check("backend: a fresh document is not synced", h.requests("GET", "/license/document").is_empty())
	var ok: PKeyResult = await s.backend.headers_for(api.base_url() + "/x")
	t.check("backend: headers_for an allowed URL", ok.ok and ok.detail.size() == 2)
	var no: PKeyResult = await s.backend.headers_for(other.base_url() + "/export?token=SECRET")
	t.check("backend: headers_for a foreign URL is refused", not no.ok and String(no.code) == "backend-origin-not-allowed")
	t.check("backend: the refusal names the origin only", no.message.contains(other.base_url()) and not no.message.contains("SECRET") and not no.message.contains("/export"), no.message)
	s.backend.attach(s.core, Callable(), PackedStringArray([api.base_url()]))
	s.free()


func _request(t: PKeyTestContext) -> void:
	var clock := [h.F["now"]]
	var s := await _ready_sdk(t, clock, [0.0])
	var r: PKeyResult = await s.backend.request("GET", api.base_url() + "/x", {"Authorization": "Bearer app"})
	t.check("backend: request is answered", r.ok and r.detail["status"] == 200, str(r))
	var seen: Dictionary = api.requests[0]
	t.check("backend: it sent the licence and device", seen["headers"].get("x-pkey-license") == s.core.cache.license["jws"] and seen["headers"].get("x-pkey-device") == h.F["device_id"])
	t.check("backend: the app's Authorization passes through", seen["headers"].get("authorization") == "Bearer app")
	var denied: PKeyResult = await s.backend.request("GET", other.base_url() + "/x")
	t.check("backend: a foreign origin is refused before sending", not denied.ok and String(denied.code) == "backend-origin-not-allowed" and other.requests.is_empty())
	var bad_scheme: PKeyResult = await s.backend.request("GET", "https://127.0.0.1:%d/x" % api.port)
	t.check("backend: another scheme is another origin", not bad_scheme.ok and String(bad_scheme.code) == "backend-origin-not-allowed")
	s.free()


func _redirects(t: PKeyTestContext) -> void:
	var clock := [h.F["now"]]
	var s := await _ready_sdk(t, clock, [0.0])
	api_plan = [{"status": 302, "headers": {"Location": other.base_url() + "/steal"}}]
	var r: PKeyResult = await s.backend.request("GET", api.base_url() + "/export")
	t.check("backend: a redirect to another origin is refused", not r.ok and String(r.code) == "backend-origin-not-allowed", str(r))
	t.check("backend: the hop was never sent", other.requests.is_empty() and api.requests.size() == 1, "%d/%d" % [other.requests.size(), api.requests.size()])
	t.check("backend: the refusal names the origin only", r.message.contains(other.base_url()) and not r.message.contains("steal"), r.message)
	api.requests.clear()
	api_plan = [{"status": 302, "headers": {"Location": "/b"}}, {"status": 200, "body": "b"}]
	var ok: PKeyResult = await s.backend.request("GET", api.base_url() + "/a")
	t.check("backend: a redirect within the origin is followed with the headers", ok.ok and api.requests.size() == 2 and api.requests[1]["path"] == "/b" and api.requests[1]["headers"].has("x-pkey-license"), str(api.requests))
	api_plan = []
	s.free()


func _retry(t: PKeyTestContext) -> void:
	var clock := [h.F["now"]]
	var mono := [0.0]
	var s := await _ready_sdk(t, clock, mono)
	api_plan = [_problem(401, "license_stale")]
	var r: PKeyResult = await s.backend.request("GET", api.base_url() + "/x")
	t.check("backend: stale forces one sync and one retry", r.ok and r.detail["status"] == 401 and api.requests.size() == 2 and h.requests("GET", "/license/document").size() == 1, "%d/%d" % [api.requests.size(), h.requests("GET", "/license/document").size()])
	# Within 10 s no further forced sync: the backend's answer comes back as it is.
	r = await s.backend.request("GET", api.base_url() + "/x")
	t.check("backend: a second forced sync within 10 s does not happen", r.ok and r.detail["status"] == 401 and api.requests.size() == 3 and h.requests("GET", "/license/document").size() == 1, "%d" % api.requests.size())
	mono[0] = 10.0
	r = await s.backend.request("GET", api.base_url() + "/x")
	t.check("backend: ten seconds later it syncs again", api.requests.size() == 5 and h.requests("GET", "/license/document").size() == 2, "%d" % api.requests.size())
	mono[0] = 100.0
	api.requests.clear()
	api_plan = [_problem(401, "license_invalid"), {"status": 200, "body": "yes"}]
	r = await s.backend.request("GET", api.base_url() + "/x")
	t.check("backend: invalid retries and succeeds", r.ok and r.detail["status"] == 200 and api.requests.size() == 2)
	# A failed sync hands back the backend's own response.
	mono[0] = 1000.0
	api.requests.clear()
	h.plan["/license/document"] = [PKeyLicenseTestSupport.json(500, {"error": {"code": "internal_error"}})]
	api_plan = [_problem(401, "license_stale")]
	r = await s.backend.request("GET", api.base_url() + "/x")
	t.check("backend: a failed sync returns the backend's response, no retry", r.ok and r.detail["status"] == 401 and api.requests.size() == 1, str(api.requests.size()))
	api.requests.clear()
	api_plan = [_problem(401, "license_required")]
	r = await s.backend.request("GET", api.base_url() + "/x")
	t.check("backend: license_required is surfaced, not retried", r.ok and r.detail["status"] == 401 and api.requests.size() == 1)
	api_plan = []
	s.free()


func _typed(t: PKeyTestContext) -> void:
	var clock := [h.F["now"]]
	var s := await _ready_sdk(t, clock, [0.0])
	for code in ["not_entitled", "sign_in_required"]:
		api.requests.clear()
		api_plan = [_problem(403, code)]
		var r: PKeyResult = await s.backend.request("GET", api.base_url() + "/x")
		t.check("backend: %s is a typed failure" % code, not r.ok and String(r.code) == code and r.message == s.core.copy.message(code), str(r))
		t.check("backend: %s is never retried" % code, api.requests.size() == 1 and h.requests("GET", "/license/document").is_empty())
	api_plan = []
	s.free()


func _shared(t: PKeyTestContext) -> void:
	var clock := [h.F["now"]]
	var s := await _ready_sdk(t, clock, [0.0])
	clock[0] = int(s.core.cache.license["doc"]["expiresAt"]) - 1000
	var counted := [0]
	s.backend.attach(s.core, func(force: bool) -> PKeySyncResult:
		counted[0] += 1
		await s.get_tree().create_timer(0.1).timeout
		return await s.sync(force), PackedStringArray([api.base_url()]))
	var done := [0]
	var go := func() -> void:
		await s.backend.headers()
		done[0] += 1
	for i in 5:
		go.call()
	while done[0] < 5:
		await s.get_tree().process_frame
	t.check("backend: concurrent callers past the margin share one sync", counted[0] == 1, str(counted[0]))
	s.free()


func _configure(t: PKeyTestContext) -> void:
	var s := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(h.server.base_url(), PKeyMemoryStore.new(h.F["device_id"], ""), [h.F["now"]], h.F["product"], h.F["trust"], h.F["version"])
	opts.backend_origins = PackedStringArray(["http://api.example.com"])
	var r: PKeyResult = s.configure(opts)
	t.check("backend: a malformed origin fails configure()", not r.ok and String(r.code) == "invalid-options", str(r))
	s.free()
