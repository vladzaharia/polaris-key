class_name PKeyCommerce
extends RefCounted
## `PolarisKey.commerce` (P6-01): store purchases become licence flags. The store sells; the
## Worker verifies the purchase with the store and puts the mapped flag on the player's licence,
## for every release of the deliverable, until a refund or revocation. The device only forwards
## what its store handed it.
##
##   get_binding()                 `GET /<p>/distribution/commerce/binding` -> PKeyResult, detail
##                                 {bindingId, products: [{store, productId, flag, deliverable}]}.
##                                 Call it BEFORE buying and hand `bindingId` to the store:
##                                   App Store   purchase(product, bindingId)   (PKeyApple, P5-05:
##                                               the appAccountToken)
##                                   Play        BillingFlowParams obfuscatedAccountId = bindingId
##                                               (godot-google-play-billing)
##                                   Steam       Steam.getAuthTicketForWebApi(bindingId) (GodotSteam)
##   claim(store, payload)         `POST /<p>/distribution/commerce/claim` -> PKeyResult, detail
##                                 {store, productId, flag, deliverable, state, granted, changed}:
##                                   claim("app-store", {signedTransaction = jws})
##                                   claim("play", {productId = sku, purchaseToken = token})
##                                   claim("steam", {ticket = hex, dlcAppId = "1234560"})
##                                 Then sync() to receive the licence document with the flag. On
##                                 the App Store, finish() the transaction only after a claim
##                                 answered ok (P5-05).
##   claim_app_store(tx, apple)    claim a StoreKit transaction from PKeyApple.purchase()
##                                 (`tx` = detail.transaction: {id, jws}) and finish() it ONLY
##                                 when the claim answered ok (P5-05: finish after the server
##                                 recorded it). detail = the claim's, plus `finished`. A refused
##                                 or failed claim leaves the transaction unfinished, so StoreKit
##                                 redelivers it and a later claim can retry
##   purchase(flag)                the one call (SDK parity §3.9): binding -> the store's purchase
##                                 with the binding token -> claim -> finish only after a
##                                 successful claim -> sync. A PKeyPurchaseResult. App Store on
##                                 iOS through PKeyApple; Steam through GodotSteam (the overlay's
##                                 store page, then a claim of the DLC once Steam says it is
##                                 owned); Play answers unsupported/dependency until the Play
##                                 Billing helper ships (claim_play() takes a purchase token from
##                                 your own billing plugin meanwhile)
##   (App Store updates)           on an App Store outlet, attach() connects the facade's
##                                 transaction_updated (StoreKit Transaction.updates: Ask to Buy
##                                 approved, a slow payment cleared, another device's purchase)
##                                 to claim_app_store() and then on_claimed, once per transaction
##                                 id; `app_store_update_claimed(result)` reports each outcome. A
##                                 revoked (refunded) transaction is not claimed. A failed claim
##                                 leaves the transaction unfinished for StoreKit to redeliver
##   restore()                     re-claim what the store says this account owns (App Store
##                                 current entitlements, Steam-owned DLC), then sync
##   claim_play(sku, token)        claim a Play purchase token, then sync
##   claim_steam(dlc_app_id)       a Web API ticket from GodotSteam bound to the binding, then the
##                                 claim, then sync
##   hidden_here(flag)             true when this build's outlet must not unlock `flag` although
##                                 the licence holds it (App Store 3.1.3(b), below)
##   is_unlocked(flag)             the licence holds `flag` and the outlet does not hide it
##
## Refusals keep the server's code and `reason` (detail.error.reason): `not_entitled` +
## `no_license` (enrol first — the bridge never creates a licence; `license.enroll()`),
## `forbidden` + `binding_mismatch` / `bound_elsewhere` / `unbound` / `not_owned`, `bad_request`
## + a store reason (`untrusted_chain`, `environment`, `wrong_app`, `test_purchase`,
## `invalid_ticket`, …), `unavailable` (the store could not be reached: retry later),
## `not_found` (commerce is not set up for this store). Nothing is retried automatically.
##
## **The licence document stays outlet-agnostic.** A flag bought on Play or Steam rides every
## licence document; App Store 3.1.3(b) lets it unlock on an Apple outlet only if the same flag is
## also sold there as an in-app purchase. `hidden_here()` applies that rule on outlets whose
## commerce capability is `store-iap` and whose store is the App Store (`app-store`,
## `testflight`), from the product list the last get_binding() returned. With no list yet it hides
## nothing it cannot judge — call get_binding() at startup.
##
## Both calls need License and Distribution (`service-unavailable` without either) and a device
## token (`no-token`). Usable before configure() (every call then refuses).

