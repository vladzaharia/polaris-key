extends RefCounted
# @pkey-feature identity.nearby ui.signin
# The approver screen's flow (I-48.16): "Approve a nearby device" starts the advert, a device's three codes are shown and
# the tapped one is the pick, the licence choice is one tap per licence, and leaving the codes or the choice answers
# Deny. The screen is PKeyNearbyApproval; the SDK's side is the fake LAN of test_nearby_approve.

const A := preload("res://tests/identity/test_nearby_approve.gd")
const B := preload("res://tests/identity/support.gd")


class Stage extends RefCounted:
	var rig: A.Rig
	var view: PKeyNearbyApproval
	var flow: PKeyNearbyApprovalFlow
	var exits := 0
	var devices := 0
	var sign_ins := 0


	func _on_exited() -> void:
		exits += 1


	func _on_devices() -> void:
		devices += 1


	func _on_sign_in() -> void:
		sign_ins += 1


func _stage() -> Stage:
	var s := Stage.new()
	s.rig = A.Rig.new()
	await s.rig.up()
	s.view = PKeyNearbyApproval.new()
	s.view.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(s.view)
	s.flow = PKeyNearbyApprovalFlow.new(s.view, s.rig.sdk)
	# Methods, not lambdas: a lambda would hold the stage, which holds the flow that holds the connection.
	s.flow.exited.connect(s._on_exited)
	s.flow.devices_requested.connect(s._on_devices)
	s.flow.sign_in_requested.connect(s._on_sign_in)
	return s


func _end(s: Stage) -> void:
	s.flow.close()
	s.view.queue_free()
	s.rig.free_all()


func _until(cond: Callable) -> bool:
	return await B.until(cond, 600)


func _ask(s: Stage, approval: A.FakeApproval) -> void:
	await s.flow.open()
	s.rig.lan.handler.call(approval)


func run(t: PKeyTestContext) -> void:
	await _open_and_pick(t)
	await _choose(t)
	await _leave(t)
	await _errors(t)
	await _causes(t)
	await _stopped(t)
	await _escape(t)
	await _security(t)
	_words(t)
	_settings_row(t)
	_digits(t)


func _open_and_pick(t: PKeyTestContext) -> void:
	var s := await _stage()
	s.rig.bed.approve_n = [A.approved()]
	var ap := A.FakeApproval.new()
	await s.flow.open()
	t.check("flow: Approve a nearby device listens, with the prompt open", s.view.step == "waiting" and s.rig.lan.options.get("prompt") == true)
	s.rig.lan.handler.call(ap)
	t.check("flow: a device that asks shows its name and three codes", s.view.step == "ask" and s.view.device == "Living room" and s.view.codes.size() == 3)
	# A second ask while one is shown is denied: one prompt at a time.
	var other := A.FakeApproval.new()
	s.rig.lan.handler.call(other)
	t.check("flow: a second ask while one is shown is denied locally", other.log == ["decline"] and s.view.codes.size() == 3)
	s.view.code_chosen.emit("107 356")
	await _until(func() -> bool: return s.view.step != "working")
	t.check("flow: a code that is not the one the device shows is a mismatch and approves nothing", s.view.step == "mismatch" and s.rig.bed.approves.is_empty() and s.rig.lan.approver.stops == 1)
	s.view.primary_pressed.emit("mismatch")
	t.check("flow: Done leaves", s.exits == 1)
	_end(s)

	var g := await _stage()
	g.rig.bed.approve_n = [A.approved()]
	var gap := A.FakeApproval.new()
	g.rig.ring.held = false
	await _ask(g, gap)
	g.view.code_chosen.emit("482 913")
	t.check("flow: the tapped code is working while the Worker is asked", g.view.step == "working")
	g.view.code_chosen.emit("482 913")
	await _until(func() -> bool: return g.view.step != "working")
	t.check("flow: the matching code approves once and shows approved", g.view.step == "approved" and g.rig.bed.approves.size() == 1 and g.rig.lan.approver.stops == 1)
	_end(g)


