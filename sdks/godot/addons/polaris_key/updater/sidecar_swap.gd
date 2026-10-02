class_name PKeySidecarSwap
extends RefCounted
## The sidecar-PCK swap (README §5.6 option 2; P3-10): a code update for a writable, portable
## Windows or Linux install, WITHOUT `--main-pack`. Godot loads `<exe-name>.pck` beside the
## executable at start-up, before any script runs, so an update replaces that file and restarts.
##
##   support(env)           {ok, reason, pck}: can this install take a swap at all
##   stage(updater, check)  binary {method: sidecar-pck}: download the record's `pck` build from
##                          discovery's `distribution.endpoints.builds` (Range resume), verify
##                          size and SHA-256 against the verified record, move it into the
##                          `staged` slot with its meta. A coroutine -> PKeyApplyResult
##   apply_staged(updater)  verify the staged pack AGAIN, keep the running pack as `previous`,
##                          replace `<exe-name>.pck`. The caller restarts at once. A coroutine
##   roll_back(updater)     put `previous` back over `<exe-name>.pck`. A coroutine
##
## Refused (`swap-refused`, `detail.reason`) on a platform other than Windows and Linux (and macOS
## outside an `.app`), inside a macOS `.app` (it would break the seal), under `Program Files`, in
## an MSIX install (a `WindowsApps` path segment, compared case-insensitively on either separator:
## Godot returns `/` on Windows; the install directory is read-only, S-05 §4.4), in Flatpak, Snap
## and AppImage installs (read-only images), in a Velopack install (an update replaces the whole
## app directory and deletes a sidecar, S-05 §4.5), with no sidecar `.pck` (an embedded pack), and
## where the directory is not writable.
##
## Crash safety. The new bytes are first copied BESIDE the pack (`<pck>.pkey-new`, same volume)
## and verified there; the journal in `state.json` names the swap; then one rename replaces the
## pack. On POSIX that rename is atomic, so `<exe-name>.pck` is never missing. On Windows Godot's
## DirAccess.rename removes the target and moves the new file in (two calls; a crash between them
## is the one window this design cannot close without a helper process). The boot guard finishes
## or discards a journalled swap at the next launch by comparing the pack with the journal.
##
## Windows rename. If the running game holds the pack open, the rename fails; it is retried 12
## times 250 ms apart (Diceroll's numbers), and if it still fails the staged update is KEPT and the
## guard applies it at the next launch, followed by one immediate restart (a second restart, the
## brief's fallback; no detached helper). Not yet measured on Windows (see the README).

const RENAME_TRIES := 12
const RENAME_WAIT_MSEC := 250
const NEW_SUFFIX := ".pkey-new"

## Path segments (lower-case) that mark an install the swap must not touch.
static var _program_files := PackedStringArray(["program files", "program files (x86)"])


## {ok, reason, pck}: whether `env`'s install can take a sidecar swap, and the pack it would
## replace. `reason` is "" when ok.
static func support(env: PKeyUpdaterEnv) -> Dictionary:
	var exe := env.executable_path()
	var out := {"ok": false, "reason": "", "pck": ""}
	var platform := env.platform()
	var segments := PackedStringArray()
	for s in exe.replace("\\", "/").split("/", false):
		segments.append(s.to_lower())
	if platform == "macos":
		for s in segments:
			if s.ends_with(".app"):
				out["reason"] = "app-bundle"
				return out
	elif platform != "windows" and platform != "linux":
		out["reason"] = "platform"
		return out
	if segments.has("windowsapps"):
		out["reason"] = "msix"
		return out
	for s in segments:
		if _program_files.has(s):
			out["reason"] = "program-files"
			return out
	if env.env("FLATPAK_ID") != "" or env.file_exists("/.flatpak-info"):
		out["reason"] = "flatpak"
		return out
	if env.env("SNAP") != "":
		out["reason"] = "snap"
		return out
	if env.env("APPIMAGE") != "":
		out["reason"] = "appimage"
		return out
	if is_velopack(env, exe):
		out["reason"] = "velopack"
		return out
	var pck := pck_path(env, exe)
	if pck == "":
		out["reason"] = "no-sidecar"
		return out
	if not writable(pck.get_base_dir()):
		out["reason"] = "not-writable"
		return out
	out["ok"] = true
	out["pck"] = pck
	return out


## The pack Godot loads beside `exe`: `<exe without extension>.pck`, else `<exe>.pck` (main.cpp
## tries both), or "" when neither exists (the pack is embedded).
static func pck_path(env: PKeyUpdaterEnv, exe: String) -> String:
	var a := exe.get_basename() + ".pck"
	if env.file_exists(a):
		return a
	var b := exe + ".pck"
	return b if env.file_exists(b) else ""