## The outlet kinds whose purchases go through the App Store's in-app purchase.
const APPLE_OUTLETS := ["app-store", "testflight"]
## The outlet kinds whose purchases go through Google Play Billing.
const PLAY_OUTLETS := ["play", "play-testing"]
## The outlet kinds whose purchases go through Steam.
const STEAM_OUTLETS := ["steam"]
## GodotSteam's singleton.
const STEAM_SINGLETON := "Steam"
## How long a Steam Web API ticket may take to arrive.
const STEAM_TICKET_TIMEOUT := 10.0
## How long purchase() waits for the player to close Steam's store overlay.
const STEAM_OVERLAY_TIMEOUT := 900.0

## A StoreKit transaction that arrived through transaction_updated (not through purchase()) was
## claimed, or the claim failed: a PKeyPurchaseResult with store "app-store".
signal app_store_update_claimed(result: PKeyPurchaseResult)

## Awaited after a claim answered ok (purchase, restore, claim_play, claim_steam): the autoload's
## forced sync, so the result returns with the flag on the licence. Empty: no sync.
var on_claimed: Callable = Callable()
## The App Store facade (null: PKeyApple.shared()). Tests set it; setting it while the
## transaction_updated listener is connected moves the listener to the new facade.
var apple: Object = null:
	set(v):
		var was := _watched_apple != null
		_unwatch_app_store()
		apple = v
		if was:
			watch_app_store_updates()
## The GodotSteam object (null: the `Steam` singleton when the build has it). Tests set it.
var steam: Object = null
## The store purchase() and restore() use ("" : the outlet's). Tests and custom hosts set it.
var store_override := ""

var _core_ref: WeakRef = null
var _license_ref: WeakRef = null
## The product list from the last successful get_binding().
var products: Array = []
## The binding from the last successful get_binding() ("" until then).
var binding_id := ""
## The facade whose transaction_updated is connected (null: none).
var _watched_apple: Object = null
## Transaction ids from transaction_updated being claimed or already claimed (id -> true).
var _update_ids := {}


func attach(core: PKeyCore, license: Object = null) -> void:
	_core_ref = weakref(core)
	_license_ref = weakref(license) if license != null else null
	if current_store() == "app-store":
		watch_app_store_updates()


## Connect the App Store facade's transaction_updated to claim_app_store() (idempotent; attach()
## does it on an App Store outlet). false when the facade has no such signal.
func watch_app_store_updates() -> bool:
	var a := _apple()
	if a == null or not a.has_signal("transaction_updated"):
		return false
	if _watched_apple == a:
		return true
	_unwatch_app_store()
	a.connect("transaction_updated", _on_app_store_update)
	_watched_apple = a
	return true


func _unwatch_app_store() -> void:
	if _watched_apple != null and is_instance_valid(_watched_apple) and _watched_apple.is_connected("transaction_updated", _on_app_store_update):
		_watched_apple.disconnect("transaction_updated", _on_app_store_update)
	_watched_apple = null


func _on_app_store_update(jws: String, transaction: Dictionary) -> void:
	var id := str(transaction.get("id", ""))
	if jws == "" or id == "" or transaction.get("revoked") == true or _update_ids.has(id):
		return
	_update_ids[id] = true
	var r := await claim_app_store({"id": id, "jws": jws}, _apple())
	if not r.ok:
		_update_ids.erase(id)
	app_store_update_claimed.emit(await _claimed(r, "app-store"))


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


func _refused(core: PKeyCore) -> PKeyResult:
	for slug in ["license", "distribution"]:
		var off = core.require_service(slug, PKeyConstants.Feature.COMMERCE_RECEIPT)
		if off != null:
			return off
	return null


