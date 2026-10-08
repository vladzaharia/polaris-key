class_name PKeySettingsPanel
extends PKeyUiView
## The player's settings, rendered from the config catalog's UI hints (rows and rules in
## PKeySettingsController): one inset grouped list per category, sorted by ui.order, one control
## per widget in a column of its own, "Reset to default" while the player's own value is in use,
## `dependsOn` rows hidden while their condition fails, advanced rows behind a toggle, hidden keys
## never shown.
##
## A row is a label column (the label, its description under it, a status only when the value is
## not the default: "Changed by you", "Set by the environment") and a control column of a fixed
## width. An enforced row shows its value as text with a lock and "Set by <the developer>" once.
## A number is a slider (a bounded range) or a stepper (an unbounded one) with visible minus and
## plus buttons; left and right on a pad change the value and the focus stays (up and down move).
##
## An edit writes PolarisKey.config's override store (the player's layer), so get_value() and
## get_source() change at once (source `local`). Without a store the panel installs an in-memory
## PKeyOverrideStore; give PolarisKey.config a PKeyConfigFileStore to keep the values across
## launches. Catalog labels and descriptions are the operator's data, passed through tr() so a
## game can still translate them.
##
## Layout (PKeyUiView): on a landscape panel, a focusable section rail on the left and the
## selected section's rows on the right (left and right on a pad move between them); on a portrait
## one every section in one column. The list scrolls only when it must, ending on a row boundary
## with a fade at the clipped edge, and following the focus with room for its ring.

## A setting was written (or reset) by the player.
signal setting_changed(key: String)

## Show advanced rows (the toggle's state).
var show_advanced := false
## Read from this PKeyConfig instead of `sdk.config` (tests).
var config: PKeyConfig = null

var rows: Array = []
## The section the rail has selected on a landscape panel (an index into the groups).
var section := 0

var _frame: VBoxContainer
var _product: PKeyProductHeader
var _body: BoxContainer
var _rail_panel: PanelContainer
var _rail: VBoxContainer
var _pane: PanelContainer
var _scroll: ScrollContainer
var _fade: TextureRect
var _inset: MarginContainer
var _powered_by: TextureRect
var _title: Label
var _empty: Label
var _advanced: CheckButton
var _list: VBoxContainer
var _signature := ""
var _controls := {}
var _groups: Array = []
var _rail_buttons: Array = []
var _bound: PKeyConfig = null
var _writing := false


