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
## (the export plugin's stamp, or the editor fallback). `supports(feature)` and `caps()` say which
## parity features work here, and why not (PKeyCaps, P1b-10).
##
## Sub-objects: `config` (PKeyConfig: managed config, secrets, the catalog, edge-mint; its
## `config_changed(keys)` fires after start, each sync and each bundle import), `devices`
## (PKeyDevices: fingerprint, keyless register, the device roster, telemetry after each sync),
## `license` (PKeyLicense: the gate, activate_with_key, enroll, deactivate, entitlements, entitled
## channels, and the 401 re-acquire it installs into Core), `identity` (PKeyIdentity:
## device-code sign-in with a QR code; a `ready` stores the token and runs a forced sync),
## `update` (PKeyUpdate: the signed decision and acting on it — apply, restart_to_update,
## confirm_boot, the boot guard — the version check, its `update_available(check)` signal, the appcast
## URL), `release` (PKeyRelease: the changelog, the install and download URLs) and `commerce`
## (PKeyCommerce, P6-01: the purchase binding, claiming a store purchase as a licence flag, and
## the App Store 3.1.3(b) outlet rule), `distribution` (PKeyDistribution: the public download
## model). `crash_tags()` returns the release/environment/outlet tags for a crash reporter.
## `config`, `identity`, `update`, `release`, `commerce` and `distribution` exist before
## `configure()`, so a signal
## connected early survives it.

const SDK_VERSION := "0.1.0"

## The licence state changed (the Dictionary `status()` returns).
signal state_changed(state: Dictionary)
## A sync pass finished.
signal sync_finished(result: PKeySyncResult)
## The store failed: {op, path, error, message}.
signal store_error(err: Dictionary)
## The boot stopped (READY, BLOCKED, OFFLINE or ERROR); after the first stop, once per later stop
## (a Retry on the boot card).
signal boot_finished(result: PKeyBootResult)
## A sliced bundle verify's progress, 0.0 to 1.0 (web builds without threads, where a bundle
## verify takes seconds in frame slices; S-04). PKeyBoot drives its progress bar from it.
signal verify_progress(fraction: float)

## The drop-in boot scene `boot()` shows when no view is given.
const BOOT_SCENE := "res://addons/polaris_key/ui/boot/pkey_boot.tscn"

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
## Store purchases as licence flags (services/commerce.gd, P6-01). Refuses until configure().
var commerce := PKeyCommerce.new()
## Where the product can be got: the public download model (services/distribution.gd, SDK parity
## §3.8). Refuses until configure().
var distribution := PKeyDistribution.new()

## The PKeyBoot view `boot()` made (on a CanvasLayer under this node), or null.
var boot_view: Node = null
## The update prompt `boot()` left over the game at READY (a mandatory or blocked answer, or a
## dismissable one not yet dismissed), or null. See PKeyBoot.keep_update_prompt.
var boot_prompt: Node:
	get:
		if boot_view != null and is_instance_valid(boot_view) and is_instance_valid(boot_view.kept_prompt):
			return boot_view.kept_prompt
		if _boot_layer != null and is_instance_valid(_boot_layer):
			for c in _boot_layer.get_children():
				if c is PKeyUpdatePrompt and not c.is_queued_for_deletion():
					return c
		return null

var _boot_layer: CanvasLayer = null

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
	PKeyUiTheme.apply_options(opts)
	core = r.detail
	core.store_error.connect(_on_store_error)
	config.attach(core)
	update.attach(core)
	release.attach(core)
	devices = PKeyDevices.new(core)
	devices.install(core)
	devices.on_wiped = _emit_state
	core.attest_hook = devices.attest
	license = PKeyLicense.new(core, devices)
	license.install(core)
	license.on_acquired = _on_license_acquired
	license.on_changed = _on_license_wiped
	commerce.attach(core, license)
	commerce.on_claimed = func() -> void: await sync(true)
	distribution.attach(core)
	identity.attach(core, self)
	identity.on_acquired = func() -> PKeySyncResult: return await sync(true)
	return PKeyResult.success()


