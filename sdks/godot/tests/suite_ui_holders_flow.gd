extends RefCounted
# @pkey-feature ui.kit.holders
# The holders' scenes wired to a live SDK (UK-43.14), against the loopback Worker:
#   gate       a key activates: the gate holds the product back, draws the Done step (the key held in
#              memory only, never drawn), Start using forgets it and lets the product show; Escape on
#              Done does nothing; the step off (`key_done = false`) shows the product at once.
#   add        the recommendation opens AddToAccount; its model's `changed` drives the scene
#              (`apply_snapshot`); Cancel on an idle form goes back to Done; Escape never cancels a wait.
#   portal     Add opens the portal through the validated opener, `#key=` on a computer and never on a
#              pad-only screen, which shows the manage QR; no link is a danger line, not an action.
#   signin     the account sign-ins (Sign in as ..) wait on the form's wait screen (code, address, QR,
#              reopen), Cancel returns to the step they started from, a failed one says so there.
#   settings   a floating license shows "Not in an account", its Add, and "Remove license from this device".
#
#   godot --headless --path sdks/godot -- --pkey-test ui_holders_flow

const S := preload("res://tests/license/support.gd")
const B := preload("res://tests/identity/support.gd")
const KEY := "PKEY-TEST-KEY-0000"
const SERVICES := ["license", "config", "identity"]
const LINK := "https://polaris.locker/activate?product=tidewater"

var h: PKeyLicenseTestSupport


static func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _until(cond: Callable, max_frames := 600) -> bool:
	for i in max_frames:
		if cond.call():
			return true
		await _tree().process_frame
	return cond.call()


static func _texts(n: Node, out: Array) -> Array:
	if n is Label:
		out.append((n as Label).text)
	elif n is Button:
		out.append((n as Button).text)
	elif n is LineEdit:
		out.append((n as LineEdit).text)
	for ch in n.get_children():
		_texts(ch, out)
	return out


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	h = PKeyLicenseTestSupport.new()
	if not t.check("holders flow: fixtures present", h.ready()):
		return true
	TranslationServer.set_locale("en")
	PKeyUiView.pointer_last = false
	PKeyUiView._pointer_known = true
	PKeyUiView.mobile_override = false
	PKeyUiView.pad_only_override = false
	await _gate(t)
	await _flow_steps(t)
	await _portal(t)
	await _settings(t)
	h.free_server()
	await _sign_ins(t)
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null
	return true


func _sdk() -> Node:
	var token: String = h.F["token"]
	h.plan = {"/license/activate": [S.json(200, {"token": token, "schemaVersion": 2})]}
	h.serve_docs([token])
	return await h.sdk(PKeyMemoryStore.new(h.F["device_id"]), PackedStringArray(SERVICES), func(o: PKeyOptions) -> void: o.request_timeout_seconds = 1.0)


## A gate over `sdk` at key entry.
func _gate_over(sdk: Node) -> PKeyGateView:
	var gate := PKeyGateView.new()
	gate.auto_sdk = false
	gate.auto_sign_in = false
	_tree().root.add_child(gate)
	await _tree().process_frame
	gate.sdk = sdk
	gate.show_state({"status": "needs-activation"})
	await _tree().process_frame
	return gate


# ── The gate ─────────────────────────────────────────────────────────────────────────────

