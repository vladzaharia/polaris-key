class_name PKeyActivateDone
extends PKeyUiView
## ActivateDone (ui-matrix `holders`; ui-core's `activate_done_view`): the step after a license key
## activates. "{product} is ready", the license line and, once and quietly, a recommendation to keep
## the license in an account. Skipping is never a refusal: Start using is always the one filled
## control, and "Or continue without an account" is a line, not a second button.
##
## States (the model's): `ready` (the recommendation: only the reasons the product has, one action),
## `waiting` (the license was sent to an email: sign in as that email) and hidden (License off). With
## Identity off, or a kit with no in-app channel (`add_in` "portal"), the action says it opens Polaris
## Locker and carries the new-window glyph.
##
## The kit draws the step; what the buttons do is the host's: connect `start_pressed`, `add_pressed`
## and `sign_in_pressed`. While the host works on a press it sets `busy`: the card then offers no
## action and takes no focus, and the press is ignored.

## Start using the product: the one primary.
signal start_pressed()
## Add your name and email (or Add it in Polaris Locker): the host opens AddToAccount or the portal.
signal add_pressed()
## Sign in as the email the license was sent to (waiting).
signal sign_in_pressed()

## The license's tier and term, as words ("Pro", "Lifetime"); the device line is left out while
## any of its parts is unknown, never drawn with a placeholder.
@export var tier := "":
	set(value):
		tier = value
		refresh_view()
@export var term := "":
	set(value):
		term = value
		refresh_view()
## This device as a word ("computer", "phone").
@export var device_kind := "":
	set(value):
		device_kind = value
		refresh_view()
## The seat this device takes, and how many the license has (0: unknown).
@export var seat := 0:
	set(value):
		seat = value
		refresh_view()
@export var limit := 0:
	set(value):
		limit = value
		refresh_view()
## The developer's name, for "without asking {developer}"; empty names the product instead.
@export var developer := "":
	set(value):
		developer = value
		refresh_view()
## "app": Add opens AddToAccount here. "portal": a kit with no in-app channel; Add opens Polaris Locker.
@export_enum("app", "portal") var add_in := "app":
	set(value):
		add_in = value
		refresh_view()
## The license was sent to this email: the card waits for an account that holds it. Shown masked.
@export var holder_email := "":
	set(value):
		holder_email = value
		refresh_view()
## A catalog key for a problem line (the portal link is missing or was refused, a sign-in did not
## finish); "" for none. Drawn in the danger tone, a polite live region.
@export var problem_key := "":
	set(value):
		problem_key = value
		refresh_view()
## The portal has no link behind it: Add opens nothing, so it is not offered.
@export var no_add_action := false:
	set(value):
		no_add_action = value
		refresh_view()
## The person came back from the browser: focus returns to the action they left from.
@export var returned := false:
	set(value):
		returned = value
		refresh_view()
@export var identity_on := true:
	set(value):
		identity_on = value
		refresh_view()
@export var sync_on := true:
	set(value):
		sync_on = value
		refresh_view()
## False turns the License service off: nothing shows.
@export var license_on := true:
	set(value):
		license_on = value
		refresh_view()
## A press is in flight (a hold flag): no action shows, nothing takes focus.
var busy := false:
	set(value):
		busy = value
		refresh_view()

var model: Dictionary = {}

var _body: VBoxContainer
var _product: PKeyProductHeader
var _mark: TextureRect
var _title: Label
var _device: Label
var _waiting: Label
var _recommend: PanelContainer
var _rec_title: Label
var _badge: Label
var _head: BoxContainer
var _reasons: VBoxContainer
var _reason_glyphs: Array = []
var _reason_lines: Array = []
var _add: Button
var _skip: Label
var _problem: Label
var _problem_glyph: TextureRect
var _spacer: Control
var _actions: BoxContainer
var _primary: Button
var _sign_in: Button


