extends RefCounted
# @pkey-feature ui.kit.holders
# The holder scenes (UK-43.13): PKeyActivateDone and PKeyAddToAccount. The structural snapshots, the
# focus walks, the copy and header checks and the layout at every size are suite_ui's and
# suite_ui_matrix's (tests/ui/scenarios.gd, `activate_done` and `add_to_account`). This pins what
# those cannot see: the lead-in drawn run by run and never parsed, the email keyboard, which control
# takes the first focus, what Escape does, the problem lines' live regions, the primary's
# accessibility description, and what a busy card offers.
#
#   godot --headless --path sdks/godot -- --pkey-test ui_holders

const SCENARIOS := preload("res://tests/ui/scenarios.gd")

var _sc


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	_sc = SCENARIOS.new()
	TranslationServer.set_locale("en")
	PKeyUiTheme.reset()
	PKeyUiTheme.use_presentation(null)
	PKeyUiTheme.product_name = ""
	PKeyUiTheme.reduce_motion_mode = "on"
	PKeyUiView.mobile_override = false
	PKeyUiView.pad_only_override = false
	_rich_line(t)
	await _activate_done(t)
	await _add_to_account(t)
	PKeyUiView.mobile_override = null
	PKeyUiView.pad_only_override = null
	PKeyUiTheme.reset()
	return true


static func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _settle() -> void:
	for i in 3:
		await _tree().process_frame


static func _free(v: Node) -> void:
	v.get_parent().remove_child(v)
	v.free()


static func _node(v: Node, node_name: String) -> Control:
	return v.find_child(node_name, true, false) as Control


static func _text(v: Node, node_name: String) -> String:
	return (_node(v, node_name) as Label).text


static func _btn(v: Node, node_name: String) -> Button:
	return _node(v, node_name) as Button


static func _desc(b: Button) -> String:
	return str(b.get("accessibility_description"))


## Control.accessibility_description arrived in Godot 4.5; the kit sets it only where it exists, so a
## check about the description holds on an older engine by there being nothing to describe.
static func _a11y(b: Button, ok: bool) -> bool:
	return not ("accessibility_description" in b) or ok


static func _shown(v: Node, node_name: String) -> bool:
	var c := _node(v, node_name)
	return c != null and c.is_visible_in_tree()


# ── The lead-in ──────────────────────────────────────────────────────────────────────────

## `**lead**` is drawn bold run by run; the text is never a markup string.
func _rich_line(t: PKeyTestContext) -> void:
	var line := PKeyRichLine.new()
	_tree().root.add_child(line)
	line.show_lead("**Get your license back** if you lose the key")
	t.check("rich line: the markers are not drawn", line.plain() == "Get your license back if you lose the key", line.plain())
	t.check("rich line: bbcode is off", not line.bbcode_enabled)
	line.show_lead("**[b]Sync[/b]** [color=red]across[/color] devices")
	t.check("rich line: brackets in the text are drawn as typed", line.plain() == "[b]Sync[/b] [color=red]across[/color] devices", line.plain())
	line.show_lead("")
	t.check("rich line: no text hides it", not line.visible)
	line.show_lead("No lead-in at all")
	t.check("rich line: text with no marker is one plain run", line.plain() == "No lead-in at all")
	t.check("rich line: it takes no focus and no pointer", line.focus_mode == Control.FOCUS_NONE and line.mouse_filter == Control.MOUSE_FILTER_IGNORE)
	line.free()


# ── ActivateDone ─────────────────────────────────────────────────────────────────────────

