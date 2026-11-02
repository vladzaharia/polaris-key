class_name PKeyIdentity
extends RefCounted
## `PolarisKey.identity`: device-code sign-in (RFC 8628), the only way a game finishes an
## identity sign-in natively. The player scans a QR code or types an eight-letter code on another
## device; the game polls until the sign-in completes, stores the licence-bound device token and
## syncs (notes/A2 §6, §9.5; sdk-node `identity/client.ts` is the same flow).
##
##   sign_in.start(opts)                   start a sign-in: a PKeySignInSession (the code, the
##                                         links, `wait()`, `outcome`, `cancel()`, `reopen()`,
##                                         `accept()`); opts {device_name, confirm_identity,
##                                         browser, login_hint, name_hint, purpose,
##                                         license_choice}. See PKeySignInSession.
##   choice.licenses(grant) / devices(grant, license_id) / complete(grant, choice) / cancel(grant)
##                                         the licence choice an app shows itself after a redirect
##                                         sign-in with license_choice = "app"; see PKeyIdentityChoice
##   exchange.nonce(kind) / exchange.exchange(kind, token, nonce)
##                                         the platform exchange primitive; see PKeyIdentityExchange
##   auto_sign_in(opts)                    the automatic sign-in ladder (a coroutine answering a
##                                         PKeyAutoSignInResult); see PKeyIdentityAutoSignIn
##   install_platform_provider(provider)   add a platform sign-in (PKeyPlatformIdentityProvider) the
##                                         ladder and sign_out() use; platform_providers() lists them
##   is_available()                        Identity is on for this product and set up
##   open_in_browser(session), copy_link(session)
##                                         for the dialog's two buttons
##   current()                             {name, email, activatedAt} of the signed-in person off
##                                         the verified licence, or null (SDK parity §3.12)
##   subject()                             the pairwise subject signed in on the device (GET the
##                                         discovered `subject`; kept across restarts); ok with
##                                         detail {subject: String or null}
##   sign_out()                            cancel any sign-in, run the pre-sign-out hooks, POST the
##                                         discovered `signout` and forget the identity; the token
##                                         goes only on `released: true`. ok with detail {released}.
##                                         Once the Worker accepted it, automatic sign-in stays quiet
##                                         until the person signs in again (see PKeyIdentityAutoSignIn).
##                                         Without the endpoint it is the old path: release this
##                                         device with license.deactivate()
##   attach(confirm)                       preview (false) or add this device's licence to the signed-in
##                                         account (true); see attach()
##   open_account()                        open the product's account page (the discovered
##                                         `accountPortal`); ok with detail {url, opened}
##
## The account changes reach `PolarisKey.event("identity", {kind, subject, previous})`: kind
## `signedIn` (a device-code sign-in ended signed in), `signedOut` (`sign_out()`), `activated` (a
## redirect sign-in that opted in with `key_return = true` ended on a key; `subject` is null) or
## `subjectChanged`; `subject` and `previous` are the pairwise subject now and before, or null.
##
## Device-code sign-in sends no fingerprint, so a `strict` tier refuses it. It signs in only:
## unlocking paid content with an externally bought key is a store-policy matter (notes/A2 §6).

## The `PolarisKey.event` kind the account's changes arrive under.
const EVENT_KIND := "identity"
## RFC 8628 §3.5: a `slow_down` without an interval adds this to the CURRENT interval.
const SLOW_DOWN_STEP_SECONDS := 5

## `func(seconds: float) -> void`, awaited between polls instead of a real timer (tests drive a
## fake clock with it). Empty: a SceneTreeTimer that ignores pause and time scale.
var sleeper: Callable = Callable()
## `func() -> PKeySyncResult`, awaited after a `ready` stored the token: the autoload's forced
## sync. Empty: no sync.
var on_acquired: Callable = Callable()

## `func(url: String) -> bool`, how open_account() opens the page. Empty: the system browser.
var account_opener: Callable = Callable():
	set(value):
		account_opener = value
		if _account != null:
			_account.opener = value

## `func(kind: String, subject: String, previous: String) -> void`: the account changed ("" = none).
## The autoload turns it into the `identity` event.
var on_change: Callable = Callable():
	set(value):
		on_change = value
		if _account != null:
			_account.on_change = value

## `sign_in.start(opts)`.
var sign_in: PKeySignInNamespace
## `choice.licenses / devices / complete / cancel`: the licence choice after a redirect sign-in
## that asked `license_choice = "app"` (PKeyIdentityChoice).
var choice: PKeyIdentityChoice
## `exchange.nonce / exchange`: the platform exchange primitive (PKeyIdentityExchange).
var exchange: PKeyIdentityExchange
## `auto_sign_in()`'s ladder (PKeyIdentityAutoSignIn).
var ladder: PKeyIdentityAutoSignIn
## The device key port (PKeyDeviceKeyStore or the options' own) the exchange signs its proof with:
## the autoload hands identity the one instance the key ring holds. Null until configure().
var device_keys: Object = null

