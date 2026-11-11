extends RefCounted
# @pkey-feature ui.kit connect.local
# The model behind Pair with a Code (PKeyLocalPairingModel) over a scripted
# `local_links` and a virtual clock: nothing here waits on the wall clock or the network. Each check
# is one behaviour of the React model that every kit matches: the stale-code guard, the cooldown
# after Too many tries and its countdown, the SDK's own cooldown, the second-time warning, the
# five-wrong-codes rule, the interruptions notice, "Not paired with {device}", announcing a changed
# code, the busy states, full, off and blocked, the store-failure answers and the first read.
#
#   godot --headless --path sdks/godot -- --pkey-test ui_local_models

const Fake := preload("res://tests/support/fake_local_links.gd")
const Local := preload("res://addons/polaris_key/ui/model/local.gd")
const CATS := ["crates", "cues"]


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	await _entry_and_gate(t)
	await _show_window(t)
	await _rotation_and_guessing(t)
	await _closed_and_cooldown(t)
	await _confirm_prompt(t)
	await _enter_field(t)
	await _join_answers(t)
	await _cancel_and_stale(t)
	await _network_and_full(t)
	await _paired_screen(t)
	return true


static func _model(f, extra := {}) -> PKeyLocalPairingModel:
	var o := {
		"links": f, "categories": CATS, "now": Callable(f, "now"), "timer": Callable(f, "timer")
	}
	o.merge(extra, true)
	return PKeyLocalPairingModel.new(o)


static func _opened(f, digits := "4812 3456") -> void:
	f.last_pair["on_code"].call(Fake.code(digits, "opened", f.now() + 300.0))


static func _snap(m: PKeyLocalPairingModel) -> Dictionary:
	return m.snapshot()


# ── Entry, the gate and the cap ──────────────────────────────────────────────────────────────


func _entry_and_gate(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f, {"pre_prompt": true})
	t.check(
		"local model: starts on the entry, the system's question said first",
		m.step() == "choose" and m.input()["localPairing"].get("prePrompt") == true
	)
	m.start()
	t.check(
		"local model: a gate that is on keeps the entry",
		m.step() == "choose" and _snap(m).get("full") == null
	)
	f.gate = false
	m.start()
	t.check(
		"local model: a gate that is off is the off screen",
		m.step() == "off" and m.view()["state"] == "off"
	)
	f.gate = true
	for i in 32:
		f.links.append(Fake.row("L%d" % i, "Device %d" % i))
	m.start()
	t.check(
		"local model: 32 pairings say so before either button, and neither works",
		(
			_snap(m).get("full") == true
			and m.view()["disabled"] == ["localPairing.enter", "localPairing.show"]
		)
	)
	await m.show()
	m.enter()
	t.check(
		"local model: with no room neither Show nor Enter does anything",
		m.step() == "choose" and f.pairs == 0
	)
	m.dispose()


# ── The window ───────────────────────────────────────────────────────────────────────────────


