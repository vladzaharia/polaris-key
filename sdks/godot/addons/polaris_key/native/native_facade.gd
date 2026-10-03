class_name PKeyNativeFacade
extends RefCounted
## The GDScript side of one desktop update plugin (P5-07; README §5.10): PKeySparkle,
## PKeyVelopack, PKeyWinSparkle and PKeyStoreContext extend it. A facade works with no native
## library: every call then answers the typed unsupported result (`unsupported`, `detail.reason`
## `runtime` on the wrong OS, `dependency` when the GDExtension or the updater library it loads is
## missing), so a game boots whatever is installed.
##
## A facade is also the `native` object P3-10's PKeyNativeBridge calls when no Engine singleton
## stands in: `is_available()`, `check_now(feed_url) -> int` and `install_and_relaunch(feed_url)
## -> int` (OK on success; the last may be a coroutine). The bridge builds it with the updater's
## env and a config Dictionary:
##
##   headers   Dictionary, or a Callable returning one: sent with every request the updater makes
##             (the bearer for an `entitled` feed; Sparkle and the HTTP stacks drop it across
##             origins, notes/S-11 §5.2)
##   channels  PackedStringArray: the channels a Sparkle appcast item may carry
##   quit      Callable: how the game quits when an updater asks (PKeyUpdaterEnv.quit)
##   …         the facade's own keys (see each class)
##
## The facades trust P3-10's outlet decision: none of them decides whether this build may update
## itself (a store build never reaches one). Native callbacks reach GDScript through
## `call_deferred`, on the main thread, as `native_event(event, detail)`; each facade re-emits
## them as `event`.

## Every native event (`update_found`, `progress`, `shutdown_request`, …) with its detail.
signal event(name: String, detail: Dictionary)

## The env the facade reads the platform, the executable and the files through, and quits with.
var env: PKeyUpdaterEnv
var config: Dictionary = {}
## The native object (a GDExtension class instance, or a test's stand-in); built on first use.
var native: Object = null
## The GDExtension class this facade instantiates when `native` is null. Tests point it at a
## class that does not exist to simulate a missing library.
var native_class := ""
## Why the last check_now() or install_and_relaunch() answered FAILED (null after OK): P3-10's
## bridge reports this typed result instead of "answered 1".
var last_result: PKeyResult = null

var _connected := false


func _init(p_env: PKeyUpdaterEnv = null, p_config: Dictionary = {}) -> void:
	env = p_env if p_env != null else PKeyUpdaterEnv.new()
	config = p_config
	native_class = default_native_class()


## The updater's name (`sparkle`, `velopack`, `winsparkle`, `storecontext`).
func id() -> String:
	return ""


## The OS family the plugin runs on (`macos` or `windows`).
func required_platform() -> String:
	return ""


func default_native_class() -> String:
	return ""


## Whether the updater can be used here: OK, or the typed unsupported result saying why.
func availability() -> PKeyResult:
	var p := env.platform()
	if p != required_platform():
		return unsupported(PKeyConstants.UnsupportedReason.RUNTIME, "The %s plugin runs on %s, not %s." % [id(), required_platform(), p if p != "" else "this platform"])
	if _native() == null:
		return unsupported(PKeyConstants.UnsupportedReason.DEPENDENCY, "The %s GDExtension (%s) is not installed in this build." % [id(), native_class])
	return _check_library()


func is_available() -> bool:
	return availability().ok


## The native side's own dependency check (the updater library it loads). OK by default.
func _check_library() -> PKeyResult:
	return PKeyResult.success()


## P3-10's bridge entry points. Subclasses override; the base answers FAILED.
func check_now(_feed_url: String) -> int:
	return failed(availability())


func install_and_relaunch(_feed_url: String) -> int:
	return failed(availability())


