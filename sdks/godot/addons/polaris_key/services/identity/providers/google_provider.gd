class_name PKeyGoogleProvider
extends PKeyPlatformIdentityProvider
## Google sign-in on Android through Credential Manager (I-48.5b): the adapter between the ladder's
## provider port and the PolarisKeyAndroid plugin's `gid_*` ops (PKeyAndroid).
##
##   PolarisKey.identity.install_platform_provider(PKeyGoogleProvider.new())
##
## `silent` is rung 3 (no UI when exactly one authorised account exists; with two or more Credential
## Manager shows its chooser, and nothing can stop that beforehand), `sheet` is rung 4 (the chooser)
## and `provider_row` is the sign-in form's "Sign in with Google" button. `audience` is the product's
## Google server client id from discovery; without one there is nothing to ask for.
##
## It answers `{unavailable}` where Credential Manager cannot run: the direct flavour (`outlet`), an
## export without the `androidx.credentials` libraries (`dependency`; android_export.gd adds them to
## a play export on Godot 4.4 and later), or no plugin at all. Sign-out clears Credential Manager's
## state so the next launch does not pick the same account again. The token is a secret: it goes to
## the ladder and is never printed or kept here.

## The plugin facade; the process's shared one when left null.
var android: PKeyAndroid = null


func _init(p_android: PKeyAndroid = null) -> void:
	kind = "google"
	android = p_android


func _facade() -> PKeyAndroid:
	if android == null:
		android = PKeyAndroid.shared()
	return android


func silent(nonce: String, audience: String) -> Dictionary:
	return await _ask("gid_silent", nonce, audience)


func sheet(nonce: String, audience: String) -> Dictionary:
	return await _ask("gid_sheet", nonce, audience)


func provider_row(nonce: String, audience: String) -> Dictionary:
	return await _ask("gid_provider", nonce, audience)


func sign_out_cleanup() -> void:
	await _facade().gid_sign_out()


func _ask(op: String, nonce: String, audience: String) -> Dictionary:
	var a := _facade()
	var why := a.google_id_unavailable_reason()
	if why != "":
		return {"unavailable": "Google sign-in is not available here (%s)." % why}
	if audience == "":
		return {"unavailable": "The product publishes no Google server client id."}
	var r: PKeyResult
	match op:
		"gid_silent":
			r = await a.gid_silent(nonce, audience)
		"gid_sheet":
			r = await a.gid_sheet(nonce, audience)
		_:
			r = await a.gid_provider(nonce, audience)
	if r.ok:
		var token = r.detail.get("token") if r.detail is Dictionary else null
		if token is String and token != "":
			return {"token": token}
		return {"unavailable": "Credential Manager answered no token."}
	var d: Dictionary = r.detail if r.detail is Dictionary else {}
	if str(d.get("error", "")) == "cancelled":
		return {"cancelled": true}
	var reason := str(d.get("reason", ""))
	if r.code == PKeyErrors.UNSUPPORTED:
		reason = str(d.get("reason", "unsupported"))
	return {"unavailable": "Google sign-in is not available (%s)." % (reason if reason != "" else str(r.code))}
