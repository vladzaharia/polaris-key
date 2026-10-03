class_name PKeyAndroid
extends Node
## The GDScript facade over the Android platform plugin (P5-06; README §5.10): polaris-key-platform's
## install source, Keystore, Play In-App Updates and Play Asset Delivery (play builds), and the
## verified PackageInstaller self-update (direct builds), reached through the Godot Android plugin
## `PolarisKeyAndroid` (sdks/godot/native/android/; the AARs in addons/polaris_key/native/android/bin/).
##
## The plugin has ONE method, `cmd(json) -> String`. Asynchronous results and events are queued
## natively, from any thread, and drained HERE, on the main thread, once per frame (`_process`) or
## while a call is awaited; the signals are declared and emitted in GDScript, as PKeyApple does.
##
## Without the plugin every call answers the typed unsupported result (PKeyResult with
## `code == &"unsupported"`, PARITY §2.2): `detail.reason` is `runtime` off Android and `dependency`
## on an Android build without the plugin. It is `outlet` for In-App Updates on a direct build or
## an install Play did not make, for Play Asset Delivery on a direct build, and for the
## PackageInstaller self-update on a play build (Play forbids self-update).
##
##   var android := PKeyAndroid.shared()          # one per process, polled by the tree
##   var src := android.install_source()           # PKeyResult; detail {installer, initiator, …}
##   var r := await android.update_check()         # play: detail {availability, priority, …}
##   r = await android.update_start("flexible")    # Play's UI; progress as update_progress
##   r = await android.pack_fetch("foes")          # pack_progress until status 4, then:
##   r = android.pack_location("foes")             # detail.location.pck: mount it this launch
##   r = await android.apk_install(path, sha256, version_code)   # direct: verified, then commit
##
## Pack paths contain the versionCode: re-read them every launch and never persist them. A
## self-update kills the game and nothing relaunches it: the next launch reads the outcome
## (launch_install_outcome()).

## An In-App Updates install state (flexible flows; an immediate flow reports none):
## {installStatus, errorCode, bytesDownloaded, totalBytes}.
signal update_progress(state: Dictionary)
## The In-App Updates flow's activity result: `accepted`, `canceled`, `failed` or `unknown`.
signal update_result(result: String, code: int)
## A Play Asset Delivery state change: {name, status, errorCode, bytesDownloaded, totalBytes,
## transferPercent, needsConfirmation}.
signal pack_progress(name: String, state: Dictionary)
## A PackageInstaller status while the game runs: {status, name, message, session, otherPackage, …}.
signal install_status(status: Dictionary)
## The game's activity resumed: re-check In-App Updates (a downloaded flexible update, an
## interrupted immediate one).
signal resumed()

const SINGLETON := "PolarisKeyAndroid"
const PLAY_STORE := "com.android.vending"

## In-App Updates `UpdateAvailability` and `InstallStatus` values the callers branch on.
const AVAILABILITY_NOT_AVAILABLE := 1
const AVAILABILITY_AVAILABLE := 2
const AVAILABILITY_IN_PROGRESS := 3
const INSTALL_STATUS_DOWNLOADED := 11
## Play Asset Delivery `AssetPackStatus.COMPLETED`.
const PACK_COMPLETED := 4

## The platform this answers for ("" means PKeyHeaders.platform()). Tests set it.
var platform := ""
## The native object to call instead of the Engine singleton: anything with
## `cmd(json: String) -> String` (tests).
var native: Object = null
## The Engine singleton used when `native` is null. Tests point it at a missing one.
var singleton_name := SINGLETON
## How long an awaited call waits for its result.
var timeout_s := 30.0
## How long apk_install waits for the verify-and-commit result (a large APK streams into the session).
var install_timeout_s := 600.0

var _dropped := 0
var _caps: Variant = null
var _source: Variant = null

## Results of asynchronous requests, keyed "<native id>:<req>", SHARED by every instance (the
## native queue is one per process). Consumed by the awaiting call, or dropped after its timeout.
static var _results := {}
static var _abandoned := {}

static var _shared: PKeyAndroid = null
static var _launch_started := false
static var _launch_install: Variant = null
static var _launch_abandoned := 0


