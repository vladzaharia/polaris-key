class_name PKeyGateChoice
extends RefCounted
## PKeyGateView's automatic licence choice: the choice screen's answers (a licence, a replaced device, the
## consent step) completed against `identity.choice` with the grant the gate holds.

var gate: PKeyGateView


func _init(p_gate: PKeyGateView) -> void:
	gate = p_gate


func on_chosen(selection: Dictionary) -> void:
	if gate._auto_state != "choose":
		return
	var kind := String(selection.get("kind", ""))
	var choice := {"kind": kind}
	if kind == "license":
		choice["license_id"] = String(selection.get("id", ""))
	await complete(choice, null)


## Replace a device on a full licence: the licence's devices, in place.
func on_replace_requested(license_id: String) -> void:
	var grant := gate._held_grant()
	if gate._auto_state != "choose" or grant == "" or gate.sdk == null or not is_instance_valid(gate.sdk):
		return
	var r: PKeyChoiceResult = await gate.sdk.identity.choice.devices(grant, license_id)
	if not is_instance_valid(gate) or gate._auto_state != "choose":
		return
	if r.ok and not r.view.is_empty():
		gate.license_choice.open_replace(license_id, r.view)
	else:
		gate.license_choice.show_raced()


func on_replace_confirmed(license_id: String, device: Dictionary) -> void:
	if gate._auto_state != "choose" or String(device.get("id", "")) == "":
		return
	await complete({"kind": "license", "license_id": license_id, "replace_device_id": String(device["id"])}, null)


func complete(choice: Variant, consent: Variant) -> void:
	var grant := gate._held_grant()
	if grant == "" or gate.sdk == null or not is_instance_valid(gate.sdk) or gate._completing:
		return
	gate._completing = true
	gate.auto_step.busy = gate._auto_state == "confirm"
	var r: PKeyChoiceResult = await gate.sdk.identity.choice.complete(grant, choice, consent)
	gate._completing = false
	if not is_instance_valid(gate):
		return
	gate.auto_step.busy = false
	if not r.ok and r.view is Dictionary and r.view.get("choices") is Array:
		# A refusal the person can fix (a full licence, a choice still due) carries a fresh view.
		gate._auto_state = "choose"
		gate.license_choice.other_account_link = true
		gate.show_license_choice(r.view)
		return
	if not r.ok and gate._auto_state == "confirm" and r.code != &"invalid_grant":
		# The grant is still good (the network failed, say): the step stays, with the kit's own error line,
		# and Continue tries again. The grant is given up only when the person leaves.
		gate.auto_step.error_key = "core.codes.network.message"
		return
	var failure := ""
	if not r.ok:
		# The grant expired or was used: back to the form, with the kit's line, and the grant given up.
		failure = String(gate.catalog().format("core.codes.invalid_grant.message"))
		gate.sdk.identity.choice.cancel(grant)
	gate._end_auto()
	gate.show_state(gate.sdk.status(), failure)