func _gate(t: PKeyTestContext) -> void:
	var sdk := await _sdk()
	var gate := await _gate_over(sdk)
	var usable := [0]
	gate.usable.connect(func() -> void: usable[0] += 1)
	gate.activation._key.text = KEY
	gate.activation._on_submit()
	var opened := await _until(func() -> bool: return gate.holders.is_open())
	t.check("gate: a key that activates opens the Done step", opened and gate.holders.stage() == "done" and gate.screen == "key-done", "%s %s" % [gate.holders.stage(), gate.screen])
	await _until(func() -> bool: return not gate.activation.key_in_flight)
	for i in 5:
		await _tree().process_frame
	t.check("gate: the product waits: the gate is not usable while Done shows", usable[0] == 0 and gate.visible and gate.holding_done(), str(usable[0]))
	var done: PKeyActivateDone = gate.holders.done
	# The fixture license names an email (it waits for it): the step says so; the recommendation is the floating case.
	t.check("gate: a license that names an email waits for it", done.model.get("state") == "waiting" and done._waiting.visible, str(done.model.get("state")))
	done.holder_email = ""
	await _tree().process_frame
	t.check("gate: Done is on screen with the license usable", done.is_visible_in_tree() and not gate.activation.visible and sdk.license.is_licensed())
	t.check("gate: the title says the product is ready", _texts(done, []).any(func(s: String) -> bool: return s.ends_with("is ready")), str(_texts(done, [])))
	var everything := " ".join(_texts(gate, [])) + JSON.stringify(done.input()) + JSON.stringify(gate.holders.add.input())
	t.check("gate: the key is held in memory and never drawn or put in the views' input", not everything.contains(KEY), "")
	t.check("gate: the key is held until Start using", gate.holders._key == KEY)
	t.check("gate: addIn is app on a computer", done.add_in == "app" and done._add.text == "Add your name and email", done._add.text)
	await _until(func() -> bool: return _tree().root.gui_get_focus_owner() != null)
	t.check("gate: the first focus is Start using, never a way out", gate.holders._initial_focus() == done._primary, str(gate.holders._initial_focus()))
	t.check("gate: Escape on Done declines nothing and the step stays", not gate._cancel() and gate.holders.stage() == "done")
	done.start_pressed.emit()
	await _until(func() -> bool: return usable[0] > 0)
	t.check("gate: Start using forgets the key and the product shows", usable[0] >= 1 and gate.holders._key == "" and not gate.holders.is_open() and gate.screen == "usable" and not gate.holding_done())
	gate.queue_free()
	sdk.queue_free()
	await _tree().process_frame
	# The step off: the product shows at once.
	var sdk2 := await _sdk()
	var gate2 := await _gate_over(sdk2)
	gate2.key_done = false
	var again := [0]
	gate2.usable.connect(func() -> void: again[0] += 1)
	gate2.activation._key.text = KEY
	gate2.activation._on_submit()
	await _until(func() -> bool: return again[0] > 0)
	t.check("gate: key_done = false shows the product at once", again[0] >= 1 and not gate2.holders.is_open() and gate2.screen == "usable")
	gate2.queue_free()
	sdk2.queue_free()
	await _tree().process_frame


# ── The steps ────────────────────────────────────────────────────────────────────────────

func _flow_steps(t: PKeyTestContext) -> void:
	var sdk := await _sdk()
	await sdk.license.activate_with_key(KEY)
	var flow := PKeyHolderFlow.new()
	_tree().root.add_child(flow)
	flow.sdk = sdk
	flow.begin_done(KEY)
	flow.done.holder_email = ""
	await _tree().process_frame
	flow.done.add_pressed.emit()
	await _tree().process_frame
	await _tree().process_frame
	var add: PKeyAddToAccount = flow.add
	t.check("steps: Add opens the account form over the SDK", flow.stage() == "add" and add.is_visible_in_tree() and add.step == "form" and flow._model != null, flow.stage())
	t.check("steps: the first focus is Name, never Cancel", flow._initial_focus() == add._name_input, str(flow._initial_focus()))
	add._name_input.text = "Ana"
	add._name_input.text_changed.emit("Ana")
	t.check("steps: a typed field reaches the model", flow._model.snapshot()["name"] == "Ana")
	add.submitted.emit("Ana", "not-an-email")
	await _tree().process_frame
	t.check("steps: the model's changed drives the scene (an invalid email)", add.step == "invalid" and add.field == "email", "%s %s" % [add.step, add.field])
	t.check("steps: the problem line is a polite live region", add._email_error.get("accessibility_live") == 1 or not ("accessibility_live" in add._email_error))
	add._name_input.text_changed.emit("Anna")
	await _tree().process_frame
	t.check("steps: editing a wrong field puts the form back", add.step == "form" and flow._model.snapshot()["name"] == "Anna")
	t.check("steps: Escape on an idle form goes back to Done, not out", add._cancel() and flow.stage() == "done")
	flow.done.add_pressed.emit()
	await _tree().process_frame
	add.cancelled.emit()
	t.check("steps: Cancel on an idle form goes back to Done", flow.stage() == "done" and not add.visible)
	flow.done.start_pressed.emit()
	t.check("steps: Start using ends the flow and forgets the key", not flow.is_open() and flow._key == "")
	flow.queue_free()
	sdk.queue_free()
	await _tree().process_frame


# ── The portal ───────────────────────────────────────────────────────────────────────────

