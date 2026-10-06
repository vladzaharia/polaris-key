class_name PKeyKeyringBackend
extends RefCounted
## One OS credential store for the desktop keyring store (SP-27; PKeyKeyringStore): the port of
## Kotlin's `KeyringBackend` and Python's `keyring` calls (UK-40, P1b-09).
##
##   macOS    PKeyMacKeychainBackend    the login keychain through PolarisKeyApple's desktop build
##                                      (libpkey_apple.dylib, native/macos/build_apple.sh)
##   Windows  PKeyWinCredBackend        Credential Manager through pkey_win.dll
##                                      (PKeyWinCredentialNative, native/windows/credman/)
##   Linux    PKeySecretServiceBackend  the Secret Service through `secret-tool` (libsecret-tools)
##
## Every call answers a Dictionary: {ok: true, value} for get_secret (value null when there is no
## entry), {ok: true} for set and delete, or {ok: false, error: String}. A missing entry is never
## an error; a delete of a missing entry is success. Nothing here throws, prints or retries: the
## store decides what a failure means and surfaces it.

## Why this keyring cannot be used here ("" when it can). Selects the OS piece and reads nothing
## from the keyring, so the store and status() can ask cheaply.
func unavailable() -> String:
	return "no OS keyring backend"


## A short name for messages and status details ("keychain", "credential-manager", ...).
func id() -> String:
	return "none"


func get_secret(_service: String, _account: String) -> Dictionary:
	return {"ok": false, "error": unavailable()}


func set_secret(_service: String, _account: String, _secret: String) -> Dictionary:
	return {"ok": false, "error": unavailable()}


func delete_secret(_service: String, _account: String) -> Dictionary:
	return {"ok": false, "error": unavailable()}


## The backend for this desktop OS (`platform` "" means PKeyHeaders.platform()); the base class
## (always unavailable) elsewhere.
static func for_platform(platform := "") -> PKeyKeyringBackend:
	var p := platform if platform != "" else PKeyHeaders.platform()
	match p:
		PKeyConstants.Platform.MACOS:
			return PKeyMacKeychainBackend.new()
		PKeyConstants.Platform.WINDOWS:
			return PKeyWinCredBackend.new()
		PKeyConstants.Platform.LINUX:
			return PKeySecretServiceBackend.new()
	return PKeyKeyringBackend.new()
