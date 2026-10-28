class_name PKeyNearbyApproval
extends PKeyUiView
## NearbyApproval (ui-matrix v7; ui-core's `nearby_approval_view`): the signed-in device's side of
## nearby sign-in. A new device asks to sign in; this shows three 6-digit codes, one of them the
## code the new device shows, and the person taps it (number matching). Any other code, or Not now,
## denies. The kit draws the states from the model; the protocol, the codes and what a tap does are
## the host's (CC-15): set `step`, `device` and `codes`, and connect the signals.
##
## Steps: `entry` (the account menu's "Approve a nearby device"), `ask`, `approved`, `not-nearby`.
## Hidden when the Identity service is off (`identity_on`).

## The account-menu entry was chosen.
signal entry_pressed()
## One of the three codes was tapped. The host decides whether it is the matching one.
signal code_chosen(code: String)
## Not now.
signal denied()

@export_enum("entry", "ask", "approved", "not-nearby") var step := "entry":
	set(value):
		step = value
		refresh_view()
## The new device's friendly name.
@export var device := "":
	set(value):
		device = value
		refresh_view()
## The three codes to tap, in the order shown.
@export var codes := PackedStringArray():
	set(value):
		codes = value
		refresh_view()
@export var identity_on := true:
	set(value):
		identity_on = value
		refresh_view()

var model: Dictionary = {}

var _body: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _lede: Label
var _entry: Button
var _codes_row: BoxContainer
var _code_buttons: Array = []
var _deny: Button
var _status: Label


func _build() -> void:
	name = "PKeyNearbyApproval"
	_body = vbox(card_panel(), "Body", "PKeyStack")
	_product = product_header(_body, "Product")
	_product.card = true
	var words := vbox(_body, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_lede = label(words, "Lede", "PKeyMuted")
	_status = label(_body, "Status")
	_entry = button(_body, "Entry", func() -> void: entry_pressed.emit(), "PKeyLink")
	_entry.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_codes_row = actions_row(_body, "Codes", BoxContainer.ALIGNMENT_BEGIN)
	for i in 3:
		var b := button(_codes_row, "Code%d" % i, Callable())
		b.pressed.connect(func() -> void: _on_code(i))
		_code_buttons.append(b)
	_deny = button(_body, "Deny", func() -> void: denied.emit(), "PKeyLink")
	_deny.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN


func _bleeds() -> bool:
	return false


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 1


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), identity_on]


func _render() -> void:
	var inp := {"nearbyApproval": {"step": step, "device": device if device != "" else null}}
	if not identity_on:
		inp["services"] = ["license"]
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("NearbyApproval", inp)
	var state: String = model.get("state", "hidden")
	visible = state != "hidden"
	var args := {"device": PKeyUiTheme.isolate(device)}
	_product.refresh()
	var ask := state == "ask"
	cat_text(_title, "signin.nearby.ask" if ask else "", args)
	cat_text(_lede, "signin.nearby.askBody" if ask else "", args)
	cat_text(_entry, "signin.nearby.menu" if state == "entry" else "", args)
	cat_text(_status, "signin.nearby.approved" if state == "approved" else "signin.nearby.notNearby" if state == "not-nearby" else "", args)
	_status.theme_type_variation = &"PKeyMuted" if state == "not-nearby" else &""
	cat_text(_deny, "signin.nearby.deny" if ask else "", args)
	_codes_row.visible = ask
	for i in _code_buttons.size():
		var b := _code_buttons[i] as Button
		b.visible = ask and i < codes.size()
		b.text = codes[i] if i < codes.size() else ""
		# A code is a number, not a word: drawn as given, never translated or mirrored.
		b.set_meta(DATA_META, true)


func _on_code(i: int) -> void:
	if i < codes.size():
		code_chosen.emit(codes[i])


func _initial_focus() -> Control:
	if step == "ask":
		return _code_buttons[0] if is_focusable(_code_buttons[0]) else _deny
	return _entry if is_focusable(_entry) else null


func _focus_chain() -> Array:
	return _code_buttons + [_deny, _entry]


func _cancel() -> bool:
	if step == "ask" and visible:
		denied.emit()
		return true
	return false