## The licence's purchase binding and the store products on sale. A coroutine.
func get_binding() -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var off := _refused(core)
	if off != null:
		return off
	var r := await core.request("GET", "distribution/commerce/binding", null, true)
	if not r.ok:
		return r
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "commerce/binding answered a body that is not a JSON object.", r.detail)
	var body: Dictionary = parsed["value"]
	var id = body.get("bindingId")
	if not (id is String) or not _is_uuid(id):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "commerce/binding answered no binding UUID.", r.detail)
	var list: Array = []
	if body.get("products") is Array:
		for p in body["products"]:
			if p is Dictionary and p.get("store") is String and p.get("productId") is String and p.get("flag") is String:
				list.append({"store": p["store"], "productId": p["productId"], "flag": p["flag"], "deliverable": String(p.get("deliverable", "app"))})
	binding_id = String(id).to_lower()
	products = list
	return PKeyResult.success({"bindingId": binding_id, "products": list.duplicate(true)})


## Claim one store purchase. `store`: "app-store", "play" or "steam"; `payload` as in the header.
## A coroutine.
func claim(store: String, payload: Dictionary) -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var off := _refused(core)
	if off != null:
		return off
	var body := {"store": store}
	match store:
		"app-store":
			if not (payload.get("signedTransaction") is String):
				return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "An App Store claim needs signedTransaction (the StoreKit JWS).")
			body["signedTransaction"] = payload["signedTransaction"]
		"play":
			if not (payload.get("productId") is String) or not (payload.get("purchaseToken") is String):
				return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "A Play claim needs productId and purchaseToken.")
			body["productId"] = payload["productId"]
			body["purchaseToken"] = payload["purchaseToken"]
		"steam":
			if not (payload.get("ticket") is String) or not (payload.get("dlcAppId") is String or payload.get("dlcAppId") is int):
				return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "A Steam claim needs ticket (hex) and dlcAppId.")
			body["ticket"] = payload["ticket"]
			body["dlcAppId"] = str(payload["dlcAppId"])
		_:
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "store must be app-store, play or steam.")
	var r := await core.request("POST", "distribution/commerce/claim", body, true)
	if not r.ok:
		return r
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	if not parsed["ok"] or not (parsed["value"] is Dictionary) or not PKeyClaims.is_true(parsed["value"].get("ok")):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "commerce/claim answered a body that is not a claim.", r.detail)
	return PKeyResult.success(parsed["value"])


## Claim a StoreKit transaction and finish it only after the claim succeeded. `tx` is the
## `transaction` dictionary PKeyApple.purchase() (or transaction_updated) carries: {id, jws}.
## `apple` is anything with a coroutine `finish(id) -> PKeyResult` (default PKeyApple.shared()).
## A coroutine.
func claim_app_store(tx: Dictionary, apple: Object = null) -> PKeyResult:
	if not (tx.get("jws") is String) or not (tx.get("id") is String) or String(tx["id"]) == "":
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "claim_app_store needs the transaction's id and jws.")
	var r := await claim("app-store", {"signedTransaction": tx["jws"]})
	if not r.ok:
		return r
	var store = apple if apple != null else PKeyApple.shared()
	var f: PKeyResult = await store.finish(String(tx["id"]))
	var detail: Dictionary = (r.detail as Dictionary).duplicate()
	detail["finished"] = f.ok
	if not f.ok:
		detail["finishError"] = String(f.code)
	return PKeyResult.success(detail)


# ── One-call purchase and restore (SDK parity §3.9, SP-G09) ──────────────────────────────

## The store this build sells through: "app-store", "play", "steam", or "" (not a store build).
func current_store() -> String:
	if store_override != "":
		return store_override
	var core := _core()
	if core == null:
		return ""
	var kind := String(core.update_outlet().get("kind", ""))
	if APPLE_OUTLETS.has(kind):
		return "app-store"
	if PLAY_OUTLETS.has(kind):
		return "play"
	if STEAM_OUTLETS.has(kind):
		return "steam"
	return ""


## The store product that sells `flag` in `store`, from the binding's product list, or {}.
static func product_for(list: Array, store: String, flag: String) -> Dictionary:
	for p in list:
		if p is Dictionary and p.get("store") == store and p.get("flag") == flag:
			return p
	return {}


## Buy `flag` in this build's store and claim it. A coroutine returning a PKeyPurchaseResult.
func purchase(flag: String) -> PKeyPurchaseResult:
	var store := current_store()
	var gate := _store_gate(store)
	if gate != null:
		return gate
	var b := await get_binding()
	if not b.ok:
		return PKeyPurchaseResult.from_failure(b, store)
	var p := product_for(products, store, flag)
	if p.is_empty():
		return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_REFUSED, store, PKeyErrors.NOT_FOUND, "No %s product sells the flag '%s' (check the product's store mappings)." % [store, flag])
	match store:
		"app-store":
			return await _purchase_app_store(p)
		"steam":
			return await _purchase_steam(p)
	return _unsupported_store(store)


