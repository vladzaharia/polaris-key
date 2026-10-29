class_name PKeyRecoveryCode
extends PKeyUiView
## Save your recovery code (ui-matrix `cloudSync`; ui-core's `recovery_code_view`): the new code,
## shown once, as 8 groups of 4 drawn whole (4 to a row, 2 to a row where the width or the text size
## does not hold four, never a group cut). The code is never an input of the model: the game or the
## flow hands it over (`code`, from `keyring.create()`, `reset()` or `set_recovery_code()`), the
## screen keeps nothing after Done and logs nothing. It says no one will ask for it.
##
## Copy code puts it on the clipboard. **I've saved my recovery code** is a check box; Done shows
## only once it is checked, and the screen cannot be dismissed before that (Escape and a pad's back
## button do nothing). Hidden when the Sync service is off (`sync_on`).

## Done: the person confirmed they saved the code. The screen has already wiped it.
signal done()
## Copy code was chosen.
signal code_copied()

## The code as `keyring` made it ("XXXX-XXXX-…"). Set it once; it is wiped on Done.
var code := "":
	set(value):
		code = value
		refresh_view()
## "I've saved my recovery code" is checked.
@export var saved := false:
	set(value):
		saved = value
		refresh_view()
## False turns the Sync service off: nothing shows.
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
var _no_ask: Label
var _grid: GridContainer
var _groups: Array = []
var _copy: Button
var _copied: Label
var _check: CheckBox  # ui-lint: allow godot-checkbox "I've saved my recovery code" is an acknowledgement, not a switch
var _actions: BoxContainer
var _done: Button
var _did_copy := false


