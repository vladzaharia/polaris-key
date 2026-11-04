class_name PKeyGateLink
extends RefCounted
## PKeyGateView's link offer (I-48.14): after a sign-in this device started, ask identity.link for an offer, draw
## link-offer, link-done and link-conflict through the gate's PKeySignInStep, and end the offer.

var gate: PKeyGateView


func _init(p_gate: PKeyGateView) -> void:
	gate = p_gate


## After a sign-in this device started, ask whether an identity could be linked and show the offer. True when
## it is on screen (the gate holds); false when there is none (the product, the gate, the person's earlier
## decline, or no provider here), and nothing was sent unless the SDK had an offer open.
func offer() -> bool:
	if gate.sdk == null or not is_instance_valid(gate.sdk) or gate.sdk.get("identity") == null or not gate.sdk.identity.link.pending:
		return false
	gate._link_hold = true
	var link: PKeyIdentityLink = gate.sdk.identity.link
	var answer: PKeyLinkResult = await link.offer()
	if not is_instance_valid(gate):
		return true
	var entry := link.entry_for(answer.kinds) if answer.kind == PKeyLinkResult.KIND_OFFER else {}
	if entry.is_empty():
		link.dismiss()
		gate._link_hold = false
		return false
	gate._link_entry = entry
	gate._link_problem = ""
	gate.auto_step.provider = PKeyGateController.link_provider(String(entry.get("kind", "")))
	gate.auto_step.reach = PKeyGateController.link_reach(entry)
	gate.auto_step.error_key = ""
	gate.auto_step.busy = false
	gate._show_auto("link-offer")
	return true


## Link {provider} on the offer; Done on the other two. A failed Link keeps the offer and says why (ui-core
## "link-offer"): stale swaps Link for Sign in again, refused leaves No thanks as the primary, a network failure
## keeps Link, and an answer with no offer ends quietly.
func primary(step: String) -> void:
	if step != "link-offer":
		finish(false)
	elif gate._completing:
		return
	elif gate._link_problem == "stale":
		_sign_in_again()
	elif gate._link_problem == "refused":
		finish(true)
	else:
		await _link()


## Link: accept, then the answer decides the next step.
func _link() -> void:
	gate._completing = true
	gate.auto_step.busy = true
	var r: PKeyLinkResult = await gate.sdk.identity.link.accept()
	gate._completing = false
	if not is_instance_valid(gate):
		return
	gate.auto_step.busy = false
	var next := PKeyGateController.link_next(r)
	if next != "link-offer":
		gate.auto_step.error_key = ""
		gate._show_auto(next)
		return
	gate._link_problem = PKeyGateController.link_problem(r)
	if gate._link_problem == "unavailable":
		finish(false)
	else:
		gate.auto_step.error_key = PKeyGateController.link_problem_key(gate._link_problem)


## Sign in again from a stale offer: the regular sign-in runs with the link hold and the handle kept.
func _sign_in_again() -> void:
	gate._link_resign = true
	gate._auto_state = ""
	gate._link_problem = ""
	gate.auto_step.error_key = ""
	gate.refresh_view()
	gate.activation.open_mode("sign-in")
	gate.activation.sign_in_dialog.begin()


## Sign in again ended without a sign-in (cancelled or failed): the offer is let go, the gate goes on.
func resign_ended() -> void:
	if not gate._link_resign or gate._auto_state != "":
		return
	if gate.sdk != null and is_instance_valid(gate.sdk):
		gate.sdk.identity.link.dismiss()
	gate._end_auto()
	gate.show_state(gate.sdk.status())


## No thanks declines the offer for this account on this device; Join accounts opens Help.
func secondary(step: String) -> void:
	if step == "link-offer":
		finish(true)
	elif step == "link-conflict":
		OS.shell_open("%s/docs/help/join-accounts/#if-another-account-uses-the-address" % PKeyConstants.CUSTOMER_ORIGIN_DEFAULT)


## The offer is over: `decline` remembers it for the account on this device; otherwise it is only closed.
func finish(decline: bool) -> void:
	if decline:
		gate.sdk.identity.link.decline()
	else:
		gate.sdk.identity.link.dismiss()
	gate._end_auto()
	await gate.sdk.sync(true)
	if is_instance_valid(gate):
		gate.show_state(gate.sdk.status())
