class_name PKeyNearbyAsk
extends RefCounted
## One session asking for approval, as the host's `identity.nearby.on_request` handler sees it.
##
##   device, platform, codes   the new device's name as it reports it (unverified: show it as reported by the
##                             device), its platform, and the three codes in the order to show, each like `123 456`
##   pick(code)                the person tapped this code: a PKeyNearbyStep. A wrong one closes the session
##                             (`mismatch`); the right one, with a verified request, asks the Worker. Asking
##                             twice gives the first answer, never a second approve
##   deny()                    "none of these match": the session closes, nothing is approved, no route is called
##   closed                    signal: the session ended (once)
##
## No silent approval: `nearby/approve` is reached only from a `pick` that matched on that session and whose
## `VOUCH_REQ` verified (the engine refuses `finish` otherwise).

signal closed(code: StringName, by_peer: bool)
signal settled

var device := ""
var platform := ""
var codes := PackedStringArray()

var _routes: PKeyIdentityNearbyRoutes
var _approval: PKeyPeerNearbyApprover.Approval
var _ring: Object
var _picking := false
var _pick_done := false
var _step: PKeyNearbyStep = null
var _denied := false


func _init(routes: PKeyIdentityNearbyRoutes, approval: PKeyPeerNearbyApprover.Approval, ring: Object) -> void:
	_routes = routes
	_approval = approval
	_ring = ring
	device = PKeyPeerPayload.clean_label(approval.label)
	platform = approval.platform
	for c in approval.codes:
		codes.append(String(c))
	# A method, not a lambda: a lambda would hold `self`, and the approval that holds the connection is held by `self`.
	approval.closed.connect(_on_closed)


func _to_string() -> String:
	return "PKeyNearbyAsk()"


func _on_closed(code: StringName, by_peer: bool) -> void:
	closed.emit(code, by_peer)


func is_closed() -> bool:
	return _approval.is_closed()


func pick(code: String) -> PKeyNearbyStep:
	if _pick_done:
		return _step
	if _picking:
		await settled
		return _step
	if _denied:
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_EXPIRED)
	_picking = true
	_step = await _pick_once(code)
	_pick_done = true
	_picking = false
	settled.emit()
	return _step


func _pick_once(code: String) -> PKeyNearbyStep:
	var picked: PKeyResult = await _approval.pick(code)
	if not picked.ok:
		# A wrong code is a mismatch; a request that did not verify closed the session and approved nothing.
		if picked.detail is Dictionary and (picked.detail as Dictionary).get("reason") == "mismatch":
			return PKeyNearbyStep.of(PKeyNearbyStep.KIND_MISMATCH)
		return PKeyNearbyStep.of(PKeyNearbyStep.KIND_EXPIRED)
	# The matched code and the verified request earn the permit; nothing else does.
	var vouch := PKeyNearbyVouch.from_pick(picked.detail)
	return await PKeyNearbyDecision.new(_routes, _approval, vouch, _ring).run("approve", null, 1)


func deny() -> void:
	if _picking or _pick_done or _denied:
		return
	_denied = true
	_approval.decline()