func _choose(t: PKeyTestContext) -> void:
	var s := await _stage()
	s.rig.bed.approve_n = [A.choose_answer(), A.approved()]
	var ap := A.FakeApproval.new()
	ap.finishes = [{"wait": "choice"}, {"sent": "approved"}]
	s.rig.ring.held = false
	await _ask(s, ap)
	s.view.code_chosen.emit("482 913")
	await _until(func() -> bool: return s.view.step == "choose")
	t.check("choose: one button per free licence, by name, and no new one when the Worker offers none", s.view.choices == PackedStringArray(["djdl", "Second"]) and not s.view.create_offered)
	s.view.choice_chosen.emit(1)
	await _until(func() -> bool: return s.view.step != "working")
	t.check("choose: one tap on a licence approves it", s.view.step == "approved" and s.rig.bed.approves[1]["body"].get("choice") == {"kind": "license", "licenseId": "lic_1"})
	_end(s)

	var c := await _stage()
	c.rig.bed.approve_n = [A.choose_answer(), B.json(204, {})]
	var cap := A.FakeApproval.new()
	cap.finishes = [{"wait": "choice"}, {"sent": "denied"}]
	await _ask(c, cap)
	c.view.code_chosen.emit("482 913")
	await _until(func() -> bool: return c.view.step == "choose")
	c.view.denied.emit()
	await _until(func() -> bool: return c.view.step != "working")
	t.check("choose: Deny at the choice tells the Worker to deny", c.view.step == "denied" and c.rig.bed.approves[1]["body"].get("decision") == "deny")
	_end(c)


func _leave(t: PKeyTestContext) -> void:
	# Leaving the codes any way is Deny, with no route.
	var s := await _stage()
	var ap := A.FakeApproval.new()
	await _ask(s, ap)
	s.flow.leave()
	t.check("leave: leaving the codes denies locally and calls no route", ap.log == ["decline"] and s.rig.bed.requests.is_empty() and s.exits == 1 and s.rig.lan.approver.stops == 1)
	_end(s)
	# Leaving the licence choice answers the choice's own cancel.
	var c := await _stage()
	c.rig.bed.approve_n = [A.choose_answer(), B.json(204, {})]
	var cap := A.FakeApproval.new()
	cap.finishes = [{"wait": "choice"}, {"sent": "denied"}]
	await _ask(c, cap)
	c.view.code_chosen.emit("482 913")
	await _until(func() -> bool: return c.view.step == "choose")
	c.flow.leave()
	await _until(func() -> bool: return c.rig.bed.approves.size() == 2)
	t.check("leave: leaving the licence choice tells the Worker to deny", c.rig.bed.approves.size() == 2 and c.rig.bed.approves[1]["body"].get("decision") == "deny")
	_end(c)
	# Escape on the codes is Deny.
	var e := await _stage()
	var eap := A.FakeApproval.new()
	await _ask(e, eap)
	t.check("leave: the view's Escape on the codes is Deny", e.view._cancel() and eap.log == ["decline"] and e.view.step == "denied")
	_end(e)
	# The device leaves before the person answers: it is said, naming the device, with Done.
	var d := await _stage()
	var dap := A.FakeApproval.new()
	await _ask(d, dap)
	dap.closed.emit(&"peer_bye", true)
	t.check("leave: a device that left before the answer is expired, naming it", d.view.step == "expired" and d.view.device == "Living room" and d.view.model["state"] == "expired")
	_end(d)


func _errors(t: PKeyTestContext) -> void:
	var s := await _stage()
	s.rig.lan.failure = PKeyResult.failure(PKeyConstants.ErrorCode.ACCOUNT_REQUIRED, "signed out")
	await s.flow.open()
	t.check("errors: signed out is account-required, with Sign in", s.view.step == "account-required")
	s.view.primary_pressed.emit("account-required")
	t.check("errors: Sign in leaves and asks the host", s.sign_ins == 1 and s.exits == 1)
	_end(s)
	var u := await _stage()
	u.rig.lan.failure = PKeyResult.failure(PKeyConstants.ErrorCode.NEARBY_UNSUPPORTED, "no")
	await u.flow.open()
	t.check("errors: nothing nearby can ask is failed, not an expired code", u.view.step == "failed")
	_end(u)
	var l := await _stage()
	l.rig.bed.approve_n = [A.refused(403, "device_limit")]
	var lap := A.FakeApproval.new()
	lap.finishes = [{"sent": "denied"}]
	await _ask(l, lap)
	l.view.code_chosen.emit("482 913")
	await _until(func() -> bool: return l.view.step != "working")
	t.check("errors: a device limit offers Manage devices", l.view.step == "device-limit")
	l.view.primary_pressed.emit("device-limit")
	t.check("errors: Manage devices leaves and asks the host", l.devices == 1 and l.exits == 1)
	_end(l)


