class_name PKeyUnlockSync
extends PKeyUiView
## Unlock sync (ui-matrix `cloudSync`; ui-core's `unlock_sync_view`): this device holds no key for the
## synced data, so the person types or pastes the recovery code they saved, or starts over with a new
## key. The kit draws the states from the model and, unless the game handles it (`host_handles`),
## runs the two calls on `PolarisKey.keyring`: `recover(code)` and `reset(true)`
## (`PKeyCloudSyncController`). Nearby unlock is never offered in v0.10.0.
##
## Steps: `code`, `invalid` ("That code isn't right." until the field is edited), `working` (nothing
## else to press, and Escape is ignored), `failed` (Try again repeats the unlock),
## `start-over-failed` (Start over did not run: its own line, and Try again repeats the start over),
## `no-code` (the account holds none, so
## only Start over helps) and `start-over` (the warning that synced data will be lost; Start over
## first, Cancel last with the first focus, and Start over arms about half a second after the warning
## appears so a double press cannot run it).
##
## The host's contract: after `unlocked` or `started_over` the screen stays on `working` (nothing to
## press, no empty form) until the host closes it or replaces it with `PKeyRecoveryCode`.
##
## The recovery code is entered only in the app (T23): it is never logged, and the field is cleared
## when it is accepted. Cancel on the warning returns to the code step with what was typed kept.
## Hidden when the Sync service is off (`sync_on`).

## The recovery code was accepted: this device holds the key again.
signal unlocked()
## A new ring was made. `recovery_code` is its code, to show once on `PKeyRecoveryCode`.
signal started_over(recovery_code: String)
## Cancel (or Escape) on the code step.
signal cancelled()
## `host_handles`: Unlock was chosen with this code (set `step` as the answer comes back).
signal unlock_requested(code: String)
## `host_handles`: Start over was confirmed.
signal start_over_confirmed()

## How long Start over stays inert after the warning appears, in milliseconds.
const ARM_MSEC := 500

@export_enum("code", "invalid", "working", "failed", "start-over-failed", "no-code", "start-over") var step := "code":
	set(value):
		step = value
		refresh_view()
## False turns the Sync service off: nothing shows.
@export var sync_on := true:
	set(value):
		sync_on = value
		refresh_view()
## The game runs the key ring calls itself: the screen only emits `unlock_requested` and
## `start_over_confirmed`.
@export var host_handles := false

var model: Dictionary = {}

var _product: PKeyProductHeader
var _cols: BoxContainer
var _body: VBoxContainer
var _title: Label
var _lede: Label
var _warning: Label
var _warning_glyph: TextureRect
var _field_block: VBoxContainer
var _field_label: Label
var _field_row: BoxContainer
var _field: LineEdit
var _paste: Button
var _error: Label
var _no_ask: Label
var _status: Label
var _actions: BoxContainer
var _confirm: Button
var _primary: Button
var _start_over: Button
var _cancel_button: Button
var _armed_at := 0
var _last_state := ""
## A mint (Start over) is running: Escape and Cancel do nothing, so a new code is never lost.
var _minting := false
## The step the warning was opened from ("code" or "no-code").
var _back_step := "code"


