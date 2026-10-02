class_name PKeyUpdatePrompt
extends PKeyUiView
## What an update answer means for the player, per build (React's `<UpdatePrompt>` states; logic in
## PKeyUpdatePromptController). It follows PolarisKey.update.update_available, so dropping it into
## a layout is enough; `show_result()` drives it directly.
##
## Two modes: `banner` (default), a strip in the game's own layout that never steals focus from
## play, and `modal`, a full-rect card for a dismissable answer the game wants to put front and
## centre. A mandatory or blocked answer is LOCKED: always the banner, with no dismiss control,
## whatever `modal` says — it never covers a game that keeps running (no v4 answer stops play).
##
## P1 never downloads: a direct build opens the release page (`release_url`, or the v3 answer's
## url), a store answer opens its listing, and a store, Steam or itch build shows the store link
## or nothing. Installing and restarting are P3-10's.

## The player chose the action (after the URL, if any, was opened).
signal action_taken(result: PKeyResult)
## The player dismissed a dismissable answer.
signal dismissed()

## Use the full-rect card for dismissable answers (a locked answer is always the banner).
@export var modal := false
## The release page a direct build opens for a binary answer ("" offers no action).
@export var release_url := ""
## Show "You're up to date" for an up-to-date answer instead of hiding.
@export var show_when_current := false
## Override the build's outlet ("" reads PolarisKey.build_info()).
@export var outlet := ""

var result: PKeyResult = null
var is_dismissed := false
var model: Dictionary = {}

var _card: VBoxContainer
var _title: Label
var _body: Label
var _action: Button
var _dismiss: Button
var _bound := false
var _covering := false


func _build() -> void:
	name = "PKeyUpdatePrompt"
	_card = vbox(self, "Body", 8)
	_title = label(_card, "Title", "PKeyTitle")
	_body = label(_card, "Message", "PKeyMuted")
	var actions := hbox(_card, "Actions")
	_action = button(actions, "Action", _on_action, "PKeyPrimary")
	_dismiss = button(actions, "Dismiss", _on_dismiss)


func _ready() -> void:
	super()
	if sdk != null and not _bound and sdk.get("update") != null:
		_bound = true
		sdk.update.update_available.connect(show_result)


func show_result(r: PKeyResult) -> void:
	result = r
	is_dismissed = false
	refresh_view()


func _outlet() -> String:
	if outlet != "":
		return outlet
	if sdk != null and sdk.has_method("build_info"):
		var o = sdk.build_info().get("outlet")
		return o if o is String else ""
	return ""


## The mode in use: "banner" or "modal" ("" when hidden).
func presentation() -> String:
	if not visible:
		return ""
	return "modal" if _covering else "banner"


func _render() -> void:
	var t := c()
	model = PKeyUpdatePromptController.model(result, _outlet(), release_url, show_when_current)
	var locked: bool = model["locked"]
	visible = model["visible"] and (locked or not is_dismissed)
	var as_modal := modal and not locked
	if as_modal:
		set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		theme_type_variation = ""
		_covering = true
	else:
		# Never left full-rect: a locked answer must not cover the running game.
		if _covering:
			set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
			_covering = false
		theme_type_variation = "PKeyBanner"
	show_text(_title, t.text(model["title"]) if model["title"] != "" else "")
	show_text(_body, t.text(model["body"], model["body_arg"]) if model["body"] != "" else "")
	show_text(_action, t.text(model["action"]) if model["action"] != "" else "")
	_dismiss.visible = not locked and model["state"] != "current"
	_dismiss.text = t.text("update_dismiss")


func _focus_chain() -> Array:
	return [_action, _dismiss]


func _on_action() -> void:
	if model.get("action_url", "") != "":
		OS.shell_open(model["action_url"])
	action_taken.emit(result)


func _on_dismiss() -> void:
	if model.get("locked", false):
		return
	is_dismissed = true
	refresh_view()
	dismissed.emit()


func _cancel() -> bool:
	if not model.get("locked", false) and visible:
		_on_dismiss()
		return true
	return false