## Re-claim what this account owns in this build's store. ok when at least one purchase was
## claimed (`flags`), not-owned when the store reports none. A coroutine.
func restore() -> PKeyPurchaseResult:
	var store := current_store()
	var gate := _store_gate(store)
	if gate != null:
		return gate
	var b := await get_binding()
	if not b.ok:
		return PKeyPurchaseResult.from_failure(b, store)
	match store:
		"app-store":
			return await _restore_app_store()
		"steam":
			return await _restore_steam()
	return _unsupported_store(store)


## Claim a Play purchase (from your billing plugin: the SKU and its purchase token), then sync.
## A coroutine.
func claim_play(product_id: String, purchase_token: String) -> PKeyPurchaseResult:
	var r := await claim("play", {"productId": product_id, "purchaseToken": purchase_token})
	return await _claimed(r, "play")


## Claim a Steam DLC: ask GodotSteam for a Web API ticket bound to the licence's binding
## (`getAuthTicketForWebApi(bindingId)`), then claim it, then sync. A coroutine.
func claim_steam(dlc_app_id: Variant) -> PKeyPurchaseResult:
	var s := _steam()
	if s == null:
		return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_UNSUPPORTED, "steam", PKeyErrors.UNSUPPORTED, "GodotSteam is not in this build.", {"feature": PKeyConstants.Feature.COMMERCE_RECEIPT, "reason": PKeyConstants.UnsupportedReason.DEPENDENCY, "detail": "GodotSteam is not in this build."})
	if binding_id == "":
		var b := await get_binding()
		if not b.ok:
			return PKeyPurchaseResult.from_failure(b, "steam")
	var t := await steam_ticket(s, binding_id)
	if not t.ok:
		return PKeyPurchaseResult.from_failure(t, "steam")
	var r := await claim("steam", {"ticket": t.detail["ticket"], "dlcAppId": str(dlc_app_id)})
	return await _claimed(r, "steam")


## A Steam Web API ticket for `identity` as hex: detail {ticket}. GodotSteam's
## getAuthTicketForWebApi answers through its `get_ticket_for_web_api(handle, result, size,
## buffer)` signal; anything but result 1 (k_EResultOK) or no answer in time is a platform-error.
## A coroutine.
static func steam_ticket(s: Object, identity: String) -> PKeyResult:
	if s == null or not s.has_method("getAuthTicketForWebApi") or not s.has_signal("get_ticket_for_web_api"):
		return PKeyResult.unsupported(PKeyConstants.Feature.COMMERCE_RECEIPT, PKeyConstants.UnsupportedReason.DEPENDENCY, "This GodotSteam has no getAuthTicketForWebApi (GodotSteam 4.6 or later).")
	var box := {"done": false, "ticket": "", "result": 0}
	var handle := [-1]
	var on_ticket := func(h: int, result: int, _size: int, buffer: Variant) -> void:
		if box["done"] or (handle[0] != -1 and h != handle[0]):
			return
		box["done"] = true
		box["result"] = result
		var bytes := PackedByteArray(buffer) if (buffer is Array or buffer is PackedByteArray) else PackedByteArray()
		box["ticket"] = bytes.hex_encode()
	s.connect("get_ticket_for_web_api", on_ticket)
	handle[0] = int(s.getAuthTicketForWebApi(identity))
	var tree := Engine.get_main_loop() as SceneTree
	var deadline := Time.get_ticks_msec() + int(STEAM_TICKET_TIMEOUT * 1000.0)
	while not box["done"] and Time.get_ticks_msec() < deadline:
		if s.has_method("run_callbacks"):
			s.run_callbacks()
		await tree.process_frame
	if s.is_connected("get_ticket_for_web_api", on_ticket):
		s.disconnect("get_ticket_for_web_api", on_ticket)
	if not box["done"]:
		return PKeyResult.failure(PKeyErrors.TIMEOUT, "Steam did not answer the Web API ticket request in time.")
	if int(box["result"]) != 1 or box["ticket"] == "":
		return PKeyResult.failure(PKeyErrors.PLATFORM_ERROR, "Steam refused the Web API ticket (EResult %d)." % int(box["result"]), {"result": box["result"]})
	return PKeyResult.success({"ticket": box["ticket"]})


