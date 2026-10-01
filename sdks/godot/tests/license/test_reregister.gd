extends RefCounted
# @pkey-feature license.reregister
# The §5 single re-acquire on a document 401, on the route P1b-06's rule picks
# (PKeyTokenManager.choose_reacquire_route), installed by PolarisKey.license:
#   - License disabled for the product: exactly one keyless POST /devices/register (no
#     Authorization, the same device id, the fingerprint) and one retry;
#   - a token minted by devices.register() in this process, License on: the same;
#   - a licensed device (activated in this process): exactly one POST /license/token with the
#     current token as the bearer;
#   - after a restart (the source is unknown) with License on: POST /license/token (P1b-06's
#     correction: no restart heuristic; the sync-errors transcript pins it);
#   - two parallel 401s (licence and config) share the one attempt;
#   - a 403 registration_closed, or a 429 from license/token, records the hard 401 with no
#     second attempt in that pass.

const S := preload("res://tests/license/support.gd")
const OLD := "pkeyt_OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD0"
const NEW := "pkeyt_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNE0"
const REGISTERED := "pkeyt_REGREGREGREGREGREGREGREGREGREGREGREGREGRE0"

var h: PKeyLicenseTestSupport


func run(t: PKeyTestContext) -> void:
	h = PKeyLicenseTestSupport.new()
	if not t.check("reregister: fixtures present", h.ready()):
		return
	await _license_disabled(t)
	await _minted_by_register(t)
	await _licensed(t)
	await _after_restart(t)
	await _hard_401(t)
	h.free_server()


func _attempts(sdk: Node) -> int:
	return sdk.core.tokens.attempts


