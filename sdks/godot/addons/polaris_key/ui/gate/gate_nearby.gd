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
##  - nearby-wait looks for devices (a status line, and nearby-none-found after a while); nearby-choose lists
##    the devices that answered (a pad lands on the first; a single one is taken after a few seconds); nearby-wait
##    then shows the code of the one chosen, to be tapped there, with a way back to the list;
##  - every way a request ends but the person leaving has its own step (nearby-denied, -expired, -not-nearby,
##    -failed, -rate-limited, -unavailable, -signed-out, -none-found) with Try again and Use a code instead;
##  - nearby-done holds the sign-in: Continue says the account is the person's, Not you? declines it. Leaving
##    the steps by any route (Escape, Use a code instead, the gate going away, a newer sign-in) ends the
##    request, and an unconfirmed account signs out;
##  - a confirm that fails is an expired request, never a sign-in.

## The steps that end a request: Try again starts another.
const ENDINGS := [
	"nearby-none-found", "nearby-denied", "nearby-expired", "nearby-not-nearby", "nearby-failed", "nearby-rate-limited",
	"nearby-unavailable", "nearby-cancelled", "nearby-signed-out",
]

## The session the gate is showing (a PKeyNearbySignIn), or null.
var session: PKeyNearbySignIn = null
## Seconds of searching with no device before nearby-none-found, and of one device on the list before it is taken.
var none_found_after := 15.0
var single_pick_after := 3.0

var _gate_ref: WeakRef
## Bumped at every change of step, so a timer set for an earlier one does nothing.
var _gen := 0


func _init(gate: PKeyGateView) -> void:
	_gate_ref = weakref(gate)


func _to_string() -> String:
	return "PKeyGateNearby()"


func _gate() -> PKeyGateView:
	return _gate_ref.get_ref() as PKeyGateView if _gate_ref != null else null


## The step a request's end is shown as: by the outcome's kind, else by its code.
static func ending_for(kind: StringName, code: StringName) -> String:
	match kind:
		PKeySignInOutcome.KIND_DENIED:
			return "nearby-denied"
		PKeySignInOutcome.KIND_EXPIRED:
			return "nearby-expired"
		PKeySignInOutcome.KIND_CANCELLED:
			return "nearby-cancelled"
		PKeySignInOutcome.KIND_RATE_LIMITED:
			return "nearby-rate-limited"
		PKeySignInOutcome.KIND_SERVICE_UNAVAILABLE:
			return "nearby-unavailable"
	return ending_for_code(code)


## The step a failure's code is shown as.
static func ending_for_code(code: StringName) -> String:
	match String(code):
		"rate_limited", "upstream_rate_limited":
			return "nearby-rate-limited"
		"nearby-unsupported", "nearby-permission-denied", "service-unavailable", "service-disabled":
			return "nearby-unavailable"
		"not_nearby":
			return "nearby-not-nearby"
		"sign-in-expired":
			return "nearby-expired"
		"sign-in-denied":
			return "nearby-denied"
	return "nearby-failed"


## The phone sign-in's prompt (nearby-prompt).
func show_prompt() -> void:
	var gate := _gate()
	if gate == null or (gate._auto_on() and not gate._auto_state.begins_with("nearby")):
		return
	gate._show_auto("nearby-prompt")


## The steps are over: a session still held is cancelled (an unconfirmed account signs out).
func end() -> void:
	_gen += 1
	var held := session
	session = null
	if held != null:
		held.cancel()


## True while the person's confirmation of the held account is being settled by the SDK.
func confirming() -> bool:
	var gate := _gate()
	return session != null and gate != null and gate._completing and gate._auto_state == "nearby-done"


## The step's primary: Continue on the prompt, Continue on the held account, Try again on an ending.
func on_primary(step: String) -> void:
	if step == "nearby-done":
		await _confirm()
	elif step == "nearby-prompt" or ENDINGS.has(step):
		await _continue()


## The step's quiet action: Not you? declines the account (the held records go and the device signs out) and
## says so; Not now and Use a code instead leave for the form.
func on_secondary(step: String) -> void:
	var gate := _gate()
	if gate == null:
		return
	if step == "nearby-done" and session != null:
		# The SDK settles a confirm in flight; Not you? waits for it and never undoes it.
		if gate._completing or session.is_confirmed():
			return
		var declined := session
		# The decline ends this request itself; its own end is not shown as a lapse.
		session = null
		_gen += 1
		await declined.decline_account()
		if is_instance_valid(gate) and gate._auto_state.begins_with("nearby"):
			_show_ending("nearby-signed-out")
		return
	gate._leave_auto_sign_in()


## Choose another device: this request ends and a new one looks again.
func on_another() -> void:
	var gate := _gate()
	if gate == null or gate._auto_state != "nearby-wait" or gate._completing:
		return
	end()
	await _continue()


