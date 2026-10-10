class_name PKeyAppImageBridge
extends PKeyNativeBridge
## AppImage installs use the selected build from the verified Polaris release record, not the
## image's embedded zsync feed. The updater downloads into a private directory beside $APPIMAGE,
## checks size and SHA-256, then atomically replaces it and relaunches $APPIMAGE (the mounted
## executable still points at the old image). The generic native hook cannot install an image.

const TOOL := "appimageupdatetool"
const PRIVATE_MODE := FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER


func id() -> String:
	return "appimage"


func is_available() -> bool:
	var image := env.env("APPIMAGE")
	return env.platform() == "linux" and image.is_absolute_path() and env.file_exists(image)


## `appimageupdatetool -j` is informational only; it never authorizes installation.
func check_now() -> PKeyApplyResult:
	if not is_available() or env.find_program(TOOL) == "":
		return PKeyApplyResult.missing_dependency(id())
	var code := await _run(PackedStringArray(["-j", env.env("APPIMAGE")]))
	if code == 0 or code == 1:
		return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": id(), "method": "native", "available": code == 1})
	return PKeyApplyResult.failed(PKeyErrors.UNSUPPORTED, "%s -j exited with %d." % [TOOL, code], {"feature": PKeyConstants.Feature.UPDATE_DRIVER, "reason": "runtime", "bridge": id()})


## No plugin or exit code may bypass release-record verification.
func install_and_relaunch() -> PKeyApplyResult:
	return PKeyApplyResult.failed(PKeyErrors.INVALID_OPTIONS, "Installing an AppImage needs the PKeyUpdateCheck (its verified record) through PKeyUpdater.install_appimage(check).")


## `request` supplies transport, URL, headers and download options only. Artifact authorization
## comes exclusively from `check`, the pinned-release-key-verified result of update.decide().
func install_verified(check: PKeyUpdateCheck, request: Dictionary) -> PKeyApplyResult:
	if check == null or not check.ok:
		return PKeyApplyResult.failed(PKeyErrors.INVALID_OPTIONS, "Installing an AppImage needs a successful PKeyUpdateCheck.")
	var d := check.decision
	var release = d.get("release")
	var build_id := String(d.get("build", ""))
	var build := PKeySidecarSwap.build_of(check.record_doc, build_id)
	var art = PKeySidecarSwap.payload_of(check.record_doc, build_id)
	if d.get("action") != "binary" or d.get("method") != "native" or not (release is Dictionary) or not (check.record_doc is Dictionary) or check.record_doc.get("version") != release.get("version") or build.get("platform") != "linux" or build.get("format") != "appimage" or art == null:
		return PKeyApplyResult.failed(PKeyErrors.RECORD_MISMATCH, "The verified record names no selected AppImage payload for this decision.")
	# Snapshot authorization before any await; no request field can replace these constraints.
	art = art.duplicate(true)
	var size := int(art["size"])
	var sha := String(art["sha256"])
	if size <= 0 or float(art["size"]) != float(size) or not PKeyRelease._is_hex64(sha):
		return PKeyApplyResult.failed(PKeyErrors.RECORD_MISMATCH, "The AppImage payload needs a positive integer size and SHA-256.")
	if not is_available():
		return PKeyApplyResult.missing_dependency(id())
	var image := env.env("APPIMAGE")
	var url := String(request.get("url", ""))
	if url == "":
		return PKeyApplyResult.failed(PKeyErrors.SERVICE_UNAVAILABLE, "Discovery names no builds URL.")
	# A sibling directory keeps the final rename on the same filesystem. Never reuse a path
	# an earlier process could have left behind, and never download over the running image.
	var dir := image.get_base_dir().path_join(".pkey-appimage-%s" % Crypto.new().generate_random_bytes(16).hex_encode())
	if DirAccess.make_dir_absolute(dir) != OK:
		return PKeyApplyResult.failed(PKeyErrors.STORE_FAILED, "A private AppImage staging directory could not be created.")
	if FileAccess.set_unix_permissions(dir, PRIVATE_MODE) != OK:
		DirAccess.remove_absolute(dir)
		return PKeyApplyResult.failed(PKeyErrors.STORE_FAILED, "The AppImage staging directory could not be made private.")
	var fresh := dir.path_join("update.AppImage")
	var download := request.duplicate()
	download["artifact"] = art
	download["to"] = fresh
	var r := await PKeyRelease.download_artifact(download)
	if not r.ok:
		_cleanup(fresh, dir)
		return PKeyApplyResult.failed(r.code, r.message, r.detail)
	# Re-read the final staged file before committing, and set only owner permissions (no suid).
	if not await PKeySlots.verify_file(fresh, size, sha):
		_cleanup(fresh, dir)
		return PKeyApplyResult.failed(PKeyErrors.PAYLOAD_MISMATCH, "The staged AppImage does not match the verified record; nothing was installed.")
	if FileAccess.set_unix_permissions(fresh, PRIVATE_MODE) != OK:
		_cleanup(fresh, dir)
		return PKeyApplyResult.failed(PKeyErrors.STORE_FAILED, "The verified AppImage could not be made executable.")
	var rename: Callable = request.get("rename", Callable())
	var code: int = rename.call(fresh, image) if rename.is_valid() else DirAccess.rename_absolute(fresh, image)
	if code != OK:
		_cleanup(fresh, dir)
		return PKeyApplyResult.failed(PKeyErrors.SWAP_FAILED, "The verified AppImage could not replace the running image.")
	DirAccess.remove_absolute(dir)
	if env.relaunch(image) <= 0:
		return PKeyApplyResult.failed(PKeyErrors.SWAP_FAILED, "The verified AppImage was installed but could not be relaunched.")
	return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": id(), "method": "native", "sha256": sha})


static func _cleanup(fresh: String, dir: String) -> void:
	if FileAccess.file_exists(fresh):
		DirAccess.remove_absolute(fresh)
	if FileAccess.file_exists(fresh + ".part"):
		DirAccess.remove_absolute(fresh + ".part")
	DirAccess.remove_absolute(dir)


## OS.execute off the main thread (only the informational check uses the external tool).
func _run(args: PackedStringArray) -> int:
	var tool := env.find_program(TOOL)
	var r := await PKeySlots._off_thread(func() -> Dictionary: return {"ok": true, "code": env.execute(tool, args)})
	return int(r.get("code", -1))
