class_name PKeyVelopack
extends PKeyNativeFacade
## Velopack on Windows (P5-07; notes/S-11 §4.2, §8): the facade over `PKeyVelopackNative`, in the
## Windows GDExtension (sdks/godot/native/windows/). The extension loads `velopack_libc.dll` from
## beside the executable at run time, so a missing DLL is a `dependency` answer and never unloads
## the WinSparkle and StoreContext backends that share the extension.
##
## A Velopack install runs P5-07's launcher shim as `--mainExe` (`<Game>.exe`), which answers the
## `--veloapp-*` hooks without starting the engine and then starts `<game>_godot.exe` beside it.
##
##   open(feed_url)        an UpdateManager over the feed directory (P3-09's
##                         `…/update/<channel>/velopack/`; Velopack appends
##                         `releases.<velopackChannel>.json` and resolves each bare `FileName`
##                         against it, which the Worker answers with a 302 to the package),
##                         with the headers through vpkc_new_source_http_url_with_options
##                         (Velopack sends none otherwise). Not installed by Velopack:
##                         `unsupported` (`runtime`)
##   check()               a coroutine: {status: available | none | remote_empty, target,
##                         deltas, …} on a worker thread
##   download()            a coroutine: the delta or full package, on a worker thread;
##                         `progress` events carry {percent}
##   apply_on_exit()       Update.exe waits for this process to exit, applies, restarts the shim;
##                         the facade quits the game at once
##   install_and_relaunch(feed_url)  all of the above (P3-10's hook)
##
## Config keys beyond the base ones: `library` (the DLL path; default `velopack_libc.dll` beside
## the executable), `timeout_s` (the check's limit, default 60).

const NATIVE_CLASS := "PKeyVelopackNative"
const LIBRARY := "velopack_libc.dll"

var _opened_url := ""
var _loaded := false


func id() -> String:
	return "velopack"


func required_platform() -> String:
	return PKeyConstants.Platform.WINDOWS


func default_native_class() -> String:
	return NATIVE_CLASS


func library_path() -> String:
	return String(config.get("library", exe_dir().path_join(LIBRARY)))


func _check_library() -> PKeyResult:
	if not _loaded:
		var r = _native().call("load_library", library_path())
		var d: Dictionary = r if r is Dictionary else {}
		if not d.get("ok", false):
			return unsupported(PKeyConstants.UnsupportedReason.DEPENDENCY, "%s could not be loaded (%s)." % [library_path(), str(d.get("win32", d.get("message", "")))])
		_loaded = true
	if not PKeySidecarSwap.is_velopack(env, env.executable_path()):
		return unsupported(PKeyConstants.UnsupportedReason.RUNTIME, "This build was not installed by Velopack (no Update.exe above it, no sq.version beside it).")
	return PKeyResult.success()


## An UpdateManager for `feed_url`: {current_version, app_id, portable} on success.
func open(feed_url: String) -> PKeyResult:
	var a := availability()
	if not a.ok:
		return a
	if feed_url == "":
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "No Velopack feed URL (discovery names no update.endpoints.velopack).")
	var r = _native().call("open", feed_url, headers())
	var d: Dictionary = r if r is Dictionary else {}
	if d.get("ok", false):
		_opened_url = feed_url
		return PKeyResult.success(d)
	if String(d.get("error", "")) == "not_installed":
		return unsupported(PKeyConstants.UnsupportedReason.RUNTIME, "Velopack: %s" % String(d.get("message", "not installed")))
	return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "Velopack could not open %s: %s" % [feed_url, String(d.get("message", d.get("error", "")))], d)


## Ask the feed: {status, target, base, deltas, is_downgrade}. A coroutine.
func check() -> PKeyResult:
	if _opened_url == "":
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Velopack: open() first.")
	var request := int(_native().call("check_async"))
	if request < 0:
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "Velopack: a check or download is already running.")
	var got := await wait_event(["checked"], request, float(config.get("timeout_s", 60.0)))
	if got["event"] == "timeout":
		return PKeyResult.failure(PKeyErrors.TIMEOUT, "Velopack: the check did not answer.")
	var d: Dictionary = got["detail"]
	if String(d.get("status", "")) == "error":
		return PKeyResult.failure(PKeyErrors.NETWORK, "Velopack: %s" % String(d.get("message", "")), d)
	return PKeyResult.success(d)


## Download the update the last check() found. A coroutine; `progress` events meanwhile.
func download() -> PKeyResult:
	var request := int(_native().call("download_async"))
	if request < 0:
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "Velopack: nothing to download, or a download is already running.")
	var got := await wait_event(["downloaded", "download_failed"], request)
	var d: Dictionary = got["detail"]
	if got["event"] != "downloaded":
		return PKeyResult.failure(PKeyErrors.NETWORK, "Velopack: %s" % String(d.get("message", "download failed")), d)
	return PKeyResult.success(d)


## Hand the downloaded update to Update.exe and quit; it applies and (with `restart`) starts the
## shim again.
func apply_on_exit(restart := true) -> PKeyResult:
	var r = _native().call("apply_on_exit", restart)
	var d: Dictionary = r if r is Dictionary else {}
	if not d.get("ok", false):
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "Velopack: %s" % String(d.get("message", d.get("error", "apply failed"))), d)
	quit()
	return PKeyResult.success(d)


## Velopack has no UI of its own: a check (OK when it answered).
func check_now(feed_url: String) -> int:
	if _opened_url != feed_url and not open(feed_url).ok:
		return FAILED
	var c := await check()
	return OK if c.ok else FAILED


## Open, check, download, apply on exit and quit (P3-10's hook). A coroutine; FAILED when the
## feed has no update (the adapter then opens the build's download link).
func install_and_relaunch(feed_url: String) -> int:
	if _opened_url != feed_url and not open(feed_url).ok:
		return FAILED
	var c := await check()
	if not c.ok or String(c.detail.get("status", "")) != "available":
		return FAILED
	var d := await download()
	if not d.ok:
		return FAILED
	return OK if apply_on_exit(true).ok else FAILED