## A Velopack install [I]: Velopack runs the app from `<root>/current/` with `Update.exe` (Windows)
## in `<root>`, and writes `sq.version` beside the executable.
static func is_velopack(env: PKeyUpdaterEnv, exe: String) -> bool:
	var d := exe.get_base_dir()
	if env.file_exists(d.path_join("sq.version")):
		return true
	return d.get_file().to_lower() == "current" and (env.file_exists(d.get_base_dir().path_join("Update.exe")) or env.file_exists(d.get_base_dir().path_join("UpdateNix")))


## Whether a file can be created and removed in `dir`.
static func writable(dir: String) -> bool:
	var probe := dir.path_join(".pkey-write-test")
	var f := FileAccess.open(probe, FileAccess.WRITE)
	if f == null:
		return false
	f.close()
	return DirAccess.remove_absolute(probe) == OK


# ── Stage ─────────────────────────────────────────────────────────────────────────────────────

## binary {method: sidecar-pck} from `check` (a PKeyUpdateCheck): download, verify and stage the
## record's code pack. Changes nothing on a size or hash mismatch. A coroutine.
static func stage(updater: PKeyUpdater, check: PKeyUpdateCheck) -> PKeyApplyResult:
	var d: Dictionary = check.decision
	var sup := support(updater.env)
	if not sup["ok"]:
		return PKeyApplyResult.refused(sup["reason"])
	var art = payload_of(check.record_doc, String(d.get("build", "")))
	if not (art is Dictionary):
		return PKeyApplyResult.failed(PKeyErrors.RECORD_MISMATCH, "The verified record has no build '%s' with one payload." % d.get("build", ""))
	var version: String = d["release"]["version"]
	var slots := updater.slots
	var held = slots.meta("staged")
	if held is Dictionary and held["sha256"] == art["sha256"] and held.get("channel") == check.channel:
		return PKeyApplyResult.of("staged", {"version": version, "method": "sidecar-pck"})
	var url := updater.build_url(version, String(d["build"]))
	if url == "":
		return PKeyApplyResult.failed(PKeyErrors.SERVICE_UNAVAILABLE, "Discovery names no distribution.endpoints.builds (or release.endpoints.builds) URL.")
	var tmp := slots.dir("staged.tmp")
	DirAccess.make_dir_recursive_absolute(tmp)
	var dest := tmp.path_join(PKeySlots.PAYLOAD)
	var r := await PKeyDownload.fetch(updater.transport(), url, dest, updater.download_headers(), {
		"expected_size": int(art["size"]),
		"timeout": updater.download_timeout,
		"progress": func(got: int, total: int) -> void: updater.download_progress.emit(got, total),
	})
	if not r.ok:
		return PKeyApplyResult.failed(r.code, r.message, r.detail)
	var part: String = r.detail["path"]
	if not await PKeySlots.verify_file(part, int(art["size"]), String(art["sha256"])):
		DirAccess.remove_absolute(part)
		return PKeyApplyResult.failed(PKeyErrors.PAYLOAD_MISMATCH, "The downloaded pack does not match the record's size and SHA-256; nothing was staged.")
	if DirAccess.rename_absolute(part, dest) != OK:
		return PKeyApplyResult.failed(PKeyErrors.STORE_FAILED, "The verified pack could not be moved into the staged slot.")
	var build: Dictionary = build_of(check.record_doc, String(d["build"]))
	var req: Dictionary = build["requires"] if build.get("requires") is Dictionary else {}
	slots.write_meta("staged.tmp", {
		"version": version,
		"channel": check.channel,
		"buildNumber": build.get("buildNumber"),
		"build": d["build"],
		"recordHash": d["release"].get("sha256"),
		"sha256": String(art["sha256"]).to_lower(),
		"size": int(art["size"]),
		"engine": req.get("engine"),
		"scheme": check.feed_doc.get("app", {}).get("versionScheme", "semver"),
	})
	if not slots.promote("staged.tmp", "staged"):
		return PKeyApplyResult.failed(PKeyErrors.STORE_FAILED, "The staged slot could not be written.")
	return PKeyApplyResult.of("staged", {"version": version, "method": "sidecar-pck"})


## The build `id` of a verified record, or {}.
static func build_of(record: Variant, id: String) -> Dictionary:
	if record is Dictionary and record.get("builds") is Array:
		for b in record["builds"]:
			if b is Dictionary and b.get("id") == id:
				return b
	return {}


## The one `payload` artifact of build `id` ({name, role, sha256, size}), or null.
static func payload_of(record: Variant, id: String) -> Variant:
	var b := build_of(record, id)
	if not (b.get("artifacts") is Array):
		return null
	var found = null
	for a in b["artifacts"]:
		if a is Dictionary and a.get("role") == "payload":
			if found != null:
				return null
			found = a
	if found == null or not (found.get("sha256") is String) or not PKeyClaims.is_number(found.get("size")):
		return null
	return found


# ── Apply and roll back ───────────────────────────────────────────────────────────────────────

