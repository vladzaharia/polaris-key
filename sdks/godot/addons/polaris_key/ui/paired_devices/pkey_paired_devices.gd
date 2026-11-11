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


func _build() -> void:
	name = "PKeyPairedDevices"
	_frame = vbox(card_panel(), "Frame", "PKeySections")
	var head := vbox(_frame, "Head", "PKeyStack")
	_product = product_header(head, "Product")
	_product.card = true
	var titles := vbox(head, "Titles", "PKeyTight")
	_title = label(titles, "Title", "PKeyTitle")
	_title.focus_mode = PKeyPairCode.accessibility_focus() as Control.FocusMode
	_lede = label(titles, "Lede", "PKeyMuted")
	loading_bar(_frame)
	_notices = vbox(_frame, "Notices", "PKeyStack")
	for i in 3:
		var n := PKeyPairNotice.new()
		n.name = "Notice%d" % i
		n.action_pressed.connect(_on_notice_action.bind(i))
		_notices.add_child(n)
		_notice_nodes.append(n)
	_message = label(_frame, "Message", "PKeyMuted")
	_error = label(_frame, "Failure", "PKeyError")
	if "accessibility_live" in _error:
		_error.set("accessibility_live", 1)
	_column_head = label(_frame, "ColumnHead", "PKeyMuted")
	_column_head.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_list_scroll = PKeyListScroll.make(_frame, "ListScroll")
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


func _opens_at_top() -> bool:
	return true


func squeeze_max() -> int:
	return 3


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
			copy.has("pairedDevices.reachableFullTitle")
		]
	)
	if sig != _signature:
		_signature = sig
		_rebuild(listing, switches, copy.has("pairedDevices.reachableFullTitle"), state)
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
		if copy.has("core.codes.local-links-full.title"):
			made.append(
				[
					fmt.call("core.codes.local-links-full.title"),
					fmt.call("pairedDevices.fullBody"),
					"info",
					"",
					""
				]
			)
		if copy.has("pairedDevices.reachableFullTitle"):
			made.append(
				[
					fmt.call("pairedDevices.reachableFullTitle"),
					fmt.call("pairedDevices.reachableFullBody"),
					"info",
					"",
					""
				]
			)
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
		cat_text(hint, "localPairing.nameHint", args)
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
		var acts := _row_actions(line)
		acts.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		var rename := _row_button(acts, "Rename", "devices.rename", id, "PKeyLink", args)
		name_for_reader(rename, "%s: %s" % [rename.text, shown])
		var forget := _row_button(acts, "ForgetRow", "pairedDevices.forget", id, "PKeyLink", args)
		name_for_reader(forget, "%s: %s" % [forget.text, shown])
		out["rename"] = rename
		out["forget"] = forget
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
	super(m)
	var scale := float(layout_metrics()["scale"])
	var phone := bool(layout_metrics().get("phone", false))
	var least := roundf(56.0 * scale)
	for id in _row_nodes:
		var r: Dictionary = _row_nodes[id]
		var line := r["holder"].get_node_or_null("Line") as BoxContainer
		if line != null:
			line.custom_minimum_size.y = least
		if r.has("switch"):
			r["switch"].size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_notice_glyphs()
	PKeyListScroll.fit_buttons(self, _list_panel, _list_panel, _list_scroll)
	_fit_inner_actions(phone)
	var changed := _fit_list(least)
	fit_scrolls(available_height(), outer_view() == self and _stretches_vertically())
	_release_offsets()
	PKeyListScroll.resync(self)
	_spacer.visible = phone_screen()
	if changed:
		PKeyUiView._resort_all(self)


func _notice_glyphs() -> void:
	for n in _notice_nodes:
		(n as PKeyPairNotice).size_glyph(self, 20.0)


## The list takes the room the card leaves. While a row is edited and the list cannot show them all,
## it shows that row alone; and on a screen too short even for that, the product's header collapses
## to one line (DL5: it is never removed) and the lede goes, so the edit's own primary is never
## below the fold.
func _fit_list(least: float) -> bool:
	var edited := (
		String(_snap.get("target", "")) if model.get("state") in ["renaming", "forgetting"] else ""
	)
	for id in _row_nodes:
		(_row_nodes[id]["holder"] as Control).visible = true
	_product.card = true
	_lede.visible = _lede.text != ""
	_frame.theme_type_variation = &"PKeySections"
	_list_off = false
	if edited != "" and PKeyListScroll.wanted(self, _list_scroll, _list_panel, least) > 0.0:
		for id in _row_nodes:
			(_row_nodes[id]["holder"] as Control).visible = id == edited
		if PKeyListScroll.wanted(self, _list_scroll, _list_panel, least) > 0.0:
			_product.card = false
			_lede.visible = false
			_frame.theme_type_variation = &"PKeyStack"
			if PKeyListScroll.wanted(self, _list_scroll, _list_panel, least) > 0.0:
				_list_off = true
				return PKeyListScroll.pass_through(_list_scroll)
	return PKeyListScroll.apply(self, _list_scroll, _list_panel, least)


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
			flow.start_rename(id)
		"common.save":
			flow.save_rename()
		"pairedDevices.forget":
			if _snap.get("step") == "forgetting":
				flow.confirm_forget()
			else:
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
		for k in ["field", "rename", "forget", "switch"]:
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


func _initial_focus() -> Control:
	for id in _row_nodes:
		var r: Dictionary = _row_nodes[id]
		if r.has("field"):
			return r["field"]
		if r.has("cancel") and r.has("forget"):
			return r["cancel"]
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
	for d: Dictionary in _snap.get("devices", []):
		var r: Dictionary = _row_nodes.get(String(d["id"]), {})
		for k in ["field", "save", "forget", "cancel", "switch", "rename"]:
			if r.has(k) and not chain.has(r[k]):
				chain.append(r[k])
	return chain + [_retry, _pair, _done]


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
