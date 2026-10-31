class_name PKeyPlatformProviders
extends RefCounted
## Which platform sign-in providers a runtime installs for the automatic sign-in ladder (I-48.9), and
## the installing of them: Sign in with Apple (and Game Center when its opt-in extension is in the
## build) on iOS and macOS, Play Games and Google on Android, FedCM on the web. Desktop Linux and
## Windows have none, so the ladder stops at its first rung there.
##
##   PKeyPlatformProviders.install(PolarisKey.identity)   # idempotent: one provider per kind
##
## `for_platform()` is pure (a game or a test passes what it has); `install()` asks the live facades.

## The providers for `platform` (PKeyHeaders.update_platform() values) given what the build carries:
## `can` = {gamecenter, pgs, google} booleans (missing means false). Games first is the ladder's
## order, not this list's.
static func for_platform(platform: String, can := {}) -> Array:
	var out: Array = []
	match platform:
		"ios", "macos":
			out.append(PKeyAppleProvider.new())
			if can.get("gamecenter", false):
				out.append(PKeyGameCenterProvider.new())
		"android":
			if can.get("pgs", false):
				out.append(PKeyPgsProvider.new())
			if can.get("google", false):
				out.append(PKeyGoogleProvider.new())
		"web":
			out.append(PKeyFedcmProvider.new())
	return out


## The kind whose own button the sign-in form runs on `platform` ("" when the form keeps the device
## code and the redirect): Apple's plain account sheet on iOS and macOS, "Sign in with Google" on Android.
static func row_kind(platform: String) -> String:
	match platform:
		"ios", "macos":
			return "apple"
		"android":
			return "google"
	return ""


## Whether the form's own button for `platform` can run in this build: Apple's always; Google's only
## when the Android plugin carries Credential Manager and the Google library (else the button would
## lead nowhere, and the form keeps Polaris Locker alone).
static func row_available(platform: String) -> bool:
	match row_kind(platform):
		"":
			return false
		"google":
			return bool(detect(platform).get("google", false))
	return true


## What this build can do right now: the Game Center extension is installed, and the Android plugin
## carries Play Games and Credential Manager.
static func detect(platform: String) -> Dictionary:
	var can := {}
	if platform == "ios" or platform == "macos":
		can["gamecenter"] = ClassDB.class_exists(PKeyApple.GAME_CENTER_CLASS)
	elif platform == "android":
		var android := PKeyAndroid.shared()
		can["pgs"] = android.play_games_unavailable_reason() == ""
		can["google"] = android.google_id_unavailable_reason() == ""
	return can


## Install this runtime's providers on `identity` (a PKeyIdentity): the ones whose kind is not
## installed yet, so a game's own provider of a kind stays. `platform` "" is this build's. Returns how
## many it installed.
static func install(identity: Object, platform := "") -> int:
	var where := platform if platform != "" else PKeyHeaders.update_platform()
	var have := {}
	for p in identity.platform_providers():
		have[p.get("kind")] = true
	var added := 0
	for p in for_platform(where, detect(where)):
		if have.has(p.kind):
			continue
		identity.install_platform_provider(p)
		added += 1
	return added
