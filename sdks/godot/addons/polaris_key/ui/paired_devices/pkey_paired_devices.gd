class_name PKeyPairedDevices
extends PKeyUiView
## Paired devices (ui-matrix `local`; ui-core's `paired_devices_view`): the devices this one paired
## with by a code, with Rename and Forget in the row, the Can connect switches, and Pair with a Code
## as the one primary. States (the model's): loading, list, renaming, forgetting, empty, load-failed,
## off.
##
## Rules this scene keeps:
##   - nothing is said about what is paired until the first read answers (no "none yet" while loading);
##   - Rename and Forget work in the row, never in a dialog; a refused name keeps its text and says why;
##     after a Forget focus moves to the next row, or the title when none is left;
##   - the Can connect switches show only when more than 8 are paired or one is off, and while eight
##     are on the off switches wait with their reason on screen;
##   - with pairing off only Rename and Forget remain;
##   - a device name is the other device's own text: drawn whole, isolated;
##   - gamepad and keyboard reach every control: up and down walk the rows, Escape or B cancels an edit.
##
## Driven: `attach(links, options)` over `PolarisKey.cloud_connect.local_links`; the scene reads the list,
## follows its changes and unsubscribes when it leaves the tree. Plain: `apply_snapshot(snapshot)`.

## Every press, by the copy key of its control, with the row (`{id}`) where it has one.
signal action_pressed(key: String, detail: Dictionary)
## Pair with a Code was chosen: the host opens the pairing screen.
signal pair_requested
## Done: the host closes the screen.
signal closed

const Models := preload("res://addons/polaris_key/ui/model/models.gd")
const Local := preload("res://addons/polaris_key/ui/model/local.gd")
const Context := preload("res://addons/polaris_key/ui/model/context.gd")

## The controls of a row in the order they read.
const ROW_ORDER := ["field", "switch", "rename", "forget", "save", "cancel"]

## `func() -> float` epoch seconds (tests); empty uses the system's.
var now_source: Callable = Callable()
## Connect is off: the scene is hidden.
var connect_on := true:
	set(value):
		connect_on = value
		refresh_view()

## The view of the state drawn now.
var model: Dictionary = {}
## The driven model, or null in plain mode.
var flow: PKeyPairedDevicesModel = null

var _snap: Dictionary = {"step": "loading", "devices": []}
var _frame: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _lede: Label
var _notices: VBoxContainer
var _notice_nodes: Array = []
var _message: Label
var _error: Label
var _column_head: Label
var _list_scroll: ScrollContainer
var _list_panel: PanelContainer
var _rows: VBoxContainer
var _row_nodes: Dictionary = {}
var _spacer: Control
var _actions: BoxContainer
var _pair: Button
var _retry: Button
var _done: Button
var _signature := ""
var _applied_focus := ""
var _list_off := false
var _cols: BoxContainer
var _side: VBoxContainer
var _main: VBoxContainer
var _head_margin: MarginContainer
## The button that opened a row's edit, where focus returns when it is cancelled.
var _prefer := "rename"
var _skeleton: VBoxContainer


