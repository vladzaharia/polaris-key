class_name PKeyOfflineDialog
extends PKeyUiView
## Offline activation (WIRE-CONTRACT-V3 §7): show the request code an operator mints a bundle
## against (this device's id, with Copy and a QR code), then import the `pkey-bundle+jws` that
## comes back, from a file (a FileDialog; the native picker, so Android gets the Storage Access
## Framework), pasted text, or a file dropped on the window (desktop only). On web there is no
## file system to pick from, so only paste is offered.
##
## An import is PolarisKey.import_bundle(text): all-or-nothing; a refusal names the §7 step that
## failed (signature, claims, trust, the licence inside) in plain words.
##
## Layout (PKeyUiView): two numbered steps, "1 Send this code" (the code in a filled field with
## Copy inline, its QR code under it) and "2 Load the reply" (load a file, or paste); in landscape
## they are the two columns, in portrait they stack. Close and Activate share one row along the
## bottom edge (the primary last; stacked with the primary first on a phone). The QR code shows
## only where it fits at a scannable size; the code and Copy carry the request without it.

## A bundle verified and installed.
signal activated()
## The player closed the dialog.
signal closed()

## Override the platform check (snapshots): -1 auto, 0 not web, 1 web.
var web_override := -1
## The product slug and device id shown when there is no SDK (snapshots).
var product := ""
var device_id := ""
## Lead with the product's identity above the steps.
var show_product := true:
	set(value):
		if show_product != value:
			show_product = value
			refresh_view()

var message := ""
var message_ok := false
var busy := false

var _stack: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _body: BoxContainer
var _step1: VBoxContainer
var _step2: VBoxContainer
var _s1_title: Label
var _request: Label
var _code_field: PanelContainer
var _code: Label
var _copy: Button
var _qr: PKeyQrRect
var _s2_title: Label
var _hint: Label
var _load: Button
var _paste: TextEdit
var _drop: Label
var _message: Label
var _spacer: Control
var _actions: BoxContainer
var _import: Button
var _close: Button
var _file_dialog: FileDialog = null


func _build() -> void:
	name = "PKeyOfflineDialog"
	_stack = vbox(card_panel(), "Stack", "PKeySections")
	var head := vbox(_stack, "Head", "PKeyTight")
	_product = product_header(head, "Product")
	_title = label(head, "Title", "PKeyTitle")
	_body = columns(_stack, "Body")
	_step1 = vbox(_body, "Request", "PKeyStack")
	_step1.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_s1_title = label(_step1, "SendTitle", "PKeyStrong")
	_request = label(_step1, "RequestText", "PKeyMuted")
	_code_field = PanelContainer.new()
	_code_field.name = "CodeField"
	_code_field.theme_type_variation = "PKeyRail"
	_step1.add_child(_code_field)
	var cf := hbox(_code_field, "CodeRow")
	_code = label(cf, "RequestCode", "PKeyMono", true)
	_code.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	_code.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_code.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_copy = button(cf, "CopyCode", _on_copy, "PKeyLink")
	_qr = qr_tile(_step1)
	_qr.get_parent().size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	_step2 = vbox(_body, "Import", "PKeyStack")
	_step2.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_s2_title = label(_step2, "LoadTitle", "PKeyStrong")
	_hint = label(_step2, "LoadHint", "PKeyMuted")
	var load_row := actions_row(_step2, "LoadRow", BoxContainer.ALIGNMENT_BEGIN)
	_load = button(load_row, "LoadFile", _on_load)
	_paste = TextEdit.new()
	_paste.name = "Paste"
	_paste.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_paste.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_paste.size_flags_vertical = Control.SIZE_EXPAND_FILL
	tab_leaves(_paste)
	# Ctrl+Enter in the paste box activates.
	_paste.gui_input.connect(func(e: InputEvent) -> void:
		if e is InputEventKey and (e as InputEventKey).pressed and (e as InputEventKey).keycode in [KEY_ENTER, KEY_KP_ENTER] and ((e as InputEventKey).ctrl_pressed or (e as InputEventKey).meta_pressed):
			_paste.accept_event()
			_on_import())
	_step2.add_child(_paste)
	_drop = label(_step2, "DropHint", "PKeyMuted")
	_message = label(_stack, "Message")
	loading_bar(_stack)
	_spacer = spacer(_stack)
	_actions = actions_row(_stack, "Actions", BoxContainer.ALIGNMENT_END)
	_close = button(_actions, "Close", func(): _close_dialog())
	_import = button(_actions, "Import", _on_import, "PKeyPrimary")