func _show_window(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f, {"label": "Studio PC"})
	await m.show()
	t.check(
		"show model: the code tile is a placeholder first, then the code",
		f.pairs == 1 and m.step() == "opening"
	)
	t.check(
		"show model: the device's label is sent",
		f.last_pair["label"] == "Studio PC" and f.last_pair["categories"] == CATS
	)
	_opened(f)
	var s := _snap(m)
	t.check(
		"show model: the first code shows with its QR and seconds",
		(
			m.step() == "show"
			and s["code"] == "4812 3456"
			and s["secondsLeft"] == 300
			and String(s["qr"]).begins_with("PKP1:")
		)
	)
	t.check(
		"show model: nothing is lit and no notice on the first code",
		s["changed"] == [] and not s.has("notice")
	)
	f.advance(1.0)
	t.check("show model: the seconds follow the injected clock", _snap(m)["secondsLeft"] == 299)
	f.advance(59.0)
	t.check(
		"show model: a minute later 240 are left",
		_snap(m)["secondsLeft"] == 240 and f.pending_timers() == 1
	)
	f.last_pair["on_interrupted"].call(2)
	t.check("show model: two interruptions say nothing", not _snap(m).has("notice"))
	f.last_pair["on_interrupted"].call(3)
	t.check(
		"show model: three interruptions say pairing is being blocked",
		_snap(m)["notice"] == "blocked" and m.view()["copy"].has("localPairing.blockedTitle")
	)
	m.cancel()
	t.check(
		"show model: Cancel withdraws the window and returns to the entry",
		m.step() == "choose" and f.window.stops == 1 and f.pending_timers() == 0
	)
	t.check(
		"show model: a late code from the withdrawn window is dropped", _noop_after_cancel(f, m)
	)
	# Expired: no wait, no warning.
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	f.last_pair["on_end"].call({"reason": "expired"})
	var c := m.view()
	t.check(
		"show model: a window that ran out has no wait",
		(
			m.step() == "closed"
			and _snap(m)["closedBy"] == "expired"
			and not c["copy"].has("localPairing.showNewIn")
			and not c.has("disabled")
		)
	)
	m.dispose()
	# Off while it showed.
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	f.last_pair["on_end"].call({"reason": "off"})
	t.check("show model: the gate going off ends on the off screen", m.step() == "off")
	m.dispose()
	# The person's own stop.
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	f.last_pair["on_end"].call({"reason": "person"})
	t.check("show model: an end by the person returns to the entry", m.step() == "choose")
	m.dispose()


func _noop_after_cancel(f, m: PKeyLocalPairingModel) -> bool:
	f.last_pair["on_code"].call(Fake.code("9999 9999", "opened", f.now() + 300.0))
	return m.step() == "choose"


# ── Rotation, the changed digits and the guessing rules ──────────────────────────────────────


func _rotation_and_guessing(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f)
	await m.show()
	_opened(f)
	var first_rotation: int = _snap(m)["rotation"]
	f.last_pair["on_code"].call(Fake.code("4873 3456", "wrong-code", f.now() + 290.0))
	var s := _snap(m)
	t.check(
		"rotation model: a wrong guess changes the code and says so",
		(
			s["code"] == "4873 3456"
			and s["notice"] == "rotated"
			and m.view()["copy"].has("localPairing.rotatedTitle")
		)
	)
	t.check(
		"rotation model: the changed digits are lit and the rotation counted",
		s["changed"] == [2, 3] and s["rotation"] == first_rotation + 1
	)
	t.check(
		"rotation model: the new code is announced apart from the action",
		m.view()["copy"].has("a11y.newCode") and m.view()["args"]["code"] == "4873 3456"
	)
	f.last_pair["on_code"].call(Fake.code("1273 3456", "wrong-code", f.now() + 280.0))
	t.check(
		"rotation model: the digits lit are those of the last change only",
		_snap(m)["changed"] == [0, 1]
	)
	for i in 2:
		f.last_pair["on_code"].call(
			Fake.code("%d273 3456" % (2 + i), "wrong-code", f.now() + 270.0)
		)
	t.check(
		"rotation model: four wrong codes are still a plain change", _snap(m)["notice"] == "rotated"
	)
	f.last_pair["on_code"].call(Fake.code("5273 3456", "wrong-code", f.now() + 260.0))
	(
		t
		. check(
			"rotation model: the fifth wrong code over renewed windows warns that someone may be guessing",
			(
				_snap(m)["notice"] == "guessing"
				and m.view()["copy"].has("localPairing.tooManyAgainBody")
			)
		)
	)
	m.dispose()
	# A decline names the device.
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	var offer := Fake.Offer.new("LAPTOP-7QH3RX", CATS)
	f.last_pair["on_confirm"].call(offer)
	t.check(
		"rotation model: a device at the prompt is named, with what is shared",
		(
			m.step() == "confirm"
			and _snap(m)["device"] == "LAPTOP-7QH3RX"
			and _snap(m)["categories"] == CATS
		)
	)
	f.last_pair["on_code"].call(Fake.code("7000 1111", "declined", f.now() + 295.0))
	s = _snap(m)
	t.check(
		"rotation model: Not now on the other device says Not paired with {device}",
		(
			m.step() == "show"
			and s["notice"] == "declined"
			and s["device"] == "LAPTOP-7QH3RX"
			and m.view()["copy"].has("localPairing.notPairedWith")
		)
	)
	(
		t
		. check(
			"rotation model: the prompt had no code on screen, so nothing is lit, and the new one is announced",
			s["changed"] == [] and m.view()["copy"].has("a11y.newCode")
		)
	)
	m.dispose()