func _build() -> void:
	name = "PKeySettingsPanel"
	_frame = vbox(card_panel("Card", false), "Frame", "PKeySections")
	var head := vbox(_frame, "Head", "PKeyTight")
	_product = product_header(head, "Product")
	_product.card = true
	_title = label(head, "Title", "PKeyTitle")
	_empty = label(head, "Empty", "PKeyMuted")
	_body = columns(_frame, "Body")
	_body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_rail_panel = PanelContainer.new()
	_rail_panel.name = "RailPanel"
	_rail_panel.theme_type_variation = "PKeyRail"
	_rail_panel.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	_body.add_child(_rail_panel)
	_rail = vbox(_rail_panel, "Rail", "PKeyTight")
	_pane = PanelContainer.new()
	_pane.name = "Pane"
	_pane.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_pane.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_pane.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_body.add_child(_pane)
	# A long catalog (or the advanced rows) scrolls instead of running off the screen. The scroll
	# follows the focus by hand (with room for the focus ring), never by the engine's rule.
	_scroll = ScrollContainer.new()
	_scroll.name = "Scroll"
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.follow_focus = false
	_pane.add_child(_scroll)
	# A fade over the clipped bottom edge, while there is more below.
	var g := Gradient.new()
	g.colors = PackedColorArray([Color.TRANSPARENT, Color.WHITE])
	var gt := GradientTexture2D.new()
	gt.gradient = g
	gt.fill_from = Vector2(0, 0)
	gt.fill_to = Vector2(0, 1)
	gt.width = 4
	gt.height = 24
	_fade = TextureRect.new()
	_fade.name = "Fade"
	_fade.texture = gt
	_fade.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_fade.stretch_mode = TextureRect.STRETCH_SCALE
	_fade.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_fade.size_flags_vertical = Control.SIZE_SHRINK_END
	_fade.custom_minimum_size.y = 24.0
	_fade.visible = false
	_pane.add_child(_fade)
	# Room for the scroll bar while it shows, so it never sits on the rows' controls.
	_inset = MarginContainer.new()
	_inset.name = "Inset"
	_inset.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_inset.size_flags_vertical = Control.SIZE_EXPAND | Control.SIZE_SHRINK_BEGIN
	_inset.minimum_size_changed.connect(layout_content)
	_scroll.add_child(_inset)
	_scroll.get_v_scroll_bar().visibility_changed.connect(func():
		_inset.add_theme_constant_override("margin_right", roundi(role("space_4")) if _scroll.get_v_scroll_bar().visible else 0))
	_scroll.get_v_scroll_bar().value_changed.connect(func(_v: float) -> void: _update_fade())
	var box := vbox(_inset, "Body", "PKeySections")
	_list = vbox(box, "Rows", "PKeySections")
	_advanced = CheckButton.new()
	_advanced.name = "AdvancedToggle"
	_advanced.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_advanced.set_meta(DISCLOSURE_META, true)
	_advanced.toggled.connect(func(on: bool):
		show_advanced = on
		refresh_view())
	box.add_child(_advanced)
	_powered_by = brand_node(_frame, "PoweredBy", BRAND_POWERED_BY)


func _bleeds() -> bool:
	return true


func _scrim_wanted() -> bool:
	return true


func _content() -> Control:
	return _card_box


func _screen_key() -> String:
	return "settings"


## The widest the list gets: a landscape panel is a wide card (rail and rows), a portrait one a list.
func _apply_width(width: float) -> void:
	if phone_bleed():
		super(0.0)
		return
	var content := _content()
	if content == null:
		return
	var want := role("card_width_wide") if is_landscape() else role("content_width")
	content.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	content.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	content.custom_minimum_size.x = minf(want, content_room().x)


func _arrange(m: Dictionary) -> void:
	var rail := is_landscape() and _groups.size() > 1 and not phone_bleed()
	_rail_panel.visible = rail and not _groups.is_empty()
	set_columns(_body, rail)
	for i in _groups.size():
		(_groups[i]["node"] as Control).visible = (not rail) or i == section
	for i in _rail_buttons.size():
		(_rail_buttons[i] as Button).set_pressed_no_signal(i == section)
	super(m)
	var stack := bool(m["phone"]) or content_room().x < role("card_width")
	for k in _controls:
		var n: Dictionary = _controls[k]
		(n["row"] as BoxContainer).vertical = stack
		(n["control"] as Control).custom_minimum_size.x = 0.0 if stack else role("card_width") * 0.42
		(n["control"] as Control).size_flags_horizontal = Control.SIZE_FILL if stack else Control.SIZE_SHRINK_END
		_size_control(n)
	# The list is as tall as its rows, up to the room the screen leaves, then scrolls: ending on a
	# row boundary so no row is cut in half.
	var room := available_height()
	room -= _frame_head_height()
	if _powered_by.visible:
		room -= _powered_by.get_combined_minimum_size().y + role("section_gap")
	room = maxf(room, 0.0)
	var need := _inset.get_combined_minimum_size().y
	var want := need
	if need > room:
		want = _row_boundary(room)
	if not is_equal_approx(_scroll.custom_minimum_size.y, want):
		_scroll.custom_minimum_size.y = want
	_update_fade()