func _activate_done(t: PKeyTestContext) -> void:
	var d: PKeyActivateDone = await _sc.activate_done("ready")
	await _settle()
	var primary := _node(d, "Primary") as Button
	t.check("done: one filled control, Start using", primary.visible and primary.theme_type_variation == &"PKeyPrimary" and primary.text.begins_with("Start using"), primary.text)
	var filled := 0
	for b in d.find_children("*", "Button", true, false):
		if b.is_visible_in_tree() and (b as Button).theme_type_variation == &"PKeyPrimary":
			filled += 1
	t.check("done: skipping is a line, never a second filled control", filled == 1 and _shown(d, "Skip"))
	var reasons: Array = d.find_children("Line", "PKeyRichLine", true, false).filter(func(l): return l.is_visible_in_tree())
	t.check("done: the three reasons, drawn by PKeyRichLine", reasons.size() == 3, str(reasons.size()))
	t.check("done: a reason's lead-in has no markers", reasons.all(func(l): return not (l as PKeyRichLine).plain().contains("**")))
	t.check("done: initial focus is Start using", d._initial_focus() == primary)
	t.check("done: the primary reads the title and the device line", _a11y(primary, _desc(primary) == "%s. %s" % [_text(d, "Title"), _text(d, "Device")]), _desc(primary))
	t.check("done: Escape is left for the game", not d._cancel())
	var starts := [0]
	d.start_pressed.connect(func(): starts[0] += 1)
	primary.pressed.emit()
	t.check("done: Start using is emitted", starts[0] == 1)
	d.busy = true
	await _settle()
	t.check("done: a busy card has no actions", not _shown(d, "Actions") and not _shown(d, "Add") and not _shown(d, "Primary"))
	t.check("done: a busy card takes no focus", d._initial_focus() == null and d.focus_order().is_empty())
	primary.pressed.emit()
	t.check("done: a press while busy is ignored", starts[0] == 1)
	t.check("done: a busy card has no description to carry", _a11y(primary, _desc(primary) == ""))
	d.busy = false
	d.holder_email = "maya@example.com"
	await _settle()
	var waiting_line := _text(d, "Waiting")
	t.check("done: waiting names the email masked, never in full", waiting_line.contains("m•••@example.com") and not waiting_line.contains("maya@"), waiting_line)
	t.check("done: the description follows the step", _a11y(primary, _desc(primary).contains(waiting_line)))
	t.check("done: waiting has Sign in as the quiet action", _shown(d, "SignIn") and not _shown(d, "Add"))
	d.license_on = false
	await _settle()
	t.check("done: License off hides it, and the description with it", not d.visible and _a11y(primary, _desc(primary) == ""))
	_free(d)

	d = await _sc.activate_done("ready")
	d.no_add_action = true
	await _settle()
	t.check("done: with no Add action the card and the skip line are gone", not _shown(d, "Recommend") and not _shown(d, "Skip") and not _shown(d, "Add") and _shown(d, "Primary"))
	_free(d)

	d = await _sc.activate_done("ready")
	d.no_add_action = true
	await _settle()
	t.check("done: with no Add action the card and the skip line are gone", not _shown(d, "Recommend") and not _shown(d, "Skip") and not _shown(d, "Add") and _shown(d, "Primary"))
	_free(d)

	d = await _sc.activate_done("ready, the device line unknown")
	await _settle()
	t.check("done: the device line is left out while a part is unknown", not _shown(d, "Device"))
	_free(d)

	d = await _sc.activate_done("ready, back from the browser")
	await _settle()
	t.check("done: back from the browser, focus returns to Add", d._initial_focus() == _node(d, "Add"))
	_free(d)

	d = await _sc.activate_done("ready, no in-app channel")
	await _settle()
	var add := _node(d, "Add") as Button
	var opens_locker := add.text.begins_with("Add it in Polaris Locker") and add.icon != null and _a11y(add, _desc(add) != "")
	t.check("done: no in-app channel, Add opens Polaris Locker and says so", opens_locker, add.text)
	d.add_in = "app"
	await _settle()
	t.check("done: the in-app Add has no new-window glyph or note", add.icon == null and _a11y(add, _desc(add) == ""))
	_free(d)

	d = await _sc.activate_done("ready, Identity off")
	await _settle()
	var reasons_off: Array = d.find_children("Line", "PKeyRichLine", true, false).filter(func(l): return l.is_visible_in_tree())
	t.check("done: Identity off, one reason that opens Polaris Locker", reasons_off.size() == 1 and (_node(d, "Add") as Button).text.begins_with("Add it in"), str(reasons_off.size()))
	_free(d)

	d = await _sc.activate_done("ready, no Cloud Sync")
	await _settle()
	var reasons_nosync: Array = d.find_children("Line", "PKeyRichLine", true, false).filter(func(l): return l.is_visible_in_tree())
	t.check("done: no Cloud Sync line without Cloud Sync", reasons_nosync.size() == 2 and not reasons_nosync.any(func(l): return (l as PKeyRichLine).plain().contains("Sync")))
	_free(d)

	# A developer name that holds markup is drawn as typed.
	d = await _sc.activate_done("ready")
	d.developer = "[b]Mallory[/b]"
	await _settle()
	var lines: Array = d.find_children("Line", "PKeyRichLine", true, false).filter(func(l): return l.is_visible_in_tree())
	t.check("done: a developer name with brackets is drawn as typed", lines.any(func(l): return (l as PKeyRichLine).plain().contains("[b]Mallory[/b]")))
	_free(d)


# ── AddToAccount ─────────────────────────────────────────────────────────────────────────

