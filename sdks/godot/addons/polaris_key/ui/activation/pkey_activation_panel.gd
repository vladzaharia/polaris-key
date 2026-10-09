class_name PKeyActivationPanel
extends PKeyUiView
## The ways this build can be activated, and only those (PKeyActivationController): a licence
## key field (License on), "Sign in" (Identity available; opens PKeySignInDialog in place),
## "Continue free" (keyless enrolment offered by the game, never on web) and "Activate offline"
## (a link; opens PKeyOfflineDialog in place). Every PKeyActivationResult kind reads as plain
## words, beside the thing it is about: a rejected key under the key field (the field in its error
## style, focus on it), a Sign in or Continue free failure under that button.
##
## The capabilities come from `sdk` (PolarisKey) when it is configured, unless
## `set_capabilities()` was called (snapshots, a custom flow). The dialogs open inside the panel,
## never as a separate window, so a gamepad never loses focus.
##
## Layout (PKeyUiView): on a wide panel (landscape, at least 680 layout px, aspect 1.5 or more)
## two panes: the product on a sunken pane, as the screen's title, beside the form; on anything
## else one column led by the product. The form has one primary, the key field with Activate (or
## Sign in on a pad-only device, which has no keyboard to type a key with), then the secondaries,
## and the offline link last. A full license is a state of its own (`limit`): one column with the
## seat meter and the way to free a seat.

## A token was minted (key, enrolment or sign-in) or a bundle installed.
signal activated()
## The panel switched between "main", "sign-in" and "offline" (`open_mode()`).
signal mode_changed(mode: String)

## Offer "Continue free" (keyless enrolment, POST /license/enroll) where License runs. Off by
## default: only a product with a free tier turns it on.
@export var offer_enrollment := false
## Show key entry even on an App Store, TestFlight or Play build (off: hidden there, as the
## stores' payment rules require; PKeyActivationController.STORE_OUTLETS).
@export var allow_key_entry_on_store := false

## Where the portal sends the player back once a seat is free (PX-W8): one of the product's
## declared return targets, or "" for none.
@export var return_url := ""
## How "Replace a device" is offered: "auto" (a button, or a QR code where a joypad is the only
## input), "button" or "qr".
@export_enum("auto", "button", "qr") var manage_mode := "auto"

## No longer shows an "Activate" heading (the product names the screen, the form says the rest);
## kept so a host that sets it keeps compiling.
var show_title := true
## Lead with the product's identity (off when a host card already leads with it).
var show_product := true:
	set(value):
		if show_product != value:
			show_product = value
			refresh_view()
## A label above the form ("Use another license"), or "".
var form_title := "":
	set(value):
		form_title = value
		refresh_view()
var mode := "main"
var busy := false
var message := ""
var message_ok := false
## Where `message` shows: "key" (under the key field), "sign_in" or "free" (under that button).
var message_slot := "key"
## The link "Replace a device" opens, or "" (PX-W8). Never an auth failure: it is only offered.
var manage_url := ""
## The device-limit state ({used, limit} as ints, -1 when unknown), or {} when none.
var limit: Dictionary = {}

var _caps_override: Variant = null
var _message_is_data := false
var _stack: VBoxContainer
var _main: BoxContainer
## The product pane (wide) or header (one column).
var intro: VBoxContainer
var _intro_panel: PanelContainer
var _form: VBoxContainer
var _product: PKeyProductHeader
var _form_title: Label
var _key_field: VBoxContainer
var _key_label: Label
var _key: LineEdit
var _submit: Button
var _msg_key: Label
var _sign_in_block: VBoxContainer
var _sign_in: Button
var _msg_sign_in: Label
var _free_block: VBoxContainer
var _free: Button
var _msg_free: Label
var _offline: Button
var _spacer: Control
## The device-limit view.
var _limit_box: VBoxContainer
var _limit_root: VBoxContainer
var _limit_cols: BoxContainer
var _limit_left: VBoxContainer
var _limit_right: VBoxContainer
var _limit_product: PKeyProductHeader
var _limit_title: Label
var _limit_lede: Label
var _seats: HBoxContainer
var _remedy: VBoxContainer
var _manage: Button
var _manage_qr: PKeyQrRect
var _manage_caption: Label
var _limit_actions: BoxContainer
var _again: Button
var _other_key: Button
## The last result's kind.
var last_kind: StringName = &""
var sign_in_dialog: PKeySignInDialog
var offline_dialog: PKeyOfflineDialog
## The control that opened sign-in or offline activation, which gets the focus back on return.
var _mode_return: Control = null


