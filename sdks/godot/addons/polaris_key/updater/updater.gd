class_name PKeyUpdater
extends RefCounted
## Acting on the verified update decision (P3-10): the context every outlet adapter acts through,
## the slot store, the boot guard's entry point and the boot-confirmation rule. Reached as
## `PolarisKey.update.updater`; the game normally uses PolarisKey.update's methods (apply,
## restart_to_update, confirm_boot, drop_staged) and PKeyBoot.
##
## INERT in the editor, in headless runs (the test runner, a dedicated server) and in debug
## builds, as Diceroll's updater is: nothing is downloaded, swapped, restarted or counted, and the
## decision gets the host's declared methods unchanged. `enabled = true` turns it on there (the
## tests do, with a fake PKeyUpdaterEnv); `enabled = false` turns it off everywhere.
##
## What it feeds the decision while active:
##   methods()          PKeyOptions.update_methods narrowed to what THIS install can do: `native`
##                      only with a usable native updater for the platform, `sidecar-pck` only
##                      where PKeySidecarSwap.support() holds (never under Velopack, MSIX,
##                      Program Files, a macOS .app, Flatpak, Snap or an AppImage), `download`
##                      as declared
##   staged_input()     the staged update {version, channel}; `channel` is the canonical
##                      PKeyUpdateCheck.channel it was staged under
##   skip_version()     the version the guard rolled back
##   binary_version()   the binary's version while a code pack runs ("" otherwise)
##
## Boot confirmation (plans/P3-01.md §2.10, stage matrix v2): note_outcome() with each outcome
## PKeyBoot reaches. `waiting`, `blocked` and `offline` confirm the launch at once; `ready`
## confirms after BOOT_OK_SECONDS with the process alive, or at confirm_boot(); `running` and
## `error` never confirm, so a launch that ends in `error` counts as failed.

## A sidecar pack was downloaded, verified and staged.
signal update_staged(version: String)
## Download progress of a sidecar pack.
signal download_progress(received: int, total: int)
## A launch was confirmed (the failed-boot count is back to 0).
signal boot_confirmed()

## null: active unless the runtime is inert (see the class doc); true or false forces it.
var enabled: Variant = null
var env: PKeyUpdaterEnv = PKeyUpdaterEnv.new()
var slots: PKeySlots = null
## One wall-clock budget per pack download request (resumed next time when it runs out).
var download_timeout := PKeyDownload.DEFAULT_TIMEOUT
## Seconds the outcome must stay `ready` before the launch is confirmed (tests shorten it).
var boot_ok_seconds := float(PKeyStages.BOOT_OK_SECONDS)
## Native bridges by name (sparkle, velopack, winsparkle, appimage); built on first use, or
## injected by a test or a plugin.
var bridges := {}
## Replaces DirAccess.rename_absolute for the swap (tests simulate a locked file).
var rename_hook := Callable()
## The wait between rename attempts (PKeySidecarSwap.RENAME_TRIES of them; tests shorten it).
var rename_wait_msec := PKeySidecarSwap.RENAME_WAIT_MSEC
## The last boot guard's answer ({} before it ran).
var last_guard: Dictionary = {}
## Restart requests this session (the fake env records the restart itself).
var restart_reason := ""

var _core_ref: WeakRef = null
var _outcome := ""
var _confirm_gen := 0
var _confirmed := false


func attach(core: PKeyCore) -> void:
	_core_ref = weakref(core)
	slots = PKeySlots.new(root_for(core))
	bridges = {}


func core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## `<store_root>/<product>/updates`, which is `user://pkey/<product>/updates/` by default.
static func root_for(core: PKeyCore) -> String:
	return core.options.store_root.path_join(core.product).path_join("updates")


func active() -> bool:
	if core() == null or slots == null:
		return false
	if enabled is bool:
		return enabled
	return not env.inert()


func transport() -> PKeyTransport:
	var c := core()
	return c.transport if c != null else null


## The X-PKey-* headers, and the bearer when one is held (an `entitled` feed needs it; the
## download drops it on any cross-origin redirect).
func download_headers() -> Dictionary:
	var c := core()
	if c == null:
		return {}
	var h := c.headers()
	if c.tokens != null and c.tokens.has_token():
		h["Authorization"] = "Bearer %s" % c.tokens.current()
	return h


## The running build's version: the build stamp's (inside a swapped pack, the pack's own stamp).
func running_version() -> String:
	var c := core()
	if c == null:
		return ""
	var v = c.build_info().get("version")
	return v if v is String and v != "" else c.version


# ── Decision inputs ──────────────────────────────────────────────────────────────────────────

