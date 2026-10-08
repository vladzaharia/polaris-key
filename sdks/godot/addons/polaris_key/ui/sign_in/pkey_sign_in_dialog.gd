class_name PKeySignInDialog
extends PKeyUiView
## Device-code sign-in (P1-07): a large user code, a QR code of `verification_uri_complete`, "Open
## browser" and "Copy link", a countdown from the code's lifetime, and Cancel. Built for a sofa: a
## phone scans the QR code, and every control is reachable with a gamepad.
##
##   $PKeySignInDialog.begin()        # PolarisKey.identity.begin_sign_in(device_name, confirm)
##   $PKeySignInDialog.finished.connect(func(r): if r.ok: ...)
##
## With `confirm_identity`, the flow stops at the signed-in identity ("Is this you?") with an
## optional "attach this device's licence" check, until the player accepts on the device.
## `show_*()` drives the dialog without an SDK (snapshots, a custom flow). Headless logic:
## PKeySignInController.
##
## Layout (PKeyUiView): in landscape the QR code stands on one side and the product, the steps,
## the code and the actions on the other, as a console's device-code screen; in portrait one
## centred column, the code above the QR code. The code and the QR code are the focal point: the
## largest type on the screen and a QR code at the theme's `qr_size`, never under
## QR_MIN_PHYSICAL on screen.

## The sign-in ended (every way: PKeySignInResult.kind).
signal finished(result: PKeySignInResult)
## The player closed the dialog after it ended (or cancelled).
signal closed()

## Shown on the sign-in page as the anti-phishing cue (WIRE-CONTRACT-V4 §12.7.1); empty: the
## SDK's `PKeyOptions.device_name`, else the device's model or OS.
@export var device_name := ""
## Hold at the signed-in identity for the player's acceptance (and offer the licence attach).
@export var confirm_identity := false
## Lead with the product's identity above the title.
var show_product := true:
	set(value):
		if show_product != value:
			show_product = value
			refresh_view()

## `func() -> float` epoch seconds for the countdown (tests); empty: the system clock.
var now_source: Callable = Callable()

var state := "starting"
var prompt: PKeySignInPrompt = null
var confirmation: Dictionary = {}
var result: PKeySignInResult = null
var copied := false

var _body: BoxContainer
var _qr_column: CenterContainer
var _info: VBoxContainer
var _steps: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _status: Label
var _instructions: Label
var _code: Label
var _qr: PKeyQrRect
var _expires: Label
var _device: Label
var _actions: HFlowContainer
var _open: Button
var _copy: Button
var _confirm_body: Label
var _attach: CheckButton
var _continue: Button
var _try_again: Button
var _cancel_btn: Button
var _accum := 0.0
## A label's own start alignment (mirrored with the layout direction).
var _start: HorizontalAlignment


func _build() -> void:
	name = "PKeySignInDialog"
	_body = columns(card_panel(), "Body")
	_qr_column = CenterContainer.new()
	_qr_column.name = "QrColumn"
	_body.add_child(_qr_column)
	_info = vbox(_body, "Info", "PKeySections")
	_info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_info.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var head := vbox(_info, "Header", "PKeyTight")
	_product = product_header(head, "Product")
	_title = label(head, "Title", "PKeyTitle")
	_start = _title.horizontal_alignment
	_status = label(head, "Status", "PKeyMuted")
	_steps = vbox(_info, "Steps", "PKeyStack")
	_instructions = label(_steps, "Instructions")
	_code = label(_steps, "UserCode", "PKeyCode", true)
	_qr = qr_tile(_qr_column)
	var timing := vbox(_steps, "Timing", "PKeyTight")
	_expires = label(timing, "Expires", "PKeyMuted")
	_device = label(timing, "DeviceLabel", "PKeyMuted")
	_confirm_body = label(_steps, "ConfirmBody")
	_attach = CheckButton.new()
	_attach.name = "AttachLicense"
	_attach.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	# A long label wraps rather than widening the dialog past a narrow screen.
	_attach.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_steps.add_child(_attach)
	_actions = actions_row(_info, "Actions")
	_open = button(_actions, "OpenBrowser", _on_open, "PKeyPrimary")
	_copy = button(_actions, "CopyLink", _on_copy)
	_continue = button(_actions, "Continue", _on_continue, "PKeyPrimary")
	_try_again = button(_actions, "TryAgain", begin, "PKeyPrimary")
	_cancel_btn = button(_actions, "Cancel", _on_cancel)


## The content width this dialog wants (logical pixels, without a host card's padding): the QR
## code, the column gap and a text column in landscape while a code shows; one column otherwise.
func preferred_width() -> float:
	var text := role("card_width") - 2.0 * role("card_padding")
	if _pending() and _side_by_side():
		return qr_side() + role("column_gap") + text * 1.1
	return text


func _pending() -> bool:
	return state == "pending" and prompt != null


func _side_by_side() -> bool:
	return is_landscape() and _qr.text != "" and not _qr.encode_failed


func _apply_width(width: float) -> void:
	# On its own, the dialog centres its content at the width it wants (capped by the room).
	super(minf(preferred_width() + card_padding_x(), content_room().x) if width > 0.0 else 0.0)