func _build() -> void:
	name = "PKeyPairedDevices"
	_frame = vbox(card_panel(), "Frame", "PKeySections")
	_cols = columns(_frame, "Cols")
	_cols.set_meta(AUTO_HIDE_META, true)
	_side = vbox(_cols, "Side", "PKeyStack")
	var head := vbox(_side, "Head", "PKeyStack")
	_product = product_header(head, "Product")
	_product.card = true
	var titles := vbox(head, "Titles", "PKeyTight")
	_title = label(titles, "Title", "PKeyTitle")
	_title.focus_mode = PKeyPairCode.accessibility_focus() as Control.FocusMode
	_lede = label(titles, "Lede", "PKeyMuted")
	loading_bar(_side)
	_notices = vbox(_side, "Notices", "PKeyStack")
	for i in 3:
		var n := PKeyPairNotice.new()
		n.name = "Notice%d" % i
		n.action_pressed.connect(_on_notice_action.bind(i))
		_notices.add_child(n)
		_notice_nodes.append(n)
	_message = label(_side, "Message", "PKeyMuted")
	_error = label(_side, "Failure", "PKeyError")
	if "accessibility_live" in _error:
		_error.set("accessibility_live", 1)
	_main = vbox(_cols, "Main", "PKeyStack")
	_head_margin = MarginContainer.new()
	_head_margin.name = "ColumnHeadMargin"
	_main.add_child(_head_margin)
	_column_head = label(_head_margin, "ColumnHead", "PKeyMuted")
	_column_head.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_list_scroll = PKeyListScroll.make(_main, "ListScroll")
	_list_panel = PanelContainer.new()
	_list_panel.name = "List"
	_list_panel.theme_type_variation = "PKeyRail"
	_list_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_list_scroll.add_child(_list_panel)
	_rows = vbox(_list_panel, "Rows", "PKeyTight")
	_spacer = spacer(_frame)
	_actions = actions_row(_frame, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_retry = button(_actions, "Retry", func() -> void: _press("common.tryAgain", {}), "PKeyPrimary")
	_pair = button(
		_actions, "Pair", func() -> void: _press("pairedDevices.pair", {}), "PKeyPrimary"
	)
	_done = button(_actions, "Done", func() -> void: _press("common.done", {}))
	max_content_width = 640.0


func _bleeds() -> bool:
	return true


## A short landscape window cannot spare a card's padding: the page is the card, as on a phone held
## sideways.
func side_bleed() -> bool:
	if super():
		return true
	if outer_view() != self:
		return false
	var m := layout_metrics()
	var room: Vector2 = m.get("room", Vector2(1280, 720))
	return room.y < 430.0 and room.x >= room.y * 1.4


func _opens_at_top() -> bool:
	return true


func squeeze_max() -> int:
	return 4


func _exit_tree() -> void:
	if flow != null:
		flow.stop()


# ── Driving ──────────────────────────────────────────────────────────────────────────────────


## Follow `links` (`PolarisKey.cloud_connect.local_links`): the first read, and every change after it.
func attach(links: Object, options: Dictionary = {}) -> PKeyPairedDevicesModel:
	if flow != null:
		flow.changed.disconnect(_on_flow_changed)
		flow.stop()
	var o := options.duplicate()
	o["links"] = links
	flow = PKeyPairedDevicesModel.new(o)
	flow.changed.connect(_on_flow_changed)
	apply_snapshot(flow.snapshot())
	flow.start()
	return flow


func _on_flow_changed(snap: Dictionary) -> void:
	apply_snapshot(snap)
	if snap.get("left") == true:
		closed.emit()
	elif snap.get("pairAnother") == true:
		flow.snapshot()["pairAnother"] = false
		pair_requested.emit()


## Draw `snap`: the model's snapshot (the ui-matrix `pairedDevices` input; `draft` is the rename
## field's text and `focus` where focus goes next).
func apply_snapshot(snap: Dictionary) -> void:
	_snap = snap
	refresh_view()


func input() -> Dictionary:
	var list := _snap.duplicate(true)
	for k in ["draft", "focus", "loaded", "entryVisible", "left", "pairAnother"]:
		list.erase(k)
	if flow != null and list.get("notice") == null and flow.host_notice != null:
		list["notice"] = flow.host_notice
	var out := {
		"pairedDevices": list,
		"presentation": {"name": String(PKeyUiTheme.product_identity()["name"])}
	}
	if not connect_on:
		out["services"] = Context.services_without(["connect"])
	return out


# ── Rendering ────────────────────────────────────────────────────────────────────────────────


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), _snap.get("target", "")]


func _now() -> float:
	return float(now_source.call()) if now_source.is_valid() else Time.get_unix_time_from_system()


func _render() -> void:
	model = Models.view_of("PairedDevices", input())
	var state: String = model.get("state", "hidden")
	visible = state != "hidden"
	var copy: Array = model.get("copy", [])
	var args: Dictionary = (model.get("args", {}) as Dictionary).duplicate()
	if args.has("device"):
		args["device"] = PKeyUiTheme.isolate(String(args["device"]))
	_product.refresh()
	set_loading(state == "loading")
	set_process(state == "loading")
	cat_text(_title, "pairedDevices.title" if state != "hidden" else "", args)
	cat_text(_lede, "pairedDevices.lede" if copy.has("pairedDevices.lede") else "", args)
	var message := ""
	match state:
		"empty":
			message = "pairedDevices.empty"
	cat_text(_message, message, args)
	cat_text(_error, "pairedDevices.loadFailed" if state == "load-failed" else "", args)
	_render_notices(state, copy, args)
	var devices: Array = _snap.get("devices", [])
	var listing := state in ["list", "renaming", "forgetting", "off"] and not devices.is_empty()
	var switches := copy.has("pairedDevices.canConnect")
	cat_text(_column_head, "pairedDevices.canConnect" if switches and listing else "", args)
	_list_scroll.visible = listing
	var sig := JSON.stringify(
		[
			devices,
			state,
			_snap.get("target"),
			_snap.get("renameError"),
			_snap.get("forgetError"),
			_snap.get("draft"),
			switches,
			squeeze_level() >= 2,
			copy.has("pairedDevices.reachableFullTitle")
		]
	)
	if sig != _signature:
		_signature = sig
		_rebuild(listing, switches, copy.has("pairedDevices.reachableFullTitle"), state)
	_show_skeleton(
		state == "loading" and _loading_since > 0 and Time.get_ticks_msec() - _loading_since >= 300
	)
	_render_actions(state, args)
	_apply_focus_request()


