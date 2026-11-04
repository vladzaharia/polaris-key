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
##   redirect_uri      redirect: the https URI the product registered. Leave it out for a NATIVE
##                     redirect sign-in (WIRE-CONTRACT-V5 §12.12): on a desktop the SDK binds a
##                     127.0.0.1 listener, pushes the request, opens the system browser and redeems
##                     the code from this device (`session.wait()`); the session's `redirect_class`
##                     says which. Without a listener (mobile, web, a headless host) `registered_schemes`
##                     / `registered_claimed` (full redirect URIs) name the registered deliveries, which
##                     the host hands to `handle_redirect(url)`; with none the start fails with
##                     `redirect-unavailable`. On Android with the plugin, the project settings
##                     `polaris_key/native_redirect/scheme` / `claimed_uri` name the registered redirect
##                     and the SDK opens the page and takes the delivery itself (PKeyAndroidRedirect).
##                     Also: `loopback` (false to skip the listener),
##                     `return_uri` (a registered scheme's redirect URI for "Return to <App>"),
##                     `browser` (false: do not open the browser; `session.reopen()` does)
##   license_choice    redirect: "app" shows the licence choice in the app: a token that would need a
##                     choice settles `complete()` as `license_choice` (grant, choices) and
##                     `PolarisKey.identity.choice.*` finishes it. Honoured only when discovery names
##                     the choice endpoints; otherwise the card chooses. Default: the card chooses
##   key_return        redirect (web and native): true accepts a key return (WIRE-CONTRACT-V5 §12.4),
##                     so the card offers "Continue without an account" and the request carries
##                     `key_return=allow`. The sign-in may then settle `activated` (the device holds
##                     the key's licence, no account; `license_id`, `key_entries`; `subject` is "" because the
##                     stored one is cleared), never `signed_in`. Default off, and it is not sent unless
##                     true; the device-code channel refuses it (`invalid-argument`). Leave it off
##                     until your UI renders `activated`: the SDK's own kits leave it off. A refusal at the
##                     token endpoint (`device_limit`, `key_entry_limit`, `license_owned`) is an
##                     `error` outcome whose `detail` holds limit, device_count, manage_url,
##                     key_entries, sign_in_url when served
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


## Native redirect: hand the sign-in the URL the OS gave the app (a registered scheme or claimed
## link). Goes to the sign-in `start()` last returned; a PKeySignInOutcome. A delivery that is not
## that sign-in's (another URL, a wrong `state`) is a `sign-in-failed` outcome and leaves it waiting.
## `sign-in-failed` as well when no native sign-in is running. A coroutine.
func handle_redirect(url: String) -> PKeySignInOutcome:
	var identity := _owner.get_ref() as PKeyIdentity if _owner != null else null
	if identity == null:
		return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var session = identity._active.get_ref() if identity._active != null else null
	if not (session is PKeySignInSession) or session._native == null:
		return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.SIGN_IN_FAILED, "No native redirect sign-in is waiting; start one first.")
	return await session.handle_redirect(url)
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
	return await start_nearby_session(identity, opts)


## `sign_in.start_nearby(opts)`: refuses before anything is sent when it cannot run (`nearby-unsupported` when
## this runtime cannot browse the network, the typed `service-unavailable` N/A when discovery names no nearby
## approval). Then `nearby/start`, then the LAN request (a failure there leaves the Worker's request to lapse).
## ok with a PKeyNearbySignIn. A session already running is cancelled first. A coroutine.
func start_nearby_session(identity: PKeyIdentity, opts: Dictionary) -> PKeyResult:
	identity._cancel_active()
	var core := identity._core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() before sign_in.start_nearby().")
	var gen := identity._starts
	var lan := identity._nearby_lan()
	var lane := _nearby_lane(lan, opts)
	if not lane.ok:
		# An unsupported runtime never calls a route for it (rule 10).
		return lane
	var started := await identity.nearby_routes.start(String(opts.get("device_name", "")))
	if not started.ok:
		return started
	var st: PKeyIdentityNearbyRoutes.Started = started.detail
	var label := PKeyDeviceLabel.resolve(String(opts.get("device_name", "")), core.options)
	var request_options: Dictionary = (opts.get("lan", {}) as Dictionary).duplicate()
	request_options["request"] = st.request
	request_options["expires_in"] = st.expires_in
	if label != "":
		request_options["label"] = label
	var made: PKeyResult = await lan.request(request_options)
	if not made.ok:
		return made
	var session := PKeyNearbySignIn.new(identity, identity.nearby_routes, st, made.detail, label, core.clock.system_now() + st.expires_in)
	identity._active = weakref(session)
	if gen != identity._starts:
		# A newer start or a rebind landed while this one was in flight.
		session.cancel()
	return PKeyResult.success(session)


## ok when the LAN half can browse here, else the typed `nearby-unsupported` (or the lane's own failure).
static func _nearby_lane(lan: Object, opts: Dictionary) -> PKeyResult:
	if lan != null:
		return lan.lane_check(opts)
	var detail := {"feature": PKeyConstants.Feature.IDENTITY_NEARBY, "reason": PKeyConstants.UnsupportedReason.RUNTIME, "detail": "This runtime cannot look for nearby devices."}
	return PKeyResult.failure(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "Nearby sign-in is not available here.", detail)
