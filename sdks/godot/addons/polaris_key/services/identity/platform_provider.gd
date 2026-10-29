class_name PKeyPlatformIdentityProvider
extends RefCounted
## The port a platform sign-in sits behind (Sign in with Apple, Game Center, Google Credential
## Manager, Play Games, FedCM): the ladder (`PolarisKey.identity.auto_sign_in()`) asks it for a platform
## token and hands the token to the Worker's exchange. The ladder duck-types the port, so any object
## with these members works; this class holds the defaults. Install one with
## `PolarisKey.identity.install_platform_provider(provider)`.
##
## Every call that asks the platform answers a Dictionary, never null:
##   {token: String, user_id?: String}   a platform token bound to `nonce` (a secret)
##   {cancelled: true}                   the person dismissed the platform's prompt
##   {unavailable: String}               the platform has nothing here (reason in words)
## A call may be a coroutine. `audience` is the product's server client id for this kind from
## discovery (Google, Play Games), else "". The nonce is the Worker's, passed on as it is.

## The `exchange` kind this provider's tokens are: `google`, `apple`, `gamecenter` or `pgs`.
var kind := ""


## False when the platform has no silent mode (Sign in with Apple): rung 3 skips this provider and
## no nonce is requested for it.
func has_silent() -> bool:
	return true


## False when the platform has no account sheet (Game Center): rung 4 skips this provider.
func has_sheet() -> bool:
	return true


## A token with no UI (rung 3).
func silent(_nonce: String, _audience: String) -> Dictionary:
	return {"unavailable": "no silent sign-in"}


## A token through the platform's one account sheet (rung 4). Shown at most once per ladder run.
func sheet(_nonce: String, _audience: String) -> Dictionary:
	return {"unavailable": "no account sheet"}


## A token through the provider's own button in the sign-in form (the person pressed it).
func provider_row(nonce: String, audience: String) -> Dictionary:
	return await sheet(nonce, audience)


## The Worker accepted a platform token as a session (`info`: {user_id?}): keep what the launch check
## needs. Called when the session exists, which for a `confirm` or `choose` is when
## `identity.choice.complete` finishes it.
func session_started(_info: Dictionary) -> void:
	pass


## Forget the platform's session state (called by `identity.sign_out()` once the Worker accepted it).
func sign_out_cleanup() -> void:
	pass


## True only when the platform says the person revoked this app's credential (Apple's `revoked`
## state, scenario 11). Not for "not found", "transferred" or "unknown".
func credential_revoked() -> bool:
	return false