## The boot (report §5.1, §5.8): runs the P1-09 stage machine through PKeyBoot and resolves at
## the first stop with a PKeyBootResult whose `outcome` is PKeyBoot.READY, BLOCKED, OFFLINE or
## ERROR. Configures from `opts.options` or res://polaris_key.tres when configure() has not run.
##
##   var boot := await PolarisKey.boot({allow_offline = true})
##   if boot.outcome == PKeyBoot.READY: get_tree().change_scene_to_file("res://title.tscn")
##
## `opts`: allow_offline, allow_grace, required_packs (accepted; empty until P4-08),
## sync_timeout_seconds, offer_enrollment, release_url, options, and `view` (a PKeyBoot already
## in the game's own boot scene). Without a view, one is shown on a CanvasLayer above the game
## and freed once READY has been announced; on BLOCKED, OFFLINE or ERROR it stays, with Retry,
## and a later stop arrives as `boot_finished`. An update answer on screen at READY outlives the
## view: its prompt stays on the layer, top-wide, as `boot_prompt` (`keep_update_prompt: false`
## when the game shows its own PKeyUpdatePrompt, which replays update.last_available). A coroutine.
func boot(opts: Dictionary = {}) -> PKeyBootResult:
	var view = opts.get("view")
	if view == null:
		if boot_view == null or not is_instance_valid(boot_view) or boot_view.is_queued_for_deletion():
			if _boot_layer == null or not is_instance_valid(_boot_layer) or _boot_layer.is_queued_for_deletion():
				_boot_layer = CanvasLayer.new()
				_boot_layer.name = "PKeyBootLayer"
				_boot_layer.layer = 100
				add_child(_boot_layer)
			# A prompt kept from an earlier boot gives way to the new boot's own.
			for c in _boot_layer.get_children():
				if c is PKeyUpdatePrompt:
					c.queue_free()
			boot_view = (load(BOOT_SCENE) as PackedScene).instantiate()
			boot_view.free_on_ready = true
			boot_view.sdk = self
			_boot_layer.add_child(boot_view)
		view = boot_view
	view.sdk = self
	if not view.boot_finished.is_connected(_on_boot_finished):
		view.boot_finished.connect(_on_boot_finished)
	return await view.run(opts)


func _on_boot_finished(r: PKeyBootResult) -> void:
	boot_finished.emit(r)


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


## Whether a parity feature (a `PKeyConstants.Feature` id) works here (P1b-10, PARITY §2.2):
## ok with detail {feature}, or `code == &"unsupported"` with detail {feature, reason, detail},
## `reason` one of runtime, outlet, product, dependency, version. Offline and side-effect free;
## `product` follows capabilities(). Works before configure() (default capabilities).
func supports(feature: String) -> PKeyResult:
	return _capability_engine().supports(feature)


## The feature ids supports() answers ok for right now, in registry order: the `caps` every
## device report carries.
func caps() -> Array:
	return _capability_engine().caps()


func _capability_engine() -> PKeyCaps:
	if core != null:
		return core.capability_engine()
	return PKeyCaps.new(Callable(), SDK_VERSION)


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


## The tags a crash reporter needs so Polaris Key's update health can map a crash to a rollout
## (SDK parity §3.14; the convention W/services/distribution/sentry.ts reads):
## {release: "<deliverable>@<version>[+<build>]", environment: <update channel>,
## "pkey.outlet": <outlet>} ("pkey.outlet" is omitted when the outlet is unknown). No crash SDK is
## bundled: hand these to yours, e.g. Sentry's `release`, `environment` and a `pkey.outlet` tag.
func crash_tags(deliverable := "app") -> Dictionary:
	var info := build_info()
	var version := String(info.get("version", ""))
	var build := str(info.get("build", ""))
	var release_name := "%s@%s" % [deliverable, version]
	if build != "" and build != "0":
		release_name += "+" + build
	var channel := update.get_channel() if core != null else ""
	if channel == "":
		channel = String(info.get("channel", ""))
	var tags := {"release": release_name, "environment": channel}
	var outlet := core.reported_outlet() if core != null else String(info.get("outlet", "") if info.get("outlet") is String else "")
	if outlet != "":
		tags["pkey.outlet"] = outlet
	return tags


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


func _enter_tree() -> void:
	# One listener: the autoload, or the first SDK node when there is no autoload (tests).
	if name == "PolarisKey" or not PKeyJws.progress_listener.is_valid():
		PKeyJws.progress_listener = _on_verify_progress
	# iOS: this launch's AppDistributor read starts now (P5-05), so outlet detection usually has
	# it; it is raced against 2 s and never cached across launches.
	if name == "PolarisKey" and PKeyHeaders.platform() == PKeyConstants.Platform.IOS:
		PKeyApple.start_launch_reads()


func _exit_tree() -> void:
	if PKeyJws.progress_listener.is_valid() and PKeyJws.progress_listener.get_object() == self:
		PKeyJws.progress_listener = Callable()


func _on_verify_progress(fraction: float) -> void:
	verify_progress.emit(fraction)


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
