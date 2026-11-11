class_name PKeyLocalPairing
extends PKeyUiView
## Pair with a Code (ui-matrix `local`; ui-core's `local_pairing_view`): two devices of one app on one
## network pair in by an 8-digit code or a QR, with no account. One device shows a code, the other
## types it, and both people say yes. The steps are the model's (`PKeyLocalPairingModel`):
##
##   choose, opening, show, closed, enter, joining, confirm, waiting, paired, failed, network-blocked,
##   off
##
## Two ways to use it:
##   - driven: `attach(links, options)` over `PolarisKey.cloud_connect.local_links` (or a double). The
##     scene runs the whole flow, withdraws any code it showed when it leaves the tree and emits
##     `closed` when the person leaves;
##   - plain: `apply_snapshot(snapshot)` draws a state the host computed, and `action_pressed`,
##     `entry_edited` and `name_edited` tell the host what the person did.
##
## Rules this scene keeps (UI-KITS 4.3, LocalPairing):
##   - one method per screen: the show step has two views of the same open window and never shows the
##     eight digits and the QR together. The code view (the default) has the digits, the expiry ring
##     and the waiting line; the QR view has the QR, the ring and the waiting line and no digits. Each
##     has Cancel and one quiet link to the other; switching does not renew the code, and a renewal
##     updates whichever view is open. After a switch focus moves to the new view's heading (for a
##     screen reader) or its first control, never the link. The field has no code under it;
##   - the code is the largest text on its view, lit where it changed; the QR sits beside the time and
##     the waiting line in a window 600 wide or more and under them otherwise, and a window under
##     480 tall collapses the product header to one line so nothing scrolls;
##   - the categories come before Pair, so pressing Pair is the person's yes;
##   - Pair is drawn unavailable (never disabled, so focus and its reason stay reachable): a press
##     answers why under the field and sends nothing;
##   - the first focus on the prompt is Not now, Pair ignores presses for 250 ms after the prompt
##     appears and is never the default, and a pad's B or Escape is Not now;
##   - a name the other device sent is isolated text, drawn whole.
##
## The QR is drawn by one swappable node: `visual_factory` answers a Control with `present(payload)`
## and `set_side(px)` (PKeyPairVisual is the plain QR).

## Every press, by the copy key of its control (`localPairing.pair`, `common.cancel`, ...).
signal action_pressed(key: String)
## The code field changed (what the person typed).
signal entry_edited(text: String)
## The name field of the paired screen changed.
signal name_edited(text: String)
## Open the platform's settings (the network-blocked screen).
signal open_settings_requested
## Open Paired devices (the No room notice, and a pairing kept switched off).
signal paired_devices_requested
## The person left: Close, Done, Cancel on the entry, or Escape there. The host closes the screen.
signal closed

const Models := preload("res://addons/polaris_key/ui/model/models.gd")
const Local := preload("res://addons/polaris_key/ui/model/local.gd")
const Context := preload("res://addons/polaris_key/ui/model/context.gd")

## The two views of the show step switch with one quiet link each. The kit copy has no strings for
## them yet (UK-67.1 adds them), so these are the closest existing keys; the wanted strings are
## "Show a QR code" and "Show the code instead", and a body for each view ("Enter this code on the
## other device." and "Scan this with the other device's camera.").
const TO_QR_KEY := "part.qr.scanInstead"
const TO_CODE_KEY := "localPairing.toShow"

## How faint a control drawn unavailable is (it is never disabled).
const UNAVAILABLE_ALPHA := 0.55

## The name each category goes by on screen, by id; an id without one is drawn as it is.
var category_labels: Dictionary = {}
## `func() -> Control` that answers the node drawing the QR (see the header); empty uses PKeyPairVisual.
## Setting it swaps the node at once.
var visual_factory: Callable = Callable():
	set(value):
		visual_factory = value
		if _right != null:
			var old := _visual
			_visual = (
				visual_factory.call() as Control
				if visual_factory.is_valid()
				else PKeyPairVisual.new()
			)
			_right.add_child(_visual)
			_right.move_child(_visual, old.get_index())
			_right.remove_child(old)
			old.free()
			refresh_view()
