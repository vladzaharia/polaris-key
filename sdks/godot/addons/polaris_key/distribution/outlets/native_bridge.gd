class_name PKeyNativeBridge
extends RefCounted
## The GDScript interface in front of one native updater (README §5.10; P3-10's hook, P5-07's
## plugin). A bridge works with no plugin installed: every call then answers the typed unsupported
## result (`unsupported`, `detail.reason` `dependency`), and the direct adapter falls back to a
## download link, so a missing plugin never breaks boot.
##
##   is_available()           the plugin is installed and usable here
##   check_now()              ask the native updater to look for an update (its own UI)
##   install_and_relaunch()   hand the update to the native updater, which installs it and
##                            relaunches the game (AppImage refuses this generic hook; it needs
##                            PKeyUpdater.install_appimage(check) with the verified record)
##   feed_url                 the feed the native updater reads, from this session's discovery
##                            (P3-09's routes: the appcast, WinSparkle's XML, Velopack's
##                            directory, …)
##
## The native side is, in order: `native` when set (tests, a custom plugin); an Engine singleton
## named `singleton_name()`; else P5-07's GDScript facade (`make_facade()`: PKeySparkle,
## PKeyVelopack, PKeyWinSparkle, PKeyStoreContext under addons/polaris_key/native/), which drives
## the GDExtension when it is installed and answers `unsupported` when it is not. Each has
## `is_available() -> bool` (optional), `check_now(feed_url: String) -> int` and
## `install_and_relaunch(feed_url: String) -> int` (it may be a coroutine), answering OK (0) or
## `true` on success.

var env: PKeyUpdaterEnv
## The feed URL from discovery ("" when this session has none).
var feed_url := ""
## The native object to call instead of the Engine singleton (tests, a custom plugin).
var native: Object = null
## The headers the updater sends (a Callable returning them: PKeyUpdater.download_headers, so the
## bearer is read when the updater runs), the appcast channels it may show, and any facade keys
## (PKeyNativeFacade's config: `public_key`, `company`, `app`, `mode`, …).
var headers_source := Callable()
var channels := PackedStringArray()
var options := {}

var _facade: PKeyNativeFacade = null


func _init(p_env: PKeyUpdaterEnv = null, p_feed_url := "") -> void:
	env = p_env if p_env != null else PKeyUpdaterEnv.new()
	feed_url = p_feed_url


## The mechanism's name (`sparkle`, `velopack`, `winsparkle`, `appimage`).
func id() -> String:
	return ""


## The Engine singleton P5-07's plugin registers.
func singleton_name() -> String:
	return ""


## P5-07's facade for this mechanism, or null (AppImageUpdate needs none).
func make_facade() -> PKeyNativeFacade:
	return null


## The facade, configured from this bridge (built once).
func facade() -> PKeyNativeFacade:
	if _facade == null:
		var config := options.duplicate()
		config["headers"] = headers_source if headers_source.is_valid() else {}
		config["channels"] = channels
		config["quit"] = env.quit
		_facade = make_facade()
		if _facade != null:
			_facade.env = env
			_facade.config = config
	return _facade


func _native() -> Object:
	if native != null:
		return native
	var s := env.native_singleton(singleton_name()) if singleton_name() != "" else null
	if s != null:
		return s
	return facade()


func is_available() -> bool:
	var n := _native()
	if n == null:
		return false
	if not n.has_method("is_available"):
		return true
	var a = n.call("is_available")
	return a is bool and a


func check_now() -> PKeyApplyResult:
	return await _forward("check_now")


func install_and_relaunch() -> PKeyApplyResult:
	# This also covers custom native objects and Engine singletons that bypass the facade.
	if id() == "velopack":
		return PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "Velopack installation is disabled until the exact applied package can be verified against the pinned-key-signed release record (version, size and SHA-256).", {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": PKeyConstants.UnsupportedReason.RUNTIME, "bridge": id()})
	return await _forward("install_and_relaunch")


## A coroutine: the facade's methods may await (Velopack downloads before it applies).
func _forward(method: String) -> PKeyApplyResult:
	if not is_available():
		return _unavailable()
	var n := _native()
	if not n.has_method(method):
		return PKeyApplyResult.missing_dependency(id())
	var got = await n.call(method, feed_url)
	if (got is int and got == OK) or (got is bool and got):
		return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": id(), "method": "native"})
	# A facade says why (unsupported/product for a Velopack download refused twice, …).
	if n is PKeyNativeFacade and n.last_result != null and not n.last_result.ok:
		var lr: PKeyResult = n.last_result
		var d: Dictionary = lr.detail.duplicate() if lr.detail is Dictionary else {"detail": lr.detail}
		d["bridge"] = id()
		return PKeyApplyResult.failed(lr.code, lr.message, d)
	return PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "%s.%s answered %s." % [id(), method, str(got)], {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": "runtime", "bridge": id()})


## Why the native side is unusable: the facade's own answer (`runtime` on the wrong OS or in an
## install the updater cannot serve, `dependency` without the library), else `dependency`.
func _unavailable() -> PKeyApplyResult:
	var n := _native()
	if n is PKeyNativeFacade:
		var a: PKeyResult = n.availability()
		if not a.ok and a.detail is Dictionary:
			var d: Dictionary = a.detail.duplicate()
			d["bridge"] = id()
			return PKeyApplyResult.failed(a.code, a.message, d)
	return PKeyApplyResult.missing_dependency(id())
