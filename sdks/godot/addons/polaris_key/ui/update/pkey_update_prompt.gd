class_name PKeyUpdatePrompt
extends PKeyUiView
## What an update answer means for the player, per build (React's `<UpdatePrompt>` states; logic in
## PKeyUpdatePromptController). It follows PolarisKey.update.update_available, so dropping it into
## a layout is enough; `show_result()` drives it directly.
##
## Two modes: `banner` (default), a strip in the game's own layout that never steals focus from
## play, and `modal`, a full-rect card for a dismissable answer the game wants to put front and
## centre. A mandatory or blocked answer is LOCKED: always the banner, with no dismiss control,
## whatever `modal` says — it never covers a game that keeps running (floors never stop play). The
## one answer that stops play is revoked REQUIRED content (boot `required`, plans/P4-13.md
## decision 4): it shows the revoked-content copy, locked, while PKeyBoot holds the boot at
## BLOCKED; a `packs` answer shows nothing (the boot's FETCH applies it).
##
## The action is the outlet's (README §6.3, PKeyOutletAdapter): a store opens its listing or
## source page, Steam, itch and the other platforms stay silent with their own message, a web
## export reloads, and a direct build installs through its native updater (or the download
## link), downloads a code pack, or restarts into a staged one ("Restart now"). With an SDK the
## button runs PolarisKey.update.apply(result); every link it opens is https.
##
## Layout (PKeyUiView): a banner is one row on a wide screen (the words, then the action and the
## dismiss at the end) and stacks on a narrow one; the modal is a centred column. The action is
## the one primary.

## The player chose the action (after the URL, if any, was opened).
signal action_taken(result: PKeyResult)
## What the action did (PolarisKey.update.apply(), for a v4 answer with an SDK).
signal action_applied(applied: PKeyApplyResult)
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

var _card: BoxContainer
var _text: VBoxContainer
var _actions: HFlowContainer
var _title: Label
var _body: Label
var _action: Button
var _dismiss: Button
var _bound := false
var _covering := false
var _fit_queued := false
var _page_link := false


func _build() -> void:
	name = "PKeyUpdatePrompt"
	# The view's panel is the prompt's own: a page ground for the modal, a transparent strip that
	# floats the banner card for the banner (`_arrange`).
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_card = columns(card_panel(), "Body")
	_text = vbox(_card, "Text", "PKeyTight")
	_text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_text.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_title = label(_text, "Title", "PKeyTitle")
	_body = label(_text, "Message", "PKeyMuted")
	_actions = actions_row(_card, "Actions", FlowContainer.ALIGNMENT_BEGIN)
	_actions.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_action = button(_actions, "Action", _on_action, "PKeyPrimary")
	_dismiss = button(_actions, "Dismiss", _on_dismiss)
	minimum_size_changed.connect(_queue_fit)


func _floats() -> bool:
	return not _covering


## Always its own card: the modal's, or the banner's floating strip card.
func _card_shown() -> bool:
	return true


func _card_variation() -> String:
	return "PKeyCard" if _covering else "PKeyBanner"


## One row: a banner on a landscape screen.
func _row() -> bool:
	return not _covering and is_landscape()


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide" if _row() else "card_width"), content_room().x))


func _arrange(m: Dictionary) -> void:
	var row := _row()
	set_columns(_card, row)
	# In a row the actions sit at the end on one line; stacked, they lead under the words.
	_actions.size_flags_horizontal = Control.SIZE_SHRINK_END if row else Control.SIZE_FILL
	_actions.alignment = FlowContainer.ALIGNMENT_END if row else FlowContainer.ALIGNMENT_BEGIN
	_title.theme_type_variation = "PKeyTitle" if _covering else "PKeySection"
	if _covering:
		if get_theme_stylebox("panel") is StyleBoxEmpty:
			remove_theme_stylebox_override("panel")
		mouse_filter = Control.MOUSE_FILTER_STOP
	else:
		_float_strip()
		# The strip's margins let the game's clicks through; only the card takes them.
		mouse_filter = Control.MOUSE_FILTER_IGNORE
	super(m)
	var line := 0.0
	if row:
		for b in [_action, _dismiss]:
			if (b as Control).visible:
				line += (b as Control).get_combined_minimum_size().x + (role("inline_gap") if line > 0.0 else 0.0)
	_actions.custom_minimum_size.x = line


func _ready() -> void:
	super()
	follow_updates()


