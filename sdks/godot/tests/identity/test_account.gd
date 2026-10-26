extends RefCounted
# @pkey-feature identity.devicecode license.deactivate identity.account identity.attach
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
	await _discovered(t)
	await _attach(t)
	h.free_server()


## identity.attach (I-10b.3): preview, confirm, typed refusals, no endpoint.
func _attach(t: PKeyTestContext) -> void:
	h.plan.clear()
	h.server.requests.clear()
	h.serve_docs([h.F["token"]])
	var root := "%s/%s/identity" % [h.server.base_url(), h.F["product"]]
	var fragment := {"enabled": true, "account": true, "endpoints": {"attach": root + "/attach", "subject": root + "/subject", "signout": root + "/signout", "accountPortal": h.server.base_url() + "/#/p/djdl"}}
	var doc := {"product": h.F["product"], "services": {"license": {"enabled": true}, "config": {"enabled": true}, "identity": fragment}}
	h.plan["polaris.json"] = [S.json(200, doc)]
	h.plan["/identity/attach"] = [
		S.json(200, {"status": "confirm", "license": {"id": "lic_1", "tierId": null, "name": "Ada"}}),
		S.json(200, {"token": "pkeyt_ROTATEDROTATEDROTATEDROTATEDROTATEDROTATE", "subject": "ps_abc", "attached": "claimed"}),
		S.json(409, {"error": {"code": "license_owned"}}),
		S.json(401, {"error": "unauthorized"}),
		S.json(200, {"status": "ok"}),
	]
	var store := PKeyMemoryStore.new(h.F["device_id"], h.F["token"])
	var sdk = await h.sdk(store)
	await sdk.sync()
	var r: PKeyResult = await sdk.identity.attach(false)
	var sent: Array = h.requests("POST", "/identity/attach")
	t.check("attach: the preview names the licence and writes nothing", r.ok and r.detail["kind"] == "confirm" and r.detail["license"]["id"] == "lic_1" and r.detail["license"]["tier_id"] == null and store.token == h.F["token"], str(r))
	t.check("attach: the preview POSTs {confirm: false} with the device token", sent.size() == 1 and S.bearer(sent[0]) == h.F["token"] and JSON.parse_string(sent[0]["body"].get_string_from_utf8()) == {"confirm": false}, str(sent.size()))
	r = await sdk.identity.attach(true)
	t.check("attach: confirm stores the rotated token and the subject", r.ok and r.detail["kind"] == "ok" and r.detail["attached"] == "claimed" and r.detail["subject"] == "ps_abc" and store.token.begins_with("pkeyt_ROTATED") and sdk.core.cache.subject == "ps_abc", str(r))
	r = await sdk.identity.attach(true)
	t.check("attach: a Worker refusal keeps its code and the token", not r.ok and r.code == &"license_owned" and r.detail["kind"] == "refused" and r.detail["status"] == 409 and store.token.begins_with("pkeyt_ROTATED"), str(r))
	r = await sdk.identity.attach(true)
	t.check("attach: a bare error string is the code too", not r.ok and r.code == &"unauthorized" and r.detail["status"] == 401, str(r))
	r = await sdk.identity.attach(true)
	t.check("attach: an answer without a token is invalid and changes nothing", not r.ok and r.code == PKeyErrors.INVALID_RESPONSE and store.token.begins_with("pkeyt_ROTATED"), str(r))
	sdk.queue_free()

	# No endpoint: unavailable, nothing sent.
	h.plan["polaris.json"] = [S.json(200, {"product": h.F["product"], "services": {"license": {"enabled": true}, "identity": {"enabled": false}}})]
	h.server.requests.clear()
	store = PKeyMemoryStore.new(h.F["device_id"], h.F["token"])
	sdk = await h.sdk(store)
	r = await sdk.identity.attach(true)
	t.check("attach: no fragment is unavailable and nothing is sent", not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and r.detail["kind"] == "unavailable" and h.requests("POST", "/identity/attach").is_empty(), str(r))
	sdk.queue_free()