func _build() -> void:
	name = "PKeyActivateDone"
	_body = vbox(card_panel(), "Body", "PKeySections")
	var top := vbox(_body, "Top", "PKeyStack")
	_product = product_header(top, "Product")
	_product.card = true
	_mark = glyph_node(top, "Mark", "success")
	_mark.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	var words := vbox(top, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_device = label(words, "Device", "PKeyMuted")
	_waiting = label(words, "Waiting", "PKeyMuted")
	_waiting.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_recommend = PanelContainer.new()
	_recommend.name = "Recommend"
	_recommend.theme_type_variation = &"PKeyCard"
	_recommend.set_meta(AUTO_HIDE_META, true)
	top.add_child(_recommend)
	var rec := vbox(_recommend, "Stack", "PKeyStack")
	_head = BoxContainer.new()
	_head.name = "Head"
	_head.theme_type_variation = &"PKeyRow"
	_head.set_meta(AUTO_HIDE_META, true)
	rec.add_child(_head)
	var head := _head
	_rec_title = label(head, "Title", "PKeySection")
	_rec_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_badge = label(head, "Badge", "PKeyBadge")
	_badge.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	# A chip is one word, never wrapped: the title gives way to it.
	_badge.autowrap_mode = TextServer.AUTOWRAP_OFF
	_reasons = vbox(rec, "Reasons", "PKeyTight")
	for i in 3:
		var row := hbox(_reasons, "Reason%d" % i)
		row.alignment = BoxContainer.ALIGNMENT_BEGIN
		var g := glyph_node(row, "Glyph", "check")
		g.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
		var line := PKeyRichLine.new()
		line.name = "Line"
		row.add_child(line)
		_reason_glyphs.append(g)
		_reason_lines.append(line)
	_add = button(rec, "Add", func() -> void: _press(add_pressed))
	_add.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_skip = label(top, "Skip", "PKeyMuted")
	var problem := glyph_label(top, "Problem", "warning", "PKeyError")
	_problem = problem["label"]
	_problem_glyph = problem["glyph"]
	if "accessibility_live" in _problem:
		_problem.set("accessibility_live", 1)
	_spacer = spacer(_body)
	_actions = actions_row(_body, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_primary = button(_actions, "Primary", func() -> void: _press(start_pressed), "PKeyPrimary")
	_sign_in = button(_actions, "SignIn", func() -> void: _press(sign_in_pressed), "PKeyLink")
	for b in [_add, _primary, _sign_in]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


## A press the host has not answered yet is ignored.
func _press(sig: Signal) -> void:
	if busy:
		return
	sig.emit()


func _bleeds() -> bool:
	return true


func _opens_at_top() -> bool:
	return true


## 1 the product header and the mark, 2 the gaps, 3 the device line, the skip line and the badge,
## 4 all but the first reason, 5 the reasons.
func squeeze_max() -> int:
	return 5


func _arrange(m: Dictionary) -> void:
	super(m)
	# Short on room, the product header gives way before the card scrolls.
	_product.visible = squeeze_level() < 1
	size_glyph(_mark, 40.0, get_theme_color("font_color", "PKeyStrong"))
	var tight := squeeze_level() >= 2
	_body.theme_type_variation = &"PKeyTight" if tight else &"PKeySections"
	(_body.get_node("Top") as VBoxContainer).theme_type_variation = &"PKeyTight" if tight else &"PKeyStack"
	(_recommend.get_node("Stack") as VBoxContainer).theme_type_variation = &"PKeyTight" if tight else &"PKeyStack"
	_tighten_card()
	# Inside the recommendation card the Add button has the card's width less its padding.
	var inner := room_x() - scrollbar_width() - 2.0 * roundf(role("stack_gap") * (0.75 if squeeze_level() >= 2 else 1.0)) - 4.0
	if _add.custom_minimum_size.x > inner:
		_add.custom_minimum_size.x = maxf(inner, 1.0)
		_add.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	# The chip beside the title while the card holds both, above it when it does not (large type).
	var chip := _badge.get_combined_minimum_size().x
	var head_room := room_x() - 2.0 * role("stack_gap")
	_head.vertical = chip > 0.0 and chip + head_room * 0.5 > head_room
	_badge.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN if _head.vertical else Control.SIZE_SHRINK_END
	_head.move_child(_badge, 0 if _head.vertical else 1)
	for g in _reason_glyphs:
		size_glyph(g, 18.0, get_theme_color("font_color", "PKeyMuted"))
	size_glyph(_problem_glyph, 20.0, get_theme_color("font_color", "PKeyError"))
	_spacer.visible = phone_screen()


## The recommendation is a quiet card inside the card: the kit's card shape, with a smaller padding
## than a screen's own, so the step fits the room a laptop window leaves.
func _tighten_card() -> void:
	var box := get_theme_stylebox("panel", "PKeyCard")
	if not (box is StyleBoxFlat):
		return
	var pad := roundf(role("stack_gap") * (0.75 if squeeze_level() >= 2 else 1.0))
	var held := _recommend.get_theme_stylebox("panel")
	if held is StyleBoxFlat and held != box and is_equal_approx((held as StyleBoxFlat).content_margin_left, pad) and (held as StyleBoxFlat).bg_color == (box as StyleBoxFlat).bg_color:
		return
	var tight := (box as StyleBoxFlat).duplicate() as StyleBoxFlat
	tight.content_margin_left = pad
	tight.content_margin_right = pad
	tight.content_margin_top = pad
	tight.content_margin_bottom = pad
	_recommend.add_theme_stylebox_override("panel", tight)


func _screen_key() -> String:
	return "%s|%s|%s" % [model.get("state", ""), busy, problem_key]


## The model input of this step (ui-matrix `holders`).
func input() -> Dictionary:
	var done := {}
	if tier != "":
		done["tier"] = tier
	if term != "":
		done["term"] = term
	if device_kind != "":
		done["deviceKind"] = device_kind
	if seat > 0:
		done["position"] = seat
	if limit > 0:
		done["limit"] = limit
	if returned:
		done["returned"] = true
	var out := {"activateDone": done}
	var presentation := {"name": String(PKeyUiTheme.product_identity()["name"])}
	if developer != "":
		presentation["developerName"] = developer
	out["presentation"] = presentation
	var holder := {}
	if holder_email != "":
		holder["email"] = holder_email
	if add_in == "portal":
		holder["addIn"] = "portal"
	if not holder.is_empty():
		out["licenseHolder"] = holder
	var off := []
	if not license_on:
		off.append("license")
	if not identity_on:
		off.append("identity")
	if not sync_on:
		off.append("sync")
	if not off.is_empty():
		out["services"] = PKeyHolderText.services_without(off)
	if not identity_on:
		out["capabilities"] = {"signIn": false}
	return out


func _render() -> void:
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("ActivateDone", input())
	var state: String = model.get("state", "hidden")
	visible = state != "hidden"
	var copy: Array = model.get("copy", [])
	var args := PKeyHolderText.args_of(model)
	_product.refresh()
	var ready := state == "ready"
	var waiting := state == "waiting"
	cat_text(_title, "activate.done.title" if state != "hidden" else "", args)
	# The device line needs every part; a missing one leaves the line out.
	# A license that names no term says the line without it; one with no seat (the roster was not
	# reached) falls back to the tier alone.
	var level := squeeze_level()
	var device_line := ""
	if state != "hidden" and level < 3 and copy.has("activate.done.device"):
		var seat_known := true
		for k in ["tier", "deviceKind", "n", "limit"]:
			seat_known = seat_known and args.has(k)
		if seat_known:
			var line_args := args.duplicate()
			var no_term := not line_args.has("term")
			if no_term:
				line_args["term"] = "\u0001term\u0001"
			device_line = String(catalog().format("activate.done.device", line_args))
			if no_term:
				device_line = device_line.replace(" · \u0001term\u0001", "").replace("\u0001term\u0001", "")
		elif args.has("tier"):
			device_line = String(catalog().format("account.tier", {"tier": args["tier"]}))
	_device.set_meta(CATALOG_META, true)
	show_text(_device, device_line)
	cat_text(_waiting, "activate.waiting" if waiting else "", args)
	_mark.visible = state != "hidden" and level < 1
	# The recommendation: a quiet card, only the reasons the model names.
	_recommend.visible = ready
	cat_text(_rec_title, "activate.recommend.title" if ready else "", args)
	cat_text(_badge, "activate.recommend.badge" if ready and level < 3 else "", args)
	var reasons := PKeyHolderText.reasons(model)
	var shown := 0 if level >= 5 else (1 if level >= 4 else reasons.size())
	for i in _reason_lines.size():
		var on := ready and i < reasons.size() and i < shown
		(_reason_lines[i] as PKeyRichLine).show_lead(String(catalog().format(reasons[i], args)) if on else "")
		(_reason_glyphs[i] as Control).visible = on
	var portal := copy.has("signin.key.addInLocker")
	var add_key := "signin.key.addInLocker" if portal else "activate.recommend.action"
	cat_text(_add, add_key if ready and not busy and not no_add_action else "", args)
	# Opens Polaris Locker in the browser: the new-window glyph, described to a screen reader.
	leaves_app(_add, portal and ready and not busy and not no_add_action)
	if not portal and "accessibility_description" in _add:
		_add.set("accessibility_description", "")
	cat_text(_skip, "activate.recommend.skip" if ready and copy.has("activate.recommend.skip") and level < 3 else "", args)
	cat_text(_primary, "signin.done.start" if state != "hidden" and not busy else "", args)
	cat_text(_sign_in, "activate.waitingSignIn" if waiting and not busy else "", args)
	cat_text(_problem, problem_key if state != "hidden" else "", args)
	_problem_glyph.visible = _problem.visible
	_problem_glyph.set_meta(&"pkey_glyph", "warning")
	fx_error(problem_key if state != "hidden" else "")
	_actions.visible = state != "hidden" and not busy
	set_loading(busy)
	set_process(busy)
	_describe_primary()


## The primary reads the step's title and its first line to a screen reader, and carries nothing
## once the step changes (every render starts from none).
func _describe_primary() -> void:
	if not ("accessibility_description" in _primary):
		return
	var line := _waiting.text if _waiting.visible else (_device.text if _device.visible else "")
	var text := _title.text
	if line != "":
		text += ". " + line
	_primary.set("accessibility_description", text if _primary.visible and not busy else "")


func _process(_delta: float) -> void:
	_tick_loading()


func _initial_focus() -> Control:
	if busy:
		return null
	# Back from the browser: the action they left from; otherwise the forward action.
	if returned and is_focusable(_add):
		return _add
	return _primary if is_focusable(_primary) else null


func _focus_chain() -> Array:
	return [_add, _primary, _sign_in]


## Nothing here to back out of: Escape (or a pad's B) neither skips the recommendation nor answers
## it, and is left for the game.
func _cancel() -> bool:
	return false
