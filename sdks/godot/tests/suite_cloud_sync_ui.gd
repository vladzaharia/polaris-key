extends RefCounted
# @pkey-feature ui.kit
# The Cloud Sync screens (U-42.5): UnlockSync, RecoveryCode, RingChange and the CloudSyncStatus
# `locked` and `ring-changed` rows. The corpus rows run in suite_ui_core, the structural snapshots
# in suite_ui, and the layout at every size in suite_ui_matrix; this suite pins what those cannot
# see: the key ring calls the screens make (over a fake ring, never a network), the answers that
# route to start over, the recovery code drawn in whole groups and never kept, a destructive Start
# over that reads in every look, a confirm that arms after a beat and a first focus that is Cancel.
#
# The save screens (K.5, then bound to the saves in K.5T: `_saves_binding` drives the strip and the
# conflict screen from a real PKeySaves over scripted transfers): every row of ui-matrix.json's `saveConflict`
# family (SaveConflict and the CloudSyncStatus transfer rows) is built as the scene and compared with
# the row in English, German and Japanese; the Must-not rules are applied to the rendered scene and
# to a negative fixture; a pad's first focus, Keep both disabled with its reason, one choice at a
# time, and the strip that never says synced while a transfer is pending.
#
#   godot --headless --path sdks/godot -- --pkey-test cloud_sync_ui

const SCENARIOS := preload("res://tests/ui/scenarios.gd")
const MATRIX := preload("res://tests/ui/matrix.gd")
## Fixture text in the code's own shape, never a real code.
const CODE := "AB3D-9FGH-JK4M-NP5Q-RS6T-VW7X-YZ80-1C2E"
const RING := {"ring_id": "rg_AAAAAAAAAAAAAAAAAAAAAA", "epoch": 2, "root_kid": "00112233445566778899aabbccddeeff"}

var _sc


## A key ring that answers what the real one would, scripted: each verb returns the next result
## queued for it, and the arguments are kept so a test can see what was handed over.
class FakeRing extends RefCounted:
	var answers := {}
	var calls: Array = []

	func queue(verb: String, r: PKeyResult) -> void:
		if not answers.has(verb):
			answers[verb] = []
		(answers[verb] as Array).append(r)

	func _next(verb: String, args: Array) -> PKeyResult:
		calls.append([verb, args])
		var q: Array = answers.get(verb, [])
		return q.pop_front() if not q.is_empty() else PKeyResult.failure(&"network-error", "no answer queued")

	func recover(text: String) -> PKeyResult:
		return _next("recover", [text])

	func reset(with_recovery := true) -> PKeyResult:
		return _next("reset", [with_recovery])

	func accept_ring_change(confirmed: Dictionary) -> PKeyResult:
		return _next("accept_ring_change", [confirmed])

	func unlock() -> PKeyResult:
		return _next("unlock", [])

	func create(with_recovery := true) -> PKeyResult:
		return _next("create", [with_recovery])

	func set_recovery_code() -> PKeyResult:
		return _next("set_recovery_code", [])


## A records port with nothing on it: keeping the other version pulls, finds nothing, and settles.
class EmptyRecords extends RefCounted:
	func pull_records() -> bool:
		return true


	func get_record(_id: String) -> Variant:
		return null


## `PolarisKey.cloud_sync`, scripted: `status()` answers the queued status (the last one repeats);
## `flush()` is counted.
class FakeCloud extends RefCounted:
	var states: Array = []
	## The saves (PKeySaves) the screens bind to (K.5T).
	var saves: Object = null
	var reads := 0
	var flushes := 0

	func status() -> PKeyResult:
		reads += 1
		var st: Variant = states[0] if states.size() == 1 else states.pop_front()
		return st if st is PKeyResult else PKeyResult.success(st)

	func flush() -> PKeyResult:
		flushes += 1
		return status()


class FakeSdk extends Node:
	signal event(kind: String, data: Dictionary)
	var keyring: Object = null
	var cloud_sync: Object = null


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_sc = SCENARIOS.new()
	TranslationServer.set_locale("en")
	PKeyUiTheme.reset()
	PKeyUiTheme.reduce_motion_mode = "on"
	PKeyCloudSyncController.memory_clipboard = true
	var root := _tree().root
	var size_before := root.size
	root.size = Vector2i(1280, 720)
	_controller_pure(t)
	await _controller_calls(t)
	await _unlock(t)
	await _recovery(t)
	await _ring_change(t)
	await _status(t)
	await _kit_host(t)
	await _kit_strip(t)
	await _kit_account(t)
	await _destructive(t)
	await _ux_round(t)
	await _saves_rows(t)
	await _saves_behaviour(t)
	await _saves_binding(t)
	PKeyUiTheme.reset()
	PKeyCloudSyncController.memory_clipboard = false
	root.size = size_before
	return true


static func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _free(v: Control) -> void:
	v.get_parent().remove_child(v)
	v.queue_free()


func _free_node(n: Node) -> void:
	n.get_parent().remove_child(n)
	n.queue_free()


func _frames(n := 3) -> void:
	for i in n:
		await _tree().process_frame


func _fail(code: String) -> PKeyResult:
	return PKeyResult.failure(StringName(code), "scripted")


func _sdk(ring: FakeRing) -> FakeSdk:
	var s := FakeSdk.new()
	s.keyring = ring
	_tree().root.add_child(s)
	return s


func _buttons(v: Control) -> Dictionary:
	var out := {}
	for n in v.find_children("*", "Button", true, false):
		if (n as Control).is_visible_in_tree():
			out[String(n.name)] = n
	return out


# ── The controller ───────────────────────────────────────────────────────────────────────────

func _controller_pure(t: PKeyTestContext) -> void:
	t.check("unlock_step: ok is no step", PKeyCloudSyncController.unlock_step(PKeyResult.success()) == "")
	t.check("unlock_step: a failed check is invalid", PKeyCloudSyncController.unlock_step(_fail("recovery-code-invalid")) == "invalid")
	t.check("unlock_step: a not_found answer goes to start over", PKeyCloudSyncController.unlock_step(_fail("not_found")) == "no-code")
	t.check("unlock_step: any other failure is a failure", PKeyCloudSyncController.unlock_step(_fail("network-error")) == "failed")
	var groups := PKeyCloudSyncController.groups_of(CODE)
	t.check("groups_of: 8 groups of 4", groups.size() == 8 and groups[0] == "AB3D" and groups[7] == "1C2E", str(groups))
	t.check(
		"groups_of: spaces, hyphens and one long run all regroup the same",
		PKeyCloudSyncController.groups_of("ab3d 9fgh-JK4M NP5QRS6TVW7XYZ801C2E") == PackedStringArray(["ab3d", "9fgh", "JK4M", "NP5Q", "RS6T", "VW7X", "YZ80", "1C2E"]),
	)
	t.check("hyphenated: the form that is copied", PKeyCloudSyncController.hyphenated("AB3D9FGHJK4MNP5QRS6TVW7XYZ801C2E") == CODE)
	t.check("groups_of: an empty code has no groups", PKeyCloudSyncController.groups_of("").is_empty())


func _controller_calls(t: PKeyTestContext) -> void:
	var none := await PKeyCloudSyncController.recover(null, "x")
	t.check("controller: no SDK is a failure result, not an assert", not none.ok and none.code == PKeyErrors.SERVICE_UNAVAILABLE)
	var ring := FakeRing.new()
	var sdk := _sdk(ring)
	ring.queue("recover", PKeyResult.success({"ring_id": "r"}))
	t.check("controller: recover passes the typed text through", (await PKeyCloudSyncController.recover(sdk, "abc")).ok and ring.calls[0] == ["recover", ["abc"]])
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "ring-changed"}))
	var again := await PKeyCloudSyncController.accept(sdk, RING)
	t.check("controller: an accept that answers ring-changed again is ok and carries the new ring", again.ok and again.detail.get("kind") == "ring-changed")
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "locked"}))
	t.check("controller: any other answer to an accept is a failure", not (await PKeyCloudSyncController.accept(sdk, RING)).ok)
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "unlocked"}))
	t.check("controller: an accept that opened the ring is ok, with exactly the served ring", (await PKeyCloudSyncController.accept(sdk, RING)).ok and ring.calls[ring.calls.size() - 1][1][0] == RING)
	ring.queue("unlock", PKeyResult.success({"kind": "locked", "reason": "no-ring"}))
	ring.queue("create", PKeyResult.success({"recovery_code": CODE}))
	var made := await PKeyCloudSyncController.begin(sdk)
	t.check(
		"controller: locked with no ring is the create path and shows the new code",
		made["screen"] == "recovery_code" and made["code"] == CODE and ring.calls[ring.calls.size() - 1][0] == "create",
		str(made.keys()),
	)
	ring.queue("unlock", PKeyResult.success({"kind": "locked", "reason": "no-wrap"}))
	t.check("controller: locked with a ring but no wrap asks for the recovery code", (await PKeyCloudSyncController.begin(sdk))["screen"] == "unlock_sync")
	ring.queue("unlock", PKeyResult.success({"kind": "ring-changed", "served": RING, "by": "Maya"}))
	var changed := await PKeyCloudSyncController.begin(sdk)
	t.check("controller: a changed ring carries who and what was served", changed["screen"] == "ring_change" and changed["by"] == "Maya" and changed["served"] == RING)
	ring.queue("unlock", PKeyResult.success({"kind": "unlocked", "ring_id": "r", "epoch": 1}))
	t.check("controller: an unlocked device shows nothing", (await PKeyCloudSyncController.begin(sdk))["screen"] == "")
	ring.queue("unlock", _fail("network-error"))
	t.check("controller: a failed read is a failed screen", (await PKeyCloudSyncController.begin(sdk))["screen"] == "failed")
	sdk.queue_free()