## Conformance replay only: the exact `state` and `code_verifier` of a recorded redirect
## conversation ({state, code_verifier}); empty draws fresh entropy.
var redirect_entropy: Dictionary = {}
## Conformance replay and tests only: a Callable returning the loopback listener (an object with the
## members of PKeyLoopbackListener: port, start, close, poll, is_closed) instead of a bound socket.
var listener_factory: Callable = Callable()
## Tests only: "" reads the platform; "desktop" or "other" forces whether a listener can be bound.
var native_platform := ""
## Conformance replay only: false skips the forced sync after a redirect token (the `redirect-web-*`
## recordings hold the token exchange, not the sync that follows it).
var redirect_acquisition_sync := true

var _core_ref: WeakRef = null
var _account: PKeyIdentityAccount = null
var _before_sign_out: Array[Callable] = []
var _platform_providers: Array = []
var _host: Node = null
## The sign-in `sign_in.start` last returned (weak: the game holds the session), or null.
var _active: WeakRef = null
## Bumped by every start and bind: a start whose answer arrives after a newer one is cancelled.
var _starts := 0


func _init() -> void:
	sign_in = PKeySignInNamespace.new(self)
	choice = PKeyIdentityChoice.new(self)
	exchange = PKeyIdentityExchange.new(self)
	ladder = PKeyIdentityAutoSignIn.new(self)


## Bind to Core (PolarisKey.configure). A sign-in in progress is cancelled.
func bind(core: PKeyCore, host: Node) -> void:
	_cancel_active()
	_core_ref = weakref(core)
	_host = host
	_account = PKeyIdentityAccount.new(core, _before_sign_out)
	_account.opener = account_opener
	_account.on_wiped = _on_account_wiped
	_account.on_change = on_change


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


func _cancel_active() -> void:
	_starts += 1
	var s = _active.get_ref() if _active != null else null
	_active = null
	if s is PKeySignInSession:
		s.cancel()


# ── Availability ─────────────────────────────────────────────────────────────────────────

## True when Identity is enabled for this product (D-21: discovery this session, else
## `expected_services`) and, when discovery was loaded, the product has an IdP configured
## (`services.identity.configured`). No request.
func is_available() -> bool:
	var core := _core()
	if core == null or not core.enabled("identity"):
		return false
	var m = core.discovery_manifest
	if m is Dictionary and m.get("services") is Dictionary and m["services"].get("identity") is Dictionary:
		var fragment: Dictionary = m["services"]["identity"]
		if fragment.has("configured") and not PKeyClaims.is_true(fragment["configured"]):
			return false
	return true



## Open the sign-in page in the system browser: `verification_uri_complete`, or `authorize_url` on
## the redirect channel (on web: `window.open`, which popup blockers eat outside an input event, so
## always render the link and the QR code as well). Returns the `OS.shell_open` error code.
func open_in_browser(session: PKeySignInSession) -> int:
	# Only an https link ever reaches the browser, whatever the server sent.
	if session == null or not PKeyOutletAdapter.is_https(session._page_url()):
		return ERR_INVALID_PARAMETER
	return OS.shell_open(session._page_url())


## Put the sign-in page's link (see open_in_browser) on the clipboard.
func copy_link(session: PKeySignInSession) -> void:
	if session != null and session._page_url() != "":
		DisplayServer.clipboard_set(session._page_url())


## The signed-in person, SDK parity §3.12's `identity.current()`: {name, email, activatedAt} off
## the verified licence document's profile (a value the profile lacks is null), or null when the
## device holds no profile naming someone.
func current() -> Variant:
	var core := _core()
	if core == null or core.cache == null or core.cache.license == null:
		return null
	var doc = core.cache.license.get("doc")
	if not (doc is Dictionary) or not (doc.get("profile") is Dictionary):
		return null
	var p: Dictionary = doc["profile"]
	var name = p.get("name") if p.get("name") is String and p["name"] != "" else null
	var email = p.get("email") if p.get("email") is String and p["email"] != "" else null
	if name == null and email == null:
		return null
	var at = p.get("activatedAt")
	return {"name": name, "email": email, "activatedAt": int(at) if PKeyClaims.is_number(at) else null}


## The automatic sign-in ladder: stored session, then the installed platform providers silently, then (with
## `{prompt = "optional"}`) one account sheet. Answers a PKeyAutoSignInResult; see PKeyIdentityAutoSignIn. A coroutine.
func auto_sign_in(opts := {}) -> PKeyAutoSignInResult:
	return await ladder.run(opts)


## Add a platform sign-in (a PKeyPlatformIdentityProvider, or any object with its members). One per
## `kind`: installing another of the same kind replaces it.
func install_platform_provider(provider: Object) -> void:
	for existing in _platform_providers.duplicate():
		if existing.get("kind") == provider.get("kind"):
			_platform_providers.erase(existing)
	_platform_providers.append(provider)


## The installed platform providers, in installation order.
func platform_providers() -> Array:
	return _platform_providers.duplicate()


func clear_platform_providers() -> void:
	_platform_providers.clear()


