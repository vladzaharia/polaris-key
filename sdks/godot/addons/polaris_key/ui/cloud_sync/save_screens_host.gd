class_name PKeySaveScreensHost
extends RefCounted
## What the save screens do with `PolarisKey.cloud_sync.saves` (K.5T; the Godot form of React's
## `saveScreens.tsx`): says which transfer state the Cloud Sync strip shows while a save moves, and
## drives `PKeySaveConflict` from the first open save request (U-08: a PKeyMergeRequest). No node here.
## `sdk` is the PolarisKey autoload or a test's stand-in with `cloud_sync.saves` (PKeySaves).
##
##   transfer_input()   {} when nothing moves, else {state, transfer?, can_review?} for the strip:
##                      `transferring` (the counted bytes), `transfer-failed` (until the next write
##                      starts) or `conflict` (with Review). The host's own status stands otherwise.
##   conflict()         the open request (PKeyMergeRequest), held until it is dismissed so `kept` still
##                      reads after the saves forgot it, or null
##   choose(keep)       "local", "remote" or "both": runs `request.keep(keep)`, then moves on (keeping,
##                      kept, or failed)
##   retry(), choose_again(), cancel(), done()   the handlers of the failed and kept steps
##
## The SDK holds this device's copy of the save, so the game has nothing to hand in (U-08 removed the
## `local_copy` line). The sides' dates and the other device's name come from the request: `when` is the
## medium date and time of its `saved_at`; `describe`, a Callable taking the request and returning
## {local_when?, remote_when?, remote_device?}, overrides any of them.
##
## No value, key or path passes through here: the state carries counts and display-ready sizes.

signal changed()

const META := &"pkey_save_screens_host"
const UNITS := ["B", "KB", "MB", "GB"]
const MONTHS := ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

var sdk: Node = null
## Optional Callable(request: PKeyMergeRequest) -> Dictionary: {local_when?, remote_when?, remote_device?}.
var describe := Callable()
## "choose", "keeping", "kept" or "failed" (the SaveConflict steps).
var step := "choose"
## The choice being applied, applied or that failed: "local", "remote" or "both"; "" before one.
var keep := ""

var _held: PKeyMergeRequest = null
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
	# Shown until it is dismissed, so Kept still reads after the saves forgot the request. On the choose
	# step a request that closed meanwhile (an exact write superseded it) gives way to the next.
	if step == "choose" and (_held == null or _held.is_closed()):
		_held = pending[0] if not pending.is_empty() else null
	elif not pending.is_empty() and _held == null:
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


## The request the screen is on, or null.
func conflict() -> PKeyMergeRequest:
	return _held


## The SaveConflict screen's fields for the request: {step, keep, remote_deleted, both_available, newer,
## local_when, remote_when, remote_device}.
func view() -> Dictionary:
	if _held == null:
		return {}
	var local: Variant = _held.local
	var remote: Variant = _held.remote
	var out := {
		"step": step,
		"keep": keep,
		"remote_deleted": remote == null,
		"both_available": _held.choices.has("both"),
		"newer": String(_held.newer) if _held.newer != null else "",
		"local_when": when_text(local["saved_at"]) if local is Dictionary else "",
		"remote_when": when_text(remote["saved_at"]) if remote is Dictionary else "",
		"remote_device": String(remote["device"]) if remote is Dictionary and remote["device"] != null else "",
	}
	if describe.is_valid():
		var d: Variant = describe.call(_held)
		if d is Dictionary:
			for k: String in ["local_when", "remote_when", "remote_device"]:
				if d.has(k):
					out[k] = String(d[k])
	return out


## A save's `saved_at` (epoch ms) as a medium date and time ("Nov 5, 2026, 14:02"); "" when it has none.
static func when_text(saved_at: Variant) -> String:
	if not PKeyClaims.is_number(saved_at):
		return ""
	var d := Time.get_datetime_dict_from_unix_time(int(saved_at) / 1000 + int(Time.get_time_zone_from_system()["bias"]) * 60)
	return "%s %d, %d, %02d:%02d" % [MONTHS[int(d["month"]) - 1], int(d["day"]), int(d["year"]), int(d["hour"]), int(d["minute"])]


## Apply a choice once. A coroutine; the screen redraws on `changed` as the steps change.
func choose(p_keep: String) -> void:
	if _saves == null or _held == null or step == "keeping":
		return
	var c := _held
	_gen += 1
	var mine := _gen
	keep = p_keep
	step = "keeping"
	changed.emit()
	var r: PKeyResult = await c.keep(p_keep)
	if mine != _gen:
		return
	step = "kept" if r.ok else "failed"
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
	if _saves != null and _held != null:
		_saves.dismiss_conflict(_held.record)
	_held = null
	step = "choose"
	keep = ""
	changed.emit()


func done() -> void:
	cancel()