func _add_to_account(t: PKeyTestContext) -> void:
	var a: PKeyAddToAccount = await _sc.add_to_account("form")
	await _settle()
	var name_input := _node(a, "NameInput") as LineEdit
	var email_input := _node(a, "EmailInput") as LineEdit
	var primary := _node(a, "Primary") as Button
	t.check("add: Email opens the mail keyboard", email_input.virtual_keyboard_type == LineEdit.KEYBOARD_TYPE_EMAIL_ADDRESS)
	t.check("add: Name opens the plain keyboard", name_input.virtual_keyboard_type == LineEdit.KEYBOARD_TYPE_DEFAULT)
	t.check("add: neither field hides what is typed", not name_input.secret and not email_input.secret)
	a.set_values("Ada Lovelace", "ada@example.com")
	t.check("add: the typed values are not in the model's input", not JSON.stringify(a.input()).contains("Ada") and not JSON.stringify(a.input()).contains("ada@"))
	var sent := []
	a.submitted.connect(func(n: String, e: String): sent.append([n, e]))
	email_input.text_submitted.emit(email_input.text)
	t.check("add: Enter in Email submits both values", sent == [["Ada Lovelace", "ada@example.com"]], str(sent.size()))
	primary.pressed.emit()
	t.check("add: Continue submits too", sent.size() == 2)
	t.check("add: initial focus is Name on a desktop", a._initial_focus() == name_input)
	t.check("add: the primary reads the title and the first line", _a11y(primary, _desc(primary) == "%s. %s" % [_text(a, "Title"), _text(a, "Lede")]), _desc(primary))
	var cancels := [0]
	a.cancelled.connect(func(): cancels[0] += 1)
	t.check("add: Escape leaves a form with nothing in flight", a._cancel() and cancels[0] == 1)
	PKeyUiView.mobile_override = true
	a.refresh_view()
	t.check("add: a phone's first focus is still the top of the form, in view", a._initial_focus() == name_input)
	PKeyUiView.mobile_override = false
	PKeyUiView.pad_only_override = true
	a.refresh_view()
	t.check("add: on a pad the first focus is Continue", a._initial_focus() == primary)
	PKeyUiView.pad_only_override = false
	_free(a)

	# invalid: the danger tone, a polite live region, the first wrong field.
	a = await _sc.add_to_account("invalid: email")
	await _settle()
	var err := _node(a, "EmailError") as Label
	t.check("add: a problem line is in the danger tone", err.visible and err.theme_type_variation == &"PKeyError", err.text)
	t.check("add: ... and a polite live region", not ("accessibility_live" in err) or int(err.get("accessibility_live")) == 1)
	var email_mark := (_node(a, "EmailInput") as LineEdit).theme_type_variation == &"PKeyFieldError"
	var name_mark := (_node(a, "NameInput") as LineEdit).theme_type_variation == &"PKeyFieldError"
	t.check("add: the wrong field is marked, the right one is not", email_mark and not name_mark)
	t.check("add: focus goes to the first wrong field", a._initial_focus() == _node(a, "EmailInput"))
	a.step = "form"
	await _settle()
	t.check("add: the line clears with the step", not _shown(a, "EmailError"))
	_free(a)

	a = await _sc.add_to_account("invalid: both")
	await _settle()
	t.check("add: both lines show, the first wrong field has the focus", _shown(a, "NameError") and _shown(a, "EmailError") and a._initial_focus() == _node(a, "NameInput"))
	_free(a)

	# busy: nothing to press but the ways out; no focus; read-only; Escape never cancels the work.
	a = await _sc.add_to_account("busy")
	await _settle()
	a.set_values("Ada", "ada@example.com")
	t.check("add: a busy card hides Continue and shows Working", not _shown(a, "Primary") and _shown(a, "Status"))
	t.check("add: a busy card's fields are read-only", not (_node(a, "NameInput") as LineEdit).editable and not (_node(a, "EmailInput") as LineEdit).editable)
	t.check("add: a busy card takes no focus by itself", a._initial_focus() == null and not a.ensure_focus(true))
	var c2 := [0]
	a.cancelled.connect(func(): c2[0] += 1)
	t.check("add: Escape does nothing while the sign-in runs", a._cancel() and c2[0] == 0)
	t.check("add: no description rides on a hidden primary", _a11y(_node(a, "Primary") as Button, _desc(_node(a, "Primary") as Button) == ""))
	a.step = "invalid"
	await _settle()
	t.check("add: the fields can be edited again afterwards", (_node(a, "NameInput") as LineEdit).editable)
	_free(a)

	# waiting: the code, and the forward action is to open Polaris Locker again.
	a = await _sc.add_to_account("waiting")
	await _settle()
	var code := _node(a, "Code") as Label
	t.check("add: waiting shows the code", code.visible and code.text == "WDJB-MJHT")
	t.check("add: the code is named for a screen reader", not ("accessibility_name" in code) or str(code.get("accessibility_name")).contains("WDJB-MJHT"))
	t.check("add: the first focus is Open Polaris Locker again, never Cancel", a._initial_focus() == _node(a, "Second") and (_node(a, "Second") as Button).text.begins_with("Open Polaris Locker"))
	var c3 := [0]
	a.cancelled.connect(func(): c3[0] += 1)
	t.check("add: Escape does nothing while waiting", a._cancel() and c3[0] == 0)
	_free(a)

	# waiting on a TV: no browser opened, so one line says where to go and the QR sits with the text.
	PKeyUiView.pad_only_override = true
	a = await _sc.add_to_account("waiting")
	a.address = "https://polarislocker.com/link"
	a.link = "https://polarislocker.com/link?code=WDJB-MJHT"
	await _settle()
	var tv_ok := _text(a, "Check").begins_with("On any phone or computer") and not _shown(a, "Address")
	t.check("add: a TV's wait says where to go, with no second address or caption", tv_ok and not _shown(a, "QrCaption"), _text(a, "Check"))
	t.check("add: a TV's QR is left with the text column", a._qr.get_parent().size_flags_horizontal == Control.SIZE_SHRINK_BEGIN)
	_free(a)
	PKeyUiView.pad_only_override = false

	# failed: the problem line with its glyph.
	a = await _sc.add_to_account("failed")
	await _settle()
	var problem := _node(a, "Problem") as Label
	var polite := not ("accessibility_live" in problem) or int(problem.get("accessibility_live")) == 1
	t.check("add: a failure is a danger-tone live line with a glyph", problem.visible and problem.theme_type_variation == &"PKeyError" and polite)
	t.check("add: failed focuses Try again", a._initial_focus() == _node(a, "Primary") and (_node(a, "Primary") as Button).text == "Try again")
	var retries := [0]
	a.retry_pressed.connect(func(): retries[0] += 1)
	(_node(a, "Primary") as Button).pressed.emit()
	t.check("add: Try again is emitted", retries[0] == 1)
	_free(a)

	# The outcomes: one way on each, the description cleared by the next step.
	a = await _sc.add_to_account("owned")
	await _settle()
	var owned_desc := _desc(_node(a, "Primary") as Button)
	t.check("add: owned reads its title and line on the primary", _a11y(_node(a, "Primary") as Button, owned_desc.begins_with((_node(a, "Title") as Label).text)))
	a.step = "added"
	await _settle()
	var added_primary := _btn(a, "Primary")
	t.check("add: added closes with Start using and draws the mark", _shown(a, "Mark") and added_primary.text.begins_with("Start using") and _a11y(added_primary, _desc(added_primary) != owned_desc))
	_free(a)

	a = await _sc.add_to_account("added, from Settings")
	await _settle()
	t.check("add: from Settings added closes with Done", (_node(a, "Primary") as Button).text == "Done")
	_free(a)

	a = await _sc.add_to_account("email-bound")
	await _settle()
	var bound_ok := _btn(a, "Primary").text == "Verify that email" and _shown(a, "Second") and _btn(a, "Second").text == "Use another account"
	t.check("add: email-bound has Verify as the primary and Use another account beside it", bound_ok)
	t.check("add: email-bound names the email masked", (_node(a, "Lede") as Label).text.contains("m•••@example.com"))
	_free(a)

	a = await _sc.add_to_account("other-account")
	await _settle()
	t.check("add: other-account says both emails masked and offers Try again", (_node(a, "Lede") as Label).text.contains("j•••@example.com") and (_node(a, "Primary") as Button).text == "Try again")
	_free(a)

	# The model's snapshot drives the scene, and the typed values never come back out of it.
	a = await _sc.add_to_account("form")
	a.apply_snapshot({"step": "busy", "field": "", "typed_email": "", "signed_email": "", "name": "Ada", "email": "ada@example.com", "user_code": "WDJB-MJHT"})
	await _settle()
	t.check("add: a snapshot with a code is the waiting view", String(a.model.get("state")) == "waiting")
	a.apply_snapshot({"step": "invalid", "field": "name", "name": "", "email": "", "user_code": ""})
	await _settle()
	t.check("add: a snapshot's field picks the wrong field", String(a.model.get("state")) == "invalid" and _shown(a, "NameError") and not _shown(a, "EmailError"))
	_free(a)
