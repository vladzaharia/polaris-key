class_name PKeyNearbyDecision
extends RefCounted
## One `nearby/approve` for the verified request, then the answer to the LAN session; and the wrap after it.
## Ported from Swift `NearbyApprove.swift` (reference: sdk-node `identity/nearbyApprover.ts`).
##
##  - the answer is given to the LAN session (`finish`), which sends the one `VOUCH_RESULT`; the 409 keys
##    registration retries once inside the route and never loops here, and a licence choice is asked at most as
##    often as the Worker asks (MAX_ASKS);
##  - the wrap (V5 section 13.11.3): once the Worker answered `approved`, and only if this device holds the root, M
##    seals the root to the new device's `agree_key` from the verified request (and to no other key), sends that wrap
##    once as `KEYRING_WRAP` (0x0030), and only then stores it (`PUT .../wraps/{deviceId}`: the server copy is the
##    fallback). A failure of either leaves the approval as it is;
##  - the request handle, the proofs and the token are in no `str()` and no message.

const KEYRING_WRAP_RECORD := 0x0030

var _routes: PKeyIdentityNearbyRoutes
var _approval: PKeyPeerNearbyApprover.Approval
var _vouch: PKeyNearbyVouch
var _ring: Object
var _wrapped := false


func _init(routes: PKeyIdentityNearbyRoutes, approval: PKeyPeerNearbyApprover.Approval, vouch: PKeyNearbyVouch, ring: Object) -> void:
	_routes = routes
	_approval = approval
	_vouch = vouch
	_ring = ring


func _to_string() -> String:
	return "PKeyNearbyDecision()"


## Once, after `approved`: seal the wrap for the new device, send it over the channel, and only then store the
## same bytes on the Worker. A refused or failed `PUT` cannot take the channel copy with it, and a lost channel
## leaves the stored copy as the fallback.
func _wrap() -> void:
	if _ring == null or _wrapped or not _ring.unlocked():
		return
	_wrapped = true
	# The ids and the key are the verified request's, which `approve` just confirmed.
	var sealed: PKeyResult = _ring.seal_wrap_to(_vouch.device_id, _vouch.agree_key)
	if not sealed.ok:
		return
	_approval.send_record(KEYRING_WRAP_RECORD, PKeySyncRing.wrap_record(sealed.detail))
	await _ring.put_wrap(_vouch.device_id, sealed.detail)


## Codes that say the service or the network failed, as against a request that lapsed or was refused.
static func _is_failure(code: String) -> bool:
	return [
		PKeyConstants.ErrorCode.NETWORK, PKeyConstants.ErrorCode.SERVER_ERROR, PKeyConstants.ErrorCode.SERVICE_UNAVAILABLE,
		PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, PKeyConstants.ErrorCode.HTTP_ERROR, PKeyConstants.ErrorCode.INVALID_RESPONSE,
		String(PKeyErrors.NETWORK), String(PKeyErrors.LOCAL_ONLY), String(PKeyErrors.SERVICE_UNAVAILABLE),
	].has(code)


## No answer to give: signed out, the service or the network failed, or the request lapsed.
static func _unanswered(r: PKeyResult) -> PKeyNearbyStep:
	if r.code == PKeyConstants.ErrorCode.ACCOUNT_REQUIRED:
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_ACCOUNT_REQUIRED)
	return PKeyNearbyStep.of(PKeyNearbyStep.KIND_FAILED if _is_failure(String(r.code)) else PKeyNearbyStep.KIND_EXPIRED)


func _wrap_if_approved(answer: Dictionary) -> void:
	if answer["kind"] == "approved":
		await _wrap()


static func _step_of(answer: Dictionary) -> PKeyNearbyStep:
	var kind := String(answer["kind"])
	if kind == "unavailable":
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_FAILED)
	if kind == "approved":
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_APPROVED)
	if kind == "denied":
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_DENIED)
	if kind == "refused":
		var code := String(answer["code"])
		if code == PKeyConstants.ErrorCode.NOT_NEARBY:
			return PKeyNearbyStep.of(PKeyNearbyStep.KIND_NOT_NEARBY)
		if code == PKeyConstants.ErrorCode.DEVICE_LIMIT:
			return PKeyNearbyStep.of(PKeyNearbyStep.KIND_DEVICE_LIMIT)
		if code == PKeyConstants.ErrorCode.ACCOUNT_REQUIRED or code == PKeyConstants.ErrorCode.UNAUTHORIZED:
			return PKeyNearbyStep.of(PKeyNearbyStep.KIND_ACCOUNT_REQUIRED)
		if code == PKeyConstants.ErrorCode.RATE_LIMITED:
			return PKeyNearbyStep.of(PKeyNearbyStep.KIND_RATE_LIMITED)
		if _is_failure(code):
			return PKeyNearbyStep.of(PKeyNearbyStep.KIND_FAILED)
	return PKeyNearbyStep.of(PKeyNearbyStep.KIND_EXPIRED)


## `decision` "approve" or "deny"; `choice` the wire choice or null; `asks` how many times the Worker has been asked
## for this pick. A coroutine answering a PKeyNearbyStep.
func run(decision: String, choice: Variant, asks: int) -> PKeyNearbyStep:
	var r := await _routes.approve(_vouch, decision, choice)
	if not r.ok:
		# Nothing to answer with: the session closes and the person is told what it was.
		_approval.close()
		return _unanswered(r)
	var answer: Dictionary = r.detail
	var fin: PKeyResult = _approval.finish(answer["finish"])
	if not fin.ok:
		# The LAN session ended meanwhile. The Worker's answer stands: an approval is an approval, and the new
		# device's own poll signs it in. The stored wrap is the fallback for the lost channel.
		await _wrap_if_approved(answer)
		return _step_of(answer)
	var out: Dictionary = fin.detail
	if out.has("wait"):
		if out["wait"] == "choice" and asks < PKeyNearbyChoose.MAX_ASKS:
			var view: Variant = answer.get("choices") if answer["kind"] == "choose" else null
			if view is Dictionary and (view as Dictionary).get("choices") is Array:
				return PKeyNearbyStep.of(PKeyNearbyStep.KIND_CHOOSE, PKeyNearbyChoose.new(view, self, asks))
			# A lost mint (409): ask again for the licences, with no choice, to show them afresh.
			if decision == "approve":
				return await run("approve", null, asks + 1)
		# A choice nobody can show, or a retry the route already spent: end it.
		_approval.close()
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_EXPIRED)
	await _wrap_if_approved(answer)
	return _step_of(answer)
