class_name PKeyNearbyVouch
extends RefCounted
## The verified `VOUCH_REQ` of a session whose person picked the matching code (V5 section 15.6.1). `nearby/approve`
## (PKeyIdentityNearbyRoutes.approve) takes nothing else: it is not built from a handle and keys by a host, and
## only PKeyNearbyAsk makes one, from the request the approver's `pick` returned. It prints as nothing.

var request := ""
var device_id := ""
var sign_key := ""
var agree_key := ""


## `picked` is what PKeyPeerNearbyApprover.Approval.pick answered.
static func from_pick(picked: Dictionary) -> PKeyNearbyVouch:
	var v := PKeyNearbyVouch.new()
	v.request = String(picked.get("request", ""))
	v.device_id = String(picked.get("device_id", ""))
	v.sign_key = String(picked.get("sign_key", ""))
	v.agree_key = String(picked.get("agree_key", ""))
	return v


func _to_string() -> String:
	return "PKeyNearbyVouch()"
