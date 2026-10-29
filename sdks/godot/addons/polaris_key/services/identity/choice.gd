class_name PKeyIdentityChoice
extends RefCounted
## `PolarisKey.identity.choice` (identity.choice; WIRE-CONTRACT-V4 §12.5.1): the licence choice an
## app shows itself after `sign_in.start({channel = "redirect", license_choice = "app"})` settled
## `license_choice` (see PKeySignInOutcome). The port of sdk-node `identity/choice.ts`.
##
##   licenses(grant)            the licences the account can run this device on (a view)
##   devices(grant, license_id) a full licence's seated devices, for Replace (a view)
##   complete(grant, choice)    the person's choice: {kind = "license", license_id, replace_device_id?},
##                              {kind = "keep"}, {kind = "create"} or {kind = "key", key}; the device
##                              token is stored like a sign-in
##   cancel(grant)              give the grant up; no token, nothing stored
##
## Each is a coroutine answering a PKeyChoiceResult. A call dials the endpoint discovery names
## (never one it builds, and only on the product's own origin), and fails `service-unavailable`
## before any request when discovery names none (the session then ran in card mode and never
## issued a grant). No device bearer is sent: the grant in the body is the credential, and it is
## never printed or put in an error. A refusal the Worker answers is a result (`kind == refused`);
## a network failure or a 5xx is `failed`, the grant still spendable. Only an `ok` completion
## changes state.
##
## Not instantiated by a game: PKeyIdentity owns one.

const ENDPOINTS := ["choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel"]

var _identity_ref: WeakRef = null


func _init(identity: PKeyIdentity) -> void:
	_identity_ref = weakref(identity)


func _identity() -> PKeyIdentity:
	return _identity_ref.get_ref() as PKeyIdentity if _identity_ref != null else null


## True when discovery names all four choice endpoints (so `license_choice=app` is honoured).
static func available(fragment: Dictionary) -> bool:
	var endpoints = fragment.get("endpoints")
	if not (endpoints is Dictionary):
		return false
	for name in ENDPOINTS:
		if not (endpoints.get(name) is String) or endpoints[name] == "":
			return false
	return true


## The licences the account can run this device on. Counts against the grant's read budget.
func licenses(grant: String) -> PKeyChoiceResult:
	var sent := await _post("choiceLicenses", {"grant": grant}, "choice licenses")
	if sent is PKeyChoiceResult:
		return sent
	var view = sent["body"]
	if not (view is Dictionary) or not (view.get("state") is String) or not (view.get("choices") is Array):
		return PKeyChoiceResult.failed(PKeyErrors.INVALID_RESPONSE, "choice licenses answered without a readable view.")
	var r := PKeyChoiceResult.made_ok()
	r.view = view
	return r


## The devices seated on a full licence, for Replace. A licence outside the grant's view is
## `refused` with `not_found`.
func devices(grant: String, license_id: String) -> PKeyChoiceResult:
	var sent := await _post("choiceDevices", {"grant": grant, "licenseId": license_id}, "choice devices")
	if sent is PKeyChoiceResult:
		return sent
	var view = sent["body"]
	if not (view is Dictionary) or not (view.get("licenseId") is String) or not (view.get("devices") is Array):
		return PKeyChoiceResult.failed(PKeyErrors.INVALID_RESPONSE, "choice devices answered without a readable view.")
	var r := PKeyChoiceResult.made_ok()
	r.view = view
	return r


## Finish with the person's choice (see the class doc for the shapes). On `ok` the device token is
## stored, the subject kept, the forced sync runs (as after a sign-in) and `license_id`, `subject`,
## `scope` (and `key_entries` after a key, `attachable` after a keep) say what was signed in. The
## grant is spent on `ok`; a refusal the person can fix (`device_limit`, `license_choice_required`,
## a wrong key) leaves it open and carries the fresh `view`.
func complete(grant: String, choice: Variant) -> PKeyChoiceResult:
	var wire = _choice_wire(choice)
	if wire is String:
		return PKeyChoiceResult.failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, wire)
	return await _complete(grant, wire)