func _build() -> void:
	name = "PKeyRecoveryCode"
	_body = vbox(card_panel(), "Body", "PKeyStack")
	var body := _body
	_product = product_header(body, "Product")
	_product.card = true
	# The title spans the card; the columns hold what it introduces.
	_title = label(vbox(body, "Head", "PKeyTight"), "Title", "PKeyTitle")
	_cols = columns(body, "Columns")
	var left := vbox(_cols, "Left", "PKeyStack")
	left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var right := vbox(_cols, "Right", "PKeyStack")
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var words := vbox(left, "Words", "PKeyTight")
	_lede = label(words, "Lede", "PKeyMuted")
	var well := PanelContainer.new()
	well.name = "CodeField"
	well.theme_type_variation = "PKeyRail"
	left.add_child(well)
	_grid = GridContainer.new()
	_grid.name = "Code"
	_grid.columns = 4
	_grid.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	well.add_child(_grid)
	_copy = button(left, "Copy", _on_copy, "PKeyLink")
	_copy.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_copied = label(left, "Copied", "PKeyMuted")
	_no_ask = label(right, "NoAsk", "PKeyMuted")
	_check = CheckBox.new()  # ui-lint: allow godot-checkbox the saved-code acknowledgement is a check box
	_check.name = "Saved"
	_check.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_check.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_check.toggled.connect(_on_toggled)
	right.add_child(_check)
	_actions = actions_row(body, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_done = button(_actions, "Done", _on_done, "PKeyPrimary")


func _bleeds() -> bool:
	return true


func _opens_at_top() -> bool:
	return true


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 4


## Freed: the code goes with it. (Not on leaving the tree: a host may move the screen.)
func _notification(what: int) -> void:
	super(what)
	if what == NOTIFICATION_PREDELETE:
		for l in _groups:
			if is_instance_valid(l):
				(l as Label).text = ""


## Ticking the box changes the state, not the screen: the focus stays where the person put it.
func _screen_key() -> String:
	return "%s|%s" % [code != "", sync_on]


func _render() -> void:
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("RecoveryCode", PKeyRecoveryCode.input(saved, sync_on))
	var state: String = model.get("state", "hidden")
	# Nothing to save without a code: the screen stays hidden until the host hands one over.
	visible = state != "hidden" and code != ""
	_product.refresh()
	cat_text(_title, "recoveryCode.title" if visible else "")
	cat_text(_lede, "recoveryCode.lede" if visible else "")
	cat_text(_no_ask, "recoveryCode.noAsk" if visible else "")
	cat_text(_copy, "recoveryCode.copy" if visible else "")
	cat_text(_check, "recoveryCode.saved" if visible else "")
	cat_text(_copied, "common.copied" if _did_copy and code != "" else "")
	_check.set_pressed_no_signal(saved)
	cat_text(_done, "common.done" if state == "saved" else "")
	# No empty action area: the row shows only with Done.
	_actions.visible = state == "saved"
	_fill_groups()


## The model input (ui-matrix `recoveryCode`): never the code.
static func input(p_saved: bool, p_sync_on := true) -> Dictionary:
	var out := {"recoveryCode": {"saved": p_saved}}
	if not p_sync_on:
		out["services"] = ["license", "config", "release", "distribution", "update", "identity"]
	return out


## The groups on screen, in order (what a test reads).
func shown_groups() -> PackedStringArray:
	var out := PackedStringArray()
	for l in _groups:
		out.append((l as Label).text)
	return out


func _fill_groups() -> void:
	# A hidden screen (the Sync service is off) draws nothing, the code included.
	var groups := PKeyCloudSyncController.groups_of(code) if visible else PackedStringArray()
	while _groups.size() > groups.size():
		var extra := _groups.pop_back() as Label
		_grid.remove_child(extra)
		extra.queue_free()
	while _groups.size() < groups.size():
		# A group is data, not copy: drawn as given, never translated or mirrored, never wrapped.
		var l := label(_grid, "Group%d" % _groups.size(), "PKeyMono", true)
		l.autowrap_mode = TextServer.AUTOWRAP_OFF
		l.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT  # ui-lint: allow godot-rtl a code group is data and never mirrors
		_groups.append(l)

	for i in groups.size():
		(_groups[i] as Label).text = groups[i]
	_grid.visible = not groups.is_empty()
	_grid.get_parent().visible = _grid.visible
	# Read as groups with a pause between them, never as one long string.
	if _grid.visible:
		_grid.set("accessibility_name", String(catalog().format("a11y.recoveryCode", {"code": ", ".join(groups)})))


func _arrange(m: Dictionary) -> void:
	set_columns(_cols, two_pane_fits())
	super(m)
	_product.visible = squeeze_level() < 1
	# Short on room, the gaps between the parts close before the card scrolls.
	_body.theme_type_variation = &"PKeyTight" if squeeze_level() >= 2 else &"PKeyStack"
	_fit_columns()


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide" if two_pane_fits() else "card_width"), content_room().x))


## 4 groups to a row when four whole groups fit the room, else 2 (large text, a narrow screen), else
## 1: chosen from the measured width, never only from the text size.
func _fit_columns() -> void:
	if _groups.is_empty():
		return
	# The code is the screen's hero: the title's size in the mono face, stepping down to the body size
	# when the room runs short (the gaps close first, then this, before the card scrolls).
	var hero := get_theme_font_size("font_size", "PKeyTitle")
	for l in _groups:
		if squeeze_level() >= 2:
			(l as Label).remove_theme_font_size_override("font_size")
		else:
			(l as Label).add_theme_font_size_override("font_size", hero)
	var first := _groups[0] as Label
	var widest := 0.0
	for l in _groups:
		widest = maxf(widest, text_width(l as Label, (l as Label).text))
	# The theme's own separation, never the override this function sets (it would grow each pass).
	_grid.remove_theme_constant_override(&"h_separation")
	var gap := float(_grid.get_theme_constant("h_separation")) + 8.0
	var well_pad := side_padding(_grid.get_parent() as Control) if _grid.get_parent() is PanelContainer else 0.0
	# Side by side, the code has one column of the card.
	var room := room_x() - well_pad
	if two_pane_fits():
		room = (room_x() - role("column_gap")) / 2.0 - well_pad
	var cols := 1
	for n in [4, 2]:
		if float(n) * widest + float(n - 1) * gap <= room + 0.5:
			cols = n
			break
	if _grid.columns != cols:
		_grid.columns = cols
	_grid.add_theme_constant_override(&"h_separation", int(gap))
	first.custom_minimum_size.x = widest
	for l in _groups:
		(l as Label).custom_minimum_size.x = widest


func _initial_focus() -> Control:
	return _copy if is_focusable(_copy) else _check


func _focus_chain() -> Array:
	return [_copy, _check, _done]


## The code screen cannot be dismissed: only Done leaves, and only once the box is checked.
func _cancel() -> bool:
	return visible


func _on_copy() -> void:
	if code == "":
		return
	PKeyCloudSyncController.clipboard_set(PKeyCloudSyncController.hyphenated(code))
	_did_copy = true
	refresh_view()
	note_copied()
	code_copied.emit()


func _on_toggled(on: bool) -> void:
	saved = on
	if on and is_focusable(_done):
		# Done is the next step: focus it and bring it into view (it can sit below the fold).
		_done.grab_focus()
		_scroll_to_done.call_deferred()


func _scroll_to_done() -> void:
	if not is_instance_valid(_done) or not _done.is_inside_tree():
		return
	var n := _done.get_parent()
	while n != null and n != get_parent():
		if n is ScrollContainer:
			(n as ScrollContainer).ensure_control_visible(_done)
		n = n.get_parent()


func _on_done() -> void:
	if not saved:
		return
	# The clipboard keeps what it was given until it is replaced: take the code back off it, if it
	# is still there (the engine cannot mark it concealed or give it an expiry).
	if code != "" and PKeyCloudSyncController.clipboard_get() == PKeyCloudSyncController.hyphenated(code):
		PKeyCloudSyncController.clipboard_set("")
	_wipe()
	done.emit()


## Forget the code: the groups, the property, the clipboard text this screen put there is the
## person's to clear.
func _wipe() -> void:
	_did_copy = false
	code = ""
	for l in _groups:
		if is_instance_valid(l):
			(l as Label).text = ""
