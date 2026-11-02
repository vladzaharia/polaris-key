extends RefCounted
# @pkey-feature identity.nearby ui.gate
# The kit's nearby sign-in on the new device (I-48.15): the gate shows nearby-prompt, nearby-wait (the devices that
# answered, then the code to tap there) and nearby-done (held until the person says it is theirs, with the active
# mark), bound to the SDK's session. Leaving the steps by any route ends the request, and the pad reaches every
# control.

const B := preload("res://tests/identity/support.gd")
const N := preload("res://tests/identity/test_nearby.gd")


func run(t: PKeyTestContext) -> void:
	await _flow(t)
	await _leave(t)
	await _offer(t)


func _stage(rig: N.Rig, auto := false) -> PKeyGateView:
	var gate := PKeyGateView.new()
	gate.auto_sdk = false
	gate.auto_sign_in = auto
	gate.sdk = rig.sdk
	(Engine.get_main_loop() as SceneTree).root.add_child(gate)
	gate.show_state({"status": "needs-activation"})
	return gate


func _texts(n: Node, out: Array = []) -> Array:
	if n is Label and (n as Label).visible:
		out.append((n as Label).text)
	elif n is Button and (n as Button).visible:
		out.append((n as Button).text)
	for c in n.get_children():
		_texts(c, out)
	return out


## Up to the held sign-in: the gate on nearby-done with the session unconfirmed.
func _to_done(rig: N.Rig, tree: SceneTree) -> PKeyGateView:
	rig.bed.starts_n = [N.started_answer()]
	rig.bed.polls_n = [N.pending(), N.ready_answer()]
	var gate := _stage(rig)
	gate.show_nearby_prompt()
	await tree.process_frame
	gate._on_auto_primary("nearby-prompt")
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-wait" and gate._nearby_flow.session != null, 600)
	return gate