func methods() -> Array:
	var c := core()
	if c == null:
		return []
	var declared := Array(c.options.update_methods)
	if not active():
		return declared
	var out: Array = []
	for m in declared:
		match m:
			"download":
				out.append(m)
			"sidecar-pck":
				if PKeySidecarSwap.support(env)["ok"]:
					out.append(m)
			"native":
				var name := native_bridge_name()
				if name != "" and bridge(name).is_available():
					out.append(m)
	return out


func staged_input() -> Variant:
	if not active():
		return null
	var m = slots.meta("staged")
	if not (m is Dictionary):
		return null
	return {"version": m["version"], "channel": m.get("channel")}


func skip_version() -> Variant:
	if not active():
		return null
	var v = slots.load_state().get("skipVersion")
	return v if v is String else null


func binary_version() -> String:
	if not active() or not (slots.meta("current") is Dictionary):
		return ""
	var v = slots.load_state().get("binaryVersion")
	return v if v is String else ""


## The local update events (the `updateEvent` names), oldest first.
func events() -> Array:
	return slots.load_state().get("events", []) if slots != null else []


# ── Adapter context ──────────────────────────────────────────────────────────────────────────

## The adapter for this install's outlet (PolarisKey.update.outlet()).
func adapter() -> PKeyOutletAdapter:
	var c := core()
	return PKeyOutletAdapters.for_outlet(c.update_outlet() if c != null else {"id": null, "kind": "unknown"})


## The native updater for this platform: Sparkle on macOS; Velopack on a Velopack install (or
## with its plugin), else WinSparkle, on Windows; AppImageUpdate in an AppImage, else Velopack, on
## Linux; "" elsewhere.
func native_bridge_name() -> String:
	match env.platform():
		"macos":
			return "sparkle"
		"windows":
			if PKeySidecarSwap.is_velopack(env, env.executable_path()) or bridge("velopack").is_available():
				return "velopack"
			return "winsparkle"
		"linux":
			return "appimage" if env.env("APPIMAGE") != "" else "velopack"
	return ""


func bridge(name: String) -> PKeyNativeBridge:
	if bridges.has(name):
		return bridges[name]
	var b: PKeyNativeBridge
	match name:
		"sparkle":
			b = PKeySparkleBridge.new(env, feed_url(name))
		"velopack":
			b = PKeyVelopackBridge.new(env, feed_url(name))
		"winsparkle":
			b = PKeyWinSparkleBridge.new(env, feed_url(name))
		"appimage":
			b = PKeyAppImageBridge.new(env, "")
		_:
			return null
	bridges[name] = b
	return b


## The feed a native updater reads, from this session's discovery (P3-09's routes) for this
## build's channel; "" without discovery.
func feed_url(name: String) -> String:
	var c := core()
	if c == null or c.discovery_manifest == null:
		return ""
	match name:
		"sparkle":
			return PKeyDiscovery.appcast_url_from(c.discovery_manifest, c.channel, PKeyHeaders.arch())
		"winsparkle":
			var t := PKeyUpdate._endpoint(c.discovery_manifest, "update", "winsparkle")
			return PKeyUpdate._expand(c, t, "channel", c.channel) if t != "" else ""
		"velopack":
			var t := PKeyUpdate._endpoint(c.discovery_manifest, "update", "velopack")
			var at := t.find("releases.")
			if t == "" or at < 0:
				return ""
			return PKeyUpdate._expand(c, t.substr(0, at), "channel", c.channel)
	return ""


## The download URL of build `build_id` of release `version`: discovery's
## `distribution.endpoints.builds`, else `release.endpoints.builds` (never the R2-only `blobs`
## route, plans/P3-01.md §2.4), with `{selector}` and `{buildId}` percent-encoded; "" without one.
func build_url(version: String, build_id: String) -> String:
	var c := core()
	if c == null or c.discovery_manifest == null or version == "" or build_id == "":
		return ""
	var t := PKeyUpdate._endpoint(c.discovery_manifest, "distribution", "builds")
	if t == "":
		t = PKeyUpdate._endpoint(c.discovery_manifest, "release", "builds")
	if t == "":
		return ""
	t = t.replace("{selector}", PKeyUri.component(version))
	return PKeyUpdate._expand(c, t, "buildId", build_id)


## The adapter's `ctx` for `decision` (see PKeyOutletAdapter).
func context(decision: Dictionary) -> Dictionary:
	var c := core()
	var outlet: Dictionary = c.update_outlet() if c != null else {}
	var build := ""
	if decision.get("action") == "binary" and decision.get("release") is Dictionary:
		build = build_url(String(decision["release"].get("version", "")), String(decision.get("build", "")))
	var native := native_bridge_name()
	return {
		"platform": env.platform(),
		"subkind": outlet.get("subkind"),
		"release_url": c.options.update_release_url if c != null else "",
		"page_url": c.options.update_page_url if c != null else "",
		"build_url": build,
		"native_bridge": native,
		"native_available": native != "" and active() and bridge(native).is_available(),
	}