## The process's facade: created on first use and added to the scene tree (deferred), so
## `_process` drains the native queue every frame. Use this one instance in a game; other
## instances are for tests.
static func shared() -> PKeyAndroid:
	if _shared == null or not is_instance_valid(_shared):
		_shared = PKeyAndroid.new()
		_shared.name = "PKeyAndroid"
		var tree := Engine.get_main_loop() as SceneTree
		if tree != null and tree.root != null:
			tree.root.add_child.call_deferred(_shared)
	return _shared


func _ready() -> void:
	if self == _shared:
		start_launch_reads(self)


## The launch work (once per process; the shared instance runs it when it enters the tree):
## on a direct build, read and clear the previous self-update's outcome (the receiver journals it,
## usually in a process of the new version with no game running) and abandon stale
## PackageInstaller sessions, which otherwise count against the app (notes/S-10 §3).
static func start_launch_reads(android: PKeyAndroid = null) -> void:
	if _launch_started:
		return
	_launch_started = true
	if android == null:
		android = shared()
	if android.unsupported_reason() != "":
		return
	var caps := android.capabilities()
	if not (caps.ok and caps.detail.get("packageInstaller") == true):
		return
	var last := android.apk_last_install(true)
	_launch_install = last.detail.get("last") if last.ok else null
	var stale := android.apk_abandon_stale()
	_launch_abandoned = int(stale.detail.get("abandoned", 0)) if stale.ok else 0


## The previous self-update attempt's last journaled status ({event, status, name, session, …,
## at}), read at this launch; null when there was none or this is not a direct build.
static func launch_install_outcome() -> Variant:
	return _launch_install


## Stale PackageInstaller sessions abandoned at this launch.
static func launch_abandoned_sessions() -> int:
	return _launch_abandoned


## Forget this launch's reads (tests).
static func reset_launch() -> void:
	_launch_started = false
	_launch_install = null
	_launch_abandoned = 0


func _platform() -> String:
	return platform if platform != "" else PKeyHeaders.platform()


func _native_present() -> bool:
	return native != null or Engine.has_singleton(singleton_name)


## "" when the plugin can answer here, else the unsupported reason: `runtime` off Android,
## `dependency` on Android without the plugin.
func unsupported_reason() -> String:
	if native == null and _platform() != PKeyConstants.Platform.ANDROID:
		return PKeyConstants.UnsupportedReason.RUNTIME
	if not _native_present():
		return PKeyConstants.UnsupportedReason.DEPENDENCY
	return ""


func is_available() -> bool:
	return unsupported_reason() == ""


## PKeyResult.success() when the plugin works here, else the typed unsupported result for `feature`.
func availability(feature := PKeyConstants.Feature.OUTLET_DETECT) -> PKeyResult:
	var why := unsupported_reason()
	if why == PKeyConstants.UnsupportedReason.RUNTIME:
		return PKeyResult.unsupported(feature, why, "The Android platform plugin runs on Android, not %s." % (_platform() if _platform() != "" else "this platform"))
	if why == PKeyConstants.UnsupportedReason.DEPENDENCY:
		return PKeyResult.unsupported(feature, why, "The PolarisKeyAndroid plugin (polaris-key-platform and polaris-key-godot AARs) is not in this build.")
	return PKeyResult.success()


## In-App Updates here: success, or unsupported (`runtime`, `dependency`, or `outlet` on a direct
## build or an install Play did not make — the installing package is not com.android.vending).
func updates_availability() -> PKeyResult:
	var gate := availability(PKeyConstants.Feature.UPDATE_DRIVER)
	if not gate.ok:
		return gate
	if _cap("inAppUpdates") != true:
		return PKeyResult.unsupported(PKeyConstants.Feature.UPDATE_DRIVER, PKeyConstants.UnsupportedReason.OUTLET, "This is the direct build of the Android plugin: no Play In-App Updates.")
	var src := install_source()
	var installer = src.detail.get("installer") if src.ok and src.detail is Dictionary else null
	if installer != PLAY_STORE:
		return PKeyResult.unsupported(PKeyConstants.Feature.UPDATE_DRIVER, PKeyConstants.UnsupportedReason.OUTLET, "Play In-App Updates need an install made by Google Play (installer %s)." % str(installer))
	return PKeyResult.success()