## Conformance replay only: a completion sending exactly `choice` (a wire `choice` member, or null
## for none: the Worker's 409 `license_choice_required`).
func _complete(grant: String, choice: Variant) -> PKeyChoiceResult:
	var body := {"grant": grant}
	if choice is Dictionary:
		body["choice"] = choice
	# `keep` is proven by the device's own token (the Worker reads it as held); every other choice
	# is made on the grant alone.
	var held := ""
	if choice is Dictionary and choice.get("kind") == "keep":
		var core_now := _identity()._core() if _identity() != null else null
		held = core_now.tokens.current() if core_now != null else ""
	var sent := await _post("choiceComplete", body, "choice complete", held)
	if sent is PKeyChoiceResult:
		return sent
	var answer := PKeyIdentityRedirect.parse_token_answer(200, sent["body"])
	if answer["kind"] != "token":
		return PKeyChoiceResult.failed(PKeyErrors.INVALID_RESPONSE, "choice complete answered without a complete sign-in.")
	var identity := _identity()
	var core := identity._core()
	var stored := core.tokens.set_token(answer["access_token"], PKeyTokenManager.SOURCE_SIGNIN)
	if identity._account != null:
		identity._account.note_signed_in(answer["subject"])
	var r := PKeyChoiceResult.made_ok()
	r.stored = stored
	r.subject = answer["subject"]
	r.scope = answer["scope"]
	var lic = answer["license"]
	r.license_id = lic["id"] if lic is Dictionary and lic.get("id") is String else ""
	var entries = sent["body"].get("keyEntries")
	if entries is Dictionary and PKeyClaims.is_number(entries.get("used")) and PKeyClaims.is_number(entries.get("limit")):
		r.key_entries = {"used": int(entries["used"]), "limit": int(entries["limit"])}
	r.attachable = choice is Dictionary and choice.get("kind") == "keep"
	if identity.redirect_acquisition_sync and identity.on_acquired.is_valid():
		var synced: PKeySyncResult = await identity.on_acquired.call()
		var problem := PKeyLicense.unverified(core, synced, "the sign-in succeeded")
		if not problem.is_empty():
			return PKeyChoiceResult.failed(problem["code"], problem["message"])
	return r


## Give the grant up (`204`). Nothing is stored; the sign-in is over.
func cancel(grant: String) -> PKeyChoiceResult:
	var sent := await _post("choiceCancel", {"grant": grant}, "choice cancel")
	if sent is PKeyChoiceResult:
		return sent
	return PKeyChoiceResult.made_ok(sent["status"])


## The primitives the sign-in form (`ui/model/sign_in_session.gd`) drives, in its vocabulary:
##   licenses: func(grant) -> Dictionary or null      the licence view
##   devices:  func(grant, license_id) -> Dictionary or null   the Replace view
##   complete: func(grant, choice) -> Dictionary      {outcome: "signedIn", issuedNow} on ok,
##                                                    {outcome: "expired"} for a lapsed grant,
##                                                    else {outcome: "raced", view?}
##   cancel:   func(grant) -> void
## `choice` there is the form's own `{kind, licenseId?, replaceDeviceId?, key?}`.
func primitives() -> Dictionary:
	return {"licenses": _form_licenses, "devices": _form_devices, "complete": _form_complete, "cancel": _form_cancel}


func _form_licenses(grant: Variant) -> Variant:
	var r := await licenses(String(grant))
	return r.view if r.ok else null


func _form_devices(grant: Variant, license_id: Variant) -> Variant:
	var r := await devices(String(grant), String(license_id))
	return r.view if r.ok else null


func _form_complete(grant: Variant, choice: Variant) -> Variant:
	var r := await complete(String(grant), choice)
	if r.ok:
		return {"outcome": "signedIn", "issuedNow": choice is Dictionary and choice.get("kind") in ["create", "key"]}
	if r.code == &"invalid_grant":
		return {"outcome": "expired"}
	var raced := {"outcome": "raced"}
	if not r.view.is_empty():
		raced["view"] = r.view
	return raced


func _form_cancel(grant: Variant) -> void:
	await cancel(String(grant))


