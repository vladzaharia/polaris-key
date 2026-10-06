class_name PKeyApple
extends Node
## The GDScript facade over the Apple platform plugin (P5-05; README §5.10): PolarisKeyPlatform's
## AppDistributor, AppTransaction, StoreKit 2, Keychain and Background Assets, reached through the
## `PolarisKeyApple` GDExtension (sdks/godot/native/ios/, addons/polaris_key/native/ios/).
##
## The native class has ONE static method, `cmd(json) -> String`. Asynchronous results and events
## are queued natively, from any thread, and drained HERE, on the main thread, once per frame
## (`_process`) or while a call is awaited; the signals are declared and emitted in GDScript, so no
## native code calls into the engine (notes/S-09 §Results 4).
##
## Without the native class every call answers the typed unsupported result (PKeyResult with
## `code == &"unsupported"`, PARITY §2.2): `detail.reason` is `runtime` off iOS and `dependency`
## on an iOS build without the xcframework. The Keychain calls also run on macOS (SP-27), through
## the desktop build (sdks/godot/native/macos/build_apple.sh, libpkey_apple.dylib), where they
## answer `dependency` without it; every other call stays iOS-only there. Background Assets also answers `version` below
## iOS 26.4 and `outlet` in a build without the Background Assets extension (a sideload IPA).
##
##   var apple := PKeyApple.shared()                  # one per process, polled by the tree
##   var r := await apple.distributor()               # PKeyResult; detail {signal, reason?, ms,
##                                                    #   provisioned, altBundleIdentifier, …}
##   r = await apple.products(["gg.vlad.diceroll.pack.foes"])
##   r = await apple.purchase("gg.vlad.diceroll.pack.foes", app_account_token)
##   # … the server records detail.transaction.jws (P6-01), then:
##   r = await apple.finish(r.detail.transaction.id)
##   apple.transaction_updated.connect(func(jws, t): …)   # refunds, Ask to Buy, other devices
##   r = await apple.ensure_packs([{"id": "foes-c3", "path": "foes/content.pck"}])
##   r = await apple.app_attest(request_hash, stored_key_id)   # P6-02; via PolarisKey.devices.attest()
##
## `finish()` is called only after the server has recorded the purchase. A purchase is confirmed
## by its own result: `entitlements()` lags it by about a second (S-09). Transaction ids are
## strings (a UInt64 does not survive a JSON number). Pack paths are resolved fresh on every call
## and never persisted; an update replaces the file at the same path, so apply it next launch.

## A transaction the app did not just buy through purchase(): a refund (`revoked`), Ask to Buy,
## a purchase on another device. Each transaction state is emitted once.
signal transaction_updated(jws: String, transaction: Dictionary)
## Download progress of an asset pack, in bytes of the archive.
signal pack_progress(id: String, bytes: int, total: int)
## The pack is downloaded and `path` exists. Paths are not persisted.
signal pack_ready(id: String, path: String)
## The pack could not be made ready (`err` is `domain code: message`).
signal pack_failed(id: String, err: String)

const NATIVE_CLASS := "PolarisKeyApple"
## The AppDistributor deadline (OUTLET_PLATFORM_DATA.deadlineMs; notes/S-06 rule 5).
const DISTRIBUTOR_DEADLINE := 2.0

## The platform this answers for ("" means PKeyHeaders.platform()). Tests set it.
var platform := ""
## The native object to call instead of the GDExtension class: anything with
## `cmd(json: String) -> String` (tests).
var native: Object = null
## The GDExtension class used when `native` is null. Tests point it at a missing class.
var native_class := NATIVE_CLASS
## How long an awaited call waits for its event.
var timeout_s := 30.0

var _dropped := 0

## Results of asynchronous requests, keyed "<native id>:<req>", SHARED by every instance: the
## native queue is one per process, so whichever instance polls may drain another instance's
## result. Entries are consumed by the awaiting call, or dropped when it times out.
static var _results := {}
## Requests whose caller timed out: their results are dropped when they arrive.
static var _abandoned := {}

static var _shared: PKeyApple = null
## This launch's distributor answer (never persisted, never carried across launches).
static var _launch_distributor: Variant = null
static var _launch_started := false
static var _launch_listening := false


## The process's facade: created on first use and added to the scene tree (deferred), so
## `_process` drains the native queue every frame. Use this one instance in a game: the
## unsolicited events (transaction_updated, pack_*) are emitted by the instance that polls, so
## a second instance that also polls would take some of them. Awaited results are safe across
## instances (they are shared, keyed by request id). Other instances are for tests.
static func shared() -> PKeyApple:
	if _shared == null or not is_instance_valid(_shared):
		_shared = PKeyApple.new()
		_shared.name = "PKeyApple"
		var tree := Engine.get_main_loop() as SceneTree
		if tree != null and tree.root != null:
			tree.root.add_child.call_deferred(_shared)
	return _shared


