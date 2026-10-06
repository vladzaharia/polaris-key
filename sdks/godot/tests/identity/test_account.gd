extends RefCounted
# @pkey-feature identity.devicecode license.deactivate
# SDK parity §3.12: identity.current() reads the signed-in person off the verified licence's
# profile (null when none), and identity.sign_out() cancels a sign-in, forgets the identity and
# releases the seat through license.deactivate() (the best-effort server call, then the wipe).

const S := preload("res://tests/license/support.gd")

var h: PKeyLicenseTestSupport


func run(t: PKeyTestContext) -> void:
	h = PKeyLicenseTestSupport.new()
	if not t.check("account: fixtures present", h.ready()):
		return
	h.serve_docs([h.F["token"]])
	h.plan["/license/deauthorize"] = [S.json(200, {"ok": true})]
	var store := PKeyMemoryStore.new(h.F["device_id"], h.F["token"])
	var sdk = await h.sdk(store)
	t.check("account: current() is null before a document verifies", sdk.identity.current() == null)
	await sdk.sync()
	var who = sdk.identity.current()
	t.check("account: current() names the signed-in person", who is Dictionary and who["name"] == "Ada Lovelace" and who["email"] == "ada@example.com" and who.has("activatedAt"), str(who))
	var states: Array = []
	sdk.state_changed.connect(func(s): states.append(s["status"]))
	h.server.requests.clear()
	var r: PKeyResult = await sdk.identity.sign_out()
	t.check("account: sign_out() is deactivate()", r.ok and r.detail["remote_ok"] and r.detail["wiped"], str(r))
	t.check("account: sign_out() released the seat with the device token", h.requests("POST", "/license/deauthorize").size() == 1 and S.bearer(h.requests("POST", "/license/deauthorize")[0]) == h.F["token"])
	t.check("account: after sign_out() nothing is held", store.token == "" and sdk.identity.current() == null and not sdk.license.is_licensed() and states.has("needs-activation"), str(states))
	sdk.queue_free()

	var cold := PKeyTestFixtures.new_sdk()
	var r2: PKeyResult = await cold.identity.sign_out()
	t.check("account: sign_out() before configure() is refused", not r2.ok and r2.code == PKeyErrors.NOT_CONFIGURED)
	cold.queue_free()
	h.free_server()