# ── UnlockSync ───────────────────────────────────────────────────────────────────────────────

func _unlock(t: PKeyTestContext) -> void:
	var ring := FakeRing.new()
	var sdk := _sdk(ring)
	var v: PKeyUnlockSync = _sc.unlock_sync("code")
	v.sdk = sdk
	await _frames()
	# The field offers Paste, and Enter submits.
	var b := _buttons(v)
	t.check("unlock: the field offers Paste", b.has("Paste") and (b["Paste"] as Button).text == "Paste")
	t.check("unlock: Unlock, Start over and Cancel, in that order, none destructive", b.has("Primary") and b.has("StartOver") and b.has("Cancel") and not b.has("ConfirmStartOver"))
	t.check("unlock: the nearby option is never drawn", v.find_child("Nearby", true, false) == null)
	PKeyCloudSyncController.clipboard_set(CODE)
	(b["Paste"] as Button).pressed.emit()
	t.check("unlock: Paste fills the field", v.typed_code() == CODE)
	# A wrong code: the line shows, and editing clears it.
	ring.queue("recover", _fail("recovery-code-invalid"))
	var field := v.find_child("CodeInput", true, false) as LineEdit
	field.text_submitted.emit(field.text)
	await _frames(4)
	t.check("unlock: Enter submits, and a code that fails its check says so", v.step == "invalid" and ring.calls.size() == 1 and ring.calls[0][0] == "recover")
	var err := v.find_child("Error", true, false) as Label
	t.check("unlock: 'That code isn't right' is on the screen", err.visible and err.text.begins_with("That code isn"), err.text)
	field.text = CODE + "X"
	field.text_changed.emit(field.text)
	await _frames()
	t.check("unlock: the line clears when the code is edited", v.step == "code" and not (v.find_child("Error", true, false) as Label).visible)
	# A not_found answer goes to start over.
	ring.queue("recover", _fail("not_found"))
	(_buttons(v)["Primary"] as Button).pressed.emit()
	await _frames(4)
	t.check("unlock: not_found goes to start over (no field, Start over is the way on)", v.step == "no-code" and not v._field_block.visible)
	var nb := _buttons(v)
	t.check("unlock: no-code offers Start over and Cancel", nb.has("Primary") and (nb["Primary"] as Button).text == "Start over" and nb.has("Cancel"))
	# Start over: the warning, with the typed code kept across Cancel.
	(nb["Primary"] as Button).pressed.emit()
	await _frames()
	t.check("unlock: Start over opens the warning", v.step == "start-over")
	var sb := _buttons(v)
	t.check(
		"unlock: the warning lists Start over first and Cancel last",
		sb.has("ConfirmStartOver") and sb.has("Cancel") and not sb.has("Primary") and v._actions.get_child(0) == sb["ConfirmStartOver"] and _last_visible(v._actions) == sb["Cancel"],
	)
	t.check("unlock: the first focus is Cancel, never the destructive control", v._initial_focus() == sb["Cancel"])
	# A double tap inside the arming window does nothing.
	ring.queue("reset", PKeyResult.success({"recovery_code": CODE}))
	var before := ring.calls.size()
	(sb["ConfirmStartOver"] as Button).pressed.emit()
	await _frames()
	t.check("unlock: Start over ignores a press before it arms", ring.calls.size() == before and v.step == "start-over")
	v._armed_at = 0
	var minted: Array = []
	v.started_over.connect(func(c: String) -> void: minted.append(c))
	(sb["ConfirmStartOver"] as Button).pressed.emit()
	await _frames(4)
	t.check("unlock: an armed Start over runs reset and hands over the new code", ring.calls.size() == before + 1 and ring.calls[before][0] == "reset" and minted == [CODE], str(ring.calls))
	t.check("unlock: the field is cleared after a start over", v.typed_code() == "")
	_free(v)
	# Cancel on the warning returns to the code step with what was typed.
	var w: PKeyUnlockSync = _sc.unlock_sync("code")
	w.sdk = sdk
	await _frames()
	w.set_typed_code("typed-code")
	w.step = "start-over"
	await _frames()
	t.check("unlock: Escape on the warning goes back to the code step", w._cancel() and w.step == "code")
	t.check("unlock: the typed code is kept", w.typed_code() == "typed-code")
	var cancelled := []
	w.cancelled.connect(func() -> void: cancelled.append(1))
	w._cancel()
	t.check("unlock: Cancel on the code step leaves", cancelled.size() == 1)
	# A mint is never abandoned: Escape and Cancel do nothing while it runs.
	w.step = "working"
	await _frames()
	t.check("unlock: Escape is ignored while working", w._cancel() and cancelled.size() == 1 and w.step == "working")
	var wb := _buttons(w)
	t.check("unlock: nothing to press while working", not wb.has("Primary") and not wb.has("Cancel") and not wb.has("ConfirmStartOver"))
	# A failed request: Try again repeats it.
	w.step = "failed"
	await _frames()
	t.check("unlock: failed offers Try again and Cancel", (_buttons(w)["Primary"] as Button).text == "Try again")
	# A start over that failed has its own line, and Try again repeats the start over.
	var sof: PKeyUnlockSync = _sc.unlock_sync("code")
	sof.sdk = sdk
	await _frames()
	ring.queue("reset", _fail("network-error"))
	ring.queue("reset", PKeyResult.success({"recovery_code": CODE}))
	sof.step = "start-over"
	await _frames()
	sof._armed_at = 0
	var started: Array = []
	sof.started_over.connect(func(c: String) -> void: started.append(c))
	var rb0 := ring.calls.size()
	(_buttons(sof)["ConfirmStartOver"] as Button).pressed.emit()
	await _frames(4)
	t.check(
		"unlock: a failed start over is its own step with its own line",
		sof.step == "start-over-failed" and (sof.find_child("Warning", true, false) as Label).text.begins_with("Couldn't start over"),
		sof.step,
	)
	(_buttons(sof)["Primary"] as Button).pressed.emit()
	await _frames(4)
	t.check("unlock: Try again repeats the start over, with no second warning", started == [CODE] and ring.calls.size() == rb0 + 2 and ring.calls[rb0 + 1][0] == "reset")
	_free(sof)
	# Cancel on a warning opened from no-code returns to no-code.
	var nc: PKeyUnlockSync = _sc.unlock_sync("no-code")
	await _frames()
	(_buttons(nc)["Primary"] as Button).pressed.emit()
	await _frames()
	nc._cancel()
	t.check("unlock: Cancel on a warning opened from no-code returns to no-code", nc.step == "no-code")
	_free(nc)
	# The host-handled path emits and does not call the ring.
	var host: PKeyUnlockSync = _sc.unlock_sync("code")
	host.host_handles = true
	host.sdk = sdk
	await _frames()
	var asked: Array = []
	host.unlock_requested.connect(func(c: String) -> void: asked.append(c))
	host.set_typed_code(CODE)
	(_buttons(host)["Primary"] as Button).pressed.emit()
	t.check("unlock: a host-handled screen asks the game", asked == [CODE] and host.step == "code")
	_free(host)
	_free(w)
	sdk.queue_free()


static func _last_visible(row: Control) -> Node:
	var last: Node = null
	for ch in row.get_children():
		if ch is Control and (ch as Control).visible:
			last = ch
	return last


# ── RecoveryCode ─────────────────────────────────────────────────────────────────────────────

func _recovery(t: PKeyTestContext) -> void:
	var v: PKeyRecoveryCode = _sc.recovery_code("show")
	await _frames()
	t.check("code: eight groups of four, drawn as given", v.shown_groups() == PKeyCloudSyncController.groups_of(CODE) and v.shown_groups().size() == 8)
	var b := _buttons(v)
	t.check("code: Done is hidden until it is saved, and no empty action area is docked", not b.has("Done") and not v._actions.visible)
	t.check("code: it cannot be dismissed (Escape is consumed, the screen stays)", v._cancel() and v.visible)
	t.check("code: the code is never a field", v.find_children("*", "LineEdit", true, false).is_empty() and v.find_children("*", "TextEdit", true, false).is_empty())
	t.check("code: Copy code is offered", b.has("Copy") and (b["Copy"] as Button).text == "Copy code")
	var grid := v.find_child("Code", true, false) as GridContainer
	t.check("code: four groups to a row where they fit", grid.columns == 4, str(grid.columns))
	# accessibility_name exists from Godot 4.5; the 4.4 floor has no spoken label to check.
	if "accessibility_name" in grid:
		var spoken := str(grid.get("accessibility_name"))
		t.check("code: a spoken label spells the groups out with pauses", spoken.begins_with("Recovery code AB3D, 9FGH, ") and spoken.ends_with("1C2E"), spoken)
	(b["Copy"] as Button).pressed.emit()
	await _frames()
	t.check("code: Copy puts the hyphenated code on the clipboard", PKeyCloudSyncController.clipboard_get() == CODE)
	t.check("code: Copied is said", (v.find_child("Copied", true, false) as Label).visible)
	# Checking the box shows Done.
	var done := []
	v.done.connect(func() -> void: done.append(1))
	var box := v.find_child("Saved", true, false) as CheckBox
	box.button_pressed = true
	await _frames()
	b = _buttons(v)
	t.check("code: checking 'I've saved it' shows Done", v.saved and b.has("Done") and v._actions.visible)
	(b["Done"] as Button).pressed.emit()
	await _frames()
	t.check("code: Done leaves and the screen forgets the code", done.size() == 1 and v.code == "" and "".join(v.shown_groups()) == "")
	_free(v)
	# A code that arrives with spaces still draws as groups.
	var odd: PKeyRecoveryCode = _sc.recovery_code("show")
	odd.code = "ab3d 9fgh jk4m np5q rs6t vw7x yz80 1c2e"
	await _frames()
	t.check("code: spaces are normalised, never split on", odd.shown_groups().size() == 8)
	_free(odd)
	# A narrow screen draws whole groups two to a row, never clipped.
	var root := _tree().root
	var before := root.size
	root.size = Vector2i(200, 640)
	var narrow: PKeyRecoveryCode = _sc.recovery_code("show")
	narrow.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	narrow.refresh_view()
	await _frames(4)
	var ng := narrow.find_child("Code", true, false) as GridContainer
	t.check("code: a narrow screen draws fewer groups to a row", ng.columns < 4, "%d columns, room %.0f" % [ng.columns, narrow.room_x()])
	var well := narrow.find_child("CodeField", true, false) as Control
	var clipped := 0
	for g in ng.get_children():
		var gc := g as Control
		if gc.get_global_rect().end.x > well.get_global_rect().end.x + 1.0 or gc.size.x + 0.5 < gc.get_combined_minimum_size().x:
			clipped += 1
	t.check("code: no group is cut at a narrow width", clipped == 0, "%d clipped" % clipped)
	_free(narrow)
	root.size = before


