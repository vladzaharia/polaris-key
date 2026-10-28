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
## `license` (PKeyLicense: the gate, activate_with_key, enroll, deactivate, entitled
## channels, and the 401 re-acquire it installs into Core), `identity` (PKeyIdentity:
## device-code sign-in with a QR code; a `ready` stores the token and runs a forced sync),
## `update` (PKeyUpdate: the signed decision and acting on it — apply, restart_to_update,
## confirm_boot, the boot guard — the version check, its `update_available(check)` signal, the appcast
## URL), `release` (PKeyRelease: the changelog, the install and download URLs) and `commerce`
## (PKeyCommerce, P6-01: the purchase binding, claiming a store purchase as a licence flag, and
## the App Store 3.1.3(b) outlet rule), `distribution` (PKeyDistribution: the public download
## model), `backend` (PKeyBackend: the licence document to the app's own backend, `headers()`,
## `headers_for(url)` and `request()`, only to `backend_origins`). `crash_tags()` returns the release/environment/outlet tags for a crash reporter.
## `presentation()` is the product's presentation from discovery (`core.presentation`: name,
## developerName, accent, accentDark, icon) as a Dictionary, {} for none; `presentation_icon(px,
## scale)` its verified icon as a texture; `presentation_source` (PKeyPresentationSource) the seam
## the UI kit reads, with its `changed` signal.
## `config`, `identity`, `entitlements`, `update`, `release`, `commerce`, `distribution` and `presentation_source`
## exist before `configure()`, so a signal connected early survives it.

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
## The kit took (true) or gave back (false) the player's input: a dialog, the gate or the boot is
## now (or no longer) the screen that answers the pad, keyboard and pointer. The game owns pause
## and input: the kit never sets `SceneTree.paused`, so a game that wants to pause its own
## simulation or mute its action map listens to this.
signal input_captured(captured: bool)
## The kit has a sound to play: `open`, `close`, `focus` (navigation only), `confirm`, `back` or
## `error` (PKeyUiFeedback). The game plays its own sound. Survives `configure()`.
signal ui_sound(event: StringName)
## One stream of what changed (the `events` stream every SDK has), emitted beside the signals above
## once `configure()` has run. `kind` is a `PKeyConstants.EventKind` value; `data` has snake_case keys:
##   license          {status, previous}                      beside `state_changed`
##   config           {key, value, previous, source}          one per key of `config.config_changed`
##   updateAvailable  {version, action, mandatory, channel}   beside `update.update_available` (decide())
##   packs            {pack, phase, done, total}              pack progress, every phase
##   store            {reason, detail}                        beside `store_error`
##   identity         {kind, subject, previous}               `kind` signedIn, signedOut or subjectChanged; subject
##                                                             and previous are the pairwise subjects or null
## `entitlement` and `cloudSync` follow with their features. Payloads carry no token or raw hardware value.
signal event(kind: String, data: Dictionary)
## `in_play` changed.
signal in_play_changed(playing: bool)

## The drop-in boot scene `boot()` shows when no view is given.
const BOOT_SCENE := "res://addons/polaris_key/ui/boot/pkey_boot.tscn"

var core: PKeyCore = null
var _ring_hook_added := false
## The device principal's surface (services/devices.gd); null until configure().
var devices: PKeyDevices = null
## The Cloud Sync key ring (core/sync/ring.gd): create, unlock, wrap_to, recovery, adopt, forget, and the
## codec the sync lane seals with. Null until configure(). Sign-out calls `keyring.forget()`.
var keyring: PKeySyncRing = null
## The licence surface (services/license.gd); null until configure().
var license: PKeyLicense = null
## The licence's grants: has, value, all (services/entitlements.gd). Present before `configure()`
## (false, null, {}).
var entitlements := PKeyEntitlements.new()
var last_store_error: Dictionary = {}
## Managed config. Usable before `configure()` (every key falls back).
var config := PKeyConfig.new()
## Device-code sign-in. Present before `configure()` (`is_available()` is false until then).
var identity := PKeyIdentity.new()
## The version check and appcast URL (services/update.gd). Refuses until configure().
var update := PKeyUpdate.new()
## The changelog, the install and download URLs and the verified build download, fetch()
## (services/release.gd). Refuses until configure().
var release := PKeyRelease.new()
## Store purchases as licence flags (services/commerce.gd, P6-01). Refuses until configure().
var commerce := PKeyCommerce.new()
## Where the product can be got: the public download model (services/distribution.gd, SDK parity
## §3.8). Refuses until configure().
var distribution := PKeyDistribution.new()
## The licence document to the app's own backend (services/backend.gd): headers(),
## headers_for(url) and request(). Refuses every URL until configure() and `backend_origins`.
var backend := PKeyBackend.new()
## The product's presentation from discovery (core/presentation.gd): current(), icon(px, scale),
## `changed`. The UI kit's default name, icon and accent.
var presentation_source := PKeyPresentationSource.new()

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