## The cause is shown, not folded into "expired" (UXR major 7).
func _causes(t: PKeyTestContext) -> void:
	for case in [[A.refused(503, "service-unavailable"), "failed"], [B.json(500, {}), "failed"], [A.refused(404, "not_found"), "expired"], [A.refused(429, "rate_limited"), "rate-limited"]]:
		var s := await _stage()
		s.rig.bed.approve_n = [case[0]]
		var ap := A.FakeApproval.new()
		ap.finishes = [{"sent": "denied"}]
		await _ask(s, ap)
		s.view.code_chosen.emit("482 913")
		await _until(func() -> bool: return s.view.step != "working")
		t.check("causes: %s reads as %s" % [str(case[0].get("status", "")), case[1]], s.view.step == case[1], s.view.step)
		_end(s)


## Two declined requests stop the advert (UXR major 8): say so, and Start again listens afresh.
func _stopped(t: PKeyTestContext) -> void:
	var s := await _stage()
	await s.flow.open()
	s.rig.lan.approver.stopped.emit("budget")
	var primary: Variant = s.view.model["decisions"]["primary"]
	t.check("stopped: the budget stop says so, with Start again as the one way on", s.view.step == "stopped" and primary == "signin.nearby.startAgain" and s.rig.lan.approver.stops == 0)
	s.view.primary_pressed.emit("stopped")
	t.check("stopped: Start again counts from zero and shows the waiting screen", s.view.step == "waiting" and s.rig.lan.approver.reopens == 1)
	s.rig.lan.approver.stopped.emit("signed-out")
	t.check("stopped: a sign-out is account-required", s.view.step == "account-required")
	_end(s)
	var d := await _stage()
	await d.flow.open()
	d.rig.lan.approver.stopped.emit("discovery")
	t.check("stopped: a discovery failure is failed", d.view.step == "failed")
	_end(d)


## Escape and B (UXR major 6): Deny at the codes and the choice, Done on the waiting screen and on every outcome.
func _escape(t: PKeyTestContext) -> void:
	var s := await _stage()
	await s.flow.open()
	t.check("escape: the waiting screen's Escape leaves", s.view._cancel() and s.exits == 1)
	_end(s)
	for outcome in ["approved", "denied", "expired", "failed", "stopped", "device-limit", "account-required"]:
		var o := await _stage()
		await o.flow.open()
		o.view.step = outcome
		t.check("escape: %s leaves on Escape" % outcome, o.view._cancel() and o.exits == 1)
		_end(o)
	var e := PKeyNearbyApproval.new()
	e.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(e)
	t.check("escape: the entry row has nothing to leave", not e._cancel())
	e.step = "working"
	var left := [0]
	e.primary_pressed.connect(func(_s: String) -> void: left[0] += 1)
	t.check("escape: while the Worker is asked nothing can be left", e._cancel() and left[0] == 0)
	e.queue_free()


## The review's two non-blocking notes: a screen left while a pick is in flight answers Deny for the licence choice
## that comes back, and a choice that is not one of the two kinds answers Deny.
func _security(t: PKeyTestContext) -> void:
	var s := await _stage()
	s.rig.bed.approve_n = [A.choose_answer(), B.json(204, {})]
	var ap := A.FakeApproval.new()
	ap.finishes = [{"wait": "choice"}, {"sent": "denied"}]
	await _ask(s, ap)
	s.view.code_chosen.emit("482 913")
	s.flow.leave()
	await _until(func() -> bool: return s.rig.bed.approves.size() == 2)
	var denied: bool = s.rig.bed.approves.size() == 2 and s.rig.bed.approves[1]["body"].get("decision") == "deny"
	t.check("security: leaving mid-pick answers Deny for the licence choice that comes back", denied and s.view.step != "choose")
	_end(s)
	var c := await _stage()
	c.rig.bed.approve_n = [A.choose_answer(), B.json(204, {})]
	var cap := A.FakeApproval.new()
	cap.finishes = [{"wait": "choice"}, {"sent": "denied"}]
	var made: PKeyNearbyAsk = await c.rig.ask(cap)
	var step: PKeyNearbyStep = await made.pick("482 913")
	var out: PKeyNearbyStep = await step.choose.choose({"kind": "bogus"})
	t.check("security: a choice that is not a choice answers Deny", out.kind == PKeyNearbyStep.KIND_DENIED and c.rig.bed.approves.size() == 2 and c.rig.bed.approves[1]["body"].get("decision") == "deny")
	var again: PKeyNearbyStep = await step.choose.choose({"kind": "create"})
	t.check("security: the single use is spent", again.kind == PKeyNearbyStep.KIND_EXPIRED)
	_end(c)


