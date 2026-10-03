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

var _core_ref: WeakRef = null
var _license_ref: WeakRef = null
## The product list from the last successful get_binding().
var products: Array = []
## The binding from the last successful get_binding() ("" until then).
var binding_id := ""


func attach(core: PKeyCore, license: Object = null) -> void:
	_core_ref = weakref(core)
	_license_ref = weakref(license) if license != null else null


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
