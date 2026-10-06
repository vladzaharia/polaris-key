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

## The sign-in ended (every way: PKeySignInResult.kind).
signal finished(result: PKeySignInResult)
## The player closed the dialog after it ended (or cancelled).
signal closed()

## Shown on the sign-in page as the anti-phishing cue (WIRE-CONTRACT-V4 §12.7.1); empty: the
## SDK's `PKeyOptions.device_name`, else the device's model or OS.
@export var device_name := ""
## Hold at the signed-in identity for the player's acceptance (and offer the licence attach).
@export var confirm_identity := false

## `func() -> float` epoch seconds for the countdown (tests); empty: the system clock.
var now_source: Callable = Callable()

var state := "starting"
var prompt: PKeySignInPrompt = null
var confirmation: Dictionary = {}
var result: PKeySignInResult = null
var copied := false

var _title: Label
var _status: Label
var _instructions: Label
var _code: Label
var _qr: PKeyQrRect
var _expires: Label
var _device: Label
var _open: Button
var _copy: Button
var _confirm_body: Label
var _attach: CheckButton
var _continue: Button
var _try_again: Button
var _cancel_btn: Button
var _accum := 0.0


func _build() -> void:
	name = "PKeySignInDialog"
	var box := vbox(self, "Body", 12)
	_title = label(box, "Title", "PKeyTitle")
	_status = label(box, "Status", "PKeyMuted")
	_instructions = label(box, "Instructions", "PKeyMuted")
	_code = label(box, "UserCode", "PKeyCode", true)
	_code.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_qr = PKeyQrRect.new()
	_qr.name = "QrCode"
	_qr.custom_minimum_size = Vector2(220, 220)
	_qr.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	box.add_child(_qr)
	_expires = label(box, "Expires", "PKeyMuted")
	_device = label(box, "DeviceLabel", "PKeyMuted")
	var links := hbox(box, "Links")
	links.alignment = BoxContainer.ALIGNMENT_CENTER
	_open = button(links, "OpenBrowser", _on_open)
	_copy = button(links, "CopyLink", _on_copy)
	_confirm_body = label(box, "ConfirmBody")
	_attach = CheckButton.new()
	_attach.name = "AttachLicense"
	_attach.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	box.add_child(_attach)
	var actions := hbox(box, "Actions")
	actions.alignment = BoxContainer.ALIGNMENT_CENTER
	_continue = button(actions, "Continue", _on_continue, "PKeyPrimary")
	_try_again = button(actions, "TryAgain", begin, "PKeyPrimary")
	_cancel_btn = button(actions, "Cancel", _on_cancel)


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
	var pending := state == "pending" and prompt != null
	var confirming := state == "confirm"
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
