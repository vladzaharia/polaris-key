class_name PKeyApkUpdate
extends RefCounted
## The Android direct-build update (P5-06): `binary {method: native}` on a direct-flavour Android
## build. The build's APK is downloaded into the app's private storage (`user://`, which is the
## app's files directory on Android), checked against the VERIFIED signed release record (the build's
## one `payload` artifact: size and SHA-256), and handed to PKeyAndroid.apk_install, which checks it
## again (hash, private path, package, signing-certificate set, higher versionCode) and commits a
## PackageInstaller session.
##
## Nothing here comes from an unsigned feed field: the URL is only where the bytes are fetched
## from, and the bytes are accepted only when they hash to the record's artifact. The record carries
## no Android versionCode (`buildNumber` is a free string, not defined as one), so no expected
## versionCode is passed; the plugin still refuses a versionCode that is not above the installed one.
##
## Called from PolarisKey.update.apply(), i.e. after the player chose to update, so the session asks
## Android for no further prompt (`USER_ACTION_NOT_REQUIRED`): Android still shows its own prompt
## when the player has not allowed installs from the game or another installer owns its updates.
## On success the game is killed and not relaunched; the next launch reads the journaled outcome
## (PKeyAndroid.launch_install_outcome()).
##
##   run(android, request) -> PKeyApplyResult   (a coroutine)
##
## `request`: {url, headers, dir, artifact: {sha256, size}, version, build, timeout?, progress?,
## space_ok?: Callable(dir, need) -> bool, silent? (default true)}. Answers:
##   - unsupported (the plugin is missing, or this is a play build): the caller opens the link;
##   - hook {bridge: "apk", method: "native", version, session} when the session was committed;
##   - a failure otherwise: the download's code, `payload-mismatch` (size or hash), or
##     `swap-refused` with the plugin's refusals in `detail.refused`.

const BRIDGE := "apk"
const FILE := "update.apk"


static func run(android: PKeyAndroid, request: Dictionary) -> PKeyApplyResult:
	var gate := android.installer_availability()
	if not gate.ok:
		return PKeyApplyResult.failed(gate.code, gate.message, gate.detail)
	var art = request.get("artifact")
	if not (art is Dictionary) or not (art.get("sha256") is String) or not PKeyClaims.is_number(art.get("size")):
		return PKeyApplyResult.failed(PKeyErrors.RECORD_MISMATCH, "The verified record has no build '%s' with one payload." % str(request.get("build", "")))
	var url := String(request.get("url", ""))
	if url == "":
		return PKeyApplyResult.failed(PKeyErrors.SERVICE_UNAVAILABLE, "Discovery names no distribution.endpoints.builds (or release.endpoints.builds) URL.")
	var size := int(art["size"])
	var sha := String(art["sha256"]).to_lower()
	var dir := String(request.get("dir", "user://pkey/apk"))
	DirAccess.make_dir_recursive_absolute(dir)
	var space_ok: Callable = request.get("space_ok", Callable())
	if space_ok.is_valid() and not bool(space_ok.call(dir, size)):
		return PKeyApplyResult.failed(PKeyErrors.STORE_FAILED, "Not enough free space to download the %d-byte APK." % size, {"reason": "no-space"})
	var dest := dir.path_join(FILE)
	var opts := {"expected_size": size, "timeout": float(request.get("timeout", PKeyDownload.DEFAULT_TIMEOUT))}
	if request.get("progress") is Callable:
		opts["progress"] = request["progress"]
	var r := await PKeyDownload.fetch(request.get("transport"), url, dest, request.get("headers", {}), opts)
	if not r.ok:
		return PKeyApplyResult.failed(r.code, r.message, r.detail)
	var part: String = r.detail["path"]
	if not await PKeySlots.verify_file(part, size, sha):
		DirAccess.remove_absolute(part)
		return PKeyApplyResult.failed(PKeyErrors.PAYLOAD_MISMATCH, "The downloaded APK does not match the record's size and SHA-256; nothing was installed.")
	DirAccess.remove_absolute(dest)
	if DirAccess.rename_absolute(part, dest) != OK:
		return PKeyApplyResult.failed(PKeyErrors.STORE_FAILED, "The verified APK could not be moved into place.")
	var installed := await android.apk_install(ProjectSettings.globalize_path(dest), sha, -1, {"silent": bool(request.get("silent", true)), "prompt": true})
	if not installed.ok:
		DirAccess.remove_absolute(dest)
		return PKeyApplyResult.failed(installed.code, installed.message, installed.detail)
	var d: Dictionary = installed.detail
	if d.get("committed") != true:
		DirAccess.remove_absolute(dest)
		var verify = d.get("verify")
		var refused: Array = verify.get("refused", []) if verify is Dictionary and verify.get("refused") is Array else []
		return PKeyApplyResult.failed(PKeyErrors.SWAP_REFUSED, "The APK was not installed (%s)." % (", ".join(PackedStringArray(refused)) if not refused.is_empty() else str(d.get("error", "refused"))), {"reason": "apk-refused", "refused": refused, "error": d.get("error")})
	# The session holds its own copy of the bytes.
	DirAccess.remove_absolute(dest)
	return PKeyApplyResult.of(PKeyApplyResult.HOOK, {"bridge": BRIDGE, "method": "native", "version": String(request.get("version", "")), "session": d.get("session"), "sha256": sha})