# ── RingChange ───────────────────────────────────────────────────────────────────────────────

func _ring_change(t: PKeyTestContext) -> void:
	var ring := FakeRing.new()
	var sdk := _sdk(ring)
	var v: PKeyRingChange = _sc.ring_change("confirm")
	v.sdk = sdk
	await _frames()
	var b := _buttons(v)
	t.check(
		"ring: Use recovery code, That was me, Cancel, in that order",
		b.has("UseCode") and b.has("Accept") and b.has("Cancel") and v._actions.get_child(0) == b["UseCode"] and _last_visible(v._actions) == b["Cancel"],
	)
	t.check("ring: the primary is the recovery code and takes the first focus", v._initial_focus() == b["UseCode"])
	t.check("ring: the device is named", (v.find_child("BodyText", true, false) as Label).text.contains("Maya"), (v.find_child("BodyText", true, false) as Label).text)
	# Accept hands exactly the served ring over.
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "unlocked"}))
	var ok: Array = []
	v.accepted.connect(func() -> void: ok.append(1))
	(b["Accept"] as Button).pressed.emit()
	await _frames(4)
	t.check("ring: That was me passes the ring that was shown", ring.calls.size() == 1 and ring.calls[0][1][0] == RING and ok.size() == 1, str(ring.calls))
	# The ring moved again: the new ring and its device are shown, and That was me asks again for it.
	var moved := {"ring_id": "rg_BBBBBBBBBBBBBBBBBBBBBB", "epoch": 3, "root_kid": "ffeeddccbbaa99887766554433221100"}
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "ring-changed", "served": moved, "by": "Desk", "pinned": RING}))
	(_buttons(v)["Accept"] as Button).pressed.emit()
	await _frames(4)
	t.check(
		"ring: a ring that moved again shows the new ring and its device, with no failure",
		v.served == moved and v.by == "Desk" and not v.failed and (v.find_child("BodyText", true, false) as Label).text.contains("Desk") and not (v.find_child("Error", true, false) as Label).visible,
	)
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "unlocked"}))
	(_buttons(v)["Accept"] as Button).pressed.emit()
	await _frames(4)
	t.check("ring: the next That was me hands over the new ring", ring.calls[ring.calls.size() - 1][1][0] == moved and ok.size() == 2)
	# A failed accept says so and Accept stays.
	ring.queue("accept_ring_change", _fail("network-error"))
	(_buttons(v)["Accept"] as Button).pressed.emit()
	await _frames(4)
	t.check("ring: a failed accept says so and keeps Accept", v.failed and (v.find_child("Error", true, false) as Label).visible and _buttons(v).has("Accept"))
	t.check(
		"ring: the failure carries a glyph, and the device line is still there",
		(v.find_child("ErrorGlyph", true, false) as Control).visible and (v.find_child("BodyText", true, false) as Label).text.contains("Desk"),
	)
	_free(v)
	var none: PKeyRingChange = _sc.ring_change("nothing served")
	await _frames()
	t.check("ring: nothing served, nothing to accept", not _buttons(none).has("Accept") and _buttons(none).has("UseCode"))
	_free(none)
	var anon: PKeyRingChange = _sc.ring_change("no device named")
	await _frames()
	t.check(
		"ring: no device named reads neutrally",
		not (anon.find_child("BodyText", true, false) as Label).text.contains("Maya") and (anon.find_child("BodyText", true, false) as Label).text.begins_with("A device"),
	)
	_free(anon)
	var cancelled := []
	var c: PKeyRingChange = _sc.ring_change("confirm")
	c.cancelled.connect(func() -> void: cancelled.append(1))
	await _frames()
	t.check("ring: Escape cancels", c._cancel() and cancelled.size() == 1)
	_free(c)
	sdk.queue_free()


# ── CloudSyncStatus ──────────────────────────────────────────────────────────────────────────

func _status(t: PKeyTestContext) -> void:
	var s: PKeyCloudSyncStatus = _sc.cloud_sync("locked")
	await _frames()
	var asked := []
	s.unlock_requested.connect(func() -> void: asked.append("unlock"))
	s.review_requested.connect(func() -> void: asked.append("review"))
	var b := _buttons(s)
	t.check("status: locked says so and offers Unlock sync", (s.find_child("Status", true, false) as Label).text == "Sync is locked." and (b["Action"] as Button).text == "Unlock sync")
	(b["Action"] as Button).pressed.emit()
	t.check("status: Unlock sync asks for the unlock screen", asked == ["unlock"])
	_free(s)
	var r: PKeyCloudSyncStatus = _sc.cloud_sync("ring-changed")
	await _frames()
	r.review_requested.connect(func() -> void: asked.append("review"))
	var rb := _buttons(r)
	t.check("status: a changed ring always offers Review, with no host handler", (rb["Action"] as Button).text == "Review" and not r.can_review)
	(rb["Action"] as Button).pressed.emit()
	t.check("status: Review opens the ring confirmation", asked.has("review"))
	_free(r)
	var ok: PKeyCloudSyncStatus = _sc.cloud_sync("synced")
	await _frames()
	t.check("status: Synced has no warning icon", ok._glyph.get_meta(&"pkey_glyph") == "success")
	_free(ok)


# ── The destructive control reads in every look ──────────────────────────────────────────────

func _destructive(t: PKeyTestContext) -> void:
	for look in ["brand-dark", "brand-light", "neutral"]:
		PKeyUiTheme.reset()
		PKeyUiTheme.reduce_motion_mode = "on"
		if look.begins_with("brand"):
			PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
			PKeyUiTheme.scheme = "light" if look == "brand-light" else "dark"
		var v: PKeyUnlockSync = _sc.unlock_sync("start-over")
		v.refresh_view()
		await _frames()
		var confirm := v.find_child("ConfirmStartOver", true, false) as Button
		var fill := (confirm.get_theme_stylebox("normal") as StyleBoxFlat).bg_color
		var ink := confirm.get_theme_color("font_color")
		var lf := fill.srgb_to_linear().get_luminance()
		var li := ink.srgb_to_linear().get_luminance()
		var ratio := (maxf(lf, li) + 0.05) / (minf(lf, li) + 0.05)
		t.check("destructive: Start over reads at 4.5:1 on its danger fill (%s)" % look, ratio >= 4.5, "%.2f:1" % ratio)
		_free(v)
	PKeyUiTheme.reset()
	PKeyUiTheme.reduce_motion_mode = "on"


# ── The kit host: the strip and the screens follow PolarisKey.cloud_sync (U-42.5T) ────────────

func _kit_sdk(states: Array) -> FakeSdk:
	var ring := FakeRing.new()
	var sdk := _sdk(ring)
	sdk.cloud_sync = FakeCloud.new()
	sdk.cloud_sync.states = states
	return sdk


func _row(sdk: FakeSdk) -> PKeyCloudSyncKitHost:
	var h := PKeyCloudSyncKitHost.new()
	h.sdk = sdk
	await h.refresh()
	return h


