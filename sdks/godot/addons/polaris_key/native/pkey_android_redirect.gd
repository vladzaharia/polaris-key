class_name PKeyAndroidRedirect
extends RefCounted
## The Android half of the native redirect sign-in (I-48.17b; WIRE-CONTRACT-V5 §12.12). It is the identity
## service's `native_opener` on Android: it names the redirects the project registered, opens the sign-in page
## in the system browser through the plugin (a Custom Tab on the issuer's host, never a web view) and hands the
## redirect the OS brings back to `sign_in.handle_redirect(url)`, which checks the redirect URI, `state` and `iss`
## and redeems the code from this device, once.
##
## The project registers a redirect in its project settings (`polaris_key/native_redirect/scheme`, a reverse-DNS
## scheme name, and/or `polaris_key/native_redirect/claimed_uri`, a verified `https://host/path` App Link); the
## export adds the matching intent filter to the plugin's redirect activity, and adds none when both are unset
## (then the sign-in answers `redirect-unavailable` and the kit offers a code). Start options override per key. The plugin is found by a call
## (`capabilities`), never by `has_method`: a JNI singleton answers false to that.
##
## The delivery URL carries the authorization code: it passes through here once and is never printed or stored.

## The Android facade whose plugin does the work (PKeyAndroid.shared() unless a test sets it).
var android: PKeyAndroid = null
## Tests only: {scheme, claimed_uri} instead of the project settings.
var settings: Variant = null

var _session: WeakRef = null
var _connected := false


func _facade() -> PKeyAndroid:
	if android == null:
		android = PKeyAndroid.shared()
	return android


## True when the plugin can open the page and take the redirect back (the build carries the plugin). Whether a
## redirect is registered is the start's business: with none, no class applies and the sign-in answers
## `redirect-unavailable`.
func available() -> bool:
	return _facade().auth_redirect_available()


## The redirects the project settings register (the defaults; start options override per key): {schemes, claimed}.
func registered() -> Dictionary:
	return PKeyNativeRedirect.settings_redirects(settings)


## Whether `redirect_uri` is a scheme or claimed-HTTPS redirect this opener can take.
func owns(redirect_uri: String) -> bool:
	var cls := PKeyNativeRedirect.classify_native_redirect_uri(redirect_uri)
	return cls == "scheme" or cls == "claimed"


## Wait for the redirect of `session` (a PKeySignInSession): the delivery goes to `session.handle_redirect`.
## One sign-in at a time; a new attach replaces the earlier one.
func attach(session: PKeySignInSession) -> void:
	_session = weakref(session)
	var a := _facade()
	if not _connected:
		a.auth_event.connect(_on_delivery)
		_connected = true


## Open `session.authorize_url` in the system browser, for the redirect the session was pushed with. OK, or an error
## code (the plugin refused: another host, an unregistered redirect, no intent filter; or no browser started).
func open(session: PKeySignInSession, issuer_host: String) -> int:
	var uri := session.redirect_uri
	var scheme := ""
	var claimed := ""
	if session.redirect_class == "scheme":
		scheme = uri.get_slice(":", 0)
	elif session.redirect_class == "claimed":
		claimed = uri
	else:
		return ERR_UNAVAILABLE
	var r := _facade().auth_open(session.authorize_url, scheme, claimed, issuer_host)
	return OK if r.ok else FAILED


## Forget the waiting sign-in natively (the sign-in shuts it when it settles, is cancelled or lapses).
func cancel() -> void:
	_session = null
	if _facade().auth_redirect_available():
		_facade().auth_cancel()


func _on_delivery(event: Dictionary) -> void:
	var session := _session.get_ref() as PKeySignInSession if _session != null else null
	var url := str(event.get("url", ""))
	if session == null or url == "":
		return
	# The sign-in checks the redirect URI, state and iss and redeems the code; a refusal leaves it waiting.
	await session.handle_redirect(url)
