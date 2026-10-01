class_name PKeyGate
extends RefCounted
## The client licence gate (WIRE-CONTRACT-V3 §5): a port of `client-core/src/gate.ts`. The order
## is contract:
##
##   1. now = max(now, highWaterMark)
##   2. licence service disabled             -> not-applicable (usable; before everything)
##   3. no activation (no token, no bundle)  -> needs-activation
##   4. a recorded 403 build block           -> its reason (version-too-old | version-too-new |
##                                              channel-not-entitled), with allowedRange
##   5. a recorded hard 401                  -> revoked
##   6. no verified licence document         -> needs-activation
##   7. now > graceUntil                     -> expired
##   8. now > expiresAt                      -> grace
##   9. otherwise                            -> ok
##
## Input (a Dictionary): license_service_enabled, activation ("token" | "bundle" | null), doc
## (a verified licence payload or null), now, high_water_mark, last_sync_unauthorized, blocked
## ({reason, allowedRange?} or null), last_verified_at.
## Output: {status, grace_until?, last_verified_at?, allowed_range?}.

const BLOCK_REASONS := ["version-too-old", "version-too-new", "channel-not-entitled"]
const USABLE := ["ok", "grace", "not-applicable"]


static func license_state(input: Dictionary) -> Dictionary:
	var doc = input.get("doc")
	var now := maxf(float(input.get("now", 0)), float(input.get("high_water_mark", 0)))
	var last_verified = input.get("last_verified_at")
	if input.get("license_service_enabled", true) == false:
		return {"status": "not-applicable"}
	var activation = input.get("activation")
	if activation == null or activation == "":
		return {"status": "needs-activation"}
	var blocked = input.get("blocked")
	if blocked is Dictionary and not blocked.is_empty():
		var out := {"status": blocked.get("reason")}
		if blocked.has("allowedRange"):
			out["allowed_range"] = blocked["allowedRange"]
		return out
	if input.get("last_sync_unauthorized", false) == true:
		return {"status": "revoked"}
	if not (doc is Dictionary):
		return {"status": "needs-activation"}
	if now > float(doc["graceUntil"]):
		return {"status": "expired", "grace_until": doc["graceUntil"]}
	var state := {"status": "grace" if now > float(doc["expiresAt"]) else "ok", "grace_until": doc["graceUntil"]}
	if last_verified != null:
		state["last_verified_at"] = last_verified
	return state


## True for ok, grace and not-applicable. Takes a state Dictionary or a bare status.
static func is_usable(state: Variant) -> bool:
	var status = state.get("status") if state is Dictionary else state
	return status is String and USABLE.has(status)


## A recorded block hint as the gate may read it: {reason, allowedRange?} with a known reason,
## else null. An unsigned hint can only tighten the gate, so one with any other reason is
## dropped rather than allowed to become a status.
static func sanitize_blocked(v: Variant) -> Variant:
	if not (v is Dictionary) or not (v.get("reason") is String) or not BLOCK_REASONS.has(v["reason"]):
		return null
	var out := {"reason": v["reason"]}
	if v.get("allowedRange") is Dictionary:
		var r := {}
		for k in ["min", "max"]:
			if v["allowedRange"].get(k) is String:
				r[k] = v["allowedRange"][k]
		out["allowedRange"] = r
	return out