func _render_notices(state: String, copy: Array, args: Dictionary) -> void:
	var made: Array = []
	var fmt := func(k: String) -> String:
		return String(catalog().format(k, args)) if k != "" and copy.has(k) else ""
	if state == "off":
		made.append(
			[
				fmt.call("core.codes.local-pairing-off.title"),
				fmt.call("pairedDevices.offBody"),
				"info",
				"",
				""
			]
		)
	elif state == "list":
		# No room to pair and eight that can connect are one notice: the cap first, then what to do.
		var has_full := copy.has("core.codes.local-links-full.title")
		var has_reach := copy.has("pairedDevices.reachableFullTitle")
		if has_full or has_reach:
			var title: String = fmt.call(
				(
					"core.codes.local-links-full.title"
					if has_full
					else "pairedDevices.reachableFullTitle"
				)
			)
			var body: Array = []
			if has_full:
				body.append(fmt.call("pairedDevices.fullBody"))
			if has_reach:
				if has_full:
					body.append(fmt.call("pairedDevices.reachableFullTitle") + ".")
				body.append(fmt.call("pairedDevices.reachableFullBody"))
			made.append([title, " ".join(body), "info", "", ""])
		var n: Variant = _snap.get("notice")
		if n is Dictionary:
			var pair: Array = Local.NOTICE.get(n.get("kind"), [])
			if n.get("kind") == "busy":
				made.append(
					[
						fmt.call("pairedDevices.busyTitle"),
						"",
						"info",
						fmt.call("common.tryAgain"),
						"common.tryAgain"
					]
				)
			elif not pair.is_empty():
				made.append([fmt.call(pair[0]), fmt.call(pair[1]), "info", "", ""])
	for i in _notice_nodes.size():
		var node := _notice_nodes[i] as PKeyPairNotice
		if i < made.size():
			var m: Array = made[i]
			node.show_notice(m[0], m[1], m[2], m[3])
			node.set_meta(&"pkey_key", m[4])
		else:
			node.show_notice("", "")
			node.set_meta(&"pkey_key", "")
	_notices.visible = not made.is_empty()


func _render_actions(state: String, args: Dictionary) -> void:
	var primary: Variant = model.get("decisions", {}).get("primary")
	var unavailable: Array = model.get("disabled", [])
	var editing := state == "renaming" or state == "forgetting"
	cat_text(_retry, "common.tryAgain" if state == "load-failed" else "", args)
	cat_text(_pair, "pairedDevices.pair" if state in ["list", "empty"] else "", args)
	cat_text(_done, "common.done" if not editing and state != "hidden" else "", args)
	_pair.theme_type_variation = &"PKeyPrimary" if primary == "pairedDevices.pair" else &""
	_done.theme_type_variation = &"PKeyPrimary" if primary == "common.done" else &""
	_pair.modulate.a = 0.55 if unavailable.has("pairedDevices.pair") else 1.0
	_pair.set_meta(&"pkey_unavailable", unavailable.has("pairedDevices.pair"))
	_actions.visible = state != "hidden" and not editing
	_spacer.visible = phone_screen()


## Three rows of the list's shape while the first read has not answered (after the DL7 delay).
func _show_skeleton(on: bool) -> void:
	on = on and float((layout_metrics().get("room", Vector2(0, 999)) as Vector2).y) >= 430.0
	if on and _skeleton == null:
		_skeleton = vbox(_main, "Skeleton", "PKeyTight")
		_main.move_child(_skeleton, _list_scroll.get_index())
		for i in 3:
			var row := ColorRect.new()
			row.name = "Row%d" % i
			row.color = Color(1, 1, 1, 0.07)
			row.mouse_filter = Control.MOUSE_FILTER_IGNORE
			row.custom_minimum_size.y = roundf(56.0 * float(layout_metrics().get("scale", 1.0)))
			_skeleton.add_child(row)
	if _skeleton != null:
		_skeleton.visible = on