## The launch work (once per process; the PolarisKey autoload calls it on iOS):
##   - start the StoreKit Transaction.updates listener when StoreKit is there (S-09
##     Recommendation 4: refunds, Ask to Buy and other devices' purchases arrive as
##     transaction_updated from launch on, not only after the first purchase);
##   - this launch's AppDistributor read, never cached across launches. Outlet detection reads
##     the answer through launch_distributor() when it has arrived; until then it has no iOS
##     distributor evidence and the build stamp stands.
## `apple` is the instance to use (tests); shared() by default.
static func start_launch_reads(apple: PKeyApple = null) -> void:
	if _launch_started:
		return
	_launch_started = true
	if apple == null:
		apple = shared()
	if apple.unsupported_reason() != "":
		return
	var caps := apple.capabilities()
	if caps.ok and caps.detail is Dictionary and caps.detail.get("storeKit") == true:
		var listening: PKeyResult = await apple.listen()
		_launch_listening = listening.ok
	var r: PKeyResult = await apple.distributor()
	_launch_distributor = r.detail if r.ok and r.detail is Dictionary else null


## This launch's distributor answer ({signal, reason?, ms, provisioned, altBundleIdentifier,
## bundleIdentifier}), or null before it arrives or where there is none.
static func launch_distributor() -> Variant:
	return _launch_distributor


## Whether the launch work started the Transaction.updates listener.
static func launch_listening() -> bool:
	return _launch_listening


## Forget this launch's reads (tests).
static func reset_launch() -> void:
	_launch_distributor = null
	_launch_started = false
	_launch_listening = false


func _platform() -> String:
	return platform if platform != "" else PKeyHeaders.platform()


func _native_present() -> bool:
	return native != null or ClassDB.class_exists(native_class)


## "" when the plugin can answer here, else the unsupported reason: `runtime` off iOS,
## `dependency` on iOS without the GDExtension. `feature` core.store (the Keychain calls) also
## runs on macOS.
func unsupported_reason(feature := "") -> String:
	if native == null and not _runs_here(feature):
		return PKeyConstants.UnsupportedReason.RUNTIME
	if not _native_present():
		return PKeyConstants.UnsupportedReason.DEPENDENCY
	return ""


func _runs_here(feature: String) -> bool:
	var p := _platform()
	return p == PKeyConstants.Platform.IOS or (p == PKeyConstants.Platform.MACOS and feature == PKeyConstants.Feature.CORE_STORE)


func is_available() -> bool:
	return unsupported_reason() == ""


## Whether the Keychain calls can run here: iOS or macOS with the GDExtension.
func keychain_available() -> bool:
	return unsupported_reason(PKeyConstants.Feature.CORE_STORE) == ""


## PKeyResult.success() when the plugin works here, else the typed unsupported result for
## `feature`.
func availability(feature := PKeyConstants.Feature.OUTLET_DETECT) -> PKeyResult:
	var why := unsupported_reason(feature)
	if why == PKeyConstants.UnsupportedReason.RUNTIME:
		return PKeyResult.unsupported(feature, why, "The Apple platform plugin runs on iOS, not %s." % (_platform() if _platform() != "" else "this platform"))
	if why == PKeyConstants.UnsupportedReason.DEPENDENCY:
		var lib := "libpkey_apple.dylib" if _platform() == PKeyConstants.Platform.MACOS else "pkey_apple.xcframework"
		return PKeyResult.unsupported(feature, why, "The PolarisKeyApple GDExtension (%s) is not in this build." % lib)
	return PKeyResult.success()


# ── Raw calls ────────────────────────────────────────────────────────────────────────────────

## One synchronous request: the native reply as a Dictionary, or {ok: false, unsupported: true,
## reason} without the plugin. `feature` widens where it may run (core.store: macOS too).
func call_sync(q: Dictionary, feature := "") -> Dictionary:
	var why := unsupported_reason(feature)
	if why != "":
		return {"ok": false, "unsupported": true, "reason": why}
	var raw = native.call("cmd", JSON.stringify(q)) if native != null else ClassDB.class_call_static(native_class, "cmd", JSON.stringify(q))
	# JSON.new().parse() reports a bad reply quietly; JSON.parse_string() prints an engine error.
	var json := JSON.new()
	if raw is String and json.parse(raw) == OK and json.data is Dictionary:
		return json.data
	return {"ok": false, "error": "bad_reply", "raw": str(raw)}


