class_name PKeyWinSparkle
extends PKeyNativeFacade
## WinSparkle on Windows (P5-07; notes/S-11 §4.3, §8): the facade over `PKeyWinSparkleNative`, in
## the Windows GDExtension. The extension loads `WinSparkle.dll` from beside the executable at run
## time, so without it every call is `unsupported` (`dependency`).
##
##   start(appcast_url)     set the appcast (P3-09's `…/update/<channel>/winsparkle.xml`), the
##                          EdDSA public key, the app details, the headers, automatic checks off
##                          and every callback, then win_sparkle_init (once per process). Refuses
##                          without a public key (`invalid-options`): WinSparkle would accept an
##                          unsigned installer
##   check_now(url)         WinSparkle's "Check for updates" dialog
##   install_and_relaunch(url)  check, download, verify EdDSA and run the installer with the
##                          feed's `sparkle:installerArguments` (the build's `format` must be set
##                          for the Worker to emit them); WinSparkle asks the game to quit
##   check_silently()       a check without UI (`did_find_update` / `did_not_find_update`)
##
## The headers are set again before every check (WinSparkle's clear/set calls), so a rotated
## bearer reaches the next request; a check already running keeps the ones it started with.
## WinSparkle calls back on its own threads; the extension defers every callback to the main
## thread. `shutdown_request` quits the game (the installer needs the files); the extension calls
## win_sparkle_cleanup when it unloads.
##
## Config keys beyond the base ones: `public_key` (the base64 Ed25519 key, the same one Sparkle
## uses; the bridge passes PKeyOptions.update_eddsa_public_key), `company` and `app` (WinSparkle's
## registry key `HKCU\Software\<company>\<app>\WinSparkle`; default `PolarisKey` and the product),
## `version` (default the running version), `library` (default `WinSparkle.dll` beside the
## executable).

const NATIVE_CLASS := "PKeyWinSparkleNative"
const LIBRARY := "WinSparkle.dll"

var _loaded := false
var _started := false


func id() -> String:
	return "winsparkle"


func required_platform() -> String:
	return PKeyConstants.Platform.WINDOWS


func default_native_class() -> String:
	return NATIVE_CLASS


func library_path() -> String:
	return String(config.get("library", exe_dir().path_join(LIBRARY)))


func _check_library() -> PKeyResult:
	if _loaded:
		return PKeyResult.success()
	if not library_path().is_absolute_path():
		return unsupported(PKeyConstants.UnsupportedReason.DEPENDENCY, "The WinSparkle library path must be absolute: %s" % library_path())
	var r = _native().call("load", library_path())
	var d: Dictionary = r if r is Dictionary else {}
	if not d.get("ok", false):
		return unsupported(PKeyConstants.UnsupportedReason.DEPENDENCY, "%s could not be loaded (%s)." % [library_path(), str(d.get("win32", d.get("message", "")))])
	_loaded = true
	return PKeyResult.success()


func start(appcast_url: String) -> PKeyResult:
	var a := availability()
	if not a.ok:
		return a
	if _started:
		return PKeyResult.success({"already_started": true})
	var pub := String(config.get("public_key", ""))
	if pub == "":
		var text := "WinSparkle needs the EdDSA public key (PKeyOptions.update_eddsa_public_key): without it an unsigned installer would be accepted."
		push_error("Polaris Key: " + text)
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, text, {"error": "missing_public_key"})
	if appcast_url == "":
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "No WinSparkle appcast URL (discovery names no update.endpoints.winsparkle).")
	if not feed_url_allowed(appcast_url):
		return PKeyResult.failure(PKeyErrors.INSECURE_BASE_URL, "WinSparkle's appcast must be https (plain http only on loopback): %s" % appcast_url)
	var company := String(config.get("company", "PolarisKey"))
	var app := String(config.get("app", "Game"))
	var version := String(config.get("version", ProjectSettings.get_setting("application/config/version", "")))
	var r = _native().call("start", appcast_url, pub, company, app, version, headers())
	var d: Dictionary = r if r is Dictionary else {}
	if d.get("ok", false):
		_started = true
		return PKeyResult.success(d)
	if String(d.get("error", "")).begins_with("dependency"):
		return unsupported(PKeyConstants.UnsupportedReason.DEPENDENCY, "WinSparkle.dll lacks a function this plugin needs (%s)." % String(d.get("message", d.get("error"))))
	return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "WinSparkle did not start: %s" % String(d.get("error", "")), d)


func check_now(appcast_url: String) -> int:
	return _check(appcast_url, "ui")


func install_and_relaunch(appcast_url: String) -> int:
	return _check(appcast_url, "install")


func check_silently() -> int:
	if not _started:
		return FAILED
	_refresh_headers()
	_native().call("check", "silent")
	return OK


func _check(appcast_url: String, mode: String) -> int:
	var r := start(appcast_url)
	if not r.ok:
		return failed(r)
	_refresh_headers()
	_native().call("check", mode)
	return succeeded()


## The headers again before each check, so a rotated bearer is used. WinSparkle applies them to
## its next request; a check already running keeps the headers it started with.
func _refresh_headers() -> void:
	var n := _native()
	if n != null and n.has_method("set_headers"):
		n.call("set_headers", headers())


func _handle_event(name: String, _detail: Dictionary) -> void:
	if name == "shutdown_request":
		quit()