func _build() -> void:
	name = "PKeyUnlockSync"
	_body = vbox(card_panel(), "Body", "PKeyStack")
	var body := _body
	_product = product_header(body, "Product")
	_product.card = true
	# Two columns in landscape (the words on the left, the field and the actions on the right), one
	# stack otherwise.
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
	var warn := glyph_label(words, "Warning", "warning")
	_warning = warn["label"]
	_warning_glyph = warn["glyph"]
	_status = label(words, "Status", "PKeyMuted")
	loading_bar(left)
	_field_block = vbox(right, "Field", "PKeyTight")
	_field_label = label(_field_block, "FieldLabel", "PKeyStrong")
	# The field and Paste share a row while the room holds both, and stack when it does not.
	_field_row = BoxContainer.new()
	_field_row.name = "FieldRow"
	_field_row.theme_type_variation = "PKeyRow"
	_field_row.set_meta(AUTO_HIDE_META, true)
	_field_row.alignment = BoxContainer.ALIGNMENT_BEGIN
	_field_block.add_child(_field_row)
	_field = LineEdit.new()
	_field.name = "CodeInput"
	_field.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_field.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	# The code is visible and private: drawn in clear so it can be checked, typed on a keyboard that
	# neither corrects nor learns it, and never logged.
	_field.secret = false
	_field.virtual_keyboard_type = LineEdit.KEYBOARD_TYPE_PASSWORD
	_field.caret_blink = true
	_field.max_length = 64
	_field.text_changed.connect(_on_edited)
	_field.text_submitted.connect(func(_t: String) -> void: _on_unlock())
	_field_row.add_child(_field)
	_paste = button(_field_row, "Paste", _on_paste, "PKeyLink")
	_paste.size_flags_horizontal = Control.SIZE_SHRINK_END
	_error = label(_field_block, "Error", "PKeyError")
	_no_ask = label(left, "NoAsk", "PKeyMuted")
	# The actions sit under the field they act on, in the same column.
	_actions = actions_row(right, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_confirm = button(_actions, "ConfirmStartOver", _on_confirm, "PKeyDanger")
	_primary = button(_actions, "Primary", _on_primary, "PKeyPrimary")
	_start_over = button(_actions, "StartOver", _on_start_over, "PKeyLink")
	_cancel_button = button(_actions, "Cancel", _on_cancel)
	for b in [_confirm, _primary, _start_over, _cancel_button, _paste]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


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
	set_columns(_cols, two_pane_fits())
	super(m)
	_fit_field_row()
	_style_destructive(_confirm)
	size_glyph(_warning_glyph, 20.0, get_theme_color("font_color", "PKeyError" if step == "failed" or step == "start-over-failed" else "PKeyMuted"))
	# Short on room, the product header gives way before the card scrolls.
	_product.visible = squeeze_level() < 1
	# Short on room, the gaps between the parts close before the card scrolls.
	_body.theme_type_variation = &"PKeyTight" if squeeze_level() >= 2 else &"PKeyStack"


## Field and Paste on one row where the column holds a legible field beside Paste, else stacked.
func _fit_field_row() -> void:
	var col := (room_x() - role("column_gap")) / 2.0 if two_pane_fits() else room_x()
	var want := text_width(_field, "AAAA-AAAA-AAAA-AA")
	var need := want + _paste.get_combined_minimum_size().x + float(_field_row.get_theme_constant("separation"))
	_field_row.vertical = need > col
	# Never wider than the column it sits in (a large type size on a narrow screen).
	_field.custom_minimum_size.x = minf(want, maxf(col, 0.0) * 0.9)
	_paste.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN if _field_row.vertical else Control.SIZE_SHRINK_END


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide" if two_pane_fits() else "card_width"), content_room().x))


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), sync_on]