func _kit_host(t: PKeyTestContext) -> void:
	var cases := [
		["local", {"state": "local", "pending": 0}, "", false],
		["unsupported", {"state": "unsupported", "pending": 0}, "", false],
		["idle", {"state": "idle", "pending": 0}, "synced", false],
		["pending", {"state": "pending", "pending": 2}, "synced", false],
		["syncing", {"state": "syncing", "pending": 1}, "syncing", false],
		["offline", {"state": "offline", "pending": 1}, "offline", false],
		["paused", {"state": "paused", "pending": 1}, "offline", false],
		["blocked: account required", {"state": "blocked", "reason": "account_required"}, "error", true],
		["blocked: unauthorized", {"state": "blocked", "reason": "unauthorized"}, "error", true],
		["blocked: forbidden", {"state": "blocked", "reason": "forbidden"}, "error", false],
		["Sync off (typed N/A)", PKeyResult.failure(&"product", "off"), "", false],
	]
	for c in cases:
		var sdk := _kit_sdk([c[1]])
		var h := await _row(sdk)
		t.check("kit host: %s -> row '%s'" % [c[0], c[2]], h.status_row == c[2] and h.signed_out == c[3], h.status_row)
		_free_node(sdk)
	# Locked: the key ring tells a plain lock from a changed ring, and never accepts one.
	var sdk := _kit_sdk([{"state": "locked", "pending": 0, "reason": "keyring"}])
	(sdk.keyring as FakeRing).queue("unlock", PKeyResult.success({"kind": "locked", "reason": "no-wrap"}))
	var h := await _row(sdk)
	t.check("kit host: locked with a plain lock is locked", h.status_row == "locked" and h.served.is_empty())
	(sdk.keyring as FakeRing).queue("unlock", PKeyResult.success({"kind": "ring-changed", "by": "Desk", "served": RING}))
	await h.refresh()
	t.check("kit host: a changed ring is ring-changed, with the ring it was drawn for", h.status_row == "ring-changed" and h.by == "Desk" and h.served == RING)
	t.check("kit host: the probe never accepts a ring", not (sdk.keyring as FakeRing).calls.any(func(c: Array) -> bool: return c[0] == "accept_ring_change"))
	(sdk.keyring as FakeRing).queue("unlock", PKeyResult.failure(&"network-error", "x"))
	await h.refresh()
	t.check("kit host: an unreadable ring is a plain lock", h.status_row == "locked")
	# The event stream.
	sdk.cloud_sync.states = [{"state": "idle", "pending": 0}]
	await h.start()
	sdk.event.emit("cloudSync", {"type": "signedOut", "reason": "signOut"})
	t.check("kit host: signedOut is a neutral error row offering sign in", h.status_row == "error" and h.signed_out and h.account_state() == "signedOut")
	sdk.event.emit("cloudSync", {"type": "change", "keys": ["a.x"], "origin": "local"})
	await _frames()
	t.check("kit host: a change refreshes to synced", h.status_row == "synced" and not h.signed_out)
	var reads: int = sdk.cloud_sync.reads
	sdk.event.emit("license", {"type": "change"})
	await _frames()
	t.check("kit host: other event kinds are ignored", sdk.cloud_sync.reads == reads)
	h.stop()
	_free_node(sdk)


func _kit_strip(t: PKeyTestContext) -> void:
	# Locked -> Unlock sync -> the code opens the ring -> the screen goes and the machine is read again.
	var sdk := _kit_sdk([{"state": "locked", "pending": 1, "reason": "keyring"}, {"state": "idle", "pending": 0}])
	var ring := sdk.keyring as FakeRing
	ring.queue("unlock", PKeyResult.success({"kind": "locked", "reason": "no-wrap"}))
	var strip := PKeyCloudSyncStatus.new()
	strip.auto_sdk = false
	_tree().root.add_child(strip)
	await strip.follow(sdk)
	await _frames()
	t.check("strip: follows a locked machine", strip.state == "locked" and (strip.find_child("Status", true, false) as Label).text == "Sync is locked.")
	(_buttons(strip)["Action"] as Button).pressed.emit()
	await _frames()
	var u := _find(PKeyUnlockSync)
	t.check("strip: Unlock sync opens UnlockSync", u != null and strip.host.screen == "unlock")
	ring.queue("recover", PKeyResult.success({"ring_id": "r"}))
	u.set_typed_code("ab3d 9fgh")
	await u._on_unlock()
	await _frames(6)
	t.check(
		"strip: the code unlocks, the screen goes, the queue flushes and the row redraws",
		_find(PKeyUnlockSync) == null and strip.host.screen == "" and sdk.cloud_sync.flushes == 1 and strip.state == "synced",
		"%s %s %s %s" % [_find(PKeyUnlockSync), strip.host.screen, sdk.cloud_sync.flushes, strip.state],
	)
	_free_strip(strip)
	_free_node(sdk)
	# Ring changed -> Review -> Accept (only the served ring) -> the screen goes.
	sdk = _kit_sdk([{"state": "locked", "pending": 0, "reason": "keyring"}, {"state": "idle", "pending": 0}])
	ring = sdk.keyring as FakeRing
	ring.queue("unlock", PKeyResult.success({"kind": "ring-changed", "by": "Desk", "served": RING}))
	strip = PKeyCloudSyncStatus.new()
	strip.auto_sdk = false
	_tree().root.add_child(strip)
	await strip.follow(sdk)
	await _frames()
	t.check("strip: a changed ring says so and offers Review", strip.state == "ring-changed" and (_buttons(strip)["Action"] as Button).text == "Review")
	(_buttons(strip)["Action"] as Button).pressed.emit()
	await _frames()
	var rc := _find(PKeyRingChange)
	t.check("strip: Review opens RingChange for the ring that was drawn", rc != null and rc.served == RING and rc.by == "Desk")
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "unlocked"}))
	await rc._on_accept()
	await _frames(6)
	t.check(
		"strip: accepting hands over exactly that ring and closes the screen",
		ring.calls.any(func(c: Array) -> bool: return c[0] == "accept_ring_change" and c[1][0] == RING) and _find(PKeyRingChange) == null and strip.state == "synced",
		"%s %s %s" % [_find(PKeyRingChange), strip.state, ring.calls],
	)
	# "Use recovery code" from RingChange goes to UnlockSync.
	strip.host.served = RING
	strip.host.open_review()
	await _frames()
	_find(PKeyRingChange).use_code_requested.emit()
	await _frames()
	t.check("strip: use recovery code switches RingChange to UnlockSync", _find(PKeyRingChange) == null and _find(PKeyUnlockSync) != null)
	# Start over -> RecoveryCode shows the new code once -> Done wipes it.
	ring.queue("reset", PKeyResult.success({"ring_id": "r2", "recovery_code": CODE}))
	var uu := _find(PKeyUnlockSync)
	await uu._start_reset()
	await _frames()
	var rv := _find(PKeyRecoveryCode)
	t.check("strip: start over shows the new recovery code", _find(PKeyUnlockSync) == null and rv != null and rv.code == CODE and strip.host.screen == "recovery_code")
	rv.saved = true
	await rv._on_done()
	await _frames(6)
	t.check("strip: Done closes the code screen and nothing keeps the code", _find(PKeyRecoveryCode) == null and strip.host.code == "" and (not is_instance_valid(rv) or rv.code == ""))
	# New recovery code from settings.
	ring.queue("set_recovery_code", PKeyResult.success(CODE))
	await strip.host.request_new_recovery_code()
	await _frames()
	rv = _find(PKeyRecoveryCode)
	t.check("strip: New recovery code goes through the key ring and shows the code", rv != null and rv.code == CODE and ring.calls.any(func(c: Array) -> bool: return c[0] == "set_recovery_code"))
	strip.host.dismiss()
	await _frames()
	t.check("strip: an unsaved new code is never dropped", _find(PKeyRecoveryCode) != null)
	rv.saved = true
	await rv._on_done()
	await _frames(6)
	ring.queue("set_recovery_code", _fail("network-error"))
	await strip.host.request_new_recovery_code()
	await _frames()
	t.check("strip: a failed New recovery code shows no screen and says so", _find(PKeyRecoveryCode) == null and strip.host.new_code_failed)
	_free_strip(strip)
	_free_node(sdk)


func _find(cls: Variant) -> Control:
	for layer in _tree().root.get_children():
		if layer is CanvasLayer and not layer.is_queued_for_deletion():
			for c in layer.get_children():
				if is_instance_of(c, cls) and not c.is_queued_for_deletion():
					return c
	return null


func _free_strip(strip: PKeyCloudSyncStatus) -> void:
	var host := strip.host
	strip.get_parent().remove_child(strip)
	strip.queue_free()
	if host != null:
		host.stop()


func _kit_account(t: PKeyTestContext) -> void:
	var tab := PKeyAccountTab.new()
	tab.auto_sdk = false
	_tree().root.add_child(tab)
	var seen := {}
	for st in ["locked", "ring-changed", "signedOut", "synced"]:
		tab.cloud_sync = st
		tab.cloud_sync_time = "2 min ago"
		tab.refresh_view()
		await _frames()
		var v := tab.find_child("Value", true, false) as Label
		seen[st] = v.text if v != null else ""
	t.check("account: the Cloud Sync row says locked", seen["locked"] == "Sync is locked.", str(seen))
	t.check("account: the Cloud Sync row says the key changed", seen["ring-changed"] == "Your sync key changed.", str(seen))
	t.check("account: the existing rows still read", seen["signedOut"] == "You're signed out." and seen["synced"].begins_with("Synced"), str(seen))
	tab.get_parent().remove_child(tab)
	tab.queue_free()


# ── The UX round (UXR-U-42.5) ────────────────────────────────────────────────────────────────