# A Control grows to its minimum size but never shrinks back: a strip laid out while its parent
# was still narrow (wrapped text, a tall strip) would stay tall once the parent widens. Outside a
# Container (which sizes it), a banner strip is trimmed to its own minimum height each time that
# height changes.
func _queue_fit() -> void:
	if not _fit_queued:
		_fit_queued = true
		_fit.call_deferred()


func _fit() -> void:
	_fit_queued = false
	if _covering or not is_inside_tree() or get_parent() is Container or anchor_top != anchor_bottom:
		return
	var h := get_combined_minimum_size().y
	if size.y > h:
		# Offsets, not `size`: setting the size of a wide-anchored Control warns and is undone.
		if grow_vertical == Control.GROW_DIRECTION_BEGIN:
			offset_top = offset_bottom - h
		else:
			offset_bottom = offset_top + h


## Follow PolarisKey.update.update_available from now on, and show the answer already announced
## (PolarisKey.update.last_available) when this prompt has none yet: a prompt added after the boot
## still shows a mandatory or blocked answer. Called from `_ready`; safe to call again.
func follow_updates() -> void:
	if sdk == null or sdk.get("update") == null:
		return
	if not _bound:
		_bound = true
		sdk.update.update_available.connect(show_result)
	var last = sdk.update.get("last_available")
	if result == null and last is PKeyResult:
		show_result(last)


func show_result(r: PKeyResult) -> void:
	result = r
	is_dismissed = false
	refresh_view()


## The outlet KIND the prompt renders for: `outlet`, else this install's (PolarisKey.update.outlet(),
## detection included), else the stamp's outlet; "" (read as direct) in the editor.
func _outlet() -> String:
	if outlet != "":
		return outlet
	if sdk != null and sdk.get("update") != null and sdk.get("core") != null:
		var k = sdk.update.outlet().get("kind")
		return k if k is String and k != PKeyDecision.OUTLET_UNKNOWN else ""
	if sdk != null and sdk.has_method("build_info"):
		var o = sdk.build_info().get("outlet")
		return o if o is String else ""
	return ""


## The adapter's plan for the answer, with this install's context, when an SDK is configured and
## no `outlet` override is set; {} otherwise (the controller then plans from `outlet`).
func _plan() -> Dictionary:
	_page_link = false
	if outlet != "" or sdk == null or sdk.get("core") == null or sdk.get("update") == null or not sdk.update.has_method("plan"):
		return {}
	var p: Dictionary = sdk.update.plan(result)
	if p.is_empty():
		return p
	# A game-given release page backs a download answer when discovery named no build URL.
	if p.get("behaviour") == PKeyApplyResult.SILENT and release_url != "" and result is PKeyUpdateCheck and result.decision.get("action") == "binary" and _outlet() == "direct":
		_page_link = true
		return PKeyOutletAdapter.link_or_silent(release_url, "update_action")
	return p


## The mode in use: "banner" or "modal" ("" when hidden).
func presentation() -> String:
	if not visible:
		return ""
	return "modal" if _covering else "banner"


func _render() -> void:
	var t := c()
	model = PKeyUpdatePromptController.model(result, _outlet(), release_url, show_when_current, _plan())
	var locked: bool = model["locked"]
	visible = model["visible"] and (locked or not is_dismissed)
	var as_modal := modal and not locked
	if as_modal:
		set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		size_flags_vertical = Control.SIZE_FILL
		theme_type_variation = ""
		_covering = true
	else:
		# Never left full-rect: a locked answer must not cover the running game. The anchors hold
		# under a plain Control or a CanvasLayer; a Container parent ignores anchors, so the
		# banner also asks a container for its own height only, at the top.
		if _covering:
			set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
			_covering = false
		size_flags_vertical = Control.SIZE_SHRINK_BEGIN
		theme_type_variation = ""
		_queue_fit()
	show_text(_title, t.text(model["title"]) if model["title"] != "" else "")
	show_text(_body, t.text(model["body"], model["body_arg"]) if model["body"] != "" else "")
	show_text(_action, t.text(model["action"]) if model["action"] != "" else "")
	_dismiss.visible = not locked and model["state"] != "current"
	_dismiss.text = t.text("update_dismiss")


func _focus_chain() -> Array:
	return [_action, _dismiss]


func _on_action() -> void:
	if result is PKeyUpdateCheck and not _page_link and sdk != null and sdk.get("core") != null and sdk.get("update") != null and sdk.update.has_method("apply") and outlet == "":
		action_taken.emit(result)
		var applied: PKeyApplyResult = await sdk.update.apply(result)
		action_applied.emit(applied)
		return
	if model.get("behaviour", "") == PKeyApplyResult.LINK and PKeyOutletAdapter.is_https(model.get("action_url", "")):
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