func _render() -> void:
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("UnlockSync", PKeyUnlockSync.input(step, sync_on))
	var state: String = model.get("state", "hidden")
	visible = state != "hidden"
	if state == "start-over" and _last_state != "start-over":
		_armed_at = Time.get_ticks_msec() + ARM_MSEC
	_last_state = state
	var in_code := state == "code" or state == "invalid"
	var args := {"product": PKeyUiTheme.isolate(String(PKeyUiTheme.product_identity()["name"]))}
	_product.refresh()
	var title_key := "unlockSync.startOverTitle" if state == "start-over" else "unlockSync.title"
	cat_text(_title, title_key if state != "hidden" else "", args)
	cat_text(_lede, "unlockSync.lede" if in_code else ("unlockSync.noCode" if state == "no-code" else ""), args)
	var warn_key := {"start-over": "unlockSync.startOverWarning", "failed": "unlockSync.failed", "start-over-failed": "unlockSync.startOverFailed"}.get(state, "") as String
	cat_text(_warning, warn_key, args)
	var failing := state == "failed" or state == "start-over-failed"
	_warning.theme_type_variation = &"PKeyError" if failing else &""
	# A failure never rides on colour and words alone.
	_warning_glyph.visible = _warning.visible and failing
	_warning_glyph.set_meta(&"pkey_glyph", "warning")
	cat_text(_status, "common.working" if state == "working" else "", args)
	_field_block.visible = in_code
	cat_text(_field_label, "unlockSync.field" if in_code else "", args)
	cat_text(_paste, "common.paste" if in_code else "", args)
	cat_text(_error, "unlockSync.invalid" if state == "invalid" else "", args)
	_field.theme_type_variation = &"PKeyFieldError" if state == "invalid" else &""
	_field.add_theme_font_override(&"font", get_theme_font(&"font", &"PKeyMono"))
	_field.editable = state == "code" or state == "invalid"
	fx_error("unlockSync.invalid" if state == "invalid" else (warn_key if state == "failed" or state == "start-over-failed" else ""))
	cat_text(_no_ask, "recoveryCode.noAsk" if in_code else "", args)
	cat_text(_confirm, "unlockSync.startOverConfirm" if state == "start-over" else "", args)
	var primary_key := {"code": "unlockSync.unlock", "invalid": "unlockSync.unlock", "failed": "common.tryAgain", "start-over-failed": "common.tryAgain", "no-code": "unlockSync.startOver"}.get(state, "") as String
	cat_text(_primary, primary_key, args)
	cat_text(_start_over, "unlockSync.startOver" if in_code else "", args)
	cat_text(_cancel_button, "common.cancel" if state != "working" and state != "hidden" else "", args)
	_actions.visible = state != "working" and state != "hidden"
	set_loading(state == "working")
	set_process(state == "working")
	_style_destructive(_confirm)
	# The model's primary is the one filled control; the destructive confirm replaces it in the
	# warning, so only one of them shows.
	_primary.visible = primary_key != ""


## The model input of a step (ui-matrix `unlockSync`).
static func input(p_step: String, p_sync_on := true) -> Dictionary:
	var out := {"unlockSync": {"step": p_step}}
	if not p_sync_on:
		out["services"] = ["license", "config", "release", "distribution", "update", "identity"]
	return out


## What the person typed. Held only while the screen is open.
func typed_code() -> String:
	return _field.text


## Put `text` in the field (a paste, or a host that restores it).
func set_typed_code(text: String) -> void:
	_field.text = text


## Clear the field and the focus it holds.
func clear_code() -> void:
	_field.text = ""


func _initial_focus() -> Control:
	match String(model.get("state", "")):
		"start-over":
			# Cancel, never the destructive control (T22).
			return _cancel_button
		"code", "invalid":
			if is_mobile() or pad_only():
				return _paste if is_focusable(_paste) else _primary
			return _field
		"failed", "start-over-failed", "no-code":
			return _primary
	return null


func _focus_chain() -> Array:
	return [_field, _paste, _confirm, _primary, _start_over, _cancel_button]


func _cancel() -> bool:
	if not visible:
		return false
	match String(model.get("state", "")):
		"working":
			# Never lose a code being minted, nor abandon a check half-way.
			return true
		"start-over":
			step = _back_step
			return true
	_on_cancel()
	return true


func _on_edited(_text: String) -> void:
	# "That code isn't right" belongs to the code that was typed: editing it clears the line.
	if step == "invalid":
		step = "code"


func _on_paste() -> void:
	_field.text = PKeyCloudSyncController.clipboard_get().strip_edges()
	_field.caret_column = _field.text.length()
	if step == "invalid":
		step = "code"


func _on_primary() -> void:
	match step:
		"no-code":
			_on_start_over()
		"failed":
			step = "code"
			_on_unlock()
		"start-over-failed":
			_start_reset()
		_:
			_on_unlock()


func _on_start_over() -> void:
	# Cancel on the warning returns to where it was opened from.
	_back_step = "no-code" if step == "no-code" else "code"
	step = "start-over"


func _on_cancel() -> void:
	if _minting:
		return
	if step == "start-over":
		step = _back_step
		return
	cancelled.emit()