# ── Closed: the 30 seconds ───────────────────────────────────────────────────────────────────


func _closed_and_cooldown(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f)
	await m.show()
	_opened(f)
	f.last_pair["on_end"].call({"reason": "too-many-tries"})
	var s := _snap(m)
	var v := m.view()
	t.check(
		"closed model: Too many tries closes the window for 30 seconds",
		m.step() == "closed" and s["cooldownLeft"] == 30 and not s.has("warn")
	)
	t.check(
		"closed model: the new code is unavailable while it counts",
		(
			v["copy"].has("localPairing.showNewIn")
			and v["disabled"] == ["localPairing.showNewIn"]
			and v["args"]["time"] == "0:30"
		)
	)
	await m.show_new()
	t.check("closed model: Show a new code does nothing during the wait", f.pairs == 1)
	f.advance(10.0)
	t.check(
		"closed model: the countdown follows the clock",
		_snap(m)["cooldownLeft"] == 20 and m.view()["args"]["time"] == "0:20"
	)
	f.advance(20.0)
	v = m.view()
	(
		t
		. check(
			"closed model: after 30 seconds the wait is over, the timer is gone and Show a new code is ready",
			(
				_snap(m)["cooldownLeft"] == 0
				and v["copy"].has("localPairing.showNew")
				and not v.has("disabled")
				and f.pending_timers() == 0
			)
		)
	)
	await m.show_new()
	t.check("closed model: and it opens a new window", f.pairs == 2 and m.step() == "opening")
	_opened(f, "2222 3333")
	f.last_pair["on_end"].call({"reason": "too-many-tries"})
	s = _snap(m)
	t.check(
		"closed model: the second Too many tries in a row warns",
		s["warn"] == true and m.view()["copy"].has("localPairing.tooManyAgainTitle")
	)
	m.dispose()
	# The SDK's own floor.
	f = Fake.new()
	m = _model(f)
	f.pair_result = Fake.fail("peer-closed", {"reason": "cooldown"})
	await m.show()
	s = _snap(m)
	t.check(
		"closed model: the SDK's cooldown is waited out on the closed screen",
		m.step() == "closed" and s["closedBy"] == "too-many-tries" and s["cooldownLeft"] == 30
	)
	f.advance(30.0)
	t.check("closed model: and counted down like the model's own", _snap(m)["cooldownLeft"] == 0)
	m.dispose()
	# A renewal refused while the floor is on.
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	f.window.renews = [Fake.fail("peer-closed", {"reason": "cooldown"})]
	await m.show_new()
	t.check(
		"closed model: a renewal the SDK holds off lands on the closed screen",
		m.step() == "closed" and f.window.renew_calls == 1
	)
	m.dispose()
	# Renewing: busy, repeated presses ignored, then the rotation.
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	f.last_pair["on_code"].call(Fake.code("4873 3456", "wrong-code", f.now() + 290.0))
	f.window.renews = [PKeyResult.success(Fake.code("5000 1111", "declined", f.now() + 300.0))]
	m.show_new()
	t.check(
		"closed model: Show a new code keeps its label and is busy",
		_snap(m)["busy"] == "new-code" and m.view()["disabled"] == ["localPairing.showNew"]
	)
	m.show_new()
	await Engine.get_main_loop().process_frame
	await Engine.get_main_loop().process_frame
	t.check(
		"closed model: a second press while the first is answered does nothing",
		f.window.renew_calls == 1 and _snap(m)["code"] == "5000 1111" and not _snap(m).has("busy")
	)
	m.dispose()


