extends RefCounted
# @pkey-feature license.deactivate
# deactivate(): POST /license/deauthorize best-effort, then the mandatory local wipe of the token
# and the verified cache (PolarisKey.config falls back at once); the device id stays. A refused or unreachable server still gets a full
# wipe and the remote failure reported; a wipe failure is returned (store-failed), never
# swallowed.

const S := preload("res://tests/license/support.gd")
const TOKEN := "pkeyt_DEACTIVATEDEACTIVATEDEACTIVATEDEACTIVA00"


## A store whose token cannot be removed (a locked keychain, a read-only disk).
class StuckStore:
	extends PKeyMemoryStore

	func _init(p_device_id: String, p_token: String) -> void:
		super(p_device_id, p_token)

	func clear_token() -> bool:
		return false


var h: PKeyLicenseTestSupport


func run(t: PKeyTestContext) -> void:
	h = PKeyLicenseTestSupport.new()
	if not t.check("deactivate: fixtures present", h.ready()):
		return
	await _confirmed(t)
	await _refused(t)
	await _unreachable(t)
	await _wipe_failure(t)
	await _no_token(t)
	h.free_server()


## A synced device: the token held and both documents cached.
func _synced(store: PKeyStore) -> Node:
	h.serve_docs([TOKEN])
	var sdk = await h.sdk(store)
	await sdk.sync()
	return sdk


func _confirmed(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {"/license/deauthorize": [S.json(200, {"ok": true})]}
	var store := PKeyMemoryStore.new(h.F["device_id"], TOKEN)
	var sdk = await _synced(store)
	t.check("deactivate: the device starts licensed with a cache", sdk.license.status()["status"] == "ok" and store.cache is Dictionary)
	t.check("deactivate: the synced config is visible", sdk.config.get_value("ui.theme", "light") == "dark")
	var states: Array = []
	sdk.state_changed.connect(func(s): states.append(s["status"]))
	var changed: Array = []
	sdk.config.config_changed.connect(func(keys): changed.append_array(keys))
	var r: PKeyResult = await sdk.license.deactivate()
	var reqs: Array = h.requests("POST", "/license/deauthorize")
	t.check("deactivate: one POST /license/deauthorize with the token", reqs.size() == 1 and S.bearer(reqs[0]) == TOKEN)
	t.check("deactivate: ok when confirmed and wiped", r.ok and r.detail == {"remote_attempted": true, "remote_ok": true, "wiped": true}, str(r))
	_wiped(t, "confirmed", sdk, store)
	t.check("deactivate: state_changed reported needs-activation", states.back() == "needs-activation", str(states))
	t.check("deactivate: the wiped config falls back and config_changed fires", sdk.config.get_value("ui.theme", "light") == "light" and changed.has("ui.theme"), str(changed))
	sdk.queue_free()


func _refused(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {"/license/deauthorize": [S.json(401, {"error": "unauthorized"})]}
	var store := PKeyMemoryStore.new(h.F["device_id"], TOKEN)
	var sdk = await _synced(store)
	var r: PKeyResult = await sdk.license.deactivate()
	t.check("deactivate: a refusal is reported with the server's code", not r.ok and r.code == PKeyErrors.UNAUTHORIZED and r.detail == {"remote_attempted": true, "remote_ok": false, "wiped": true}, str(r))
	_wiped(t, "refused", sdk, store)
	sdk.queue_free()


func _unreachable(t: PKeyTestContext) -> void:
	var store := PKeyMemoryStore.new(h.F["device_id"], TOKEN)
	var sdk = await _synced(store)
	# The control plane goes away: point the transport at a port nobody listens on.
	var dead := PKeyTestFixtures.new_server(func(_req): return {"status": 200})
	sdk.core.base_url = dead.base_url()
	dead.stop()
	dead.queue_free()
	var r: PKeyResult = await sdk.license.deactivate()
	t.check("deactivate: unreachable -> the remote failure is reported", not r.ok and (r.code == PKeyErrors.NETWORK or r.code == PKeyErrors.TIMEOUT) and r.detail == {"remote_attempted": true, "remote_ok": false, "wiped": true}, str(r))
	_wiped(t, "unreachable", sdk, store)
	sdk.queue_free()


func _wipe_failure(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	h.plan = {"/license/deauthorize": [S.json(200, {"ok": true})]}
	var store := StuckStore.new(h.F["device_id"], TOKEN)
	var sdk = await _synced(store)
	var r: PKeyResult = await sdk.license.deactivate()
	t.check("deactivate: a wipe failure is returned, not swallowed", not r.ok and r.code == PKeyErrors.STORE_FAILED and r.detail == {"remote_attempted": true, "remote_ok": true, "wiped": false}, str(r))
	t.check("deactivate: the cache is still wiped when the token is stuck", store.cache == null and sdk.core.cache.license == null)
	sdk.queue_free()


func _no_token(t: PKeyTestContext) -> void:
	h.server.requests.clear()
	var store := PKeyMemoryStore.new(h.F["device_id"])
	var sdk = await h.sdk(store)
	var r: PKeyResult = await sdk.license.deactivate()
	t.check("deactivate: without a token nothing is sent and the wipe still runs", r.ok and r.detail == {"remote_attempted": false, "remote_ok": false, "wiped": true} and h.requests("POST", "/license/deauthorize").is_empty(), str(r))
	sdk.queue_free()


func _wiped(t: PKeyTestContext, label: String, sdk: Node, store: PKeyMemoryStore) -> void:
	t.check("deactivate (%s): the token is gone" % label, store.token == "" and not sdk.core.tokens.has_token() and sdk.core.tokens.source() == "")
	t.check("deactivate (%s): the verified cache is gone" % label, store.cache == null and sdk.core.cache.license == null and sdk.core.cache.config == null)
	t.check("deactivate (%s): the device id stays" % label, store.device_id == h.F["device_id"] and sdk.core.device_id == h.F["device_id"])
	t.check("deactivate (%s): the licence needs activation" % label, sdk.license.status()["status"] == "needs-activation" and sdk.license.activation() == &"")
