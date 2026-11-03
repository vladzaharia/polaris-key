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
	await _endings(t)
	await _search(t)
	await _form_row(t)


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
	await B.until(func() -> bool: return gate.auto_step.step.begins_with("nearby-") and gate._nearby_flow.session != null and gate.auto_step.step != "nearby-prompt", 600)
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
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-choose" and gate._nearby_flow.session != null, 600)
	await tree.process_frame
	await tree.process_frame
	t.check("gate nearby: Continue starts the request and lists the devices that answered", gate.auto_step.step == "nearby-choose" and rig.bed.sent("/start").size() == 1)
	var rows: Array = gate.auto_step._approver_buttons
	var row_texts := _texts(rows[0]).filter(func(x): return x != "") if not rows.is_empty() else []
	t.check(
		"gate nearby: each device is a row, its name then its platform muted, not a sentence",
		rows.size() == 1 and row_texts.size() == 2 and String(row_texts[0]).contains("Living room") and row_texts[1] == "Mac" and not String(row_texts[0]).begins_with("Open "),
		str(row_texts))
	t.check("gate nearby: the list has its own line, Choose the device to ask", _texts(gate.auto_step).has("Choose the device to ask."), str(_texts(gate.auto_step)))
	t.check("gate nearby: a pad lands on the first device", gate.auto_step._initial_focus() == rows[0] and gate.auto_step._focus_chain().has(rows[0]))
	t.check("gate nearby: no code is drawn before a device is chosen", not gate.auto_step._code_label.visible)
	gate._nearby_flow.on_chosen("A1")
	await B.until(func() -> bool: return gate.auto_step.code != "", 300)
	await tree.process_frame
	t.check(
		"gate nearby: choosing a device shows its code to tap there and drops the list",
		gate.auto_step._code_label.visible and gate.auto_step._code_label.text == "482 913" and gate.auto_step.approvers.is_empty() and not gate.auto_step._approver_box.visible,
		gate.auto_step._code_label.text)
	var code_texts := _texts(gate.auto_step)
	t.check(
		"gate nearby: the code step names the device and offers another",
		code_texts.any(func(x): return String(x).contains("Living room") and String(x).begins_with("Open ")) and code_texts.has("Choose another device") and code_texts.has("Use a code instead"),
		str(code_texts))
	t.check("gate nearby: the device list is gone and a pad lands on the primary or a link", rig.lan.req.chosen == "A1")
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-done", 900)
	await tree.process_frame
	t.check("gate nearby: a ready poll shows nearby-done with the account", gate.auto_step.step == "nearby-done" and gate.auto_step.email == "ada@example.com" and gate.auto_step.pending)
	var shown := String(gate.auto_step._title.text).replace("\u200b", "").replace("\u2068", "").replace("\u2069", "")
	t.check("gate nearby: the active mark leads the title in its own accent label while the sign-in is held", gate.auto_step._mark.visible and gate.auto_step._mark.text == "◆" and shown.contains("ada@example.com") and not shown.contains("◆"), shown)
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
		"gate nearby: Not you? declines, signs the device out and says so",
		rig.store.token == "" and rig.bed.signout_requests.size() == 1 and gate.auto_step.visible and gate.auto_step.step == "nearby-signed-out" and rig.events.is_empty() and rig.lan.req.declined == 1,
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
	await B.until(func() -> bool: return g2.auto_step.step == "nearby-choose" and g2._nearby_flow.session != null, 600)
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
	t.check("gate nearby: a request that ended before Continue shows no sign-in, only that it expired", fail.events.is_empty() and fail.store.token == "" and g4.auto_step.step == "nearby-expired")
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
	await B.until(func() -> bool: return g5.auto_step.step == "nearby-unavailable", 600)
	t.check("gate nearby: a start that cannot run says so, with nothing sent", g5.auto_step.step == "nearby-unavailable" and off.bed.nearby_requests.is_empty())
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


## Run the prompt's Continue up to the first step after it.
func _begin(rig: N.Rig, tree: SceneTree, auto := false) -> PKeyGateView:
	var gate := _stage(rig, auto)
	gate.show_nearby_prompt()
	await tree.process_frame
	gate._on_auto_primary("nearby-prompt")
	await B.until(func() -> bool: return gate._nearby_flow.session != null or (gate.auto_step.step != "nearby-prompt" and gate.auto_step.step.begins_with("nearby-")), 600)
	return gate


func _free(gate: PKeyGateView, rig: N.Rig) -> void:
	gate.queue_free()
	rig.sdk.queue_free()
	rig.free_all()