func _rebuild(show: bool, switches: bool, waits: bool, state: String) -> void:
	var held := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
	var keep := ""
	if held != null and _rows.is_ancestor_of(held):
		keep = String(held.get_meta(&"pkey_focus_id", ""))
	_action_rows = _action_rows.filter(
		func(r: Variant) -> bool: return is_instance_valid(r) and not _rows.is_ancestor_of(r)
	)
	for ch in _rows.get_children():
		_rows.remove_child(ch)
		ch.queue_free()
	_row_nodes.clear()
	if not show:
		return
	for d: Dictionary in _snap.get("devices", []):
		_make_row(d, switches, waits, state)
	if state == "renaming" and _row_nodes.has(String(_snap.get("target", ""))):
		# The field takes the cursor as the row opens.
		_focus_when_ready(String(_snap["target"]))
	elif keep != "" and _snap.get("focus") == null:
		_focus_when_ready(keep)


func _name_of(d: Dictionary) -> String:
	var label: Variant = d.get("label")
	return (
		String(label)
		if label is String and (label as String).strip_edges() != ""
		else String(catalog().format("devices.unnamed"))
	)


func _make_row(d: Dictionary, switches: bool, waits: bool, state: String) -> void:
	var id := String(d["id"])
	var shown := _name_of(d)
	var args := {
		"device": PKeyUiTheme.isolate(shown),
		"max": Local.MAX_NAME if _snap.get("renameError") == "long" else Local.MAX_CONNECTABLE
	}
	var holder := vbox(_rows, "Row_%s" % id, "PKeyTight")
	var out := {"holder": holder}
	var editing: bool = state == "renaming" and _snap.get("target") == id
	var asking: bool = state == "forgetting" and _snap.get("target") == id
	if editing:
		var cap := label(holder, "Caption", "PKeyMuted")
		cat_text(cap, "devices.renameLabel", args)
		var field := LineEdit.new()
		field.name = "Name"
		field.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		field.max_length = 0
		field.text = String(_snap.get("draft", ""))
		field.caret_column = field.text.length()
		field.set_meta(DATA_META, true)
		field.set_meta(&"pkey_focus_id", id)
		field.keep_editing_on_text_submit = true
		if _snap.get("renameError") != null:
			field.theme_type_variation = &"PKeyFieldError"
		field.text_changed.connect(_on_draft.bind(id))
		field.text_submitted.connect(func(_t: String) -> void: _press("common.save", {"id": id}))
		name_for_reader(field, cap.text)
		holder.add_child(field)
		var line := label(holder, "Problem", "PKeyError")
		var error_key: String = (
			{
				"long": "pairedDevices.renameLong",
				"empty": "pairedDevices.renameEmpty",
				"failed": "devices.renameFailed"
			}
			. get(_snap.get("renameError"), "")
		)
		cat_text(line, error_key, args)
		if "accessibility_live" in line:
			line.set("accessibility_live", 1)
		var hint := label(holder, "Hint", "PKeyMuted")
		cat_text(hint, "localPairing.nameHint" if squeeze_level() < 2 else "", args)
		var acts := _row_actions(holder)
		out["save"] = _row_button(acts, "Save", "common.save", id, "PKeyPrimary", args)
		out["cancel"] = _row_button(acts, "Cancel", "common.cancel", id, "", args)
		out["field"] = field
	elif asking:
		var ask := label(holder, "Question", "PKeyStrong")
		cat_text(ask, "pairedDevices.forgetConfirm", args)
		var body := label(holder, "Body", "PKeyMuted")
		cat_text(body, "pairedDevices.forgetBody", args)
		var problem := label(holder, "Problem", "PKeyError")
		cat_text(
			problem, "pairedDevices.forgetFailed" if _snap.get("forgetError") == true else "", args
		)
		if "accessibility_live" in problem:
			problem.set("accessibility_live", 1)
		var acts := _row_actions(holder)
		var yes := _row_button(acts, "Forget", "pairedDevices.forget", id, "PKeyDanger", args)
		var no := _row_button(acts, "Cancel", "common.cancel", id, "", args)
		out["forget"] = yes
		out["cancel"] = no
	else:
		var line := hbox(holder, "Line")
		var glyph := glyph_node(line, "Glyph", PKeyKitGlyphs.device(d.get("platform")))
		glyph.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		out["glyph"] = glyph
		var text := vbox(line, "Text", "PKeyTight")
		text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		var nm := label(text, "Name", "PKeyStrong", true)
		nm.text = (
			PKeyUiTheme.isolate(shown)
			if d.get("label") is String and String(d["label"]).strip_edges() != ""
			else shown
		)
		var seen: Variant = d.get("lastSeen")
		if seen != null:
			var meta := label(text, "Meta", "PKeyMuted")
			var days := int(floor(maxf(0.0, _now() - float(seen)) / 86400.0))
			cat_text(
				meta, "pairedDevices.lastSeen", {"when": PKeyDevicesController.when_text(days, c())}
			)
		if switches:
			var sw := CheckButton.new()
			sw.name = "Switch"
			sw.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
			sw.button_pressed = d.get("reachable") == true
			sw.size_flags_vertical = Control.SIZE_SHRINK_CENTER
			var stuck: bool = waits and d.get("reachable") != true
			# The switch that cannot be turned on yet is drawn unavailable, never disabled: its reason is on screen.
			sw.modulate.a = 0.55 if stuck else 1.0
			sw.set_meta(&"pkey_unavailable", stuck)
			sw.set_meta(&"pkey_focus_id", id)
			name_for_reader(sw, String(catalog().format("a11y.letConnect", args)))
			sw.toggled.connect(_on_switch.bind(id, sw, stuck))
			line.add_child(sw)
			out["switch"] = sw
		# Rename and Forget sit on the row's line, or under it on a phone or a narrow card (`_arrange`).
		var acts := _row_actions(line)
		acts.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		var rename := _row_button(acts, "Rename", "devices.rename", id, "PKeyLink", args)
		name_for_reader(rename, "%s: %s" % [rename.text, shown])
		var forget := _row_button(acts, "ForgetRow", "pairedDevices.forget", id, "PKeyLink", args)
		name_for_reader(forget, "%s: %s" % [forget.text, shown])
		out["rename"] = rename
		out["forget"] = forget
		out["acts"] = acts
	_row_nodes[id] = out


