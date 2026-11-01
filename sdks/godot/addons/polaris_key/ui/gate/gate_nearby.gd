class_name PKeyGateNearby
extends RefCounted
## The gate's nearby sign-in on this device, the new device D (I-48.15; WIRE-CONTRACT-V5 section 15.6.1): the
## steps nearby-prompt, nearby-wait and nearby-done, drawn by the gate's PKeySignInStep and bound to the SDK's
## PKeyNearbySignIn. The gate owns the screen (`_auto_state`, `_show_auto`, `_leave_auto_sign_in`); this class
## owns the session and what each tap does.
##
## Rules:
##  - the prompt is the one tap before the system asks for access to the local network; no route is called
##    before Continue;
##  - nearby-wait lists the devices that answered (each a button; a pad lands on the first), then shows the code
##    of the one chosen, to be tapped there;
##  - nearby-done holds the sign-in: Continue says the account is the person's, Not you? declines it. Leaving
##    the steps by any route (Escape, Use a code instead, the gate going away, a newer sign-in) ends the
##    request, and an unconfirmed account signs out;
##  - a confirm that fails is an expired request, never a sign-in.

## The session the gate is showing (a PKeyNearbySignIn), or null.
var session: PKeyNearbySignIn = null

var _gate_ref: WeakRef


func _init(gate: PKeyGateView) -> void:
	_gate_ref = weakref(gate)


func _to_string() -> String:
	return "PKeyGateNearby()"


func _gate() -> PKeyGateView:
	return _gate_ref.get_ref() as PKeyGateView if _gate_ref != null else null


## The phone sign-in's prompt (nearby-prompt).
func show_prompt() -> void:
	var gate := _gate()
	if gate == null or (gate._auto_on() and not gate._auto_state.begins_with("nearby")):
		return
	gate._show_auto("nearby-prompt")


## The steps are over: a session still held is cancelled (an unconfirmed account signs out).
func end() -> void:
	var held := session
	session = null
	if held != null:
		held.cancel()


## The step's primary: Continue on the prompt, Continue on the held account.
func on_primary(step: String) -> void:
	if step == "nearby-prompt":
		await _continue()
	elif step == "nearby-done":
		await _confirm()


## The step's quiet action: Not you? declines the account (the held records go and the device signs out); Not
## now and Use a code instead leave for the form.
func on_secondary(step: String) -> void:
	var gate := _gate()
	if gate == null:
		return
	if step == "nearby-done" and session != null:
		var declined := session
		await declined.decline_account()
	gate._leave_auto_sign_in()


## Continue on nearby-prompt: start the request, list the devices that answer, wait for the approval.
func _continue() -> void:
	var gate := _gate()
	if gate == null or gate._completing or gate.sdk == null or not is_instance_valid(gate.sdk):
		return
	gate._completing = true
	gate.auto_step.busy = true
	var made: PKeyResult = await gate.sdk.identity.sign_in.start_nearby()
	gate._completing = false
	if not is_instance_valid(gate):
		return
	gate.auto_step.busy = false
	if not made.ok or gate._auto_state != "nearby-prompt":
		# Not available after all, or the person left meanwhile: the form returns.
		if made.ok:
			(made.detail as PKeyNearbySignIn).cancel()
		elif gate._auto_state == "nearby-prompt":
			gate._leave_auto_sign_in()
		return
	var started: PKeyNearbySignIn = made.detail
	session = started
	started.approvers_changed.connect(func(list: Array) -> void:
		if started == session:
			gate.auto_step.approvers = list)
	started.ended.connect(_on_ended.bind(started))
	gate.auto_step.approvers = started.approvers()
	gate.auto_step.code = ""
	gate.auto_step.pending = false
	gate._show_auto("nearby-wait")
	_wait(started)


func _wait(started: PKeyNearbySignIn) -> void:
	var o: PKeySignInOutcome = await started.wait()
	var gate := _gate()
	if gate == null or started != session:
		return
	if o.kind != PKeySignInOutcome.KIND_SIGNED_IN:
		gate._leave_auto_sign_in()
		return
	# Signed in, held: the person sees whose account it is, then Continue or Not you?.
	var who: Dictionary = o.identity
	gate.auto_step.email = String(who["email"]) if who.get("email") is String else String(who.get("name", ""))
	gate.auto_step.approvers = []
	gate.auto_step.pending = true
	gate._show_auto("nearby-done")


## The person tapped a device: its code shows, to be tapped there.
func on_chosen(approver_id: String) -> void:
	var gate := _gate()
	var started := session
	if gate == null or started == null or gate._auto_state != "nearby-wait":
		return
	var r: PKeyResult = await started.choose(approver_id)
	if not is_instance_valid(gate) or started != session:
		return
	if r.ok:
		gate.auto_step.approvers = []
		gate.auto_step.code = String(r.detail.get("code", ""))
		gate.ensure_focus(true)
	else:
		gate._leave_auto_sign_in()


## Continue on nearby-done: the account is the person's.
func _confirm() -> void:
	var gate := _gate()
	var started := session
	if gate == null or started == null or gate._completing:
		return
	gate._completing = true
	gate.auto_step.busy = true
	var r: PKeyResult = await started.confirm_account()
	gate._completing = false
	if not is_instance_valid(gate):
		return
	gate.auto_step.busy = false
	if not r.ok:
		gate._leave_auto_sign_in()
		gate.show_state(gate.sdk.status(), String(PKeyUiView.catalog().format("core.codes.sign-in-expired.message")))
		return
	# Confirmed: the session is the device's now; leaving the steps must not cancel it.
	session = null
	gate._end_auto()
	await gate.sdk.sync(true)
	gate.show_state(gate.sdk.status())


## The request ended unconfirmed (the deadline, a decline, a cancel): the steps give way to the form.
func _on_ended(started: PKeyNearbySignIn) -> void:
	var gate := _gate()
	if gate != null and started == session:
		gate._leave_auto_sign_in()
