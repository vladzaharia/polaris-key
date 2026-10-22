class_name PKeyDeviceList
extends PKeyUiView
## The devices using this license (UI-KITS.md §4.1 Devices; React's `<Devices>` and the ui-core
## `devices` model are the reference): each device is a 64 px row with a form-factor glyph, its name
## (or "Unnamed device"), a "This <form factor>" tag on the row the runtime knows is this device, the
## platform and when it was last used, and Rename and Remove beside it. Rename edits in place (a text
## field, Save and Cancel under the row's name); Remove confirms in place ("Remove Work laptop? It
## signs out of Tidewater."), never in a dialog. A pad reaches every row's buttons with up and down
## and left and right, and B or Escape cancels an edit.
##
## States (the model's, ui-matrix.json `devices`): loading (nothing for the first 250 ms, DL7), list,
## renaming, confirming, empty, browser-mode (device management is in the browser only: one primary
## opens the portal) and error (a failed load is "Couldn't load your devices." with Try again, never
## "No devices"; a failed edit is said under its row).
##
## `show_devices()` drives it with rows (`{name, platform, formFactor, lastSeenDays, current, id?}`,
## see PKeyDevicesController); with an SDK `refresh_roster()` loads PolarisKey.devices.list() into it.
## The server lets a device rename and sign out only itself, so a list loaded from the SDK edits only
## this device's name and offers no Remove; a game that manages the others (the portal API, its own
## backend) sets `host_handles`, listens to `rename_requested` and `remove_requested`, and answers
## with `edit_succeeded()` or `edit_failed()`.

## The player saved a new name (an empty name clears it). `device` is the row.
signal rename_requested(device: Dictionary, label: String)
## The player confirmed removing a device.
signal remove_requested(device: Dictionary)
## The player chose Manage devices (browser mode): the portal link, when `manage_url` is set, opens.
signal manage_requested()
## The player chose Try again after a failed load.
signal retry_requested()
## The list changed (loaded, renamed, a device removed).
signal changed()

## Load PolarisKey.devices.list() when the view enters the tree and has an SDK.
@export var auto_load := true
## The portal page browser mode opens ("" opens nothing; the button still emits `manage_requested`).
@export var manage_url := ""
## The game answers `rename_requested` and `remove_requested` itself, for every row.
var host_handles := false
## Lead with the product's header (off where a host card already shows it).
var show_product := true:
	set(value):
		if show_product != value:
			show_product = value
			if _built:
				refresh_view()
## The enabled services (tools/services.json slugs); empty: all. Without "license" the view is hidden.
var services: Array = []
## `func() -> float` epoch seconds (tests); empty: the SDK's effective clock, else the system's.
var now_source: Callable = Callable()

## The rows the view shows (`{id?, name, platform, formFactor, lastSeenDays, current}`).
var devices: Array = []
var loading := false
var error: Variant = null
var browser_mode := false
var model: Dictionary = {}

var _frame: VBoxContainer
var _product: PKeyProductHeader
var _title_row: HBoxContainer
var _title: Label
var _count: Label
var _lede: Label
var _message: Label
var _fail: Label
var _actions: BoxContainer
var _retry: Button
var _manage: Button
var _list_scroll: ScrollContainer
var _list_panel: PanelContainer
var _rows: VBoxContainer
var _edit := {}
var _busy := false
var _self_only := false
var _signature := ""
var _lede_shown := false
var _list_off := false
var _row_nodes: Array = []
var _focus_path := ""