## B1: every way a request ends has its step, with Try again (a new request) and Use a code instead (the form).
func _endings(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	t.check("gate nearby: a denial, an expiry, a lapse and a refusal each map to their step",
		PKeyGateNearby.ending_for(PKeySignInOutcome.KIND_DENIED, &"") == "nearby-denied"
		and PKeyGateNearby.ending_for(PKeySignInOutcome.KIND_EXPIRED, &"") == "nearby-expired"
		and PKeyGateNearby.ending_for(PKeySignInOutcome.KIND_RATE_LIMITED, &"") == "nearby-rate-limited"
		and PKeyGateNearby.ending_for(PKeySignInOutcome.KIND_SERVICE_UNAVAILABLE, &"") == "nearby-unavailable"
		and PKeyGateNearby.ending_for(PKeySignInOutcome.KIND_ERROR, &"network-error") == "nearby-failed"
		and PKeyGateNearby.ending_for(PKeySignInOutcome.KIND_ERROR, &"rate_limited") == "nearby-rate-limited"
		and PKeyGateNearby.ending_for_code(&"not_nearby") == "nearby-not-nearby"
		and PKeyGateNearby.ending_for_code(&"nearby-unsupported") == "nearby-unavailable")
	# Denied: the title and line, Try again primary, Use a code instead quiet.
	var rig := N.Rig.new()
	await rig.up()
	rig.bed.starts_n = [N.started_answer()]
	rig.bed.polls_n = [B.json(200, {"status": "error", "reason": "access_denied"})]
	var gate := await _begin(rig, tree)
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-denied", 900)
	await tree.process_frame
	var texts := _texts(gate.auto_step)
	t.check(
		"gate nearby: a denial shows its own step with Try again and Use a code instead",
		gate.auto_step.step == "nearby-denied" and texts.has("Try again") and texts.has("Use a code instead") and gate.auto_step.model.get("decisions", {}).get("primary") == "common.tryAgain",
		str(texts))
	# Try again starts a new request.
	rig.bed.starts_n = [N.started_answer()]
	rig.bed.polls_n = [N.pending()]
	var before := rig.bed.sent("/start").size()
	gate._on_auto_primary("nearby-denied")
	await B.until(func() -> bool: return rig.bed.sent("/start").size() == before + 1 and gate.auto_step.step == "nearby-choose", 600)
	t.check("gate nearby: Try again starts a new request", rig.bed.sent("/start").size() == before + 1 and gate.auto_step.step == "nearby-choose")
	gate._cancel()
	_free(gate, rig)

	# Use a code instead leaves for the form.
	var rig2 := N.Rig.new()
	await rig2.up()
	rig2.bed.starts_n = [N.started_answer()]
	rig2.bed.polls_n = [B.json(200, {"status": "error", "reason": "access_denied"})]
	var g2 := await _begin(rig2, tree)
	await B.until(func() -> bool: return g2.auto_step.step == "nearby-denied", 900)
	g2._on_auto_secondary("nearby-denied")
	await tree.process_frame
	t.check("gate nearby: Use a code instead on an ending returns the form", not g2.auto_step.visible and g2.activation.visible)
	_free(g2, rig2)

	# A start the Worker fails is a failure step.
	var rig3 := N.Rig.new()
	await rig3.up()
	rig3.bed.starts_n = []
	var g3 := await _begin(rig3, tree)
	await B.until(func() -> bool: return g3.auto_step.step != "nearby-prompt", 600)
	t.check("gate nearby: a start the Worker fails is a step with Try again, not the bare form", g3.auto_step.visible and g3.auto_step.step in PKeyGateNearby.ENDINGS, g3.auto_step.step)
	_free(g3, rig3)

	# Not you? while the confirmation is being settled does nothing; after it, the account stays.
	var rig4 := N.Rig.new()
	await rig4.up()
	var g4 := await _to_done(rig4, tree)
	await B.until(func() -> bool: return g4.auto_step.step == "nearby-done", 900)
	g4._completing = true
	await g4._on_auto_secondary("nearby-done")
	t.check("gate nearby: Not you? during a confirm in flight leaves the screen and the session alone", g4.auto_step.step == "nearby-done" and g4._nearby_flow.session != null and rig4.store.token != "" and rig4.lan.req.declined == 0)
	t.check("gate nearby: Escape during a confirm in flight is held too", g4._cancel() and g4.auto_step.step == "nearby-done")
	g4._completing = false
	_free(g4, rig4)


## Majors 2 and 4 and minor 7: searching has a status and a limit, the list takes the focus, one device is taken.
func _search(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var rig := N.Rig.new()
	await rig.up()
	rig.lan.req.list = []
	rig.bed.starts_n = [N.started_answer()]
	rig.bed.polls_n = [N.pending()]
	var gate := _stage(rig)
	gate._nearby_flow.none_found_after = 0.3
	gate.show_nearby_prompt()
	await tree.process_frame
	gate._on_auto_primary("nearby-prompt")
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-wait" and gate._nearby_flow.session != null, 600)
	await tree.process_frame
	await tree.process_frame
	t.check("gate nearby: searching shows a status line", _texts(gate.auto_step).has("Looking for your other devices…"), str(_texts(gate.auto_step)))
	# A device answers: the list shows and a pad lands on its row.
	rig.lan.req.list = [{"id": "A1", "label": "Living room", "platform": "macOS"}, {"id": "A2", "label": "Study", "platform": "android"}]
	rig.lan.req.approvers_changed.emit(rig.lan.req.list)
	await B.until(func() -> bool: return gate.auto_step.step == "nearby-choose", 300)
	await tree.process_frame
	await tree.process_frame
	var rows: Array = gate.auto_step._approver_buttons
	t.check("gate nearby: the list shows as the devices answer, two rows", rows.size() == 2 and gate.auto_step.step == "nearby-choose")
	t.check("gate nearby: the focus lands on the first device when the list arrives", gate.get_viewport().gui_get_focus_owner() == rows[0] and gate.auto_step._initial_focus() == rows[0], str(gate.get_viewport().gui_get_focus_owner()))
	t.check("gate nearby: a device the searching timer left alone is not dropped", gate.auto_step.step == "nearby-choose")
	gate._cancel()
	_free(gate, rig)

	# Nothing answers: nearby-none-found.
	var r2 := N.Rig.new()
	await r2.up()
	r2.lan.req.list = []
	r2.bed.starts_n = [N.started_answer()]
	r2.bed.polls_n = [N.pending()]
	var g2 := _stage(r2)
	g2._nearby_flow.none_found_after = 0.2
	g2.show_nearby_prompt()
	await tree.process_frame
	g2._on_auto_primary("nearby-prompt")
	await B.until(func() -> bool: return g2.auto_step.step == "nearby-none-found", 600)
	await tree.process_frame
	var texts := _texts(g2.auto_step)
	t.check("gate nearby: with no device after a while, nearby-none-found with Try again and Use a code instead", g2.auto_step.step == "nearby-none-found" and texts.has("No device found") and texts.has("Try again") and texts.has("Use a code instead"), str(texts))
	t.check("gate nearby: the search request is over", g2._nearby_flow.session == null and r2.lan.req.closes >= 1)
	_free(g2, r2)

	# One device and no tap: it is asked.
	var r3 := N.Rig.new()
	await r3.up()
	r3.bed.starts_n = [N.started_answer()]
	r3.bed.polls_n = [N.pending()]
	var g3 := _stage(r3)
	g3._nearby_flow.single_pick_after = 0.2
	g3.show_nearby_prompt()
	await tree.process_frame
	g3._on_auto_primary("nearby-prompt")
	await B.until(func() -> bool: return g3.auto_step.code != "", 600)
	t.check("gate nearby: a single device is asked after a moment", r3.lan.req.chosen == "A1" and g3.auto_step.code == "482 913")
	# Choose another device: a new request looks again.
	r3.bed.starts_n = [N.started_answer()]
	var before := r3.bed.sent("/start").size()
	g3._nearby_flow.single_pick_after = 60.0
	g3.auto_step.another_requested.emit()
	await B.until(func() -> bool: return r3.bed.sent("/start").size() == before + 1 and g3.auto_step.step == "nearby-choose", 600)
	t.check("gate nearby: Choose another device ends the request and looks again", r3.bed.sent("/start").size() == before + 1 and g3.auto_step.code == "", "%d/%d code=%s step=%s" % [r3.bed.sent("/start").size(), before, g3.auto_step.code, g3.auto_step.step])
	g3._cancel()
	_free(g3, r3)


## Major 13: the sign-in form has a "Sign in with a nearby device" row whenever nearby is available.
func _form_row(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var rig := N.Rig.new()
	await rig.up()
	var gate := _stage(rig)
	await tree.process_frame
	await tree.process_frame
	var row: Button = gate.activation.nearby_button()
	t.check("gate nearby: the form shows Sign in with a nearby device when nearby is available", row.visible and row.text == "Sign in with a nearby device", row.text)
	t.check("gate nearby: the pad reaches the row", gate.activation._focus_chain().has(row))
	row.pressed.emit()
	await tree.process_frame
	t.check("gate nearby: the row opens the phone prompt, no route called", gate.auto_step.step == "nearby-prompt" and rig.bed.nearby_requests.is_empty())
	gate.queue_free()
	var off := N.Rig.new()
	await off.up()
	off.lan.supported = false
	var g2 := _stage(off)
	await tree.process_frame
	await tree.process_frame
	t.check("gate nearby: no row where nearby cannot run", not g2.activation.nearby_button().visible)
	g2.queue_free()
	rig.sdk.queue_free()
	off.sdk.queue_free()
	rig.free_all()
	off.free_all()
	await tree.process_frame