func _steam() -> Object:
	if steam != null:
		return steam
	return Engine.get_singleton(STEAM_SINGLETON) if Engine.has_singleton(STEAM_SINGLETON) else null


func _apple() -> Object:
	return apple if apple != null else PKeyApple.shared()


## null when `store` can be driven here, else the typed refusal.
func _store_gate(store: String) -> Variant:
	var core := _core()
	if core == null:
		return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_ERROR, store, PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var off := _refused(core)
	if off != null:
		return PKeyPurchaseResult.from_failure(off, store)
	match store:
		"app-store":
			var a = _apple()
			if a.has_method("availability"):
				var av: PKeyResult = a.availability(PKeyConstants.Feature.COMMERCE_RECEIPT)
				if not av.ok:
					return PKeyPurchaseResult.from_failure(av, store)
			return null
		"steam":
			if _steam() == null:
				return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_UNSUPPORTED, store, PKeyErrors.UNSUPPORTED, "GodotSteam is not in this build.", {"feature": PKeyConstants.Feature.COMMERCE_RECEIPT, "reason": PKeyConstants.UnsupportedReason.DEPENDENCY, "detail": "GodotSteam is not in this build."})
			return null
	return _unsupported_store(store)


func _unsupported_store(store: String) -> PKeyPurchaseResult:
	if store == "play":
		var why := "Play Billing is not driven by this addon yet: buy with your billing plugin (obfuscatedAccountId = commerce.binding_id), then claim_play(sku, token)."
		return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_UNSUPPORTED, store, PKeyErrors.UNSUPPORTED, why, {"feature": PKeyConstants.Feature.COMMERCE_RECEIPT, "reason": PKeyConstants.UnsupportedReason.DEPENDENCY, "detail": why})
	var msg := "This build is not sold through a store this addon can drive (outlet: %s)." % (store if store != "" else "not a store")
	return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_UNSUPPORTED, store, PKeyErrors.UNSUPPORTED, msg, {"feature": PKeyConstants.Feature.COMMERCE_RECEIPT, "reason": PKeyConstants.UnsupportedReason.OUTLET, "detail": msg})


## A claim's PKeyResult as a purchase result; a successful claim syncs first.
func _claimed(r: PKeyResult, store: String) -> PKeyPurchaseResult:
	if not r.ok:
		return PKeyPurchaseResult.from_failure(r, store)
	if on_claimed.is_valid():
		await on_claimed.call()
	var out := PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_OK, store, &"", "", r.detail)
	if r.detail is Dictionary and r.detail.get("flag") is String:
		out.flags = [r.detail["flag"]]
	return out


func _purchase_app_store(p: Dictionary) -> PKeyPurchaseResult:
	var a = _apple()
	var loaded: PKeyResult = await a.products(PackedStringArray([p["productId"]]))
	if not loaded.ok:
		return PKeyPurchaseResult.from_failure(loaded, "app-store")
	var bought: PKeyResult = await a.purchase(String(p["productId"]), binding_id)
	if not bought.ok:
		return PKeyPurchaseResult.from_failure(bought, "app-store")
	match String(bought.detail.get("result", "")):
		"userCancelled":
			return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_CANCELLED, "app-store")
		"pending":
			return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_PENDING, "app-store")
	var tx = bought.detail.get("transaction")
	if not (tx is Dictionary):
		return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_ERROR, "app-store", PKeyErrors.PLATFORM_ERROR, "StoreKit answered success without a transaction.", bought.detail)
	return await _claimed(await claim_app_store(tx, a), "app-store")


func _restore_app_store() -> PKeyPurchaseResult:
	var a = _apple()
	var ents: PKeyResult = await a.entitlements()
	if not ents.ok:
		return PKeyPurchaseResult.from_failure(ents, "app-store")
	var txs: Array = []
	var raw = ents.detail.get("entitlements", []) if ents.detail is Dictionary else []
	if raw is Array:
		for tx in raw:
			if tx is Dictionary and tx.get("jws") is String and tx.get("revoked") != true:
				txs.append(tx)
	return await _restore_each(txs, func(tx: Dictionary) -> PKeyResult: return await claim("app-store", {"signedTransaction": tx["jws"]}), "app-store")


