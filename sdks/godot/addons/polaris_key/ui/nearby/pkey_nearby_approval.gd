class_name PKeyNearbyApproval
extends PKeyUiView
## NearbyApproval (ui-matrix v7; ui-core's `nearby_approval_view`): the signed-in device's side of
## nearby sign-in. A new device asks to sign in; this shows three 6-digit codes, one of them the
## code the new device shows, and the person taps it (number matching). Any other code, or Not now,
## denies. The kit draws the states from the model; the protocol, the codes and what a tap does are
## the host's (CC-15): set `step`, `device` and `codes`, and connect the signals.
##
## Steps: `entry` (the account menu's "Approve a nearby device"), `waiting` (listening; Cancel), `ask`, `working` (the Worker is
## being asked; nothing can be tapped), `choose` (a licence per button, a new one where the Worker
## offers it, and Deny) and the outcomes `approved`, `not-nearby`, `mismatch`, `denied`, `expired`,
## `device-limit`, `account-required` and `rate-limited`, each a title that takes focus and one way on.
## Hidden when the Identity service is off (`identity_on`). The digits 1 to n tap the n codes or licences.

## The account-menu entry was chosen.
signal entry_pressed()
## One of the three codes was tapped. The host decides whether it is the matching one.
signal code_chosen(code: String)
## One of the licences of the choice was tapped (its position, from 0).
signal choice_chosen(index: int)
## A new licence was tapped.
signal create_chosen()
## Deny.
signal denied()
## An outcome's one way on (Done, Manage devices, Continue, Sign in, Try again).
signal primary_pressed(step: String)

const MAX_CHOICES := 9

## State -> [title key, body keys, primary key] for the outcomes; the title takes focus.
const OUTCOMES := {
	"approved": ["signin.nearby.approved", [], "common.done"],
	"not-nearby": ["signin.nearby.notNearby", ["signin.nearby.notNearbyBody"], "common.done"],
	"mismatch": ["signin.nearby.mismatch", [], "common.done"],
	"denied": ["signin.approve.deniedDone", [], "common.done"],
	"expired": ["core.codes.sign-in-expired.title", ["core.codes.sign-in-expired.message"], "common.done"],
	"device-limit": ["core.codes.device_limit.title", ["core.codes.device_limit.message"], "devices.manage"],
	"waiting": ["signin.nearby.listenTitle", ["signin.nearby.listenBody", "signin.cli.approveWaiting"], "common.cancel"],
	"choose": ["signin.nearby.chooseTitle", ["signin.nearby.chooseLede"], ""],
	"account-required": ["core.codes.account_required.title", ["core.codes.account_required.message"], "signin.key.signIn"],
	"rate-limited": ["core.codes.rate_limited.title", ["core.codes.rate_limited.message"], "common.tryAgain"],
}

@export_enum("entry", "waiting", "ask", "working", "approved", "not-nearby", "mismatch", "denied", "expired", "device-limit", "choose", "account-required", "rate-limited") var step := "entry":
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
## The names of the licences the person may give the new device, in the order shown (at most 9).
@export var choices := PackedStringArray():
	set(value):
		choices = value
		refresh_view()
## The Worker offers a new licence as well.
@export var create_offered := false:
	set(value):
		create_offered = value
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
var _choice_buttons: Array = []
var _create: Button
var _deny: Button
var _status: Label
var _primary: Button