func _license_disabled(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {}
	h.serve_docs([NEW])
	h.plan["/devices/register"] = [S.json(200, {"token": NEW, "deviceId": h.F["device_id"]})]
	var store := PKeyMemoryStore.new(h.F["device_id"], OLD)
	var sdk = await h.sdk(store, PackedStringArray(["config"]))
	var host: PKeyFakeHost = sdk.devices.fingerprint_host
	var r: PKeySyncResult = await sdk.sync()
	var reg: Array = h.requests("POST", "/devices/register")
	t.check("reregister: License disabled -> exactly one POST /devices/register", reg.size() == 1 and _attempts(sdk) == 1, "%d register calls" % reg.size())
	t.check("reregister: License disabled -> no POST /license/token", h.requests("POST", "/license/token").is_empty())
	if reg.size() == 1:
		t.check("reregister: the re-register sends no Authorization", not reg[0]["headers"].has("authorization"))
		t.check("reregister: the re-register keeps the device id", reg[0]["headers"].get("x-pkey-device") == h.F["device_id"])
		var body := PKeyJson.parse(S.body_text(reg[0]))
		t.check("reregister: the re-register sends the fingerprint", body["ok"] and body["value"] == {"fingerprint": PKeyFingerprint.hash_components(h.F["product"], host.host["expected"])}, S.body_text(reg[0]))
	var cfg: Array = h.requests("GET", "/config/document")
	t.check("reregister: one retry, with the new token", cfg.size() == 2 and S.bearer(cfg[0]) == OLD and S.bearer(cfg[1]) == NEW, str(cfg.map(func(x): return S.bearer(x))))
	t.check("reregister: the retry applies", r.documents == {"config": "applied"} and not r.unauthorized, str(r.documents))
	t.check("reregister: the new token is stored with source register", store.token == NEW and sdk.core.tokens.source() == PKeyTokenManager.SOURCE_REGISTER)
	t.check("reregister: the route was devices-register", sdk.license.last_reacquire_route == PKeyTokenManager.ROUTE_DEVICES_REGISTER)
	t.check("reregister: License disabled stays not-applicable", sdk.license.status()["status"] == "not-applicable")
	sdk.queue_free()


func _minted_by_register(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {}
	h.serve_docs([NEW])
	h.plan["/devices/register"] = [
		S.json(200, {"token": REGISTERED, "deviceId": h.F["device_id"]}),
		func(req): return S.json(200, {"token": NEW, "deviceId": h.F["device_id"]}),
	]
	var store := PKeyMemoryStore.new(h.F["device_id"])
	var sdk = await h.sdk(store)
	var reg_r: PKeyResult = await sdk.devices.register()
	t.check("reregister: register() mints the token (source register)", reg_r.ok and store.token == REGISTERED and sdk.core.tokens.source() == PKeyTokenManager.SOURCE_REGISTER, str(reg_r))
	h.server.requests.clear()
	# Both documents 401 for the registered token at once: one shared re-register serves both.
	var r: PKeySyncResult = await sdk.sync()
	var reg: Array = h.requests("POST", "/devices/register")
	t.check("reregister: a register()-minted token re-registers, License on", reg.size() == 1 and h.requests("POST", "/license/token").is_empty(), "%d register, %d token" % [reg.size(), h.requests("POST", "/license/token").size()])
	t.check("reregister: two parallel 401s cause one call", _attempts(sdk) == 1 and reg.size() == 1)
	var first := h.server.requests.filter(func(x): return String(x["path"]).ends_with("/document") and S.bearer(x) == REGISTERED)
	t.check("reregister: both documents were refused first", first.size() == 2, str(first.size()))
	t.check("reregister: both documents retried once and applied", r.documents == {"license": "applied", "config": "applied"} and h.requests("GET", "/license/document").size() == 2 and h.requests("GET", "/config/document").size() == 2, str(r.documents))
	t.check("reregister: the new token is stored", store.token == NEW)
	sdk.queue_free()


func _licensed(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {}
	# The activation's own sync finds the documents unavailable (a 503), so nothing is held yet and
	# the retry below can apply the recorded documents (the anti-replay floor refuses a re-serve).
	h.serve_docs([OLD])
	h.plan["/license/document"] = [S.json(503, {"error": "unavailable"})]
	h.plan["/config/document"] = [S.json(503, {"error": "unavailable"})]
	h.plan["/license/activate"] = [S.json(200, {"token": OLD, "schemaVersion": 1})]
	var store := PKeyMemoryStore.new(h.F["device_id"])
	var sdk = await h.sdk(store)
	var a: PKeyActivationResult = await sdk.license.activate_with_key("pkey_djdl_key")
	t.check("reregister: the device is activated", a.ok and sdk.license.activation() == &"token" and sdk.core.tokens.source() == PKeyTokenManager.SOURCE_ACTIVATE, str(a))
	h.server.requests.clear()
	h.serve_docs([NEW])
	h.plan["/license/token"] = [func(req): return S.json(200, {"token": NEW, "schemaVersion": 1}) if S.bearer(req) == OLD else S.json(401, {"error": "unauthorized"})]
	var r: PKeySyncResult = await sdk.sync()
	var tok: Array = h.requests("POST", "/license/token")
	t.check("reregister: a licensed device -> exactly one POST /license/token", tok.size() == 1 and _attempts(sdk) == 1, "%d token calls" % tok.size())
	t.check("reregister: a licensed device never re-registers", h.requests("POST", "/devices/register").is_empty())
	if tok.size() == 1:
		t.check("reregister: license/token presents the current token", S.bearer(tok[0]) == OLD)
	t.check("reregister: the licensed retry applies", r.documents == {"license": "applied", "config": "applied"} and store.token == NEW, str(r.documents))
	t.check("reregister: the rotated token's source is reacquire", sdk.core.tokens.source() == PKeyTokenManager.SOURCE_REACQUIRE)
	t.check("reregister: the route was license-token", sdk.license.last_reacquire_route == PKeyTokenManager.ROUTE_LICENSE_TOKEN)
	sdk.queue_free()


func _after_restart(t: PKeyTestContext) -> void:
	# A token loaded from the store, no verified document, no bundle, License on: the source is
	# unknown, so the route is license/token (P1b-06).
	h.server.requests.clear()
	h.plan = {}
	h.serve_docs([NEW])
	h.plan["/license/token"] = [S.json(200, {"token": NEW, "schemaVersion": 1})]
	var store := PKeyMemoryStore.new(h.F["device_id"], OLD)
	var sdk = await h.sdk(store)
	t.check("reregister: after a restart the token's source is unknown", sdk.core.tokens.source() == "" and sdk.core.cache.license == null and sdk.core.cache.imported_bundle == null)
	var r: PKeySyncResult = await sdk.sync()
	t.check("reregister: after a restart with License on -> one POST /license/token", h.requests("POST", "/license/token").size() == 1 and h.requests("POST", "/devices/register").is_empty())
	t.check("reregister: after a restart the retry applies", r.documents == {"license": "applied", "config": "applied"}, str(r.documents))
	sdk.queue_free()

	# The same restart on a config-only product re-registers.
	h.server.requests.clear()
	h.plan["/devices/register"] = [S.json(200, {"token": NEW, "deviceId": h.F["device_id"]})]
	store = PKeyMemoryStore.new(h.F["device_id"], OLD)
	sdk = await h.sdk(store, PackedStringArray(["config"]))
	await sdk.sync()
	t.check("reregister: after a restart with License off -> one POST /devices/register", h.requests("POST", "/devices/register").size() == 1 and h.requests("POST", "/license/token").is_empty())
	sdk.queue_free()


func _hard_401(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {}
	h.serve_docs([NEW])
	h.plan["/devices/register"] = [S.json(403, {"error": {"code": "registration_closed", "message": "Registration is closed."}})]
	var store := PKeyMemoryStore.new(h.F["device_id"], OLD)
	var sdk = await h.sdk(store, PackedStringArray(["config"]))
	var r: PKeySyncResult = await sdk.sync()
	t.check("reregister: 403 registration_closed -> exactly one attempt", h.requests("POST", "/devices/register").size() == 1 and _attempts(sdk) == 1)
	t.check("reregister: 403 registration_closed -> no retry of the document", h.requests("GET", "/config/document").size() == 1)
	t.check("reregister: 403 registration_closed records the hard 401", r.unauthorized and r.documents == {"config": "unauthorized"} and PKeyClaims.is_true(store.cache.get("lastSyncUnauthorized")) and sdk.core.cache.last_sync_unauthorized, str(store.cache))
	t.check("reregister: the refused device keeps its old token", store.token == OLD)
	# The next pass has a fresh budget: one more attempt, never a loop.
	r = await sdk.sync()
	t.check("reregister: the next pass makes one attempt again", h.requests("POST", "/devices/register").size() == 2 and _attempts(sdk) == 2)
	sdk.queue_free()

	h.server.requests.clear()
	h.plan["/license/token"] = [S.json(429, {"error": "rate_limited", "message": "too many token requests"})]
	store = PKeyMemoryStore.new(h.F["device_id"], OLD)
	sdk = await h.sdk(store)
	r = await sdk.sync()
	t.check("reregister: 429 from license/token -> one attempt, then the hard 401", h.requests("POST", "/license/token").size() == 1 and r.unauthorized and sdk.license.status()["status"] == "revoked", str(sdk.license.status()))
	t.check("reregister: 429 -> neither document is retried", h.requests("GET", "/license/document").size() == 1 and h.requests("GET", "/config/document").size() == 1)
	sdk.queue_free()