## Sign this device out (SDK parity §3.12's `identity.signOut()`): cancel a sign-in in progress,
## forget the identity this session saw, run the pre-sign-out hooks and POST the product's
## discovered `signout`. ok, detail {released}: true when the seat was released and the token and
## cache wiped (the device needs activating again), false when the licence and token stay.
## A product that publishes no `signout` keeps the pre-account behaviour: the seat is released
## with license.deactivate() (its best-effort server call, then the mandatory local wipe) and the
## PKeyResult is deactivate()'s. `state_changed` fires as for a deactivation. A coroutine.
func sign_out() -> PKeyResult:
	_cancel_active()
	var license = _host.get("license") if _host != null and is_instance_valid(_host) else null
	if license == null or _account == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	# A ladder in flight must store nothing from here on (the generation is checked with the store).
	_core().tokens.bump_sign_out_generation()
	var r := await _account.sign_out()
	if r.ok:
		await _mark_signed_out()
		return r
	if not (r.detail is Dictionary and r.detail.get("kind") == "unavailable"):
		return r
	for hook in _before_sign_out.duplicate():
		var stopped: Variant = await hook.call()
		if stopped is PKeyResult and not stopped.ok:
			return stopped
	var released: PKeyResult = await license.deactivate()
	if released.ok:
		await _mark_signed_out()
	return released


## The Worker accepted a sign-out: no silent rung runs until the person signs in again, and each
## platform provider forgets its session. Device keys stay (they are the device's, not the account's).
func _mark_signed_out() -> void:
	var core := _core()
	core.tokens.bump_sign_out_generation()
	core.cache.set_explicit_sign_out(true)
	for provider in _platform_providers.duplicate():
		if provider.has_method("sign_out_cleanup"):
			await provider.sign_out_cleanup()


## The pairwise subject signed in on the device (ok, detail {subject}: null for a key-only device
## or none). A product without the account endpoints answers `service-unavailable`
## (`detail.kind == "unavailable"`) and nothing is sent. A coroutine.
func subject() -> PKeyResult:
	if _account == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	return await _account.subject()


## Open the product's page in the customer portal (ok, detail {url, opened}; when not opened,
## show `url` as a link or QR code). `service-unavailable` when the product publishes none.
## A coroutine.
func open_account() -> PKeyResult:
	if _account == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	return await _account.open_account()


## `POST attach` over the discovered endpoint (identity.attach). `confirm == false` previews the
## device's own licence: ok, detail {kind: "confirm", license: {id, tier_id, name}}, nothing is
## written. `true` adds it to the signed-in account and stores the rotated token: ok, detail
## {kind: "ok", subject, attached ("claimed" when this call attached it, else "")}; sync after, as
## after `activate_with_key`. The Worker's refusals (`account_required`, `license_owned`,
## `license_email_bound`, `unauthorized`, `not_found`, ...) are failures with that `code` and
## detail {kind: "refused", status}; token, cache and identity stay. A product without the
## endpoint answers `service-unavailable` (detail.kind "unavailable"). A coroutine.
func attach(confirm: bool) -> PKeyResult:
	if _account == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	return await _account.attach(confirm)


## Register a step `sign_out()` awaits before it signs out, in registration order (Cloud Sync's
## flush, D-4): a `func() -> void`, a coroutine allowed. Nothing is registered until Cloud Sync
## does.
func add_before_sign_out(hook: Callable) -> void:
	_before_sign_out.append(hook)


## A released sign-out wiped the credential: the licence surface reports the change.
func _on_account_wiped() -> void:
	var license = _host.get("license") if _host != null and is_instance_valid(_host) else null
	if license != null and license.on_changed.is_valid():
		license.on_changed.call()


## The name a sign-in shows the human when the game gives none: the device model where the OS
## reports a real one, else the OS name ("macOS", "Linux", …).
static func default_device_name() -> String:
	return PKeyDeviceLabel.platform_default()



# ── The sign-in ──────────────────────────────────────────────────────────────────────────

## `sign_in.start(opts)`: `POST /identity/auth/device/start`. The label is
## `PKeyDeviceLabel.resolve(device_name, options)`: normalised, omitted when empty. A session
## already running is cancelled first. A coroutine.
func _start(opts: Dictionary) -> PKeySignInSession:
	_cancel_active()
	var gen := _starts
	var channel := String(opts.get("channel", "device-code"))
	if channel != "device-code" and channel != "redirect":
		return _failed(PKeyErrors.INVALID_OPTIONS, "The channel is \"device-code\" or \"redirect\" (channel: %s)." % channel)
	var session: PKeySignInSession
	if channel == "redirect":
		session = await _begin_redirect(opts)
	elif opts.get("key_return") is bool and opts["key_return"]:
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "key_return belongs to the redirect channel; the device-code channel does not take it.")
	else:
		session = await _request_start(String(opts.get("device_name", "")), opts)
	if not session.ok:
		return session
	session.confirm_identity = opts.get("confirm_identity", false) == true and channel == "device-code"
	session._identity = self
	_active = weakref(session)
	if gen != _starts:
		# A newer start or a rebind landed while this one was in flight.
		session.cancel()
	elif session._native != null:
		# A native sign-in opens the browser unless the host said not to (`browser: false`).
		if opts.get("browser", true) != false:
			session.opened = session.reopen()
	elif opts.get("browser", false) == true:
		session.reopen()
	return session