func _portal(t: PKeyTestContext) -> void:
	var sdk := await _sdk()
	await sdk.license.activate_with_key(KEY)
	var flow := PKeyHolderFlow.new()
	_tree().root.add_child(flow)
	flow.sdk = sdk
	var opened := []
	flow.open_url = func(url: String) -> int:
		opened.append(url)
		return OK
	# No link: Add is not offered, and the line says why.
	flow.begin_done(KEY)
	flow.done.holder_email = ""
	await _tree().process_frame
	t.check("portal: a portal with no link offers no Add and says so", not flow.open_portal(KEY) and opened.is_empty())
	sdk.core.get_meta(&"portal_source").accept({"core": {"portal": {"enabled": true, "activate": LINK}}})
	t.check("portal: a computer's link carries #key=", flow.open_portal(KEY) and opened.back() == LINK + "#key=" + KEY, str(opened))
	flow.close()
	# A pad-only screen shows the manage QR, with no key in it.
	PKeyUiView.pad_only_override = true
	flow.begin_done(KEY)
	flow.done.holder_email = ""
	await _tree().process_frame
	t.check("portal: addIn is portal on a pad-only screen", flow.done.add_in == "portal" and flow.done._add.text == "Add it in Polaris Locker", flow.done._add.text)
	opened.clear()
	flow.done.add_pressed.emit()
	await _tree().process_frame
	await _tree().process_frame
	t.check("portal: the TV shows the manage QR and opens nothing", flow.stage() == "qr" and flow.qr._qr.text == LINK and opened.is_empty(), "%s %s" % [flow.stage(), flow.qr._qr.text])
	t.check("portal: the QR carries no key", not flow.qr._qr.text.contains("key=") and not " ".join(_texts(flow.qr, [])).contains(KEY))
	t.check("portal: Done on the QR goes back", flow.qr._cancel() and flow.stage() == "done")
	t.check("portal: a pad-only link has no #key=", flow.open_portal(KEY) and opened.back() == LINK, str(opened))
	flow.close()
	PKeyUiView.pad_only_override = false
	# A link the opener refuses is a danger line.
	flow.begin_done(KEY)
	flow.open_url = func(_url: String) -> int: return ERR_UNAVAILABLE
	t.check("portal: a refused open is false", not flow.open_portal(KEY))
	flow.close()
	flow.queue_free()
	sdk.queue_free()
	await _tree().process_frame


# ── Settings ─────────────────────────────────────────────────────────────────────────────

func _settings(t: PKeyTestContext) -> void:
	var sdk := await _sdk()
	await sdk.license.activate_with_key(KEY)
	var tab := PKeyAccountTab.new()
	tab.auto_load = false
	tab.auto_sdk = false
	_tree().root.add_child(tab)
	tab.sdk = sdk
	tab.tier = "Pro"
	tab.status = "ok"
	tab.services = ["license", "identity"]
	tab.floating = true
	tab.refresh_view()
	await _tree().process_frame
	await _tree().process_frame
	var all := _texts(tab._list, [])
	t.check("settings: a floating license says it is not in an account", all.has("Not in an account"), str(all))
	t.check("settings: Add your name and email is offered", all.has("Add your name and email"), str(all))
	t.check("settings: the exit reads Remove license from this device", all.has("Remove license from this device") and not all.has("Sign out"), str(all))
	var add: Button = tab._list.find_child("Add", true, false)
	add.pressed.emit()
	await _tree().process_frame
	await _tree().process_frame
	t.check("settings: Add opens the form in the list's place", tab.holders.stage() == "add" and tab.holders.add.is_visible_in_tree() and not tab._list.visible, tab.holders.stage())
	tab.holders.add.cancelled.emit()
	await _tree().process_frame
	t.check("settings: Cancel from Settings leaves the form and shows the list again", not tab.holders.is_open() and tab._list.visible)
	# Identity off: the portal opens in the browser, a missing link is not offered.
	tab.services = ["license"]
	tab.refresh_view()
	await _tree().process_frame
	await _tree().process_frame
	t.check("settings: with Identity off and no portal link Add is not offered", tab._list.find_child("Add", true, false) == null)
	tab.floating = false
	tab.services = ["license", "identity"]
	tab.refresh_view()
	await _tree().process_frame
	await _tree().process_frame
	t.check("settings: a license in an account keeps Sign out and no Add", _texts(tab._list, []).has("Sign out") and tab._list.find_child("Add", true, false) == null, str(_texts(tab._list, [])))
	tab.queue_free()
	sdk.queue_free()
	await _tree().process_frame