func _purchase_steam(p: Dictionary) -> PKeyPurchaseResult:
	var s := _steam()
	var dlc := int(String(p["productId"]))
	if s.has_method("isSubscribedApp") and s.isSubscribedApp(dlc):
		return await claim_steam(dlc)
	if not s.has_method("activateGameOverlayToStore"):
		return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_UNSUPPORTED, "steam", PKeyErrors.UNSUPPORTED, "This GodotSteam cannot open the store overlay.")
	var closed := {"done": false}
	var on_overlay := func(active: bool, _user := false, _app := 0) -> void:
		if not active:
			closed["done"] = true
	var watching: bool = s.has_signal("overlay_toggled")
	if watching:
		s.connect("overlay_toggled", on_overlay)
	s.activateGameOverlayToStore(dlc, 0)
	var tree := Engine.get_main_loop() as SceneTree
	var deadline := Time.get_ticks_msec() + int(STEAM_OVERLAY_TIMEOUT * 1000.0)
	while watching and not closed["done"] and Time.get_ticks_msec() < deadline:
		if s.has_method("run_callbacks"):
			s.run_callbacks()
		await tree.process_frame
	if watching and s.is_connected("overlay_toggled", on_overlay):
		s.disconnect("overlay_toggled", on_overlay)
	if s.has_method("isSubscribedApp") and not s.isSubscribedApp(dlc):
		return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_CANCELLED, "steam")
	return await claim_steam(dlc)


func _restore_steam() -> PKeyPurchaseResult:
	var s := _steam()
	var owned: Array = []
	for p in products:
		if p is Dictionary and p.get("store") == "steam" and String(p.get("productId", "")).is_valid_int():
			var dlc := int(String(p["productId"]))
			if not s.has_method("isSubscribedApp") or s.isSubscribedApp(dlc):
				owned.append(dlc)
	return await _restore_each(owned, func(dlc: int) -> PKeyResult:
		var t := await steam_ticket(s, binding_id)
		if not t.ok:
			return t
		return await claim("steam", {"ticket": t.detail["ticket"], "dlcAppId": str(dlc)}), "steam")


## Claim each item; ok when any claimed (then one sync), not-owned when there was nothing, else
## the first failure.
func _restore_each(items: Array, claim_one: Callable, store: String) -> PKeyPurchaseResult:
	if items.is_empty():
		return PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_NOT_OWNED, store, &"", "The store reports no purchases to restore.")
	var flags: Array = []
	var first_failure: PKeyResult = null
	for item in items:
		var r: PKeyResult = await claim_one.call(item)
		if r.ok:
			if r.detail is Dictionary and r.detail.get("flag") is String and not flags.has(r.detail["flag"]):
				flags.append(r.detail["flag"])
		elif first_failure == null:
			first_failure = r
	if flags.is_empty():
		return PKeyPurchaseResult.from_failure(first_failure, store) if first_failure != null else PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_NOT_OWNED, store)
	if on_claimed.is_valid():
		await on_claimed.call()
	var out := PKeyPurchaseResult.of(PKeyPurchaseResult.KIND_OK, store, &"", "", {"flags": flags, "failed": first_failure != null})
	out.flags = flags
	return out


## Whether this build's outlet hides `flag` (App Store 3.1.3(b); see the header).
func hidden_here(flag: String) -> bool:
	var core := _core()
	if core == null:
		return false
	var kind := String(core.update_outlet().get("kind", ""))
	if not APPLE_OUTLETS.has(kind):
		return false
	var caps: Dictionary = PKeyDecision.CAPABILITY_DEFAULTS.get(kind, {})
	if String(caps.get("commerce", "")) != "store-iap":
		return false
	return hidden_on(flag, products)


## The rule itself, for a given product list: a flag that is sold somewhere but not as an App
## Store product is hidden on an Apple outlet. A flag sold nowhere (an operator's grant) is not.
static func hidden_on(flag: String, list: Array) -> bool:
	var sold := false
	for p in list:
		if p is Dictionary and p.get("flag") == flag:
			if p.get("store") == "app-store":
				return false
			sold = true
	return sold


## The licence holds `flag` and this outlet does not hide it.
func is_unlocked(flag: String) -> bool:
	var license = _license_ref.get_ref() if _license_ref != null else null
	if license == null or not license.has_method("is_entitled"):
		return false
	return license.is_entitled(flag) and not hidden_here(flag)


static func _is_uuid(s: String) -> bool:
	var re := RegEx.create_from_string("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")
	return re.search(s) != null