## Play Asset Delivery here: success, or unsupported (`outlet` on a direct build).
func packs_availability() -> PKeyResult:
	var gate := availability(PKeyConstants.Feature.PACKS_TRANSPORT_PLAY)
	if not gate.ok:
		return gate
	if _cap("assetPacks") != true:
		return PKeyResult.unsupported(PKeyConstants.Feature.PACKS_TRANSPORT_PLAY, PKeyConstants.UnsupportedReason.OUTLET, "This is the direct build of the Android plugin: no Play Asset Delivery.")
	return PKeyResult.success()


## The PackageInstaller self-update here: success, or unsupported (`outlet` on a play build).
func installer_availability() -> PKeyResult:
	var gate := availability(PKeyConstants.Feature.UPDATE_DRIVER)
	if not gate.ok:
		return gate
	if _cap("packageInstaller") != true:
		return PKeyResult.unsupported(PKeyConstants.Feature.UPDATE_DRIVER, PKeyConstants.UnsupportedReason.OUTLET, "This is the play build of the Android plugin: Play forbids self-update.")
	return PKeyResult.success()


func _cap(key: String) -> Variant:
	if _caps == null:
		var r := call_sync({"op": "capabilities"})
		if not r.get("ok", false):
			return null
		_caps = r
	return _caps.get(key)


# ── Raw calls ────────────────────────────────────────────────────────────────────────────────

## One synchronous request: the native reply as a Dictionary, or {ok: false, unsupported: true,
## reason} without the plugin.
func call_sync(q: Dictionary) -> Dictionary:
	var why := unsupported_reason()
	if why != "":
		return {"ok": false, "unsupported": true, "reason": why}
	var target: Object = native if native != null else Engine.get_singleton(singleton_name)
	var raw = target.call("cmd", JSON.stringify(q))
	var json := JSON.new()
	if raw is String and json.parse(raw) == OK and json.data is Dictionary:
		return json.data
	return {"ok": false, "error": "bad_reply", "raw": str(raw)}


## One request awaited to its result: a synchronous reply as it is, or the result event carrying
## the asynchronous reply's `req` ({ok: false, error: "timeout"} after `timeout_s`).
func call_async(q: Dictionary, wait_s := -1.0) -> Dictionary:
	var r := call_sync(q)
	if not r.has("req") or not r.get("ok", false):
		return r
	var req := int(r["req"])
	var limit_ms := int((wait_s if wait_s >= 0.0 else timeout_s) * 1000.0)
	var t0 := Time.get_ticks_msec()
	var tree := Engine.get_main_loop() as SceneTree
	var key := _key(req)
	while not _results.has(key):
		poll()
		if _results.has(key):
			break
		if Time.get_ticks_msec() - t0 > limit_ms or tree == null:
			_abandoned[key] = true
			return {"ok": false, "error": "timeout", "req": req}
		await tree.process_frame
	var out: Dictionary = _results[key]
	_results.erase(key)
	return out


func _key(req: int) -> String:
	return "%d:%d" % [native.get_instance_id() if native != null else 0, req]


## Drain the native event queue: results go to their awaiting call, the rest become signals.
## The number of events drained.
func poll() -> int:
	if unsupported_reason() != "":
		return 0
	var r := call_sync({"op": "poll"})
	_dropped += int(r.get("dropped", 0))
	var events = r.get("events", [])
	if not (events is Array):
		return 0
	for ev in events:
		if not (ev is Dictionary):
			continue
		match str(ev.get("ev", "")):
			"result":
				var key := _key(int(ev.get("req", -1)))
				if _abandoned.has(key):
					_abandoned.erase(key)
				else:
					_results[key] = ev
			"update_state":
				update_progress.emit(_ints(ev, ["installStatus", "errorCode", "bytesDownloaded", "totalBytes"]))
			"update_result":
				update_result.emit(str(ev.get("result", "unknown")), int(ev.get("resultCode", 0)))
			"pack_state":
				pack_progress.emit(str(ev.get("name", "")), _ints(ev, ["status", "errorCode", "bytesDownloaded", "totalBytes", "transferPercent"]))
			"install_status":
				install_status.emit(_ints(ev, ["status", "session", "legacyStatus"]))
			"resumed":
				_source = null
				resumed.emit()
	return events.size()


## JSON numbers arrive as floats: the named fields back to int.
static func _ints(ev: Dictionary, keys: Array) -> Dictionary:
	var out := ev.duplicate()
	out.erase("ev")
	for k in keys:
		if out.get(k) is float:
			out[k] = int(out[k])
	return out


## Events the native queue dropped because nobody polled (it keeps the newest 1024).
func dropped_events() -> int:
	return _dropped