func _build() -> void:
	name = "PKeyNearbyApproval"
	_body = vbox(card_panel(), "Body", "PKeyStack")
	_product = product_header(_body, "Product")
	_product.card = true
	var words := vbox(_body, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_lede = label(words, "Lede", "PKeyMuted")
	_status = label(words, "Status", "PKeyMuted")
	_primary = button(_body, "Primary", func() -> void: primary_pressed.emit(step), "PKeyPrimary")
	_primary.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_entry = button(_body, "Entry", func() -> void: entry_pressed.emit(), "PKeyLink")
	_entry.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_codes_row = actions_row(_body, "Codes", BoxContainer.ALIGNMENT_BEGIN)
	for i in 3:
		var b := button(_codes_row, "Code%d" % i, Callable())
		b.pressed.connect(func() -> void: _on_code(i))
		_code_buttons.append(b)
	var licences := vbox(_body, "Licences", "PKeyTight")
	for i in MAX_CHOICES:
		var cb := button(licences, "Choice%d" % i, Callable())
		cb.pressed.connect(func() -> void: _on_choice(i))
		cb.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_choice_buttons.append(cb)
	_create = button(licences, "Create", func() -> void: create_chosen.emit())
	_create.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_deny = button(_body, "Deny", func() -> void: denied.emit(), "PKeyLink")
	_deny.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	for b in [_primary, _entry, _deny]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


func _bleeds() -> bool:
	return true


func _opens_at_top() -> bool:
	return true


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 4


func _arrange(m: Dictionary) -> void:
	super(m)
	# Short on room, the product header gives way before the card scrolls.
	_product.visible = squeeze_level() < 1


func _screen_key() -> String:
	return "%s|%s" % [step if step in ["working", "waiting"] else model.get("state", ""), identity_on]


func _render() -> void:
	var inp := {"nearbyApproval": {"step": step, "device": device if device != "" else null}}
	if not identity_on:
		inp["services"] = ["license"]
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("NearbyApproval", inp)
	var state: String = model.get("state", "hidden")
	if (step == "working" or step == "waiting") and state != "hidden":
		state = step
	visible = state != "hidden"
	# A missing device name reads "the new device".
	var shown := device if device != "" else String(catalog().format("part.newDevice", {}))
	var args := {"device": PKeyUiTheme.isolate(shown), "product": PKeyUiTheme.isolate(String(PKeyUiTheme.product_identity()["name"]))}
	_product.refresh()
	var ask := state == "ask"
	var choose := state == "choose"
	var working := step == "working"
	var outcome: Array = OUTCOMES.get(state, ["", [], ""])
	var body: Array = ["signin.nearby.askBody", "signin.approve.warning"] if ask else outcome[1]
	cat_text(_title, "signin.nearby.ask" if ask or working else outcome[0], args)
	cat_text(_lede, body[0] if body.size() > 0 else "", args)
	cat_text(_status, "common.working" if working else (body[1] if body.size() > 1 else ""), args)
	_status.theme_type_variation = &"PKeyMuted"
	cat_text(_entry, "signin.nearby.menu" if state == "entry" else "", args)
	cat_text(_primary, outcome[2], args)
	cat_text(_deny, "signin.approve.deny" if ask or choose else "", args)
	_codes_row.visible = ask
	for i in _code_buttons.size():
		var b := _code_buttons[i] as Button
		b.visible = ask and i < codes.size()
		b.text = codes[i] if i < codes.size() else ""
		# A code is a number, not a word: drawn as given, never translated or mirrored.
		b.set_meta(DATA_META, true)
		b.tooltip_text = ""
	for i in _choice_buttons.size():
		var cb := _choice_buttons[i] as Button
		cb.visible = choose and i < choices.size()
		cb.text = PKeyUiTheme.isolate(choices[i]) if i < choices.size() else ""
		# A licence name is the account's, drawn as given.
		cb.set_meta(DATA_META, true)
	cat_text(_create, "signin.choice.create" if choose and create_offered else "", args)


func _on_choice(i: int) -> void:
	if i < choices.size():
		choice_chosen.emit(i)


func _on_code(i: int) -> void:
	if i < codes.size():
		code_chosen.emit(codes[i])


func _initial_focus() -> Control:
	if step == "choose":
		# Deny is the safe default here too: a pad's A on open never gives out a licence at random.
		return _deny if is_focusable(_deny) else _choice_buttons[0]
	if step == "ask":
		# Deny is the safe default: a pad's A on open never approves a code at random.
		return _deny if is_focusable(_deny) else _code_buttons[0]
	if is_focusable(_primary):
		return _primary
	return _entry if is_focusable(_entry) else null


func _focus_chain() -> Array:
	return _code_buttons + _choice_buttons + [_create, _deny, _primary, _entry]


func _unhandled_key_input(event: InputEvent) -> void:
	if not visible or not (event is InputEventKey) or not event.pressed or event.echo:
		return
	# The digits 1 to n tap the n codes or licences that are there, and no others.
	var n := codes.size() if step == "ask" else (choices.size() if step == "choose" else 0)
	var digit := int(event.unicode) - 48
	if digit >= 1 and digit <= mini(n, 9):
		get_viewport().set_input_as_handled()
		if step == "ask":
			_on_code(digit - 1)
		else:
			_on_choice(digit - 1)


func _cancel() -> bool:
	if (step == "ask" or step == "choose") and visible:
		denied.emit()
		return true
	return false