func _build() -> void:
	name = "PKeyActivationPanel"
	_stack = vbox(card_panel(), "Stack", "PKeySections")
	_main = columns(_stack, "Main")
	_intro_panel = PanelContainer.new()
	_intro_panel.name = "Pane"
	_intro_panel.theme_type_variation = "PKeyRail"
	_intro_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_intro_panel.size_flags_stretch_ratio = 0.8
	_main.add_child(_intro_panel)
	intro = vbox(_intro_panel, "Intro", "PKeyStack")
	intro.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_product = product_header(intro, "Product", true)
	_form = vbox(_main, "Form", "PKeyStack")
	_form.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_form.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_form_title = label(_form, "FormTitle", "PKeyMuted")
	_key_field = vbox(_form, "KeyField", "PKeyTight")
	_key_label = label(_key_field, "KeyLabel")
	var row := hbox(_key_field, "KeyRow")
	_key = LineEdit.new()
	_key.name = "KeyInput"
	_key.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_key.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_key.text_submitted.connect(func(_t): _on_submit())
	_key.text_changed.connect(func(_t): _clear_key_error())
	row.add_child(_key)
	_submit = button(row, "Activate", _on_submit, "PKeyPrimary")
	_msg_key = label(_key_field, "Message")
	_sign_in_block = vbox(_form, "SignInBlock", "PKeyTight")
	_sign_in = button(_sign_in_block, "SignIn", _on_sign_in)
	_msg_sign_in = label(_sign_in_block, "SignInMessage")
	_free_block = vbox(_form, "FreeBlock", "PKeyTight")
	_free = button(_free_block, "ContinueFree", _on_free)
	_msg_free = label(_free_block, "FreeMessage")
	_offline = button(_form, "OfflineActivation", _on_offline, "PKeyLink")
	_offline.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_limit_root = vbox(_stack, "Limit", "PKeyStack")
	_limit_box = _limit_root
	_limit_cols = columns(_limit_root, "Columns")
	_limit_left = vbox(_limit_cols, "Left", "PKeyStack")
	_limit_left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_limit_right = vbox(_limit_cols, "Right", "PKeyStack")
	_limit_right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_limit_right.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var lhead := vbox(_limit_left, "Head", "PKeyTight")
	_limit_product = product_header(lhead, "Product")
	_limit_title = label(lhead, "Title", "PKeyTitle")
	_limit_lede = label(lhead, "Lede", "PKeyMuted")
	_seats = hbox(_limit_left, "Seats")
	_remedy = vbox(_limit_right, "Remedy", "PKeyTight")
	_manage = button(_remedy, "FreeDevice", _on_manage)
	_manage_qr = qr_tile(_remedy, "FreeDeviceQr")
	_manage_qr.get_parent().size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_manage_caption = label(_remedy, "FreeDeviceCaption", "PKeyMuted")
	_spacer = spacer(_limit_right)
	_limit_actions = actions_row(_limit_right, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_again = button(_limit_actions, "TryAgain", _on_again, "PKeyPrimary")
	_other_key = button(_limit_actions, "DifferentKey", _on_other_key)
	sign_in_dialog = PKeySignInDialog.new()
	sign_in_dialog.auto_sdk = false
	sign_in_dialog.closed.connect(_back)
	sign_in_dialog.use_key_requested.connect(func() -> void: _key_after_back = true)
	sign_in_dialog.finished.connect(func(r: PKeySignInResult): if r.ok: activated.emit())
	_stack.add_child(sign_in_dialog)
	offline_dialog = PKeyOfflineDialog.new()
	offline_dialog.auto_sdk = false
	offline_dialog.closed.connect(_back)
	offline_dialog.activated.connect(func(): activated.emit())
	_stack.add_child(offline_dialog)


## "Use a license key instead" on a pad-only sign-in returns to the form with the key field focused.
var _key_after_back := false


func _ready() -> void:
	super()
	sign_in_dialog.sdk = sdk
	offline_dialog.sdk = sdk


func _bleeds() -> bool:
	return true


func squeeze_max() -> int:
	return 3


func _screen_key() -> String:
	return "%s|%s" % [mode, "limit" if not limit.is_empty() else ""]


## The width this panel wants (logical pixels, without a host card's padding): two panes on a wide
## panel, one column otherwise, or what an open dialog wants.
func preferred_width() -> float:
	if mode == "sign-in":
		return sign_in_dialog.preferred_width()
	if mode == "offline":
		return offline_dialog.preferred_width()
	if _two_panes() or _limit_side_by_side():
		return role("card_width_wide") - 2.0 * role("card_padding")
	return role("card_width") - 2.0 * role("card_padding")


## The device-limit view's two columns (the state, the way out): on a landscape panel with room.
func _limit_side_by_side() -> bool:
	if limit.is_empty() or mode != "main" or phone_screen() or not bool(layout_metrics().get("landscape", false)):
		return false
	# Only when the width this panel really gets holds both columns (a host card around it can be
	# narrower than the screen): each column keeps most of a single column's width.
	return room_x() + 1.0 >= (role("card_width") - 2.0 * role("card_padding")) * 1.45


func _two_panes() -> bool:
	return bool(layout_metrics().get("wide", false)) and show_product and limit.is_empty() and not phone_screen()


func _apply_width(width: float) -> void:
	if phone_screen():
		super(0.0)
		return
	super(minf(preferred_width() + card_padding_x(), card_width(INF)) if width > 0.0 else 0.0)


func _arrange(m: Dictionary) -> void:
	super(m)
	var two := _two_panes()
	set_columns(_main, two)
	# A pane on its own sunken surface when side by side; a plain, leading header otherwise.
	_intro_panel.visible = show_product and mode == "main"
	if two:
		if _intro_panel.has_theme_stylebox_override("panel"):
			_intro_panel.remove_theme_stylebox_override("panel")
	elif not _intro_panel.has_theme_stylebox_override("panel"):
		_intro_panel.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_product.centered = two
	_product.as_title = two
	_product.hero = two
	_product.card = false
	intro.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_form.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	# A full license on a landscape panel: the state on one side, the way out on the other.
	set_columns(_limit_cols, _limit_side_by_side())
	_spacer.visible = phone_screen() and not limit.is_empty()
	# On a phone's screen a dialog fills the page, so it can dock its actions to the bottom.
	var fill := Control.SIZE_EXPAND_FILL if phone_screen() else Control.SIZE_FILL
	sign_in_dialog.size_flags_vertical = fill
	offline_dialog.size_flags_vertical = fill
	_main.size_flags_vertical = fill
	_limit_box.size_flags_vertical = fill
	_limit_cols.size_flags_vertical = fill
	_limit_right.size_flags_vertical = Control.SIZE_EXPAND_FILL if phone_screen() else Control.SIZE_SHRINK_CENTER
	var qr := qr_side(content_room().y * 0.45)
	if squeeze_level() >= 1:
		qr = maxf(roundf(qr * 0.7), QR_MIN_PHYSICAL / float(m["physical"]))
	_manage_qr.custom_minimum_size = Vector2(qr, qr)
	_seats.custom_minimum_size.y = roundf(role("space_2"))
	# A pad-only device leads with Sign in: it comes first in the form, as the primary.
	var pad := pad_only()
	var first := _sign_in_block if pad else _key_field
	var want := 1 if _form_title.visible else 0
	if _form.get_child(want) != first:
		_form.move_child(first, want)
	_sign_in.theme_type_variation = &"PKeyPrimary" if pad else &""
	_submit.theme_type_variation = &"" if pad else &"PKeyPrimary"
	# "Replace a device" is the one filled primary where it shows (Try again is then secondary); with
	# a QR code instead of the button, Try again is the primary.
	_again.theme_type_variation = &"" if _manage.visible else &"PKeyPrimary"
	_manage.theme_type_variation = &"PKeyPrimary"
	# On a phone the three actions dock together at the bottom, the primary on top.
	var docked := phone_screen() and not limit.is_empty()
	if docked:
		place(_manage, _limit_actions, 0)
	else:
		place(_manage, _remedy, 0)


## Fix the capabilities ({key_entry, sign_in, continue_free, offline}) instead of reading them
## from the SDK; null goes back to the SDK.
func set_capabilities(caps: Variant) -> void:
	_caps_override = caps
	refresh_view()


func capabilities() -> Dictionary:
	if _caps_override is Dictionary:
		return _caps_override
	return PKeyActivationController.capabilities_from(sdk, offer_enrollment, OS.has_feature("web"), allow_key_entry_on_store)


func _render() -> void:
	var t := c()
	var caps := capabilities()
	var in_limit := not limit.is_empty() and mode == "main"
	_main.visible = mode == "main" and not in_limit
	_limit_box.visible = in_limit
	sign_in_dialog.visible = mode == "sign-in"
	offline_dialog.visible = mode == "offline"
	_product.visible = show_product
	if show_product:
		_product.refresh()
	show_text(_form_title, form_title)
	_key_label.text = t.text("key_label")
	_key_field.visible = caps["key_entry"]
	_key.placeholder_text = t.text("key_placeholder")
	_key.editable = true
	_submit.text = t.text("activation_working") if busy else t.text("key_submit")
	_sign_in_block.visible = caps["sign_in"]
	_sign_in.text = t.text("activation_working") if busy and message_slot == "sign_in" else t.text("sign_in")
	_free_block.visible = caps["continue_free"]
	_free.text = t.text("activation_working") if busy and message_slot == "free" else t.text("continue_free")
	_offline.text = t.text("offline_activation")
	_offline.visible = caps["offline"]
	var slots := {"key": _msg_key, "sign_in": _msg_sign_in, "free": _msg_free}
	for k in slots:
		show_text(slots[k], message if k == message_slot else "")
		# A message the caller worded is theirs, not the kit's copy.
		if _message_is_data:
			slots[k].set_meta(DATA_META, true)
		else:
			slots[k].remove_meta(DATA_META)
		(slots[k] as Label).theme_type_variation = &"PKeyMuted" if message_ok else &"PKeyError"
	_key.theme_type_variation = &"PKeyFieldError" if message != "" and not message_ok and message_slot == "key" else &""
	_render_limit(t)


func _render_limit(t: PKeyUiCopy) -> void:
	if limit.is_empty():
		return
	# The device-limit view leads with the product whoever hosts it: a host's own product pane gives
	# way to it (the gate hides its pane while a limit shows).
	_limit_product.visible = true
	_limit_product.refresh()
	var used: int = limit.get("used", -1)
	var cap: int = limit.get("limit", -1)
	if used >= 0 and cap >= 0:
		_limit_title.text = t.text("device_limit_heading_one" if cap == 1 else "device_limit_heading", [str(used), str(cap)])
	else:
		_limit_title.text = t.text("device_limit_heading_unknown")
	_limit_lede.text = t.text("device_limit_lede")
	_limit_lede.visible = squeeze_level() < 3
	# The seat meter: a segment per seat, the used ones filled (text_strong at 80 %), no caption.
	var segments := clampi(cap, 0, 12) if cap > 0 else 0
	while _seats.get_child_count() < segments:
		var seg := PanelContainer.new()
		seg.mouse_filter = Control.MOUSE_FILTER_IGNORE
		seg.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		_seats.add_child(seg)
	for i in _seats.get_child_count():
		var seg := _seats.get_child(i) as PanelContainer
		seg.visible = i < segments
		seg.theme_type_variation = &"PKeySeatOn" if i < clampi(used, 0, segments) else &"PKeySeatOff"
	_seats.visible = segments > 0
	var how := manage_presentation()
	var has_link := manage_url != ""
	_manage.text = t.text("free_device")
	# A phone opens the link itself; a tablet or a pad-only device (a TV) shows the QR code for another
	# device when that is how the link is offered.
	var phone := is_phone_device()
	_manage.visible = has_link and (how == "button" or phone)
	_manage_qr.text = manage_url if how == "qr" and not phone else ""
	_manage_qr.visible = has_link and how == "qr" and not phone and not _manage_qr.encode_failed
	_manage_qr.get_parent().visible = _manage_qr.visible
	show_text(_manage_caption, t.text("free_device_scan") if _manage_qr.visible else "")
	_remedy.visible = _manage.visible or _manage_qr.visible
	_again.text = t.text("retry")
	_other_key.text = t.text("different_key")


## The controls in focus order for the form on screen now.
func _focus_chain() -> Array:
	if mode == "sign-in":
		return sign_in_dialog._focus_chain()
	if mode == "offline":
		return offline_dialog._focus_chain()
	if not limit.is_empty():
		return [_manage, _again, _other_key]
	if pad_only():
		return [_sign_in, _key, _submit, _free, _offline]
	return [_key, _submit, _sign_in, _free, _offline]


## Sign in on a pad-only device (no keyboard to type a key with); otherwise the key field.
func _initial_focus() -> Control:
	if mode == "sign-in":
		return sign_in_dialog._initial_focus()
	if mode == "offline":
		return offline_dialog._initial_focus()
	if not limit.is_empty():
		return _manage if is_focusable(_manage) else _again
	if pad_only() and is_focusable(_sign_in):
		return _sign_in
	if is_focusable(_key):
		return _key
	for b in [_sign_in, _free, _offline]:
		if is_focusable(b):
			return b
	return null


## "button" or "qr" for "Replace a device" here (manage_mode, else the device).
func manage_presentation() -> String:
	if manage_mode == "button" or manage_mode == "qr":
		return manage_mode
	return PKeyActivationController.manage_presentation_here()


## Render an activation result (also used by snapshots). `key` is the key just tried, which a
## device-limit button link to the portal's activate page carries as a fragment (a QR code never).
## `slot` is where an error shows: "key" (a rejected key: under the field, which takes focus),
## "sign_in" or "free" (under that button). A device limit is a state of its own.
func show_result(r: PKeyActivationResult, key := "", slot := "key") -> void:
	manage_url = PKeyActivationController.manage_link(r, key, return_url, manage_presentation() == "qr")
	last_kind = r.kind if r != null else &""
	if r != null and r.kind == PKeyActivationResult.KIND_DEVICE_LIMIT:
		limit = {"used": int(r.device_count) if r.device_count != null else -1, "limit": int(r.limit) if r.limit != null else -1}
		message = ""
		message_ok = false
		refresh_view()
		return
	limit = {}
	_message_is_data = false
	var m := PKeyActivationController.message_for(r)
	message = c().text(m[0], m[1])
	message_ok = r != null and r.ok
	message_slot = slot
	refresh_view()
	if message_ok:
		activated.emit()
	elif slot == "key":
		_key.grab_focus.call_deferred()
	elif slot == "sign_in":
		_sign_in.grab_focus.call_deferred()
	else:
		_free.grab_focus.call_deferred()


## Show a message already worded by the caller (a rejected key the gate reports) under the key
## field, in its error style, with the focus on it.
func show_message(text: String, slot := "key") -> void:
	_message_is_data = true
	message = text
	message_ok = false
	message_slot = slot
	limit = {}
	refresh_view()
	if text != "" and slot == "key":
		_key.grab_focus.call_deferred()


func _clear_key_error() -> void:
	if message != "" and not message_ok and message_slot == "key":
		message = ""
		refresh_view()


func _on_submit() -> void:
	if busy:
		return
	var key := _key.text.strip_edges()
	if key == "":
		message = c().text("activation_key_empty")
		message_ok = false
		message_slot = "key"
		refresh_view()
		_key.grab_focus()
		return
	if sdk == null or sdk.get("license") == null:
		show_result(PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, ""))
		return
	busy = true
	message = ""
	message_slot = "key"
	refresh_view()
	var r: PKeyActivationResult = await sdk.license.activate_with_key(key)
	busy = false
	if r.ok:
		_key.text = ""
	show_result(r, key)