func _row_actions(parent: Node) -> BoxContainer:
	var box := BoxContainer.new()
	box.name = "Actions"
	box.theme_type_variation = "PKeyActionRow"
	box.alignment = BoxContainer.ALIGNMENT_BEGIN
	parent.add_child(box)
	return box


func _row_button(
	parent: Node, node_name: String, key: String, id: String, variation: String, args: Dictionary
) -> Button:
	var b := button(parent, node_name, _press.bind(key, {"id": id}), variation)
	cat_text(b, key, args)
	b.set_meta(&"pkey_focus_id", id)
	b.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return b


# ── Layout ───────────────────────────────────────────────────────────────────────────────────


func _arrange(m: Dictionary) -> void:
	var scale := float(layout_metrics()["scale"])
	var phone := bool(layout_metrics().get("phone", false))
	var room: Vector2 = m.get("room", Vector2(1280, 720))
	# A short, wide window gives the card the width of two columns.
	max_content_width = 920.0 if room.y < 430.0 and room.x >= 760.0 else 640.0
	super(m)
	var least := roundf(56.0 * scale)
	# Under 420 tall the title, the notices and the controls take a column beside the list.
	var short: bool = room.y < 430.0 and room.x >= 760.0
	var state := String(model.get("state", ""))
	var listing := _list_scroll.visible
	set_columns(_cols, short and listing)
	_cols.vertical = not (short and listing)
	_side.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_main.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_side.size_flags_stretch_ratio = 0.7
	_main.size_flags_stretch_ratio = 1.3
	_actions_placement(short and listing)
	var narrow := phone or room.y < 430.0 or room_x() < 440.0 * scale
	for id in _row_nodes:
		var r: Dictionary = _row_nodes[id]
		var line := r["holder"].get_node_or_null("Line") as BoxContainer
		if line != null:
			line.custom_minimum_size.y = least
		if r.has("glyph"):
			size_glyph(r["glyph"], 24.0, get_theme_color("font_color", "PKeyMuted"))
		if r.has("acts"):
			# One line: name, meta, switch and the two links. Narrow: the links go under, as in Devices.
			var home: Node = r["holder"] if narrow else line
			if (r["acts"] as Node).get_parent() != home:
				(r["acts"] as Node).reparent(home, false)
	_notice_glyphs()
	# At the tightest the title steps down to the body's heading size.
	if squeeze_level() >= 3:
		_title.add_theme_font_size_override(
			&"font_size", int(get_theme_font_size("font_size", "Button") * 1.5)
		)
	else:
		_title.remove_theme_font_size_override(&"font_size")
	_show_skeleton(
		state == "loading" and _loading_since > 0 and Time.get_ticks_msec() - _loading_since >= 300
	)
	_head_margin_fit(narrow)
	PKeyListScroll.fit_buttons(self, _list_panel, _list_panel, _list_scroll)
	_fit_inner_actions(false)
	var changed := _fit_list(least * 3.0, least)
	fit_scrolls(available_height(), outer_view() == self and _stretches_vertically())
	_release_offsets()
	PKeyListScroll.resync(self)
	_spacer.visible = phone_screen() and state != "loading"
	if changed:
		PKeyUiView._resort_all(self)


