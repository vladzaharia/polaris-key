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
##                            relaunches the game
##   feed_url                 the feed the native updater reads, from this session's discovery
##                            (P3-09's routes: the appcast, WinSparkle's XML, Velopack's
##                            directory, …)
##
## The native side (P5-07) is an Engine singleton named `singleton_name()` with
## `is_available() -> bool` (optional), `check_now(feed_url: String) -> int` and
## `install_and_relaunch(feed_url: String) -> int`, each answering OK (0) or `true` on success.
## Tests inject any object with those methods as `native`.

var env: PKeyUpdaterEnv
## The feed URL from discovery ("" when this session has none).
var feed_url := ""
## The native object to call instead of the Engine singleton (tests, a custom plugin).
var native: Object = null


func _init(p_env: PKeyUpdaterEnv = null, p_feed_url := "") -> void:
	env = p_env if p_env != null else PKeyUpdaterEnv.new()
	feed_url = p_feed_url


## The mechanism's name (`sparkle`, `velopack`, `winsparkle`, `appimage`).
func id() -> String:
	return ""


## The Engine singleton P5-07's plugin registers.
func singleton_name() -> String:
	return ""


func _native() -> Object:
	if native != null:
		return native
	return env.native_singleton(singleton_name()) if singleton_name() != "" else null


func is_available() -> bool:
	var n := _native()
	if n == null:
		return false
	if not n.has_method("is_available"):
		return true
	var a = n.call("is_available")
	return a is bool and a


func check_now() -> PKeyApplyResult:
	return _forward("check_now")


func install_and_relaunch() -> PKeyApplyResult:
	return _forward("install_and_relaunch")


func _forward(method: String) -> PKeyApplyResult:
	if not is_available():
		return PKeyApplyResult.missing_dependency(id())
	var n := _native()
	if not n.has_method(method):
		return PKeyApplyResult.missing_dependency(id())
	var got = n.call(method, feed_url)
	if (got is int and got == OK) or (got is bool and got):
		return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": id(), "method": "native"})
	return PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "%s.%s answered %s." % [id(), method, str(got)], {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": "runtime", "bridge": id()})