# ── The prompt ───────────────────────────────────────────────────────────────────────────────


func _confirm_prompt(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f)
	await m.show()
	_opened(f)
	var a := Fake.Offer.new("Studio PC", CATS)
	var b := Fake.Offer.new("Other", CATS)
	f.last_pair["on_confirm"].call(a)
	f.last_pair["on_confirm"].call(b)
	t.check(
		"prompt model: one device at a time, the next is declined",
		b.declines == 1 and a.declines == 0 and _snap(m)["device"] == "Studio PC"
	)
	m.confirm()
	m.confirm()
	t.check(
		"prompt model: Pair is answered at once and a repeat is ignored",
		(
			a.confirms == 1
			and _snap(m)["busy"] == "pair"
			and m.view()["disabled"] == ["common.notNow", "localPairing.pair"]
		)
	)
	m.not_now()
	t.check("prompt model: Not now cannot be pressed while Pair is answered", a.declines == 0)
	f.last_pair["on_linked"].call({"id": "L9", "label": "Studio PC", "categories": CATS})
	t.check(
		"prompt model: the pairing ends on the paired screen, the name as sent",
		m.step() == "paired" and _snap(m)["name"] == "Studio PC" and _snap(m)["id"] == "L9"
	)
	m.dispose()
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	a = Fake.Offer.new("", CATS)
	f.last_pair["on_confirm"].call(a)
	t.check(
		"prompt model: a device that sent no name is asked about unnamed",
		not _snap(m).has("device") and m.view()["copy"].has("localPairing.confirmUnnamed")
	)
	m.not_now()
	t.check(
		"prompt model: Not now is answered at once, both controls wait",
		a.declines == 1 and _snap(m)["busy"] == "not-now"
	)
	m.cancel()
	t.check(
		"prompt model: Cancel at the prompt declines it and returns to the entry",
		m.step() == "choose" and f.window.stops == 1
	)
	m.dispose()
	# The code changing under the prompt ends it.
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	a = Fake.Offer.new("Studio PC", CATS)
	f.last_pair["on_confirm"].call(a)
	f.last_pair["on_code"].call(Fake.code("8000 1111", "timeout", f.now() + 290.0))
	b = Fake.Offer.new("Next", CATS)
	f.last_pair["on_confirm"].call(b)
	t.check(
		"prompt model: a changed code ends the prompt, so the next device is not turned away",
		m.step() == "confirm" and b.declines == 0 and _snap(m)["device"] == "Next"
	)
	m.dispose()


# ── The field ────────────────────────────────────────────────────────────────────────────────


