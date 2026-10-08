class_name PKeyActivationPanel
extends PKeyUiView
## The ways this build can be activated, and only those (PKeyActivationController): a licence
## key field (License on), "Sign in" (Identity available; opens PKeySignInDialog in place),
## "Continue free" (keyless enrolment offered by the game, never on web) and "Offline
## activation…" (opens PKeyOfflineDialog in place). Every PKeyActivationResult kind reads as
## plain words.
##
## The capabilities come from `sdk` (PolarisKey) when it is configured, unless
## `set_capabilities()` was called (snapshots, a custom flow). The dialogs open inside the panel,
## never as a separate window, so a gamepad never loses focus.
##
## Layout (PKeyUiView): the intro (the product, the title, the subtitle) and the form are two
## columns in landscape and stack in portrait; the key field leads the form, the one primary
## action beside it, the other ways in below. A host card that leads with its own column (the
## gate) adopts `intro` into it (`adopt_intro()`).

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

## Show the panel's own "Activate" title (off when a host card already has one).
var show_title := true:
	set(value):
		if show_title != value:
			show_title = value
			refresh_view()
## Lead with the product's identity above the title (off when a host card already leads with it).
var show_product := true:
	set(value):
		if show_product != value:
			show_product = value
			refresh_view()
var mode := "main"
var busy := false
var message := ""
var message_ok := false
## The link "Replace a device" opens, or "" (PX-W8). Never an auth failure: it is only offered.
var manage_url := ""

var _caps_override: Variant = null
## The intro column (product, title, subtitle); a host may adopt it (`adopt_intro()`).
var intro: VBoxContainer
var _adopted: Node = null
var _form: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _subtitle: Label
var _key_label: Label
var _key: LineEdit
var _submit: Button
var _sign_in: Button
var _free: Button
var _offline: Button
var _message: Label
var _manage: Button
var _manage_qr: PKeyQrRect
var _manage_caption: Label
var _manage_box: VBoxContainer
## The last result's kind.
var last_kind: StringName = &""
var _main: BoxContainer
var sign_in_dialog: PKeySignInDialog
var offline_dialog: PKeyOfflineDialog


func _build() -> void:
	name = "PKeyActivationPanel"
	var root := vbox(card_panel(), "Stack", "PKeySections")
	_main = columns(root, "Main")
	intro = vbox(_main, "Intro", "PKeyStack")
	intro.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	intro.size_flags_stretch_ratio = 0.8
	_product = product_header(intro, "Product", true)
	var head := vbox(intro, "Head", "PKeyTight")
	_title = label(head, "Title", "PKeyTitle")
	_subtitle = label(head, "Subtitle", "PKeyMuted")
	_form = vbox(_main, "Form", "PKeyStack")
	_form.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var field := vbox(_form, "KeyField", "PKeyTight")
	_key_label = label(field, "KeyLabel")
	var row := hbox(field, "KeyRow")
	_key = LineEdit.new()
	_key.name = "KeyInput"
	_key.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_key.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_key.text_submitted.connect(func(_t): _on_submit())
	row.add_child(_key)
	_submit = button(row, "Activate", _on_submit, "PKeyPrimary")
	_message = label(_form, "Message")
	_manage = button(_form, "FreeDevice", _on_manage)
	# The QR code to replace a device and its caption move together: under the intro in two
	# columns (the form keeps its height), under the message in one.
	_manage_box = vbox(_form, "Replace", "PKeyTight")
	_manage_qr = qr_tile(_manage_box, "FreeDeviceQr")
	_manage_qr.get_parent().size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_manage_caption = label(_manage_box, "FreeDeviceCaption", "PKeyMuted")
	_sign_in = button(_form, "SignIn", _on_sign_in)
	_free = button(_form, "ContinueFree", _on_free)
	_offline = button(_form, "OfflineActivation", _on_offline)
	sign_in_dialog = PKeySignInDialog.new()
	sign_in_dialog.auto_sdk = false
	sign_in_dialog.closed.connect(_back)
	sign_in_dialog.finished.connect(func(r: PKeySignInResult): if r.ok: activated.emit())
	root.add_child(sign_in_dialog)
	offline_dialog = PKeyOfflineDialog.new()
	offline_dialog.auto_sdk = false
	offline_dialog.closed.connect(_back)
	offline_dialog.activated.connect(func(): activated.emit())
	root.add_child(offline_dialog)


## Move the intro column under `host` (a host card's lead column), or back into the panel with
## null. The intro holds no control, so the focus chain is untouched.
func adopt_intro(host: Node) -> void:
	if host == _adopted:
		return
	_adopted = host
	if host != null:
		place(intro, host)
	else:
		place(intro, _main, 0)


## The content width this panel wants (logical pixels, without a host card's padding): the two
## columns in landscape, one column otherwise, or what an open dialog wants.
func preferred_width() -> float:
	if mode == "sign-in":
		return sign_in_dialog.preferred_width()
	if mode == "offline":
		return offline_dialog.preferred_width()
	if is_landscape() and _adopted == null:
		return role("card_width_wide") - 2.0 * role("card_padding")
	if is_landscape():
		return (role("card_width_wide") - 2.0 * role("card_padding") - role("column_gap")) * 0.55
	return role("card_width") - 2.0 * role("card_padding")


func _apply_width(width: float) -> void:
	super(minf(preferred_width() + card_padding_x(), content_room().x) if width > 0.0 else 0.0)


