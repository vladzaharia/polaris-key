class_name PKeyNearbyStep
extends RefCounted
## What happens after the person taps a code, or a licence, on the approving device: `kind` is one of the KIND_
## names, and `choose` holds the licence choice (a PKeyNearbyChoose) when the kind is `choose`.

const KIND_APPROVED := &"approved"
## The tapped code was not the one the new device shows: it was not signed in.
const KIND_MISMATCH := &"mismatch"
const KIND_NOT_NEARBY := &"not-nearby"
const KIND_DENIED := &"denied"
const KIND_EXPIRED := &"expired"
const KIND_DEVICE_LIMIT := &"device-limit"
const KIND_ACCOUNT_REQUIRED := &"account-required"
const KIND_RATE_LIMITED := &"rate-limited"
## The service or the network failed (a 5xx, no answer, the routes gone): nothing was approved, and it is not an
## expired code.
const KIND_FAILED := &"failed"
const KIND_CHOOSE := &"choose"

var kind: StringName = KIND_EXPIRED
var choose: PKeyNearbyChoose = null


static func of(p_kind: StringName, p_choose: PKeyNearbyChoose = null) -> PKeyNearbyStep:
	var s := PKeyNearbyStep.new()
	s.kind = p_kind
	s.choose = p_choose
	return s


func _to_string() -> String:
	return "PKeyNearbyStep(%s)" % kind
