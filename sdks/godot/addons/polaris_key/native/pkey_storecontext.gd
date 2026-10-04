class_name PKeyStoreContext
extends PKeyNativeFacade
## Microsoft Store updates for an MSIX build (P5-07; notes/S-11 §4.4, §8; notes/E3 §A1.3): the
## facade over `PKeyStoreContextNative`, the C++/WinRT part of the Windows GDExtension. It is the
## only updater a Store MSIX may run.
##
##   package_identity()     {packaged, full_name, rc}: GetCurrentPackageFullName (rc 15700 is
##                          APPMODEL_ERROR_NO_PACKAGE: not packaged)
##   updates()              a coroutine: {count, mandatory, updates: [{package, version,
##                          mandatory}]} from GetAppAndOptionalStorePackageUpdatesAsync
##   download_and_install(silent)  a coroutine: RequestDownloadAndInstallStorePackageUpdatesAsync
##                          (the OS consent dialog, owned by the game window), or with `silent`
##                          TrySilentDownloadAndInstallStorePackageUpdatesAsync after
##                          CanSilentlyDownloadStorePackageUpdates; {state, …}
##   install_and_relaunch(_)  P3-10's hook (PKeyMsStoreAdapter): the consent-dialog install
##
## Every StoreContext call runs on an MTA worker thread (a blocking `.get()` is not allowed on the
## STA main thread) after IInitializeWithWindow with the game window's handle
## (DisplayServer.window_get_native_handle(WINDOW_HANDLE)). Without package identity, and for the
## HRESULTs an install that is not Store-associated answers (0x803F6101, 0x803F6107, 0x80070002),
## the answer is `unsupported` (`runtime`: not a Store install), never "no update".
##
## Config keys beyond the base ones: `window_handle` (int, overrides the DisplayServer handle;
## tests), `timeout_s` (default 120 for a query; none for an install).

const NATIVE_CLASS := "PKeyStoreContextNative"
## APPMODEL_ERROR_NO_PACKAGE.
const NO_PACKAGE := 15700
## What StoreContext answers outside a Store-associated package (notes/S-11 §4.4).
const NOT_STORE_HRESULTS := ["0x803F6101", "0x803F6107", "0x80070002"]


func id() -> String:
	return "storecontext"


func required_platform() -> String:
	return PKeyConstants.Platform.WINDOWS


func default_native_class() -> String:
	return NATIVE_CLASS


func _check_library() -> PKeyResult:
	var p := package_identity()
	if not p.get("packaged", false):
		return unsupported(PKeyConstants.UnsupportedReason.RUNTIME, "Not a Store install: this process has no package identity (GetCurrentPackageFullName answered %s)." % str(p.get("rc", "")))
	return PKeyResult.success()


func package_identity() -> Dictionary:
	var n := _native()
	if n == null or not n.has_method("package_identity"):
		return {"packaged": false}
	var d = n.call("package_identity")
	return d if d is Dictionary else {"packaged": false}


func window_handle() -> int:
	if config.has("window_handle"):
		return int(config["window_handle"])
	if DisplayServer.get_name() == "headless":
		return 0
	return DisplayServer.window_get_native_handle(DisplayServer.WINDOW_HANDLE)


## The Store's package updates for this app. A coroutine.
func updates() -> PKeyResult:
	return await _request("updates", false, float(config.get("timeout_s", 120.0)))


## Download and install every pending update. A coroutine.
func download_and_install(silent := false) -> PKeyResult:
	return await _request("download_and_install", silent, 0.0)


func can_silently_download() -> PKeyResult:
	return await _request("can_silently_download", false, float(config.get("timeout_s", 120.0)))


func check_now(_feed_url: String) -> int:
	var r := await updates()
	return succeeded() if r.ok else failed(r)


func install_and_relaunch(_feed_url: String) -> int:
	var r := await download_and_install(false)
	if r.ok and String(r.detail.get("state", "")) in ["completed", "none"]:
		return succeeded()
	return failed(r if not r.ok else PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "StoreContext: the install ended %s." % String(r.detail.get("state", "")), r.detail))


func _request(op: String, silent: bool, timeout_s: float) -> PKeyResult:
	var a := availability()
	if not a.ok:
		return a
	var request := int(_native().call("request_async", op, window_handle(), silent))
	if request < 0:
		return PKeyResult.failure(PKeyErrors.INVALID_OPTIONS, "StoreContext: unknown operation %s." % op)
	var got := await wait_event(["store_result"], request, timeout_s)
	if got["event"] == "timeout":
		return PKeyResult.failure(PKeyErrors.TIMEOUT, "StoreContext: %s did not answer." % op)
	return interpret(got["detail"])


## A native `store_result` as a PKeyResult (pure: the device-free tests drive it).
static func interpret(d: Dictionary) -> PKeyResult:
	if d.get("ok", false):
		return PKeyResult.success(d)
	var hr := String(d.get("hresult", "")).to_upper().replace("0X", "0x")
	if NOT_STORE_HRESULTS.has(hr) or int(d.get("rc", 0)) == NO_PACKAGE:
		return unsupported(PKeyConstants.UnsupportedReason.RUNTIME, "Not a Store install: StoreContext answered %s." % (hr if hr != "" else str(d.get("rc"))))
	return PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "StoreContext %s failed: %s %s" % [String(d.get("op", "")), hr, String(d.get("message", ""))], d)
