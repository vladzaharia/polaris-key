class_name PKeySaveConflict
extends PKeyUiView
## The same save changed on two devices (ui-matrix `saveConflict`; ui-core's `save_conflict_view`).
## Two cards say whose copy is whose and when each was saved, and the person picks one way on. The
## kit never settles it for them:
##
##   Keep this device's version   replaces the other copy
##   Keep the other version       replaces the one on this device
##   Keep both                    saves the other as a copy; needs a free slot of the 16, and with
##                                none it stays on screen, disabled, with its reason under it
##   Cancel                       leaves the conflict as it is
##
## Nothing is the default: no choice is filled and none is focused. The actions are one column in
## reading order, never docked. When the other copy was deleted (`remote_deleted`) the screen has
## its own title and lede, one card, and **Delete it here too** (drawn in the danger colour) in
## place of Keep the other; Keep both goes. A choice is applied once: `keeping` offers nothing,
## `kept` names the choice that was made, and `failed` keeps both saves as they were (Try again
## repeats the choice; the first focus is Cancel, never a control that overwrites).
##
## Not bound to a live client: the host sets `step` and the display-ready fields, and connects the
## signals. `model` is the ui-core view of the state, so a binding reads it rather than redoing it.
## Hidden when the Sync service is off (`sync_on`).

## A way on was chosen: "local", "remote" (a deletion when `remote_deleted`) or "both".
signal keep_requested(keep: String)
## Try again, after a failure: repeat the choice that failed (`keep`).
signal retry_requested(keep: String)
## Cancel (or Escape): leave the conflict as it is.
signal cancelled()
## Done, after `kept`.
signal done()

## "choose", "keeping", "kept" or "failed".
@export_enum("choose", "keeping", "kept", "failed") var step := "choose":
	set(value):
		step = value
		refresh_view()
## The choice being applied (keeping), applied (kept) or that failed: "local", "remote" or "both".
@export var keep := "":
	set(value):
		keep = value
		refresh_view()
## When the copy on this device was saved, already worded ("today, 14:02"); "" says nothing.
@export var local_when := "":
	set(value):
		local_when = value
		refresh_view()
## When the other copy was saved, already worded ("yesterday, 21:40").
@export var remote_when := "":
	set(value):
		remote_when = value
		refresh_view()
## The other copy's device name (someone's own text, drawn bidi-isolated), or "" when not known.
@export var remote_device := "":
	set(value):
		remote_device = value
		refresh_view()
## The other copy was deleted: there is nothing to keep or copy.
@export var remote_deleted := false:
	set(value):
		remote_deleted = value
		refresh_view()
## A free slot of the 16 is left for Keep both. Without it (or unsaid) Keep both is disabled.
@export var both_available := false:
	set(value):
		both_available = value
		refresh_view()
@export var sync_on := true:
	set(value):
		sync_on = value
		refresh_view()

var model: Dictionary = {}

var _product: PKeyProductHeader
var _cols: BoxContainer
var _body: VBoxContainer
var _title: Label
var _lede: Label
var _cards: BoxContainer
var _local_card: PanelContainer
var _local_who: Label
var _local_when: Label
var _remote_card: PanelContainer
var _remote_who: Label
var _remote_when: Label
var _status_row: HBoxContainer
var _status_glyph: TextureRect
var _status: Label
var _actions: BoxContainer
var _keep_local: Button
var _keep_remote: Button
var _keep_both: Button
var _both_full: Label
var _done_button: Button
var _retry: Button
var _cancel_button: Button