func _ux_round(t: PKeyTestContext) -> void:
	var ring := FakeRing.new()
	var sdk := _sdk(ring)
	# An empty field shows no error and takes the focus; success stays on `working`.
	var u: PKeyUnlockSync = _sc.unlock_sync("code")
	u.sdk = sdk
	await _frames()
	await u._on_unlock()
	await _frames()
	t.check("unlock: Enter on an empty field checks nothing and shows no error", u.step == "code" and ring.calls.is_empty() and not (u.find_child("Error", true, false) as Label).visible)
	ring.queue("recover", PKeyResult.success({"ring_id": "r"}))
	var woke: Array = []
	u.unlocked.connect(func() -> void: woke.append(u.step))
	u.set_typed_code("ab3d")
	await u._on_unlock()
	await _frames()
	t.check("unlock: a successful unlock stays on working (no empty form) for the host to close", u.step == "working" and woke == ["working"] and u.typed_code() == "")
	_free(u)
	ring.queue("reset", PKeyResult.success({"ring_id": "r2", "recovery_code": CODE}))
	var so: PKeyUnlockSync = _sc.unlock_sync("code")
	so.sdk = sdk
	await _frames()
	await so._start_reset()
	await _frames()
	t.check("unlock: a start over that made a code stays on working for the host", so.step == "working")
	_free(so)
	# The actions sit under the field, in its column, and a failure carries a glyph.
	var f: PKeyUnlockSync = _sc.unlock_sync("failed")
	await _frames()
	t.check("unlock: a failure line has a glyph before it", (f.find_child("WarningGlyph", true, false) as Control).visible and (f.find_child("Warning", true, false) as Label).visible)
	_free(f)
	var c: PKeyUnlockSync = _sc.unlock_sync("code")
	await _frames()
	t.check("unlock: Unlock sits in the field's column", c._actions.get_parent() == c._field_block.get_parent())
	_free(c)
	# Start over: left and right reach the neighbouring button on a horizontal row.
	var w: PKeyUnlockSync = _sc.unlock_sync("start-over")
	await _frames(4)
	if not w._actions.vertical:
		var order: Array = []
		for ch in w._actions.get_children():
			if ch is Control and (ch as Control).visible:
				order.append(ch)
		var last := order[order.size() - 1] as Control
		var prev := order[order.size() - 2] as Control
		t.check("unlock: a pad's left from Cancel reaches the button before it", last.get_node_or_null(last.focus_neighbor_left) == prev)
		t.check("unlock: a pad's right reaches the next button", prev.get_node_or_null(prev.focus_neighbor_right) == last)
	_free(w)
	# The destructive button is the theme's PKeyDanger in every look and size.
	for look in ["brand-dark", "brand-light", "neutral"]:
		PKeyUiTheme.reset()
		PKeyUiTheme.reduce_motion_mode = "on"
		if look.begins_with("brand"):
			PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
			PKeyUiTheme.scheme = "light" if look == "brand-light" else "dark"
		var d: PKeyUnlockSync = _sc.unlock_sync("start-over")
		d.refresh_view()
		await _frames()
		var danger := d._confirm.get_theme_stylebox("normal") as StyleBoxFlat
		var prim := d._primary.get_theme_stylebox("normal") as StyleBoxFlat
		t.check(
			"danger: Start over keeps the primary's shape and padding (%s)" % look,
			(
				d._confirm.theme_type_variation == &"PKeyDanger"
				and not d._confirm.has_theme_stylebox_override("normal")
				and danger != null
				and prim != null
				and danger.get_corner_radius(CORNER_TOP_LEFT) == prim.get_corner_radius(CORNER_TOP_LEFT)
				and danger.content_margin_left == prim.content_margin_left
				and danger.content_margin_top == prim.content_margin_top
			),
			"%s %s" % [danger.content_margin_left if danger else -1, prim.content_margin_left if prim else -1],
		)
		_free(d)
	PKeyUiTheme.reset()
	PKeyUiTheme.reduce_motion_mode = "on"
	# Save the code: ticking the box moves focus to Done; Done takes the code off the clipboard.
	var r: PKeyRecoveryCode = _sc.recovery_code("show")
	await _frames(4)
	var box := r.find_child("Saved", true, false) as CheckBox
	box.grab_focus()
	box.button_pressed = true
	await _frames(4)
	var done := r.find_child("Done", true, false) as Button
	t.check("code: ticking the box moves the focus to Done", done != null and done.visible and done.has_focus())
	PKeyCloudSyncController.clipboard_set(PKeyCloudSyncController.hyphenated(CODE))
	await r._on_done()
	t.check("code: Done takes the code off the clipboard", PKeyCloudSyncController.clipboard_get() == "")
	PKeyCloudSyncController.clipboard_set("something else")
	_free(r)
	var r2: PKeyRecoveryCode = _sc.recovery_code("show")
	await _frames()
	r2.saved = true
	await r2._on_done()
	t.check("code: Done leaves a clipboard that holds something else alone", PKeyCloudSyncController.clipboard_get() == "something else")
	_free(r2)
	var empty := PKeyRecoveryCode.new()
	empty.auto_sdk = false
	_tree().root.add_child(empty)
	await _frames()
	t.check("code: no code, no screen", not empty.visible)
	_free(empty)
	_free_node(sdk)


# ── The save screens (K.5) ───────────────────────────────────────────────────────────────────

const MATRIX_PATH := "res://tests/corpus/v2/ui-matrix.json"
## The labels of the controls a save screen offers, by copy key.
const BUTTON_KEYS := ["saveConflict.keepThis", "saveConflict.keepOther", "saveConflict.acceptDelete", "saveConflict.keepBoth", "common.cancel", "common.done", "common.tryAgain", "saveConflict.chooseAgain"]


## Build the scene a `saveConflict` row names, from the row's own input.
func _scene_for(row: Dictionary) -> Control:
	var input: Dictionary = row["input"]
	var on: bool = not input.has("services") or (input["services"] as Array).has("sync")
	if row["expect"]["component"] == "SaveConflict":
		var c: Dictionary = input["saveConflict"]
		var s := PKeySaveConflict.new()
		s.auto_sdk = false
		_sc.add(s)
		s.sync_on = on
		s.local_when = String((c.get("local", {}) as Dictionary).get("when", ""))
		s.remote_deleted = c.has("remote") and c["remote"] == null
		if c.get("remote") is Dictionary:
			s.remote_when = String(c["remote"].get("when", ""))
			s.remote_device = String(c["remote"].get("device", ""))
		s.both_available = c.get("bothAvailable") == true
		s.keep = String(c.get("keep", ""))
		s.newer = String(c.get("newer", ""))
		s.step = String(c["step"])
		s.refresh_view()
		return s
	var cs: Dictionary = input["cloudSync"]
	var strip := PKeyCloudSyncStatus.new()
	strip.auto_sdk = false
	strip.follow_sdk = false
	_sc.add(strip)
	strip.service_on = on
	strip.sync_time = String(cs.get("lastSynced", ""))
	var tr: Dictionary = cs.get("transfer", {})
	strip.transfer_size = String(tr.get("size", ""))
	strip.transfer_total = String(tr.get("total", ""))
	strip.transfer_fraction = float(tr.get("fraction", -1.0))
	strip.reason = String(cs.get("reason", "network"))
	strip.state = String(cs["state"])
	strip.refresh_view()
	return strip


## The words a scene draws: its labels and buttons, bar the product header.
func _drawn(v: Control) -> Array:
	var out := []
	for n in v.find_children("*", "Control", true, false):
		if (n is Label or n is Button) and (n as Control).is_visible_in_tree() and not str(v.get_path_to(n)).contains("Product"):
			out.append(n)
	return out


## The Must-not rules of a row applied to what is drawn: the state, the copy keys and the actions.
## Returns the violated rule, or "".
static func _violation(must_not: Variant, state: String, shown: Array, actions: Array) -> String:
	if not (must_not is Dictionary):
		return ""
	for s in must_not.get("states", []):
		if state == s:
			return "state %s" % s
	for k in must_not.get("copy", []):
		if shown.has(k):
			return "copy %s" % k
	for a in must_not.get("actions", []):
		if actions.has(a):
			return "action %s" % a
	return ""


func _saves_rows(t: PKeyTestContext) -> void:
	var m = PKeyTestFixtures.read_json(MATRIX_PATH)
	var rows: Array = m["saveConflict"]
	t.check("saves: the saveConflict family has rows to run", rows.size() >= 23, str(rows.size()))
	var catalog = null
	for locale in ["en", "de", "ja"]:
		TranslationServer.set_locale(locale)
		catalog = PKeyUiView.catalog()
		var ran := 0
		var texts_seen := 0
		for row in rows:
			var name := "saves rows (%s): %s" % [locale, row["name"]]
			var v := _scene_for(row)
			await _frames(2)
			var want: Dictionary = row["expect"]
			var model: Dictionary = (v as Variant).model
			var ok: bool = model.get("state") == want["state"]
			var copy: Array = model.get("copy", []).duplicate()
			copy.sort()
			var want_copy: Array = (want.get("copy", []) as Array).duplicate()
			want_copy.sort()
			ok = ok and copy == want_copy
			var acts: Array = model.get("actions", []).duplicate()
			acts.sort()
			var want_acts: Array = (want.get("actions", []) as Array).duplicate()
			want_acts.sort()
			ok = ok and acts == want_acts
			var detail := "" if ok else "%s %s %s / want %s %s %s" % [model.get("state"), copy, acts, want["state"], want_copy, want_acts]
			# The scene draws the model's words in the running locale, and nothing else.
			var key_args: Dictionary = model.get("keyArgs", {})
			var device := ""
			if v is PKeySaveConflict:
				device = PKeyUiTheme.isolate((v as PKeySaveConflict).remote_device.strip_edges())
			var expected: Array = []
			for k in copy:
				# a11y copy names a control for a screen reader; it draws no words.
				if String(k).begins_with("a11y."):
					continue
				var args: Dictionary = key_args.get(k, model.get("args", {})).duplicate()
				if args.has("device"):
					args["device"] = device
				expected.append(String(catalog.format(k, args)))
			var drawn := _drawn(v)
			if want["state"] == "hidden":
				ok = ok and not v.visible
			else:
				for e in expected:
					var found := false
					for n in drawn:
						found = found or String(n.text).contains(e)
					ok = ok and found
					if not found:
						detail += " missing text [%s]" % e
				for n in drawn:
					var known := false
					for e in expected:
						known = known or String(n.text).contains(e)
					if not known:
						ok = false
						detail += " stray text [%s]" % n.text
					if n is Button and known:
						texts_seen += 1
				# The controls offered are the model's actions, and a disabled one is never one of them.
				var offered := 0
				for n in drawn:
					if n is Button and not (n as Button).disabled and (n as Button).text != catalog.format("common.cancel", {}) and (n as Button).text != catalog.format("common.done", {}) and (n as Button).text != catalog.format("common.tryAgain", {}) and (n as Button).text != catalog.format("saveConflict.chooseAgain", {}):
						offered += 1
				var model_actions := 0
				for a in acts:
					if a in ["keep-local", "keep-remote", "keep-both"]:
						model_actions += 1
				ok = ok and offered == model_actions
				if offered != model_actions:
					detail += " offered %d choices, model has %d" % [offered, model_actions]
			# Must not, on the model and on what is drawn.
			var shown_keys: Array = copy
			var hit := _violation(want.get("mustNot"), String(model.get("state")), shown_keys, acts)
			var must_not = row.get("mustNot")
			if must_not is Dictionary and must_not.has("copy") and v.visible:
				# Never "Synced" while a transfer is pending, in words as well as in keys.
				for k in must_not["copy"]:
					# Newer's two keys read the same: a drawn "Newer" is the other key's when that is the model's.
					if k in ["saveConflict.newerThis", "saveConflict.newerOther"] and (copy.has("saveConflict.newerThis") or copy.has("saveConflict.newerOther")):
						continue
					for n in drawn:
						if String(n.text) == String(catalog.format(k, {"time": "2 min ago"})):
							hit = "drawn %s" % k
			if hit != "":
				ok = false
				detail += " Must not (%s): %s" % [must_not.get("invariant", ""), hit]
			if t.check(name, ok, detail):
				ran += 1
			_free(v)
		t.check("saves rows (%s): every row passes (%d/%d)" % [locale, ran, rows.size()], ran == rows.size())
		t.check("saves rows (%s): controls were found and checked" % locale, texts_seen > 0)
	TranslationServer.set_locale("en")
	# The negative fixture: the rules catch a screen that breaks them.
	var gone_wrong := {"states": ["keeping", "kept"]}
	t.check("saves: Must-not catches a choice already applied on a screen that asked", _violation(gone_wrong, "kept", [], []) != "")
	t.check("saves: Must-not catches Synced while a transfer is pending", _violation({"copy": ["cloudSync.synced"]}, "transferring", ["cloudSync.synced", "cloudSync.transferring"], []) != "")
	t.check("saves: Must-not catches Keep both offered with every slot in use", _violation({"actions": ["keep-both"]}, "choose", [], ["keep-both", "keep-local"]) != "")
	t.check("saves: Must-not passes a clean choice", _violation(gone_wrong, "choose", [], ["keep-local"]) == "")