## Show how a request ended: the held session (if any) is over, nothing of the request stays on screen.
func _show_ending(state: String) -> void:
	var gate := _gate()
	if gate == null:
		return
	end()
	gate.auto_step.approvers = []
	gate.auto_step.code = ""
	gate.auto_step.device = ""
	gate.auto_step.searching = false
	gate.auto_step.pending = false
	gate.auto_step.busy = false
	gate._completing = false
	gate._show_auto(state)


## Continue on nearby-prompt, Try again on an ending: start the request, look for devices, wait for the approval.
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
	if not made.ok or not gate._auto_state.begins_with("nearby"):
		# The person left meanwhile, or it did not start: a started session is cancelled, a failure is shown.
		if made.ok:
			(made.detail as PKeyNearbySignIn).cancel()
		elif gate._auto_state.begins_with("nearby"):
			_show_ending(ending_for_code(made.code))
		return
	var started: PKeyNearbySignIn = made.detail
	session = started
	_gen += 1
	started.approvers_changed.connect(_on_list.bind(started))
	started.ended.connect(_on_ended.bind(started))
	gate.auto_step.approvers = []
	gate.auto_step.code = ""
	gate.auto_step.device = ""
	gate.auto_step.pending = false
	_on_list(started.approvers(), started)
	_wait(started)


## The devices that answered changed: searching, choosing, or (with a code on screen) nothing to do.
func _on_list(list: Array, started: PKeyNearbySignIn) -> void:
	var gate := _gate()
	if gate == null or started != session or started.code != "":
		return
	var before := gate._auto_state
	gate.auto_step.approvers = list
	if list.is_empty():
		gate.auto_step.searching = true
		if before != "nearby-wait":
			gate._show_auto("nearby-wait")
		else:
			gate.refresh_view()
		_gen += 1
		_after(none_found_after, _none_found.bind(started, _gen))
		return
	gate.auto_step.searching = false
	_gen += 1
	if before != "nearby-choose":
		gate._show_auto("nearby-choose")
	else:
		gate.refresh_view()
	if list.size() == 1:
		_after(single_pick_after, _take_single.bind(started, _gen, String(list[0].get("id", ""))))


func _after(seconds: float, fn: Callable) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return
	tree.create_timer(maxf(seconds, 0.0)).timeout.connect(fn)


## Nothing answered for a while: the request ends and the step says so.
func _none_found(started: PKeyNearbySignIn, gen: int) -> void:
	var gate := _gate()
	if gate == null or started != session or gen != _gen or gate._auto_state != "nearby-wait" or started.code != "":
		return
	_show_ending("nearby-none-found")


## One device on the list and no tap: it is asked.
func _take_single(started: PKeyNearbySignIn, gen: int, approver_id: String) -> void:
	var gate := _gate()
	if gate == null or started != session or gen != _gen or gate._auto_state != "nearby-choose" or approver_id == "":
		return
	await on_chosen(approver_id)


func _wait(started: PKeyNearbySignIn) -> void:
	var o: PKeySignInOutcome = await started.wait()
	var gate := _gate()
	if gate == null or started != session:
		return
	if o.kind != PKeySignInOutcome.KIND_SIGNED_IN:
		_show_ending(ending_for(o.kind, o.code))
		return
	# Signed in, held: the person sees whose account it is, then Continue or Not you?.
	var who: Dictionary = o.identity
	gate.auto_step.email = String(who["email"]) if who.get("email") is String else String(who.get("name", ""))
	gate.auto_step.approvers = []
	gate.auto_step.searching = false
	gate.auto_step.pending = true
	_gen += 1
	gate._show_auto("nearby-done")


## The person tapped a device: its code shows, to be tapped there.
func on_chosen(approver_id: String) -> void:
	var gate := _gate()
	var started := session
	if gate == null or started == null or not (gate._auto_state == "nearby-choose" or gate._auto_state == "nearby-wait"):
		return
	var chosen_name := ""
	for a: Dictionary in started.approvers():
		if String(a.get("id", "")) == approver_id:
			chosen_name = String(a["label"]) if a.get("label") is String else PKeySignInStep.platform_name(String(a.get("platform", "")))
	_gen += 1
	var r: PKeyResult = await started.choose(approver_id)
	if not is_instance_valid(gate) or started != session:
		return
	if r.ok:
		gate.auto_step.approvers = []
		gate.auto_step.searching = false
		gate.auto_step.device = chosen_name
		gate.auto_step.code = String(r.detail.get("code", ""))
		if gate._auto_state != "nearby-wait":
			gate._show_auto("nearby-wait")
		else:
			gate.refresh_view()
			gate.ensure_focus(true)
	else:
		_show_ending(ending_for_code(r.code))


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
		# The sign-in lapsed before it was confirmed: the step says so.
		_show_ending("nearby-expired")
		return
	# Confirmed (the SDK fetched the account's licence): the session is the device's now; leaving the steps
	# must not cancel it.
	session = null
	gate._end_auto()
	gate.show_state(gate.sdk.status())


## The request ended unconfirmed (the deadline, a decline, a cancel): the step says it lapsed.
func _on_ended(started: PKeyNearbySignIn) -> void:
	var gate := _gate()
	if gate != null and started == session:
		_show_ending("nearby-expired")
