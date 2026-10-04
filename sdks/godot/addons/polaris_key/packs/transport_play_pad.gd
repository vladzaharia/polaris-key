class_name PKeyPackPlayPadTransport
extends PKeyPackPlatformTransport
## `play-pad` (P5-08; CONTENT §7, notes/S-05 §4.2): fast-follow and on-demand Play asset packs
## through P5-06's PKeyAndroid (`pack_fetch`, `pack_location`, `pack_confirm`, `pack_progress`).
## Unsupported `runtime` off Android, `dependency` without the plugin, `outlet` on the direct
## build. Install-time packs are not this transport's: Godot's own install-time pack is merged
## into the APK's assets (`res://`), so a pack shipped that way is an embedded baseline.
##
## The Play asset-pack (Gradle module) name of a pack id replaces `.` and `-` with `_`
## (`diceroll.foes` → `diceroll_foes`; `pkey transport play-pad modules` writes the module, the
## same mapping as `@polaris-key/manifest`'s `padPackName`). The module carries the payload and its
## marker under `assets/pkey/`, or under `assets/pkey#tcf_<format>/` per texture format; Play
## delivers one of them (suffix-stripped or not), so the transport reads whichever `pkey*`
## directory the pack's `assetsPath()` holds. That path contains the versionCode, so it is read
## again on every call and never persisted (S-05 §4.2).
##
## Play asset packs change only with a new app bundle, so a pack delivered this way stays pinned
## (`floats()` false, CONTENT §6.6): a copy that is not the build's pinned release is refused.
##
## A large download on a cellular network stops at WAITING_FOR_WIFI or
## REQUIRES_USER_CONFIRMATION. `confirm_hook(pack_id, state) -> bool` (may be a coroutine) lets the
## game show its own size disclosure first (Apple 4.2.3(ii)-style consent stays the planner's and
## PKeyBoot's job): true shows Play's confirmation dialog, false cancels the download (`cancelled`).
## Without a hook Play's dialog is shown at once. `last_state(pack_id)` has the sizes.

## AssetPackStatus values.
const PENDING := 1
const DOWNLOADING := 2
const TRANSFERRING := 3
const COMPLETED := 4
const FAILED := 5
const CANCELED := 6
const WAITING_FOR_WIFI := 7
const NOT_INSTALLED := 8
const REQUIRES_USER_CONFIRMATION := 9
## The directory a module's payload sits in, below its assets path.
const PREFIX := "pkey"

## The PKeyAndroid facade (PKeyAndroid.shared() when null).
var android: PKeyAndroid = null
## (pack_id: String, state: Dictionary) -> bool, or empty for Play's own dialog at once.
var confirm_hook := Callable()
## How long ensure_pack waits for Play to finish.
var fetch_timeout_s := 3600.0

var _states := {}


func _init(p_android: PKeyAndroid = null) -> void:
	android = p_android


func _android() -> PKeyAndroid:
	if android == null:
		android = PKeyAndroid.shared()
	return android


func id() -> String:
	return PKeyConstants.Transport.PLAY_PAD


func feature() -> String:
	return PKeyConstants.Feature.PACKS_TRANSPORT_PLAY


func floats() -> bool:
	return false


## The Play asset-pack name of `pack_id`.
static func pad_name(pack_id: String) -> String:
	return pack_id.replace(".", "_").replace("-", "_")


func availability() -> PKeyResult:
	return _android().packs_availability()


## The last Play state seen for `pack_id` ({status, bytesDownloaded, totalBytes, …}), or {}.
func last_state(pack_id: String) -> Dictionary:
	return _states.get(pad_name(pack_id), {})


func _locate(pack_id: String) -> Dictionary:
	var r := _android().pack_location(pad_name(pack_id))
	if not r.ok:
		return {"result": r}
	var loc = r.detail.get("location") if r.detail is Dictionary else null
	if not (loc is Dictionary) or loc.get("installTime") == true or not (loc.get("assetsPath") is String):
		return {"missing": true}
	var assets := String(loc["assetsPath"]).trim_suffix("/")
	var l := PKeyPackStorage.list_dir(assets)
	if not l["ok"]:
		return {"missing": true}
	var dirs: Array = Array(l["dirs"])
	dirs.sort()
	if dirs.has(PREFIX):
		return {"dir": assets.path_join(PREFIX)}
	for d in dirs:
		if String(d).begins_with(PREFIX + "#tcf_"):
			return {"dir": assets.path_join(String(d))}
	return {"missing": true}


func _on_state(name: String, state: Dictionary) -> void:
	_states[name] = state


func _fetch(pack_id: String) -> PKeyResult:
	var name := pad_name(pack_id)
	var a := _android()
	var seen := func(n: String, state: Dictionary) -> void:
		if n != name:
			return
		_on_state(n, state)
		pack_progress.emit(pack_id, int(state.get("bytesDownloaded", 0)), int(state.get("totalBytes", 0)))
	a.pack_progress.connect(seen)
	var r := await _fetch_inner(pack_id, name, a)
	a.pack_progress.disconnect(seen)
	return r


func _fetch_inner(pack_id: String, name: String, a: PKeyAndroid) -> PKeyResult:
	_states.erase(name)
	var r: PKeyResult = await a.pack_fetch(name)
	if not r.ok:
		return r
	if r.detail is Dictionary and r.detail.get("state") is Dictionary and not _states.has(name):
		_on_state(name, r.detail["state"])
	var confirmed := false
	var deadline := Time.get_ticks_msec() + int(fetch_timeout_s * 1000.0)
	while true:
		var st: Dictionary = _states.get(name, {})
		var status := int(st.get("status", 0))
		match status:
			COMPLETED:
				return PKeyResult.success(st)
			FAILED, CANCELED:
				return PKeyResult.failure(PKeyErrors.CANCELLED if status == CANCELED else PKeyErrors.PLATFORM_ERROR, "Play Asset Delivery stopped %s (status %d, error %d)." % [name, status, int(st.get("errorCode", 0))], st)
			WAITING_FOR_WIFI, REQUIRES_USER_CONFIRMATION:
				if not confirmed:
					confirmed = true
					var go = true
					if confirm_hook.is_valid():
						go = await confirm_hook.call(pack_id, st)
					if go != true:
						a.pack_cancel(name)
						return PKeyResult.failure(PKeyErrors.CANCELLED, "The download of %s was declined." % name, st)
					var c: PKeyResult = await a.pack_confirm()
					if not c.ok:
						return c
		if Time.get_ticks_msec() > deadline:
			return PKeyResult.failure(PKeyErrors.TIMEOUT, "Play Asset Delivery did not finish %s in time." % name, st)
		await PKeyPackPlatformTransport._frame()
		a.poll()
	return PKeyResult.failure(PKeyErrors.PLATFORM_ERROR, "unreachable")