## How long (ms) Pair on the prompt ignores presses after the prompt appears.
var guard_msec := 250
## `func() -> int` milliseconds (tests); empty uses the engine's tick count.
var ticks_source: Callable = Callable()
## Connect is off: the scene is hidden.
var connect_on := true:
	set(value):
		connect_on = value
		refresh_view()

## The view of the state drawn now.
var model: Dictionary = {}
## The driven model, or null in plain mode.
var flow: PKeyLocalPairingModel = null

var _snap: Dictionary = {"step": "choose"}
var _body: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _lede: Label
var _stage: BoxContainer
var _left: VBoxContainer
var _right: VBoxContainer
var _code_block: VBoxContainer
var _code: PKeyPairCode
var _time_row: HBoxContainer
var _ring: PKeyTimeRing
var _time: Label
var _visual: Control
var _live: VBoxContainer
var _notice: PKeyPairNotice
var _waiting: Label
var _field: VBoxContainer
var _field_label: Label
var _entry: LineEdit
var _field_error: Label
var _field_hint: Label
var _shares: VBoxContainer
var _shares_head: Label
var _shares_list: Label
var _name_block: VBoxContainer
var _name_label: Label
var _name_edit: LineEdit
var _name_error: Label
var _name_hint: Label
var _spacer: Control
var _actions: BoxContainer
var _buttons: Array = []
var _links_row: BoxContainer
var _links: Array = []
var _prev_state := ""
var _prev_rotation := 0
var _prev_view := "code"
## Whether the quiet links stack in a pane (the show step's do, where the pane is narrow).
var _stack_links := true
var _confirm_since := 0
var _layout: Dictionary = {}