## The gate `boot({persistent_gate: true})` left over the game (it follows the licence for the rest
## of the session and covers the game again when the licence stops being usable), or null.
var boot_gate: Node:
	get:
		if _boot_layer != null and is_instance_valid(_boot_layer):
			for c in _boot_layer.get_children():
				if c is PKeyGateView and not c.is_queued_for_deletion():
					return c
		return null

var _boot_layer: CanvasLayer = null

## Whether the player is in the middle of play (true) or in a menu, a results screen or a pause
## screen (false, the default). While it is true an available update is only a toast at the
## toast anchor and the modal prompt waits; the game sets it (UI-KITS.md §4.3 Games).
var in_play := false:
	set(value):
		if value == in_play:
			return
		in_play = value
		in_play_changed.emit(value)

var _capturers := {}

## Where the kit's toasts sit over the game: "bottom_center" (the default, above the hints),
## "bottom_right" or "top_right". They stay inside the title-safe area. The game sets it once.
var toast_anchor := "bottom_center":
	set(value):
		toast_anchor = value
		if _toaster != null and is_instance_valid(_toaster):
			_toaster.toast_anchor = value

var _toaster: PKeyToast = null
var _toast_layer: CanvasLayer = null

var _timer: Timer = null
var _syncing := false
var _last_state: Dictionary = {}


## Validate the options and build Core. Nothing touches the disk or the network. Fails with
## `insecure-base-url` (http to a non-loopback host) or `invalid-options` (a bad product slug,
## a non-semver version, malformed pins, an unknown expected service).
func configure(opts: PKeyOptions) -> PKeyResult:
	for origin in (opts.backend_origins if opts != null else PackedStringArray()):
		if PKeyBackend.normalize_origin(origin) == "":
			return PKeyResult.failure(PKeyConstants.ErrorCode.INVALID_OPTIONS, "backend_origins: \"%s\" is not an exact origin (https://host[:port]; http only on loopback)." % origin)
	var r := PKeyCore.create(opts, self, SDK_VERSION)
	if not r.ok:
		return r
	_stop_timer()
	PKeyUiTheme.apply_options(opts)
	core = r.detail
	core.store_error.connect(_on_store_error)
	config.attach(core)
	update.attach(core)
	release.attach(core, update)
	devices = PKeyDevices.new(core)
	devices.install(core)
	devices.on_wiped = _emit_state
	core.attest_hook = devices.attest
	license = PKeyLicense.new(core, devices)
	license.install(core)
	license.on_acquired = _on_license_acquired
	license.on_changed = _on_license_wiped
	entitlements.attach(license)
	commerce.attach(core, entitlements)
	commerce.on_claimed = func() -> void: await sync(true)
	distribution.attach(core)
	backend.attach(core, func(force: bool) -> PKeySyncResult: return await sync(force), opts.backend_origins)
	identity.bind(core, self)
	_build_keyring(opts)
	identity.on_acquired = func() -> PKeySyncResult: return await sync(true)
	identity.on_change = _on_identity_change
	presentation_source.attach(core, self)
	PKeyUiTheme.use_presentation(presentation_source)
	return PKeyResult.success()


## The key ring over this Core: the options' device keys and vault, else the product's own under
## `store_root`. Sign-out forgets the root and the pin (one hook, registered once, reads the current ring).
func _build_keyring(opts: PKeyOptions) -> void:
	# The ring's files stay out of OS backups: Android's no-backup directory when the plugin is present.
	var sensitive_root := PKeyBackupExclusion.root(opts.store_root)
	var keys: Object = opts.device_keys if opts.device_keys != null else PKeyDeviceKeyStore.new(core.product, sensitive_root)
	var vault: PKeySyncRingVault = opts.ring_vault if opts.ring_vault != null else PKeySyncRingVault.new(core.product, sensitive_root)
	keyring = PKeySyncRing.for_core(core, keys, vault)
	if not _ring_hook_added:
		_ring_hook_added = true
		identity.add_before_sign_out(_forget_ring)


func _forget_ring() -> void:
	if keyring != null:
		await keyring.forget()