func _process(_delta: float) -> void:
	poll()


# ── Typed calls (each a PKeyResult; the native reply is `detail`) ─────────────────────────────

## The plugin's view of this process: {protocol, flavor, sdk, package, keystore, inAppUpdates,
## assetPacks, packageInstaller}.
func capabilities() -> PKeyResult:
	return _wrap(PKeyConstants.Feature.OUTLET_DETECT, call_sync({"op": "capabilities"}))


## RAW install-source facts (getInstallSourceInfo, API 30+; getInstallerPackageName below):
## {installer, initiator, initiatorCertSha256, initiatorSigners, packageSource, updateOwner,
## selfSigners, selfUpdated, versionCode, sdk, …}. Read once per launch (again after a resume).
## Mapping them to an outlet is PKeyOutlet.detect_outlet's job.
func install_source() -> PKeyResult:
	if _source == null:
		var r := call_sync({"op": "install_source"})
		if not r.get("ok", false):
			return _wrap(PKeyConstants.Feature.OUTLET_DETECT, r)
		_source = r
	return PKeyResult.success(_source)


## A Keystore-wrapped value of product `product`: detail {value (null when absent), reset}. `reset`
## is `key-missing` or `key-invalidated` when the key was lost and its values dropped (re-enrol).
func keystore_get(product: String, account: String) -> PKeyResult:
	return _wrap(PKeyConstants.Feature.CORE_STORE, call_sync({"op": "ks_get", "product": product, "account": account}), PKeyErrors.STORE_FAILED)


func keystore_set(product: String, account: String, value: String) -> PKeyResult:
	return _wrap(PKeyConstants.Feature.CORE_STORE, call_sync({"op": "ks_set", "product": product, "account": account, "value": value}), PKeyErrors.STORE_FAILED)


## detail.existed.
func keystore_delete(product: String, account: String) -> PKeyResult:
	return _wrap(PKeyConstants.Feature.CORE_STORE, call_sync({"op": "ks_delete", "product": product, "account": account}), PKeyErrors.STORE_FAILED)


## What protects the product's key: {alias, backend, exists, securityLevel, insideSecureHardware,
## strongBox, keySize}.
func keystore_info(product: String) -> PKeyResult:
	return _wrap(PKeyConstants.Feature.CORE_STORE, call_sync({"op": "ks_info", "product": product}), PKeyErrors.STORE_FAILED)


## What Play says (play builds installed by Play): detail {availability, availableVersionCode,
## installStatus, priority, stalenessDays, flexibleAllowed, immediateAllowed, bytesDownloaded,
## totalBytes, readyToComplete, inProgress}. ANY failure is `platform-error` with detail.error
## `unavailable` (without the Play Store it is an internal bind failure, not an install error code).
func update_check() -> PKeyResult:
	var gate := updates_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, await call_async({"op": "iau_check"}))


## Start Play's `flexible` or `immediate` flow on the last check: detail {started, reason,
## preconditions}. The outcome arrives as update_result; flexible progress as update_progress.
func update_start(type: String) -> PKeyResult:
	var gate := updates_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, await call_async({"op": "iau_start", "type": type}))


## Install a downloaded flexible update; Play restarts the game.
func update_complete() -> PKeyResult:
	var gate := updates_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, await call_async({"op": "iau_complete"}))


## One pack's state: detail.state {name, status, …}. One pack per call (one unknown name fails a
## whole Play batch).
func pack_status(name: String) -> PKeyResult:
	return await _pack_async({"op": "pad_state", "name": name})


## Request a pack. The reply only says Play accepted it (status PENDING); progress and completion
## arrive as pack_progress.
func pack_fetch(name: String) -> PKeyResult:
	return await _pack_async({"op": "pad_fetch", "name": name})


## Where the pack is NOW: detail.location {storageMethod, assetsPath, path, installTime, pck} or
## null. Mount `pck` (an absolute path) with ProjectSettings.load_resource_pack; `installTime`
## means the install-time pack (`res://`). Never persist it.
func pack_location(name: String) -> PKeyResult:
	var gate := packs_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.PACKS_TRANSPORT_PLAY, call_sync({"op": "pad_location", "name": name}))


func pack_remove(name: String) -> PKeyResult:
	return await _pack_async({"op": "pad_remove", "name": name})


