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

@export_enum("confirm", "link-offer", "link-done", "link-conflict", "nearby-prompt", "nearby-wait", "nearby-done") var step := "confirm":
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
## The developer's name, for "Apps from {developer} sign you in by themselves."
@export var developer := "":
	set(value):
		developer = value
		refresh_view()
## The provider's name, or "" for the default.
@export var provider := "":
	set(value):
		provider = value
		refresh_view()

var model: Dictionary = {}

## State -> [title, body, primary, secondary] catalog keys ("" for none), `body` for the confirm
## step chosen by whether an email came back.
const LAYOUT := {
	"confirm": ["signin.auto.confirm.title", "", "signin.auto.confirm.primary", "signin.auto.confirm.other"],
	"link-offer": ["signin.linkOffer.title", "", "signin.linkOffer.primary", "signin.linkOffer.decline"],
	"link-done": ["", "signin.linkOffer.done", "", ""],
	"link-conflict": ["", "signin.linkOffer.conflict", "", ""],
	"nearby-prompt": ["", "signin.nearby.prePrompt", "signin.auto.confirm.primary", "common.notNow"],
	"nearby-wait": ["signin.nearby.title", "signin.nearby.body", "", "signin.nearby.code"],
	"nearby-done": ["", "signin.nearby.done", "", "signin.nearby.notYou"],
}

var _body: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _lede: Label
var _actions: BoxContainer
var _primary: Button
var _secondary: Button


func _build() -> void:
	name = "PKeySignInStep"
	_body = vbox(card_panel(), "Body", "PKeyStack")
	_product = product_header(_body, "Product")
	_product.card = true
	var words := vbox(_body, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_lede = label(words, "Lede", "PKeyMuted")
	loading_bar(_body)
	_actions = actions_row(_body, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_primary = button(_actions, "Primary", func() -> void: primary_pressed.emit(step), "PKeyPrimary")
	_secondary = button(_actions, "Secondary", func() -> void: secondary_pressed.emit(step), "PKeyLink")


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 1


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
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("SignIn", inp)
	var id := PKeyUiTheme.product_identity()
	var args := {
		"app": PKeyUiTheme.isolate(String(id["name"])),
		"developer": PKeyUiTheme.isolate(developer),
		"email": PKeyUiTheme.isolate(email),
		"provider": PKeyUiTheme.isolate(provider if provider != "" else PKeyConstants.SIGN_IN_PROVIDER_NAME),
	}
	_product.refresh()
	var row: Array = LAYOUT.get(step, LAYOUT["nearby-done"])
	# The copy the model names is the copy drawn: the body of a confirm or a link offer is whichever
	# of its two lines the model chose.
	var copy: Array = model.get("copy", [])
	var body: String = row[1]
	if step == "confirm":
		body = "signin.auto.confirm.as" if copy.has("signin.auto.confirm.as") else "signin.auto.confirm.asApple"
	elif step == "link-offer":
		body = "signin.linkOffer.bodyGlobal" if copy.has("signin.linkOffer.bodyGlobal") else "signin.linkOffer.bodyDeveloper"
	cat_text(_title, row[0], args)
	cat_text(_lede, body, args)
	cat_text(_primary, row[2], args)
	cat_text(_secondary, row[3], args)
	_secondary.theme_type_variation = &"PKeyLink"
	# The wait for the other device shows the thin indicator, never a spinner in the title.
	set_loading(step == "nearby-wait")
	set_process(step == "nearby-wait")


func _initial_focus() -> Control:
	if is_focusable(_primary):
		return _primary
	return _secondary if is_focusable(_secondary) else null


func _focus_chain() -> Array:
	return [_primary, _secondary]