# ── The account sign-ins ─────────────────────────────────────────────────────────────────

func _sign_ins(t: PKeyTestContext) -> void:
	var bed := B.new()
	var sdk: Node = await bed.make_sdk("")
	bed.starts = [B.started()]
	bed.polls = [B.state("pending")]
	var flow := PKeyHolderFlow.new()
	_tree().root.add_child(flow)
	flow.sdk = sdk
	var pages := []
	flow.open_page = func(_s: PKeySignInSession) -> bool:
		pages.append(1)
		return pages.size() != 2
	flow.begin_done(KEY)
	await _tree().process_frame
	flow.done.holder_email = "ana@fennick.studio"
	flow.done.sign_in_pressed.emit()
	var waiting := await _until(func() -> bool: return flow.is_waiting())
	await _tree().process_frame
	var add: PKeyAddToAccount = flow.add
	var on_wait: bool = waiting and flow.stage() == "add" and add.step == "busy" and add.user_code == "WDJB-MJHT"
	t.check("sign-in: Sign in as .. waits on the form's wait screen on the device-code channel", on_wait, "%s %s" % [flow.stage(), add.step])
	var all := _texts(add, [])
	t.check("sign-in: the wait shows the code and the address", all.has("WDJB-MJHT") and all.any(func(s: String) -> bool: return s.contains("key.plrs.im/djdl/identity/auth/device")), str(all))
	t.check("sign-in: the page opened once, so the way back reads Open Polaris Locker again", pages.size() == 1 and add._second.text == "Open Polaris Locker again", add._second.text)
	t.check("sign-in: the wait takes the forward action's focus, not Cancel", flow._initial_focus() == add._second, str(flow._initial_focus()))
	t.check("sign-in: Escape on the wait neither declines nor cancels it", add._cancel() and flow.is_waiting())
	# The page that does not open says so, in the danger tone.
	add.reopen_pressed.emit()
	await _tree().process_frame
	t.check("sign-in: a page that did not open is a danger line on the wait", add._problem.text == "We couldn't open your browser" and add._problem.visible, add._problem.text)
	# Cancel stays live and returns to the step they started from.
	t.check("sign-in: Cancel is on the wait", add._link.visible and add._link.text == "Cancel", add._link.text)
	add.cancelled.emit()
	await _tree().process_frame
	t.check("sign-in: Cancel lets go and returns to Done", not flow.is_waiting() and flow.stage() == "done" and add.user_code == "" and add.address == "", flow.stage())
	# The QR shows on a pad-only screen.
	PKeyUiView.pad_only_override = true
	flow.done.sign_in_pressed.emit()
	await _until(func() -> bool: return flow.is_waiting())
	await _tree().process_frame
	await _tree().process_frame
	t.check("sign-in: a QR code of the page shows on a TV", add._qr.text.begins_with("https://") and add._qr.get_parent().visible, add._qr.text)
	add.cancelled.emit()
	PKeyUiView.pad_only_override = false
	# A sign-in that does not finish says so on the step it started from.
	bed.starts = [B.started()]
	bed.polls = [B.state("timeout")]
	flow.done.sign_in_pressed.emit()
	await _until(func() -> bool: return flow.stage() == "done" and flow.done.problem_key == "signin.approve.failed")
	t.check("sign-in: a sign-in that failed says so on Done, in sign-in words", flow.done._problem.text == "That didn't go through. Try again." and flow.done._problem.visible, flow.done._problem.text)
	# Signed in: the flow ends.
	bed.starts = [B.started()]
	bed.polls = [B.state("ready", {"token": B.TOKEN, "schemaVersion": 1, "identity": {"name": "Ana", "email": "ana@fennick.studio"}})]
	var ended := [0]
	flow.finished.connect(func() -> void: ended[0] += 1)
	flow.done.sign_in_pressed.emit()
	await _until(func() -> bool: return ended[0] > 0)
	t.check("sign-in: a sign-in that finishes ends the flow and forgets the key", ended[0] == 1 and not flow.is_open() and flow._key == "")
	flow.queue_free()
	bed.free_all()
	await _tree().process_frame
