class_name PKeyBootGuard
extends RefCounted
## The boot guard (P3-10; plans/P1-09.md §2.3, plans/P3-01.md §2.10; notes/A4 §1.5, P9–P11): what
## PKeyBoot's GUARD stage does before anything else loads.
##
##   run(updater)   a coroutine -> {result: "ok" | "applied" | "rolled-back", restart, action,
##                  error}. `result` is what `guard.done` carries; with `restart` true the
##                  updater has asked to restart and the caller sends NOTHING (the next launch
##                  starts a new machine, P1-09 §2.3)
##
## In order:
##
##  1. A journalled swap (state.json `journal`) that a crash interrupted is finished (the pack
##     beside the executable already has the new bytes) or discarded (it does not).
##  2. A `current` slot whose version is not the running stamp's, or whose size is not the pack's,
##     means the install was replaced from outside (a full download, an installer): the slots
##     forget it and the counting stops. With no `current`, the running version IS the binary's
##     (`binaryVersion`, the decision's `installed.binaryVersion` while a code pack runs).
##  3. Staged code is dropped when it is incomplete, built for another engine (`godot-<maj>.<min>`),
##     not newer than the binary (A4 P10: "a newer binary already contains that content"), or no
##     longer matches its size and SHA-256. (A channel switch drops it where it happens: the
##     decision's `discardStaged`, and PKeyDevMenuSection's picker.)
##  4. PKeyStages.boot_guard_action(staged, failedBoots): `roll-back` puts `previous` back,
##     records the bad version as `skipVersion` (a decision input, so it is never re-offered) and
##     restarts; `apply-staged` swaps the staged pack in (PKeySidecarSwap) and restarts; `none`
##     counts this launch (failedBoots + 1) while an applied update is active. A launch reports
##     the swap or rollback the previous launch made (`applied`, `rolled-back`) once.
##
## failedBoots counts the launches of the active slot that passed the guard and were never
## confirmed (P1-09 §2.3): it resets when a launch is confirmed (PKeyUpdater.confirm_boot, the
## BOOT_OK_SECONDS rule) and whenever the active slot changes, and it counts only while an applied
## update is active. Two crashed launches roll back on the third. A swap that cannot be made (a
## Windows lock) keeps the staged update and the launch continues on the old pack.
##
## Packs (P4-08) share the count: it also runs while a new pack set is active (an active pack
## install that is not the release running at the last confirmed launch, PKeyPackState.pending),
## and `roll-back` puts every such pack back to its `previous` together with the binary, so a
## binary and its pack set roll back as one. A packs-only rollback needs no restart (the guard runs
## before MOUNT, so nothing of the bad set is mounted yet): the launch continues on the restored
## set and reports `rolled-back`. Each pack rolled back queues a `boot_rolled_back` event with its
## pack id as the deliverable and the restored set's packSetId.


static func run(updater: PKeyUpdater) -> Dictionary:
	var out := {"result": "ok", "restart": false, "action": "none", "error": ""}
	if not updater.active():
		return out
	var slots := updater.slots
	var st := slots.load_state()
	await _recover(updater, st)
	var loaded := st.duplicate(true)
	var running := updater.running_version()
	var cur = slots.meta("current")
	var sup := PKeySidecarSwap.support(updater.env)
	# 2. Replaced from outside.
	if cur is Dictionary:
		var replaced: bool = cur["version"] != running
		if not replaced and sup["ok"]:
			replaced = PKeySlots.file_size(sup["pck"]) != int(cur["size"])
		if replaced:
			slots.drop("current")
			slots.drop("previous")
			st["failedBoots"] = 0
			st["notice"] = ""
			cur = null
	if cur == null:
		st["binaryVersion"] = running
	# 3. Staged code that no longer applies.
	var staged = slots.meta("staged")
	if staged == null:
		slots.drop("staged")
	else:
		var why := stale_reason(staged, String(st["binaryVersion"]) if st["binaryVersion"] is String else running)
		if why == "" and not await PKeySlots.verify_file(slots.payload("staged"), int(staged["size"]), String(staged["sha256"])):
			why = "corrupt"
		if why != "":
			slots.drop("staged")
			staged = null
	# The pack set the last confirmed launch did not run (P4-08).
	var pending := PackedStringArray()
	var packs = updater.packs
	if packs != null and packs.has_method("pending_for_guard"):
		pending = await packs.pending_for_guard()
	var counting: bool = cur is Dictionary or not pending.is_empty()
	var failed: float = float(st["failedBoots"]) if counting else 0.0
	var action := PKeyStages.boot_guard_action(staged != null, failed)
	out["action"] = action
	var now := int(Time.get_unix_time_from_system())
	match action:
		"roll-back":
			var pack_events := await _roll_back_packs(updater, pending, now)
			for ev in pack_events:
				PKeySlots.add_event(st, ev)
			if not (cur is Dictionary):
				# Packs only: the restored set mounts at this launch; no restart.
				st["failedBoots"] = 0
				st["notice"] = ""
				slots.save_state(st)
				out["result"] = "rolled-back" if not pack_events.is_empty() else "ok"
				return out
			var bad: String = cur["version"]
			var r := await PKeySidecarSwap.roll_back(updater, st)
			st["skipVersion"] = bad
			st["failedBoots"] = 0
			st["journal"] = null
			PKeySlots.add_event(st, updater.event(PKeyConstants.UpdateEvent.BOOT_ROLLED_BACK, cur, null, "failed-boots", now))
			if r["ok"]:
				st["notice"] = "rolled-back"
				slots.save_state(st)
				updater.restart("rolled-back")
				out["result"] = "rolled-back"
				out["restart"] = true
				return out
			# Nothing to restore (or the rename failed): the bad version is skipped from now on and
			# the counting starts again.
			out["error"] = String(r["code"])
			slots.save_state(st)
			return out
		"apply-staged":
			var r := await PKeySidecarSwap.apply_staged(updater, st)
			if r["ok"]:
				st["journal"] = null
				st["failedBoots"] = 0
				st["notice"] = "applied"
				PKeySlots.add_event(st, updater.event(PKeyConstants.UpdateEvent.UPDATE_APPLIED, staged, cur, "", now))
				slots.save_state(st)
				updater.restart("applied")
				out["result"] = "applied"
				out["restart"] = true
				return out
			out["error"] = String(r["code"])
	# 4. none (or a swap that could not be made): report last launch's swap once, count this one.
	if st["notice"] == "applied" or st["notice"] == "rolled-back":
		out["result"] = st["notice"]
	st["notice"] = ""
	if slots.meta("current") is Dictionary or not pending.is_empty():
		st["failedBoots"] = float(st["failedBoots"]) + 1
	else:
		st["failedBoots"] = 0
	# Most launches have nothing applied: no write then (a store build boots without touching the
	# disk here).
	if not st.recursive_equal(loaded, 8):
		slots.save_state(st)
	return out


