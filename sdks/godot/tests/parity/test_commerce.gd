extends RefCounted
# The commerce one-calls (SDK parity §3.9, SP-G09): purchase(flag) and restore() through the App
# Store (a fake PKeyApple) and Steam (a fake GodotSteam), claim_play(), claim_steam() with a Web
# API ticket bound to the binding, the sync after a successful claim, and the typed outcomes
# (cancelled, pending, not-owned, refused, unsupported) of PKeyPurchaseResult.

const TOKEN := "pkeyt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const BINDING := "f8606ae6-c6af-419a-a7ca-125107444036"
const PRODUCTS := [
	{"store": "app-store", "productId": "gg.acme.djdl.skins", "flag": "extras.diceSkins", "deliverable": "app"},
	{"store": "steam", "productId": "1234560", "flag": "extras.diceSkins", "deliverable": "app"},
	{"store": "play", "productId": "soundtrack", "flag": "extras.ost", "deliverable": "app"},
]

var server: PKeyFakeServer
var plan := {}


class Apple:
	extends RefCounted
	var result := "success"
	var owned: Array = []
	var finished: Array = []
	var bought: Array = []

	func availability(_f := "") -> PKeyResult:
		return PKeyResult.success()

	func products(ids: PackedStringArray) -> PKeyResult:
		await Engine.get_main_loop().process_frame
		return PKeyResult.success({"products": Array(ids).map(func(i): return {"id": i})})

	func purchase(id: String, token := "") -> PKeyResult:
		await Engine.get_main_loop().process_frame
		bought.append([id, token])
		if result != "success":
			return PKeyResult.success({"result": result})
		return PKeyResult.success({"result": "success", "transaction": {"id": "42", "jws": "h.p.s"}})

	func entitlements(_id := "") -> PKeyResult:
		await Engine.get_main_loop().process_frame
		return PKeyResult.success({"entitlements": owned})

	func finish(id: String) -> PKeyResult:
		await Engine.get_main_loop().process_frame
		finished.append(id)
		return PKeyResult.success({"finished": true})


class Steam:
	extends RefCounted
	signal get_ticket_for_web_api(auth_ticket: int, result: int, ticket_size: int, ticket_buffer: Array)
	signal overlay_toggled(active: bool, user_initiated: bool, app_id: int)
	var subscribed := {}
	var buy_on_overlay := true
	var identities: Array = []
	var overlays: Array = []
	var _pending: Array = []

	func getAuthTicketForWebApi(identity: String) -> int:
		identities.append(identity)
		_pending.append(["ticket", 7])
		return 7

	func isSubscribedApp(id: int) -> bool:
		return subscribed.has(id)

	func activateGameOverlayToStore(id: int, _flag: int) -> void:
		overlays.append(id)
		_pending.append(["overlay", id])

	func run_callbacks() -> void:
		var q := _pending.duplicate()
		_pending.clear()
		for p in q:
			if p[0] == "ticket":
				get_ticket_for_web_api.emit(p[1], 1, 3, [0xde, 0xad, 0x01])
			else:
				if buy_on_overlay:
					subscribed[p[1]] = true
				overlay_toggled.emit(false, true, p[1])


func run(t: PKeyTestContext) -> void:
	server = PKeyTestFixtures.new_server(_answer)
	await _app_store(t)
	await _steam(t)
	await _play_and_outlets(t)
	server.queue_free()


func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	for suffix in plan:
		if path.ends_with(suffix):
			var a = plan[suffix]
			return a.call(req) if a is Callable else a
	return _json(404, {"error": {"code": "not_found"}})


func _json(status: int, body: Variant) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(body)}


func _claim_ok(req: Dictionary) -> Dictionary:
	var b = JSON.parse_string((req["body"] as PackedByteArray).get_string_from_utf8())
	var flag := "extras.ost" if b.get("store") == "play" else "extras.diceSkins"
	return _json(200, {"ok": true, "store": b.get("store"), "productId": "p", "flag": flag, "deliverable": "app", "state": "active", "granted": true, "changed": true})


func _sdk(outlet := "") -> Node:
	var store := PKeyMemoryStore.new("TRANSCRIPTDEVICE0000000000000001", TOKEN)
	var opts := PKeyTestFixtures.options(server.base_url(), store, [1_700_000_000])
	opts.expected_services = PackedStringArray(["license", "config", "release", "distribution"])
	if outlet != "":
		opts.update_outlet = outlet
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(opts)
	await sdk.start()
	return sdk


func _claims() -> Array:
	return server.requests.filter(func(r): return String(r["path"]).ends_with("/distribution/commerce/claim"))