## Swap the staged pack in: {ok, code, message}. Re-verifies the staged bytes, keeps the running
## pack as `previous` (with the current meta, or a `shipped` meta for the pack the binary came
## with), copies the staged pack beside the target, verifies it there, journals, renames, and
## records the new `current`. The caller restarts at once: the running process still holds the
## old pack's directory. A coroutine.
static func apply_staged(updater: PKeyUpdater, state: Dictionary) -> Dictionary:
	var slots := updater.slots
	var staged = slots.meta("staged")
	if not (staged is Dictionary):
		return _fail(PKeyErrors.PAYLOAD_MISMATCH, "Nothing complete is staged.")
	var sup := support(updater.env)
	if not sup["ok"]:
		return _fail(PKeyErrors.SWAP_REFUSED, "This install cannot take a sidecar swap (%s)." % sup["reason"], sup["reason"])
	if not await PKeySlots.verify_file(slots.payload("staged"), int(staged["size"]), String(staged["sha256"])):
		slots.drop("staged")
		return _fail(PKeyErrors.PAYLOAD_MISMATCH, "The staged pack no longer matches its record; it was discarded.")
	var pck: String = sup["pck"]
	# Keep what runs now as `previous`, so a bad update can be rolled back.
	var copy := await PKeySlots.copy_file(pck, slots.payload("previous.tmp"))
	if not copy["ok"]:
		slots.drop("previous.tmp")
		return _fail(PKeyErrors.SWAP_FAILED, "The running pack could not be kept as previous.")
	var cur = slots.meta("current")
	var prev_meta: Dictionary = cur.duplicate() if cur is Dictionary else {"version": state.get("binaryVersion") if state.get("binaryVersion") is String else updater.running_version(), "shipped": true, "engine": PKeyBuildStamp.engine_id()}
	prev_meta["sha256"] = copy["sha256"]
	prev_meta["size"] = copy["size"]
	slots.write_meta("previous.tmp", prev_meta)
	var r := await replace(updater, slots.payload("staged"), int(staged["size"]), String(staged["sha256"]), pck, state, "apply")
	if not r["ok"]:
		slots.drop("previous.tmp")
		return r
	slots.promote("previous.tmp", "previous")
	slots.write_meta("current", staged)
	slots.drop("staged")
	return {"ok": true, "code": "", "message": ""}


## Put `previous` back: {ok, code, message, restored (the meta now current, or null for the shipped
## pack)}. A coroutine.
static func roll_back(updater: PKeyUpdater, state: Dictionary) -> Dictionary:
	var slots := updater.slots
	var prev = slots.meta("previous")
	if not (prev is Dictionary):
		return _fail(PKeyErrors.SWAP_FAILED, "There is no previous pack to restore.")
	var sup := support(updater.env)
	if not sup["ok"]:
		return _fail(PKeyErrors.SWAP_REFUSED, "This install cannot take a sidecar swap (%s)." % sup["reason"], sup["reason"])
	var r := await replace(updater, slots.payload("previous"), int(prev["size"]), String(prev["sha256"]), sup["pck"], state, "roll-back")
	if not r["ok"]:
		return r
	if prev.get("shipped") == true:
		slots.drop("current")
		r["restored"] = null
	else:
		slots.write_meta("current", prev)
		r["restored"] = prev
	slots.drop("previous")
	return r


## Copy `src` beside `pck`, verify it there, journal the swap in `state`, and rename it over the
## pack (retried for Windows file locks). {ok, code, message}. A coroutine.
static func replace(updater: PKeyUpdater, src: String, size: int, sha256: String, pck: String, state: Dictionary, kind: String) -> Dictionary:
	var fresh := pck + NEW_SUFFIX
	var copy := await PKeySlots.copy_file(src, fresh)
	if not copy["ok"] or copy["size"] != size or copy["sha256"] != sha256.to_lower():
		DirAccess.remove_absolute(fresh)
		return _fail(PKeyErrors.PAYLOAD_MISMATCH if copy["ok"] else PKeyErrors.SWAP_FAILED, "The pack copied beside the executable does not verify.")
	state["journal"] = {"kind": kind, "pck": pck, "sha256": sha256.to_lower(), "size": size}
	updater.slots.save_state(state)
	var tree := Engine.get_main_loop() as SceneTree
	for i in RENAME_TRIES:
		if updater.rename(fresh, pck) == OK:
			return {"ok": true, "code": "", "message": ""}
		if tree == null:
			break
		var until := Time.get_ticks_msec() + updater.rename_wait_msec
		while Time.get_ticks_msec() < until:
			await tree.process_frame
	DirAccess.remove_absolute(fresh)
	state["journal"] = null
	updater.slots.save_state(state)
	return _fail(PKeyErrors.SWAP_FAILED, "The pack beside the executable could not be replaced after %d tries (is it open?)." % RENAME_TRIES)


static func _fail(code: StringName, message: String, reason := "") -> Dictionary:
	return {"ok": false, "code": code, "message": message, "reason": reason}