## Record why an entry point fails and answer FAILED (`r` OK means "no reason recorded").
func failed(r: PKeyResult) -> int:
	last_result = r if r != null and not r.ok else PKeyResult.failure(PKeyErrors.UNSUPPORTED, "%s did not complete." % id(), {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": PKeyConstants.UnsupportedReason.RUNTIME})
	return FAILED


## Answer OK and clear last_result.
func succeeded() -> int:
	last_result = null
	return OK


## https anywhere; plain http only on loopback (127.0.0.1, localhost, [::1]), as PKeyTransport.
static func feed_url_allowed(url: String) -> bool:
	if url.begins_with("https://"):
		return true
	for p in ["http://127.0.0.1:", "http://127.0.0.1/", "http://localhost:", "http://localhost/", "http://[::1]:", "http://[::1]/"]:
		if url.begins_with(p):
			return true
	return false


# ── Helpers ──────────────────────────────────────────────────────────────────────────────────

static func unsupported(reason: String, text: String) -> PKeyResult:
	return PKeyResult.unsupported(PKeyConstants.Feature.UPDATE_DRIVER, reason, text)


## The config's headers, resolved now (a Callable is called each time: the bearer may change).
func headers() -> Dictionary:
	var h = config.get("headers", {})
	if h is Callable:
		h = h.call() if h.is_valid() else {}
	return h.duplicate() if h is Dictionary else {}


func channels() -> PackedStringArray:
	var c = config.get("channels", PackedStringArray())
	return PackedStringArray(c) if (c is PackedStringArray or c is Array) else PackedStringArray()


## Ask the game to quit (an updater is about to replace or relaunch it).
func quit() -> void:
	var q = config.get("quit")
	if q is Callable and q.is_valid():
		q.call()
	else:
		env.quit()


## The directory of the running executable (where the Windows plugins load their DLLs from).
func exe_dir() -> String:
	return env.executable_path().get_base_dir()


func _native() -> Object:
	if native == null and native_class != "" and ClassDB.class_exists(native_class) and ClassDB.can_instantiate(native_class):
		native = ClassDB.instantiate(native_class)
	if native != null and not _connected and native.has_signal("native_event"):
		native.connect("native_event", _on_native_event)
		_connected = true
	return native


func _on_native_event(name: String, detail: Variant) -> void:
	var d: Dictionary = detail if detail is Dictionary else {}
	_handle_event(name, d)
	event.emit(name, d)


## Subclasses react to native events here (quit on a shutdown request, …).
func _handle_event(_name: String, _detail: Dictionary) -> void:
	pass


## Wait for the native event `names` carrying `request` (or any request when -1), at most
## `timeout_s` seconds (0: no limit). {event, detail}, or {event: "timeout", detail: {}}.
func wait_event(names: Array, request := -1, timeout_s := 0.0) -> Dictionary:
	var waiter := _Waiter.new(names, request)
	var n := _native()
	if n == null or not n.has_signal("native_event"):
		return {"event": "timeout", "detail": {}}
	n.connect("native_event", waiter.on_event)
	var tree := Engine.get_main_loop() as SceneTree
	if timeout_s > 0.0 and tree != null:
		tree.create_timer(timeout_s).timeout.connect(waiter.on_timeout)
	if not waiter.finished:
		await waiter.done
	if n.is_connected("native_event", waiter.on_event):
		n.disconnect("native_event", waiter.on_event)
	return waiter.result


class _Waiter extends RefCounted:
	signal done
	var names: Array
	var request: int
	var finished := false
	var result := {"event": "timeout", "detail": {}}

	func _init(p_names: Array, p_request: int) -> void:
		names = p_names
		request = p_request

	func on_event(name: String, detail: Variant) -> void:
		if finished or not names.has(name):
			return
		var d: Dictionary = detail if detail is Dictionary else {}
		if request >= 0 and int(d.get("request", -1)) != request:
			return
		finished = true
		result = {"event": name, "detail": d}
		done.emit()

	func on_timeout() -> void:
		if finished:
			return
		finished = true
		done.emit()
