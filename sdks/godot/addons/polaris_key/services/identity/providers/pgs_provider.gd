class_name PKeyPgsProvider
extends PKeyPlatformIdentityProvider
## Play Games sign-in on Android (I-48.7b): the adapter between the ladder's provider port and the
## PolarisKeyAndroid plugin's `pgs_*` ops (PKeyAndroid; the play flavour, with the export opt-in
## `polaris_key/play_games`, which adds the Play Games library and the app id).
##
##   PolarisKey.identity.install_platform_provider(PKeyPgsProvider.new())
##
## `silent` asks for a server auth code when the player is already signed in to Play Games and never
## starts Play Games' sign-in. `sheet` is the same call (the plan's rung 4 is "the same call"; there is
## no account chooser of ours to show). `provider_row` is the sign-in form's button: Play Games' own
## `signIn()` (which may show its sheet), then the code. `audience` is the product's Play Games server
## client id from discovery; without one there is nothing to ask for.
##
## The server auth code is the exchange's `subject_token` (`urn:polaris-key:token-type:pgs-server-auth-code`).
## Play Games has no nonce to put in it: the ladder still asks the Worker for one, and the exchange proof
## binds the code's hash to it. Answers (the port's shapes): `{token}` or `{unavailable}`; the code is a
## secret and is never printed or kept here.

## The plugin facade; the process's shared one when left null.
var android: PKeyAndroid = null


func _init(p_android: PKeyAndroid = null) -> void:
	kind = "pgs"
	android = p_android


func _facade() -> PKeyAndroid:
	if android == null:
		android = PKeyAndroid.shared()
	return android


func silent(_nonce: String, audience: String) -> Dictionary:
	return await _code(audience)


func sheet(_nonce: String, audience: String) -> Dictionary:
	return await _code(audience)


func provider_row(_nonce: String, audience: String) -> Dictionary:
	var a := _facade()
	var refused := _refusal(a, audience)
	if not refused.is_empty():
		return refused
	var row: PKeyResult = await a.pgs_sign_in()
	if not row.ok:
		return _failure(row)
	if not (row.detail is Dictionary and row.detail.get("authenticated") == true):
		return {"cancelled": true}
	return await _code(audience)


func _code(audience: String) -> Dictionary:
	var a := _facade()
	var refused := _refusal(a, audience)
	if not refused.is_empty():
		return refused
	var r: PKeyResult = await a.pgs_code(audience)
	if not r.ok:
		return _failure(r)
	var code = r.detail.get("code") if r.detail is Dictionary else null
	if code is String and code != "":
		return {"token": code}
	return {"unavailable": "Play Games answered no server auth code."}


func _refusal(a: PKeyAndroid, audience: String) -> Dictionary:
	var why := a.play_games_unavailable_reason()
	if why != "":
		return {"unavailable": "Play Games is not available here (%s)." % why}
	if audience == "":
		return {"unavailable": "The product publishes no Play Games server client id."}
	return {}


func _failure(r: PKeyResult) -> Dictionary:
	var d: Dictionary = r.detail if r.detail is Dictionary else {}
	var reason := str(d.get("reason", ""))
	if r.code == PKeyErrors.UNSUPPORTED:
		reason = str(d.get("reason", "unsupported"))
	return {"unavailable": "Play Games is not available (%s)." % (reason if reason != "" else str(r.code))}
