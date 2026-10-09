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
##
## By device: on a phone it leads with what the player can do there (Open browser, Copy link, the
## code and the address) and never shows a QR code, since the phone opens the browser itself; a
## desktop or tablet adds the QR code for another device; on a pad-only device (a TV, a console, a
## Steam Deck in game mode) there is no browser to open, so the screen is the address, the code
## and the QR code with "Use a license key instead" and Cancel.

## The sign-in ended (every way: PKeySignInResult.kind).
signal finished(result: PKeySignInResult)
## The player closed the dialog after it ended (or cancelled).
signal closed()
## The player chose "Use a license key instead" (a pad-only device has no browser to open).
signal use_key_requested()

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

var _root: VBoxContainer
var _body: BoxContainer
var _qr_column: CenterContainer
var _info: VBoxContainer
var _steps: VBoxContainer
var _product: PKeyProductHeader
var _title_row: HBoxContainer
var _glyph: TextureRect
var _title: Label
var _status: Label
var _instructions: Label
var _url: Label
var _code: Label
var _qr: PKeyQrRect
var _timing: VBoxContainer
var _expires: Label
var _device: Label
var _account: HBoxContainer
var _avatar: PanelContainer
var _initials: Label
var _who: Label
var _email: Label
var _attach: CheckButton
var _spacer: Control
var _actions: BoxContainer
var _open: Button
var _copy: Button
var _use_key: Button
var _continue: Button
var _try_again: Button
var _cancel_btn: Button
var _accum := 0.0
var _busy := false
## A label's own start alignment (mirrored with the layout direction).
var _start: HorizontalAlignment