func _enter_field(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f)
	m.enter()
	var s := _snap(m)
	t.check(
		"field model: an empty field, Pair unavailable, no tries known",
		(
			m.step() == "enter"
			and s["entry"] == ""
			and s["pairDisabled"] == true
			and s["triesLeft"] == null
		)
	)
	m.set_entry("48-12 34")
	s = _snap(m)
	t.check(
		"field model: spaces and hyphens in a paste are dropped, digits grouped",
		s["entry"] == "4812 34" and s["pairDisabled"] == true and s["triesLeft"] == 2
	)
	m.set_entry("a4812 3456789")
	s = _snap(m)
	t.check(
		"field model: at most 8 digits are kept and Pair is ready",
		s["entry"] == "4812 3456" and s["pairDisabled"] == false
	)
	f.dials["48"] = 1
	m.set_entry("4812")
	m.set_entry("48123456")
	t.check(
		"field model: one try left says so",
		_snap(m)["triesLeft"] == 1 and m.view()["copy"].has("localPairing.triesLeft")
	)
	f.dials["48"] = 0
	m.set_entry("48123457")
	s = _snap(m)
	t.check(
		"field model: a prefix with no dial left is spent: Pair waits and says so",
		(
			s["triesLeft"] == 0
			and s["pairDisabled"] == true
			and m.view()["copy"].has("localPairing.spentCode")
		)
	)
	await m.pair()
	t.check(
		"field model: pressing an unavailable Pair answers its reason and sends nothing",
		f.joins == 0 and _snap(m)["error"] == "spent"
	)
	f.dials.clear()
	m.set_entry("48")
	await m.pair()
	t.check(
		"field model: fewer than 8 digits answer Not a code",
		(
			f.joins == 0
			and _snap(m)["error"] == "not-a-code"
			and m.view()["decisions"]["tone"] == "danger"
		)
	)
	m.dispose()


# ── What a join answers ──────────────────────────────────────────────────────────────────────


func _join_answers(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f, {"label": "Mac"})
	m.enter()
	m.set_entry("48123456")
	f.hold_join = true
	m.pair()
	t.check(
		"join model: Pair keeps its label while it looks, the field is the person's",
		(
			m.step() == "joining"
			and f.last_join["code"] == "48123456"
			and f.last_join["label"] == "Mac"
			and m.view()["disabled"] == ["localPairing.pair"]
		)
	)
	var offer := Fake.Offer.new("Studio PC", CATS)
	f.last_join["on_confirm"].call(offer)
	t.check(
		"join model: Pair was the yes: the prompt is confirmed at once and the screen waits",
		offer.confirms == 1 and m.step() == "waiting" and _snap(m)["device"] == "Studio PC"
	)
	f.finish_join(PKeyResult.success({"id": "L5", "label": "Studio PC", "categories": CATS}))
	await Engine.get_main_loop().process_frame
	await Engine.get_main_loop().process_frame
	t.check(
		"join model: a stored link is the paired screen",
		m.step() == "paired" and _snap(m)["id"] == "L5"
	)
	m.dispose()
	# Wrong: the first two digits stay, the failed code is held back.
	f = Fake.new()
	m = _model(f)
	m.enter()
	m.set_entry("48123456")
	f.join_result = Fake.fail("pairing-code-failed", {"reason": "wrong"})
	await m.pair()
	var s := _snap(m)
	t.check(
		"join model: a wrong code keeps the first two digits and says so",
		(
			m.step() == "enter"
			and s["entry"] == "48"
			and s["error"] == "wrong"
			and s["pairDisabled"] == true
		)
	)
	m.set_entry("481")
	t.check(
		"join model: typing past the proven digits keeps the line until they change",
		_snap(m).get("error") == null
	)
	m.set_entry("48123456")
	t.check(
		"join model: the very code that just failed is held: Pair stays unavailable",
		_snap(m)["pairDisabled"] == true
	)
	await m.pair()
	t.check(
		"join model: pressing it answers wrong without sending",
		f.joins == 1 and _snap(m)["error"] == "wrong"
	)
	m.set_entry("48123457")
	t.check("join model: a different eight digits are ready", _snap(m)["pairDisabled"] == false)
	m.dispose()
	# Spent: empty and editable.
	f = Fake.new()
	m = _model(f)
	m.enter()
	m.set_entry("48123456")
	f.join_result = Fake.fail("pairing-code-failed", {"reason": "spent"})
	await m.pair()
	s = _snap(m)
	t.check(
		"join model: a spent prefix leaves an empty editable field with the cooldown line",
		(
			s["entry"] == ""
			and s["error"] == "too-many"
			and m.view()["copy"].has("localPairing.cooldownTitle")
		)
	)
	# Invalid and other-app.
	f.join_result = Fake.fail("pairing-code-failed", {"reason": "invalid"})
	m.set_entry("48123456")
	await m.pair()
	t.check(
		"join model: an invalid code keeps what was typed",
		_snap(m)["entry"] == "4812 3456" and _snap(m)["error"] == "not-a-code"
	)
	f.join_result = Fake.fail("pairing-code-failed", {"reason": "other-app"})
	await m.pair()
	t.check(
		"join model: another app's code reads like a wrong one",
		_snap(m)["error"] == "wrong" and _snap(m)["entry"] == "48"
	)
	f.join_result = Fake.fail("pairing-not-found")
	m.set_entry("48123450")
	await m.pair()
	t.check(
		"join model: nothing found keeps the code and says so",
		_snap(m)["entry"] == "4812 3450" and _snap(m)["error"] == "not-found"
	)
	var pair_case_index := 0
	for pair_case in [
		["declined", "declined"], ["timeout", "timeout"], ["closed", "closed"], ["weird", "closed"]
	]:
		pair_case_index += 1
		f.join_result = Fake.fail("peer-closed", {"reason": pair_case[0]})
		m.set_entry("4812345%d" % (1 + pair_case_index))
		await m.pair()
		t.check(
			"join model: a %s end is the failed screen (%s)" % [pair_case[0], pair_case[1]],
			m.step() == "failed" and _snap(m)["reason"] == pair_case[1]
		)
		m.enter()
	m.dispose()