func _build() -> void:
	name = "PKeySaveConflict"
	_body = vbox(card_panel(), "Body", "PKeyStack")
	var body := _body
	_product = product_header(body, "Product")
	_product.card = true
	var head := vbox(body, "Head", "PKeyTight")
	_title = label(head, "Title", "PKeyTitle")
	_cols = columns(body, "Columns")
	var left := vbox(_cols, "Left", "PKeyStack")
	left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var right := vbox(_cols, "Right", "PKeyStack")
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_lede = label(left, "Lede", "PKeyMuted")
	_cards = columns(left, "Cards")
	_local_card = _save_card(_cards, "Local")
	_local_who = _local_card.get_node("Words/Who")
	_local_when = _local_card.get_node("Words/When")
	_remote_card = _save_card(_cards, "Remote")
	_remote_who = _remote_card.get_node("Words/Who")
	_remote_when = _remote_card.get_node("Words/When")
	var st := glyph_label(left, "Status", "info", "PKeyMuted")
	_status_row = st["row"]
	_status_glyph = st["glyph"]
	_status = st["label"]
	# The busy bar sits with the status line: the actions column is empty while a choice is applied.
	loading_bar(left)
	# One column in reading order: the choices, Keep both's reason right under it, then Cancel.
	_actions = actions_row(right, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_actions.set_meta(&"pkey_force_stack", true)
	_keep_local = button(_actions, "KeepThis", _on_keep_local)
	_keep_remote = button(_actions, "KeepOther", _on_keep_remote)
	_keep_both = button(_actions, "KeepBoth", _on_keep_both)
	_both_full = label(_actions, "BothFull", "PKeyMuted")
	_done_button = button(_actions, "Done", _on_done, "PKeyPrimary")
	# Try again repeats an overwrite or a deletion: secondary, never the filled control.
	_retry = button(_actions, "TryAgain", _on_retry)
	_cancel_button = button(_actions, "Cancel", _on_cancel, "PKeyLink")
	for b in [_keep_local, _keep_remote, _keep_both, _done_button, _retry, _cancel_button]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


## One copy of the save: whose it is, and when it was saved.
func _save_card(parent: Node, node_name: String) -> PanelContainer:
	var p := PanelContainer.new()
	p.name = node_name
	p.theme_type_variation = "PKeyBanner"
	p.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	p.set_meta(AUTO_HIDE_META, true)
	parent.add_child(p)
	var words := vbox(p, "Words", "PKeyTight")
	label(words, "Who", "PKeyStrong")
	label(words, "When", "PKeyMuted")
	return p


func _bleeds() -> bool:
	return true


func _opens_at_top() -> bool:
	return true


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 4


func _process(_delta: float) -> void:
	_tick_loading()


func _arrange(m: Dictionary) -> void:
	var two := two_pane_fits()
	set_columns(_cols, two)
	# The two copies sit side by side while the column holds both, else stacked.
	# The copies stack, in the same order as the choices they map to.
	set_columns(_cards, false)
	_cols.get_child(0).size_flags_stretch_ratio = 1.0
	super(m)
	_fit_choices()
	_product.visible = squeeze_level() < 1
	size_glyph(_status_glyph, 20.0, get_theme_color("font_color", "PKeyError" if step == "failed" else "PKeyMuted"))
	_style_delete(_keep_remote, remote_deleted)
	_body.theme_type_variation = &"PKeyTight" if squeeze_level() >= 2 else &"PKeyStack"


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide" if two_pane_fits() else "card_width"), content_room().x))


## "Delete it here too" in the danger colour, outlined and never filled: the choices stay unfilled.
## It keeps the shape and fill the other choices draw with (Keep this's resolved style) and changes
## the border and the ink only.
func _style_delete(b: Button, on: bool) -> void:
	var colour := get_theme_color(&"font_color", &"PKeyError")
	for item in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		if on:
			b.add_theme_color_override(item, colour)
		else:
			b.remove_theme_color_override(item)
	for item in ["normal", "hover", "pressed"]:
		var base := _keep_local.get_theme_stylebox(item)
		if on and base is StyleBoxFlat:
			var box := (base as StyleBoxFlat).duplicate() as StyleBoxFlat
			box.border_color = colour
			box.set_border_width_all(maxi(2, box.border_width_left))
			b.add_theme_stylebox_override(item, box)
		else:
			b.remove_theme_stylebox_override(item)


## The room a wrapped choice has: the column, less the bar of a scrolling card that bleeds to the
## edges (the base measure leaves the bar out there, and the choices would run 8 px past the screen).
func _choice_room() -> float:
	var room := room_x()
	if card_padding_x() == 0.0:
		room -= scrollbar_width()
	return room


func _fit_choices() -> void:
	var room := _choice_room()
	for b in [_keep_local, _keep_remote, _keep_both, _done_button, _retry, _cancel_button]:
		_fit_label(b as Button, room)


## A choice that wraps is exactly the room the column has. When the card starts to scroll, its bar
## takes some of that room: the wrapped choices are measured again at what is left.
func _layout_stale() -> bool:
	if not (is_inside_tree() and is_visible_in_tree()):
		return false
	var room := _choice_room()
	for b in [_keep_local, _keep_remote, _keep_both, _done_button, _retry, _cancel_button]:
		if (b as Button).visible and (b as Button).custom_minimum_size.x > room + 0.5:
			return true
	return false


## The person has moved the focus (a direction, Tab or a pad press) since the screen opened. Until
## then a host update or a resize must not scroll the versions away to the focused Cancel.
var _moved := false
var _seen_state := ""


func _input(event: InputEvent) -> void:
	super(event)
	for a in ["ui_up", "ui_down", "ui_left", "ui_right", "ui_focus_next", "ui_focus_prev"]:
		if event.is_action_pressed(a):
			_moved = true


## Keep the title and both copies in view until the person moves the focus; once they have, the
## focus is kept in view, and reaching the first choice brings the top back (the copies cannot take
## the focus, so this is how a pad scrolls up to them).
func _reveal_focus() -> void:
	var f := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
	var first: Control = null
	for c in [_keep_local, _keep_remote, _keep_both, _done_button, _retry, _cancel_button]:
		if is_focusable(c):
			first = c
			break
	if String(model.get("state", "")) != "choose" or (_moved and f != null and f != first):
		super()
		return
	for sc in _scrolls:
		if (sc as ScrollContainer).vertical_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED:
			(sc as ScrollContainer).scroll_vertical = 0


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), sync_on]