## The boot (report §5.1, §5.8): runs the P1-09 stage machine through PKeyBoot and resolves at
## READY with a PKeyBootResult (`outcome` PKeyBoot.READY). Configures from `opts.options` or
## res://polaris_key.tres when configure() has not run.
##
##   await PolarisKey.boot({allow_offline = true})
##   get_tree().change_scene_to_file("res://title.tscn")
##
## A stop on the way (OFFLINE, BLOCKED, ERROR) keeps the boot's own card on screen with the way
## forward (Try again, update, key entry), and the await waits through any number of retries:
## the game continues once the player is through. A game that draws its own stop UI passes
## `resolve_on_stop: true` to resolve at the first stop instead (READY, BLOCKED, OFFLINE or ERROR)
## and reads later stops from `boot_finished`. Calling boot() again while one is going on joins it,
## and calling it after READY (a sign-out, a revoked licence) starts a new boot with its own gate.
##
## `opts`: allow_offline, allow_grace, required_packs (accepted; empty until P4-08),
## sync_timeout_seconds, offer_enrollment, release_url, options, resolve_on_stop, confirm_identity
## (a sign-in stops at "Is this you?" with the account it found before handing back),
## persistent_gate (`boot_gate`, below), and `view` (a PKeyBoot already in the game's own boot
## scene). Without a view, one is shown on a CanvasLayer above the game and freed once READY has
## been announced. With `persistent_gate` a gate stays on that layer for the session: it hides
## while the licence is usable and covers the game again with the boot's screens when it is not
## (revoked, expired, signed out). An update answer on screen at READY outlives the view: its
## prompt stays on the layer, top-wide, as `boot_prompt` (`keep_update_prompt: false` when the game
## shows its own PKeyUpdatePrompt, which replays update.last_available; a prompt the game places
## replaces the kept one). A coroutine.
func boot(opts: Dictionary = {}) -> PKeyBootResult:
	var view = opts.get("view")
	if view == null:
		if boot_view == null or not is_instance_valid(boot_view) or boot_view.is_queued_for_deletion():
			if _boot_layer == null or not is_instance_valid(_boot_layer) or _boot_layer.is_queued_for_deletion():
				_boot_layer = CanvasLayer.new()
				_boot_layer.name = "PKeyBootLayer"
				_boot_layer.layer = 100
				add_child(_boot_layer)
			# A prompt, and a persistent gate, kept from an earlier boot give way to the new boot's own.
			for c in _boot_layer.get_children():
				if c is PKeyUpdatePrompt or c is PKeyGateView:
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


## The drop-in names this device for the sign-in page and the customer's device list: the
## computer's own name ("Ada's MacBook Pro") instead of "macOS" when the game's configuration
## gives none. A game's `device_name`, and `send_device_name = false`, stay as they are.
## The boot calls it once the SDK is configured.
func use_friendly_device_name() -> void:
	if core != null and core.options.device_name == "" and core.options.send_device_name:
		core.options.device_name = PKeyDeviceLabel.friendly_default()


func _on_boot_finished(r: PKeyBootResult) -> void:
	boot_finished.emit(r)


## This device from local state, no network: {id, current: true, status, license_id?,
## last_verified_at?}. {} before configure().
func current_device() -> Dictionary:
	if devices == null:
		return {}
	return devices._current_device()


## The offline load: device id, token, cached documents re-verified. No network. A coroutine.
func start() -> PKeyResult:
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var r := await core.start()
	if r.ok:
		# The last presentation, so an offline start still shows the product.
		presentation_source.load_cached()
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


## The product's presentation (`core.presentation`, WIRE-CONTRACT-V4 §5.5) from the last
## successful discovery, else from the last session's: {name, developerName?, accent?,
## accentDark?, icon?}, or {} when the product serves none. Unsigned display data: nothing gates on
## it. Works before configure() ({}).
func presentation() -> Dictionary:
	return presentation_source.current()


## The product's verified icon for a hero drawn at `px` points on a `scale` screen, or null (no
## icon, nothing this platform decodes, or a fetch, hash or decode that failed). A coroutine.
func presentation_icon(px: float, scale := 1.0) -> ImageTexture:
	return await presentation_source.icon(px, scale)


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
func _on_license_acquired() -> PKeySyncResult:
	var r := await sync(true)
	_emit_state()
	return r


## deactivate() wiped the token and the cache: the gate and the config both read from them.
func _on_license_wiped() -> void:
	_emit_state()
	config.refresh()