# ── Cancel and the stale answer ──────────────────────────────────────────────────────────────


func _cancel_and_stale(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f)
	m.enter()
	m.set_entry("48123456")
	f.hold_join = true
	m.pair()
	m.cancel()
	(
		t
		. check(
			"cancel model: Cancel while joining stops the join and returns to the field with the typed code",
			(
				f.cancels == 1
				and m.step() == "enter"
				and _snap(m)["entry"] == "4812 3456"
				and _snap(m)["pairDisabled"] == false
			)
		)
	)
	await Engine.get_main_loop().process_frame
	await Engine.get_main_loop().process_frame
	t.check(
		"cancel model: the cancelled join's late answer is dropped",
		m.step() == "enter" and not _snap(m).has("error")
	)
	m.dispose()
	# Cancel at the waiting step declines the offer.
	f = Fake.new()
	m = _model(f)
	m.enter()
	m.set_entry("48123456")
	f.hold_join = true
	m.pair()
	var offer := Fake.Offer.new("Studio PC", CATS)
	f.last_join["on_confirm"].call(offer)
	m.cancel()
	t.check(
		"cancel model: Cancel while waiting declines the prompt",
		offer.declines == 1 and m.step() == "enter"
	)
	f.finish_join(PKeyResult.success({"id": "L1", "label": "x", "categories": []}))
	await Engine.get_main_loop().process_frame
	t.check(
		"cancel model: a pairing that finishes after Cancel does not take the screen",
		m.step() == "enter"
	)
	m.dispose()
	# Back and Close.
	f = Fake.new()
	m = _model(f)
	m.enter()
	m.back_to_choose()
	t.check("cancel model: Back from the field is the entry", m.step() == "choose")
	m.cancel()
	t.check("cancel model: Cancel on the entry leaves", _snap(m)["left"] == true)
	m.dispose()


# ── The network, the cap ─────────────────────────────────────────────────────────────────────