func _build() -> void:
	name = "PKeyDeviceList"
	_frame = vbox(card_panel(), "Frame", "PKeySections")
	var head := vbox(_frame, "Head", "PKeyStack")
	_product = product_header(head, "Product")
	_product.card = true
	var titles := vbox(head, "Titles", "PKeyTight")
	_title_row = hbox(titles, "TitleRow")
	_title = label(_title_row, "Title", "PKeyTitle")
	_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_count = label(_title_row, "Count", "PKeyBadge")
	_count.autowrap_mode = TextServer.AUTOWRAP_OFF
	_count.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_lede = label(titles, "Lede", "PKeyMuted")
	loading_bar(_frame)
	_message = label(_frame, "Message", "PKeyMuted")
	_fail = label(_frame, "Failure", "PKeyError")
	_list_scroll = PKeyListScroll.make(_frame, "ListScroll")
	_list_panel = PanelContainer.new()
	_list_panel.name = "List"
	_list_panel.theme_type_variation = "PKeyRail"
	_list_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_list_scroll.add_child(_list_panel)
	_rows = vbox(_list_panel, "Rows", "PKeyTight")
	_actions = actions_row(_frame, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_retry = button(_actions, "Retry", _on_retry, "PKeyPrimary")
	_manage = button(_actions, "Manage", _on_manage, "PKeyPrimary")
	# The web layout's cap (UI-KITS.md §4.3): wide enough for a row's words and its two buttons.
	max_content_width = 640.0


func _ready() -> void:
	super()
	if auto_load and sdk != null and sdk.get("devices") != null and devices.is_empty() and not loading:
		refresh_roster.call_deferred()


func _process(_delta: float) -> void:
	_tick_loading()
	if loading and _loading_due() and not _frame.visible:
		refresh_view()


## DL7: a wait shows nothing for its first 250 ms.
func _loading_due() -> bool:
	return _loading_since > 0 and Time.get_ticks_msec() - _loading_since >= 250


## On a phone the page is the card, edge to edge (DL1: full-bleed, top-aligned).
func _bleeds() -> bool:
	return true


func _screen_key() -> String:
	return "%s|%s|%s" % [String(model.get("state", "")), _edit.get("kind", ""), _edit.get("index", -1)]


# ── Data ─────────────────────────────────────────────────────────────────────────────────────

## Show these rows (`{id?, name, platform, formFactor, lastSeenDays, current}`), ending any load,
## error or edit.
func show_devices(rows: Array) -> void:
	devices = rows
	loading = false
	error = null
	_edit = {}
	_busy = false
	refresh_view()
	changed.emit()


func show_loading() -> void:
	loading = true
	refresh_view()


## A failed load (`code` an error code) or, while an edit is open, a failed edit.
func show_error(code: Variant = "device_list_failed") -> void:
	loading = false
	error = {"code": str(code)}
	_busy = false
	PKeyUiFeedback.emit(&"error")
	refresh_view()


## Device management is in the browser only: say so, with one primary opening the portal.
func show_browser_mode() -> void:
	browser_mode = true
	loading = false
	refresh_view()


## Load the roster from PolarisKey.devices.list() (a coroutine).
func refresh_roster() -> void:
	if sdk == null or sdk.get("devices") == null:
		return
	loading = true
	error = null
	refresh_view()
	var r: PKeyResult = await sdk.devices.list()
	if not is_inside_tree():
		return
	if not r.ok:
		show_error(r.code)
		return
	var detail: Dictionary = r.detail
	# A roster fetched with a token lists this license's devices; the server lets each rename and sign
	# out only itself.
	_self_only = not host_handles
	show_devices(PKeyDevicesController.rows(detail, _now()))


func _now() -> float:
	if now_source.is_valid():
		return float(now_source.call())
	if sdk != null and sdk.get("core") != null and sdk.core.clock != null:
		return sdk.core.clock.now()
	return Time.get_unix_time_from_system()


## The host answers an edit it handled: the new name (or null after a removal) is applied to the row.
func edit_succeeded(new_label: Variant = null) -> void:
	_apply_edit(new_label)


## The host answers an edit it could not do: the failure is said under its row.
func edit_failed(code: Variant = "") -> void:
	_busy = false
	var kind := String(_edit.get("kind", ""))
	error = {"code": str(code) if str(code) != "" else ("device_rename_failed" if kind == "rename" else "device_deauthorize_failed")}
	refresh_view()


# ── The model ────────────────────────────────────────────────────────────────────────────────

func _model_input() -> Dictionary:
	var edit := {}
	if not _edit.is_empty():
		edit = {"kind": _edit["kind"], "device": _name_of(devices[_edit["index"]]) if _edit["index"] < devices.size() else ""}
	var elapsed: Variant = null
	if loading and _loading_since > 0:
		elapsed = Time.get_ticks_msec() - _loading_since
	var extra := {}
	if not services.is_empty():
		extra["services"] = services
	return PKeyDevicesController.input(devices, edit, error, loading, browser_mode, elapsed, extra)


## A row's name as the strings say it: its name, else "Unnamed device".
func _name_of(row: Dictionary) -> String:
	var n = row.get("name")
	return String(n) if n is String and n != "" else c().text("devices_unnamed")


# ── Rendering ────────────────────────────────────────────────────────────────────────────────

func _render() -> void:
	var t := c()
	set_loading(loading)
	model = PKeyDevicesController.view(_model_input())
	var state := String(model.get("state", "list"))
	var hidden := state == "hidden"
	visible = not hidden
	# DL7: nothing shows for a load's first 250 ms; then the title, a label and the shimmer.
	var waiting := state == "loading" and not _loading_due()
	_frame.visible = not hidden and not waiting
	if show_product:
		_product.refresh()
	else:
		_product.visible = false
	show_text(_title, t.text("devices_title") if not hidden else "")
	var listing := state in ["list", "renaming", "confirming"]
	show_text(_lede, t.text("devices_lede") if listing else "")
	show_text(_count, (t.text("devices_count_one", 1) if devices.size() == 1 else t.text("devices_count", devices.size())) if listing else "")
	_lede_shown = _lede.visible
	var message := ""
	match state:
		"loading":
			message = t.text("loading")
		"empty":
			message = t.text("devices_empty")
		"browser-mode":
			message = t.text("devices_browser")
		"error":
			# A failed edit is said under its row; only a failed load stands alone.
			message = t.text("devices_load_failed") if _edit.is_empty() else ""
	show_text(_message, message)
	show_text(_fail, "")
	_retry.disabled = false
	show_text(_retry, t.text("retry") if state == "error" and _edit.is_empty() else "")
	show_text(_manage, t.text("devices_manage") if state == "browser-mode" else "")
	_list_scroll.visible = listing or (state == "error" and not _edit.is_empty())
	var sig := JSON.stringify([devices, _edit, error, state, _self_only, host_handles, _busy])
	if sig != _signature:
		_signature = sig
		_rebuild(listing or (state == "error" and not _edit.is_empty()))
	if not _focus_path.is_empty():
		var again := get_node_or_null(NodePath(_focus_path)) as Control
		_focus_path = ""
		if again != null:
			again.grab_focus.call_deferred()


func _can_rename(row: Dictionary) -> bool:
	return host_handles or not _self_only or bool(row.get("current", false))


func _can_remove(row: Dictionary) -> bool:
	# The device a list is read on cannot remove itself here (that is Sign out); a roster read through
	# the SDK offers no Remove at all.
	return host_handles or not _self_only and not bool(row.get("current", false))


func _rebuild(show: bool) -> void:
	var held := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
	if _focus_path.is_empty() and held != null and _rows.is_ancestor_of(held):
		_focus_path = String(get_path_to(held))
	# The rows' action rows go with them (the base fits the action rows it was given).
	_action_rows = _action_rows.filter(func(r: Variant) -> bool: return is_instance_valid(r) and not _rows.is_ancestor_of(r))
	for ch in _rows.get_children():
		_rows.remove_child(ch)
		ch.queue_free()
	_row_nodes.clear()
	if not show:
		return
	var t := c()
	for i in devices.size():
		_row_nodes.append(_make_row(i, devices[i], t))


func _make_row(i: int, d: Dictionary, t: PKeyUiCopy) -> Dictionary:
	var holder := vbox(_rows, "Row_%d" % i, "PKeyTight")
	var row := BoxContainer.new()
	row.name = "Line"
	row.theme_type_variation = "PKeyActionRow"
	holder.add_child(row)
	var out := {"holder": holder, "row": row}
	var renaming: bool = _edit.get("kind") == "rename" and _edit.get("index") == i
	var confirming: bool = _edit.get("kind") == "remove" and _edit.get("index") == i
	if renaming:
		var form := vbox(row, "RenameForm", "PKeyTight")
		form.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		var cap := label(form, "Caption", "PKeyMuted")
		cap.text = t.text("devices_rename_label")
		var field := LineEdit.new()
		field.name = "Name"
		field.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		field.text = String(d.get("name")) if d.get("name") is String else ""
		field.max_length = PKeyDevices.MAX_LABEL
		field.set_meta(DATA_META, true)
		field.text_submitted.connect(func(_s: String) -> void: _save(i))
		name_for_reader(field, t.text("devices_rename_label"))
		form.add_child(field)
		var acts := _inner_actions(form)
		_inner_of(out).append(acts)
		var save := button(acts, "Save", _save.bind(i), "PKeyPrimary")
		save.text = t.text("retry") if error != null else t.text("devices_rename_save")
		save.disabled = _busy
		var cancel := button(acts, "Cancel", _end_edit)
		cancel.text = t.text("cancel")
		out["field"] = field
		out["save"] = save
		out["cancel"] = cancel
	else:
		var head := hbox(row, "Head")
		head.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		var glyph := glyph_node(head, "Glyph", PKeyKitGlyphs.device(d.get("formFactor")))
		out["glyph"] = glyph
		name_for_reader(glyph, t.text(PKeyDevicesController.form_factor_key(d)))
		var text := vbox(head, "Text", "PKeyTight")
		text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		text.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		var nm := label(text, "Label", "PKeyStrong", true)
		nm.text = PKeyUiTheme.isolate(_name_of(d)) if d.get("name") is String and d.get("name") != "" else _name_of(d)
		var meta := label(text, "Meta", "PKeyMuted")
		meta.text = _meta_text(d, t)
		var acts := _inner_actions(row)
		acts.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		out["actions"] = acts
		_inner_of(out).append(acts)
		var shown_name := _name_of(d)
		if _can_rename(d):
			var rn := button(acts, "Rename", _start_edit.bind("rename", i), "PKeyLink")
			rn.text = t.text("devices_rename")
			name_for_reader(rn, t.text("a11y_rename_device", shown_name))
			out["rename"] = rn
		if _can_remove(d):
			var rm := button(acts, "Remove", _start_edit.bind("remove", i), "PKeyLink")
			rm.text = t.text("devices_remove")
			name_for_reader(rm, t.text("a11y_remove_device", shown_name))
			out["remove"] = rm
	row.set_meta(&"pkey_row", i)
	if confirming:
		var box := vbox(holder, "Confirm", "PKeyTight")
		var ask := label(box, "Question", "")
		ask.text = t.text("devices_remove_confirm", PKeyUiTheme.isolate(_name_of(d)))
		var acts := _inner_actions(box)
		_inner_of(out).append(acts)
		var yes := button(acts, "ConfirmRemove", _confirm_remove.bind(i), "PKeyPrimary")
		yes.text = t.text("retry") if error != null else t.text("devices_remove")
		yes.disabled = _busy
		var no := button(acts, "Cancel", _end_edit)
		no.text = t.text("cancel")
		out["confirm"] = yes
		out["cancel"] = no
		_style_danger(yes)
	if (renaming or confirming) and error != null:
		var fail := label(holder, "Failure", "PKeyError")
		var key := "devices_rename_failed" if renaming else "devices_remove_failed"
		fail.text = t.text(key, PKeyUiTheme.isolate(_name_of(d)))
		fail.set_meta(&"pkey_live", true)
	return out


## The row's list of button boxes `_fit_inner_actions` fits.
func _inner_of(out: Dictionary) -> Array:
	if not out.has("inner"):
		out["inner"] = []
	return out["inner"]


## A row of buttons inside the list's own panel: one line while its buttons fit, stacked otherwise
## (`_fit_inner_actions`; the base fits only the action rows it was handed, and does not know the list's padding).
func _inner_actions(parent: Node) -> BoxContainer:
	var box := BoxContainer.new()
	box.name = "Actions"
	box.theme_type_variation = "PKeyActionRow"
	box.alignment = BoxContainer.ALIGNMENT_BEGIN
	parent.add_child(box)
	return box


## "This Mac" on the row the runtime knows is this device; "Windows · last used 3 days ago" on every
## other (PKeyDevicesController.meta_text).
func _meta_text(d: Dictionary, t: PKeyUiCopy) -> String:
	return PKeyDevicesController.meta_text(d, t)


func _when(days: Variant, t: PKeyUiCopy) -> String:
	return PKeyDevicesController.when_text(days, t)


## The destructive confirm reads in the danger colour.
func _style_danger(b: Button) -> void:
	var danger := get_theme_color("font_color", "PKeyError")
	for item in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		b.add_theme_color_override(item, danger)


# ── Arrange ──────────────────────────────────────────────────────────────────────────────────

func _arrange(m: Dictionary) -> void:
	super(m)
	var phone := bool(layout_metrics().get("phone", false))
	var min_row := roundf(64.0 * float(layout_metrics()["scale"]))
	# What a row's words and its buttons share, inside the list's padding.
	var inner := PKeyListScroll.inner_room(self, _list_panel, _list_scroll)
	for r in _row_nodes:
		var row := r["row"] as BoxContainer
		# The buttons go under the words before large type or a narrow card squeezes the words to a sliver.
		var wide_actions: bool = r.has("actions") and _line_width(r["actions"]) > inner * 0.4
		row.vertical = phone or wide_actions
		# A row is at least 64 px (a second line fits, a control is not squeezed).
		row.custom_minimum_size.y = min_row
		if r.has("glyph"):
			size_glyph(r["glyph"], 24.0, get_theme_color("font_color", "PKeyMuted"))
		if r.has("actions"):
			(r["actions"] as Control).size_flags_horizontal = Control.SIZE_FILL if row.vertical else Control.SIZE_SHRINK_END
		if r.has("confirm"):
			_style_danger(r["confirm"])
	PKeyListScroll.fit_buttons(self, _list_panel, _list_panel, _list_scroll)
	_fit_inner_actions()
	var changed := _fit_list(min_row)
	# The card's own scroll is decided on what the list now takes, and a view that grew meanwhile is
	# the screen's size again.
	fit_scrolls(available_height(), outer_view() == self and _stretches_vertically())
	_release_offsets()
	PKeyListScroll.resync(self)
	if changed:
		PKeyUiView._resort_all(self)


## The list takes the room the card leaves. While a row is being edited and the list cannot show them
## all, it shows that row alone; and on a screen too short even for that, the product's header
## collapses to one line (DL5: it is never removed) and the lede goes, so the edit's own primary is
## never below the fold.
func _fit_list(least: float) -> bool:
	var edited := -1
	if not _edit.is_empty():
		edited = int(_edit["index"])
	for r in _row_nodes:
		(r["holder"] as Control).visible = true
	_product.card = true
	_lede.visible = _lede_shown
	_frame.theme_type_variation = &"PKeySections"
	_list_off = false
	if edited >= 0 and PKeyListScroll.wanted(self, _list_scroll, _list_panel, least) > 0.0:
		for i in _row_nodes.size():
			(_row_nodes[i]["holder"] as Control).visible = i == edited
		if PKeyListScroll.wanted(self, _list_scroll, _list_panel, least) > 0.0:
			_product.card = false
			_lede.visible = false
			_frame.theme_type_variation = &"PKeyStack"
			# Not even the row alone fits: no second scroll inside the card's (the card scrolls and
			# follows the focus), so the edit's own buttons are never in a scroll within a scroll.
			if PKeyListScroll.wanted(self, _list_scroll, _list_panel, least) > 0.0:
				_list_off = true
				return PKeyListScroll.pass_through(_list_scroll)
	return PKeyListScroll.apply(self, _list_scroll, _list_panel, least)


## Buttons that sit inside the list's own panel stack when they do not fit on a line (the base fits
## the action rows it was given, and does not know the list's padding).
func _fit_inner_actions() -> void:
	var room := PKeyListScroll.inner_room(self, _list_panel, _list_scroll)
	for r in _row_nodes:
		if not r.has("inner"):
			continue
		for box in r["inner"]:
			var b := box as BoxContainer
			var stack := _line_width(b) > room + 0.5
			b.vertical = stack
			for ch in b.get_children():
				if ch is Control:
					(ch as Control).size_flags_horizontal = Control.SIZE_FILL if stack else Control.SIZE_SHRINK_BEGIN


## The width a box's visible children take on one line (whatever way the box runs now).
func _line_width(b: BoxContainer) -> float:
	var line := 0.0
	var n := 0
	for ch in b.get_children():
		if ch is Control and (ch as Control).visible:
			line += (ch as Control).get_combined_minimum_size().x
			n += 1
	return line + maxf(0.0, n - 1.0) * float(b.get_theme_constant("separation"))


func _layout_stale() -> bool:
	return not _list_off and PKeyListScroll.stale(self, _list_scroll, _list_panel, roundf(64.0 * float(layout_metrics()["scale"])))


# ── Focus ────────────────────────────────────────────────────────────────────────────────────

func _focus_chain() -> Array:
	var out: Array = []
	for r in _row_nodes:
		for k in ["rename", "remove", "field", "save", "confirm", "cancel"]:
			if r.has(k):
				out.append(r[k])
	out.append_array([_retry, _manage])
	return out


func _initial_focus() -> Control:
	for r in _row_nodes:
		if r.has("field") and is_focusable(r["field"]):
			return r["field"]
		if r.has("confirm") and is_focusable(r["confirm"]):
			return r["confirm"]
	var chain := focus_order()
	return chain[0] if not chain.is_empty() else null


func _cancel() -> bool:
	if not _edit.is_empty() and is_visible_in_tree():
		_end_edit()
		return true
	return false


# ── Actions ──────────────────────────────────────────────────────────────────────────────────

func _start_edit(kind: String, i: int) -> void:
	_edit = {"kind": kind, "index": i}
	error = null
	_busy = false
	refresh_view()
	if kind == "rename":
		var f := _field(i)
		if f != null:
			f.grab_focus.call_deferred()
			f.select_all.call_deferred()


func _field(i: int) -> LineEdit:
	for r in _row_nodes:
		if r.has("field") and (r["row"] as Node).get_meta(&"pkey_row", -1) == i:
			return r["field"]
	return null


## Close an edit and give the focus back to the row's own button.
func _end_edit() -> void:
	var i: int = _edit.get("index", -1)
	var kind: String = _edit.get("kind", "")
	_edit = {}
	error = null
	_busy = false
	if i >= 0:
		_focus_path = "%s/Row_%d/Line/Actions/%s" % [get_path_to(_rows), i, "Rename" if kind == "rename" else "Remove"]
	refresh_view()


func _save(i: int) -> void:
	if _busy or i >= devices.size():
		return
	var f := _field(i)
	var label_text := f.text.strip_edges() if f != null else ""
	var row: Dictionary = devices[i]
	rename_requested.emit(row, label_text)
	if host_handles:
		_busy = true
		refresh_view()
		return
	if sdk != null and sdk.get("devices") != null and bool(row.get("current", false)):
		_busy = true
		refresh_view()
		var r: PKeyResult = await sdk.devices.rename(label_text if label_text != "" else null)
		if not is_inside_tree():
			return
		if r.ok:
			_apply_edit(label_text if label_text != "" else null)
		else:
			edit_failed("device_rename_failed")
		return
	_apply_edit(label_text if label_text != "" else null)


func _confirm_remove(i: int) -> void:
	if _busy or i >= devices.size():
		return
	remove_requested.emit(devices[i])
	if host_handles:
		_busy = true
		refresh_view()
		return
	_apply_edit(null)


## An edit succeeded: a rename sets the row's name, a removal drops the row.
func _apply_edit(new_label: Variant) -> void:
	var i: int = _edit.get("index", -1)
	var kind: String = _edit.get("kind", "")
	_edit = {}
	error = null
	_busy = false
	if i >= 0 and i < devices.size():
		var next := devices.duplicate(true)
		if kind == "remove":
			next.remove_at(i)
		else:
			next[i]["name"] = new_label
		devices = next
		_focus_path = ""
	refresh_view()
	changed.emit()
	# The focus returns to the row that was edited (or the one now in its place).
	if not _row_nodes.is_empty():
		var j := clampi(i, 0, _row_nodes.size() - 1)
		for k in ["rename", "remove"]:
			if _row_nodes[j].has(k):
				(_row_nodes[j][k] as Control).grab_focus.call_deferred()
				break


func _on_retry() -> void:
	if not _edit.is_empty():
		return
	retry_requested.emit()
	if sdk != null and sdk.get("devices") != null:
		refresh_roster()


func _on_manage() -> void:
	manage_requested.emit()
	if manage_url != "" and manage_url.begins_with("https://"):
		OS.shell_open(manage_url)