## One request awaited to its result: a synchronous reply as it is, or the event carrying the
## asynchronous reply's `req` ({ok:false, error:"timeout"} after `timeout_s`).
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
			# A late result must not linger: poll() drops results nobody waits for any more.
			_abandoned[key] = true
			return {"ok": false, "error": "timeout", "req": req}
		await tree.process_frame
	var out: Dictionary = _results[key]
	_results.erase(key)
	return out


## The shared-results key of request `req` on this instance's native side.
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
		if ev.has("req"):
			var key := _key(int(ev["req"]))
			if _abandoned.has(key):
				_abandoned.erase(key)
			else:
				_results[key] = ev
		match str(ev.get("ev", "")):
			"transaction_updated":
				transaction_updated.emit(str(ev.get("jws", "")), ev)
			"pack_progress":
				pack_progress.emit(str(ev.get("id", "")), int(ev.get("bytes", 0)), int(ev.get("total", 0)))
			"pack_ready":
				pack_ready.emit(str(ev.get("id", "")), str(ev.get("path", "")))
			"pack_failed":
				pack_failed.emit(str(ev.get("id", "")), str(ev.get("err", "")))
	return events.size()


## Events the native queue dropped because nobody polled (it keeps the newest 1024).
func dropped_events() -> int:
	return _dropped


func _process(_delta: float) -> void:
	poll()


# ── Typed calls (each a PKeyResult; the native reply is `detail`) ─────────────────────────────

## The plugin's view of this process: {protocol, platform, appDistributor, appDistributorWeb,
## managedAssetPacks, backgroundAssetsConfigured, storeKit, keychain, entitlementsForID, appAttest}.
func capabilities() -> PKeyResult:
	return _wrap(PKeyConstants.Feature.OUTLET_DETECT, call_sync({"op": "capabilities"}))


## AppDistributor.current, raced against `deadline` seconds (default 2), plus the static bundle
## evidence (`provisioned`, `altBundleIdentifier`, `bundleIdentifier`). RAW signals: `appStore`,
## `testFlight`, `marketplace:<bundle id>`, `web`, `other`, or `unavailable` (no evidence; `reason`
## says why). Mapping them to an outlet is PKeyOutlet.detect_outlet's job.
func distributor(deadline := DISTRIBUTOR_DEADLINE) -> PKeyResult:
	return await _async(PKeyConstants.Feature.OUTLET_DETECT, {"op": "distributor", "deadline": deadline}, deadline + 5.0)


## AppTransaction for commerce (P6-01 verifies `jws`); never for outlet detection.
func app_transaction(refresh := false) -> PKeyResult:
	return await _async(PKeyConstants.Feature.COMMERCE_RECEIPT, {"op": "app_transaction", "refresh": refresh})


## The products StoreKit knows among `ids`: detail.products [{id, type, displayName,
## displayPrice, price}].
func products(ids: PackedStringArray) -> PKeyResult:
	return await _async(PKeyConstants.Feature.COMMERCE_RECEIPT, {"op": "products", "ids": Array(ids)})


## Buy a product products() has loaded. `app_account_token` is the UUID P6-01 issues. detail:
## {result: success|pending|userCancelled, transaction?: {id, jws, …}}.
func purchase(product_id: String, app_account_token := "") -> PKeyResult:
	var q := {"op": "purchase", "product": product_id}
	if app_account_token != "":
		q["appAccountToken"] = app_account_token
	return await _async(PKeyConstants.Feature.COMMERCE_RECEIPT, q, 600.0)


## The current entitlements (optionally one product's). Never use it to confirm a purchase that
## just succeeded.
func entitlements(product_id := "") -> PKeyResult:
	var q := {"op": "entitlements"}
	if product_id != "":
		q["product"] = product_id
	return await _async(PKeyConstants.Feature.COMMERCE_RECEIPT, q)


## Finish a transaction, ONLY after the server has recorded it. detail.finished.
func finish(transaction_id: String) -> PKeyResult:
	return await _async(PKeyConstants.Feature.COMMERCE_RECEIPT, {"op": "finish", "id": transaction_id})


## Start the Transaction.updates listener (idempotent); updates arrive as transaction_updated.
func listen() -> PKeyResult:
	return await _async(PKeyConstants.Feature.COMMERCE_RECEIPT, {"op": "listen"})


## The login keychain (macOS desktop, SP-27): the `keychain` argument of the Keychain calls.
const LOGIN_KEYCHAIN := "login"


## A Keychain value of service `pkey:<product>`: detail.value, null when absent. `keychain` ""
## is the data-protection keychain (iOS); LOGIN_KEYCHAIN the macOS login keychain.
func keychain_get(product: String, account: String, keychain := "") -> PKeyResult:
	return _keychain_call({"op": "kc_get", "product": product, "account": account}, keychain)


