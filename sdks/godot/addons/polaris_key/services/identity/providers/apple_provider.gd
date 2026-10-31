class_name PKeyAppleProvider
extends PKeyPlatformIdentityProvider
## Sign in with Apple on iOS and macOS (I-48.4b): the adapter between the ladder's provider port and
## the PolarisKeyApple plugin's `apple_*` ops (PKeyApple).
##
##   PolarisKey.identity.install_platform_provider(PKeyAppleProvider.new())
##
## Apple has no silent mode: `has_silent()` is false, so rung 3 skips this provider and asks the
## Worker for no nonce. `sheet` is the ladder's one OS sheet over a credential this app already has
## (`immediate = true`); `provider_row` is the sign-in form's Apple button (the plain account sheet).
## The Worker's nonce goes to Apple as it is; the identity token's own `nonce` claim is what the
## Worker compares.
##
## Apple's user id is kept for the launch check only once the Worker accepted the token
## (`session_started`), and forgotten at sign-out. `credential_revoked()` is true only for Apple's
## `revoked` state; a missing credential, a transfer or a failed lookup is not revocation.
##
## Answers (the port's shapes): `{token, user_id}`, `{cancelled: true}` or `{unavailable: why}`. The
## token is a secret: it is returned to the ladder and never printed or kept here.

## The plugin facade; the process's shared one when left null.
var apple: PKeyApple = null


func _init(p_apple: PKeyApple = null) -> void:
	kind = "apple"
	apple = p_apple


func _facade() -> PKeyApple:
	if apple == null:
		apple = PKeyApple.shared()
	return apple


func has_silent() -> bool:
	return false


func silent(_nonce: String, _audience: String) -> Dictionary:
	return {"unavailable": "Sign in with Apple has no silent sign-in."}


func sheet(nonce: String, _audience: String) -> Dictionary:
	return await _sign_in(nonce, true)


func provider_row(nonce: String, _audience: String) -> Dictionary:
	return await _sign_in(nonce, false)


func session_started(info: Dictionary) -> void:
	var id = info.get("user_id")
	if id is String and id != "":
		_facade().apple_remember(id)


func sign_out_cleanup() -> void:
	_facade().apple_forget()


func credential_revoked() -> bool:
	var r: PKeyResult = await _facade().apple_credential_state()
	return r.ok and r.detail is Dictionary and str(r.detail.get("state", "")) == "revoked"


func _sign_in(nonce: String, immediate: bool) -> Dictionary:
	var r: PKeyResult = await _facade().apple_sign_in(nonce, immediate)
	if r.ok:
		var d: Dictionary = r.detail if r.detail is Dictionary else {}
		var token = d.get("token")
		if not (token is String) or token == "":
			return {"unavailable": "Apple answered no identity token."}
		var out := {"token": token}
		if d.get("userID") is String and d["userID"] != "":
			out["user_id"] = d["userID"]
		return out
	if r.code == PKeyErrors.UNSUPPORTED:
		return {"unavailable": r.message}
	var err := str(r.detail.get("error", "")) if r.detail is Dictionary else ""
	if err == "cancelled":
		return {"cancelled": true}
	return {"unavailable": "Sign in with Apple is not available (%s)." % (err if err != "" else str(r.code))}
