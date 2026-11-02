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
## (then the sign-in answers `redirect-unavailable` and the kit offers a code). The plugin is found by a call
## (`capabilities`), never by `has_method`: a JNI singleton answers false to that.
##
## The delivery URL carries the authorization code: it passes through here once and is never printed or stored.

## The Android facade whose plugin does the work (PKeyAndroid.shared() unless a test sets it).
var android: PKeyAndroid = null
## Tests only: the registered redirects ({scheme, claimed_uri}) instead of the project settings.
var settings: Variant = null

var _session: WeakRef = null
var _connected := false


func _facade() -> PKeyAndroid:
	if android == null:
		android = PKeyAndroid.shared()
	return android


func _scheme() -> String:
	var raw: Variant = settings.get("scheme") if settings is Dictionary else (ProjectSettings.get_setting(PKeyAndroidExport.REDIRECT_SCHEME_SETTING, "") if ProjectSettings.has_setting(PKeyAndroidExport.REDIRECT_SCHEME_SETTING) else "")
	return PKeyAndroidExport.redirect_scheme(raw)


func _claimed() -> String:
	var raw: Variant = settings.get("claimed_uri") if settings is Dictionary else (ProjectSettings.get_setting(PKeyAndroidExport.REDIRECT_CLAIMED_SETTING, "") if ProjectSettings.has_setting(PKeyAndroidExport.REDIRECT_CLAIMED_SETTING) else "")
	return PKeyAndroidExport.redirect_claimed(raw)


## True when the plugin can open the page and take the redirect back (the build carries the plugin) AND the project
## registered at least one redirect.
func available() -> bool:
	return _facade().auth_redirect_available() and (_scheme() != "" or _claimed() != "")


## The registered redirects as full redirect URIs: {schemes: [...], claimed: [...]}.
func registered() -> Dictionary:
	var schemes: Array = []
	var claimed: Array = []
	var s := _scheme()
	if s != "":
		schemes.append(PKeyNativeRedirect.native_redirect_uri("scheme", {"scheme": s}))
	var c := _claimed()
	if c != "" and PKeyNativeRedirect.classify_native_redirect_uri(c) == "claimed":
		claimed.append(c)
	return {"schemes": schemes.filter(func(u): return u != ""), "claimed": claimed}


## Whether `redirect_uri` is one this build registered.
func owns(redirect_uri: String) -> bool:
	var r := registered()
	return redirect_uri in r["schemes"] or redirect_uri in r["claimed"]


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
	if session.redirect_class == "scheme" and uri in registered()["schemes"]:
		scheme = _scheme()
	elif session.redirect_class == "claimed" and uri in registered()["claimed"]:
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