## The wire `choice` member for `choice` (either spelling of the keys), or an error String.
static func _choice_wire(choice: Variant) -> Variant:
	if not (choice is Dictionary):
		return "choice must be a Dictionary with a kind."
	match choice.get("kind"):
		"keep", "create":
			return {"kind": choice["kind"]}
		"license":
			var id = choice.get("license_id", choice.get("licenseId"))
			if not (id is String) or id == "":
				return "a license choice needs license_id."
			var wire := {"kind": "license", "licenseId": id}
			var replace = choice.get("replace_device_id", choice.get("replaceDeviceId"))
			if replace is String and replace != "":
				wire["replaceDeviceId"] = replace
			return wire
		"key":
			if not (choice.get("key") is String) or choice["key"] == "":
				return "a key choice needs the key."
			return {"kind": "key", "key": choice["key"]}
	return "choice.kind is license, keep, create or key."


## POST `name`'s discovery endpoint with `body` (JSON, no bearer but `bearer` when given: `keep`'s
## device token). A PKeyChoiceResult when the call
## ended (unavailable, transport failure, 5xx, a refusal); else {status, body} of a 2xx.
func _post(name: String, body: Dictionary, what: String, bearer: String = "") -> Variant:
	var identity := _identity()
	var core := identity._core() if identity != null else null
	if core == null or not core.started:
		return PKeyChoiceResult.failed(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if core.discovery_manifest == null:
		await core.discover()
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var url: String = fragment.get("endpoints", {}).get(name, "") if fragment.get("endpoints") is Dictionary else ""
	if not core.enabled("identity") or url == "":
		return PKeyChoiceResult.failed(
			PKeyErrors.SERVICE_UNAVAILABLE,
			"The identity %s endpoint is not served for %s." % [name, core.product],
			PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_CHOICE, "identity"))
	if not identity._own(url):
		return PKeyChoiceResult.failed(PKeyErrors.INVALID_RESPONSE, "The %s endpoint points outside this product." % name)
	var extra := {"Content-Type": "application/json"}
	if bearer != "":
		extra["Authorization"] = "Bearer " + bearer
	var h := core.headers(extra)
	var r := await core.transport.request("POST", url, h, PKeyJson.stringify(body).to_utf8_buffer())
	if not r.ok:
		return PKeyChoiceResult.failed(r.code if r.code == PKeyErrors.LOCAL_ONLY else PKeyErrors.NETWORK, r.message)
	var status: int = r.detail["status"]
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var answer = parsed["value"] if parsed["ok"] else null
	if status >= 500:
		return PKeyChoiceResult.failed(PKeyErrors.SERVER_ERROR, "%s failed with status %d." % [what, status], {"status": status})
	if status != 200 and not (name == "choiceCancel" and status == 204):
		return _refusal(status, r, answer)
	return {"status": status, "body": answer}


## A 4xx as its result: the wire code and only the members the answer carried.
static func _refusal(status: int, r: PKeyResult, body: Variant) -> PKeyChoiceResult:
	var b: Dictionary = body if body is Dictionary else {}
	var error = b.get("error")
	var code = error.get("code") if error is Dictionary else error
	var out := PKeyChoiceResult.refused(StringName(code if code is String and code != "" else "http_%d" % status), status)
	var retry = b.get("retryAfter")
	if PKeyClaims.is_number(retry) and not is_nan(float(retry)) and not is_inf(float(retry)) and float(retry) > 0.0:
		out.retry_after_seconds = int(ceil(float(retry)))
	else:
		var header = r.detail["headers"].get("retry-after") if r.detail["headers"] is Dictionary else null
		if header is String and (header as String).strip_edges().is_valid_int() and int((header as String).strip_edges()) > 0:
			out.retry_after_seconds = int((header as String).strip_edges())
	var view = b.get("view")
	if view is Dictionary and view.get("state") is String and view.get("choices") is Array:
		out.view = view
	if b.get("manageUrl") is String:
		out.manage_url = b["manageUrl"]
	if b.get("signInUrl") is String:
		out.sign_in_url = b["signInUrl"]
	var entries = b.get("keyEntries")
	if entries is Dictionary and PKeyClaims.is_number(entries.get("used")) and PKeyClaims.is_number(entries.get("limit")):
		out.key_entries = {"used": int(entries["used"]), "limit": int(entries["limit"])}
	return out