## Store a Keychain value (data protection: AfterFirstUnlockThisDeviceOnly, no access group).
func keychain_set(product: String, account: String, value: String, keychain := "") -> PKeyResult:
	return _keychain_call({"op": "kc_set", "product": product, "account": account, "value": value}, keychain)


func keychain_delete(product: String, account: String, keychain := "") -> PKeyResult:
	return _keychain_call({"op": "kc_delete", "product": product, "account": account}, keychain)


func _keychain_call(q: Dictionary, keychain: String) -> PKeyResult:
	if keychain != "":
		q["keychain"] = keychain
	return _wrap(PKeyConstants.Feature.CORE_STORE, call_sync(q, PKeyConstants.Feature.CORE_STORE), PKeyErrors.STORE_FAILED)


## A pack's status: detail {status: [flags], version, localVersion, downloadSize}.
func pack_status(id: String) -> PKeyResult:
	return await _async(PKeyConstants.Feature.PACKS_TRANSPORT_APPLE, {"op": "packs_status", "id": id})


## Make packs ready: `packs` is [{id, path}] (`path` a file inside the pack). Emits pack_progress,
## then pack_ready or pack_failed per pack; detail.packs [{id, ready, path?, error?}].
func ensure_packs(packs: Array, latest := false) -> PKeyResult:
	return await _async(PKeyConstants.Feature.PACKS_TRANSPORT_APPLE, {"op": "packs_ensure", "packs": packs, "latest": latest}, 3600.0)


func check_pack_updates() -> PKeyResult:
	return await _async(PKeyConstants.Feature.PACKS_TRANSPORT_APPLE, {"op": "packs_check_updates"})


func remove_pack(id: String) -> PKeyResult:
	return await _async(PKeyConstants.Feature.PACKS_TRANSPORT_APPLE, {"op": "packs_remove", "id": id})


## Resolve a file inside the downloaded packs now: detail {path, exists}. Never persist it.
func pack_path(path: String) -> PKeyResult:
	return await _async(PKeyConstants.Feature.PACKS_TRANSPORT_APPLE, {"op": "packs_url", "path": path})


## Forward a pack's system-initiated download progress as pack_progress (idempotent).
func watch_pack(id: String) -> PKeyResult:
	return await _async(PKeyConstants.Feature.PACKS_TRANSPORT_APPLE, {"op": "packs_watch", "id": id})


func unwatch_pack(id: String) -> PKeyResult:
	return await _async(PKeyConstants.Feature.PACKS_TRANSPORT_APPLE, {"op": "packs_unwatch", "id": id})


# ── App Attest (P6-02; PolarisKey.devices.attest() drives these) ───────────────────────────────

## Whether App Attest runs here: success with detail.supported, or unsupported `runtime` (off iOS,
## the simulator, an app extension) or `dependency` (no GDExtension).
func app_attest_supported() -> PKeyResult:
	return _wrap(PKeyConstants.Feature.DEVICES_ATTEST, call_sync({"op": "app_attest_supported"}))


## Attest `key_id` ("" generates a key first) with clientDataHash = SHA-256(UTF-8(request_hash)):
## detail {keyId, attestation (standard base64), generated, ms}. A failure is `platform-error` with
## detail.error `invalid_key` (the key died with a reinstall, migration or restore: drop it and
## attest again with ""), `server_unavailable` (retry later with the SAME key; detail.keyId holds a
## generated one), `invalid_input`, `system_failure` or `timeout`.
func app_attest(request_hash: String, key_id := "") -> PKeyResult:
	var q := {"op": "app_attest_attest", "requestHash": request_hash}
	if key_id != "":
		q["keyId"] = key_id
	return await _async(PKeyConstants.Feature.DEVICES_ATTEST, q, 45.0)


## An assertion by an attested key over SHA-256(UTF-8(client_data)): detail {keyId, assertion}.
## Stored for later use; the Worker does not ask for assertions yet.
func app_attest_assert(key_id: String, client_data: String) -> PKeyResult:
	return await _async(PKeyConstants.Feature.DEVICES_ATTEST, {"op": "app_attest_assert", "keyId": key_id, "clientData": client_data}, 45.0)


func _async(feature: String, q: Dictionary, wait_s := -1.0) -> PKeyResult:
	var gate := availability(feature)
	if not gate.ok:
		return gate
	return _wrap(feature, await call_async(q, wait_s))


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
		return PKeyResult.failure(PKeyErrors.TIMEOUT, "The Apple platform plugin did not answer in time.", r)
	return PKeyResult.failure(fail_code, "The Apple platform plugin answered %s." % str(r.get("error", "an error")), r)
