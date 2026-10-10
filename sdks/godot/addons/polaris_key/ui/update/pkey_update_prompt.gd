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
## Set for the prompts the kit places itself (PKeyBoot's own and the one it keeps over the game): a
## prompt the game places replaces them, so there is one update prompt on screen at a time.
var managed := false
## A newer prompt took over this one's answer: it shows nothing (a kept prompt frees itself).
var superseded := false

var _card: BoxContainer
var _product: PKeyProductHeader
var _text: VBoxContainer
var _actions: BoxContainer
var _title: Label
var _body: Label
var _action: Button
var _dismiss: Button
var _bound := false
var _covering := false
var _fit_queued := false
var _page_link := false
var _checking := false
var _check_note := ""
var _note: Label


func _build() -> void:
	name = "PKeyUpdatePrompt"
	# The view's panel is the prompt's own: a page ground for the modal, a transparent strip that
	# floats the banner card for the banner (`_arrange`).
	add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	_card = columns(card_panel(), "Body")
	_text = vbox(_card, "Text", "PKeyTight")
	_text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_text.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	# On the modal card the product leads, its icon at the card size (56 px).
	_product = product_header(_text, "Product")
	_product.card = true
	_title = label(_text, "Title", "PKeyTitle")
	_body = label(_text, "Message", "PKeyMuted")
	_note = label(_text, "CheckNote", "PKeyMuted")
	_actions = actions_row(_card, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_actions.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_action = button(_actions, "Action", _on_action, "PKeyPrimary")
	_dismiss = button(_actions, "Dismiss", _on_dismiss)
	minimum_size_changed.connect(_queue_fit)


func _floats() -> bool:
	return not _covering


## The modal card dims the game with the scrim instead of replacing it with a page.
func _scrim_wanted() -> bool:
	return _covering


func _bleeds() -> bool:
	return _covering


func _guard_for_modal() -> bool:
	return _covering and visible


func _screen_key() -> String:
	return "%s|%s|%s" % [model.get("state", ""), model.get("locked", false), _covering]


## A modal opens on its way out ("Not now"), never on the update, so a stray press cannot start it.
func _initial_focus() -> Control:
	if _covering and is_focusable(_dismiss):
		return _dismiss
	return _action if is_focusable(_action) else (_dismiss if is_focusable(_dismiss) else null)


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
	_actions.set_meta(&"pkey_align", BoxContainer.ALIGNMENT_END if row else BoxContainer.ALIGNMENT_BEGIN)
	_product.visible = _covering and _product.visible
	_title.theme_type_variation = "PKeyTitle" if _covering else "PKeySection"
	if _covering:
		if has_theme_stylebox_override("panel") and get_theme_stylebox("panel") is StyleBoxEmpty:
			# The strip's transparent panel (with or without the safe area folded into its margins)
			# gives way to the scrim, and the safe area is baked into the scrim's panel instead: a
			# modal laid out fresh at the size (the strip's panel was the first one it had) gets the
			# same insets as one that was resized to it.
			remove_theme_stylebox_override("panel")
			_safe_base = null
			_safe_applied = [0.0, 0.0, 0.0, 0.0]
			_apply_safe_area(m["insets"])
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
	_claim()
	if superseded:
		return
	if not _bound:
		_bound = true
		sdk.update.update_available.connect(show_result)
	var last = sdk.update.get("last_available")
	if result == null and last is PKeyResult:
		show_result(last)


## One update prompt follows the SDK at a time: the latest one the game places, and the kit's own
## only while the game has placed none. The prompt it replaces hides (a kept one is freed).
func _claim() -> void:
	var prior: Node = null
	if sdk.has_meta(&"pkey_update_prompt"):
		prior = (sdk.get_meta(&"pkey_update_prompt") as WeakRef).get_ref() as Node
	if prior != null and prior != self and is_instance_valid(prior) and not prior.is_queued_for_deletion():
		if managed and not prior.get("managed"):
			superseded = true
			refresh_view()
			return
		prior.call("_yield_to_newer")
	superseded = false
	sdk.set_meta(&"pkey_update_prompt", weakref(self))


func _yield_to_newer() -> void:
	superseded = true
	if has_meta(&"pkey_kept"):
		queue_free()
	else:
		refresh_view()


func show_result(r: PKeyResult) -> void:
	_check_note = ""
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
	visible = model["visible"] and (locked or not is_dismissed) and not superseded
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
		if _covering or (not (get_parent() is Container) and anchor_top != anchor_bottom):
			# A locked or non-modal answer asked for in a full-screen slot is still a strip at the
			# top, whatever was true before.
			set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
			_covering = false
		size_flags_vertical = Control.SIZE_SHRINK_BEGIN
		theme_type_variation = ""
		_queue_fit()
	var product := String(PKeyUiTheme.product_identity()["name"])
	var title_text: String = t.text(model["title"]) if model["title"] != "" else ""
	var body_text: String = t.text(model["body"], model["body_arg"]) if model["body"] != "" else ""
	var plain: bool = model["state"] in ["binary", "store", "platform", "version"] and model["version"] != ""
	if as_modal and plain and product != "":
		# "{product} {version}", and what the player has: nothing else to read.
		title_text = t.text("update_modal_title", model["version"])
		var have := String(ProjectSettings.get_setting("application/config/version", ""))
		var size = (result as PKeyUpdateCheck).decision.get("size") if result is PKeyUpdateCheck else null
		if have == "":
			body_text = ""
		elif PKeyClaims.is_number(size) and float(size) > 0.0:
			body_text = t.text("update_current", [have, PKeyBoot.human_size(int(size))])
		else:
			body_text = t.text("update_current_nosize", have)
	elif locked and model["body"] == "update_mandatory_body" and product != "":
		title_text = t.text("update_mandatory_title", product)
		body_text = ""
	show_text(_title, title_text)
	show_text(_body, body_text)
	_product.visible = as_modal
	if as_modal:
		_product.refresh()
	# A locked answer is never a dead end: with nothing to open or install, the action asks again.
	if model["visible"] and locked and model["action"] == "" and model["state"] not in ["", "current"] and sdk != null and sdk.get("update") != null:
		model["action"] = "update_check_again"
		model["behaviour"] = "check"
	show_text(_action, (t.text("update_checking") if _checking else t.text(model["action"])) if model["action"] != "" else "")
	_action.disabled = _checking
	show_text(_note, _check_note)
	_dismiss.visible = not locked and model["state"] != "current"
	_dismiss.text = t.text("update_dismiss")


func _focus_chain() -> Array:
	return [_action, _dismiss]


func _on_action() -> void:
	if model.get("behaviour", "") == "check":
		action_taken.emit(result)
		_checking = true
		_check_note = ""
		refresh_view()
		var before := model.duplicate()
		var again: PKeyUpdateCheck = await sdk.update.decide()
		_checking = false
		if not is_inside_tree():
			return
		if not again.ok:
			# The old answer stays; the failure is said under it.
			_check_note = c().text("update_check_failed")
			refresh_view()
			return
		var after := PKeyUpdatePromptController.model(again, _outlet(), release_url, show_when_current, {})
		if after["visible"] and after["state"] == before.get("state") and after["version"] == before.get("version"):
			result = again
			_check_note = c().text("update_no_update_yet")
			refresh_view()
		else:
			show_result(again)
		return
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
	# Back to the control (the game's own) that had focus when the modal opened.
	restore_opener()


func _cancel() -> bool:
	if not model.get("locked", false) and visible:
		_on_dismiss()
		return true
	return false