func _on_manage() -> void:
	if manage_url != "":
		OS.shell_open(manage_url)


func _on_again() -> void:
	limit = {}
	manage_url = ""
	message = ""
	refresh_view()
	_key.grab_focus.call_deferred()


func _on_other_key() -> void:
	_key.text = ""
	_on_again()


func _on_free() -> void:
	if busy:
		return
	if sdk == null or sdk.get("license") == null:
		show_result(PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, ""), "", "free")
		return
	busy = true
	message = ""
	message_slot = "free"
	refresh_view()
	var r: PKeyActivationResult = await sdk.license.enroll()
	busy = false
	show_result(r, "", "free")


func _on_sign_in() -> void:
	if busy:
		return
	open_mode("sign-in")
	sign_in_dialog.begin()


func _on_offline() -> void:
	open_mode("offline")


## Show "main", "sign-in" or "offline" (snapshots open a dialog without starting it). The control
## that opened a dialog gets the focus back when it closes.
func open_mode(m: String) -> void:
	var changed := mode != m
	if changed and m != "main":
		var f := get_viewport().gui_get_focus_owner() if is_inside_tree() else null
		_mode_return = f if f != null and (f == self or is_ancestor_of(f)) else null
	mode = m
	sign_in_dialog.sdk = sdk
	offline_dialog.sdk = sdk
	if m == "offline":
		# The request code and product come from the SDK it was just given.
		offline_dialog.refresh_view()
	refresh_view()
	if changed:
		mode_changed.emit(m)


func _back() -> void:
	var to_key := _key_after_back
	_key_after_back = false
	open_mode("main")
	var ret := _mode_return
	_mode_return = null
	if to_key and is_focusable(_key):
		_key.grab_focus.call_deferred()
	elif ret != null and is_instance_valid(ret) and is_focusable(ret):
		ret.grab_focus.call_deferred()


func _cancel() -> bool:
	if not limit.is_empty():
		_on_again()
		return true
	if mode != "main":
		_back()
		return true
	return false