func _init() -> void:
	# The kit's nodes keep running while the game pauses the tree (a sign-in opened from a pause
	# menu must not freeze). Children inherit it; a game overrides it by setting `process_mode`.
	process_mode = Node.PROCESS_MODE_ALWAYS
	config.config_changes.connect(_on_config_changes)
	update.update_available.connect(_on_update_available)
	update.packs.pack_phase.connect(_on_pack_phase)


## The one toast host the kit's screens share (the update prompt in play, the gate's and boot's
## "Signed in" and "Copied"): a PKeyToast on its own canvas layer above the game's UI, created on
## first use and kept for the session. It never takes focus from play.
func toasts() -> PKeyToast:
	if _toaster == null or not is_instance_valid(_toaster):
		_toast_layer = CanvasLayer.new()
		_toast_layer.name = "PKeyToastLayer"
		_toast_layer.layer = 101
		add_child(_toast_layer)
		_toaster = PKeyToast.new()
		_toaster.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		_toaster.sdk = self
		_toaster.toast_anchor = toast_anchor
		_toast_layer.add_child(_toaster)
	return _toaster


## Whether any kit screen holds the player's input now.
func is_input_captured() -> bool:
	_prune_capturers()
	return not _capturers.is_empty()


## A kit view reports that it takes (`on`) or releases the player's input. `input_captured` is
## emitted when the first view takes it and when the last gives it back.
func capture_input(owner: Object, on: bool) -> void:
	if owner == null:
		return
	var was := is_input_captured()
	var id := owner.get_instance_id()
	if on:
		_capturers[id] = true
	else:
		_capturers.erase(id)
	var now := is_input_captured()
	if now != was:
		input_captured.emit(now)


func _prune_capturers() -> void:
	for id in _capturers.keys():
		if not is_instance_id_valid(id):
			_capturers.erase(id)


func _enter_tree() -> void:
	# One listener: the autoload, or the first SDK node when there is no autoload (tests).
	if name == "PolarisKey" or not PKeyJws.progress_listener.is_valid():
		PKeyJws.progress_listener = _on_verify_progress
	if name == "PolarisKey":
		# A pad's A and B must work on the kit's screens whatever the game's input map holds.
		PKeyUiView.ensure_pad_bindings()
	# iOS: this launch's AppDistributor read starts now (P5-05), so outlet detection usually has
	# it; it is raced against 2 s and never cached across launches.
	if name == "PolarisKey" and PKeyHeaders.update_platform() == PKeyConstants.Platform.IOS:
		PKeyApple.start_launch_reads()


func _exit_tree() -> void:
	if PKeyJws.progress_listener.is_valid() and PKeyJws.progress_listener.get_object() == self:
		PKeyJws.progress_listener = Callable()


func _on_verify_progress(fraction: float) -> void:
	verify_progress.emit(fraction)


func _on_store_error(err: Dictionary) -> void:
	last_store_error = err
	store_error.emit(err)
	_emit_event(PKeyConstants.EventKind.STORE, {"reason": PKeyConstants.ErrorCode.STORE_FAILED, "detail": str(err.get("message", ""))})


## Raise `event` once the SDK is configured.
func _emit_event(kind: String, data: Dictionary) -> void:
	if core != null:
		event.emit(kind, data)


func _on_identity_change(kind: String, subject: String, previous: String) -> void:
	_emit_event(PKeyIdentity.EVENT_KIND, {
		"kind": kind,
		"subject": subject if subject != "" else null,
		"previous": previous if previous != "" else null,
	})


func _on_config_changes(changes: Array) -> void:
	for c in changes:
		_emit_event(PKeyConstants.EventKind.CONFIG, c)


func _on_update_available(result: PKeyResult) -> void:
	if not (result is PKeyUpdateCheck):
		return
	var d: Dictionary = result.decision
	var release = d.get("release")
	_emit_event(PKeyConstants.EventKind.UPDATEAVAILABLE, {
		"version": release["version"] if release is Dictionary and release.get("version") is String else "",
		"action": String(d.get("action", "")),
		"mandatory": d.get("mandatory") == true,
		"channel": result.channel,
	})


func _on_pack_phase(info: Dictionary) -> void:
	_emit_event(PKeyConstants.EventKind.PACKS, info)


func _emit_state() -> void:
	var s := status()
	if s != _last_state:
		var previous = _last_state.get("status")
		_last_state = s
		state_changed.emit(s)
		# `license` is a STATUS change only (as Swift and Node); state_changed fires on any change.
		if s.get("status") != previous:
			_emit_event(PKeyConstants.EventKind.LICENSE, {"status": s.get("status"), "previous": previous})


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