static func _contrast(a: Color, b: Color) -> float:
	var la := _lum(a)
	var lb := _lum(b)
	return (maxf(la, lb) + 0.05) / (minf(la, lb) + 0.05)


static func _lum(c: Color) -> float:
	var l := c.srgb_to_linear()
	return 0.2126 * l.r + 0.7152 * l.g + 0.0722 * l.b


func _saves_behaviour(t: PKeyTestContext) -> void:
	TranslationServer.set_locale("en")
	# Nothing is the default: no filled control, the first focus is Cancel, and a choice is one press.
	var v: PKeySaveConflict = _sc.save_conflict("choose")
	await _frames(3)
	var b := _buttons(v)
	var primaries := 0
	for n in b.values():
		primaries += 1 if (n as Button).theme_type_variation == &"PKeyPrimary" else 0
	t.check("saves: choose has no filled control", primaries == 0 and b.has("KeepThis") and b.has("KeepOther") and b.has("KeepBoth") and b.has("Cancel"))
	t.check("saves: the first focus is Cancel, never a choice", v._initial_focus() == b["Cancel"])
	t.check("saves: the choices are one column in reading order, Cancel last", v._actions.get_child(0) == b["KeepThis"] and v._actions.get_child(1) == b["KeepOther"] and v._actions.get_child(2) == b["KeepBoth"] and _last_visible(v._actions) == b["Cancel"])
	t.check("saves: the choices are not split into a docked bar", b["Cancel"].get_parent() == b["KeepThis"].get_parent())
	var picked: Array = []
	v.keep_requested.connect(func(k: String) -> void: picked.append(k))
	v.cancelled.connect(func() -> void: picked.append("cancelled"))
	(b["KeepThis"] as Button).pressed.emit()
	(b["KeepOther"] as Button).pressed.emit()
	(b["KeepBoth"] as Button).pressed.emit()
	(b["Cancel"] as Button).pressed.emit()
	t.check("saves: each way on is its own signal", picked == ["local", "remote", "both", "cancelled"], str(picked))
	picked.clear()
	v._cancel()
	t.check("saves: Escape cancels", picked == ["cancelled"])
	_free(v)
	# Every slot in use: Keep both stays, disabled, with its reason, and asks for nothing.
	var full: PKeySaveConflict = _sc.save_conflict("slots-full")
	await _frames(3)
	var fb := _buttons(full)
	var reason := full.find_child("BothFull", true, false) as Label
	t.check("saves: Keep both is disabled while every slot is in use, with its reason under it", (fb["KeepBoth"] as Button).disabled and reason.visible and reason.get_index() == (fb["KeepBoth"] as Button).get_index() + 1 and reason.text == PKeyUiView.catalog().format("saveConflict.bothFull", {}))
	var asked: Array = []
	full.keep_requested.connect(func(k: String) -> void: asked.append(k))
	full._on_keep_both()
	t.check("saves: a disabled Keep both asks for nothing", asked.is_empty())
	t.check("saves: the first focus is still Cancel", full._initial_focus() == fb["Cancel"] and not PKeyUiView.is_focusable(fb["KeepBoth"]))
	_free(full)
	# The other copy was deleted: its own title, lede and button, no Keep both.
	var gone: PKeySaveConflict = _sc.save_conflict("deleted")
	await _frames(3)
	var gb := _buttons(gone)
	var cat = PKeyUiView.catalog()
	t.check("saves: a deleted copy has its own title and lede", (gone.find_child("Title", true, false) as Label).text == cat.format("saveConflict.deletedTitle", {}) and (gone.find_child("Lede", true, false) as Label).text == cat.format("saveConflict.deletedLede", {}))
	t.check("saves: Delete it here too is its own button and Keep both goes", (gb["KeepOther"] as Button).text == "Delete it here too" and not gb.has("KeepBoth"))
	t.check("saves: Delete it here too is outlined in the danger colour, never filled", (gb["KeepOther"] as Button).theme_type_variation != &"PKeyPrimary" and (gb["KeepOther"] as Button).has_theme_color_override(&"font_color"))
	_free(gone)
	# It keeps the shape and fill of the other choices, and its words read, in both schemes.
	var mx = MATRIX.new()
	mx.use_locale("en")
	for scheme in ["dark", "light"]:
		var st: Dictionary = await mx.stage(_tree(), ["save_conflict.deleted", "save_conflict", "choose: the other copy was deleted", "full"], Vector2i(1280, 720), 1.0, null, scheme)
		var d: PKeySaveConflict = st["view"]
		await _frames(4)
		var db := _buttons(d)
		# Two panes: each version card is level with the choice it maps to, and carries no outline.
		var lc := d.find_child("Local", true, false) as Control
		var rc := d.find_child("Remote", true, false) as Control
		t.check("saves (%s): the cards line up with their choices" % scheme, d.two_pane_fits() and absf(lc.global_position.y - (db["KeepThis"] as Control).global_position.y) <= 4.0 and absf(rc.global_position.y - (db["KeepOther"] as Control).global_position.y) <= 4.0, "%s %s / %s %s" % [lc.global_position.y, rc.global_position.y, (db["KeepThis"] as Control).global_position.y, (db["KeepOther"] as Control).global_position.y])
		t.check("saves (%s): the cards are tints, not outlined controls" % scheme, ((lc as PanelContainer).get_theme_stylebox(&"panel") as StyleBoxFlat).border_width_left == 0)
		var del := db["KeepOther"] as Button
		var keep := db["KeepThis"] as Button
		var dbox := del.get_theme_stylebox(&"normal") as StyleBoxFlat
		var kbox := keep.get_theme_stylebox(&"normal") as StyleBoxFlat
		t.check("saves (%s): Delete it here too has the other choices' corner radius and fill" % scheme, dbox != null and kbox != null and dbox.corner_radius_top_left == kbox.corner_radius_top_left and dbox.bg_color == kbox.bg_color and dbox.border_color != kbox.border_color, "%s %s" % [dbox, kbox])
		var ratio := _contrast(del.get_theme_color(&"font_color"), kbox.bg_color if kbox != null else Color.BLACK)
		t.check("saves (%s): Delete it here too reads at 4.5:1 or better" % scheme, ratio >= 4.5, "%.2f font %s fill %s" % [ratio, del.get_theme_color(&"font_color"), kbox.bg_color])
		(st["vp"] as Node).free()
		await _frames(1)
	PKeyUiTheme.reset()
	PKeyUiTheme.reduce_motion_mode = "on"
	# Keeping offers nothing; kept names the choice and Done; failed focuses Cancel and Try again repeats.
	var keeping: PKeySaveConflict = _sc.save_conflict("keeping")
	await _frames(3)
	# `accessibility_live` is an engine 4.5 property; the floor has no such label state to check.
	if "accessibility_live" in keeping._status:
		var live := 0
		for n in keeping.find_children("*", "Label", true, false):
			live += 1 if int(n.get("accessibility_live")) != 0 else 0
		t.check("saves: keeping has exactly one live label, its status", live == 1 and int(keeping._status.get("accessibility_live")) == 1, str(live))
	var kb := _buttons(keeping)
	t.check("saves: while a choice is applied nothing is offered", kb.is_empty() and keeping._initial_focus() == null)
	await _tree().create_timer(0.4).timeout
	keeping._process(0.0)
	t.check("saves: while a choice is applied the busy bar shows with real width", keeping._loading_bar.visible and keeping._loading_bar.size.x > 20.0, str(keeping._loading_bar.size))
	var gate := [0]
	keeping.cancelled.connect(func() -> void: gate[0] += 1)
	keeping._cancel()
	t.check("saves: Escape does not take back a choice being applied", gate[0] == 0)
	_free(keeping)
	var kept: PKeySaveConflict = _sc.save_conflict("kept-remote")
	await _frames(3)
	var kd := _buttons(kept)
	var finished: Array = []
	kept.done.connect(func() -> void: finished.append(1))
	t.check("saves: kept titles itself with the choice that was made, and Done takes the focus", (kept.find_child("Title", true, false) as Label).text == "Kept the other version" and not (kept.find_child("Status", true, false) as Label).visible and kept._initial_focus() == kd["Done"] and kd.size() == 1)
	var mark := kept.find_child("Mark", true, false) as TextureRect
	t.check("saves: kept draws the success mark in the success colour above its title", mark.visible and mark.texture != null and mark.modulate == kept._success_colour() and mark.get_index() < (kept.find_child("Title", true, false) as Label).get_index(), str(mark.modulate))
	var both_kept: PKeySaveConflict = _sc.save_conflict("kept-both")
	await _frames(3)
	t.check("saves: keeping both says where the other version went", (both_kept.find_child("Title", true, false) as Label).text == "Kept both versions" and (both_kept.find_child("Status", true, false) as Label).text == "The other version is saved as a copy.")
	_free(both_kept)
	kept._cancel()
	t.check("saves: Escape on kept is Done", finished == [1])
	_free(kept)
	var failed: PKeySaveConflict = _sc.save_conflict("failed")
	await _frames(3)
	var fl := _buttons(failed)
	var again: Array = []
	failed.retry_requested.connect(func(k: String) -> void: again.append(k))
	(fl["TryAgain"] as Button).pressed.emit()
	t.check("saves: failed leaves both saves as they were, never says kept, and Try again repeats the choice", (failed.find_child("Status", true, false) as Label).text == PKeyUiView.catalog().format("saveConflict.failed", {}) and again == ["local"] and not (failed.model["copy"] as Array).has("saveConflict.keptLocal"))
	t.check("saves: failed focuses Cancel (the TV lands on a safe control) and Try again is not filled", failed._initial_focus() == fl["Cancel"] and (fl["TryAgain"] as Button).theme_type_variation != &"PKeyPrimary")
	var chosen: Array = []
	failed.choose_again_requested.connect(func() -> void: chosen.append(1))
	(fl["ChooseAgain"] as Button).pressed.emit()
	var primaries_failed := 0
	for n in fl.values():
		primaries_failed += 1 if (n as Button).theme_type_variation == &"PKeyPrimary" else 0
	t.check("saves: failed offers Try again, Choose again and Cancel in that order, none filled, and Choose again asks the host", chosen == [1] and primaries_failed == 0 and failed._actions.get_child(failed._actions.get_children().find(fl["TryAgain"]) + 1) == fl["ChooseAgain"] and _last_visible(failed._actions) == fl["Cancel"])
	_free(failed)
	var failed_gone: PKeySaveConflict = _sc.save_conflict("failed-deleted")
	await _frames(3)
	t.check("saves: failed after a deletion keeps the deletion's title and says the save is unchanged", (failed_gone.find_child("Title", true, false) as Label).text == "This save was deleted elsewhere" and (failed_gone.find_child("Status", true, false) as Label).text == "Couldn't keep your choice. Your save is unchanged.", (failed_gone.find_child("Title", true, false) as Label).text)
	_free(failed_gone)
	# Newer tags the named card and nothing else: no fill, no focus change, no reorder.
	var plain_choose: PKeySaveConflict = _sc.save_conflict("choose")
	var newer_remote: PKeySaveConflict = _sc.save_conflict("newer-remote")
	await _frames(3)
	var nl := newer_remote.find_child("Local", true, false) as Control
	var nr := newer_remote.find_child("Remote", true, false) as Control
	t.check("saves: Newer tags the other version's card only", not (nl.find_child("Newer", true, false) as Label).visible and (nr.find_child("Newer", true, false) as Label).visible and (nr.find_child("Newer", true, false) as Label).text == "Newer")
	var nb := _buttons(newer_remote)
	var pb := _buttons(plain_choose)
	var same := nb.keys() == pb.keys() and newer_remote._initial_focus().name == plain_choose._initial_focus().name
	for k in nb:
		same = same and (nb[k] as Button).theme_type_variation == (pb[k] as Button).theme_type_variation
	t.check("saves: Newer never fills, focuses or reorders anything", same and nl.get_index() < nr.get_index())
	_free(newer_remote)
	_free(plain_choose)
	var newer_gone: PKeySaveConflict = _sc.save_conflict("deleted")
	newer_gone.newer = "local"
	await _frames(3)
	t.check("saves: with one version there is no Newer tag", not (newer_gone.find_child("Local", true, false).find_child("Newer", true, false) as Label).visible and not (newer_gone.find_child("Remote", true, false).find_child("Newer", true, false) as Label).visible)
	_free(newer_gone)
	# TV focus: a pad only. The screen takes the focus onto Cancel, and a direction reaches the choices.
	PKeyUiView.pad_only_override = true
	var tv: PKeySaveConflict = _sc.save_conflict("choose")
	await _frames(4)
	tv.ensure_focus(true)
	await _frames(2)
	var owner := tv.get_viewport().gui_get_focus_owner()
	var tb := _buttons(tv)
	t.check("saves: on a TV the first focus lands on Cancel", owner == tb["Cancel"], str(owner))
	var up: Control = tb["Cancel"].get_node_or_null(tb["Cancel"].focus_neighbor_top)
	t.check("saves: a pad reaches the choices from Cancel", up == tb["KeepBoth"] or up == tb["KeepOther"])
	_free(tv)
	PKeyUiView.pad_only_override = null
	# The strip: a pending transfer is never synced, and a figure never replaces the label.
	var strip: PKeyCloudSyncStatus = _sc.cloud_sync("transferring")
	await _frames(3)
	var st := strip.find_child("Status", true, false) as Label
	var figs := strip.find_child("Figures", true, false) as Label
	t.check("strip: transferring says Syncing saves before its figures", st.text == "Syncing saves…" and figs.text == "38 MB of 61 MB" and strip._bar.visible and not strip._bar.indeterminate and is_equal_approx(strip._bar.value, 0.62), st.text)
	# One announcement per state change: the label is live, the figures are not, so a byte update is silent.
	if "accessibility_live" in st:
		t.check("strip: only the label is live", int(st.get("accessibility_live")) == 1 and int(figs.get("accessibility_live")) == 0)
	var said := st.text
	strip.transfer_size = "39 MB"
	strip.refresh_view()
	await _frames(2)
	t.check("strip: a byte update changes the figures and leaves the live label alone", st.text == said and figs.text == "39 MB of 61 MB", figs.text)
	t.check("strip: the bar has real width", strip._bar.size.x > 20.0, str(strip._bar.size))
	t.check("strip: transferring is never Synced, though the last sync time is known", not st.text.contains("Synced") and strip.sync_time != "" and not strip._action.visible)
	_free(strip)
	var plain: PKeyCloudSyncStatus = _sc.cloud_sync("transferring-plain")
	await _frames(3)
	t.check("strip: without figures the label stands alone and the bar runs", (plain.find_child("Status", true, false) as Label).text == "Syncing saves…" and plain._bar.visible and plain._bar.size.x > 20.0)
	_free(plain)
	var waiting: PKeyCloudSyncStatus = _sc.cloud_sync("waiting-battery")
	await _frames(3)
	t.check("strip: waiting names what it waits for, with no bar and no Synced", (waiting.find_child("Status", true, false) as Label).text == "Waiting for power" and not waiting._bar.visible and not waiting._action.visible)
	t.check("strip: waiting for power is the info glyph, not offline", waiting._glyph.get_meta(&"pkey_glyph") == "info")
	_free(waiting)
	var waiting_net: PKeyCloudSyncStatus = _sc.cloud_sync("waiting")
	await _frames(3)
	t.check("strip: waiting for a connection is the offline glyph", waiting_net._glyph.get_meta(&"pkey_glyph") == "cloud_off")
	_free(waiting_net)
	var waiting_bg: PKeyCloudSyncStatus = _sc.cloud_sync("waiting-background")
	await _frames(3)
	t.check("strip: waiting for the app is the info glyph, not offline", waiting_bg._glyph.get_meta(&"pkey_glyph") == "info")
	_free(waiting_bg)
	var bad: PKeyCloudSyncStatus = _sc.cloud_sync("transfer-failed")
	await _frames(3)
	var retried: Array = []
	bad.retry_requested.connect(func() -> void: retried.append(1))
	t.check("strip: a failed transfer says so and Try again is secondary", (bad.find_child("Status", true, false) as Label).text == "Couldn't sync your saves." and bad._action.text == "Try again" and bad._action.theme_type_variation == &"PKeyLink")
	t.check("strip: Try again lines up with the words", is_equal_approx(bad._action.global_position.x, bad._text.global_position.x), "%s %s" % [bad._action.global_position.x, bad._text.global_position.x])
	bad._action.pressed.emit()
	t.check("strip: Try again asks the game", retried == [1])
	_free(bad)