## "Can connect" sits above the switch column: its right edge is the switch's, left of the links.
func _head_margin_fit(narrow: bool) -> void:
	var gap := 0.0
	for id in _row_nodes:
		var r: Dictionary = _row_nodes[id]
		if r.has("acts") and r.has("switch"):
			var acts := r["acts"] as Control
			if not narrow:
				gap = acts.get_combined_minimum_size().x + role("inline_gap")
			break
	var pad := role("card_padding") * 0.0
	_head_margin.add_theme_constant_override("margin_right", int(gap + pad + 16.0))


## The Actions row: at the foot of the card, or in the side column when the list takes the other one.
func _actions_placement(beside: bool) -> void:
	var home: Node = _side if beside else _frame
	_actions.set_meta(&"pkey_force_stack", false)
	if _actions.get_parent() != home:
		_actions.reparent(home, false)
	if not beside:
		_frame.move_child(_actions, _frame.get_child_count() - 1)


func _notice_glyphs() -> void:
	for n in _notice_nodes:
		(n as PKeyPairNotice).size_glyph(self, 20.0)


## The list takes the room the card leaves. While a row is edited and the list cannot show them all,
## it shows that row alone; and on a screen too short even for that, the product's header collapses
## to one line (DL5: it is never removed) and the lede goes, so the edit's own primary is never
## below the fold.
func _fit_list(rows3: float, least: float) -> bool:
	var edited := (
		String(_snap.get("target", "")) if model.get("state") in ["renaming", "forgetting"] else ""
	)
	for id in _row_nodes:
		(_row_nodes[id]["holder"] as Control).visible = true
	# Short on room (the squeeze) the logo collapses to one line, the lede goes, the notices keep their
	# titles only and the gaps close, before anything scrolls.
	var squeeze := squeeze_level()
	_product.card = squeeze < 1
	_lede.visible = _lede.text != "" and squeeze < 1
	_frame.theme_type_variation = &"PKeyTight" if squeeze >= 2 else &"PKeySections"
	_side.theme_type_variation = &"PKeyTight" if squeeze >= 2 else &"PKeyStack"
	for n in _notice_nodes:
		(n as PKeyPairNotice).set_body_hidden(squeeze >= 2)
	_list_off = false
	# The list keeps three rows. It gives way in this order before the card would scroll: the lede, the
	# logo (one line), the notice's words; then the edited row alone.
	var steps: Array = [
		func() -> void: _lede.visible = false,
		func() -> void: _product.card = false,
		func() -> void: _column_head.visible = false,
		func() -> void:
			for n in _notice_nodes:
				(n as PKeyPairNotice).set_body_hidden(true),
	]
	var i := 0
	while i < steps.size() and PKeyListScroll.wanted(self, _list_scroll, _list_panel, rows3) > 0.0:
		steps[i].call()
		i += 1
	# "Can connect" over a row being edited or asked about would head nothing.
	if edited != "":
		_column_head.visible = false
	if edited != "" and PKeyListScroll.wanted(self, _list_scroll, _list_panel, least) > 0.0:
		for id in _row_nodes:
			(_row_nodes[id]["holder"] as Control).visible = id == edited
		_frame.theme_type_variation = &"PKeyTight"
		if PKeyListScroll.wanted(self, _list_scroll, _list_panel, least) > 0.0:
			_list_off = true
			return PKeyListScroll.pass_through(_list_scroll)
	# Whatever room is left is the list's, down to a row and a half: the controls under it stay on screen.
	return PKeyListScroll.apply(
		self, _list_scroll, _list_panel, least * (1.0 if squeeze_level() >= 3 else 1.5)
	)