func _build() -> void:
	name = "PKeyLocalPairing"
	_body = vbox(card_panel(), "Body", "PKeySections")
	var top := vbox(_body, "Top", "PKeyStack")
	_product = product_header(top, "Product")
	_product.card = true
	var words := vbox(top, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_title.focus_mode = PKeyPairCode.accessibility_focus() as Control.FocusMode
	_lede = label(words, "Lede", "PKeyMuted")
	_stage = columns(top, "Stage")
	_stage.set_meta(AUTO_HIDE_META, true)
	_left = vbox(_stage, "Left", "PKeyStack")
	_code_block = vbox(_left, "CodeBlock", "PKeyTight")
	_code = PKeyPairCode.new()
	_code_block.add_child(_code)
	_time_row = hbox(_code_block, "TimeRow")
	_ring = PKeyTimeRing.new()
	_time_row.add_child(_ring)
	_time = label(_time_row, "Time", "PKeyMuted")
	_time.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_field = vbox(_left, "Field", "PKeyTight")
	_field_label = label(_field, "FieldLabel", "PKeyStrong")
	_entry = _line_edit(_field, "Entry", LineEdit.KEYBOARD_TYPE_NUMBER)
	# Its placeholder is catalog text, already in the running locale.
	_entry.set_meta(CATALOG_META, true)
	_entry.text_changed.connect(_on_entry_changed)
	_entry.text_submitted.connect(func(_t: String) -> void: _press("localPairing.pair"))
	_field_error = _live_label(_field, "FieldError", "PKeyError")
	_field_hint = _live_label(_field, "FieldHint", "PKeyMuted")
	_name_block = vbox(_left, "NameField", "PKeyTight")
	_name_label = label(_name_block, "NameLabel", "PKeyStrong")
	_name_edit = _line_edit(_name_block, "NameEdit", LineEdit.KEYBOARD_TYPE_DEFAULT)
	_name_edit.max_length = Local.MAX_NAME
	_name_edit.set_meta(DATA_META, true)
	_name_edit.text_changed.connect(_on_name_changed)
	_name_edit.text_submitted.connect(func(_t: String) -> void: _press("common.done"))
	_name_error = _live_label(_name_block, "NameError", "PKeyError")
	_name_hint = label(_name_block, "NameHint", "PKeyMuted")
	_right = vbox(_stage, "Right", "PKeyStack")
	_visual = (
		visual_factory.call() as Control if visual_factory.is_valid() else PKeyPairVisual.new()
	)
	_right.add_child(_visual)
	_shares = vbox(_right, "Shares", "PKeyTight")
	_shares_head = label(_shares, "SharesHead", "PKeyStrong")
	_shares_list = label(_shares, "SharesList", "")
	_shares_list.set_meta(DATA_META, true)
	_live = vbox(_left, "Live", "PKeyStack")
	_notice = PKeyPairNotice.new()
	_live.add_child(_notice)
	_notice.action_pressed.connect(_on_notice_action)
	_waiting = label(_live, "Waiting", "PKeyMuted")
	_spacer = spacer(_body)
	_actions = actions_row(_body, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	for i in 3:
		_buttons.append(button(_actions, "Button%d" % i, Callable()))
		(_buttons[i] as Button).pressed.connect(_on_button.bind(i))
		(_buttons[i] as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_links_row = actions_row(_body, "Links", BoxContainer.ALIGNMENT_BEGIN)
	for i in 2:
		_links.append(button(_links_row, "Link%d" % i, Callable(), "PKeyLink"))
		(_links[i] as Button).pressed.connect(_on_link.bind(i))
		(_links[i] as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


func _line_edit(parent: Node, node_name: String, keyboard: int) -> LineEdit:
	var le := LineEdit.new()
	le.name = node_name
	le.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	le.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	le.virtual_keyboard_type = keyboard as LineEdit.VirtualKeyboardType
	le.caret_blink = true
	# Enter submits; the field stays in edit mode, so a correction typed next is not lost.
	le.keep_editing_on_text_submit = true
	le.context_menu_enabled = true
	parent.add_child(le)
	return le


func _live_label(parent: Node, node_name: String, variation: String) -> Label:
	var l := label(parent, node_name, variation)
	if "accessibility_live" in l:
		l.set("accessibility_live", 1)
	return l


func _bleeds() -> bool:
	return true


func _opens_at_top() -> bool:
	return true


func squeeze_max() -> int:
	return 4


func ring_inset() -> float:
	return roundf(RING_PAD * float(layout_metrics().get("scale", 1.0)))


func _exit_tree() -> void:
	if flow != null:
		flow.dispose()


# ── Driving ──────────────────────────────────────────────────────────────────────────────────


## Run the flow over `links` (`PolarisKey.cloud_connect.local_links`): `options` are the model's
## (`categories`, `label`, `pre_prompt`, `can_open_settings`, `now`, `timer`, `base`). Starts at the
## entry, with the cap and the gate read.
func attach(links: Object, options: Dictionary = {}) -> PKeyLocalPairingModel:
	if flow != null:
		flow.changed.disconnect(_on_flow_changed)
		flow.dispose()
	var o := options.duplicate()
	o["links"] = links
	flow = PKeyLocalPairingModel.new(o)
	flow.changed.connect(_on_flow_changed)
	flow.start()
	apply_snapshot(flow.snapshot())
	return flow


func _on_flow_changed(snap: Dictionary) -> void:
	apply_snapshot(snap)
	if snap.get("left") == true:
		closed.emit()


## Draw `snap`: the model's snapshot (the ui-matrix `localPairing` input, plus `changed` (the lit digit
## positions), `rotation`, and `name`, the paired screen's field).
func apply_snapshot(snap: Dictionary) -> void:
	_snap = snap
	refresh_view()


func input() -> Dictionary:
	var pairing := _snap.duplicate(true)
	for k in ["changed", "rotation", "name", "id", "left"]:
		pairing.erase(k)
	var out := {
		"localPairing": pairing,
		"presentation": {"name": String(PKeyUiTheme.product_identity()["name"])}
	}
	if not connect_on:
		out["services"] = Context.services_without(["connect"])
	return out


# ── Rendering ────────────────────────────────────────────────────────────────────────────────


func _screen_key() -> String:
	var state := String(model.get("state", ""))
	if state == "show":
		return "show|%s" % _snap.get("view", "code")
	return "enter" if state == "joining" else state


func _render() -> void:
	model = Models.view_of("LocalPairing", input())
	var state: String = model.get("state", "hidden")
	visible = state != "hidden"
	var copy: Array = model.get("copy", [])
	var args: Dictionary = (model.get("args", {}) as Dictionary).duplicate()
	if args.has("device"):
		args["device"] = PKeyUiTheme.isolate(String(args["device"]))
	_product.refresh()
	_words(state, copy, args)
	_render_show(state, copy, args)
	_render_field(state, copy, args)
	_render_shares(copy)
	_render_name(state, copy, args)
	_render_notice(state, copy, args)
	_render_actions(state, copy, args)
	var tone_danger: bool = model.get("decisions", {}).get("tone") == "danger"
	fx_error(
		("%s:%s" % [state, _snap.get("error", _snap.get("nameError", ""))]) if tone_danger else ""
	)
	if state == "confirm" and _prev_state != "confirm":
		_confirm_since = _ticks()
	var view_now := String(_snap.get("view", "code"))
	if state == "show" and _prev_state == "show" and view_now != _prev_view and is_inside_tree():
		_focus_after_switch.call_deferred()
	_prev_view = view_now
	_prev_state = state
	var rotation := int(_snap.get("rotation", 0))
	if (
		state == "show"
		and view_now == "code"
		and rotation != _prev_rotation
		and is_inside_tree()
		and not _has_focus_inside()
	):
		_focus_code_for_reader.call_deferred()
	_prev_rotation = rotation


## The screen's title and lede, from the model's copy.
func _words(state: String, copy: Array, args: Dictionary) -> void:
	var title := "localPairing.title"
	var lede := ""
	match state:
		"choose":
			lede = "localPairing.chooseBody"
		"opening", "show":
			lede = "localPairing.showBody"
		"closed":
			title = "linkPairing.failedTitle"
			lede = (
				"localPairing.failedTooMany"
				if copy.has("localPairing.failedTooMany")
				else "localPairing.failedExpired"
			)
		"enter", "joining":
			lede = "localPairing.enterBody"
		"confirm":
			title = (
				"localPairing.confirmTitle"
				if copy.has("localPairing.confirmTitle")
				else "localPairing.confirmUnnamed"
			)
			lede = "localPairing.confirmBody"
		"waiting":
			title = "linkPairing.waiting"
			lede = "localPairing.waitingWith"
		"paired":
			title = "localPairing.pairedTitle"
			lede = "localPairing.pairedBody"
		"failed":
			title = "linkPairing.failedTitle"
			for k in Local.FAILED_BODY.values():
				if copy.has(k):
					lede = k
		"network-blocked":
			title = "core.codes.nearby-permission-denied.title"
			lede = "core.codes.nearby-permission-denied.message"
		"off":
			title = "core.codes.local-pairing-off.title"
			lede = "core.codes.local-pairing-off.message"
	cat_text(_title, title if copy.has(title) else "", args)
	# Short on room the lede that only explains (2) goes before the card scrolls; a reason never does.
	var explains := state in ["choose", "opening", "show", "enter", "joining"]
	cat_text(
		_lede, lede if copy.has(lede) and not (explains and squeeze_level() >= 2) else "", args
	)


func _render_show(state: String, copy: Array, args: Dictionary) -> void:
	var shown := state == "show"
	var placeholder := state == "opening"
	var qr_view: bool = shown and _snap.get("view", "code") == "qr"
	_code_block.visible = shown or placeholder
	if shown and not qr_view:
		var code := String(_snap.get("code", ""))
		_code.show_code(code, _snap.get("changed", []))
		name_for_reader(_code, String(catalog().format("a11y.linkCode", {"code": spell_out(code)})))
	else:
		# The window is opening: the code tile holds its place until the first code arrives. The QR
		# view has no digits at all.
		_code.show_code("···· ····" if placeholder else "", [])
		name_for_reader(_code, String(catalog().format("a11y.busy")) if placeholder else "")
	_time_row.visible = shown or placeholder
	_ring.seconds_left = (
		float(_snap.get("secondsLeft", 300)) if shown else float(PKeyTimeRing.WINDOW_SECONDS)
	)
	cat_text(
		_time,
		"localPairing.expires" if copy.has("localPairing.expires") or placeholder else "",
		{"time": args.get("time", "5:00")}
	)
	cat_text(
		_waiting,
		"localPairing.waitingDevice" if (shown or placeholder) and squeeze_level() < 3 else "",
		args
	)
	var payload := String(_snap.get("qr", "")) if qr_view else ""
	if _visual.has_method("present"):
		_visual.call("present", payload)
	_visual.visible = qr_view and payload != ""
	if qr_view:
		name_for_reader(_visual, String(catalog().format("a11y.qrPairing")))


func _render_field(state: String, copy: Array, args: Dictionary) -> void:
	var on := state == "enter" or state == "joining"
	_field.visible = on
	cat_text(_field_label, "localPairing.codeLabel" if on else "", args)
	var busy := state == "joining"
	_entry.visible = on
	_entry.editable = not busy
	_entry.placeholder_text = (
		String(catalog().format("localPairing.codePlaceholder"))
		if copy.has("localPairing.codePlaceholder")
		else ""
	)
	var entry := String(_snap.get("entry", ""))
	if _entry.text != entry:
		_entry.text = entry
		_entry.caret_column = entry.length()
	var danger: bool = model.get("decisions", {}).get("tone") == "danger"
	_entry.theme_type_variation = &"PKeyFieldError" if danger else &""
	name_for_reader(_entry, _field_label.text)
	var error_key := ""
	for k in ["localPairing.wrongCode", "localPairing.notACode"]:
		if copy.has(k):
			error_key = k
	cat_text(_field_error, error_key, args)
	var hint_key := (
		"localPairing.spentCode"
		if copy.has("localPairing.spentCode")
		else ("localPairing.triesLeft" if copy.has("localPairing.triesLeft") else "")
	)
	cat_text(
		_field_hint,
		hint_key if hint_key != "localPairing.triesLeft" or squeeze_level() < 4 else "",
		args
	)


func _render_shares(copy: Array) -> void:
	var head := (
		"linkPairing.shares"
		if copy.has("linkPairing.shares")
		else ("linkPairing.sharesNone" if copy.has("linkPairing.sharesNone") else "")
	)
	_shares.visible = head != ""
	cat_text(_shares_head, head)
	var lines: Array = []
	if head == "linkPairing.shares":
		for id in _snap.get("categories", []):
			lines.append("• " + PKeyUiTheme.isolate(String(category_labels.get(id, id))))
	_shares_list.text = "\n".join(lines)
	_shares_list.visible = not lines.is_empty()


func _render_name(state: String, copy: Array, args: Dictionary) -> void:
	var on := state == "paired"
	_name_block.visible = on
	cat_text(_name_label, "localPairing.nameLabel" if on else "", args)
	var held := String(_snap.get("name", ""))
	if _name_edit.text != held:
		_name_edit.text = held
		_name_edit.caret_column = held.length()
	_name_edit.visible = on
	_name_edit.theme_type_variation = (
		&"PKeyFieldError" if on and _snap.get("nameError") != null else &""
	)
	name_for_reader(_name_edit, _name_label.text)
	cat_text(
		_name_error, "devices.renameFailed" if on and copy.has("devices.renameFailed") else "", args
	)
	cat_text(_name_hint, "localPairing.nameHint" if on else "", args)


## The one notice a state may carry: its title, words, glyph and quiet action.
func _render_notice(state: String, copy: Array, args: Dictionary) -> void:
	var fmt := func(k: String) -> String:
		return String(catalog().format(k, args)) if k != "" and copy.has(k) else ""
	var title := ""
	var body := ""
	var glyph := "info"
	var action := ""
	match state:
		"choose":
			if copy.has("core.codes.local-links-full.title"):
				title = "core.codes.local-links-full.title"
				body = "core.codes.local-links-full.message"
				action = "localPairing.pairedDevices"
		"show":
			var n: Variant = _snap.get("notice")
			if n == "rotated" or n == "declined" or n == "guessing":
				title = (
					"localPairing.notPairedWith" if n == "declined" else "localPairing.rotatedTitle"
				)
				body = (
					"localPairing.tooManyAgainBody"
					if n == "guessing"
					else "localPairing.rotatedBody"
				)
				action = "localPairing.showNew"
				glyph = "warning" if n == "guessing" else "info"
			elif n == "blocked":
				title = "localPairing.blockedTitle"
				body = "localPairing.blockedBody"
				glyph = "warning"
		"closed":
			if copy.has("localPairing.tooManyAgainTitle"):
				title = "localPairing.tooManyAgainTitle"
				body = "localPairing.tooManyAgainBody"
				glyph = "warning"
		"enter":
			if copy.has("localPairing.cooldownTitle"):
				title = "localPairing.cooldownTitle"
				body = "localPairing.cooldownBody"
			elif copy.has("localPairing.notFoundTitle"):
				title = "localPairing.notFoundTitle"
				body = "localPairing.notFoundBody"
		"paired":
			if copy.has("localPairing.cantConnectTitle"):
				title = "localPairing.cantConnectTitle"
				body = "localPairing.cantConnectBody"
				action = "localPairing.pairedDevices"
	_notice.show_notice(fmt.call(title), fmt.call(body), glyph, fmt.call(action))
	_notice.set_meta(&"pkey_key", action)
	if action == "localPairing.showNew" and (model.get("disabled", []) as Array).has(action):
		_notice.action_button().modulate.a = UNAVAILABLE_ALPHA
	elif _notice.action_button() != null:
		_notice.action_button().modulate.a = 1.0


## The controls of the state: buttons in the first row, quiet links in the second.
func _render_actions(state: String, copy: Array, args: Dictionary) -> void:
	var buttons: Array = []
	var links: Array = []
	match state:
		"choose":
			buttons = ["localPairing.show", "localPairing.enter"]
			links = ["common.cancel"]
		"opening":
			buttons = ["common.cancel"]
		"show":
			# One quiet link to the other view of the same window.
			buttons = ["common.cancel"]
			links = [TO_CODE_KEY if _snap.get("view", "code") == "qr" else TO_QR_KEY]
		"closed":
			buttons = [
				(
					"localPairing.showNewIn"
					if copy.has("localPairing.showNewIn")
					else "localPairing.showNew"
				),
				"common.close"
			]
		"enter":
			buttons = ["localPairing.pair"]
			links = ["localPairing.toShow", "common.back"]
		"joining":
			buttons = ["localPairing.pair"]
			links = ["common.cancel"]
		"confirm":
			buttons = ["localPairing.pair", "common.notNow"]
		"waiting":
			buttons = ["common.cancel"]
		"paired":
			buttons = ["common.done"]
			links = ["localPairing.pairedDevices"] if copy.has("localPairing.pairedDevices") else []
		"failed", "network-blocked":
			for k in ["localPairing.openSettings", "common.tryAgain", "common.close"]:
				if copy.has(k):
					buttons.append(k)
		"off":
			buttons = ["common.close"]
	var primary: Variant = model.get("decisions", {}).get("primary")
	var unavailable: Array = model.get("disabled", [])
	for i in _buttons.size():
		var key: String = buttons[i] if i < buttons.size() else ""
		_style_slot(_buttons[i], key, args, key == primary, unavailable)
	for i in _links.size():
		_style_slot(_links[i], links[i] if i < links.size() else "", args, false, unavailable)
	_actions.visible = not buttons.is_empty()
	_links_row.visible = not links.is_empty()


func _style_slot(
	b: Button, key: String, args: Dictionary, primary: bool, unavailable: Array
) -> void:
	var skip := key == "common.cancel" and false
	cat_text(b, key if not skip else "", args)
	b.set_meta(&"pkey_key", key)
	if b.get_parent() == _actions:
		b.theme_type_variation = &"PKeyPrimary" if primary else &""
	# Drawn unavailable, never disabled: focus and the press that answers its reason stay.
	b.modulate.a = UNAVAILABLE_ALPHA if unavailable.has(key) else 1.0
	b.set_meta(&"pkey_unavailable", unavailable.has(key))
	if key == "localPairing.openSettings":
		leaves_app(b, true)
	else:
		leaves_app(b, false)


## After a switch of view, focus moves to the new view's heading (a screen reader) or its first
## control, which is Cancel: never the link that was pressed.
func _focus_after_switch() -> void:
	if not is_instance_valid(self) or not is_inside_tree():
		return
	if get_tree().is_accessibility_enabled() and _title.focus_mode != Control.FOCUS_NONE:
		_title.grab_focus()
		return
	var first := _first_button()
	if first != null:
		first.grab_focus()


func _focus_code_for_reader() -> void:
	if is_instance_valid(_code):
		PKeyPairCode.focus_for_reader(_code)


## The digits of a code, apart, for a screen reader ("4 8 1 2 3 4 5 6").
static func spell_out(code: String) -> String:
	var out: Array = []
	for ch in code:
		if ch != " ":
			out.append(ch)
	return " ".join(out)


# ── Layout ───────────────────────────────────────────────────────────────────────────────────


func _arrange(m: Dictionary) -> void:
	super(m)
	var scale := float(m.get("scale", 1.0))
	var room: Vector2 = m.get("room", Vector2(1280, 720))
	_layout = Local.layout({"width": room.x / scale, "height": room.y / scale, "tv": pad_only()})
	var state := String(model.get("state", ""))
	# Short on room the product's header collapses to one line (DL5: it is never removed): always in a
	# window under 480 tall, where nothing may scroll for it.
	_product.card = bool(_layout["logo"]) and squeeze_level() < 1
	# Two panes from 600 px of window: the facts on one side, what to do about them on the other. The
	# QR view's QR is a pane of its own.
	var qr_view := _visual.visible
	# The show step follows the window rule. The other steps share a window only when it is wide and short,
	# where a second column saves the height a single one lacks.
	var wide_short: bool = (
		room.x >= room.y * 1.6 and room.y / scale < 600.0 and room.x / scale >= 520.0
	)
	var two: bool = false
	if state in ["opening", "show"]:
		# With the QR beside it, the window rule; the code view has nothing to put beside it but the
		# notice and the controls, which a wide and short window takes as a second column.
		two = int(_layout["panes"]) == 2 if qr_view else wide_short
	elif state in ["enter", "joining", "confirm", "waiting"]:
		two = wide_short
	set_columns(_stage, two)
	_live_placement(two, qr_view)
	# Beside the QR the window's own controls sit under the time, so the screen is no taller than its QR;
	# in the code view they sit under the notice.
	_stack_links = state in ["opening", "show"]
	_actions_placement(two and (wide_short or not qr_view), qr_view)
	# Beside the controls the QR keeps to two fifths of the width, so the controls keep the rest.
	var side := (
		qr_side(maxf(room_x() * 0.4, QR_MIN_PHYSICAL / float(m.get("physical", 1.0))))
		if two
		else qr_side()
	)
	if _visual.has_method("set_side"):
		_visual.call("set_side", side)
	# The digits fit their half of the window beside the notice, or the whole width in one column.
	_code.fit_to(maxf(room_x() * 0.5 - role("column_gap") if two else room_x(), 1.0))
	_ring.custom_minimum_size = Vector2(roundf(20.0 * scale), roundf(20.0 * scale))
	_notice.size_glyph(self, 20.0)
	_spacer.visible = (
		phone_screen()
		and state in ["confirm", "enter", "joining", "paired", "closed", "failed", "choose"]
	)
	_body.theme_type_variation = &"PKeyTight" if squeeze_level() >= 2 else &"PKeySections"
	tighten_gap(_body, squeeze_level() >= 3)
	_left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_right.size_flags_horizontal = Control.SIZE_EXPAND_FILL


## The notice and the waiting line: beside the facts in two panes (under the QR's pane in the code
## view, with the time in the QR view); in one column after the QR, or before it in a window that
## scrolls (so a wrong code's notice is not left under the QR out of view).
func _live_placement(two: bool, qr_view: bool) -> void:
	var before: bool = bool(_layout.get("noticeBeforeQr", false))
	var home: Node = _stage
	if two:
		home = _left if qr_view else _right
	elif before:
		home = _left
	if _live.get_parent() != home:
		_live.reparent(home, false)
	if home == _stage:
		_stage.move_child(_live, _stage.get_child_count() - 1)
	else:
		home.move_child(_live, home.get_child_count() - 1)
	# The shares sit above the notice in the right pane.
	if home == _right:
		_right.move_child(_live, _right.get_child_count() - 1)


## The window's controls: under the notice beside the QR (`beside`), else at the screen's foot.
func _actions_placement(beside: bool, qr_view: bool) -> void:
	var home: Node = (_left if qr_view else _right) if beside else _body
	# In a pane the controls stack at the pane's width.
	_actions.set_meta(&"pkey_force_stack", beside)
	_links_row.set_meta(
		&"pkey_force_stack", beside and _links_row.get_child_count() > 0 and _stack_links
	)
	if _actions.get_parent() != home:
		_actions.reparent(home, false)
		_links_row.reparent(home, false)
	if beside:
		home.move_child(_actions, home.get_child_count() - 2)
		home.move_child(_links_row, home.get_child_count() - 1)
	else:
		_body.move_child(_actions, _spacer.get_index() + 1)
		_body.move_child(_links_row, _actions.get_index() + 1)


# ── Presses ──────────────────────────────────────────────────────────────────────────────────


func _ticks() -> int:
	return int(ticks_source.call()) if ticks_source.is_valid() else Time.get_ticks_msec()


func _on_button(i: int) -> void:
	_press(String((_buttons[i] as Button).get_meta(&"pkey_key", "")))


func _on_link(i: int) -> void:
	_press(String((_links[i] as Button).get_meta(&"pkey_key", "")))


func _on_notice_action() -> void:
	_press(String(_notice.get_meta(&"pkey_key", "")))


func _on_entry_changed(text: String) -> void:
	entry_edited.emit(text)
	if flow != null:
		flow.set_entry(text)


func _on_name_changed(text: String) -> void:
	name_edited.emit(text)
	if flow != null:
		flow.set_name(text)


## A control was pressed. Pair on the prompt is ignored for the guard's first milliseconds, so the
## press that opened the prompt cannot answer it; a prompt that was pressed already waits.
func _press(key: String) -> void:
	if key == "":
		return
	var state := String(model.get("state", ""))
	if state == "confirm" and key == "localPairing.pair" and _ticks() - _confirm_since < guard_msec:
		return
	if state == "confirm" and (model.get("disabled", []) as Array).has(key):
		return
	action_pressed.emit(key)
	match key:
		"localPairing.openSettings":
			open_settings_requested.emit()
			return
		"localPairing.pairedDevices":
			paired_devices_requested.emit()
			return
	if flow == null:
		if key in ["common.close", "common.done"] or (key == "common.cancel" and state == "choose"):
			closed.emit()
		return
	_route(key, state)


func _route(key: String, state: String) -> void:
	match key:
		"localPairing.show":
			flow.show()
		"localPairing.toShow":
			# On the field it opens a window; on the QR view it goes back to the code.
			if state == "show":
				flow.set_view("code")
			else:
				flow.show()
		"part.qr.scanInstead":
			flow.set_view("qr")
		"localPairing.enter", "localPairing.toEnter":
			flow.enter()
		"localPairing.showNew", "localPairing.showNewIn":
			flow.show_new()
		"localPairing.pair":
			if state == "confirm":
				flow.confirm()
			else:
				flow.pair()
		"common.notNow":
			flow.not_now()
		"common.cancel":
			flow.cancel()
		"common.back":
			flow.cancel()
		"common.close":
			flow.close()
		"common.done":
			flow.done()
		"common.tryAgain":
			flow.retry()


# ── Focus ────────────────────────────────────────────────────────────────────────────────────


func _initial_focus() -> Control:
	match String(model.get("state", "")):
		"confirm":
			# Not now first, and never Pair: Enter or a pad's A on arrival does not pair.
			return _confirm_not_now()
		"enter":
			if pad_only() or is_mobile():
				return _first_button()
			return _entry if is_focusable(_entry) else _first_button()
		"joining":
			return _first_button()
		"paired":
			return (
				_name_edit
				if is_focusable(_name_edit) and not pad_only() and not is_mobile()
				else _first_button()
			)
	return _first_button()


func _confirm_not_now() -> Control:
	for b in _buttons:
		if (b as Button).get_meta(&"pkey_key", "") == "common.notNow" and is_focusable(b):
			return b
	return _first_button()


func _first_button() -> Control:
	for b in _buttons + _links:
		if is_focusable(b):
			return b
	return null


func _focus_chain() -> Array:
	var chain: Array = [_entry, _name_edit]
	if _notice.action_button() != null:
		chain.append(_notice.action_button())
	return chain + _buttons + _links


## Escape (or a pad's B): Not now on the prompt, Cancel on a window or a busy Pair, Back on the field,
## and the way out elsewhere. The paired screen leaves with the name as it was.
func _cancel() -> bool:
	if not visible:
		return false
	var key := ""
	match String(model.get("state", "")):
		"confirm":
			key = "common.notNow"
		"opening", "show", "joining", "waiting":
			key = "common.cancel"
		"enter":
			key = "common.back"
		"choose":
			key = "common.cancel"
		"hidden":
			return false
		_:
			key = "common.close"
	_press(key)
	return true
