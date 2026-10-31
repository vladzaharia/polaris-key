class_name PKeyTransfer
extends RefCounted
## A save write in flight (U-23.G5; plan D-8): the handle `PolarisKey.cloud_sync.saves.write()` returns at
## once. The transfer runs on its own; `await transfer.wait()` (or the `finished` signal) settles on
## the outcome, which is never an error value:
##
##   {state: "done", id, version, file, copy_id?}   stored; the metadata is pushed
##   {state: "done", id, kept: "remote", version}   a conflict settled by keeping the server's copy
##   {state: "cancelled"}                           cancelled (a cancel is a state, not a failure)
##   {state: "failed", error: {code, reason, detail}}
##   {state: "conflict", conflict: {...}}           another write got there first (see `saves.resolve`)
##
## `state` is "running", "paused", "done", "cancelled", "failed" or "conflict". `pause()` stops the engine
## at its next step and keeps the journal, so `resume()` carries on from what the Worker already holds;
## `cancel()` releases the server's upload and ends the wait for the metadata write (a cancelled write is
## reported as cancelled; the write itself is exact, so it is harmless if it lands later). Pausing a
## transfer that is not in the engine's hands (sealing, the record write) lets that step finish.

const Transfer := preload("res://addons/polaris_key/services/cloud_sync/transfer.gd")

signal finished(outcome: Dictionary)

var id := ""
var state := "running"
var progress := {"done": 0, "total": 0}
var outcome: Variant = null

var _attempt: Callable
var _release: Callable
var _wanted := "run"
var _cancel: Transfer.Cancel = Transfer.Cancel.new()
## Set only by `cancel()`: it also ends the wait for the metadata write (a pause does not).
var _hard: Transfer.Cancel = Transfer.Cancel.new()


## `attempt` is `func(cancel: Transfer.Cancel, hard: Transfer.Cancel) -> Dictionary` (a coroutine; the
## outcome, or `{state: "aborted"}` when a cancel flag stopped it). `release` is `func() -> void` (a coroutine), run on cancel.
static func start(p_id: String, p_progress: Dictionary, attempt: Callable, release: Callable) -> PKeyTransfer:
	var t := PKeyTransfer.new()
	t.id = p_id
	t.progress = p_progress
	t._attempt = attempt
	t._release = release
	t._drive()
	return t


## A transfer that is already over.
static func settled(p_id: String, p_outcome: Dictionary) -> PKeyTransfer:
	var t := PKeyTransfer.new()
	t.id = p_id
	t.outcome = p_outcome
	t.state = String(p_outcome["state"])
	return t


func pause() -> void:
	if state != "running":
		return
	_wanted = "pause"
	_cancel.cancelled = true


func resume() -> void:
	if state == "paused" or _wanted == "pause":
		_wanted = "run"


## Stop and release the server's upload. Resolves once the transfer has settled.
func cancel() -> void:
	if outcome != null:
		return
	_wanted = "cancel"
	_cancel.cancelled = true
	_hard.cancelled = true
	await wait()


## The outcome, once there is one.
func wait() -> Dictionary:
	if outcome != null:
		return outcome
	return await finished


func _drive() -> void:
	var tree := Engine.get_main_loop() as SceneTree
	while true:
		_cancel = Transfer.Cancel.new()
		if _wanted == "pause":
			_cancel.cancelled = true
		state = "running"
		var out: Dictionary = await _attempt.call(_cancel, _hard)
		if _wanted == "cancel":
			await _cancelled()
			return
		if out.get("state") != "aborted":
			_settle(out)
			return
		# Paused: wait for resume (or cancel).
		state = "paused"
		while _wanted == "pause":
			await tree.process_frame
		if _wanted == "cancel":
			await _cancelled()
			return
		_wanted = "run"


func _cancelled() -> void:
	if _release.is_valid():
		await _release.call()
	_settle({"state": "cancelled"})


func _settle(out: Dictionary) -> void:
	state = String(out["state"])
	outcome = out
	finished.emit(out)