## Buttons inside the list's own panel stack when they do not fit on a line.
func _fit_inner_actions(phone: bool) -> void:
	var room := PKeyListScroll.inner_room(self, _list_panel, _list_scroll)
	for id in _row_nodes:
		var r: Dictionary = _row_nodes[id]
		var line := r["holder"].get_node_or_null("Line") as BoxContainer
		for acts in r["holder"].find_children("Actions", "BoxContainer", true, false):
			var box := acts as BoxContainer
			var stack := (
				_line_width(box) > room * (0.5 if box.get_parent() == line else 1.0) + 0.5
				or (phone and box.get_parent() == line)
			)
			box.vertical = stack
			for ch in box.get_children():
				if ch is Control:
					(ch as Control).size_flags_horizontal = (
						Control.SIZE_FILL if stack else Control.SIZE_SHRINK_BEGIN
					)


func _line_width(b: BoxContainer) -> float:
	var total := 0.0
	var n := 0
	for ch in b.get_children():
		if ch is Control and (ch as Control).visible:
			total += (ch as Control).get_combined_minimum_size().x
			n += 1
	return total + maxf(0.0, n - 1.0) * float(b.get_theme_constant("separation"))


func _layout_stale() -> bool:
	return (
		not _list_off
		and PKeyListScroll.stale(
			self, _list_scroll, _list_panel, roundf(56.0 * float(layout_metrics()["scale"]))
		)
	)


# ── Presses ──────────────────────────────────────────────────────────────────────────────────


func _on_draft(text: String, id: String) -> void:
	if flow != null:
		flow.set_draft(text)
	action_pressed.emit("devices.renameLabel", {"id": id, "text": text})


func _on_switch(on: bool, id: String, sw: CheckButton, stuck: bool) -> void:
	if stuck and on:
		# The reason is on screen; the switch goes back.
		sw.set_pressed_no_signal(false)
		return
	_press("a11y.letConnect", {"id": id, "on": on})


func _on_notice_action(i: int) -> void:
	var key := String((_notice_nodes[i] as PKeyPairNotice).get_meta(&"pkey_key", ""))
	var n: Variant = _snap.get("notice")
	_press(key, {"id": n.get("id", "") if n is Dictionary else ""})


func _press(key: String, detail: Dictionary) -> void:
	if key == "":
		return
	if key == "pairedDevices.pair" and (model.get("disabled", []) as Array).has(key):
		return
	action_pressed.emit(key, detail)
	if flow == null:
		if key == "pairedDevices.pair":
			pair_requested.emit()
		elif key == "common.done":
			closed.emit()
		return
	var id := String(detail.get("id", ""))
	match key:
		"devices.rename":
			_prefer = "rename"
			flow.start_rename(id)
		"common.save":
			flow.save_rename()
		"pairedDevices.forget":
			if _snap.get("step") == "forgetting":
				flow.confirm_forget()
			else:
				_prefer = "forget"
				flow.ask_forget(id)
		"common.cancel":
			flow.cancel_edit()
		"a11y.letConnect":
			flow.set_reachable(id, bool(detail.get("on", false)))
		"common.tryAgain":
			if id != "":
				flow.report(id, "")
			flow.refresh()
		"pairedDevices.pair":
			flow.request_pair()
		"common.done":
			flow.done()


# ── Focus ────────────────────────────────────────────────────────────────────────────────────


## Focus returns to the row's first button after an edit, moves to the next row after a Forget, and goes
## to the title when no row is left. The model names the place once; it is applied once.
func _apply_focus_request() -> void:
	var at: Variant = _snap.get("focus")
	var sig := JSON.stringify(at) if at != null else ""
	if sig == _applied_focus:
		return
	_applied_focus = sig
	if at is Dictionary:
		if at.get("kind") == "title":
			_focus_when_ready("")
		else:
			_focus_when_ready(String(at.get("id", "")))


func _focus_when_ready(id: String) -> void:
	if not is_inside_tree():
		return
	_focus_row.call_deferred(id)