## The kit draws the model's copy and its way on (UXR major 10): nothing the model names is missing, and the way on is the
## model's own, whichever words the kit keeps for its order.
func _words(t: PKeyTestContext) -> void:
	var view := PKeyNearbyApproval.new()
	view.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(view)
	view.device = "TV"
	view.codes = PackedStringArray(["111 111", "222 222", "333 333"])
	view.choices = PackedStringArray(["A"])
	var bad: Array = []
	for state in ["approved", "not-nearby", "mismatch", "denied", "expired", "device-limit", "account-required", "rate-limited", "stopped", "failed", "waiting", "choose", "ask"]:
		view.step = state
		var key: String = "listening" if state == "waiting" else state
		var known: Array = [PKeyNearbyApproval.WORDS[key][0]] + PKeyNearbyApproval.WORDS[key][1] + ["signin.approve.deny"]
		var primary = view.model["decisions"]["primary"]
		if primary is String:
			known.append(primary)
		if state == "stopped":
			known.append("common.done")
		for c: String in view.model["copy"]:
			if not known.has(c):
				bad.append("%s: %s" % [state, c])
		# Done is the way out of the paused screen, drawn beside Start again.
		if state == "stopped":
			bad.append("" if view._primary.text == "Start again" and view._done.text == "Done" else "stopped: primary %s, done %s" % [view._primary.text, view._done.text])
	bad = bad.filter(func(x: String) -> bool: return x != "")
	t.check("words: every key the model names is drawn", bad.is_empty(), str(bad))
	view.step = "device-limit"
	t.check("words: the device limit says where the room is, not 'here'", view._lede.text.contains("make room for"), view._lede.text)
	view.step = "rate-limited"
	t.check("words: rate limited has one way on, Done", view._primary.text == "Done", view._primary.text)
	view.step = "waiting"
	var lede := "On the new device, choose Sign in with a nearby device."
	t.check("words: the waiting screen reads as the model's listening state", view.model["state"] == "listening" and view._title.text == "Approve a nearby device" and view._lede.text == lede)
	view.device = ""
	view.step = "approved"
	t.check("words: an unnamed device starts the sentence in capitals", view._title.text.contains("The new device") and not view._title.text.contains("the new device"), view._title.text)
	view.step = "mismatch"
	t.check("words: a wrong code is a short title, with the sentence under it", view._title.text == "Denied. Nothing changed." and view._lede.visible)
	view.queue_free()


## The Settings row is drawn only while the host handles it.
func _settings_row(t: PKeyTestContext) -> void:
	var tab := PKeyAccountTab.new()
	tab.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(tab)
	tab.nearby_approval_offered = true
	t.check("settings row: not drawn while nothing handles it", not tab._nearby_row())
	tab.nearby_approval_requested.connect(func() -> void: pass)
	t.check("settings row: drawn once the host handles it", tab._nearby_row())
	tab.queue_free()


func _digits(t: PKeyTestContext) -> void:
	var view := PKeyNearbyApproval.new()
	view.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(view)
	view.device = "TV"
	view.codes = PackedStringArray(["111 111", "222 222", "333 333"])
	view.step = "ask"
	var tapped: Array = []
	view.code_chosen.connect(func(c: String) -> void: tapped.append(c))
	view._unhandled_key_input(_key("2"))
	view._unhandled_key_input(_key("4"))
	view._unhandled_key_input(_key("0"))
	t.check("digits: 1 to n tap the n codes there are, and no others", tapped == ["222 222"], str(tapped))
	var licences: Array = []
	view.choice_chosen.connect(func(i: int) -> void: licences.append(i))
	view.choices = PackedStringArray(["A", "B"])
	view.step = "choose"
	view._unhandled_key_input(_key("3"))
	view._unhandled_key_input(_key("1"))
	t.check("digits: the licence digits are the real 1 to n", licences == [0], str(licences))
	view.queue_free()


func _key(c: String) -> InputEventKey:
	var e := InputEventKey.new()
	e.pressed = true
	e.unicode = c.unicode_at(0)
	return e