func _app_store(t: PKeyTestContext) -> void:
	plan = {"/distribution/commerce/binding": _json(200, {"bindingId": BINDING, "products": PRODUCTS}), "/distribution/commerce/claim": _claim_ok}
	var sdk = await _sdk("app-store")
	var apple := Apple.new()
	sdk.commerce.apple = apple
	var syncs := [0]
	sdk.commerce.on_claimed = func() -> void: syncs[0] += 1
	t.check("commerce: an app-store outlet buys through the App Store", sdk.commerce.current_store() == "app-store")
	var r: PKeyPurchaseResult = await sdk.commerce.purchase("extras.diceSkins")
	t.check("purchase: App Store bought with the binding token, claimed, finished, synced", r.ok and r.kind == PKeyPurchaseResult.KIND_OK and r.flags == ["extras.diceSkins"] and apple.bought == [["gg.acme.djdl.skins", BINDING]] and apple.finished == ["42"] and syncs[0] == 1, "%s %s %s" % [r, apple.bought, apple.finished])
	apple.result = "userCancelled"
	r = await sdk.commerce.purchase("extras.diceSkins")
	t.check("purchase: a cancelled sheet is cancelled and claims nothing", r.kind == PKeyPurchaseResult.KIND_CANCELLED and apple.finished.size() == 1)
	apple.result = "pending"
	r = await sdk.commerce.purchase("extras.diceSkins")
	t.check("purchase: Ask to Buy is pending", r.kind == PKeyPurchaseResult.KIND_PENDING)
	r = await sdk.commerce.purchase("extras.nope")
	t.check("purchase: a flag no product sells is refused before the store", r.kind == PKeyPurchaseResult.KIND_REFUSED and r.code == PKeyErrors.NOT_FOUND)
	apple.result = "success"
	plan["/distribution/commerce/claim"] = _json(403, {"error": {"code": "forbidden"}, "reason": "bound_elsewhere"})
	r = await sdk.commerce.purchase("extras.diceSkins")
	t.check("purchase: a refused claim keeps code and reason, and is not finished", r.kind == PKeyPurchaseResult.KIND_REFUSED and r.code == &"forbidden" and r.reason == "bound_elsewhere" and apple.finished.size() == 1, str(r))
	plan["/distribution/commerce/claim"] = _json(403, {"error": {"code": "forbidden"}, "reason": "not_owned"})
	r = await sdk.commerce.purchase("extras.diceSkins")
	t.check("purchase: not_owned reads as not-owned", r.kind == PKeyPurchaseResult.KIND_NOT_OWNED)
	plan["/distribution/commerce/claim"] = _claim_ok
	syncs[0] = 0
	r = await sdk.commerce.restore()
	t.check("restore: nothing owned -> not-owned, no sync", r.kind == PKeyPurchaseResult.KIND_NOT_OWNED and syncs[0] == 0)
	apple.owned = [{"id": "1", "jws": "a.b.c", "revoked": false}, {"id": "2", "jws": "d.e.f", "revoked": true}, {"id": "3", "jws": "g.h.i"}]
	server.requests.clear()
	r = await sdk.commerce.restore()
	t.check("restore: every unrevoked entitlement is claimed, then one sync", r.ok and r.flags == ["extras.diceSkins"] and _claims().size() == 2 and syncs[0] == 1, "%s claims=%d" % [r, _claims().size()])
	sdk.queue_free()


func _steam(t: PKeyTestContext) -> void:
	plan = {"/distribution/commerce/binding": _json(200, {"bindingId": BINDING, "products": PRODUCTS}), "/distribution/commerce/claim": _claim_ok}
	var sdk = await _sdk("steam")
	var steam := Steam.new()
	sdk.commerce.steam = steam
	var syncs := [0]
	sdk.commerce.on_claimed = func() -> void: syncs[0] += 1
	server.requests.clear()
	var r: PKeyPurchaseResult = await sdk.commerce.purchase("extras.diceSkins")
	var c: Array = _claims()
	var body = JSON.parse_string((c[0]["body"] as PackedByteArray).get_string_from_utf8()) if not c.is_empty() else {}
	t.check("purchase: Steam opens the DLC's store page, then claims it once owned", r.ok and steam.overlays == [1234560] and c.size() == 1 and syncs[0] == 1, "%s %s" % [r, steam.overlays])
	t.check("claim_steam: the ticket is bound to the binding and sent as hex", steam.identities == [BINDING] and body.get("ticket") == "dead01" and body.get("dlcAppId") == "1234560", str(body))
	steam.subscribed.clear()
	steam.buy_on_overlay = false
	r = await sdk.commerce.purchase("extras.diceSkins")
	t.check("purchase: closing Steam's overlay without buying is cancelled", r.kind == PKeyPurchaseResult.KIND_CANCELLED)
	steam.subscribed[1234560] = true
	server.requests.clear()
	r = await sdk.commerce.restore()
	t.check("restore: owned Steam DLC is claimed", r.ok and _claims().size() == 1)
	r = await sdk.commerce.claim_steam(1234560)
	t.check("claim_steam: the helper claims and syncs", r.ok and r.store == "steam")
	sdk.commerce.steam = Object.new()
	var t2: PKeyResult = await PKeyCommerce.steam_ticket(sdk.commerce.steam, BINDING)
	t.check("claim_steam: a GodotSteam without the Web API ticket call is unsupported/dependency", not t2.ok and t2.code == PKeyErrors.UNSUPPORTED and t2.detail["reason"] == "dependency")
	sdk.queue_free()


func _play_and_outlets(t: PKeyTestContext) -> void:
	plan = {"/distribution/commerce/binding": _json(200, {"bindingId": BINDING, "products": PRODUCTS}), "/distribution/commerce/claim": _claim_ok}
	var play = await _sdk("play")
	var r: PKeyPurchaseResult = await play.commerce.purchase("extras.ost")
	t.check("purchase: Play is unsupported/dependency until the billing helper ships", r.kind == PKeyPurchaseResult.KIND_UNSUPPORTED and r.detail["reason"] == "dependency", str(r))
	server.requests.clear()
	r = await play.commerce.claim_play("soundtrack", "tok.en")
	var c: Array = _claims()
	t.check("claim_play: claims the token and returns ok", r.ok and r.flags == ["extras.ost"] and c.size() == 1)
	play.queue_free()
	var direct = await _sdk("direct")
	r = await direct.commerce.purchase("extras.diceSkins")
	t.check("purchase: a direct build is unsupported/outlet", r.kind == PKeyPurchaseResult.KIND_UNSUPPORTED and r.detail["reason"] == "outlet" and direct.commerce.current_store() == "")
	direct.queue_free()
	var bare := PKeyCommerce.new()
	bare.store_override = "steam"
	r = await bare.purchase("x")
	t.check("purchase: before configure() -> not-configured", r.code == PKeyErrors.NOT_CONFIGURED)