func open_url(url: String) -> bool:
	if not PKeyOutletAdapter.is_https(url):
		return false
	return env.shell_open(url) == OK


func reload_web() -> bool:
	return env.reload_web()


# ── Acting ───────────────────────────────────────────────────────────────────────────────────

## binary {sidecar-pck}: download, verify and stage. A coroutine.
func stage_sidecar(check: PKeyUpdateCheck) -> PKeyApplyResult:
	if not active():
		return PKeyApplyResult.refused("inert")
	var r := await PKeySidecarSwap.stage(self, check)
	if r.ok:
		var st := slots.load_state()
		PKeySlots.add_event(st, PKeyConstants.UpdateEvent.UPDATE_DOWNLOADED, r.version, int(Time.get_unix_time_from_system()))
		slots.save_state(st)
		update_staged.emit(r.version)
	return r


## code-ready: swap the staged pack in and restart ("Restart to update"). When the pack beside the
## executable cannot be replaced now (a Windows lock), the staged update is kept, the game
## restarts anyway, and the boot guard applies it at the next launch. A coroutine.
func restart_to_update() -> PKeyApplyResult:
	if not active():
		return PKeyApplyResult.refused("inert")
	var st := slots.load_state()
	var staged = slots.meta("staged")
	if not (staged is Dictionary):
		return PKeyApplyResult.failed(PKeyErrors.PAYLOAD_MISMATCH, "Nothing complete is staged.")
	if not (slots.meta("current") is Dictionary):
		st["binaryVersion"] = running_version()
	var r := await PKeySidecarSwap.apply_staged(self, st)
	if r["ok"]:
		st["journal"] = null
		st["failedBoots"] = 0
		st["notice"] = "applied"
		PKeySlots.add_event(st, PKeyConstants.UpdateEvent.UPDATE_APPLIED, staged["version"], int(Time.get_unix_time_from_system()))
		slots.save_state(st)
		restart("applied")
		return PKeyApplyResult.of(PKeyApplyResult.RESTART, {"version": staged["version"], "method": "sidecar-pck"})
	if r["code"] == PKeyErrors.SWAP_FAILED and slots.meta("staged") is Dictionary:
		slots.save_state(st)
		restart("deferred")
		return PKeyApplyResult.of(PKeyApplyResult.RESTART, {"version": staged["version"], "method": "sidecar-pck", "deferred": true})
	slots.save_state(st)
	return PKeyApplyResult.failed(StringName(r["code"]), r["message"], {"reason": r.get("reason", "")})


func restart(reason: String) -> void:
	restart_reason = reason
	env.restart()


func rename(from: String, to: String) -> int:
	if rename_hook.is_valid():
		return int(rename_hook.call(from, to))
	return DirAccess.rename_absolute(from, to)


## Drop the staged update (a channel switch, a decision's discardStaged). True when one was
## dropped.
func drop_staged(_reason := "") -> bool:
	if slots == null or not DirAccess.dir_exists_absolute(slots.dir("staged")):
		return false
	slots.drop("staged")
	return true


## The boot guard (PKeyBootGuard.run). A coroutine.
func run_guard() -> Dictionary:
	_confirmed = false
	last_guard = await PKeyBootGuard.run(self)
	return last_guard


# ── Boot confirmation ────────────────────────────────────────────────────────────────────────

## The outcome PKeyBoot reached (see the class doc).
func note_outcome(outcome: String) -> void:
	_outcome = outcome
	if not active():
		return
	_confirm_gen += 1
	match PKeyStages.boot_confirmation(outcome):
		"now":
			_confirm()
		"after-ok-seconds":
			_confirm_later(_confirm_gen)


func _confirm_later(gen: int) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return
	await tree.create_timer(boot_ok_seconds, true, false, true).timeout
	if gen == _confirm_gen and _outcome == "ready":
		_confirm()


## The game's explicit confirmation while the outcome is `ready` (or when it runs no PKeyBoot).
## True when the launch is (now) confirmed.
func confirm_boot() -> bool:
	if _outcome != "ready" and _outcome != "":
		return false
	_confirm()
	return true


func _confirm() -> void:
	if not active() or _confirmed:
		return
	_confirmed = true
	var st := slots.load_state()
	var cur = slots.meta("current")
	if float(st["failedBoots"]) != 0.0 or (cur is Dictionary and st.get("confirmedVersion") != cur["version"]):
		st["failedBoots"] = 0
		if cur is Dictionary and st.get("confirmedVersion") != cur["version"]:
			st["confirmedVersion"] = cur["version"]
			PKeySlots.add_event(st, PKeyConstants.UpdateEvent.UPDATE_CONFIRMED, cur["version"], int(Time.get_unix_time_from_system()))
		slots.save_state(st)
	boot_confirmed.emit()


## Whether this launch has been confirmed.
func is_confirmed() -> bool:
	return _confirmed
