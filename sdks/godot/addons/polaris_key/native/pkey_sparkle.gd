class_name PKeySparkle
extends PKeyNativeFacade
## Sparkle 2 on macOS (P5-07; notes/S-11 §4.1, §8): the facade over `PKeySparkleNative`, the
## GDExtension in sdks/godot/native/macos/ that weak-links Sparkle.framework and drives
## `SPUStandardUpdaterController` on the main thread.
##
##   start(feed_url)         create the updater (once): refuses off the main thread, without
##                           Sparkle.framework (`dependency`) and without SUPublicEDKey in the
##                           bundle's Info.plist (`invalid-options`: Sparkle would otherwise
##                           accept unsigned updates; SparkleAnchor.swift's rule)
##   check_now(feed_url)     Sparkle's own "Check for Updates…" UI; it downloads, verifies the
##                           EdDSA signature, installs and relaunches when the player agrees
##   check_in_background()   a silent check (Sparkle shows UI only when it finds something)
##   set_automatically_checks(on), set_automatically_downloads(on), state()
##
## The feed URL comes from discovery (the updater passes PolarisKey.update.appcast_url()) through
## SPUUpdaterDelegate, so SUFeedURL in Info.plist is only a fallback; the headers carry the bearer
## for an `entitled` feed; `channels` are the appcast channels the player may see. The facade
## never verifies an update itself: SUPublicEDKey in the signed bundle is the only anchor.
##
## Config keys beyond the base ones: `mode`: `standard` (the default, what a game ships) or
## `headless` (an auto-accepting user driver that installs every update without asking): TEST
## ONLY, refused unless the process environment sets PKEY_SPARKLE_HEADLESS=1, which only the
## end-to-end runs do.
##
## When Sparkle relaunches it terminates the app through AppKit, which Godot turns into
## NOTIFICATION_WM_CLOSE_REQUEST; a game with `auto_accept_quit` off must quit on `will_relaunch`
## (the facade does so itself when the tree does not auto-accept).

const NATIVE_CLASS := "PKeySparkleNative"
## The environment flag the headless mode needs (the native side checks it too): only the
## end-to-end runs set it.
const HEADLESS_ENV := "PKEY_SPARKLE_HEADLESS"

var _started := false


func id() -> String:
	return "sparkle"


func required_platform() -> String:
	return PKeyConstants.Platform.MACOS


func default_native_class() -> String:
	return NATIVE_CLASS


func _check_library() -> PKeyResult:
	var info := bundle_info()
	if not info.get("sparkle_loaded", false):
		return unsupported(PKeyConstants.UnsupportedReason.DEPENDENCY, "Sparkle.framework is not in Contents/Frameworks.")
	return PKeyResult.success()


## The running bundle as Sparkle sees it: {path, version, short, has_public_key, feed_url,
## sparkle_loaded, main_thread}; {} without the plugin.
func bundle_info() -> Dictionary:
	var n := _native()
	if n == null or not n.has_method("bundle_info"):
		return {}
	var d = n.call("bundle_info")
	return d if d is Dictionary else {}


## Create the updater for `feed_url` (once; later calls update the feed URL and headers).
func start(feed_url := "") -> PKeyResult:
	var a := availability()
	if not a.ok:
		return a
	var n := _native()
	if _started:
		if feed_url != "" and n.has_method("set_feed_url"):
			n.call("set_feed_url", feed_url)
		if n.has_method("set_http_headers"):
			n.call("set_http_headers", headers())
		return PKeyResult.success({"already_started": true})
	var mode := String(config.get("mode", "standard"))
	if mode == "headless" and OS.get_environment(HEADLESS_ENV) != "1":
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "Sparkle's headless mode installs every update without asking and exists for unattended tests only: set %s=1 to use it." % HEADLESS_ENV, {"error": "headless_not_allowed"})
	var r = n.call("start", mode, feed_url, headers(), channels())
	var d: Dictionary = r if r is Dictionary else {}
	if d.get("ok", false):
		_started = true
		return PKeyResult.success(d)
	match String(d.get("error", "")):
		"dependency":
			return unsupported(PKeyConstants.UnsupportedReason.DEPENDENCY, String(d.get("message", "Sparkle.framework is not loaded.")))
		"missing_public_key":
			var text := "SUPublicEDKey is missing from the bundle's Info.plist: Sparkle would accept unsigned updates. Set polaris_key/sparkle/public_ed_key (or PKeyOptions.update_eddsa_public_key) and export again."
			push_error("Polaris Key: " + text)
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, text, d)
		"not_main_thread":
			return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "Sparkle must be started on the main thread.", d)
	return PKeyResult.failure(PKeyErrors.UNSUPPORTED, "Sparkle did not start: %s" % String(d.get("message", d.get("error", "unknown"))), {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": PKeyConstants.UnsupportedReason.RUNTIME, "detail": d})


func check_now(feed_url: String) -> int:
	var r := start(feed_url)
	if not r.ok:
		return failed(r)
	_native().call("check_for_updates")
	return succeeded()


## Sparkle installs and relaunches from its own "update found" flow, so this is check_now().
func install_and_relaunch(feed_url: String) -> int:
	return check_now(feed_url)


func check_in_background() -> int:
	if not _started:
		return FAILED
	_native().call("check_in_background")
	return OK


func set_automatically_checks(on: bool) -> void:
	if _started:
		_native().call("set_automatically_checks", on)


func set_automatically_downloads(on: bool) -> void:
	if _started:
		_native().call("set_automatically_downloads", on)


## {started, can_check, session, feed_url, auto_checks, auto_downloads}.
func state() -> Dictionary:
	var n := _native()
	if n == null or not n.has_method("get_state"):
		return {"started": false}
	var d = n.call("get_state")
	return d if d is Dictionary else {"started": false}


func _handle_event(name: String, _detail: Dictionary) -> void:
	if name != "will_relaunch":
		return
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null and not tree.auto_accept_quit:
		quit()
