class_name PKeySettingsPanel
extends PKeyUiView
## The player's settings, rendered from the config catalog's UI hints (rows and rules in
## PKeySettingsController): grouped by category, sorted by ui.order, one control per widget,
## enforced rows disabled with a lock and "Set by <product>", a provenance badge on every row,
## "Reset to default" while the player's own value is in use, `dependsOn` rows hidden while their
## condition fails, advanced rows behind a toggle, hidden keys never shown.
##
## An edit writes PolarisKey.config's override store (the player's layer), so get_value() and
## get_source() change at once (source `local`). Without a store the panel installs an in-memory
## PKeyOverrideStore; give PolarisKey.config a PKeyConfigFileStore to keep the values across
## launches. Catalog labels and descriptions are the operator's data, passed through tr() so a
## game can still translate them.

## A setting was written (or reset) by the player.
signal setting_changed(key: String)

## Show advanced rows (the toggle's state).
var show_advanced := false
## Read from this PKeyConfig instead of `sdk.config` (tests).
var config: PKeyConfig = null

var rows: Array = []

var _frame: VBoxContainer
var _scroll: ScrollContainer
var _inset: MarginContainer
var _powered_by: TextureRect
var _title: Label
var _empty: Label
var _advanced: CheckButton
var _list: VBoxContainer
var _signature := ""
var _controls := {}
var _bound: PKeyConfig = null
var _writing := false


func _build() -> void:
	name = "PKeySettingsPanel"
	max_content_width = 640.0
	# A long catalog (or the advanced rows) scrolls instead of running off the screen; a gamepad
	# focusing a row below the fold scrolls it into view. The Powered-by badge sits below the
	# scroll area, never scrolled away.
	_frame = vbox(self, "Frame", 12)
	_scroll = ScrollContainer.new()
	_scroll.name = "Scroll"
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.follow_focus = true
	_frame.add_child(_scroll)
	# Room for the scroll bar while it shows, so it never sits on the rows' controls.
	_inset = MarginContainer.new()
	_inset.name = "Inset"
	_inset.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_inset.size_flags_vertical = Control.SIZE_EXPAND | Control.SIZE_SHRINK_CENTER
	_inset.minimum_size_changed.connect(layout_content)
	_scroll.add_child(_inset)
	_scroll.get_v_scroll_bar().visibility_changed.connect(func():
		_inset.add_theme_constant_override("margin_right", 12 if _scroll.get_v_scroll_bar().visible else 0))
	var box := vbox(_inset, "Body", 12)
	_title = label(box, "Title", "PKeyTitle")
	_empty = label(box, "Empty", "PKeyMuted")
	_list = vbox(box, "Rows", 14)
	_advanced = CheckButton.new()
	_advanced.name = "AdvancedToggle"
	_advanced.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_advanced.set_meta(DISCLOSURE_META, true)
	_advanced.toggled.connect(func(on: bool):
		show_advanced = on
		refresh_view())
	box.add_child(_advanced)
	_powered_by = brand_node(_frame, "PoweredBy", BRAND_POWERED_BY)


func _content() -> Control:
	return _frame


## The scroll area is as tall as the rows, up to the room the viewport leaves (less the gutters,
## this view's padding and the badge below), then scrolls; it fills whatever height a parent
## gives it.
func _apply_width(width: float) -> void:
	super(width)
	var room := INF
	if is_inside_tree():
		var box := get_theme_stylebox("panel")
		var pad := box.get_margin(SIDE_TOP) + box.get_margin(SIDE_BOTTOM) if box != null else 0.0
		if _powered_by.visible:
			pad += _powered_by.get_combined_minimum_size().y + _frame.get_theme_constant("separation")
		room = maxf(0.0, get_viewport_rect().size.y - pad - 2.0 * GUTTER)
	var want := minf(_inset.get_combined_minimum_size().y, room)
	if not is_equal_approx(_scroll.custom_minimum_size.y, want):
		_scroll.custom_minimum_size.y = want
	_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL if width <= 0.0 else Control.SIZE_FILL


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
	_title.text = t.text("settings_title")
	var has_advanced := rows.any(func(r): return r["advanced"] and r["visible"])
	_advanced.visible = has_advanced
	_advanced.text = t.text("settings_advanced")
	_advanced.set_pressed_no_signal(show_advanced)
	var shown := rows.filter(func(r): return r["visible"] and (show_advanced or not r["advanced"]))
	show_text(_empty, t.text("settings_empty") if shown.is_empty() else "")
	var sig := JSON.stringify(shown.map(func(r): return [r["key"], r["widget"], r["editable"], r["reset"], r["category"], r["options"].size()]))
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
	_controls.clear()
	var category = null
	for r in shown:
		if r["category"] != category:
			category = r["category"]
			if category != "":
				var h := label(_list, "Category_%s" % _safe(category), "PKeyMuted", true)
				h.text = tr(category)
		_controls[r["key"]] = _row_nodes(r)
	if focused_key != "" and _controls.has(focused_key):
		var input = _controls[focused_key].get("input")
		if input is Control:
			(input as Control).grab_focus.call_deferred()