func _flow(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var rig := N.Rig.new()
	await rig.up()
	var gate := _stage(rig)
	await tree.process_frame
	t.check("gate nearby: the form shows no phone prompt unless it is offered", not gate.auto_step.visible and gate._nearby_flow.session == null)
	gate.show_nearby_prompt()
	await tree.process_frame
	t.check(
		"gate nearby: nearby-prompt replaces the form, with Continue the primary",
		gate.auto_step.visible and gate.auto_step.step == "nearby-prompt" and gate.auto_step.model.get("decisions", {}).get("primary") == "common.continue",
		str(gate.auto_step.model.get("decisions")))
	t.check("gate nearby: no route was called by the prompt", rig.bed.nearby_requests.is_empty())
	rig.bed.starts_n = [N.started_answer()]
	rig.bed.polls_n = [N.pending(), N.ready_answer()]
	gate._on_auto_primary("nearby-prompt")
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-wait" and gate._nearby_flow.session != null, 600)
	await tree.process_frame
	await tree.process_frame
	t.check("gate nearby: Continue starts the request and shows nearby-wait", gate.auto_step.step == "nearby-wait" and rig.bed.sent("/start").size() == 1)
	var rows: Array = gate.auto_step._approver_buttons
	t.check(
		"gate nearby: the devices that answered are buttons, each reading Open <app> on <device>",
		rows.size() == 1 and String((rows[0] as Button).text).contains("Living room") and String((rows[0] as Button).text).begins_with("Open "),
		str(_texts(gate.auto_step)))
	t.check("gate nearby: a pad lands on the first device", gate.auto_step._initial_focus() == rows[0] and gate.auto_step._focus_chain().has(rows[0]))
	t.check("gate nearby: no code is drawn before a device is chosen", not gate.auto_step._code_label.visible)
	gate._nearby_flow.on_chosen("A1")
	await B.until(func() -> bool: return gate.auto_step.code != "", 300)
	await tree.process_frame
	t.check(
		"gate nearby: choosing a device shows its code to tap there and drops the list",
		gate.auto_step._code_label.visible and gate.auto_step._code_label.text == "482 913" and gate.auto_step.approvers.is_empty() and not gate.auto_step._approver_box.visible,
		gate.auto_step._code_label.text)
	t.check("gate nearby: the device list is gone and a pad lands on the primary or a link", rig.lan.req.chosen == "A1")
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-done", 900)
	await tree.process_frame
	t.check("gate nearby: a ready poll shows nearby-done with the account", gate.auto_step.step == "nearby-done" and gate.auto_step.email == "ada@example.com" and gate.auto_step.pending)
	var shown := String(gate.auto_step._title.text).replace("\u200b", "").replace("\u2068", "").replace("\u2069", "")
	t.check("gate nearby: the title leads with the active mark while the sign-in is held", shown.begins_with("◆ ") and shown.contains("ada@example.com"), shown)
	t.check("gate nearby: the token is held unconfirmed behind the screen", rig.sdk.core.tokens.unconfirmed() and rig.events.is_empty())
	gate._on_auto_primary("nearby-done")
	await B.until(func() -> bool: return not gate.auto_step.visible and gate._nearby_flow.session == null, 900)
	await tree.process_frame
	t.check(
		"gate nearby: Continue confirms: the token is a sign-in, the event fires, the steps are gone",
		not rig.sdk.core.tokens.unconfirmed() and rig.events.size() == 1 and not gate.auto_step.visible and gate._nearby_flow.session == null,
		str(rig.events))
	t.check("gate nearby: the mark leaves the title once it is over", not gate.auto_step.pending)
	gate.queue_free()
	rig.sdk.queue_free()
	rig.free_all()
	await tree.process_frame


func _leave(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	# Not you? declines: the device signs out and the form returns.
	var rig := N.Rig.new()
	await rig.up()
	var gate := await _to_done(rig, tree)
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-done", 900)
	rig.bed.signout_requests.clear()
	await gate._on_auto_secondary("nearby-done")
	await tree.process_frame
	t.check(
		"gate nearby: Not you? declines, signs the device out and returns the form",
		rig.store.token == "" and rig.bed.signout_requests.size() == 1 and not gate.auto_step.visible and rig.events.is_empty() and rig.lan.req.declined == 1,
		str(rig.store.token))
	gate.queue_free()
	rig.sdk.queue_free()
	rig.free_all()

	# Escape on nearby-wait: the request ends, the form returns.
	var esc := N.Rig.new()
	await esc.up()
	esc.bed.starts_n = [N.started_answer()]
	esc.bed.polls_n = [N.pending()]
	var g2 := _stage(esc)
	g2.show_nearby_prompt()
	g2._on_auto_primary("nearby-prompt")
	await B.until(func() -> bool: return g2.auto_step.step == "nearby-wait" and g2._nearby_flow.session != null, 600)
	var session: PKeyNearbySignIn = g2._nearby_flow.session
	g2._cancel()
	await tree.process_frame
	t.check(
		"gate nearby: leaving the wait by Escape ends the request and shows the form",
		session.is_ended() and esc.lan.req.closes >= 1 and not g2.auto_step.visible and g2._nearby_flow.session == null)
	g2.queue_free()
	esc.sdk.queue_free()
	esc.free_all()

	# Escape on the held account: it counts as Not you? (the unconfirmed sign-in is discarded).
	var held := N.Rig.new()
	await held.up()
	var g3 := await _to_done(held, tree)
	await B.until(func() -> bool: return g3.auto_step.step == "nearby-done", 900)
	g3._cancel()
	await B.until(func() -> bool: return held.store.token == "", 600)
	t.check("gate nearby: leaving the held account by Escape signs the device out", held.store.token == "" and held.events.is_empty() and not g3.auto_step.visible)
	g3.queue_free()
	held.sdk.queue_free()
	held.free_all()

	# A confirm that fails is an expired request, never a sign-in.
	var fail := N.Rig.new()
	await fail.up()
	var g4 := await _to_done(fail, tree)
	await B.until(func() -> bool: return g4.auto_step.step == "nearby-done", 900)
	g4._nearby_flow.session.cancel()
	await B.until(func() -> bool: return fail.store.token == "", 600)
	await g4._on_auto_primary("nearby-done")
	t.check("gate nearby: a request that ended before Continue shows no sign-in", fail.events.is_empty() and fail.store.token == "" and not g4.auto_step.visible)
	g4.queue_free()
	fail.sdk.queue_free()
	fail.free_all()

	# A start the product refuses sends the person back to the form.
	var off := N.Rig.new()
	await off.up()
	off.lan.supported = false
	var g5 := _stage(off)
	g5.show_nearby_prompt()
	g5._on_auto_primary("nearby-prompt")
	await B.until(func() -> bool: return not g5.auto_step.visible, 600)
	t.check("gate nearby: a start that cannot run returns the form with nothing sent", not g5.auto_step.visible and off.bed.nearby_requests.is_empty())
	g5.queue_free()
	off.sdk.queue_free()
	off.free_all()
	await tree.process_frame


func _offer(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var rig := N.Rig.new()
	await rig.up()
	var gate := PKeyGateView.new()
	gate.auto_sdk = false
	gate.auto_sign_in = true
	gate.offer_nearby = true
	gate.sdk = rig.sdk
	tree.root.add_child(gate)
	var box := []
	gate.auto_sign_in_finished.connect(func(r: PKeyAutoSignInResult) -> void: box.append(r))
	gate.show_state({"status": "needs-activation"})
	await B.until(func() -> bool: return not box.is_empty(), 900)
	await tree.process_frame
	t.check("gate nearby: with the offer on and nothing found silently, the phone prompt shows", gate.auto_step.visible and gate.auto_step.step == "nearby-prompt", str(box))
	gate.queue_free()
	rig.sdk.queue_free()
	rig.free_all()
	await tree.process_frame
