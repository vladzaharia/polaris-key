class_name PKeyAppleRedirect
extends RefCounted
## The Apple half of the native redirect sign-in as the identity service's mobile opener (I-48.17), the same contract as
## PKeyAndroidRedirect: available / registered / owns / attach / open(session, issuer_host) / cancel. It wraps
## PKeyAppleAuth (the system browser sheet, ASWebAuthenticationSession): the delivered redirect goes to
## `session.handle_redirect`, a sheet the person closes leaves the sign-in waiting (`reopen()` shows it again) and a
## sheet that failed ends it. Only a registered scheme works here (the sheet needs no manifest); there is no
## claimed-link path, so `registered()` answers no claimed link. The project settings are the defaults and start
## options override per key (PKeyNativeRedirect.settings_redirects / merge_registered).

## The sheet opener (a PKeyAppleAuth, or a stand-in with open / cancel_sheet / sheet_id); null reads the process's.
var auth: Object = null
## Tests only: {scheme, claimed_uri} instead of the project settings.
var settings: Variant = null

var _session: WeakRef = null
var _sheet := 0


func _sheet_backend() -> Object:
	return auth if auth != null else PKeyAppleAuth.shared()


## True when the sheet ops are in this build.
func available() -> bool:
	return _sheet_backend() != null


func registered() -> Dictionary:
	return {"schemes": PKeyNativeRedirect.settings_redirects(settings)["schemes"], "claimed": []}


func owns(redirect_uri: String) -> bool:
	return PKeyNativeRedirect.classify_native_redirect_uri(redirect_uri) == "scheme"


func attach(session: PKeySignInSession) -> void:
	_session = weakref(session)


## Show the authorize page in the sheet, bound to the session's scheme and the issuer's host. OK or FAILED.
func open(session: PKeySignInSession, issuer_host: String) -> int:
	var backend := _sheet_backend()
	if backend == null or session.redirect_class != "scheme":
		return FAILED
	var me := weakref(session)
	var on_done := func(url: String) -> void:
		var s = me.get_ref()
		if s != null:
			s.handle_redirect(url)
	var on_fail := func(reason: String) -> void:
		var s = me.get_ref()
		if s != null and reason != "cancelled":
			s._sheet_failed()
	if not backend.open(session.authorize_url, session.redirect_uri.get_slice(":", 0), issuer_host, on_done, on_fail):
		return FAILED
	_sheet = backend.sheet_id
	return OK


## Close the sheet this opener showed, if it is still the one on screen.
func cancel() -> void:
	var backend := _sheet_backend()
	if backend != null and _sheet > 0:
		backend.cancel_sheet(_sheet)
	_sheet = 0