func _build() -> void:
	name = "PKeySignInDialog"
	_root = vbox(card_panel(), "Stack", "PKeySections")
	_body = columns(_root, "Body")
	_qr_column = CenterContainer.new()
	_qr_column.name = "QrColumn"
	_body.add_child(_qr_column)
	_info = vbox(_body, "Info", "PKeySections")
	_info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_info.size_flags_vertical = Control.SIZE_EXPAND_FILL
	loading_bar(_info)
	var head := vbox(_info, "Header", "PKeyTight")
	_product = product_header(head, "Product")
	_title_row = hbox(head, "TitleRow")
	_glyph = glyph_node(_title_row, "Glyph", "warning")
	_title = label(_title_row, "Title", "PKeyTitle")
	_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_start = _title.horizontal_alignment
	_status = label(head, "Status", "PKeyMuted")
	_steps = vbox(_info, "Steps", "PKeyStack")
	var where := vbox(_steps, "Where", "PKeyTight")
	_instructions = label(where, "Instructions")
	# The address on a line of its own, in the strong colour: the thing to type.
	_url = label(where, "Address", "PKeyStrong", true)
	_code = label(_steps, "UserCode", "PKeyCode", true)
	# One line while the room allows; a last resort breaks it rather than push the card off screen.
	_code.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	_qr = qr_tile(_qr_column)
	_timing = vbox(_steps, "Timing", "PKeyTight")
	_expires = label(_timing, "Expires", "PKeyMuted")
	_device = label(_timing, "DeviceLabel", "PKeyMuted")
	# Who signed in: an initials avatar, the name and, quieter, the e-mail.
	_account = hbox(_steps, "Account")
	_avatar = PanelContainer.new()
	_avatar.name = "Avatar"
	_avatar.theme_type_variation = "PKeyAvatar"
	_avatar.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_account.add_child(_avatar)
	_initials = Label.new()
	_initials.name = "Initials"
	_initials.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_initials.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_initials.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_initials.set_meta(DATA_META, true)
	_avatar.add_child(_initials)
	var who := vbox(_account, "Who", "PKeyTight")
	who.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	who.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_who = label(who, "Name", "PKeyStrong", true)
	_email = label(who, "Email", "PKeyMuted", true)
	# An address is one word: past the width it breaks rather than push the card off screen.
	_email.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	_attach = CheckButton.new()
	_attach.name = "AttachLicense"
	_attach.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	# A long label wraps rather than widening the dialog past a narrow screen.
	_attach.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_attach.size_flags_horizontal = Control.SIZE_FILL
	_steps.add_child(_attach)
	_spacer = spacer(_info)
	_actions = actions_row(_info, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_open = button(_actions, "OpenBrowser", _on_open, "PKeyPrimary")
	_use_key = button(_actions, "UseKey", _on_use_key, "PKeyPrimary")
	_continue = button(_actions, "Continue", _on_continue, "PKeyPrimary")
	_try_again = button(_actions, "TryAgain", begin, "PKeyPrimary")
	_copy = button(_actions, "CopyLink", _on_copy)
	_cancel_btn = button(_actions, "Cancel", _on_cancel)


func _bleeds() -> bool:
	return true


func squeeze_max() -> int:
	return 3


func _scrim_wanted() -> bool:
	return true


## A QR code shows only on a TV, a console or any pad-only device, where there is no browser to open;
## a phone, a tablet and a desktop open the browser (Open browser, Copy link) and show the code.
func _is_phone() -> bool:
	return is_phone_device()


func _pad() -> bool:
	return pad_only()


func _screen_key() -> String:
	return "%s|%s" % [state, str(result.kind) if result != null and state == "ended" else ""]


## Whether the QR code is on this screen: with a code, never on a phone.
func _qr_wanted() -> bool:
	return _showing_code() and _qr.text != "" and not _qr.encode_failed and _pad()


func _showing_code() -> bool:
	return state == "pending" and prompt != null


func _pending() -> bool:
	return _showing_code()


## A landscape layout puts the QR code beside the text; it keeps its column while the code is
## still on its way (starting), so the card does not jump when it arrives.
func _side_by_side() -> bool:
	if not (is_landscape() and not phone_screen() and (_qr_wanted() or (state == "starting" and _pad()))):
		return false
	# Only while the QR code, its gaps and a text column wide enough for the code fit the room.
	var text_min := maxf(role("card_width") * 0.5, text_width(_code, _code.text if _code.text != "" else "WDJB-MJHT"))
	return _qr_px(true) + role("space_3") * 2.0 + role("column_gap") + text_min <= room_x()


## The QR code's side: the theme's, within the room, smaller once the layout has squeezed.
func _qr_px(side: bool) -> float:
	var room := content_room()
	var q := qr_side(room.y * 0.62 if side else minf(room.x, room.y * 0.4))
	if squeeze_level() >= 1:
		q = maxf(roundf(q * 0.7), QR_MIN_PHYSICAL / float(layout_metrics()["physical"]))
	return q


## The content width this dialog wants (logical pixels, without a host card's padding), for a host
## that sizes it: the QR code, the column gap and a text column in landscape while a code shows.
func preferred_width() -> float:
	var text := role("card_width") * 0.95
	if _side_by_side():
		return _qr_px(true) + role("space_3") * 2.0 + role("column_gap") + text
	return role("card_width") - 2.0 * role("card_padding")


func _apply_width(width: float) -> void:
	if phone_screen():
		_info.custom_minimum_size.x = 0.0
		super(0.0)
		return
	var content := _content()
	if content == null:
		return
	# The card hugs its content: the QR column and a text column of a set width, so the padding is
	# the same on both sides; stacked, one column at a card's width.
	var avail := room_x()
	var side := _side_by_side()
	var info_w := minf(role("card_width") * 0.95, avail - (_qr_px(true) + role("space_3") * 2.0 + role("column_gap")) if side else avail)
	if side:
		# What the QR column and the gap really take, not what they were planned to.
		info_w = minf(info_w, avail - _qr_column.get_combined_minimum_size().x - float(_body.get_theme_constant("separation")))
	if not side:
		info_w = minf(role("card_width") - 2.0 * role("card_padding"), avail)
		if _column_mode():
			info_w = minf(info_w, avail - role("card_width") * 0.5 - role("column_gap"))
	_info.custom_minimum_size.x = maxf(info_w, 0.0)
	content.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	content.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	content.custom_minimum_size.x = 0.0


## Squeezed on a short landscape screen with no QR column: the actions are a column of their own.
func _column_mode() -> bool:
	var m := layout_metrics()
	var room: Vector2 = m["room"]
	# (Not while a QR code shows: its tile is as wide as the column the actions would take.)
	return squeeze_level() >= 2 and not _side_by_side() and not _qr_wanted() and room.x >= room.y * 1.3 and room.x >= 560.0 * float(m["scale"]) and not phone_screen()


func _arrange(m: Dictionary) -> void:
	super(m)
	var phone := phone_bleed()
	_body.size_flags_vertical = Control.SIZE_EXPAND_FILL if phone_screen() else Control.SIZE_FILL
	var side := _side_by_side()
	var level := squeeze_level()
	# Squeezed on a short screen: the actions go where they cost no height (under both columns, or a
	# column of their own beside the steps), then the secondary lines go.
	var under: bool = level >= 2 and side
	var column: bool = _column_mode()
	set_columns(_body, side or column)
	if under:
		place(_actions, _root)
	elif column:
		place(_actions, _body)
	else:
		place(_actions, _info)
	_actions.set_meta(&"pkey_force_stack", column)
	if column:
		_actions.custom_minimum_size.x = roundf(role("card_width") * 0.5)
		_actions.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	else:
		_actions.custom_minimum_size.x = 0.0
	_device.visible = _device.visible and level < 3
	_timing.visible = _expires.visible or _device.visible
	var tile := _qr.get_parent()
	if side:
		place(tile, _qr_column)
	else:
		place(tile, _steps, _code.get_index() + 1)
	_qr_column.visible = side
	_spacer.visible = phone_screen() and not under
	# The QR code: as large as the theme asks, within the room the screen leaves.
	var room := content_room()
	var q := _qr_px(side)
	_qr.custom_minimum_size = Vector2(q, q)
	_qr_column.custom_minimum_size = Vector2(q + role("space_3") * 2.0, 0) if side else Vector2.ZERO
	# Landscape and a phone read from the start edge; a stacked desktop column is centred, so is
	# the QR code.
	var centred: bool = not (side or m["landscape"] or phone_screen())
	for l in [_title, _status, _instructions, _url, _code, _expires, _device]:
		(l as Label).horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER if centred else _start
	_actions.set_meta(&"pkey_align", BoxContainer.ALIGNMENT_CENTER if centred else BoxContainer.ALIGNMENT_BEGIN)
	_product.centered = centred
	_title_row.alignment = BoxContainer.ALIGNMENT_CENTER if centred else BoxContainer.ALIGNMENT_BEGIN
	_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_glyph(_glyph, 24.0, get_theme_color("font_color", "PKeyWarning"))
	var ink := get_theme_font_size("font_size", "PKeyStrong") if has_theme_font_size("font_size", "PKeyStrong") else 0
	_avatar.custom_minimum_size = Vector2.ONE * roundf(role("control_height") * 0.8)
	_initials.add_theme_font_size_override("font_size", maxi(14, roundi(role("control_height") * 0.34)))
	_tick_loading()


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
	result = r
	if r.kind == PKeySignInResult.KIND_CANCELLED:
		# A cancel is the player's own choice: it closes the dialog, it does not show a card.
		var already := state == "cancelled"
		state = "cancelled"
		finished.emit(r)
		if not already:
			closed.emit()
			restore_opener()
		return
	state = "ended"
	refresh_view()
	finished.emit(r)


func _now() -> float:
	return float(now_source.call()) if now_source.is_valid() else Time.get_unix_time_from_system()


func _render() -> void:
	var t := c()
	var pending := _pending()
	var confirming := state == "confirm"
	var ended := state == "ended" and result != null
	var expired := ended and (result.kind == PKeySignInResult.KIND_EXPIRED or result.kind == PKeySignInResult.KIND_TIMEOUT)
	var failed := ended and not result.ok
	_product.visible = show_product
	if show_product:
		_product.refresh()
	_title.text = t.text("sign_in_confirm_title") if confirming else (t.text("sign_in_expired_title") if expired else t.text("sign_in_title"))
	_glyph.visible = expired
	var status := ""
	if state == "starting":
		status = t.text("sign_in_starting")
	elif ended and not expired:
		status = t.text(PKeySignInController.message_for(result.kind))
	elif pending and copied:
		status = t.text("sign_in_copied")
	show_text(_status, status)
	_status.theme_type_variation = "PKeyError" if failed and not expired else "PKeyMuted"
	set_loading(state == "starting")
	# Without a QR code on the screen the line never says "scan".
	show_text(_instructions, (t.text("sign_in_instructions") if _qr_wanted() else t.text("sign_in_instructions_plain")) if pending else "")
	show_text(_url, PKeySignInController.short_uri(prompt.verification_uri) if pending else "")
	show_text(_code, prompt.user_code if pending else "")
	_qr.text = prompt.verification_uri_complete if pending else ""
	var qr_on := _qr_wanted()
	_qr.visible = qr_on
	_qr.get_parent().visible = qr_on
	show_text(_expires, t.text("sign_in_expires", PKeySignInController.clock(PKeySignInController.remaining(prompt, _now()))) if pending else "")
	# The label the page will show, as the Worker stored it (the echo), so the player can match it.
	show_text(_device, t.text("sign_in_device", prompt.device_name) if pending and prompt.device_name != "" else "")
	_timing.visible = _expires.visible or _device.visible
	var identity: Dictionary = confirmation.get("identity", {}) if confirming else {}
	var name_text := String(identity.get("name", "")) if identity.get("name") is String else ""
	var email_text := String(identity.get("email", "")) if identity.get("email") is String else ""
	_account.visible = confirming and (name_text != "" or email_text != "")
	_who.text = name_text if name_text != "" else email_text
	_email.text = email_text if name_text != "" else ""
	_email.visible = _email.text != ""
	var seed := (name_text if name_text != "" else email_text).strip_edges()
	_initials.text = seed.left(1).capitalize() if seed != "" else ""
	var has_link := pending and prompt.verification_uri_complete != ""
	var pad := _pad()
	# A pad-only device has no browser: the code and the QR code are the screen, with a way to a key.
	_open.visible = has_link and not pad
	_open.text = t.text("sign_in_open_browser")
	_copy.visible = has_link and not pad
	_copy.text = t.text("sign_in_copy_link")
	_use_key.visible = (pending or state == "starting") and pad
	_use_key.text = t.text("sign_in_use_key")
	_attach.visible = confirming and confirmation.get("attachable") == true
	_attach.text = t.text("sign_in_attach")
	_continue.visible = confirming
	_continue.text = t.text("sign_in_continue")
	_try_again.visible = failed
	_try_again.text = t.text("sign_in_new_code") if expired else t.text("retry")
	_cancel_btn.text = t.text("close") if ended else t.text("cancel")
	set_process(pending or state == "starting")


func _focus_chain() -> Array:
	return [_attach, _open, _use_key, _continue, _try_again, _copy, _cancel_btn]


## A code on its way or on screen leads with its primary, never Cancel (a habitual A press must not
## cancel the sign-in): Open browser, or "Use a license key instead" on a pad.
func _initial_focus() -> Control:
	for b in [_open, _use_key, _continue, _try_again]:
		if is_focusable(b):
			return b
	return _cancel_btn


func _process(delta: float) -> void:
	_tick_loading()
	_accum += delta
	if _accum >= 1.0:
		_accum = 0.0
		if state == "pending" and prompt != null:
			var left := PKeySignInController.remaining(prompt, _now())
			if left <= 0.0:
				# The code ran out: say so now, without waiting for the poll to answer.
				result = PKeySignInResult.ended(PKeySignInResult.KIND_EXPIRED, PKeyErrors.SIGN_IN_EXPIRED, "")
				state = "ended"
				refresh_view()
				return
			_expires.text = c().text("sign_in_expires", PKeySignInController.clock(left))


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




func _on_use_key() -> void:
	use_key_requested.emit()
	_on_cancel()


func _on_continue() -> void:
	if _busy:
		return
	if sdk != null and sdk.get("identity") != null:
		sdk.identity.accept_sign_in(_attach.visible and _attach.button_pressed)


func _on_cancel() -> void:
	if state == "ended":
		closed.emit()
		restore_opener()
		return
	if sdk != null and sdk.get("identity") != null:
		sdk.identity.cancel()
	# Cancelling closes the dialog at once; the flow's own cancelled result changes nothing more.
	state = "cancelled"
	closed.emit()
	restore_opener()


func _cancel() -> bool:
	_on_cancel()
	return true
