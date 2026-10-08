class_name PKeyOfflineDialog
extends PKeyUiView
## Offline activation (WIRE-CONTRACT-V3 §7): show the request code an operator mints a bundle
## against (the product slug and this device's id, with Copy and a QR code), then import the
## `pkey-bundle+jws` that comes back, from a file (a FileDialog; the native picker, so Android
## gets the Storage Access Framework), pasted text, or a file dropped on the window (desktop).
## On web there is no file system to pick from and nothing to drop, so only paste is offered.
##
## An import is PolarisKey.import_bundle(text): all-or-nothing; a refusal names the §7 step that
## failed (signature, claims, trust, the licence inside) in plain words.
##
## Layout (PKeyUiView): the request (the code to send, its QR code, Copy) and the import (load,
## paste, Import) are two columns in landscape and stack in portrait. The QR code shows only where
## it fits at a scannable size; the code and Copy carry the request without it.

## A bundle verified and installed.
signal activated()
## The player closed the dialog.
signal closed()

## Override the platform check (snapshots): -1 auto, 0 not web, 1 web.
var web_override := -1
## The product slug and device id shown when there is no SDK (snapshots).
var product := ""
var device_id := ""

var message := ""
var message_ok := false
var busy := false

var _body: BoxContainer
var _request_col: VBoxContainer
var _import_col: VBoxContainer
var _title: Label
var _request: Label
var _product: Label
var _code: Label
var _qr: PKeyQrRect
var _copy: Button
var _hint: Label
var _load: Button
var _paste: TextEdit
var _import: Button
var _drop: Label
var _message: Label
var _close: Button
var _file_dialog: FileDialog = null


func _build() -> void:
	name = "PKeyOfflineDialog"
	_body = columns(card_panel(), "Body")
	_request_col = vbox(_body, "Request", "PKeyStack")
	_request_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var head := vbox(_request_col, "Head", "PKeyTight")
	_title = label(head, "Title", "PKeyTitle")
	_request = label(head, "RequestText", "PKeyMuted")
	var code := vbox(_request_col, "Code", "PKeyTight")
	_product = label(code, "Product", "PKeyMuted")
	_code = label(code, "RequestCode", "PKeyMono", true)
	_qr = qr_tile(_request_col)
	_qr.get_parent().size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	var copy_row := actions_row(_request_col, "CopyRow", FlowContainer.ALIGNMENT_BEGIN)
	_copy = button(copy_row, "CopyCode", _on_copy)
	_import_col = vbox(_body, "Import", "PKeyStack")
	_import_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_hint = label(_import_col, "LoadHint", "PKeyMuted")
	var load_row := actions_row(_import_col, "LoadRow", FlowContainer.ALIGNMENT_BEGIN)
	_load = button(load_row, "LoadFile", _on_load)
	_paste = TextEdit.new()
	_paste.name = "Paste"
	_paste.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_paste.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_import_col.add_child(_paste)
	_drop = label(_import_col, "DropHint", "PKeyMuted")
	_message = label(_import_col, "Message")
	var actions := actions_row(_import_col, "Actions", FlowContainer.ALIGNMENT_BEGIN)
	_import = button(actions, "Import", _on_import, "PKeyPrimary")
	_close = button(actions, "Close", func(): closed.emit())


## The content width this dialog wants (logical pixels, without a host card's padding).
func preferred_width() -> float:
	if is_landscape():
		return role("card_width_wide") - 2.0 * role("card_padding")
	return role("card_width") - 2.0 * role("card_padding")


func _apply_width(width: float) -> void:
	super(minf(preferred_width() + card_padding_x(), content_room().x) if width > 0.0 else 0.0)


func _arrange(m: Dictionary) -> void:
	super(m)
	set_columns(_body, m["landscape"])
	_paste.custom_minimum_size.y = roundf(role("control_height") * 1.75)
	# The QR code at a scannable size where the screen has the height for it, else not at all.
	var want := _device_id() != "" and not _qr.encode_failed
	_qr.visible = want
	_qr.get_parent().visible = want
	if want:
		var q := qr_side(content_room().y * 0.4)
		_qr.custom_minimum_size = Vector2(q, q)
		var fits := _body.get_combined_minimum_size().y <= available_height()
		_qr.visible = fits
		_qr.get_parent().visible = fits


func _ready() -> void:
	super()
	var w := get_window()
	if w != null and not _is_web() and not w.files_dropped.is_connected(_on_files_dropped):
		w.files_dropped.connect(_on_files_dropped)


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


func _render() -> void:
	var t := c()
	var web := _is_web()
	_title.text = t.text("offline_title")
	_request.text = t.text("offline_request")
	show_text(_product, t.text("offline_product", _product_slug()) if _product_slug() != "" else "")
	show_text(_code, _device_id())
	_qr.text = _device_id()
	_copy.text = t.text("offline_copy_code")
	_copy.visible = _device_id() != ""
	_copy.get_parent().visible = _copy.visible
	_hint.text = t.text("offline_load_hint")
	_load.text = t.text("offline_load_file")
	_load.get_parent().visible = not web
	_paste.placeholder_text = t.text("offline_paste_placeholder")
	show_text(_drop, t.text("offline_drop_hint") if not web else "")
	show_text(_message, message)
	_message.theme_type_variation = "PKeyMuted" if message_ok else "PKeyError"
	_import.text = t.text("offline_import")
	_import.disabled = busy
	_close.text = t.text("close")


func _focus_chain() -> Array:
	return [_copy, _load, _paste, _import, _close]


func _cancel() -> bool:
	closed.emit()
	return true


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