func _render() -> void:
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("SaveConflict", PKeySaveConflict.input(step, local_when, remote_when, remote_device, remote_deleted, both_available, keep, sync_on))
	var state: String = model.get("state", "hidden")
	visible = state != "hidden"
	if state != _seen_state:
		_seen_state = state
		_moved = false
	_product.refresh()
	var copy: Array = model.get("copy", [])
	var key_args: Dictionary = model.get("keyArgs", {})
	var args := {"device": PKeyUiTheme.isolate(remote_device.strip_edges())}
	var choose := state == "choose"
	var gone := copy.has("saveConflict.deletedTitle")
	cat_text(_title, ("saveConflict.deletedTitle" if gone else "saveConflict.title") if visible else "")
	cat_text(_lede, ("saveConflict.deletedLede" if gone else "saveConflict.lede") if choose else "")
	# The two copies: whose they are, and when each was saved.
	_local_card.visible = choose
	_remote_card.visible = choose
	cat_text(_local_who, "saveConflict.thisDevice" if choose else "")
	cat_text(_local_when, "saveConflict.savedThis" if copy.has("saveConflict.savedThis") else "", key_args.get("saveConflict.savedThis", {}))
	var who_key := "saveConflict.deletedElsewhere" if gone else ("saveConflict.otherDevice" if copy.has("saveConflict.otherDevice") else "saveConflict.otherUnknown")
	cat_text(_remote_when, "saveConflict.savedOther" if copy.has("saveConflict.savedOther") else "", key_args.get("saveConflict.savedOther", {}))
	cat_text(_remote_who, who_key if choose else "", args)
	# The way on for the state.
	var status_key := ""
	match state:
		"keeping":
			status_key = "saveConflict.keeping"
		"failed":
			status_key = "saveConflict.failed"
		"kept":
			for k in ["saveConflict.keptLocal", "saveConflict.keptRemote", "saveConflict.keptBoth", "saveConflict.keptDeleted"]:
				if copy.has(k):
					status_key = k
	cat_text(_status, status_key)
	_status_glyph.set_meta(&"pkey_glyph", {"failed": "warning", "kept": "success"}.get(state, "info"))
	_status_glyph.visible = _status.visible and state != "keeping"
	_status.theme_type_variation = &"PKeyError" if state == "failed" else &"PKeyMuted"
	fx_error("saveConflict.failed" if state == "failed" else "")
	cat_text(_keep_local, "saveConflict.keepThis" if choose else "")
	cat_text(_keep_remote, ("saveConflict.acceptDelete" if gone else "saveConflict.keepOther") if choose else "")
	cat_text(_keep_both, "saveConflict.keepBoth" if copy.has("saveConflict.keepBoth") else "")
	# Keep both stays on screen while every slot is in use: disabled, and the reason under it.
	var both_ok: bool = (model.get("actions", []) as Array).has("keep-both")
	_keep_both.disabled = not both_ok
	cat_text(_both_full, "saveConflict.bothFull" if copy.has("saveConflict.bothFull") else "")
	cat_text(_done_button, "common.done" if state == "kept" else "")
	cat_text(_retry, "common.tryAgain" if state == "failed" else "")
	cat_text(_cancel_button, "common.cancel" if copy.has("common.cancel") else "")
	_actions.visible = state != "keeping" and state != "hidden"
	set_loading(state == "keeping")
	set_process(state == "keeping")


## The model input of a state (ui-matrix `saveConflict`).
static func input(p_step: String, p_local_when := "", p_remote_when := "", p_device := "", p_deleted := false, p_both := false, p_keep := "", p_sync_on := true) -> Dictionary:
	var c := {"step": p_step}
	var local := {}
	if p_local_when != "":
		local["when"] = p_local_when
	c["local"] = local
	if p_deleted:
		c["remote"] = null
	else:
		var remote := {}
		if p_remote_when != "":
			remote["when"] = p_remote_when
		if p_device.strip_edges() != "":
			remote["device"] = p_device
		c["remote"] = remote
	if p_both:
		c["bothAvailable"] = true
	if p_keep != "":
		c["keep"] = p_keep
	var out := {"saveConflict": c}
	if not p_sync_on:
		out["services"] = ["license", "config", "release", "distribution", "update", "identity"]
	return out


## Nothing is the default (a pad's A on open must never overwrite a save): the first focus is Cancel
## on a choice and on a failure, and Done once the choice is applied.
func _initial_focus() -> Control:
	match String(model.get("state", "")):
		"kept":
			return _done_button
		"choose", "failed":
			return _cancel_button
	return null


func _focus_chain() -> Array:
	return [_keep_local, _keep_remote, _keep_both, _done_button, _retry, _cancel_button]


func _cancel() -> bool:
	if not visible:
		return false
	match String(model.get("state", "")):
		"keeping":
			# A choice is applied once and not taken back.
			return true
		"kept":
			_on_done()
			return true
	_on_cancel()
	return true


func _on_keep_local() -> void:
	keep_requested.emit("local")


func _on_keep_remote() -> void:
	keep_requested.emit("remote")


func _on_keep_both() -> void:
	if _keep_both.disabled:
		return
	keep_requested.emit("both")


func _on_retry() -> void:
	retry_requested.emit(keep)


func _on_done() -> void:
	done.emit()


func _on_cancel() -> void:
	cancelled.emit()
