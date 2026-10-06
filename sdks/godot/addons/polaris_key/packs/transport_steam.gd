class_name PKeyPackSteamTransport
extends PKeyPackPlatformTransport
## `steam-depot` (P5-08; CONTENT §7, notes/E3 §B3): packs installed by Steam from depots, read
## through GodotSteam (the `Steam` singleton, GDExtension or module) when the build has it.
## Unsupported `runtime` on Android, iOS and the web, `dependency` without GodotSteam, `outlet`
## when Steam is not running this copy.
##
## `pkey transport steam-depot vdf` lays a pack's depot out as `pkey_packs/<pack id>/` (the payload
## and its marker, or a tree with `.pkey/pack.json`) under the app's install directory
## (`Steam.getAppInstallDir(getAppID())`; the executable's directory when GodotSteam does not say).
## The transport only reads there: Steam owns the install directory, and nothing is ever written
## into it (CONTENT §7). A content-only build moves a compatible pack on a branch, so a delivered
## release may be newer than the build's pin (`floats()` true).
##
## A paid pack is a DLC depot: `dlc` maps its pack id to the DLC's app id. Its files count only
## while `isDLCInstalled` says so; ensure_pack asks Steam to install it (`installDLC`) and waits for
## `dlc_installed`. Ownership itself is P6-01's commerce check. `build_id()` and `beta_name()` are
## for diagnostics (which build and branch put these bytes here).

const PACKS_DIR := "pkey_packs"
const SINGLETON := "Steam"

## The GodotSteam object to use instead of the `Steam` singleton (tests).
var steam: Object = null
## The platform this answers for ("" means PKeyHeaders.update_platform()). Tests set it.
var platform := ""
## Pack id → DLC app id, for packs shipped as DLC depots.
var dlc := {}
## The install directory to read instead of asking Steam (tests, or a host that knows better).
var install_dir := ""
## How long ensure_pack waits for a DLC install.
var install_timeout_s := 3600.0


func _init(p_steam: Object = null) -> void:
	steam = p_steam


func _steam() -> Object:
	if steam != null:
		return steam
	if Engine.has_singleton(SINGLETON):
		return Engine.get_singleton(SINGLETON)
	return null


func id() -> String:
	return PKeyConstants.Transport.STEAM_DEPOT


func feature() -> String:
	return PKeyConstants.Feature.PACKS_TRANSPORT_STEAM


func floats() -> bool:
	return true


func availability() -> PKeyResult:
	var p := platform if platform != "" else PKeyHeaders.update_platform()
	if steam == null and p in [PKeyConstants.Platform.ANDROID, PKeyConstants.Platform.IOS, PKeyConstants.Platform.WEB]:
		return PKeyResult.unsupported(feature(), PKeyConstants.UnsupportedReason.RUNTIME, "Steam does not distribute %s builds." % p)
	var s := _steam()
	if s == null:
		return PKeyResult.unsupported(feature(), PKeyConstants.UnsupportedReason.DEPENDENCY, "GodotSteam (the Steam singleton) is not in this build.")
	if s.has_method("isSteamRunning") and s.call("isSteamRunning") != true:
		return PKeyResult.unsupported(feature(), PKeyConstants.UnsupportedReason.OUTLET, "Steam is not running this copy.")
	return PKeyResult.success()


## The app's install directory, from Steam (read every call).
func app_dir() -> String:
	if install_dir != "":
		return install_dir.trim_suffix("/")
	var s := _steam()
	if s != null and s.has_method("getAppInstallDir"):
		var app_id = s.call("getAppID") if s.has_method("getAppID") else 0
		var r = s.call("getAppInstallDir", int(app_id))
		var d = r.get("directory") if r is Dictionary else r
		if d is String and d != "":
			return d.trim_suffix("/")
	return OS.get_executable_path().get_base_dir()


## The Steam build id of the installed app (0 when unknown).
func build_id() -> int:
	var s := _steam()
	return int(s.call("getAppBuildId")) if s != null and s.has_method("getAppBuildId") else 0


## The beta branch this copy runs ("" on the default branch or when unknown).
func beta_name() -> String:
	var s := _steam()
	if s == null or not s.has_method("getCurrentBetaName"):
		return ""
	var r = s.call("getCurrentBetaName")
	if r is Dictionary:
		r = r.get("name", r.get("branch", ""))
	return String(r) if r is String else ""


func _dlc_installed(pack_id: String) -> bool:
	if not dlc.has(pack_id):
		return true
	var s := _steam()
	return s != null and s.has_method("isDLCInstalled") and s.call("isDLCInstalled", int(dlc[pack_id])) == true


func _locate(pack_id: String) -> Dictionary:
	if not _dlc_installed(pack_id):
		return {"missing": true}
	var dir := app_dir().path_join(PACKS_DIR).path_join(pack_id)
	if not DirAccess.dir_exists_absolute(dir):
		return {"missing": true}
	return {"dir": dir}


func _fetch(pack_id: String) -> PKeyResult:
	if _dlc_installed(pack_id):
		var b: Dictionary = await baseline(pack_id)
		if b.is_empty():
			return PKeyResult.failure(PKeyErrors.PLATFORM_ERROR, "Steam holds no copy of %s under %s (its depot is not in this build)." % [pack_id, app_dir().path_join(PACKS_DIR)])
		return PKeyResult.success({"buildId": build_id(), "beta": beta_name()})
	var s := _steam()
	var app := int(dlc[pack_id])
	if not s.has_method("installDLC"):
		return PKeyResult.failure(PKeyErrors.PLATFORM_ERROR, "This GodotSteam cannot install DLC %d." % app)
	var done := [false]
	var on_installed := func(installed_app: int) -> void:
		if int(installed_app) == app:
			done[0] = true
	if s.has_signal("dlc_installed"):
		s.connect("dlc_installed", on_installed)
	s.call("installDLC", app)
	var deadline := Time.get_ticks_msec() + int(install_timeout_s * 1000.0)
	while not done[0] and not _dlc_installed(pack_id):
		if Time.get_ticks_msec() > deadline:
			break
		await PKeyPackPlatformTransport._frame()
		if s.has_method("run_callbacks"):
			s.call("run_callbacks")
	if s.has_signal("dlc_installed") and s.is_connected("dlc_installed", on_installed):
		s.disconnect("dlc_installed", on_installed)
	if not _dlc_installed(pack_id):
		return PKeyResult.failure(PKeyErrors.TIMEOUT, "Steam did not install DLC %d for %s in time." % [app, pack_id])
	return PKeyResult.success({"dlc": app, "buildId": build_id(), "beta": beta_name()})
