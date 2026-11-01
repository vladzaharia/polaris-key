class_name PKeySaveScreensHost
extends RefCounted
## What the save screens do with `PolarisKey.cloud_sync.saves` (K.5T; the Godot form of React's
## `saveScreens.tsx`): says which transfer state the Cloud Sync strip shows while a save moves, and
## drives `PKeySaveConflict` from the first conflict a write ended with. No node here. `sdk` is the
## PolarisKey autoload or a test's stand-in with `cloud_sync.saves` (PKeySaves).
##
##   transfer_input()   {} when nothing moves, else {state, transfer?, can_review?} for the strip:
##                      `transferring` (the counted bytes), `transfer-failed` (until the next write
##                      starts) or `conflict` (with Review). The host's own status stands otherwise.
##   conflict()         the pending conflict, held until it is dismissed so `kept` still reads after
##                      the saves forgot it, or {}
##   choose(keep)       "local", "remote" or "both": runs `saves.resolve` with the bytes `local_copy`
##                      hands in, then moves on (keeping, kept, or failed)
##   retry(), choose_again(), cancel(), done()   the handlers of the failed and kept steps
##
## **The game's one line:** `local_copy`, a Callable taking the conflict and returning the local save's
## `PackedByteArray` (the SDK holds the other copy; it has no copy of the local file to give back).
## Keeping the other version needs none. Without one, Keep this version and Keep both fail, and the
## screen says so; nothing is overwritten.
##
## No value, key or path passes through here: the state carries counts and display-ready sizes.

signal changed()

const META := &"pkey_save_screens_host"
const UNITS := ["B", "KB", "MB", "GB"]

var sdk: Node = null
## Callable(conflict: Dictionary) -> PackedByteArray: the local copy of the save in conflict.
var local_copy := Callable()
## "choose", "keeping", "kept" or "failed" (the SaveConflict steps).
var step := "choose"
## The choice being applied, applied or that failed: "local", "remote" or "both"; "" before one.
var keep := ""

var _held: Dictionary = {}
var _saves: PKeySaves = null
var _started := false
var _gen := 0


## The one host an SDK node has, so a strip and a conflict screen agree. Null where there are no saves.
static func of(p_sdk: Node) -> PKeySaveScreensHost:
	if p_sdk == null or not is_instance_valid(p_sdk):
		return null
	if p_sdk.has_meta(META):
		return p_sdk.get_meta(META)
	var cs: Variant = p_sdk.get("cloud_sync")
	if not (cs is Object) or not ((cs as Object).get("saves") is Object):
		return null
	var h := PKeySaveScreensHost.new()
	h.sdk = p_sdk
	p_sdk.set_meta(META, h)
	return h


## A size, display-ready ("38 MB"): decimal units, one decimal only below 10.
static func size_text(bytes: int) -> String:
	var n := float(maxi(0, bytes))
	var u := 0
	while n >= 1000.0 and u < UNITS.size() - 1:
		n /= 1000.0
		u += 1
	var shown := str(int(round(n))) if (n >= 10.0 or u == 0) else str(snappedf(n, 0.1))
	return "%s %s" % [shown, UNITS[u]]


## Follow the saves. Idempotent.
func start() -> void:
	if _started:
		return
	var s: Variant = sdk.cloud_sync.get("saves") if sdk != null and is_instance_valid(sdk) and sdk.get("cloud_sync") != null else null
	if not (s is PKeySaves):
		return
	_saves = s
	_started = true
	_saves.changed.connect(_on_saves)
	_on_saves()


func stop() -> void:
	if _started and _saves != null and _saves.changed.is_connected(_on_saves):
		_saves.changed.disconnect(_on_saves)
	_started = false


func _on_saves() -> void:
	var pending := _saves.conflicts()
	# Shown until it is dismissed, so Kept still reads after the saves forgot the conflict.
	if not pending.is_empty() and step == "choose":
		_held = pending[0]
	changed.emit()


## The strip's state over the host's own, or {} when no save is moving and none failed or conflicts.
func transfer_input() -> Dictionary:
	if _saves == null:
		return {}
	var running := _saves.transfers()
	if not running.is_empty():
		var done := 0
		var total := 0
		for t: PKeyTransfer in running:
			done += int(t.progress.get("done", 0))
			total += int(t.progress.get("total", 0))
		var out := {"state": "transferring", "transfer": {}}
		if total > 0:
			out["transfer"] = {"size": size_text(done), "total": size_text(total), "fraction": minf(1.0, float(done) / float(total))}
		return out
	if _saves.last_failed():
		return {"state": "transfer-failed"}
	if not _saves.conflicts().is_empty():
		return {"state": "conflict", "can_review": true}
	return {}


## The conflict the screen is on, or {}.
func conflict() -> Dictionary:
	return _held


## The SaveConflict screen's fields for the conflict: {step, keep, remote_deleted, both_available}.
func view() -> Dictionary:
	if _held.is_empty():
		return {}
	return {
		"step": step,
		"keep": keep,
		"remote_deleted": _held.get("remote") == null,
		"both_available": bool(_held.get("both_available", false)),
	}


## Apply a choice once. A coroutine; the screen redraws on `changed` as the steps change.
func choose(p_keep: String) -> void:
	if _saves == null or _held.is_empty() or step == "keeping":
		return
	var c := _held
	_gen += 1
	var mine := _gen
	keep = p_keep
	step = "keeping"
	changed.emit()
	var bytes := PackedByteArray()
	var have := true
	if p_keep != "remote":
		have = local_copy.is_valid()
		if have:
			var got: Variant = await local_copy.call(c)
			have = got is PackedByteArray
			if have:
				bytes = got
	if mine != _gen:
		return
	if not have:
		step = "failed"
		changed.emit()
		return
	var t := _saves.resolve(c, p_keep, bytes)
	var out: Dictionary = await t.wait()
	if mine != _gen:
		return
	step = "kept" if String(out.get("state", "")) == "done" else "failed"
	changed.emit()


## Try again, after a failure: repeat the choice that failed.
func retry() -> void:
	if step == "failed" and keep != "":
		await choose(keep)


## Choose again, after a failure: back to the versions. Nothing was applied.
func choose_again() -> void:
	_gen += 1
	step = "choose"
	keep = ""
	changed.emit()


## Cancel, or Done after `kept`: forget the conflict without settling it.
func cancel() -> void:
	_gen += 1
	if _saves != null and not _held.is_empty():
		_saves.dismiss_conflict(String(_held.get("id", "")))
	_held = {}
	step = "choose"
	keep = ""
	changed.emit()


func done() -> void:
	cancel()
