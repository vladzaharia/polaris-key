extends RefCounted
# @pkey-feature ui.kit
# The Cloud Sync screens (U-42.5): UnlockSync, RecoveryCode, RingChange and the CloudSyncStatus
# `locked` and `ring-changed` rows. The corpus rows run in suite_ui_core, the structural snapshots
# in suite_ui, and the layout at every size in suite_ui_matrix; this suite pins what those cannot
# see: the key ring calls the screens make (over a fake ring, never a network), the answers that
# route to start over, the recovery code drawn in whole groups and never kept, a destructive Start
# over that reads in every look, a confirm that arms after a beat and a first focus that is Cancel.
#
#   godot --headless --path sdks/godot -- --pkey-test cloud_sync_ui

const SCENARIOS := preload("res://tests/ui/scenarios.gd")
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


## `PolarisKey.cloud_sync`, scripted: `status()` answers the queued status (the last one repeats);
## `flush()` is counted.
class FakeCloud extends RefCounted:
	var states: Array = []
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
	t.check("groups_of: spaces, hyphens and one long run all regroup the same", PKeyCloudSyncController.groups_of("ab3d 9fgh-JK4M NP5QRS6TVW7XYZ801C2E") == PackedStringArray(["ab3d", "9fgh", "JK4M", "NP5Q", "RS6T", "VW7X", "YZ80", "1C2E"]))
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
	t.check("controller: an accept that answers ring-changed again is a failure", not again.ok)
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "unlocked"}))
	t.check("controller: an accept that opened the ring is ok, with exactly the served ring", (await PKeyCloudSyncController.accept(sdk, RING)).ok and ring.calls[ring.calls.size() - 1][1][0] == RING)
	ring.queue("unlock", PKeyResult.success({"kind": "locked", "reason": "no-ring"}))
	ring.queue("create", PKeyResult.success({"recovery_code": CODE}))
	var made := await PKeyCloudSyncController.begin(sdk)
	t.check("controller: locked with no ring is the create path and shows the new code", made["screen"] == "recovery_code" and made["code"] == CODE and ring.calls[ring.calls.size() - 1][0] == "create", str(made.keys()))
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
	t.check("unlock: the warning lists Start over first and Cancel last", sb.has("ConfirmStartOver") and sb.has("Cancel") and not sb.has("Primary") and v._actions.get_child(0) == sb["ConfirmStartOver"] and _last_visible(v._actions) == sb["Cancel"])
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
	t.check("unlock: a failed start over is its own step with its own line", sof.step == "start-over-failed" and (sof.find_child("Warning", true, false) as Label).text.begins_with("Couldn't start over"), sof.step)
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
	var spoken := String(grid.get("accessibility_name"))
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
	t.check("ring: Use recovery code, That was me, Cancel, in that order", b.has("UseCode") and b.has("Accept") and b.has("Cancel") and v._actions.get_child(0) == b["UseCode"] and _last_visible(v._actions) == b["Cancel"])
	t.check("ring: the primary is the recovery code and takes the first focus", v._initial_focus() == b["UseCode"])
	t.check("ring: the device is named", (v.find_child("BodyText", true, false) as Label).text.contains("Maya"), (v.find_child("BodyText", true, false) as Label).text)
	# Accept hands exactly the served ring over.
	ring.queue("accept_ring_change", PKeyResult.success({"kind": "unlocked"}))
	var ok: Array = []
	v.accepted.connect(func() -> void: ok.append(1))
	(b["Accept"] as Button).pressed.emit()
	await _frames(4)
	t.check("ring: That was me passes the ring that was shown", ring.calls.size() == 1 and ring.calls[0][1][0] == RING and ok.size() == 1, str(ring.calls))
	# A failed accept says so and Accept stays.
	ring.queue("accept_ring_change", _fail("network-error"))
	(_buttons(v)["Accept"] as Button).pressed.emit()
	await _frames(4)
	t.check("ring: a failed accept says so and keeps Accept", v.failed and (v.find_child("Error", true, false) as Label).visible and _buttons(v).has("Accept"))
	_free(v)
	var none: PKeyRingChange = _sc.ring_change("nothing served")
	await _frames()
	t.check("ring: nothing served, nothing to accept", not _buttons(none).has("Accept") and _buttons(none).has("UseCode"))
	_free(none)
	var anon: PKeyRingChange = _sc.ring_change("no device named")
	await _frames()
	t.check("ring: no device named reads neutrally", not (anon.find_child("BodyText", true, false) as Label).text.contains("Maya") and (anon.find_child("BodyText", true, false) as Label).text.begins_with("A device"))
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
	t.check("strip: the code unlocks, the screen goes, the queue flushes and the row redraws", _find(PKeyUnlockSync) == null and strip.host.screen == "" and sdk.cloud_sync.flushes == 1 and strip.state == "synced", "%s %s %s %s" % [_find(PKeyUnlockSync), strip.host.screen, sdk.cloud_sync.flushes, strip.state])
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
	t.check("strip: accepting hands over exactly that ring and closes the screen", ring.calls.any(func(c: Array) -> bool: return c[0] == "accept_ring_change" and c[1][0] == RING) and _find(PKeyRingChange) == null and strip.state == "synced", "%s %s %s" % [_find(PKeyRingChange), strip.state, ring.calls])
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
