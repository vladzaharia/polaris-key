class_name PKeySignInNamespace
extends RefCounted
## `PolarisKey.identity.sign_in`: the one way to start a sign-in.
##
##   var s := await PolarisKey.identity.sign_in.start({device_name = "Deck"})
##   if not s.ok: ...                       # typed: `s.code` (service-unavailable, rate_limited, ...)
##   var outcome := await s.wait()          # PKeySignInSession.wait()

var _owner: WeakRef = null


func _init(owner: PKeyIdentity) -> void:
	_owner = weakref(owner)


## Ask for a device code and return the session. `opts`:
##   device_name       the label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1); empty:
##                     `PKeyOptions.device_name`, else the device's model or OS, unless
##                     `PKeyOptions.send_device_name` is off
##   confirm_identity  hold at the signed-in identity for the player's acceptance, and offer the
##                     licence attach (see PKeySignInSession)
##   browser           open the verification page in the system browser at once; the code and
##                     QR code stay on screen for another device
##   channel           "device-code" (default), or "redirect": the OAuth authorization-code flow
##                     for a host that can take the browser back to an https page it registered.
##                     The session's `authorize_url` is the page to open; hand the URL the browser
##                     landed on to `session.complete(callback_url)`.
##   redirect_uri      redirect: the https URI the product registered (required)
##   license_choice    redirect: "app" shows the licence choice in the app: a token that would need a
##                     choice settles `complete()` as `license_choice` (grant, choices) and
##                     `PolarisKey.identity.choice.*` finishes it. Honoured only when discovery names
##                     the choice endpoints; otherwise the card chooses. Default: the card chooses
##   scope             redirect: scopes asked for, a String or Array; default "profile email"
##   login_hint, name_hint, purpose
##                     redirect: prefill the card (WIRE-CONTRACT-V4 §12.4); they verify nothing.
##                     `purpose` is "signin" or "attach"
## A session that could not start has `ok == false` and a typed `code`: `service-unavailable`
## before any request when Identity is off or not set up, and for a start the Worker answers 404;
## `rate_limited`, `invalid-response` or a transport code otherwise. A sign-in already running is
## cancelled first. A coroutine.
func start(opts: Dictionary = {}) -> PKeySignInSession:
	var identity := _owner.get_ref() as PKeyIdentity if _owner != null else null
	if identity == null:
		return PKeySignInSession.new(false, PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	return await identity._start(opts)


## Begin a nearby sign-in on this device, the new device D (WIRE-CONTRACT-V5 section 15.6.1): a signed-in device
## nearby approves it. `opts`: `device_name` (the label the approver is shown). ok with a PKeyNearbySignIn
## (the approvers, `choose`, `code`, `wait`, `confirm_account`, `decline_account`, `cancel`); otherwise the typed
## failure: `nearby-unsupported` (this runtime cannot browse the network; no route was called),
## `nearby-permission-denied`, `service-unavailable` (discovery names no nearby approval), `rate_limited`,
## `invalid_grant`, ... A sign-in already running is cancelled first. A coroutine.
##
##   var r := await PolarisKey.identity.sign_in.start_nearby()
##   if r.ok:
##       var s: PKeyNearbySignIn = r.detail
##       var code := (await s.choose(s.approvers()[0]["id"])).detail["code"]   # show it
##       var outcome := await s.wait()                                         # signed_in, ...
##       await s.confirm_account()                                             # only if it is the person's
func start_nearby(opts: Dictionary = {}) -> PKeyResult:
	var identity := _owner.get_ref() as PKeyIdentity if _owner != null else null
	if identity == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	return await identity._start_nearby(opts)