# ── The save screens bound to the saves (K.5T) ──────────────────────────────────────────────

## An open save request (S1) as a write that lost its compare-and-set leaves it: this device's copy is held in
## memory, the other is `deleted` or the server's version 3. `both` says a slot of the 16 is free.
static func _open_request(saves: PKeySaves, id: String, deleted := false, both := true) -> PKeyMergeRequest:
	var remote: Variant = null
	if not deleted:
		remote = {"id": id, "version": 3, "metadata": {"savedAt": 1760000000000, "deviceLabel": "Deck"}, "file": null, "newer_format": false}
	var request: PKeyMergeRequest = saves._open_slot({
		"id": id, "metadata": {"level": 4, "savedAt": 1760003600000}, "bytes": PackedByteArray([1, 2, 3]), "opts": {}, "base": 1,
		"remote": remote, "remote_version": "*" if deleted else 3, "slots_free": both,
	}, null if deleted else 3)
	saves.changed.emit()
	return request


func _saves() -> PKeySaves:
	# No engine: a write answers the typed unsupported refusal at once, and resolve(remote) pulls from an empty
	# records port (nothing to pull) and then settles.
	return PKeySaves.new({"supported": func() -> bool: return false, "records": EmptyRecords.new()})


func _held(saves: PKeySaves, id: String, progress: Dictionary) -> Array:
	## A write the test holds open: [handle, release Callable].
	var gate := {"open": false}
	var attempt := func(_soft: Variant, _hard: Variant) -> Dictionary:
		while not gate["open"]:
			await _tree().process_frame
		return {"state": "done", "id": id, "version": 1}
	var release := func() -> void: pass
	var tr: PKeyTransfer = saves._tracked(PKeyTransfer.start("saves:" + id, progress, attempt, release))
	return [tr, func() -> void: gate["open"] = true]


