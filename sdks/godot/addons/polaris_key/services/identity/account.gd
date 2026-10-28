class_name PKeyIdentityAccount
extends RefCounted
## The account on the device (identity.account, WIRE-CONTRACT-V4 §12.3 and §12.6): `subject()`,
## `sign_out()` and `open_account()`. Each is used only when discovery's identity fragment carries
## the endpoint (`account: true` with `subject`, `signout`, `accountPortal`), and the URL is the one
## the fragment published: this client never builds one. A product with Identity off, or a
## discovery that predates the account features, answers `service-unavailable` with
## `detail.kind == "unavailable"`: no request is sent. The credential only ever goes to the
## product's own origin (`PolarisKey` options' base URL).
##
##   subject()      GET  <subject>    the pairwise subject (`ps_...`) signed in on the device, kept
##                                    beside the token; null for a key-only device.
##   sign_out()     the pre-sign-out hooks run first (Cloud Sync registers its flush there, D-4),
##                  then POST <signout>, then the stored subject is forgotten. The token goes only
##                  when the server answers `released: true` (the sign-in had counted this device
##                  against a licence of the account); `released: false` keeps licence and token.
##   open_account() hands `accountPortal` to the opener (OS.shell_open, https only).
##   attach(confirm) POST <attach> {confirm}: false previews the device's own licence and writes
##                  nothing; true puts it in the signed-in account, rotates and stores the token.
##                  A Worker refusal (`account_required`, `license_owned`, `license_email_bound`,
##                  `unauthorized`, `not_found`, ...) is a failure whose `code` is the Worker's and
##                  whose detail is {kind: "refused", status}; it keeps token, cache and identity.
##
## Not instantiated by a game: PKeyIdentity owns one.

const KIND_SIGNED_IN := "signedIn"
const KIND_SIGNED_OUT := "signedOut"
const KIND_SUBJECT_CHANGED := "subjectChanged"

## `func(url: String) -> bool`, awaited by open_account(); true when it opened the page. Empty:
## the system browser (https only).
var opener: Callable = Callable()
## `func() -> void` (a coroutine allowed): fires after a released sign-out wiped the credential.
var on_wiped: Callable = Callable()
## `func(kind: String, subject: String, previous: String) -> void`: the account changed
## (`signedIn`, `signedOut` or `subjectChanged`; "" = none). PKeyIdentity turns it into the
## `identity` event.
var on_change: Callable = Callable()

var _core_ref: WeakRef = null
## Shared with PKeyIdentity.add_before_sign_out: `func() -> void` (or `-> PKeyResult`), each awaited in
## order. A hook that returns a failing PKeyResult stops the sign-out and that result is returned.
var _hooks: Array[Callable]


func _init(core: PKeyCore, hooks: Array[Callable]) -> void:
	_core_ref = weakref(core)
	_hooks = hooks


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## The identity fragment, discovering once when this session has not yet (a fragment is never
## guessed); {} when the product serves none.
func _fragment() -> Dictionary:
	var core := _core()
	if core == null or not core.started:
		return {}
	if core.discovery_manifest == null:
		await core.discover()
	return PKeyDiscovery.identity_from(core.discovery_manifest)


## True when `url` is an endpoint of the product's own origin: the bearer is never sent elsewhere.
func _own(url: String) -> bool:
	var core := _core()
	var u := PKeyTransport.parse_url(url)
	var base := PKeyTransport.parse_url(core.base_url)
	return not u.is_empty() and not base.is_empty() and u["origin"] == base["origin"]


static func _unavailable(what: String) -> PKeyResult:
	return PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "The product does not serve %s." % what, {"kind": "unavailable"})


func _send(method: String, url: String, body: Variant = null) -> PKeyResult:
	var core := _core()
	var h := core.headers({"Authorization": "Bearer %s" % core.tokens.current()})
	var bytes := PackedByteArray()
	if body is Dictionary:
		bytes = PKeyJson.stringify(body).to_utf8_buffer()
		h["Content-Type"] = "application/json"
	var r := await core.transport.request(method, url, h, bytes)
	if not r.ok:
		return PKeyResult.failure(r.code if r.code == PKeyErrors.LOCAL_ONLY else PKeyErrors.NETWORK, r.message)
	return r


static func _body(r: PKeyResult) -> Variant:
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	return parsed["value"] if parsed["ok"] and parsed["value"] is Dictionary else null


## A failed exchange as its result: the transport's own failure, a 5xx as `server-error`, any other
## non-200 as `refused` (the code the call's refusal takes); null when the answer is a 200.
static func _failed(r: PKeyResult, what: String, refused: StringName) -> PKeyResult:
	if not r.ok:
		return r
	var status: int = r.detail["status"]
	if status >= 500:
		return PKeyResult.failure(PKeyErrors.SERVER_ERROR, "%s failed with status %d." % [what, status], {"status": status})
	if status != 200:
		return PKeyResult.failure(refused, "%s was refused (status %d)." % [what, status], {"status": status})
	return null


## ok: detail {subject: String or null (a key-only device or no credential)}.
func subject() -> PKeyResult:
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	var fragment := await _fragment()
	var url: String = fragment.get("subject", "") if fragment.get("account") == true else ""
	if url == "" or not _own(url):
		return _unavailable("the account subject")
	if not core.tokens.has_token():
		return PKeyResult.success({"subject": null})
	var r := await _send("GET", url)
	var failed := _failed(r, "The subject read", PKeyErrors.INVALID_RESPONSE)
	if failed != null:
		return failed
	var body = _body(r)
	var value = body.get("subject") if body is Dictionary else 0
	if not (value == null and body.has("subject")) and not (value is String and value != ""):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "The subject read answered without a subject.")
	_store_subject(value if value is String else "")
	return PKeyResult.success({"subject": value})


