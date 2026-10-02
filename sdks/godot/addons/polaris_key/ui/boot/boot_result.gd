class_name PKeyBootResult
extends PKeyResult
## What `await PolarisKey.boot(opts)` (and `PKeyBoot.run(opts)`) returns when the boot first
## stops: `outcome` is PKeyBoot.READY, BLOCKED, OFFLINE or ERROR, the machine's outcome
## (stage-matrix.json's vocabulary). `ok` is true only for READY.
##
##   reason        BLOCKED: "update-required" or "not-available"; ERROR: the error code
##                 ("sync-failed", "fetch-failed", or the host's code, which is also `code`);
##                 "" otherwise
##   stages        every stage entered, in order (the stage_changed sequence)
##   update        the update answer when DECIDE found one to show (PKeyUpdateCheck, or the v3
##                 PKeyVersionCheck), else null
##   rolled_back   the boot guard rolled back to the previous build (P3-10)
##   can_play_offline  OFFLINE: false on every v1 path
##
## A later stop (after the player pressed Retry on the card) arrives as PKeyBoot.boot_finished
## and PolarisKey.boot_finished with a new result.

var outcome := ""
var reason := ""
var stages: Array = []
var update: PKeyResult = null
var rolled_back := false
var can_play_offline := false


static func of(p_outcome: String, p_reason: String, p_stages: Array) -> PKeyBootResult:
	var r := PKeyBootResult.new(p_outcome == "ready", StringName(p_reason) if p_outcome == "error" else &"", p_reason)
	r.outcome = p_outcome
	r.reason = p_reason
	r.stages = p_stages.duplicate()
	return r


func _to_string() -> String:
	return "PKeyBootResult(%s%s)" % [outcome, (", " + reason) if reason != "" else ""]