func _ready() -> void:
	super()
	var w := get_window()
	if w != null and not _is_web() and not w.files_dropped.is_connected(_on_files_dropped):
		w.files_dropped.connect(_on_files_dropped)


func _process(_delta: float) -> void:
	_tick_loading()


func _bleeds() -> bool:
	return true


func squeeze_max() -> int:
	return 4


func _scrim_wanted() -> bool:
	return true


func _is_web() -> bool:
	return web_override == 1 if web_override >= 0 else OS.has_feature("web")


func _product_slug() -> String:
	if sdk != null and sdk.get("core") != null:
		return sdk.core.product
	return product


func _device_id() -> String:
	if sdk != null and sdk.get("core") != null:
		return sdk.core.device_id
	return device_id


func _screen_key() -> String:
	return "offline"


## The content width this dialog wants (logical pixels, without a host card's padding).
func preferred_width() -> float:
	if is_landscape():
		return role("card_width_wide") - 2.0 * role("card_padding")
	return role("card_width") - 2.0 * role("card_padding")


func _apply_width(width: float) -> void:
	if phone_screen():
		super(0.0)
		return
	super(minf(preferred_width() + card_padding_x(), card_width(INF)) if width > 0.0 else 0.0)


func _arrange(m: Dictionary) -> void:
	super(m)
	var phone := phone_bleed()
	var side: bool = m["landscape"] and not phone_screen()
	var level := squeeze_level()
	set_columns(_body, side)
	# Squeezed: Close and Activate move up into the reply's column (no row of their own), then the
	# request line and the drop hint go.
	if level >= 2 and side:
		place(_actions, _step2)
	else:
		place(_actions, _stack)
	_request.visible = level < 3
	_hint.visible = level < 3
	if level >= 3:
		_drop.visible = false
	elif _drop.text != "":
		_drop.visible = true
	_spacer.visible = phone_screen()
	_paste.custom_minimum_size.y = roundf(role("control_height") * (1.0 if level >= 3 else 1.75))
	# The product's name leads; it is the screen's name for the product, never a slug.
	_product.centered = false
	# The QR code at a scannable size where the screen has the height for it, else not at all.
	var want := _device_id() != "" and not _qr.encode_failed and (not is_phone_device() or pad_only())
	_qr.visible = want
	_qr.get_parent().visible = want
	if want:
		var q := qr_side(content_room().y * 0.4)
		if level >= 1:
			q = maxf(roundf(q * 0.7), QR_MIN_PHYSICAL / float(m["physical"]))
		# Shown at the largest scannable size at which the request column with its QR code still fits
		# the room: side by side, the reply's column is usually the taller one, so the code costs
		# little height and balances the two.
		var tile := _qr.get_parent() as Control
		tile.visible = false
		_qr.visible = false
		var left := _step1.get_combined_minimum_size().y
		var right := _step2.get_combined_minimum_size().y
		var rest := _stack.get_combined_minimum_size().y - _body.get_combined_minimum_size().y
		var pad := tile.get_combined_minimum_size().y
		var least := QR_MIN_PHYSICAL / float(m["physical"])
		var fit_q := 0.0
		var try_q := q
		while try_q >= least - 0.5:
			var with_qr := left + pad + try_q + float(_step1.get_theme_constant("separation"))
			var body_h := maxf(with_qr, right) if side else with_qr + right + float(_body.get_theme_constant("separation"))
			if rest + body_h <= available_height():
				fit_q = try_q
				break
			try_q -= 8.0
		if fit_q <= 0.0 and q > least:
			fit_q = 0.0
		_qr.custom_minimum_size = Vector2(maxf(fit_q, least), maxf(fit_q, least))
		_qr.visible = fit_q > 0.0
		tile.visible = fit_q > 0.0
	# Close, then Activate (the primary last) along the bottom; a phone stacks them, primary first.
	var first := _import if phone else _close
	if _actions.get_child(0) != first:
		_actions.move_child(first, 0)
	_actions.set_meta(&"pkey_align", BoxContainer.ALIGNMENT_BEGIN if phone else BoxContainer.ALIGNMENT_END)