func _saves_binding(t: PKeyTestContext) -> void:
	TranslationServer.set_locale("en")
	var sizes := [0, 999, 1500, 38000000, 61000000].map(PKeySaveScreensHost.size_text)
	t.check("saves binding: sizes read as the strip words them", sizes == ["0 B", "999 B", "1.5 KB", "38 MB", "61 MB"], str(sizes))
	var sdk := _kit_sdk([{"state": "idle", "pending": 0}])
	var saves := _saves()
	sdk.cloud_sync.saves = saves
	var strip := PKeyCloudSyncStatus.new()
	strip.auto_sdk = false
	_tree().root.add_child(strip)
	await strip.follow(sdk)
	await _frames()
	t.check("saves binding: nothing moving leaves the host's own state", strip.state == "synced" and strip.saves_host != null)
	# A write moving: transferring, with the counted bytes; never synced.
	var progress := {"done": 38000000, "total": 61000000}
	var w := _held(saves, "slot1", progress)
	await _frames()
	var figures := "%s %s %s" % [strip.state, strip.transfer_size, strip.transfer_fraction]
	var counted: bool = strip.transfer_size == "38 MB" and strip.transfer_total == "61 MB"
	t.check("saves binding: a running write is transferring with its counted figures", strip.state == "transferring" and counted and absf(strip.transfer_fraction - 38.0 / 61.0) < 0.001, figures)
	progress["done"] = 50000000
	saves.changed.emit()
	await _frames()
	t.check("saves binding: the figures follow the bytes", strip.transfer_size == "50 MB")
	var empty := {"done": 0, "total": 0}
	progress["done"] = 61000000
	var w2 := _held(saves, "slot2", empty)
	await _frames()
	t.check("saves binding: two writes add up", strip.transfer_size == "61 MB" and strip.transfer_total == "61 MB")
	(w[1] as Callable).call()
	(w2[1] as Callable).call()
	await (w[0] as PKeyTransfer).wait()
	await (w2[0] as PKeyTransfer).wait()
	await _frames()
	t.check("saves binding: when the writes end the host's state stands again, figures cleared", strip.state == "synced" and strip.transfer_size == "" and strip.transfer_fraction < 0.0)
	# A write that fails: transfer-failed, until the next write starts.
	var failed := saves.write("slot1", PackedByteArray([1]), {})
	await failed.wait()
	await _frames()
	t.check("saves binding: a failed write is transfer-failed", strip.state == "transfer-failed" and saves.last_failed())
	var retried: Array = []
	strip.retry_requested.connect(func() -> void: retried.append(1))
	strip._action.pressed.emit()
	t.check("saves binding: Try again on the strip asks the game", retried == [1])
	var again := _held(saves, "slot1", {"done": 1, "total": 10})
	await _frames()
	t.check("saves binding: the next write clears the failure", strip.state == "transferring" and not saves.last_failed())
	(again[1] as Callable).call()
	await (again[0] as PKeyTransfer).wait()
	await _frames()
	# A conflict: the strip offers Review, and Review opens the bound screen.
	var slot1 := _open_request(saves, "slot1")
	await _frames()
	t.check("saves binding: a conflict is the strip's conflict with Review", strip.state == "conflict" and strip.can_review and saves.conflicts().size() == 1)
	strip._action.pressed.emit()
	await _frames(4)
	var screen: PKeySaveConflict = _find(PKeySaveConflict)
	var bound: bool = screen != null and screen.host != null and screen.visible
	t.check("saves binding: Review opens SaveConflict, bound, on the choose step", bound and screen.step == "choose" and screen.both_available and not screen.remote_deleted)
	t.check(
			"saves binding: the screen takes the dates, the device and which is newer from the request",
			screen.remote_device == "Deck" and screen.local_when != "" and screen.remote_when != "" and screen.local_when != screen.remote_when and screen.newer == "local",
			"%s | %s | %s" % [screen.local_when, screen.remote_when, screen.newer]
	)
	if screen == null:
		_free_strip(strip)
		_free_node(sdk)
		return
	var b := _buttons(screen)
	t.check("saves binding: nothing is the default on the bound screen", b.has("KeepThis") and b.has("KeepOther") and b.has("Cancel") and screen._initial_focus() == b["Cancel"])
	# Keep this version: the SDK holds the local copy, so nothing is asked of the game. Here the write cannot run
	# (the typed unsupported refusal): the choice fails, the request reopens with the failure, nothing is written.
	var host := PKeySaveScreensHost.of(sdk)
	(b["KeepThis"] as Button).pressed.emit()
	await _frames(6)
	t.check(
			"saves binding: keep this version that cannot be applied fails, says so and leaves the request open",
			screen.step == "failed" and screen.keep == "local" and saves.transfers().is_empty() and slot1.state == "open" and slot1.error == "unsupported",
			str(slot1.error)
	)
	b = _buttons(screen)
	t.check("saves binding: a failure offers Try again, Choose again and Cancel, none filled", b.has("TryAgain") or b.has("Retry") or screen._retry.visible)
	screen._retry.pressed.emit()
	await _frames(6)
	t.check(
			"saves binding: Try again repeats the choice and the result (here the typed unsupported refusal) is a failure, never a kept",
			screen.step == "failed" and screen.keep == "local" and slot1.state == "open"
	)
	screen._choose_again.pressed.emit()
	await _frames(3)
	t.check("saves binding: Choose again returns to the versions", screen.step == "choose" and screen.keep == "")
	# Keep the other version: needs no local copy, settles at once, and kept reads after the saves forgot it.
	b = _buttons(screen)
	(b["KeepOther"] as Button).pressed.emit()
	await _frames(6)
	t.check("saves binding: keep the other version is kept, and the conflict is settled", screen.step == "kept" and screen.keep == "remote" and saves.conflicts().is_empty())
	t.check("saves binding: kept still shows its result after the saves forgot the conflict", screen.visible and screen.model.get("state") == "kept")
	t.check("saves binding: the strip is no longer in conflict", strip.state == "synced")
	screen._done_button.pressed.emit()
	await _frames(4)
	t.check("saves binding: Done closes the screen", _find(PKeySaveConflict) == null and host.conflict() == null)
	# Cancel leaves the conflict as it is (dismissed from the strip, both copies untouched).
	_open_request(saves, "slot9", true, false)
	await _frames()
	strip._action.pressed.emit()
	await _frames(4)
	var gone: PKeySaveConflict = _find(PKeySaveConflict)
	var variant: bool = gone != null and gone.remote_deleted and not gone.both_available
	t.check("saves binding: a deleted other copy is the deleted variant, with no Keep both", variant and gone.model.get("state") == "choose")
	gone.cancelled.emit()
	await _frames(4)
	t.check("saves binding: Cancel drops the conflict without settling it", _find(PKeySaveConflict) == null and saves.conflicts().is_empty() and strip.state == "synced")
	# Keep both with no free slot: refused, a failure, nothing written.
	_open_request(saves, "slot2", false, false)
	await _frames()
	await host.choose("both")
	t.check("saves binding: keep both with every slot in use fails", host.step == "failed" and host.keep == "both")
	host.cancel()
	# A request a later exact write superseded is gone.
	_open_request(saves, "slot3", true)
	t.check("saves binding: an open request is listed", saves.conflicts().size() == 1)
	saves.write("slot3", PackedByteArray([9]), {}, {"base_version": 3})
	t.check("saves binding: a later write with a base supersedes it", saves.conflicts().is_empty())
	# Not following: the screen is the host's to drive, and it is not hidden by the saves.
	var manual := PKeySaveConflict.new()
	manual.auto_sdk = false
	manual.follow_sdk = false
	manual.step = "choose"
	_tree().root.add_child(manual)
	await _frames(3)
	t.check("saves binding: without follow_sdk the screen is drawn from its properties", manual.host == null and manual.visible and manual.model.get("state") == "choose")
	_free(manual)
	_free_strip(strip)
	host.stop()
	_free_node(sdk)