## `sign_in.start({channel = "redirect", redirect_uri})` (WIRE-CONTRACT-V4 §12.4): nothing is
## sent. The authorize URL is built from discovery's `authorize` endpoint and `issuer` (never
## from a guessed path), with the S256 challenge, the `state` and the hints. The token endpoint
## must be on this product's origin: the device's headers go nowhere else.
func _begin_redirect(opts: Dictionary) -> PKeySignInSession:
	var given = opts.get("redirect_uri")
	if given == null or (given is String and given == ""):
		return await _begin_native(opts)
	var core := _core()
	if core == null or not core.started:
		return _failed(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() before sign_in.start().")
	if core.discovery_manifest == null:
		# An endpoint is used only when discovery names it; the answer may also say Identity is off.
		await core.discover()
	if not core.enabled("identity") or not is_available():
		var off := _failed(PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled (or not set up) for %s." % core.product)
		off.detail = PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_REDIRECT_WEB, "identity")
		return off
	if not PKeyIdentityRedirect.is_redirect_uri(opts.get("redirect_uri")):
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "redirect_uri must be an absolute https URL with no fragment.")
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var endpoints: Dictionary = fragment.get("endpoints", {})
	var authorize: String = endpoints.get("authorize", "")
	var token: String = endpoints.get("token", "")
	var issuer: String = fragment.get("issuer", "")
	if authorize == "" or token == "" or issuer == "":
		return _failed(PKeyConstants.ErrorCode.SIGN_IN_UNAVAILABLE, "This product's discovery serves no redirect sign-in.")
	if not _own(token):
		return _failed(PKeyErrors.INVALID_RESPONSE, "The token endpoint points outside this product.")
	var started := PKeyIdentityRedirect.start({
		"authorize_endpoint": authorize, "token_endpoint": token, "issuer": issuer, "client_id": core.product,
		"redirect_uri": opts.get("redirect_uri"), "scope": opts.get("scope"),
		"login_hint": opts.get("login_hint"), "name_hint": opts.get("name_hint"), "purpose": opts.get("purpose"),
		"state": redirect_entropy.get("state"), "code_verifier": redirect_entropy.get("code_verifier"),
		"license_choice": opts.get("license_choice"), "choice_available": PKeyIdentityChoice.available(fragment),
		"key_return": opts.get("key_return"),
	})
	if not started["ok"]:
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, started["message"])
	var session := PKeySignInSession.new(true)
	session.channel = &"redirect"
	session._pending = started["pending"]
	session.authorize_url = started["pending"]["authorize_url"]
	session.device_name = PKeyDeviceLabel.resolve(String(opts.get("device_name", "")), core.options)
	return session