func _render() -> void:
	var t := c()
	var web := _is_web()
	_product.visible = show_product
	if show_product:
		_product.refresh()
	_title.text = t.text("offline_title")
	_s1_title.text = t.text("offline_step_send")
	_request.text = t.text("offline_request")
	show_text(_code, _device_id())
	_code_field.visible = _device_id() != ""
	_qr.text = _device_id()
	_copy.text = t.text("offline_copy_code")
	_copy.visible = _device_id() != ""
	_s2_title.text = t.text("offline_step_load")
	_hint.text = t.text("offline_load_hint")
	_load.text = t.text("offline_load_file")
	_load.get_parent().visible = not web
	_paste.placeholder_text = t.text("offline_paste_placeholder")
	# Dropping a file on the window is a desktop gesture.
	show_text(_drop, t.text("offline_drop_hint") if not web and OS.has_feature("pc") else "")
	show_text(_message, message)
	_message.theme_type_variation = "PKeyMuted" if message_ok else "PKeyError"
	_import.text = t.text("offline_import")
	set_loading(busy)
	set_process(busy)
	_close.text = t.text("close")


func _focus_chain() -> Array:
	return [_copy, _load, _paste, _close, _import] if not phone_screen() else [_copy, _load, _paste, _import, _close]


## Pasting is what the dialog is for; on a pad, Load file (no keyboard to paste with).
func _initial_focus() -> Control:
	if is_focusable(_load) and pad_only():
		return _load
	return _paste if is_focusable(_paste) and not pad_only() else (_load if is_focusable(_load) else _close)


func _cancel() -> bool:
	_close_dialog()
	return true


func _close_dialog() -> void:
	closed.emit()
	restore_opener()


func _on_copy() -> void:
	DisplayServer.clipboard_set(_device_id())
	_set_message(c().text("offline_copied"), true)


func _on_load() -> void:
	if _file_dialog == null:
		_file_dialog = FileDialog.new()
		_file_dialog.name = "FileDialog"
		_file_dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE
		_file_dialog.access = FileDialog.ACCESS_FILESYSTEM
		_file_dialog.use_native_dialog = true
		_file_dialog.file_selected.connect(_load_path)
		add_child(_file_dialog)
	_file_dialog.popup_centered_ratio(0.6)


func _on_files_dropped(files: PackedStringArray) -> void:
	if is_visible_in_tree() and not files.is_empty():
		_load_path(files[0])


## Read a bundle file into the paste box and import it.
func _load_path(path: String) -> void:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null or f.get_length() > PKeyJws.MAX_BUNDLE_BYTES * 2:
		_set_message(c().text("offline_unreadable"), false)
		return
	_paste.text = f.get_as_text().strip_edges()
	_on_import()


func _on_import() -> void:
	var text := _paste.text.strip_edges()
	if text == "":
		_set_message(c().text("offline_empty"), false)
		return
	if sdk == null or not sdk.has_method("import_bundle"):
		_set_message(c().text("offline_unsupported"), false)
		return
	if busy:
		return
	busy = true
	refresh_view()
	var r: PKeyResult = await sdk.import_bundle(text)
	busy = false
	show_import_result(r)


## Render an import result (also used by snapshots).
func show_import_result(r: PKeyResult) -> void:
	if r.ok:
		_set_message(c().text("offline_ok"), true)
		activated.emit()
		return
	_set_message(c().text(message_key(r.code)), false)


## The copy key for an import refusal, by the §7 step its code names.
static func message_key(code: StringName) -> String:
	match code:
		PKeyErrors.BUNDLE_JWS_REJECTED:
			return "offline_jws_rejected"
		PKeyErrors.BUNDLE_CLAIMS_REJECTED:
			return "offline_claims_rejected"
		PKeyErrors.BUNDLE_TRUST_REJECTED:
			return "offline_trust_rejected"
		PKeyErrors.INNER_DOC_REJECTED:
			return "offline_inner_rejected"
		PKeyErrors.UNSUPPORTED, &"bundle-import-unsupported":
			return "offline_unsupported"
	return "offline_not_bundle"


func _set_message(text: String, ok: bool) -> void:
	message = text
	message_ok = ok
	refresh_view()