func _network_and_full(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f, {"can_open_settings": true})
	f.pair_result = Fake.fail("nearby-permission-denied")
	await m.show()
	(
		t
		. check(
			"network model: a blocked local network is its own screen, Open Settings where the platform can",
			m.step() == "network-blocked" and _snap(m)["canOpenSettings"] == true
		)
	)
	f.pair_result = null
	await m.retry()
	t.check(
		"network model: Try again from a shown code opens the window again",
		m.step() == "opening" and f.pairs == 2
	)
	m.dispose()
	f = Fake.new()
	m = _model(f)
	m.enter()
	m.set_entry("48123456")
	f.join_result = Fake.fail("nearby-permission-denied")
	await m.pair()
	t.check(
		"network model: blocked on the field, the words alone elsewhere",
		m.step() == "network-blocked" and not _snap(m).has("canOpenSettings")
	)
	f.join_result = null
	await m.retry()
	t.check(
		"network model: Try again returns to the field with the code kept",
		m.step() == "enter" and _snap(m)["entry"] == "4812 3456"
	)
	m.dispose()
	# The cap, learnt late.
	f = Fake.new()
	m = _model(f)
	f.pair_result = Fake.fail("local-links-full", {"cap": "stored"})
	await m.show()
	t.check(
		"full model: no room learnt when showing returns to the entry with it said",
		m.step() == "choose" and _snap(m)["full"] == true
	)
	m.enter()
	m.set_entry("48123456")
	f.join_result = Fake.fail("local-links-full", {"cap": "stored"})
	f.links.clear()
	m.dispose()
	f = Fake.new()
	m = _model(f)
	m.enter()
	m.set_entry("48123456")
	f.join_result = Fake.fail("local-links-full", {"cap": "stored"})
	await m.pair()
	t.check(
		"full model: no room learnt when entering is the failed screen, Close leading",
		m.step() == "failed" and m.view()["decisions"]["primary"] == "common.close"
	)
	m.dispose()
	# Pairing off.
	f = Fake.new()
	m = _model(f)
	f.pair_result = Fake.fail("local-pairing-off")
	await m.show()
	t.check("off model: pairing turned off while opening is the off screen", m.step() == "off")
	m.dispose()
	# An unknown refusal.
	f = Fake.new()
	m = _model(f)
	f.pair_result = Fake.fail("something-else")
	await m.show()
	t.check(
		"off model: any other refusal is the failed screen",
		m.step() == "failed" and _snap(m)["reason"] == "closed"
	)
	m.dispose()


# ── The paired screen ────────────────────────────────────────────────────────────────────────


func _paired_screen(t: PKeyTestContext) -> void:
	var f := Fake.new()
	var m := _model(f)
	f.links = [Fake.row("L7", "LAPTOP-7QH3RX", null, false)]
	await m.show()
	_opened(f)
	f.last_pair["on_linked"].call({"id": "L7", "label": "LAPTOP-7QH3RX", "categories": CATS})
	t.check(
		"paired model: a pairing kept with Can connect off says it cannot connect",
		(
			m.step() == "paired"
			and _snap(m)["cantConnect"] == true
			and m.view()["copy"].has("localPairing.cantConnectTitle")
		)
	)
	m.set_name("Desk")
	m.done()
	t.check(
		"paired model: Done saves a changed name on this device and leaves",
		f.renamed == [["L7", "Desk"]] and _snap(m)["left"] == true
	)
	m.dispose()
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	f.rename_result = Fake.fail("storage-failed")
	f.last_pair["on_linked"].call({"id": "L7", "label": "LAPTOP-7QH3RX", "categories": CATS})
	m.set_name("Desk")
	m.done()
	t.check(
		"paired model: a name the store could not keep stays on the screen and says so",
		(
			m.step() == "paired"
			and _snap(m)["nameError"] == "failed"
			and _snap(m)["left"] == false
			and m.view()["copy"].has("devices.renameFailed")
		)
	)
	m.set_name("Desk 2")
	t.check("paired model: typing again clears the line", not _snap(m).has("nameError"))
	m.dispose()
	f = Fake.new()
	m = _model(f)
	await m.show()
	_opened(f)
	f.last_pair["on_linked"].call({"id": "L7", "label": "Same", "categories": CATS})
	m.done()
	t.check(
		"paired model: an unchanged name saves nothing",
		f.renamed.is_empty() and _snap(m)["left"] == true
	)
	m.dispose()