## `sign_in.start({channel = "redirect"})` with no `redirect_uri` (WIRE-CONTRACT-V5 §12.12): the
## native redirect. The order is the listener's bind, the pushed request, then the browser (in
## `_start`), so the port is held before the Worker learns it. Every endpoint is used only when
## discovery names it, and the ones the device's headers reach must be on this product. Nothing is
## sent when no class applies: `redirect-unavailable`, and the kit offers a code.
func _begin_native(opts: Dictionary) -> PKeySignInSession:
	var core := _core()
	if core == null or not core.started:
		return _failed(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() before sign_in.start().")
	if core.discovery_manifest == null:
		await core.discover()
	if not core.enabled("identity") or not is_available():
		var off := _failed(PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled (or not set up) for %s." % core.product)
		off.detail = PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_REDIRECT_NATIVE, "identity")
		return off
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var raw = core.discovery_manifest.get("services", {}).get("identity") if core.discovery_manifest is Dictionary and core.discovery_manifest.get("services") is Dictionary else null
	var endpoints: Dictionary = fragment.get("endpoints", {})
	var request_endpoint: String = endpoints.get("request", "")
	var authorize: String = endpoints.get("authorize", "")
	var token: String = endpoints.get("token", "")
	var issuer: String = fragment.get("issuer", "")
	var return_page: String = endpoints.get("signinReturn", "")
	if return_page != "":
		# The 303 target is the product's own customer host: the API origin or the issuer's.
		var page := PKeyTransport.parse_url(return_page)
		var allowed: Array = []
		for u in [core.base_url, issuer]:
			var parsed := PKeyTransport.parse_url(u)
			if not parsed.is_empty():
				allowed.append(parsed["origin"])
		# https, or the API's own origin (a local Worker for development).
		var own_origin: bool = page.get("origin") == PKeyTransport.parse_url(core.base_url).get("origin")
		if page.is_empty() or not (return_page.begins_with("https://") or own_origin) or not (page["origin"] in allowed):
			return _failed(PKeyErrors.INVALID_OPTIONS, "The return page is outside this product.")
	var advertised = raw.get("nativeRedirect") if raw is Dictionary else null
	var native: Variant = advertised if advertised is Dictionary else null
	if request_endpoint != "" and (authorize == "" or token == "" or issuer == ""):
		return _failed(PKeyConstants.ErrorCode.SIGN_IN_UNAVAILABLE, "This product's discovery serves no redirect sign-in.")
	var desktop := PKeyNativeRedirect.is_desktop() if native_platform == "" else native_platform == "desktop"
	var can_listen: bool = (not PKeyNativeRedirect.is_headless() if not opts.has("loopback") else opts["loopback"] == true) and desktop and return_page != ""
	var choice := PKeyNativeRedirect.choose_redirect_class({
		"request_endpoint": request_endpoint, "discovery": native, "can_listen": can_listen,
		"registered_schemes": opts.get("registered_schemes", []), "registered_claimed": opts.get("registered_claimed", []),
	})
	if choice["kind"] == "unavailable":
		var gone := _failed(StringName(choice["code"]), "No native redirect can start here; sign in with a code instead (%s)." % choice["reason"])
		gone.detail = {"reason": choice["reason"]}
		return gone
	if not _own(token) or not _own(request_endpoint):
		return _failed(PKeyErrors.INVALID_RESPONSE, "An endpoint points outside this product.")
	var label := PKeyDeviceLabel.resolve(String(opts.get("device_name", "")), core.options)
	var listener: Object = null
	var redirect_uri := ""
	if choice["kind"] == "loopback":
		# Bind first, push second: the port is ours before the Worker learns it.
		listener = listener_factory.call() if listener_factory.is_valid() else PKeyLoopbackListener.new()
		if listener.port < 1:
			return _failed(PKeyErrors.NETWORK, "The loopback listener could not be bound.")
		redirect_uri = PKeyNativeRedirect.native_redirect_uri("loopback", {"port": listener.port})
	else:
		redirect_uri = choice["redirect_uri"]
	var pushed := PKeyNativeRedirect.push_request({
		"request_endpoint": request_endpoint, "authorize_endpoint": authorize, "token_endpoint": token,
		"issuer": issuer, "client_id": core.product, "redirect_uri": redirect_uri, "device_name": label,
		"return_uri": opts.get("return_uri"), "scope": opts.get("scope"),
		"login_hint": opts.get("login_hint"), "name_hint": opts.get("name_hint"), "purpose": opts.get("purpose"),
		"license_choice": opts.get("license_choice"), "choice_available": PKeyIdentityChoice.available(fragment),
		"key_return": opts.get("key_return"),
		"state": redirect_entropy.get("state"), "code_verifier": redirect_entropy.get("code_verifier"),
	})
	if not pushed["ok"]:
		if listener != null:
			listener.close()
		return _failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, pushed["message"])
	var r := await core.transport.request("POST", pushed["url"], core.headers({"Content-Type": pushed["content_type"]}), String(pushed["body"]).to_utf8_buffer())
	var failure := _push_failure(r)
	if failure == null:
		var status := _status(r)
		var parsed := PKeyJson.parse_bytes(r.detail["body"])
		var answer := PKeyNativeRedirect.parse_pushed_answer(status, parsed["value"] if parsed["ok"] else null)
		if answer["kind"] == "refused":
			var retry = answer.get("retry_after_seconds")
			if retry == null:
				var header = r.detail["headers"].get("retry-after") if r.detail["headers"] is Dictionary else null
				if header is String and (header as String).strip_edges().is_valid_int():
					retry = mini(int((header as String).strip_edges()), 3600)
			failure = _failed(StringName(answer["error"]), "The Worker refused the sign-in request (%s)." % answer["error"])
			failure.detail = {"status": status}
			if retry != null:
				failure.detail["retry_after_seconds"] = retry
		elif answer["kind"] == "malformed":
			failure = _failed(PKeyErrors.INVALID_RESPONSE, "The request endpoint answered without a complete pushed request.")
			failure.detail = {"status": status}
		else:
			var n := PKeyNativeSignIn.new()
			n.pending = pushed["pending"]
			n.redirect_class = pushed["pending"]["redirect_class"]
			n.redirect_uri = redirect_uri
			n.authorize_url = PKeyNativeRedirect.authorize_url_for(authorize, core.product, answer["request_uri"])
			n.expires_at = core.clock.system_now() + float(answer["expires_in"])
			n.listener = listener
			n.return_page = return_page
			var session := PKeySignInSession.new(true)
			session.channel = &"redirect"
			session._native = n
			session.authorize_url = n.authorize_url
			session.redirect_class = n.redirect_class
			session.redirect_uri = redirect_uri
			session.expires_in = int(answer["expires_in"])
			session.expires_at = n.expires_at
			session.device_name = label
			session.license_choice = pushed["pending"]["license_choice"]
			if listener != null:
				listener.start(Callable(n, "on_listener_callback"))
				n.drive(_host)
			return session
	if listener != null:
		listener.close()
	return failure


## A push that got no answer, as the failed session (null when there was one).
static func _push_failure(r: PKeyResult) -> PKeySignInSession:
	if r.ok:
		return null
	return _failed(r.code if r.code == PKeyErrors.LOCAL_ONLY else PKeyErrors.NETWORK, r.message)


func _own(url: String) -> bool:
	var u := PKeyTransport.parse_url(url)
	var base := PKeyTransport.parse_url(_core().base_url)
	return not u.is_empty() and not base.is_empty() and u["origin"] == base["origin"]


