class_name PKeyAppImageBridge
extends PKeyNativeBridge
## AppImageUpdate on Linux (notes/E3 §B1): an AppImage carries its own update information (P3-09
## embeds `zsync|<update.endpoints.zsync>`), so when `APPIMAGE` is set and `appimageupdatetool`
## is on PATH, `install_and_relaunch()` runs it over the AppImage (`-O`: overwrite in place [I])
## through OS.execute on a worker thread, then starts the updated AppImage and quits. Relaunching
## `OS.get_executable_path()` would start the OLD mounted image, so it relaunches `$APPIMAGE`.
## Without the tool, or outside an AppImage, every call answers `unsupported` (`dependency`) and
## the adapter opens the build's download link. No plugin is needed.

const TOOL := "appimageupdatetool"


func id() -> String:
	return "appimage"


func is_available() -> bool:
	if native != null:
		return super()
	return env.env("APPIMAGE") != "" and env.find_program(TOOL) != ""


## `appimageupdatetool -j` (exit 1: an update is available). A coroutine.
func check_now() -> PKeyApplyResult:
	if native != null:
		return await super()
	if not is_available():
		return PKeyApplyResult.missing_dependency(id())
	var code := await _run(PackedStringArray(["-j", env.env("APPIMAGE")]))
	if code == 0 or code == 1:
		return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": id(), "method": "native", "available": code == 1})
	return PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "%s -j exited with %d." % [TOOL, code], {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": "runtime", "bridge": id()})


## Update the AppImage in place, then relaunch it. A coroutine.
func install_and_relaunch() -> PKeyApplyResult:
	if native != null:
		return await super()
	if not is_available():
		return PKeyApplyResult.missing_dependency(id())
	var image := env.env("APPIMAGE")
	var code := await _run(PackedStringArray(["-O", image]))
	if code != 0:
		return PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "%s exited with %d." % [TOOL, code], {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": "runtime", "bridge": id()})
	env.relaunch(image)
	return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": id(), "method": "native"})


## OS.execute off the main thread (it blocks for the whole download).
func _run(args: PackedStringArray) -> int:
	var tool := env.find_program(TOOL)
	var r := await PKeySlots._off_thread(func() -> Dictionary: return {"ok": true, "code": env.execute(tool, args)})
	return int(r.get("code", -1))
