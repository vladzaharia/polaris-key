extends RefCounted
# @pkey-feature core.sync license.entitlements
# LX-17 (S-19 §7.5, §10.1 risk 1, decision 10): does the Godot SDK tolerate a `licenseId` that
# changes on a PLAIN REFRESH (no activation call, the same device token), the way
# `licensing.reanchor: onRefresh` would deliver it?
#
# "Tolerate" is pinned on the three surfaces the audit names:
#   cache       the new document is applied, the accessors read it, and it is what a fresh SDK
#               restores from the same store with no network;
#   telemetry   the `/devices/report` after the refresh carries the NEW licence's grants, and the
#               current device reports the new licence id;
#   activation  the device stays activated on the SAME token, with no re-activation and no wipe.
#
# The first document is the one recorded in sync-etag-304 (`lic_djdl_1`); the re-anchored one is
# the same claims with another licence id, a later issuedAt and one more grant, signed with the
# corpus's test product key (the transcript's pin).
#
# Audit result for Godot: PASS.

const PRO_ID := "lic_djdl_pro"


func run(t: PKeyTestContext) -> void:
	var h := PKeyLicenseTestSupport.new()
	if not t.check("licenseId refresh: fixtures present", h.ready()):
		return
	await _refresh(t, h)
	h.free_server()


func _pro_doc(h: PKeyLicenseTestSupport) -> String:
	var now: int = int(h.F["now"]) + 60
	var doc := {
		"iss": "key.plrs.im", "aud": h.F["product"], "deviceId": h.F["device_id"],
		"issuedAt": now, "expiresAt": now + 3600, "graceUntil": now + 30 * 86400,
		"licenseId": PRO_ID,
		"profile": {"name": "Ada Lovelace", "firstName": "Ada", "email": "ada@example.com", "activatedAt": int(h.F["now"])},
		"entitlements": {
			"polarisVpn": {"state": "enforced", "value": true, "updatedAt": now},
			"pro": {"state": "enforced", "value": true, "updatedAt": now},
		},
	}
	return PKeyPacksFixtures.sign_with(doc, "pkey-test-prod-2026", "pkey-license+jws")


func _sdk(h: PKeyLicenseTestSupport, base_url: String, store: PKeyStore, clock: Array) -> Node:
	var s := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(base_url, store, clock, h.F["product"], h.F["trust"], h.F["version"])
	opts.expected_services = PackedStringArray(["license"])
	s.configure(opts)
	await s.start()
	return s


func _refresh(t: PKeyTestContext, h: PKeyLicenseTestSupport) -> void:
	var token: String = h.F["token"]
	var pro_jws := _pro_doc(h)
	var etag := [String(h.F["license_etag"])]
	var served := [String(h.F["license"])]
	h.server.requests.clear()
	h.plan = {
		"polaris-trust.jws": [h.ok_doc(h.F["trust_jws"])],
		"/license/document": [func(req: Dictionary) -> Dictionary:
			if req["headers"].get("if-none-match") == etag[0]:
				return {"status": 304, "headers": {"ETag": etag[0]}}
			return h.ok_doc(served[0], etag[0])],
		"/devices/report": [h.json(200, {"ok": true})],
	}
	var store := PKeyMemoryStore.new(h.F["device_id"], token)
	var clock := [h.F["now"]]
	var sdk = await _sdk(h, h.server.base_url(), store, clock)
	var first: PKeySyncResult = await sdk.sync()
	t.check("licenseId refresh: the first licence applies", first.documents.get("license") == "applied" and sdk.license.get_license_id() == "lic_djdl_1" and not sdk.license.is_entitled("pro"), str(first.documents))

	# The server re-anchors this device on another licence; the next plain sync receives it.
	served[0] = pro_jws
	etag[0] = "\"lic-2\""
	clock[0] = int(h.F["now"]) + 60
	h.server.requests.clear()
	var r: PKeySyncResult = await sdk.sync()

	# cache
	t.check("licenseId refresh: the re-anchored document is applied", r.documents.get("license") == "applied", str(r.documents))
	t.check("licenseId refresh: get_license_id reads the new licence", sdk.license.get_license_id() == PRO_ID, sdk.license.get_license_id())
	t.check("licenseId refresh: the new licence's grants are read", sdk.license.is_entitled("pro") and sdk.license.get_entitlements() == {"polarisVpn": true, "pro": true}, str(sdk.license.get_entitlements()))
	t.check("licenseId refresh: the store holds the new artifact", store.cache["docs"]["license"] == pro_jws and store.cache["etags"]["license"] == "\"lic-2\"")
	# activation state
	t.check("licenseId refresh: no re-activation", h.requests("POST", "/license/activate").is_empty())
	var bearers: Array = h.requests("GET", "/license/document").map(func(x): return PKeyLicenseTestSupport.bearer(x))
	t.check("licenseId refresh: the same token is used", not bearers.is_empty() and bearers.all(func(b): return b == token) and store.token == token, str(bearers))
	t.check("licenseId refresh: still activated by the token and ok", sdk.license.activation() == &"token" and sdk.license.status()["status"] == "ok" and sdk.is_licensed(), str(sdk.license.status()))
	# telemetry
	var reports := h.requests("POST", "/devices/report")
	var body = PKeyJson.parse(PKeyLicenseTestSupport.body_text(reports[0]))["value"] if reports.size() == 1 else null
	t.check("licenseId refresh: one report carrying the new grants", body is Dictionary and body.get("entitlements") == {"polarisVpn": true, "pro": true}, str(body))
	t.check("licenseId refresh: the current device reports the new licence id", sdk.devices.get_current_device().get("license_id") == PRO_ID, str(sdk.devices.get_current_device()))

	# The following refresh revalidates the new licence's document normally.
	var again: PKeySyncResult = await sdk.sync()
	t.check("licenseId refresh: the next refresh is a 304 on the new licence", again.documents.get("license") == "unchanged" and sdk.license.get_license_id() == PRO_ID, str(again.documents))
	sdk.queue_free()

	# A fresh SDK on the same store, with nothing listening, restores the re-anchored document.
	var offline = await _sdk(h, "http://127.0.0.1:9", store, clock)
	t.check("licenseId refresh: a fresh SDK restores the new licence offline", offline.license.get_license_id() == PRO_ID and offline.license.is_entitled("pro") and offline.license.status()["status"] == "ok", str(offline.license.status()))
	offline.queue_free()
