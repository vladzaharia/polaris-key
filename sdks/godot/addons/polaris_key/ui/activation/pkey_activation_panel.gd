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

## A token was minted (key, enrolment or sign-in) or a bundle installed.
signal activated()

## Offer "Continue free" (keyless enrolment, POST /license/enroll) where License runs. Off by
## default: only a product with a free tier turns it on.
@export var offer_enrollment := false
## Show key entry even on an App Store, TestFlight or Play build (off: hidden there, as the
## stores' payment rules require; PKeyActivationController.STORE_OUTLETS).
@export var allow_key_entry_on_store := false

## Show the panel's own "Activate" title (off when a host card already has one).
var show_title := true:
	set(value):
		if show_title != value:
			show_title = value
			refresh_view()
var mode := "main"
var busy := false
var message := ""
var message_ok := false

var _caps_override: Variant = null
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
## The last result's kind (device-limit shows "Manage devices": the portal's free-device flow).
var last_kind: StringName = &""
var _main: VBoxContainer
var sign_in_dialog: PKeySignInDialog
var offline_dialog: PKeyOfflineDialog


func _build() -> void:
	name = "PKeyActivationPanel"
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	var root := vbox(self, "Stack", 0)
	_main = vbox(root, "Main", 10)
	_title = label(_main, "Title", "PKeyTitle")
	_subtitle = label(_main, "Subtitle", "PKeyMuted")
	_key_label = label(_main, "KeyLabel")
	var row := hbox(_main, "KeyRow")
	_key = LineEdit.new()
	_key.name = "KeyInput"
	_key.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_key.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_key.text_submitted.connect(func(_t): _on_submit())
	row.add_child(_key)
	_submit = button(row, "Activate", _on_submit, "PKeyPrimary")
	_sign_in = button(_main, "SignIn", _on_sign_in)
	_free = button(_main, "ContinueFree", _on_free)
	_offline = button(_main, "OfflineActivation", _on_offline)
	_message = label(_main, "Message")
	_manage = button(_main, "ManageDevices", _on_manage)
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
	_title.text = t.text("activation_title")
	_title.visible = show_title
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
	_key.get_parent().visible = caps["key_entry"]
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
	_manage.text = t.text("activation_manage_devices")
	_manage.visible = last_kind == PKeyActivationResult.KIND_DEVICE_LIMIT and manage_url() != ""
	_manage.disabled = busy


func _focus_chain() -> Array:
	if mode == "sign-in":
		return sign_in_dialog._focus_chain()
	if mode == "offline":
		return offline_dialog._focus_chain()
	return [_key, _submit, _sign_in, _free, _offline, _manage]


## Render an activation result (also used by snapshots).
func show_result(r: PKeyActivationResult) -> void:
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
	show_result(r)


## Where "Manage devices" goes on a device-limit refusal: only a link the server supplies
## (`manageUrl`, PX-W8), never one built here (owner decision Q6). The Worker does not send one
## yet, so this is "" and the button stays hidden.
func manage_url() -> String:
	return ""


func _on_manage() -> void:
	var u := manage_url()
	if u != "":
		OS.shell_open(u)


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
	mode = m
	sign_in_dialog.sdk = sdk
	offline_dialog.sdk = sdk
	refresh_view()
	focus_first.call_deferred()


func _back() -> void:
	open_mode("main")


func _cancel() -> bool:
	if mode != "main":
		_back()
		return true
	return false