## identity.account (I-10b.2): subject(), sign_out() and open_account() over a discovered fragment.
func _discovered(t: PKeyTestContext) -> void:
	h.plan.clear()
	h.server.requests.clear()
	h.serve_docs([h.F["token"]])
	var root := "%s/%s/identity" % [h.server.base_url(), h.F["product"]]
	var fragment := {"enabled": true, "account": true, "endpoints": {"subject": root + "/subject", "signout": root + "/signout", "accountPortal": h.server.base_url() + "/#/p/djdl"}}
	var doc := {"product": h.F["product"], "services": {"license": {"enabled": true}, "config": {"enabled": true}, "identity": fragment}}
	h.plan["polaris.json"] = [S.json(200, doc)]
	h.plan["/identity/subject"] = [S.json(200, {"subject": "ps_abc"}), S.json(200, {"subject": null})]
	h.plan["/identity/signout"] = [S.json(200, {"released": false}), S.json(200, {"released": true})]
	var store := PKeyMemoryStore.new(h.F["device_id"], h.F["token"])
	var sdk = await h.sdk(store)
	await sdk.sync()
	var events: Array = []
	sdk.event.connect(func(kind: String, data: Dictionary) -> void:
		if kind == "identity":
			events.append(data))
	var r: PKeyResult = await sdk.identity.subject()
	t.check("account: subject() reads the discovered endpoint", r.ok and r.detail["subject"] == "ps_abc" and S.bearer(h.requests("GET", "/identity/subject")[0]) == h.F["token"], str(r))
	t.check("account: the subject is kept in the cache record", sdk.core.cache.subject == "ps_abc" and store.cache.get("subject") == "ps_abc")
	var order: Array = []
	sdk.identity.add_before_sign_out(func() -> void: order.append("hook"))
	t.check("account: the first subject read is a subjectChanged event", events == [{"kind": "subjectChanged", "subject": "ps_abc", "previous": null}], str(events))
	r = await sdk.identity.sign_out()
	t.check("account: released: false keeps the token and the licence", r.ok and r.detail["released"] == false and store.token == h.F["token"] and sdk.license.is_licensed(), str(r))
	t.check("account: the hook ran before the server was asked, the subject is forgotten", order == ["hook"] and sdk.core.cache.subject == "" and not store.cache.has("subject"))
	r = await sdk.identity.subject()
	t.check("account: subject() is null once forgotten", r.ok and r.detail["subject"] == null, str(r))
	t.check("account: a sign-out is a signedOut event carrying the subject it forgot", events.size() == 2 and events[1] == {"kind": "signedOut", "subject": null, "previous": "ps_abc"}, str(events))
	r = await sdk.identity.sign_out()
	t.check("account: released: true drops the token and the cache", r.ok and r.detail["released"] == true and store.token == "" and not sdk.license.is_licensed(), str(r))
	t.check("account: no deauthorize call on the released path", h.requests("POST", "/license/deauthorize").is_empty(), str(h.requests("POST", "/license/deauthorize").size()))
	r = await sdk.identity.subject()
	t.check("account: subject() without a credential is null", r.ok and r.detail["subject"] == null, str(r))
	var opened: Array = []
	sdk.identity.account_opener = func(url: String) -> bool:
		opened.append(url)
		return true
	r = await sdk.identity.open_account()
	t.check("account: open_account() hands the published page to the opener", r.ok and r.detail["opened"] and opened.size() == 1 and r.detail["url"] == fragment["endpoints"]["accountPortal"], str(r))
	sdk.queue_free()

	# An endpoint on another origin is never used.
	h.server.requests.clear()
	store = PKeyMemoryStore.new(h.F["device_id"], h.F["token"])
	sdk = await h.sdk(store)
	await sdk.sync()
	fragment["endpoints"]["signout"] = "https://evil.example/identity/signout"
	h.plan["polaris.json"] = [S.json(200, doc)]
	h.plan["/license/deauthorize"] = [S.json(200, {"ok": true})]
	r = await sdk.identity.sign_out()
	t.check("account: an endpoint on another origin is unavailable and the legacy release runs", r.ok and r.detail.has("remote_attempted") and h.requests("POST", "/identity/signout").is_empty(), str(r))
	sdk.queue_free()

	# No identity fragment: unavailable, and nothing is sent.
	h.plan["polaris.json"] = [S.json(200, {"product": h.F["product"], "services": {"license": {"enabled": true}, "identity": {"enabled": false}}})]
	h.server.requests.clear()
	store = PKeyMemoryStore.new(h.F["device_id"], h.F["token"])
	sdk = await h.sdk(store)
	r = await sdk.identity.subject()
	t.check("account: no fragment: subject() is unavailable", not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and r.detail["kind"] == "unavailable", str(r))
	r = await sdk.identity.open_account()
	t.check("account: no fragment: open_account() is unavailable", not r.ok and r.detail["kind"] == "unavailable", str(r))
	t.check("account: no fragment: only discovery was requested", h.requests("GET", "/identity/subject").is_empty())
	sdk.queue_free()