## Redeem the code at the token endpoint (form body, no bearer) and, on a token, store it. Returns
## a PKeySignInOutcome: signed_in, or an error carrying the Worker's own code (`invalid_grant`,
## `invalid_client`, `rate_limited` with detail {retry_after_seconds}, `server-error` for a 5xx).
## A refusal never touches the stored token or the cache. A coroutine.
func _redeem(session: PKeySignInSession, pending: Dictionary, code: String, native := false) -> PKeySignInOutcome:
	var core := _core()
	if core == null or not core.started:
		return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	# A native sign-in's label went with the push (the token request does not repeat it) and the
	# request names the pushing device.
	var form := PKeyIdentityRedirect.token_form(pending, code, "" if native else session.device_name)
	var h := core.headers({"Content-Type": PKeyIdentityRedirect.TOKEN_CONTENT_TYPE})
	if native:
		var tr := PKeyNativeRedirect.native_token_request(pending, code, core.device_id)
		if tr.is_empty():
			return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, "The device has no usable id.")
		form = tr["body"]
		h = core.headers(tr["headers"])
	var r := await core.transport.request("POST", pending["token_endpoint"], h, form.to_utf8_buffer())
	if not r.ok:
		return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, r.code if r.code == PKeyErrors.LOCAL_ONLY else PKeyErrors.NETWORK, r.message)
	var status := _status(r)
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var answer := PKeyIdentityRedirect.parse_token_answer(status, parsed["value"] if parsed["ok"] else null, {"key_return": pending.get("key_return") is bool and pending["key_return"]})
	match answer["kind"]:
		"malformed":
			return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.INVALID_RESPONSE, "The token endpoint answered without a complete sign-in.", status)
		"choose":
			# Only `license_choice=app` makes the Worker answer this. Nothing is stored;
			# `identity.choice.*` finishes it.
			if pending.get("license_choice") == true:
				return PKeySignInOutcome.license_choice(answer["grant"], answer["expires_in"], answer["choices"])
			return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.INVALID_RESPONSE, "The token endpoint asked for a licence choice this sign-in did not request.", status)
		"refused":
			var retry = answer.get("retry_after_seconds")
			if retry == null:
				var header = r.detail["headers"].get("retry-after") if r.detail["headers"] is Dictionary else null
				if header is String and (header as String).strip_edges().is_valid_int():
					retry = mini(int((header as String).strip_edges()), 3600)
			var refused := PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, PKeyErrors.SERVER_ERROR if status >= 500 else StringName(answer["error"]), "The token endpoint refused the sign-in (%s)." % answer["error"], status)
			var extra: Dictionary = answer.get("details", {}) if status < 500 else {}
			if retry != null or not extra.is_empty():
				# The flat members of a refusal (device_limit, key_entry_limit, license_owned) ride along.
				refused.detail = extra.duplicate()
				if retry != null:
					refused.detail["retry_after_seconds"] = retry
			return refused
		"activated":
			# A key return: a key activation, never a sign-in. The token is stored as `activate` (a key's
			# provenance, so rung 1 of automatic sign-in does not count it) and the stored subject is the
			# answered value, so a null one clears an account the device held.
			var key_stored := core.tokens.set_token(answer["access_token"], PKeyTokenManager.SOURCE_ACTIVATE, true, PKeyTokenManager.ORIGIN_KEY)
			var key_subject: String = answer["subject"] if answer["subject"] is String else ""
			if _account != null:
				_account.note_activated(key_subject)
			var key_synced: PKeySyncResult = null
			if redirect_acquisition_sync and on_acquired.is_valid():
				key_synced = await on_acquired.call()
				var key_problem := PKeyLicense.unverified(core, key_synced, "the key was accepted")
				if not key_problem.is_empty():
					return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, key_problem["code"], key_problem["message"], int(key_problem["status"]))
			var key_license: Dictionary = answer["license"]
			return PKeySignInOutcome.activated(String(key_license.get("id", "")) if key_license.get("id") is String else "", answer["key_entries"], key_subject, key_stored, key_synced)
	var stored := core.tokens.set_token(answer["access_token"], PKeyTokenManager.SOURCE_SIGNIN, true)
	var subject: String = answer["subject"]
	if _account != null:
		_account.note_signed_in(subject)
	var synced: PKeySyncResult = null
	if redirect_acquisition_sync and on_acquired.is_valid():
		synced = await on_acquired.call()
		var problem := PKeyLicense.unverified(core, synced, "the sign-in succeeded")
		if not problem.is_empty():
			return PKeySignInOutcome.ended(PKeySignInOutcome.KIND_ERROR, problem["code"], problem["message"], int(problem["status"]))
	var out := PKeySignInOutcome.signed_in({}, "", stored, synced, subject)
	out.scope = answer["scope"]
	out.license_id = answer["license"].get("id", "") if answer["license"] is Dictionary and answer["license"].get("id") is String else ""
	return out