func _frame_head_height() -> float:
	var h := 0.0
	for ch in _frame.get_children():
		if ch is Control and (ch as Control).visible and ch != _body and ch != _powered_by:
			h += (ch as Control).get_combined_minimum_size().y + float(_frame.get_theme_constant("separation"))
	if _rail_panel.visible and _body.vertical:
		h += _rail_panel.get_combined_minimum_size().y
	return h + float(_frame.get_theme_constant("separation"))


## The largest height up to `room` at which a whole row ends (the pane's own row boundaries).
func _row_boundary(room: float) -> float:
	var best := 0.0
	for k in _controls:
		var rowc := (_controls[k]["row"] as Control)
		if not rowc.is_visible_in_tree():
			continue
		var bottom := rowc.global_position.y + rowc.size.y - _inset.global_position.y
		if bottom <= room and bottom > best:
			best = bottom
	return best if best > 0.0 else room


func _update_fade() -> void:
	var bar := _scroll.get_v_scroll_bar()
	var more := _inset.get_combined_minimum_size().y > _scroll.size.y + 1.0 and bar.value + bar.page < bar.max_value - 1.0
	_fade.visible = more
	var c := Color.TRANSPARENT
	var ground := get_theme_stylebox("panel")
	if ground is StyleBoxFlat:
		c = (ground as StyleBoxFlat).bg_color
	if _card_box != null and _card_box.get_theme_stylebox("panel") is StyleBoxFlat:
		c = (_card_box.get_theme_stylebox("panel") as StyleBoxFlat).bg_color
	_fade.self_modulate = Color(c, 1.0)
	_fade.custom_minimum_size.y = roundf(24.0 * float(layout_metrics()["scale"]))


func _config() -> PKeyConfig:
	if config != null:
		return config
	if sdk != null and sdk.get("config") != null:
		return sdk.config
	return null


func _render() -> void:
	var cfg := _config()
	if cfg != _bound:
		if _bound != null and _bound.config_changed.is_connected(_on_config_changed):
			_bound.config_changed.disconnect(_on_config_changed)
		_bound = cfg
		if cfg != null:
			cfg.config_changed.connect(_on_config_changed)
	var t := c()
	rows = PKeySettingsController.rows(cfg)
	_product.refresh()
	_title.text = t.text("settings_title")
	var has_advanced := rows.any(func(r): return r["advanced"] and r["visible"])
	_advanced.visible = has_advanced
	_advanced.text = t.text("settings_advanced")
	_advanced.set_pressed_no_signal(show_advanced)
	var shown := rows.filter(func(r): return r["visible"] and (show_advanced or not r["advanced"]))
	show_text(_empty, t.text("settings_empty") if shown.is_empty() else "")
	var sig := JSON.stringify(shown.map(func(r): return [r["key"], r["widget"], r["editable"], r["reset"], r["category"], r["options"].size(), r["min"] > -1e8 and r["max"] < 1e8]))
	if sig != _signature:
		_rebuild(shown)
		_signature = sig
	_update_values(shown)


func _on_config_changed(_keys: PackedStringArray) -> void:
	if not _writing:
		refresh_view()


