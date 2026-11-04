class_name PKeyNearbyChoose
extends RefCounted
## The licence choice of an approval: the licences the person may give the new device, and two ways on. Answered
## once: a second answer is `expired`; a choice that is not one of the two kinds answers Deny.
##
##   choices     the view the Worker sent ({state, choices: [{id, tierName, name, state, ...}], keep, preselected,
##               create, getLicense}); only `state == "free"` entries can be chosen
##   choose(c)   {kind = "license", license_id} (one tap per licence) or {kind = "create"}: a PKeyNearbyStep
##   cancel()    decline: the Worker records a denial and the new device is told

const MAX_ASKS := 3

var choices: Dictionary = {}

var _decision: PKeyNearbyDecision
var _asks := 0
var _used := false


func _init(view: Dictionary, decision: PKeyNearbyDecision, asks: int) -> void:
	choices = view
	_decision = decision
	_asks = asks


func _to_string() -> String:
	return "PKeyNearbyChoose()"


func _once() -> bool:
	if _used:
		return false
	_used = true
	return true


## Give the new device this licence, or a new one. A coroutine answering a PKeyNearbyStep.
func choose(choice: Dictionary) -> PKeyNearbyStep:
	if not _once():
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_EXPIRED)
	var wire := {}
	if choice.get("kind") == "create":
		wire = {"kind": "create"}
	elif choice.get("kind") == "license" and choice.get("license_id") is String:
		wire = {"kind": "license", "licenseId": choice["license_id"]}
	else:
		# Not a choice the person could make: the single use answers Deny, and the request does not lapse unseen.
		return await _decision.run("deny", null, _asks + 1)
	return await _decision.run("approve", wire, _asks + 1)


## Decline. The right code was tapped on this session, so the Worker may be told "deny". A coroutine.
func cancel() -> PKeyNearbyStep:
	if not _once():
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_EXPIRED)
	return await _decision.run("deny", null, _asks + 1)
