class_name PKeySignInStep
extends PKeyUiView
## Automatic sign-in's own steps (ui-matrix v7 SignIn/confirm, link-offer, link-done, link-conflict,
## nearby-prompt, nearby-wait and nearby-done; plans/auto-sign-in.md §3), drawn from the sign-in
## form's model (`sign_in_view` with an `autoSignIn` input). The kit draws a step; what Continue,
## Link and the nearby approval do is the host's (the auto sign-in flow, CC-15): set `step` and
## connect `primary_pressed` and `secondary_pressed`.

## The step's primary was chosen (Continue, Link {provider}).
signal primary_pressed(step: String)
## The step's quiet action was chosen (Use another account, No thanks, Not now, Use a code instead,
## Not you?).
signal secondary_pressed(step: String)

## State -> [title key, body keys (shown when the model names them), secondary keys]; the
## primary is the model's. Every step has a title that takes focus and no Cancel.
const LAYOUT := {
	"confirm": [
		"signin.auto.confirm.title",
		[
			"signin.auto.confirm.as", "signin.auto.confirm.asApple", "signin.consent.license", "signin.consent.newLicense",
			"signin.consent.licenseLine", "signin.consent.alsoGets", "signin.consent.profile", "signin.consent.pairwise",
		],
		["signin.auto.confirm.other"],
	],
	"link-offer": ["signin.linkOffer.title", ["signin.linkOffer.bodyGlobal", "signin.linkOffer.bodyDeveloper", "signin.linkOffer.bodyApp"], ["signin.linkOffer.decline"]],
	"link-done": ["signin.linkOffer.done", [], []],
	"link-conflict": ["signin.linkOffer.conflictTitle", ["signin.linkOffer.conflict"], ["signin.linkOffer.join"]],
	"nearby-prompt": ["signin.nearby.promptTitle", ["signin.nearby.prePrompt"], ["common.notNow"]],
	"nearby-wait": ["signin.nearby.title", ["signin.nearby.body", "signin.nearby.match"], ["signin.nearby.code"]],
	"nearby-done": ["signin.nearby.done", [], ["signin.nearby.notYou"]],
	"device-limit": ["core.codes.device_limit.title", ["core.codes.device_limit.message", "deviceLimit.noManage"], ["signin.auto.confirm.other", "common.cancel"]],
}

@export_enum("confirm", "link-offer", "link-done", "link-conflict", "nearby-prompt", "nearby-wait", "nearby-done", "device-limit") var step := "confirm":
	set(value):
		step = value
		refresh_view()
## The account's email; empty when the provider shared none (Sign in with Apple, private).
@export var email := "":
	set(value):
		email = value
		refresh_view()
## Whom the provider's identity is shared with: "global" across apps, "developer" per developer.
@export_enum("unknown", "global", "developer") var reach := "unknown":
	set(value):
		reach = value
		refresh_view()
## The developer's name, for "Apps from {developer} sign you in automatically."
@export var developer := "":
	set(value):
		developer = value
		refresh_view()
## The account's tier, for a done line that names it.
@export var tier := "":
	set(value):
		tier = value
		refresh_view()
## The code the waiting device shows (nearby-wait), which is tapped on the approving device.
@export var code := "":
	set(value):
		code = value
		refresh_view()
## The confirm step's license line: "none", "new" or "existing".
@export_enum("none", "new", "existing") var license_line := "none":
	set(value):
		license_line = value
		refresh_view()
## The confirm step lists what the app also gets (a first sign-in, or the consent changed).
@export var also_gets := false:
	set(value):
		also_gets = value
		refresh_view()
## The provider's name, or "" for the default.
@export var provider := "":
	set(value):
		provider = value
		refresh_view()

var model: Dictionary = {}


var _body: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _lede: Label
var _lines: Array = []
var _actions: BoxContainer
var _spacer: Control
var _primary: Button
var _secondary: Button
var _secondary2: Button


func _build() -> void:
	name = "PKeySignInStep"
	_body = vbox(card_panel(), "Body", "PKeyStack")
	_product = product_header(_body, "Product")
	_product.card = true
	var words := vbox(_body, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_lede = label(words, "Lede", "PKeyMuted")
	for i in 7:
		_lines.append(label(words, "Line%d" % i, "PKeyMuted"))
	loading_bar(_body)
	_spacer = spacer(_body)
	_actions = actions_row(_body, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_primary = button(_actions, "Primary", func() -> void: primary_pressed.emit(step), "PKeyPrimary")
	_secondary = button(_actions, "Secondary", func() -> void: secondary_pressed.emit(step), "PKeyLink")
	_secondary2 = button(_actions, "Secondary2", func() -> void: secondary_pressed.emit(step), "PKeyLink")
	for b in [_primary, _secondary, _secondary2]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


func _card_shown() -> bool:
	return true


## On a phone the step fills the page less the safe margins, like the refusal steps.
func _bleeds() -> bool:
	return true


func _opens_at_top() -> bool:
	return true


func squeeze_max() -> int:
	return 4


func _arrange(m: Dictionary) -> void:
	super(m)
	# Short on room, the product header gives way before the card scrolls.
	_product.visible = squeeze_level() < 1
	# On a phone's page the actions dock to the bottom, in the thumb zone, as the refusal steps' do.
	_spacer.visible = phone_screen()


func _screen_key() -> String:
	return step


func _render() -> void:
	var auto := {"step": step}
	if email != "":
		auto["email"] = email
	if reach != "unknown":
		auto["reach"] = reach
	var inp := {"signIn": {"outcome": "pending"}, "autoSignIn": auto}
	if provider != "":
		inp["provider"] = provider
	if developer != "":
		inp["integrator"] = {"developer": developer}
	if license_line != "none":
		auto["license"] = license_line
	if also_gets:
		auto["alsoGets"] = true
	if code != "":
		auto["code"] = code
	if tier != "":
		inp["account"] = {"tier": tier}
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("SignIn", inp)
	var id := PKeyUiTheme.product_identity()
	var args := {
		"app": PKeyUiTheme.isolate(String(id["name"])),
		"developer": PKeyUiTheme.isolate(developer),
		"email": PKeyUiTheme.isolate(email),
		"provider": PKeyUiTheme.isolate(provider if provider != "" else PKeyConstants.SIGN_IN_PROVIDER_NAME),
		"tier": PKeyUiTheme.isolate(tier),
		"code": code,
	}
	_product.refresh()
	var row: Array = LAYOUT.get(step, LAYOUT["nearby-done"])
	# The copy the model names is the copy drawn: each body line is one the model chose.
	var copy: Array = model.get("copy", [])
	var lines: Array = (row[1] as Array).filter(func(k): return copy.has(k))
	cat_text(_title, row[0], args)
	cat_text(_lede, "", args)
	for i in _lines.size():
		cat_text(_lines[i], lines[i] if i < lines.size() else "", args)
	cat_text(_primary, String(model["decisions"].get("primary") if model.get("decisions") != null and model["decisions"].get("primary") != null else ""), args)
	var sec: Array = row[2]
	cat_text(_secondary, sec[0] if sec.size() > 0 else "", args)
	cat_text(_secondary2, sec[1] if sec.size() > 1 else "", args)
	# The wait for the other device shows the thin indicator, never a spinner in the title.
	set_loading(step == "nearby-wait")
	set_process(step == "nearby-wait")


func _initial_focus() -> Control:
	if is_focusable(_primary):
		return _primary
	return _secondary if is_focusable(_secondary) else null


func _focus_chain() -> Array:
	return [_primary, _secondary, _secondary2]