func _row_nodes(r: Dictionary) -> Dictionary:
	var key: String = r["key"]
	var row := vbox(_list, "Row_%s" % _safe(key), 4)
	# A flow line: on a narrow screen the badge and Reset wrap below instead of squeezing the name.
	var line := HFlowContainer.new()
	line.name = "Line"
	line.add_theme_constant_override("v_separation", 6)
	row.add_child(line)
	var name_label := label(line, "Label", "", true)
	name_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	var input := _make_input(line, r)
	var badge := label(line, "Badge", "PKeyBadge")
	badge.autowrap_mode = TextServer.AUTOWRAP_OFF
	var reset := button(line, "Reset", func(): _reset(key))
	var set_by := label(row, "SetBy", "PKeyMuted")
	var desc := label(row, "Description", "PKeyMuted", true)
	return {"row": row, "label": name_label, "input": input, "badge": badge, "reset": reset, "set_by": set_by, "description": desc}


func _make_input(parent: Node, r: Dictionary) -> Control:
	var key: String = r["key"]
	var ctl: Control
	match r["widget"]:
		"switch":
			var cb := CheckButton.new()
			cb.toggled.connect(func(on: bool): _write(key, on))
			ctl = cb
		"stepper":
			var sp := SpinBox.new()
			sp.min_value = r["min"]
			sp.max_value = r["max"]
			sp.step = r["step"]
			sp.rounded = r["integer"]
			sp.suffix = r["unit"]
			sp.value_changed.connect(func(v: float): _write(key, int(v) if r["integer"] else v))
			ctl = sp
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
			te.custom_minimum_size = Vector2(240, 80)
			te.focus_exited.connect(func(): _write_text(key, te.text))
			ctl = te
		"password", "text":
			var le := LineEdit.new()
			le.secret = r["widget"] == "password"
			le.placeholder_text = tr(r["placeholder"])
			le.custom_minimum_size = Vector2(200, 0)
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
	parent.add_child(ctl)
	return ctl


func _update_values(shown: Array) -> void:
	var t := c()
	var product := PKeySettingsController.product_name(sdk)
	for r in shown:
		var n: Dictionary = _controls.get(r["key"], {})
		if n.is_empty():
			continue
		var name_label: Label = n["label"]
		name_label.text = tr(r["label"])
		# About 8 em, so a long name ("Message of the day") wraps by words, never a syllable a line.
		name_label.custom_minimum_size.x = 8.0 * name_label.get_theme_font_size("font_size")
		var input: Control = n["input"]
		var v = r["value"]
		if input is CheckButton:
			(input as CheckButton).set_pressed_no_signal(v == true)
			(input as CheckButton).disabled = not r["editable"]
		elif input is SpinBox:
			(input as SpinBox).set_value_no_signal(float(v) if PKeyClaims.is_number(v) else 0.0)
			(input as SpinBox).editable = r["editable"]
		elif input is OptionButton:
			var idx := -1
			for i in r["options"].size():
				if PKeyConfig._same(r["options"][i][0], v):
					idx = i
			(input as OptionButton).select(idx)
			(input as OptionButton).disabled = not r["editable"]
		elif input is TextEdit:
			if not input.has_focus():
				(input as TextEdit).text = str(v) if v != null else ""
			(input as TextEdit).editable = r["editable"]
		elif input is LineEdit:
			if not input.has_focus():
				(input as LineEdit).text = str(v) if v != null else ""
			(input as LineEdit).editable = r["editable"]
		elif input is Label:
			(input as Label).text = JSON.stringify(v)
		var badge: Label = n["badge"]
		show_text(badge, t.text(r["badge"]) if r["badge"] != "" else "")
		var reset: Button = n["reset"]
		reset.visible = r["reset"]
		reset.text = t.text("settings_reset")
		var set_by: Label = n["set_by"]
		show_text(set_by, t.text("settings_set_by", product) if r["enforced"] and product != "" else "")
		input.tooltip_text = set_by.text if r["enforced"] else ""
		show_text(n["description"], tr(r["description"]) if r["description"] != "" else "")


func _focus_chain() -> Array:
	var out: Array = []
	for k in _controls:
		var n: Dictionary = _controls[k]
		var input = n["input"]
		out.append((input as SpinBox).get_line_edit() if input is SpinBox else input)
		out.append(n["reset"])
	out.append(_advanced)
	return out


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