func _rebuild(shown: Array) -> void:
	var focused := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
	var focused_key := ""
	for k in _controls:
		if _controls[k].values().has(focused):
			focused_key = k
	for child in _list.get_children():
		_list.remove_child(child)
		child.queue_free()
	for b in _rail_buttons:
		(b as Node).queue_free()
	_rail_buttons.clear()
	_controls.clear()
	_groups.clear()
	var category = null
	var group: VBoxContainer = null
	for r in shown:
		if group == null or r["category"] != category:
			category = r["category"]
			# One inset grouped list per category: its heading above it, the groups a section apart.
			var holder := vbox(_list, "Group_%s" % _safe(category if category != "" else "General"), "PKeyTight")
			if category != "":
				var h := label(holder, "Category", "PKeyMuted", true)
				h.text = tr(category)
			var panel := PanelContainer.new()
			panel.name = "List"
			panel.theme_type_variation = "PKeyRail"
			holder.add_child(panel)
			group = vbox(panel, "Rows", "PKeySections")
			_groups.append({"node": holder, "category": category})
		_controls[r["key"]] = _row_nodes(group, r)
	if section >= _groups.size():
		section = 0
	for i in _groups.size():
		var name_text: String = _groups[i]["category"] if _groups[i]["category"] != "" else tr("settings_title")
		var b := Button.new()
		b.name = "Section_%d" % i
		b.text = tr(name_text)
		b.toggle_mode = true
		# 0 is the start edge (left to right); the layout direction mirrors it.
		b.alignment = 0 as HorizontalAlignment
		b.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		b.set_meta(DATA_META, true)
		# On a pad, the section follows the focus; accept keeps it.
		b.focus_entered.connect(func() -> void: _select_section(i))
		b.pressed.connect(func() -> void: _select_section(i))
		_rail.add_child(b)
		_rail_buttons.append(b)
	if focused_key != "" and _controls.has(focused_key):
		var input = _controls[focused_key].get("input")
		if input is Control:
			(input as Control).grab_focus.call_deferred()


func _select_section(i: int) -> void:
	if i == section:
		return
	section = i
	layout_content()


func _row_nodes(group: Node, r: Dictionary) -> Dictionary:
	var key: String = r["key"]
	# A label column and a control column; stacked on a narrow panel.
	var row := BoxContainer.new()
	row.name = "Row_%s" % _safe(key)
	row.theme_type_variation = "PKeyActionRow"
	group.add_child(row)
	var text := vbox(row, "Text", "PKeyTight")
	text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var name_label := label(text, "Label", "PKeyStrong", true)
	var status := label(text, "Status", "PKeyMuted")
	var desc := label(text, "Description", "PKeyMuted", true)
	var lock_row := hbox(text, "Locked")
	var lock := glyph_node(lock_row, "Lock", "lock")
	var set_by := label(lock_row, "SetBy", "PKeyMuted", true)
	var control := vbox(row, "Control", "PKeyTight")
	control.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var line := hbox(control, "Line")
	var input := _make_input(line, r)
	var reset := button(control, "Reset", func(): _reset(key), "PKeyLink")
	reset.size_flags_horizontal = Control.SIZE_SHRINK_END
	var out := {"row": row, "text": text, "label": name_label, "status": status, "description": desc, "lock_row": lock_row, "lock": lock, "set_by": set_by, "control": control, "line": line, "input": input, "reset": reset}
	out.merge(input_parts.get(input, {}), true)
	return out


## Per-input extras (minus and plus buttons, a slider's value label), keyed by the input.
var input_parts := {}


