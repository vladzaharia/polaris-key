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
## `device-limit`, `account-required`, `rate-limited`, `stopped` (two requests were declined; Start again) and
## `failed` (the service or the network; nothing was approved), each a title with a glyph and one way on. The words
## and the one way on are the model's (`ui/model/nearby.gd`); Escape and B answer Deny at the codes and the choice
## and leave everywhere else.
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

## State -> [title key, body keys]: the order the model's copy is drawn in (the model keeps a sorted set). The way on
## is the model's `decisions.primary`. `mismatch` leads with the short outcome and the model's sentence under it.
const WORDS := {
	"approved": ["signin.nearby.approved", []],
	"not-nearby": ["signin.nearby.notNearby", ["signin.nearby.notNearbyBody"]],
	"mismatch": ["signin.approve.deniedDone", ["signin.nearby.mismatch"]],
	"denied": ["signin.approve.deniedDone", []],
	"expired": ["core.codes.sign-in-expired.title", ["signin.nearby.expiredBody"]],
	"device-limit": ["core.codes.device_limit.title", ["signin.nearby.deviceLimitBody"]],
	"listening": ["signin.nearby.listenTitle", ["signin.nearby.listenBody", "signin.cli.approveWaiting"]],
	"stopped": ["signin.nearby.pausedTitle", ["signin.nearby.pausedBody"]],
	"failed": ["core.codes.network.title", ["signin.nearby.failedBody"]],
	"choose": ["signin.nearby.chooseTitle", ["signin.nearby.chooseLede"]],
	"ask": ["signin.nearby.ask", ["signin.nearby.askBody", "signin.approve.warning"]],
	"account-required": ["core.codes.account_required.title", ["core.codes.account_required.message"]],
	"rate-limited": ["core.codes.rate_limited.title", ["signin.nearby.rateLimitedBody"]],
}

## State -> [glyph, tone]: an outcome is never colour alone.
const MARKS := {
	"approved": ["success", "accent"],
	"mismatch": ["warning", "warning"],
	"failed": ["warning", "warning"],
	"denied": ["info", "muted"],
	"not-nearby": ["info", "muted"],
	"expired": ["info", "muted"],
	"device-limit": ["info", "muted"],
	"account-required": ["info", "muted"],
	"rate-limited": ["info", "muted"],
	"stopped": ["info", "muted"],
}

@export_enum(
	"entry", "waiting", "ask", "working", "approved", "not-nearby", "mismatch", "denied", "expired", "device-limit", "choose",
	"account-required", "rate-limited", "stopped", "failed"
) var step := "entry":
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
var _pad: MarginContainer
var _title_row: Control
var _glyph: TextureRect
var _title: Label
var _lede: Label
var _entry: Button
var _codes_row: Control
var _code_buttons: Array = []
var _choice_buttons: Array = []
var _create: Button
var _deny: Button
var _status: Label
var _primary: Button
var _done: Button
var _spacer: Control


func _build() -> void:
	name = "PKeyNearbyApproval"
	_pad = MarginContainer.new()
	_pad.name = "Pad"
	card_panel().add_child(_pad)
	_body = vbox(_pad, "Body", "PKeyStack")
	_product = product_header(_body, "Product")
	_product.card = true
	var words := vbox(_body, "Words", "PKeyTight")
	var head := glyph_label(words, "Title", "info", "PKeyTitle")
	_title_row = head["row"]
	_glyph = head["glyph"]
	_title = head["label"]
	_lede = label(words, "Lede", "PKeyMuted")
	_status = label(words, "Status", "PKeyMuted")
	loading_bar(_body)
	_primary = button(_body, "Primary", func() -> void: primary_pressed.emit(step), "PKeyPrimary")
	_primary.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	# Two declined requests: Start again is the way on, Done the way out.
	_done = button(_body, "Done", func() -> void: primary_pressed.emit("leave"), "PKeyLink")
	_done.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_entry = button(_body, "Entry", func() -> void: entry_pressed.emit(), "PKeyLink")
	_entry.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	# The codes are the hero: one full-width row each, in a large type of their own.
	_codes_row = vbox(_body, "Codes", "PKeyTight")
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
	# On a phone's page Deny (and Done) dock to the bottom, in the thumb zone, as the sign-in steps' actions do.
	_spacer = spacer(_body)
	_deny = button(_body, "Deny", func() -> void: denied.emit(), "PKeyLink")
	_deny.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	for b in [_primary, _done, _entry, _deny]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


func _bleeds() -> bool:
	return true


func _opens_at_top() -> bool:
	# At the licence choice the focus is Deny, below the list: it is brought into view, not the title.
	return step != "choose"


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 4


func ring_inset() -> float:
	return roundf(RING_PAD * float(layout_metrics().get("scale", 1.0)))