func _arrange(m: Dictionary) -> void:
	super(m)
	var side := _pending() and _side_by_side()
	set_columns(_body, side)
	var tile := _qr.get_parent()
	if side:
		place(tile, _qr_column)
	else:
		place(tile, _steps, _code.get_index() + 1)
	_qr_column.visible = side and _qr.visible
	# The QR code: as large as the theme asks, within the room the screen leaves.
	var room := content_room()
	var q := qr_side(room.y * 0.62 if side else minf(room.x, room.y * 0.4))
	_qr.custom_minimum_size = Vector2(q, q)
	# Landscape reads on from the QR code, from the start edge; a portrait column is centred.
	var centred: bool = not (side or m["landscape"])
	for l in [_title, _status, _instructions, _code, _expires, _device, _confirm_body]:
		(l as Label).horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER if centred else _start
	_actions.alignment = FlowContainer.ALIGNMENT_CENTER if centred else FlowContainer.ALIGNMENT_BEGIN
	_product.centered = centred


## Start a sign-in through `sdk.identity` and follow it to the end.
func begin() -> void:
	show_starting()
	if sdk == null or sdk.get("identity") == null:
		show_result(PKeySignInResult.ended(PKeySignInResult.KIND_SERVICE_UNAVAILABLE, PKeyErrors.NOT_CONFIGURED, "No SDK."))
		return
	var identity: PKeyIdentity = sdk.identity
	if not identity.sign_in_pending.is_connected(show_prompt):
		identity.sign_in_pending.connect(show_prompt)
		identity.sign_in_confirm.connect(show_confirm)
		identity.sign_in_finished.connect(show_result)
	identity.begin_sign_in(device_name, confirm_identity)


func show_starting() -> void:
	state = "starting"
	prompt = null
	result = null
	copied = false
	refresh_view()


func show_prompt(p: PKeySignInPrompt) -> void:
	state = "pending"
	prompt = p
	copied = false
	refresh_view()


func show_confirm(c_: Dictionary) -> void:
	state = "confirm"
	confirmation = c_
	refresh_view()


func show_result(r: PKeySignInResult) -> void:
	state = "ended"
	result = r
	refresh_view()
	finished.emit(r)


func _now() -> float:
	return float(now_source.call()) if now_source.is_valid() else Time.get_unix_time_from_system()


func _render() -> void:
	var t := c()
	var pending := _pending()
	var confirming := state == "confirm"
	_product.visible = show_product
	if show_product:
		_product.refresh()
	var ended := state == "ended" and result != null
	_title.text = t.text("sign_in_confirm_title") if confirming else t.text("sign_in_title")
	var status := ""
	if state == "starting":
		status = t.text("sign_in_starting")
	elif ended:
		status = t.text(PKeySignInController.message_for(result.kind))
	elif pending and copied:
		status = t.text("sign_in_copied")
	show_text(_status, status)
	_status.theme_type_variation = "PKeyError" if ended and not result.ok else "PKeyMuted"
	show_text(_instructions, t.text("sign_in_instructions", PKeySignInController.short_uri(prompt.verification_uri)) if pending else "")
	show_text(_code, prompt.user_code if pending else "")
	_qr.text = prompt.verification_uri_complete if pending else ""
	_qr.visible = pending and not _qr.encode_failed
	show_text(_expires, t.text("sign_in_expires", PKeySignInController.clock(PKeySignInController.remaining(prompt, _now()))) if pending else "")
	# The label the page will show, as the Worker stored it (the echo), so the player can match it.
	show_text(_device, t.text("sign_in_device", prompt.device_name) if pending and prompt.device_name != "" else "")
	_expires.get_parent().visible = _expires.visible or _device.visible
	_open.visible = pending and prompt.verification_uri_complete != ""
	_open.text = t.text("sign_in_open_browser")
	_copy.visible = _open.visible
	_copy.text = t.text("sign_in_copy_link")
	show_text(_confirm_body, t.text("sign_in_confirm_body", PKeySignInController.identity_line(confirmation.get("identity", {}))) if confirming else "")
	_attach.visible = confirming and confirmation.get("attachable") == true
	_attach.text = t.text("sign_in_attach")
	_continue.visible = confirming
	_continue.text = t.text("sign_in_continue")
	_try_again.visible = ended and not result.ok
	_try_again.text = t.text("retry")
	_cancel_btn.text = t.text("close") if ended else t.text("cancel")
	set_process(pending)


func _focus_chain() -> Array:
	return [_open, _copy, _attach, _continue, _try_again, _cancel_btn]


func _process(delta: float) -> void:
	_accum += delta
	if _accum >= 1.0:
		_accum = 0.0
		if state == "pending" and prompt != null:
			_expires.text = c().text("sign_in_expires", PKeySignInController.clock(PKeySignInController.remaining(prompt, _now())))


func _on_open() -> void:
	if sdk != null and sdk.get("identity") != null:
		sdk.identity.open_in_browser(prompt)
	elif prompt != null:
		OS.shell_open(prompt.verification_uri_complete)


func _on_copy() -> void:
	if prompt == null:
		return
	DisplayServer.clipboard_set(prompt.verification_uri_complete)
	copied = true
	refresh_view()


func _on_continue() -> void:
	if sdk != null and sdk.get("identity") != null:
		sdk.identity.accept_sign_in(_attach.visible and _attach.button_pressed)


func _on_cancel() -> void:
	if state == "ended":
		closed.emit()
		return
	if sdk != null and sdk.get("identity") != null:
		sdk.identity.cancel()
	else:
		show_result(PKeySignInResult.ended(PKeySignInResult.KIND_CANCELLED, PKeyErrors.CANCELLED, ""))


func _cancel() -> bool:
	_on_cancel()
	return true