func _make_input(parent: Node, r: Dictionary) -> Control:
	var key: String = r["key"]
	var ctl: Control
	if not r["editable"]:
		# An enforced or read-only value is text, never a dimmed control.
		var l := Label.new()
		l.theme_type_variation = &"PKeyStrong"
		l.set_meta(DATA_META, true)
		l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		ctl = l
		ctl.name = "Input"
		ctl.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		parent.add_child(ctl)
		return ctl
	match r["widget"]:
		"switch":
			var cb := CheckButton.new()
			cb.toggled.connect(func(on: bool): _write(key, on))
			ctl = cb
		"stepper":
			var step: float = r["step"]
			var bounded: bool = r["min"] > -1e8 and r["max"] < 1e8
			var parts := {}
			var minus := Button.new()
			minus.name = "Minus"
			minus.text = "−"
			minus.set_meta(DATA_META, true)
			minus.focus_mode = Control.FOCUS_NONE
			minus.set_meta(FREE_HEIGHT_META, true)
			parent.add_child(minus)
			if bounded:
				var sl := HSlider.new()
				sl.min_value = r["min"]
				sl.max_value = r["max"]
				sl.step = step
				sl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
				sl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
				sl.value_changed.connect(func(v: float): _write(key, int(v) if r["integer"] else v))
				ctl = sl
			else:
				var sp := SpinBox.new()
				sp.min_value = r["min"]
				sp.max_value = r["max"]
				sp.step = step
				sp.rounded = r["integer"]
				sp.suffix = r["unit"]
				sp.size_flags_horizontal = Control.SIZE_EXPAND_FILL
				sp.value_changed.connect(func(v: float): _write(key, int(v) if r["integer"] else v))
				# Left and right are minus and plus a step on a pad; up and down still move focus.
				sp.get_line_edit().gui_input.connect(func(e: InputEvent) -> void:
					if e.is_action_pressed("ui_left") or e.is_action_pressed("ui_right"):
						sp.value += step * (1.0 if e.is_action_pressed("ui_right") else -1.0)
						sp.get_line_edit().accept_event())
				ctl = sp
			ctl.name = "Input"
			ctl.set_meta(DATA_META, true)
			ctl.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
			parent.add_child(ctl)
			var plus := Button.new()
			plus.name = "Plus"
			plus.text = "+"
			plus.set_meta(DATA_META, true)
			plus.focus_mode = Control.FOCUS_NONE
			plus.set_meta(FREE_HEIGHT_META, true)
			parent.add_child(plus)
			var value := Label.new()
			value.name = "Value"
			value.set_meta(DATA_META, true)
			value.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
			value.visible = bounded
			parent.add_child(value)
			minus.pressed.connect(func(): _nudge(ctl, -step))
			plus.pressed.connect(func(): _nudge(ctl, step))
			parts = {"minus": minus, "plus": plus, "value": value, "bounded": bounded}
			input_parts[ctl] = parts
			_keep_focus_on_sides(ctl)
			return ctl
		"select":
			var ob := OptionButton.new()
			for i in r["options"].size():
				ob.add_item(tr(r["options"][i][1]), i)
			var opts: Array = r["options"]
			ob.item_selected.connect(func(i: int): _write(key, opts[i][0]))
			ob.set_meta(DATA_META, true)
			ctl = ob
		"textarea":
			var te := TextEdit.new()
			te.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
			tab_leaves(te)
			te.focus_exited.connect(func(): _write_text(key, te.text))
			ctl = te
		"password", "text":
			var le := LineEdit.new()
			le.secret = r["widget"] == "password"
			le.placeholder_text = tr(r["placeholder"])
			le.text_submitted.connect(func(t: String): _write_text(key, t))
			le.focus_exited.connect(func(): _write_text(key, le.text))
			ctl = le
		_:
			var l := Label.new()
			l.set_meta(DATA_META, true)
			ctl = l
	ctl.name = "Input"
	# The value (and a catalog placeholder) is data, not copy.
	ctl.set_meta(DATA_META, true)
	ctl.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	ctl.size_flags_horizontal = Control.SIZE_EXPAND_FILL if not (ctl is CheckButton) else Control.SIZE_SHRINK_BEGIN
	parent.add_child(ctl)
	ctl.focus_entered.connect(func() -> void: _ensure_visible(ctl))
	return ctl


## Left and right change the value; the focus stays on the control.
func _keep_focus_on_sides(ctl: Control) -> void:
	var target: Control = (ctl as SpinBox).get_line_edit() if ctl is SpinBox else ctl
	target.focus_entered.connect(func() -> void:
		target.focus_neighbor_left = target.get_path_to(target)
		target.focus_neighbor_right = target.get_path_to(target)
		_ensure_visible(target))


func _nudge(ctl: Control, by: float) -> void:
	if ctl is Range:
		(ctl as Range).value += by