func _on_unlock() -> void:
	if step != "code" and step != "invalid":
		return
	var text := _field.text.strip_edges()
	if text == "":
		# Nothing was checked: no error, the field takes the focus.
		_field.grab_focus()
		return
	if host_handles:
		unlock_requested.emit(text)
		return
	step = "working"
	var r: PKeyResult = await PKeyCloudSyncController.recover(sdk, text)
	if not is_instance_valid(self):
		return
	var next := PKeyCloudSyncController.unlock_step(r)
	if next == "":
		# Stays on `working` until the host closes or replaces the screen: no empty form flashes.
		clear_code()
		unlocked.emit()
		return
	step = next


func _on_confirm() -> void:
	# A second press of the same tap lands inside the arming window and does nothing.
	if Time.get_ticks_msec() < _armed_at or step != "start-over" or _minting:
		return
	_start_reset()


## Replace the key (the person confirmed on the warning): a new ring and a new recovery code. A
## failure is its own step, and Try again repeats this.
func _start_reset() -> void:
	if _minting:
		return
	if host_handles:
		start_over_confirmed.emit()
		return
	_minting = true
	step = "working"
	var r: PKeyResult = await PKeyCloudSyncController.start_over(sdk)
	if not is_instance_valid(self):
		return
	_minting = false
	if not r.ok or not (r.detail is Dictionary):
		step = "start-over-failed"
		return
	var code := String(r.detail.get("recovery_code", ""))
	clear_code()
	# Stays on `working` until the host shows the new code (or closes the screen).
	started_over.emit(code)


## The destructive confirm: the danger fill with its own text colour, so it passes contrast in every
## look (the Polaris Key look's danger and dangerOn tokens; a game's own look gets its error red
## and whichever of white or ink reads better on it).
func _style_destructive(b: Button) -> void:
	# The kit's themes carry PKeyDanger (shape, padding and ink follow the primary in every look);
	# a game's own theme without it gets the same fill from here.
	if b.has_theme_stylebox(&"normal", &"PKeyDanger"):
		for item in ["normal", "hover", "pressed"]:
			b.remove_theme_stylebox_override(item)
		for item in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
			b.remove_theme_color_override(item)
		return
	var fill: Color
	var on: Color
	if PKeyUiTheme.branded():
		var dark := PKeyUiTheme.is_dark(self)
		fill = PKeyBrand.Dark.DANGER if dark else PKeyBrand.Light.DANGER
		on = PKeyBrand.Dark.DANGER_ON if dark else PKeyBrand.Light.DANGER_ON
	else:
		fill = get_theme_color(&"font_color", &"PKeyError")
		var ink := PKeyBrand.Dark.SURFACE_PAGE
		on = ink if _contrast(fill, ink) >= _contrast(fill, Color.WHITE) else Color.WHITE
	var base := b.get_theme_stylebox(&"normal")
	b.custom_minimum_size.y = role("control_height")
	for pair in [["normal", 0.0], ["hover", 0.12], ["pressed", 0.22]]:
		var box: StyleBoxFlat = base.duplicate() as StyleBoxFlat if base is StyleBoxFlat else StyleBoxFlat.new()
		var shade := fill.lightened(float(pair[1])) if on.get_luminance() < 0.5 else fill.darkened(float(pair[1]))
		box.draw_center = true
		# The shape of the kit's primary, whether or not the theme had resolved when this ran.
		box.set_corner_radius_all(PKeyUiTheme.RADIUS_CONTROL)
		box.content_margin_left = role("control_padding")
		box.content_margin_right = role("control_padding")
		box.content_margin_top = 8.0
		box.content_margin_bottom = 8.0
		box.bg_color = shade
		box.border_color = shade
		b.add_theme_stylebox_override(String(pair[0]), box)
	for item in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		b.add_theme_color_override(item, on)


static func _contrast(x: Color, y: Color) -> float:
	var lx := x.srgb_to_linear().get_luminance()
	var ly := y.srgb_to_linear().get_luminance()
	return (maxf(lx, ly) + 0.05) / (minf(lx, ly) + 0.05)
