class_name PKeyFakeBootHost
extends RefCounted
## A scripted PKeyBootHost for PKeyBoot's tests: every stage's work waits until the test answers
## it with an event (`answer(e)`), so a stage-matrix row can be fed to PKeyBoot step by step. It
## records which stage's work PKeyBoot asked for, in order (`calls`); a gate re-check after
## `changed` is recorded as "gate*". An answer resumes every pending wait: a stale one (a stage
## the machine has already left after a timeout or a retry) must be dropped by PKeyBoot's own
## generation check, which is exactly what the rows with late events prove.

signal changed()
signal _answered(event: Dictionary)

var calls: Array = []
## The stage whose work is waiting for an answer, or "".
var waiting_stage := ""
## Set before `changed` is emitted, so the re-check is recorded as "gate*".
var recheck := false
var update_result: PKeyResult = null


func shell(_opts: Dictionary) -> Dictionary:
	return await _wait("shell")


func guard() -> Dictionary:
	return await _wait("guard")


func sync(_force := false) -> Dictionary:
	return await _wait("sync")


func gate_status() -> Dictionary:
	return await _wait("gate")


func decide() -> Dictionary:
	return await _wait("decide")


func fetch(_required: Array) -> Dictionary:
	return await _wait("fetch")


func mount() -> Dictionary:
	return await _wait("mount")


func _wait(stage: String) -> Dictionary:
	calls.append(stage + "*" if recheck else stage)
	recheck = false
	waiting_stage = stage
	var e: Dictionary = await _answered
	return e


## Answer the pending work with `event`.
func answer(event: Dictionary) -> void:
	waiting_stage = ""
	_answered.emit(event)


## The licence moved while the gate waits: PKeyBoot asks for gate.status again.
func poke() -> void:
	recheck = true
	changed.emit()