func _arrange(m: Dictionary) -> void:
	super(m)
	# Two columns only while the intro is the panel's own and the screen is landscape.
	set_columns(_main, m["landscape"] and _adopted == null)
	if m["landscape"]:
		place(_manage_box, intro)
	else:
		place(_manage_box, _form, _message.get_index() + 1)
	var qr := qr_side(content_room().y * 0.45)
	_manage_qr.custom_minimum_size = Vector2(qr, qr)
	# On a small landscape screen the QR code to replace a device needs the intro's height: the
	# product's identity gives way to it there.
	_product.visible = show_product and not (m["landscape"] and m["density"] == "compact" and _manage_qr.visible)
	# With the QR code in it, the intro column takes half the width (its caption needs it).
	intro.size_flags_stretch_ratio = 1.0 if _manage_qr.visible else 0.8


func _ready() -> void:
	super()
	sign_in_dialog.sdk = sdk
	offline_dialog.sdk = sdk


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
	_main.visible = mode == "main"
	sign_in_dialog.visible = mode == "sign-in"
	offline_dialog.visible = mode == "offline"
	_product.visible = show_product
	if show_product:
		_product.refresh()
	_title.text = t.text("activation_title")
	_title.visible = show_title
	intro.visible = mode == "main" and (_product.visible or show_title or caps["key_entry"] or caps["sign_in"])
	var subtitle := ""
	if caps["key_entry"] and caps["sign_in"]:
		subtitle = "activation_subtitle"
	elif caps["key_entry"]:
		subtitle = "activation_subtitle_key"
	elif caps["sign_in"]:
		subtitle = "activation_subtitle_sign_in"
	show_text(_subtitle, t.text(subtitle) if subtitle != "" else "")
	_key_label.text = t.text("key_label")
	_key_label.visible = caps["key_entry"]
	_key.get_parent().get_parent().visible = caps["key_entry"]
	_key.placeholder_text = t.text("key_placeholder")
	_key.editable = not busy
	_submit.text = t.text("activation_working") if busy else t.text("key_submit")
	_submit.disabled = busy
	_sign_in.text = t.text("sign_in")
	_sign_in.visible = caps["sign_in"]
	_sign_in.disabled = busy
	_free.text = t.text("continue_free")
	_free.visible = caps["continue_free"]
	_free.disabled = busy
	_offline.text = t.text("offline_activation")
	_offline.visible = caps["offline"]
	_offline.disabled = busy
	show_text(_message, message)
	_message.theme_type_variation = "PKeyMuted" if message_ok else "PKeyError"
	var how := manage_presentation()
	_manage.text = t.text("free_device")
	_manage.visible = manage_url != "" and how == "button"
	_manage.disabled = busy
	_manage_qr.text = manage_url if how == "qr" else ""
	_manage_qr.visible = manage_url != "" and how == "qr" and not _manage_qr.encode_failed
	show_text(_manage_caption, t.text("free_device_scan") if _manage_qr.visible else "")


func _focus_chain() -> Array:
	if mode == "sign-in":
		return sign_in_dialog._focus_chain()
	if mode == "offline":
		return offline_dialog._focus_chain()
	return [_key, _submit, _manage, _sign_in, _free, _offline]


## "button" or "qr" for "Replace a device" here (manage_mode, else the device).
func manage_presentation() -> String:
	if manage_mode == "button" or manage_mode == "qr":
		return manage_mode
	return PKeyActivationController.manage_presentation_here()


## Render an activation result (also used by snapshots). `key` is the key just tried, which a
## device-limit button link to the portal's activate page carries as a fragment (a QR code never).
func show_result(r: PKeyActivationResult, key := "") -> void:
	manage_url = PKeyActivationController.manage_link(r, key, return_url, manage_presentation() == "qr")
	var m := PKeyActivationController.message_for(r)
	last_kind = r.kind if r != null else &""
	message = c().text(m[0], m[1])
	message_ok = r != null and r.ok
	refresh_view()
	if message_ok:
		activated.emit()


func _on_submit() -> void:
	var key := _key.text.strip_edges()
	if key == "":
		message = c().text("activation_key_empty")
		message_ok = false
		refresh_view()
		return
	if sdk == null or sdk.get("license") == null:
		show_result(PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, ""))
		return
	busy = true
	message = ""
	refresh_view()
	var r: PKeyActivationResult = await sdk.license.activate_with_key(key)
	busy = false
	if r.ok:
		_key.text = ""
	show_result(r, key)


func _on_manage() -> void:
	if manage_url != "":
		OS.shell_open(manage_url)


func _on_free() -> void:
	if sdk == null or sdk.get("license") == null:
		show_result(PKeyActivationResult.of(PKeyActivationResult.KIND_ERROR, PKeyErrors.NOT_CONFIGURED, ""))
		return
	busy = true
	message = ""
	refresh_view()
	var r: PKeyActivationResult = await sdk.license.enroll()
	busy = false
	show_result(r)


func _on_sign_in() -> void:
	open_mode("sign-in")
	sign_in_dialog.begin()


func _on_offline() -> void:
	open_mode("offline")


## Show "main", "sign-in" or "offline" (snapshots open a dialog without starting it).
func open_mode(m: String) -> void:
	var changed := mode != m
	mode = m
	sign_in_dialog.sdk = sdk
	offline_dialog.sdk = sdk
	if m == "offline":
		# The request code and product come from the SDK it was just given.
		offline_dialog.refresh_view()
	refresh_view()
	if changed:
		mode_changed.emit(m)
	focus_first.call_deferred()


func _back() -> void:
	open_mode("main")


func _cancel() -> bool:
	if mode != "main":
		_back()
		return true
	return false