## Scroll so `ctl`'s row is fully in view with room for its focus ring and the gap to the next row.
func _ensure_visible(ctl: Control) -> void:
	if not is_inside_tree() or not _scroll.is_visible_in_tree():
		return
	var row: Control = ctl
	while row != null and row.get_parent() != null and not (row.get_parent() is VBoxContainer and row.get_parent().name == "Rows"):
		row = row.get_parent_control()
	if row == null:
		return
	var margin := float(PKeyUiTheme.RING_WIDTH + PKeyUiTheme.RING_OFFSET) + role("section_gap")
	var top := row.global_position.y - _inset.global_position.y - margin
	var bottom := row.global_position.y + row.size.y - _inset.global_position.y + margin
	if top < _scroll.scroll_vertical:
		_scroll.scroll_vertical = maxi(0, int(top))
	elif bottom > _scroll.scroll_vertical + _scroll.size.y:
		_scroll.scroll_vertical = int(bottom - _scroll.size.y)


func _size_control(n: Dictionary) -> void:
	var h := role("control_height")
	for k in ["minus", "plus"]:
		if n.has(k):
			(n[k] as Control).custom_minimum_size = Vector2(h, h)
	if n.has("input") and n["input"] is HSlider:
		(n["input"] as Control).custom_minimum_size = Vector2(role("space_10") * 2.0, h * 0.5)
	if n["input"] is TextEdit:
		(n["input"] as Control).custom_minimum_size.y = roundf(h * 1.5)
	size_glyph(n["lock"], 14.0, get_theme_color("font_color", "PKeyMuted"))


func _update_values(shown: Array) -> void:
	var t := c()
	var product := PKeySettingsController.product_name(sdk)
	for r in shown:
		var n: Dictionary = _controls.get(r["key"], {})
		if n.is_empty():
			continue
		var name_label: Label = n["label"]
		name_label.text = tr(r["label"])
		var input: Control = n["input"]
		var v = r["value"]
		if input is CheckButton:
			(input as CheckButton).set_pressed_no_signal(v == true)
		elif input is HSlider:
			(input as HSlider).set_value_no_signal(float(v) if PKeyClaims.is_number(v) else 0.0)
			var unit: String = r["unit"]
			(n["value"] as Label).text = "%s%s" % [("%d" % int(v)) if r["integer"] and PKeyClaims.is_number(v) else str(v), (" " + unit) if unit != "" else ""]
		elif input is SpinBox:
			(input as SpinBox).set_value_no_signal(float(v) if PKeyClaims.is_number(v) else 0.0)
		elif input is OptionButton:
			var idx := -1
			for i in r["options"].size():
				if PKeyConfig._same(r["options"][i][0], v):
					idx = i
			(input as OptionButton).select(idx)
		elif input is TextEdit:
			if not input.has_focus():
				(input as TextEdit).text = str(v) if v != null else ""
		elif input is LineEdit:
			if not input.has_focus():
				(input as LineEdit).text = str(v) if v != null else ""
		elif input is Label:
			(input as Label).text = _show_value(v, r)
		# A quiet status only when the value is not the default; nothing for a default.
		var badge: String = r["badge"]
		var status_key := "settings_source_local" if badge == "settings_badge_local" else ("settings_source_env" if badge == "settings_badge_env" else "")
		show_text(n["status"], t.text(status_key) if status_key != "" else "")
		var reset: Button = n["reset"]
		reset.visible = r["reset"]
		reset.text = t.text("settings_reset")
		# A locked row: its value, a lock and who set it, once; the description only when it says
		# something else.
		var locked: bool = r["enforced"]
		(n["lock_row"] as Control).visible = locked and product != ""
		(n["set_by"] as Label).text = t.text("settings_set_by", product) if locked and product != "" else ""
		var d: String = r["description"]
		var repeats := locked and (d.to_lower().contains("set by") or d == "")
		show_text(n["description"], tr(d) if d != "" and not repeats else "")
		if input is Control and not locked:
			input.tooltip_text = ""
		for k in ["minus", "plus"]:
			if n.has(k):
				(n[k] as Button).disabled = not r["editable"]