func _focus_row(id: String) -> void:
	var target: Control = _title
	if id != "" and _row_nodes.has(id):
		var r: Dictionary = _row_nodes[id]
		for k in ["field", _prefer, "rename", "forget", "switch"]:
			if r.has(k) and is_focusable(r[k]):
				target = r[k]
				break
	if target == _title:
		PKeyPairCode.focus_for_reader(_title)
		if (
			get_viewport().gui_get_focus_owner() == null
			or not is_ancestor_of(get_viewport().gui_get_focus_owner())
		):
			var fallback := _initial_focus()
			if fallback != null:
				fallback.grab_focus()
		return
	target.grab_focus()
	if target is LineEdit:
		(target as LineEdit).edit()


func _process(_delta: float) -> void:
	_tick_loading()
	if (
		model.get("state") == "loading"
		and _loading_since > 0
		and Time.get_ticks_msec() - _loading_since >= 300
		and (_skeleton == null or not _skeleton.visible)
	):
		refresh_view()


func _initial_focus() -> Control:
	for id in _row_nodes:
		var r: Dictionary = _row_nodes[id]
		if r.has("field"):
			return r["field"]
		if r.has("cancel") and r.has("forget"):
			return r["cancel"]
	# After an edit is cancelled or saved focus returns to the row, not to the screen's first control.
	var at: Variant = _snap.get("focus")
	if at is Dictionary and at.get("kind") == "row" and _row_nodes.has(String(at.get("id", ""))):
		var r: Dictionary = _row_nodes[String(at["id"])]
		for k in [_prefer, "rename", "forget", "switch"]:
			if r.has(k) and is_focusable(r[k]):
				return r[k]
	if is_focusable(_retry):
		return _retry
	if is_focusable(_pair) and not bool(_pair.get_meta(&"pkey_unavailable", false)):
		return _pair
	return _done if is_focusable(_done) else null


func _focus_chain() -> Array:
	var chain: Array = []
	for n in _notice_nodes:
		if (n as PKeyPairNotice).action_button() != null:
			chain.append((n as PKeyPairNotice).action_button())
	# Each row in the order it reads: the switch, Rename, Forget (or the field, Save, Cancel).
	for d: Dictionary in _snap.get("devices", []):
		var r: Dictionary = _row_nodes.get(String(d["id"]), {})
		for k in ROW_ORDER:
			if r.has(k) and not chain.has(r[k]):
				chain.append(r[k])
	return chain + [_retry, _pair, _done]


## Up and down keep to the same control of the next row, a column at a time (the switches, then Rename,
## then Forget, so down alone reaches every control); left and right walk the row.
func _after_wire() -> void:
	var rows: Array = []
	var cols := 0
	for d: Dictionary in _snap.get("devices", []):
		var r: Dictionary = _row_nodes.get(String(d["id"]), {})
		var ctls: Array = []
		for k in ROW_ORDER:
			if r.has(k) and is_focusable(r[k]):
				ctls.append(r[k])
		if not ctls.is_empty():
			rows.append(ctls)
			cols = maxi(cols, ctls.size())
	var foot: Control = null
	for b in [_retry, _pair, _done]:
		if is_focusable(b):
			foot = b
			break
	for i in rows.size():
		var ctls: Array = rows[i]
		for j in ctls.size():
			var c := ctls[j] as Control
			if j > 0:
				c.focus_neighbor_left = c.get_path_to(ctls[j - 1])
			if j + 1 < ctls.size():
				c.focus_neighbor_right = c.get_path_to(ctls[j + 1])
			if i > 0:
				var above: Array = rows[i - 1]
				c.focus_neighbor_top = c.get_path_to(above[mini(j, above.size() - 1)])
			elif j > 0:
				# The top of a column goes to the foot of the one before it.
				var last: Array = rows[rows.size() - 1]
				c.focus_neighbor_top = c.get_path_to(last[mini(j - 1, last.size() - 1)])
			if i + 1 < rows.size():
				var below: Array = rows[i + 1]
				c.focus_neighbor_bottom = c.get_path_to(below[mini(j, below.size() - 1)])
			elif j + 1 < ctls.size():
				var first: Array = rows[0]
				c.focus_neighbor_bottom = c.get_path_to(first[mini(j + 1, first.size() - 1)])
			elif foot != null:
				c.focus_neighbor_bottom = c.get_path_to(foot)


## Escape (or a pad's B) cancels an edit; elsewhere it is Done.
func _cancel() -> bool:
	if not visible:
		return false
	match String(model.get("state", "")):
		"renaming", "forgetting":
			_press("common.cancel", {"id": String(_snap.get("target", ""))})
		"hidden":
			return false
		_:
			_press("common.done", {})
	return true
