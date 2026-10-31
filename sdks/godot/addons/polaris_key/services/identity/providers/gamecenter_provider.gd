class_name PKeyGameCenterProvider
extends PKeyPlatformIdentityProvider
## Game Center sign-in on iOS and macOS (I-48.6b): the adapter between the ladder's provider port and the
## OPT-IN Game Center extension (PKeyApple.game_center(); native/ios/build.sh with EXTENSION=gamecenter).
##
##   PolarisKey.identity.install_platform_provider(PKeyGameCenterProvider.new())
##
## Silent only: the player must already be signed in to Game Center, and this never presents Game
## Center's sign-in, so there is no sheet (`has_sheet()` is false) and the sign-in form has no Game
## Center button. The extension returns the raw fields; PKeyGameCenterToken builds the `gc1.` token.
## Game Center takes no nonce: the ladder still asks the Worker for one, and the exchange proof binds
## the token's hash to it.
##
## Answers (the port's shapes): `{token}`, or `{unavailable}` for everything else (no extension in
## this build, a player who is not signed in, ids that are not persistent, a refused or malformed
## signature). The token is a secret: it goes to the ladder and is never printed or kept here.

## The extension's facade; PKeyApple.game_center() when left null.
var game_center: PKeyApple = null


func _init(p_game_center: PKeyApple = null) -> void:
	kind = "gamecenter"
	game_center = p_game_center


func _facade() -> PKeyApple:
	if game_center == null:
		game_center = PKeyApple.game_center()
	return game_center


func has_sheet() -> bool:
	return false


func silent(_nonce: String, _audience: String) -> Dictionary:
	var r: PKeyResult = await _facade().gc_identity()
	if not r.ok:
		if r.code == PKeyErrors.UNSUPPORTED:
			return {"unavailable": r.message}
		var err := str(r.detail.get("error", "")) if r.detail is Dictionary else ""
		return {"unavailable": "Game Center is not available (%s)." % (err if err != "" else str(r.code))}
	var token := PKeyGameCenterToken.encode(r.detail if r.detail is Dictionary else {})
	if token == "":
		return {"unavailable": "Game Center answered a malformed signature."}
	return {"token": token}


func sheet(_nonce: String, _audience: String) -> Dictionary:
	return {"unavailable": "Game Center has no account sheet."}