static func _show_value(v: Variant, r: Dictionary) -> String:
	if v is bool:
		return "On" if v else "Off"
	if v == null:
		return ""
	var unit: String = r.get("unit", "")
	return ("%s %s" % [str(v), unit]) if unit != "" else (JSON.stringify(v) if v is Dictionary or v is Array else str(v))


func _focus_chain() -> Array:
	var out: Array = []
	if _rail_panel.visible:
		out.append_array(_rail_buttons)
	for k in _controls:
		var n: Dictionary = _controls[k]
		var input = n["input"]
		if input is Label:
			continue
		out.append((input as SpinBox).get_line_edit() if input is SpinBox else input)
		out.append(n["reset"])
	out.append(_advanced)
	return out


## Left on a row's first control goes to the rail, and right on the rail goes into the rows (a pad).
func _after_wire() -> void:
	if not _rail_panel.visible or _rail_buttons.is_empty():
		return
	var rail_btn: Button = _rail_buttons[clampi(section, 0, _rail_buttons.size() - 1)]
	var first: Control = null
	for ctl in focus_order():
		if not _rail_buttons.has(ctl):
			first = ctl
			break
	for b in _rail_buttons:
		if first != null:
			(b as Control).focus_neighbor_right = (b as Control).get_path_to(first)
		(b as Control).focus_neighbor_left = (b as Control).get_path_to(b)
	if first != null:
		for ctl in focus_order():
			if _rail_buttons.has(ctl):
				continue
			if ctl.focus_neighbor_left.is_empty() or ctl.focus_neighbor_left == ctl.get_path_to(ctl) and not (ctl is HSlider or ctl is LineEdit):
				pass
		# The first control of each row steps left to the rail.
		for k in _controls:
			var inp = _controls[k]["input"]
			var target: Control = (inp as SpinBox).get_line_edit() if inp is SpinBox else inp
			if target is Control and not (inp is HSlider or inp is SpinBox) and is_focusable(target):
				target.focus_neighbor_left = target.get_path_to(rail_btn)


## The first rail button when there is one, else the first row's control.
func _initial_focus() -> Control:
	var chain := focus_order()
	for ctl in chain:
		if not _rail_buttons.has(ctl):
			return ctl
	return chain[0] if not chain.is_empty() else null


## The store edits go to: PolarisKey.config's, else a new in-memory one installed there.
func _store(cfg: PKeyConfig) -> PKeyOverrideStore:
	var store := cfg.get_override_store()
	if store == null:
		store = PKeyOverrideStore.new()
		cfg.set_override_store(store)
	return store


func _accessor(cfg: PKeyConfig, key: String) -> String:
	var e := cfg.catalog_entry(key)
	return e["accessor"] if e.get("accessor") is String else ""


func _write(key: String, value: Variant) -> void:
	var cfg := _config()
	if cfg == null:
		return
	var r = rows.filter(func(x): return x["key"] == key)
	if r.is_empty() or not r[0]["editable"]:
		return
	if PKeyConfig._same(r[0]["value"], value) and r[0]["source"] == &"local":
		return
	_writing = true
	_store(cfg).set_override(key, value, _accessor(cfg, key))
	_writing = false
	refresh_view()
	setting_changed.emit(key)


func _write_text(key: String, text: String) -> void:
	var r = rows.filter(func(x): return x["key"] == key)
	if r.is_empty() or str(r[0]["value"]) == text:
		return
	_write(key, text)


func _reset(key: String) -> void:
	var cfg := _config()
	if cfg == null:
		return
	_writing = true
	_store(cfg).clear_override(key, _accessor(cfg, key))
	_writing = false
	refresh_view()
	setting_changed.emit(key)


static func _safe(s: String) -> String:
	return s.validate_node_name().replace(".", "_").replace(" ", "_")