## The device start's optional members (WIRE-CONTRACT-V5 §12.10.1). The hints and `purpose` are
## always sent when valid (an older Worker ignores them); `licenseChoice: "app"` only when the
## caller asked for it AND discovery advertises `deviceChoice` with the four choice endpoints.
func _start_members(opts: Dictionary, fragment: Dictionary) -> Dictionary:
	var out := {}
	for pair in [["login_hint", "loginHint"], ["name_hint", "nameHint"]]:
		if opts.get(pair[0]) is String and opts[pair[0]] != "":
			out[pair[1]] = opts[pair[0]]
	if opts.get("purpose") in ["signin", "attach"]:
		out["purpose"] = opts["purpose"]
	if opts.get("license_choice") == "app" and fragment.get("device_choice") == true and PKeyIdentityChoice.available(fragment):
		out["licenseChoice"] = "app"
	return out


func _request_start(device_name: String, opts: Dictionary = {}) -> PKeySignInSession:
	var core := _core()
	if core == null or not core.started:
		return _failed(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() before sign_in.start().")
	if not core.enabled("identity"):
		var off := _failed(PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled (or not set up) for %s." % core.product)
		off.detail = PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_DEVICECODE, "identity")
		return off
	if not is_available():
		return _failed(PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled (or not set up) for %s." % core.product)
	if opts.get("license_choice") == "app" and core.discovery_manifest == null:
		# The gate reads discovery; fetch it only for a start that asks for the app's choice.
		await core.discover()
	var members := _start_members(opts, PKeyDiscovery.identity_from(core.discovery_manifest))
	var body := {"deviceId": core.device_id}
	body.merge(members)
	var label := PKeyDeviceLabel.resolve(device_name, core.options)
	if label != "":
		body["deviceName"] = label
	var r := await core.request("POST", "identity/auth/device/start", body)
	if not r.ok:
		var status := _status(r)
		if status == 404:
			# Device and JSON routes never say "identity is off": a start the Worker does not know
			# is a service the product does not run (WIRE-CONTRACT-V4 §12.8, identity-disabled).
			var gone := _failed(PKeyErrors.SERVICE_UNAVAILABLE, "The identity service is not enabled for %s." % core.product)
			gone.detail = PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_DEVICECODE, "identity")
			gone.detail["status"] = status
			return gone
		var p := _failed(r.code, r.message)
		p.detail = {"status": status}
		return p
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var b = parsed["value"] if parsed["ok"] else null
	if not (b is Dictionary) or not _str(b.get("deviceCode")) or not _str(b.get("userCode")) \
			or not _str(b.get("verificationUri")) or not _str(b.get("verificationUriComplete")) \
			or not _seconds(b.get("expiresIn")) or not _seconds(b.get("interval")):
		return _failed(PKeyErrors.INVALID_RESPONSE, "The device sign-in start answered without a complete prompt.")
	var session := PKeySignInSession.new(true)
	session.license_choice = members.get("licenseChoice") == "app"
	session.device_code = b["deviceCode"]
	session.user_code = b["userCode"]
	session.verification_uri = b["verificationUri"]
	session.verification_uri_complete = b["verificationUriComplete"]
	session.expires_in = _whole(b["expiresIn"])
	session.interval = _whole(b["interval"])
	session.expires_at = core.clock.system_now() + session.expires_in
	# The echo is what the page shows; an older Worker sends none, so show what was sent.
	if b.has("deviceName"):
		session.device_name = b["deviceName"] if b["deviceName"] is String else ""
	else:
		session.device_name = label
	return session


static func _failed(code: StringName, message: String) -> PKeySignInSession:
	return PKeySignInSession.new(false, code, message)


## Exactly one `POST /identity/auth/device/poll`; the session's `wait()` paces them. Returns
## {status, ...}:
##   pending                     not finished yet
##   slow-down    {interval}     polled too fast: wait `interval` seconds before the next poll
##   license-choice {grant, expires_in, choices}
##                               the poll answered `choose` (only after a start that sent
##                               licenseChoice "app"): nothing is stored, `choice.*` finishes it
##   confirm      {identity, attachable}
##                               signed in, held for the player's acceptance (confirm_identity)
##   ready        {identity, attached, stored, sync, subject}
##                               the token is stored and the forced sync has run
##   timeout                     the server no longer knows the code
##   denied                      the server answered `error` with `reason: access_denied`
##                               (the person pressed Deny)
##   device-mismatch             401
##   transient    {code}         no answer, or a 5xx: says nothing about the sign-in
##   error        {code, message, status}
##                               a bare `error` (no reason) is the sign-in failing after
##                               approval: code `sign-in-failed`
## A coroutine.
func _poll(prompt: PKeySignInSession, current: int, decision: Variant) -> Dictionary:
	var core := _core()
	if core == null or not core.started:
		return {"status": "error", "code": PKeyErrors.NOT_CONFIGURED, "message": "Call configure() and start() first.", "status_code": 0}
	if prompt == null or not prompt.ok:
		return {"status": "error", "code": PKeyErrors.INVALID_OPTIONS, "message": "No usable sign-in prompt.", "status_code": 0}
	var body := {"deviceCode": prompt.device_code, "deviceId": core.device_id}
	var extra := {}
	if prompt.confirm_identity:
		body["confirmIdentity"] = true
		if decision != null:
			body["attachLicense"] = bool(decision)
		# The device's own token names the anonymous licence an attach would take. Sent only on
		# the opt-in: an ordinary poll asks for the identity's credential and carries no bearer.
		if core.tokens.has_token():
			extra["Authorization"] = "Bearer %s" % core.tokens.current()
	var r := await core.request("POST", "identity/auth/device/poll", body, false, extra)
	var status := _status(r)
	if status == 0:
		if r.code == PKeyErrors.LOCAL_ONLY or r.code == PKeyErrors.NOT_CONFIGURED:
			return {"status": "error", "code": r.code, "message": r.message, "status_code": 0}
		return {"status": "transient", "code": r.code, "message": r.message}
	if status >= 500:
		return {"status": "transient", "code": PKeyErrors.SERVER_ERROR, "message": "The poll answered %d." % status}
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var b: Dictionary = parsed["value"] if parsed["ok"] and parsed["value"] is Dictionary else {}
	if status == 429:
		# The Worker's own `slow_down` carries the interval; a rate limiter in front of it (or its
		# flat `rate_limited`) answers 429 without one, which RFC 8628 §3.5 treats the same way.
		return {"status": "slow-down", "interval": _whole(b["interval"]) if _seconds(b.get("interval")) else current + SLOW_DOWN_STEP_SECONDS}
	if status == 401:
		return {"status": "device-mismatch", "code": PKeyErrors.UNAUTHORIZED, "message": "The poll's device id is not the one the sign-in was started for.", "status_code": 401}
	if not r.ok:
		return {"status": "error", "code": r.code, "message": r.message, "status_code": status}
	match b.get("status"):
		"pending":
			return {"status": "pending"}
		"timeout":
			return {"status": "timeout"}
		"error":
			# DENY-01: only `reason: access_denied` is a refusal; a bare `error` is a failure.
			if b.get("reason") == "access_denied":
				return {"status": "denied"}
			return {"status": "error", "code": PKeyErrors.SIGN_IN_FAILED, "message": "The sign-in failed after approval; begin again.", "status_code": status}
		"choose":
			var chosen := PKeyIdentityRedirect.parse_token_answer(200, b)
			if not prompt.license_choice:
				return {"status": "error", "code": PKeyErrors.INVALID_RESPONSE, "message": "The poll asked for a licence choice this sign-in did not request.", "status_code": status}
			if chosen["kind"] != "choose":
				return {"status": "error", "code": PKeyErrors.INVALID_RESPONSE, "message": "The poll answered choose without a complete grant.", "status_code": status}
			return {"status": "license-choice", "grant": chosen["grant"], "expires_in": chosen["expires_in"], "choices": chosen["choices"]}
		"confirm":
			return {"status": "confirm", "identity": _shown(b.get("identity")), "attachable": PKeyClaims.is_true(b.get("attachable"))}
		"ready":
			if not _str(b.get("token")):
				return {"status": "error", "code": PKeyErrors.INVALID_RESPONSE, "message": "The poll answered ready without a token.", "status_code": status}
			var shown := _shown(b.get("identity"))
			var stored := core.tokens.set_token(b["token"], PKeyTokenManager.SOURCE_SIGNIN, true)
			# The account's subject, kept beside the token, and the `identity` event.
			var subject: String = b["subject"] if _str(b.get("subject")) else ""
			if _account != null:
				_account.note_signed_in(subject)
			var synced: PKeySyncResult = null
			if on_acquired.is_valid():
				synced = await on_acquired.call()
				var problem := PKeyLicense.unverified(core, synced, "the sign-in succeeded")
				if not problem.is_empty():
					return {"status": "error", "code": problem["code"], "message": problem["message"], "status_code": int(problem["status"])}
			var attached: String = b["attached"] if b.get("attached") in ["claimed", "migrated"] else ""
			return {"status": "ready", "identity": shown, "attached": attached, "stored": stored, "sync": synced, "subject": subject}
	return {"status": "error", "code": PKeyErrors.INVALID_RESPONSE, "message": "The poll answered an unknown state.", "status_code": status}


## The seconds the wait actually sleeps: `interval`, never under one second (a zero, negative or
## non-finite interval would spin) and never past the code's remaining lifetime.
static func poll_delay(interval: float, remaining: float) -> float:
	var ceiling := remaining if remaining >= 1.0 and not is_inf(remaining) else 1.0
	if is_nan(interval) or interval < 1.0:
		return 1.0
	return minf(interval, ceiling)


## {name?, email?} from a server or document value: non-empty strings only, nothing else.
static func _shown(v: Variant) -> Dictionary:
	var out := {}
	if v is Dictionary:
		for k in ["name", "email"]:
			if _str(v.get(k)):
				out[k] = v[k]
	return out


static func _status(r: PKeyResult) -> int:
	return int(r.detail.get("status", 0)) if r.detail is Dictionary else 0


static func _str(v: Variant) -> bool:
	return v is String and v != ""


static func _seconds(v: Variant) -> bool:
	return PKeyClaims.is_number(v) and not is_nan(float(v)) and not is_inf(float(v)) and float(v) > 0.0


## A server's seconds rounded UP, so a 0.5 is one second rather than a sub-second spin (the same
## as the Node, Python and Swift SDKs).
static func _whole(v: Variant) -> int:
	return int(ceil(float(v)))