## Why staged `meta` no longer applies ("" when it does): `engine` (another engine), `not-newer`
## (the binary is at least as new, or a version does not parse).
static func stale_reason(meta: Dictionary, binary_version: String) -> String:
	if meta.get("engine") is String and meta["engine"] != PKeyBuildStamp.engine_id():
		return "engine"
	var scheme: String = meta["scheme"] if meta.get("scheme") is String else "semver"
	var c = PKeyVersion.compare_versions(scheme, meta["version"], binary_version)
	if c == null or int(c) <= 0:
		return "not-newer"
	return ""


## Finish or discard a swap a crash interrupted (see the class doc, step 1).
static func _recover(updater: PKeyUpdater, st: Dictionary) -> void:
	var j = st.get("journal")
	if not (j is Dictionary):
		return
	var slots := updater.slots
	var pck := String(j.get("pck", ""))
	var done: bool = pck != "" and await PKeySlots.verify_file(pck, int(j.get("size", -1)), String(j.get("sha256", "")))
	if pck != "" and FileAccess.file_exists(pck + PKeySidecarSwap.NEW_SUFFIX):
		DirAccess.remove_absolute(pck + PKeySidecarSwap.NEW_SUFFIX)
	if j.get("kind") == "apply":
		if done:
			var staged = slots.meta("staged")
			if staged is Dictionary and staged["sha256"] == j["sha256"]:
				if DirAccess.dir_exists_absolute(slots.dir("previous.tmp")):
					slots.promote("previous.tmp", "previous")
				slots.write_meta("current", staged)
				slots.drop("staged")
			st["failedBoots"] = 0
			st["notice"] = "applied"
		slots.drop("previous.tmp")
	elif j.get("kind") == "roll-back" and done:
		var prev = slots.meta("previous")
		if prev is Dictionary and prev["sha256"] == j["sha256"]:
			st["skipVersion"] = slots.meta("current")["version"] if slots.meta("current") is Dictionary else st.get("skipVersion")
			if prev.get("shipped") == true:
				slots.drop("current")
			else:
				slots.write_meta("current", prev)
			slots.drop("previous")
		st["failedBoots"] = 0
		st["notice"] = "rolled-back"
	st["journal"] = null
	slots.save_state(st)


## Roll the pending packs back to `previous` (P4-08) and build one `boot_rolled_back` event per
## pack rolled back: {deliverable: packId, release: the restored version, fromRelease: the bad one,
## packSetId: the restored running set's, code: failed-boots}. A coroutine.
static func _roll_back_packs(updater: PKeyUpdater, pending: PackedStringArray, now: int) -> Array:
	var out: Array = []
	var packs = updater.packs
	if pending.is_empty() or packs == null or not packs.has_method("roll_back_for_guard"):
		return out
	var rolled: Dictionary = await packs.roll_back_for_guard(pending)
	var set_id = packs.pack_set_id()
	for id in rolled:
		var to: Dictionary = rolled[id]["to"]
		var from = rolled[id]["from"]
		var e := updater.event(PKeyConstants.UpdateEvent.BOOT_ROLLED_BACK, {"version": to["version"]}, {"version": from["version"]} if from is Dictionary else null, "failed-boots", now)
		e["deliverable"] = id
		if set_id is String:
			e["packSetId"] = set_id
		out.append(e)
	return out