func _arrange(m: Dictionary) -> void:
	super(m)
	# Short on room, the product header gives way before the card scrolls.
	_product.visible = squeeze_level() < 1
	# Room inside the scroll for a focus ring at any edge, at every squeeze level.
	for side in ["top", "bottom", "left", "right"]:
		_pad.add_theme_constant_override("margin_" + side, int(ring_inset()))
	var tone := get_theme_color("font_color", "PKeyMuted")
	var state: String = model.get("state", "")
	var mark: Array = MARKS.get(state, ["info", "muted"])
	match mark[1]:
		"accent":
			# The accent is the link's colour (a button type; PKeyAccent is not a theme type).
			tone = get_theme_color("font_color", "PKeyLink")
		"warning":
			tone = get_theme_color("font_color", "PKeyWarning")
	_glyph.set_meta(&"pkey_glyph", mark[0])
	size_glyph(_glyph, 28.0, tone)
	# Squeezed, the gaps between the parts halve: the ring's inset stays.
	tighten_gap(_body, squeeze_level() >= 3)
	# Deny (the codes and the choice) and Done (two declined requests) sit at the page's foot on a phone.
	var dock := phone_screen() and state in ["ask", "choose", "stopped"]
	_spacer.visible = dock
	_body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_body.move_child(_spacer, (_primary if state == "stopped" else _deny).get_index())
	# A code is read across the room: the PKeyCode type (the heading weight) at about twice the body type,
	# less as the room runs out.
	var body_px := get_theme_font_size("font_size", "Button")
	var grow := 2.0 if squeeze_level() < 2 else (1.6 if squeeze_level() < 3 else (1.25 if squeeze_level() < 4 else 1.0))
	var code_px := mini(get_theme_font_size("font_size", "PKeyCode"), roundi(body_px * grow))
	var code_font := get_theme_font("font", "PKeyCode")
	for b in _code_buttons:
		(b as Button).add_theme_font_size_override("font_size", code_px)
		(b as Button).add_theme_font_override("font", code_font)
		(b as Button).custom_minimum_size.y = roundf(float(code_px) * (1.5 if squeeze_level() < 2 else (1.3 if squeeze_level() < 3 else 1.15)))


func _screen_key() -> String:
	return "%s|%s" % [step if step in ["working", "waiting"] else model.get("state", ""), identity_on]


func _render() -> void:
	var shown_step := "listening" if step == "waiting" else step
	var inp := {"nearbyApproval": {"step": "ask" if step == "working" else shown_step, "device": device if device != "" else null}}
	if not identity_on:
		inp["services"] = ["license"]
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("NearbyApproval", inp)
	var state: String = model.get("state", "hidden")
	visible = state != "hidden"
	# A missing device name reads "the new device".
	var shown := device if device != "" else String(catalog().format("part.newDevice", {}))
	var args := {"device": PKeyUiTheme.isolate(shown), "product": PKeyUiTheme.isolate(String(PKeyUiTheme.product_identity()["name"]))}
	_product.refresh()
	var working := step == "working"
	var words: Array = WORDS.get(state, ["", []])
	var body: Array = words[1]
	var primary: Variant = (model.get("decisions", {}) as Dictionary).get("primary")
	cat_text(_title, words[0], args)
	cat_text(_lede, body[0] if body.size() > 0 else "", args)
	cat_text(_status, "common.working" if working else (body[1] if body.size() > 1 else ""), args)
	_status.theme_type_variation = &"PKeyMuted"
	# The name starts the sentence, so an unnamed device reads "The new device", not "the new device".
	if device == "":
		_sentence_case(_title)
		_sentence_case(_lede)
	_title_row.visible = _title.text != "" and state != "entry"
	_glyph.visible = _title_row.visible and MARKS.has(state)
	cat_text(_entry, "signin.nearby.menu" if state == "entry" else "", args)
	cat_text(_primary, String(primary) if primary is String else "", args)
	cat_text(_done, "common.done" if state == "stopped" else "", args)
	cat_text(_deny, "signin.approve.deny" if state == "ask" or state == "choose" else "", args)
	var ask := state == "ask" and not working
	var choose := state == "choose"
	_codes_row.visible = ask
	# Waiting for a device, or for the Worker's answer: the thin bar says the screen is alive.
	set_loading(working or state == "listening")
	set_process(working or state == "listening")
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


func _process(_delta: float) -> void:
	_tick_loading()


## The text starts with an isolated name (a bidi mark first): capitalise its first letter.
static func _sentence_case(l: Label) -> void:
	var t := l.text
	if t.length() > 1 and t.unicode_at(0) == 0x2068:
		l.text = t.substr(0, 1) + t.substr(1, 1).to_upper() + t.substr(2)


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
	return _code_buttons + _choice_buttons + [_create, _deny, _primary, _done, _entry]


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
	if not visible:
		return false
	match String(model.get("state", "")):
		"ask", "choose":
			if step == "ask" or step == "choose":
				denied.emit()
			return true
		"entry", "hidden":
			return false
	# Waiting for the Worker's answer nothing can be left; everywhere else Escape and B are Done.
	if step != "working":
		primary_pressed.emit("leave")
	return true