## POST the sign-out: {released: bool}, or {failure: PKeyResult}.
func _post_signout(url: String) -> Dictionary:
	var r := await _send("POST", url)
	var failed := _failed(r, "Sign-out", PKeyConstants.ErrorCode.SIGN_OUT_FAILED)
	if failed != null:
		return {"failure": failed}
	var body = _body(r)
	if not (body is Dictionary) or not (body.get("released") is bool):
		return {"failure": PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "Sign-out answered without `released`.")}
	return {"released": body["released"]}


## ok: detail {released: bool}. A failed hook stops the sign-out (nothing is lost to it).
func sign_out() -> PKeyResult:
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	var fragment := await _fragment()
	var url: String = fragment.get("signout", "") if fragment.get("account") == true else ""
	if url == "" or not _own(url):
		return _unavailable("sign-out")
	for hook in _hooks.duplicate():
		var stopped: Variant = await hook.call()
		if stopped is PKeyResult and not stopped.ok:
			return stopped
	var previous := core.cache.subject
	var released := false
	if core.tokens.has_token():
		var sent := await _post_signout(url)
		if sent.has("failure"):
			return sent["failure"]
		released = sent["released"]
	if not released:
		core.cache.set_subject("")
		_notify(KIND_SIGNED_OUT, "", previous)
		return PKeyResult.success({"released": false})
	# The seat is released server-side: the token and everything it vouched for go, the subject
	# with the cache record. The device id stays.
	var wiped := core.tokens.clear()
	wiped = core.cache.clear() and wiped
	_notify(KIND_SIGNED_OUT, "", previous)
	if on_wiped.is_valid():
		await on_wiped.call()
	if not wiped:
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The local credential or cache could not be removed.", {"released": true})
	return PKeyResult.success({"released": true})


## ok: detail {url, opened: bool}. Not opened (no opener, or it declined): show `url` instead.
func open_account() -> PKeyResult:
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	var fragment := await _fragment()
	var url: String = fragment.get("account_portal", "")
	if url == "" or (not PKeyOutletAdapter.is_https(url) and not PKeyTransport.LOOPBACK_HOSTS.has(PKeyTransport.parse_url(url).get("host", ""))):
		return _unavailable("an account page")
	var opened := false
	if opener.is_valid():
		opened = bool(await opener.call(url))
	elif PKeyOutletAdapter.is_https(url):
		opened = OS.shell_open(url) == OK
	return PKeyResult.success({"url": url, "opened": opened})


## ok: detail {kind: "confirm", license: {id, tier_id, name}} for `confirm == false` (nothing is
## written), or {kind: "ok", subject: String or "", attached: "claimed" or ""} for `true`: the
## rotated token is stored; the caller syncs, as after `activate_with_key`. A refusal is a failure
## (code = the Worker's, detail {kind: "refused", status}); no endpoint (no `account: true`) is
## `service-unavailable` with detail.kind "unavailable" and nothing is sent.
func attach(confirm: bool) -> PKeyResult:
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	var fragment := await _fragment()
	var url: String = fragment.get("attach", "") if fragment.get("account") == true else ""
	if url == "" or not _own(url):
		return _unavailable("attaching a license")
	if not core.tokens.has_token():
		return PKeyResult.failure(PKeyErrors.NO_TOKEN, "Activate or sign in before attaching.")
	var r := await _send("POST", url, {"confirm": confirm})
	if not r.ok:
		return r
	var status: int = r.detail["status"]
	var body = _body(r)
	if status >= 500:
		return PKeyResult.failure(PKeyErrors.SERVER_ERROR, "Attach failed with status %d." % status, {"status": status})
	if status != 200:
		var err = body.get("error") if body is Dictionary else null
		var code = err.get("code") if err is Dictionary else err
		var name: String = code if code is String and code != "" else "http_%d" % status
		return PKeyResult.failure(StringName(name), "Attach was refused (status %d)." % status, {"kind": "refused", "status": status})
	if not (body is Dictionary):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "Attach answered without a body.")
	if body.get("status") == "confirm":
		var l = body.get("license")
		var lic: Dictionary = l if l is Dictionary else {}
		return PKeyResult.success({"kind": "confirm", "license": {
			"id": lic["id"] if lic.get("id") is String else "",
			"tier_id": lic.get("tierId") if lic.get("tierId") is String else null,
			"name": lic.get("name") if lic.get("name") is String else null,
		}})
	var token = body.get("token")
	if not (token is String and token != ""):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "Attach answered without a token.")
	if not core.tokens.set_token(token, PKeyTokenManager.SOURCE_ACTIVATE):
		return PKeyResult.failure(PKeyErrors.STORE_FAILED, "The rotated token could not be stored.")
	var subject = body.get("subject")
	_store_subject(subject if subject is String else "")
	return PKeyResult.success({"kind": "ok", "subject": subject if subject is String else "", "attached": "claimed" if body.get("attached") == "claimed" else ""})


## A device-code sign-in ended signed in as `subject` ("" when the Worker did not say): keep it
## beside the token and raise `signedIn`.
func note_signed_in(subject: String) -> void:
	if subject != "":
		_core().cache.set_subject(subject)
	_notify(KIND_SIGNED_IN, subject, "")


func _store_subject(value: String) -> void:
	var core := _core()
	var previous := core.cache.subject
	if core.cache.set_subject(value):
		_notify(KIND_SUBJECT_CHANGED, value, previous)


func _notify(kind: String, subject: String, previous: String) -> void:
	if on_change.is_valid():
		on_change.call(kind, subject, previous)
