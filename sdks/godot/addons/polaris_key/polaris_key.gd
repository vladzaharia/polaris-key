extends Node
## The Polaris Key SDK root, registered as the autoload `PolarisKey` (plugin.gd). No
## `class_name`: the autoload is the name. Configure once, start offline, sync when online:
##
##   var opts: PKeyOptions = load("res://polaris_key.tres")
##   PolarisKey.configure(opts)                 # refuses insecure URLs and non-semver versions
##   await PolarisKey.start()                   # device id, token, verified cache; no network
##   var r := await PolarisKey.sync()           # trust, then licence and config in parallel
##   if PolarisKey.is_licensed(): ...
##
## Every call that can wait is a coroutine returning a PKeyResult (or PKeySyncResult). Signals:
## `state_changed(state)` when the licence state changes, `sync_finished(result)` after every
## sync, `store_error(err)` when the store fails to read or write (also `last_store_error`).
## `core` is the PKeyCore every service client builds on. `build_info()` says which build this is
## (the export plugin's stamp, or the editor fallback).
##
## Sub-objects: `config` (PKeyConfig: managed config, secrets, the catalog, edge-mint; its
## `config_changed(keys)` fires after start, each sync and each bundle import), `devices`
## (PKeyDevices: fingerprint, keyless register, the device roster, telemetry after each sync),
## `license` (PKeyLicense: the gate, activate_with_key, enroll, deactivate, entitlements, entitled
## channels, and the 401 re-acquire it installs into Core), `identity` (PKeyIdentity:
## device-code sign-in with a QR code; a `ready` stores the token and runs a forced sync),
## `update` (PKeyUpdate: the version check, its `update_available(check)` signal, the appcast
## URL) and `release` (PKeyRelease: the changelog, the install and download URLs). `config`,
## `identity`, `update` and `release` exist before `configure()`, so a signal connected early
## survives it.

const SDK_VERSION := "0.1.0"

## The licence state changed (the Dictionary `status()` returns).
signal state_changed(state: Dictionary)
## A sync pass finished.
signal sync_finished(result: PKeySyncResult)
## The store failed: {op, path, error, message}.
signal store_error(err: Dictionary)

var core: PKeyCore = null
## The device principal's surface (services/devices.gd); null until configure().
var devices: PKeyDevices = null
## The licence surface (services/license.gd); null until configure().
var license: PKeyLicense = null
var last_store_error: Dictionary = {}
## Managed config. Usable before `configure()` (every key falls back).
var config := PKeyConfig.new()
## Device-code sign-in. Present before `configure()` (`is_available()` is false until then).
var identity := PKeyIdentity.new()
## The version check and appcast URL (services/update.gd). Refuses until configure().
var update := PKeyUpdate.new()
## The changelog and the install and download URLs (services/release.gd). Refuses until
## configure().
var release := PKeyRelease.new()

var _timer: Timer = null
var _syncing := false
var _last_state: Dictionary = {}


## Validate the options and build Core. Nothing touches the disk or the network. Fails with
## `insecure-base-url` (http to a non-loopback host) or `invalid-options` (a bad product slug,
## a non-semver version, malformed pins, an unknown expected service).
func configure(opts: PKeyOptions) -> PKeyResult:
	var r := PKeyCore.create(opts, self, SDK_VERSION)
	if not r.ok:
		return r
	_stop_timer()
	core = r.detail
	core.store_error.connect(_on_store_error)
	config.attach(core)
	update.attach(core)
	release.attach(core)
	devices = PKeyDevices.new(core)
	devices.install(core)
	devices.on_wiped = _emit_state
	license = PKeyLicense.new(core, devices)
	license.install(core)
	license.on_acquired = _on_license_acquired
	license.on_changed = _on_license_wiped
	identity.attach(core, self)
	identity.on_acquired = func() -> PKeySyncResult: return await sync(true)
	return PKeyResult.success()


## The offline load: device id, token, cached documents re-verified. No network. A coroutine.
func start() -> PKeyResult:
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var r := await core.start()
	if r.ok:
		_start_timer()
		_emit_state()
		config.refresh()
	return r


## Fetch the product's discovery document and install its capability map. A coroutine.
func discover() -> PKeyResult:
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var r := await core.discover()
	_emit_state()
	return r


## slug -> {"enabled": bool}, fail-closed (D-21): discovery this session, else
## expected_services, else licence and config only.
func capabilities() -> Dictionary:
	return core.services() if core != null else PKeyDiscovery.default_services()


## One sync pass. A pass already running is joined rather than doubled. A coroutine.
func sync(force := false) -> PKeySyncResult:
	if core == null:
		return PKeySyncResult.new(false, PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	if _syncing:
		return await sync_finished
	_syncing = true
	var r := await core.sync(force)
	_syncing = false
	config.refresh()
	sync_finished.emit(r)
	_emit_state()
	return r


## A snapshot of everything a UI renders from.
func get_sync_state() -> Dictionary:
	return core.sync_state() if core != null and core.started else {}


## Verify and install an offline activation bundle (all-or-nothing). A coroutine.
func import_bundle(text: String) -> PKeyResult:
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var r := await core.import_bundle(text)
	_emit_state()
	config.refresh()
	return r


## The licence state: {status, grace_until?, last_verified_at?, allowed_range?}.
func status() -> Dictionary:
	if core == null or not core.started:
		return {"status": "needs-activation"}
	return core.license_state()


func is_licensed() -> bool:
	return PKeyGate.is_usable(status())


## Which build this is: the export's stamp (`res://.polaris_key/build.json`, PKeyBuildStamp:
## product, version, build, outlet, channel, engine, platform, arch, outletIds, …), or, without
## one (the editor), the fallback: application/config/version, build 0, no outlet, the editor
## channel (the setup dock's, from res://polaris_key.tres until configure()), this platform and
## arch. Works before configure().
func build_info() -> Dictionary:
	if core != null:
		return core.build_info()
	var stamp = PKeyBuildStamp.read()
	if stamp != null:
		return stamp
	var d := PKeyBuildStamp.editor_defaults()
	return PKeyBuildStamp.fallback(d["channel"], d["product"])


## Where the token lives: {backend, degraded?: {reason, detail?}}.
func store_status() -> Dictionary:
	return core.store_status() if core != null else {}


## A token was minted (activate, enroll): sync at once, unconditionally, so the caller returns
## with the licence document (sdk-node `onLicenseAcquired`).
func _on_license_acquired() -> void:
	await sync(true)
	_emit_state()


## deactivate() wiped the token and the cache: the gate and the config both read from them.
func _on_license_wiped() -> void:
	_emit_state()
	config.refresh()


func _on_store_error(err: Dictionary) -> void:
	last_store_error = err
	store_error.emit(err)


func _emit_state() -> void:
	var s := status()
	if s != _last_state:
		_last_state = s
		state_changed.emit(s)


func _start_timer() -> void:
	_stop_timer()
	if core.options.refresh_interval_seconds <= 0 or core.local_only:
		return
	_timer = Timer.new()
	_timer.wait_time = core.options.refresh_interval_seconds
	_timer.timeout.connect(_on_refresh)
	add_child(_timer)
	_timer.start()


func _stop_timer() -> void:
	if _timer != null:
		_timer.queue_free()
		_timer = null


func _on_refresh() -> void:
	await sync()


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_RESUMED and _timer != null:
		_on_refresh()