## Cancel a pack's download: detail.state (null when Play has none).
func pack_cancel(name: String) -> PKeyResult:
	var gate := packs_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.PACKS_TRANSPORT_PLAY, call_sync({"op": "pad_cancel", "name": name}))


## Show Play's dialog for a pack WAITING_FOR_WIFI (7) or REQUIRES_USER_CONFIRMATION (9).
func pack_confirm() -> PKeyResult:
	return await _pack_async({"op": "pad_confirm"}, 600.0)


func _pack_async(q: Dictionary, wait_s := -1.0) -> PKeyResult:
	var gate := packs_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.PACKS_TRANSPORT_PLAY, await call_async(q, wait_s))


## Whether the user allowed installs from the game (direct builds): detail.canInstall.
func apk_can_install() -> PKeyResult:
	var gate := installer_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, call_sync({"op": "pi_can_install"}))


## Open the "install unknown apps" setting for the game.
func apk_open_settings() -> PKeyResult:
	var gate := installer_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, await call_async({"op": "pi_open_settings"}))


## Verify a downloaded APK in app-private storage without installing it: detail.verify {ok,
## refused: [hash_required, hash_mismatch, signer_mismatch, version_not_higher, …], sha256, …}.
## `version_code` < 0 skips the expected-versionCode check.
func apk_verify(path: String, sha256: String, version_code := -1) -> PKeyResult:
	var gate := installer_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, await call_async(_apk_query("pi_verify", path, sha256, version_code), 120.0))


## Verify, then commit a PackageInstaller session: detail {committed, session, applied, error,
## verify}. `options`: silent (default true), when_backgrounded (API 34+ gentle constraints),
## timeout_ms, prompt (default true: launch the system confirmation if one is needed). On success
## the game is killed and not relaunched; the next launch reads launch_install_outcome().
func apk_install(path: String, sha256: String, version_code := -1, options := {}) -> PKeyResult:
	var gate := installer_availability()
	if not gate.ok:
		return gate
	var q := _apk_query("pi_install", path, sha256, version_code)
	q["silent"] = bool(options.get("silent", true))
	q["whenBackgrounded"] = bool(options.get("when_backgrounded", false))
	q["prompt"] = bool(options.get("prompt", true))
	if options.has("timeout_ms"):
		q["timeoutMs"] = int(options["timeout_ms"])
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, await call_async(q, install_timeout_s))


## The last journaled install status (detail.last, null when none); `clear` removes it.
func apk_last_install(clear := false) -> PKeyResult:
	var gate := installer_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, call_sync({"op": "pi_last", "clear": clear}))


## Abandon this app's PackageInstaller sessions: detail.abandoned.
func apk_abandon_stale() -> PKeyResult:
	var gate := installer_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, call_sync({"op": "pi_abandon_stale"}))


## Whether GENTLE_UPDATE constraints hold now: detail.satisfied (null below API 34 or until the
## game is its own installer of record).
func apk_constraints() -> PKeyResult:
	var gate := installer_availability()
	if not gate.ok:
		return gate
	return _wrap(PKeyConstants.Feature.UPDATE_DRIVER, await call_async({"op": "pi_constraints"}))


static func _apk_query(op: String, path: String, sha256: String, version_code: int) -> Dictionary:
	var q := {"op": op, "path": path, "sha256": sha256}
	if version_code >= 0:
		q["versionCode"] = version_code
	return q


## A native reply as a PKeyResult: success with the reply as `detail`; `unsupported` with the
## reply's reason; `timeout`; else `fail_code` (platform-error) with the reply as `detail`.
func _wrap(feature: String, r: Dictionary, fail_code: StringName = PKeyErrors.PLATFORM_ERROR) -> PKeyResult:
	if r.get("unsupported", false):
		var reason := str(r.get("reason", PKeyConstants.UnsupportedReason.RUNTIME))
		if not r.has("detail"):
			var gate := availability(feature)
			if not gate.ok:
				return gate
		return PKeyResult.unsupported(feature, reason, str(r.get("detail", "")))
	if r.get("ok", false):
		return PKeyResult.success(r)
	if str(r.get("error", "")) == "timeout":
		return PKeyResult.failure(PKeyErrors.TIMEOUT, "The Android platform plugin did not answer in time.", r)
	return PKeyResult.failure(fail_code, "The Android platform plugin answered %s." % str(r.get("error", "an error")), r)
