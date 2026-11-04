class_name PKeyAddToAccount
extends PKeyUiView
## AddToAccount (ui-matrix `holders`; ui-core's `add_to_account_view`): add a name and an email to
## the license a key activated. The person types them here; the browser confirms the email. The
## steps are the model's (`AddToAccountModel`, ui/model/add_to_account.gd):
##
##   form, invalid (a field is wrong), busy (the sign-in runs; with a `user_code` the card shows
##   `waiting`, the code to check in Polaris Locker), added, owned, email-bound, other-account, failed
##
## The kit draws the step; what the buttons do is the host's: connect the signals and set `step`
## (`apply_snapshot()` takes the model's snapshot). The typed name and email live in the two fields
## only: they are not in the model's input, in any signal but `submitted`, or in a log.
##
## Rules this scene keeps:
##   - a busy card offers only the ways out of the wait (Open the browser again, Cancel), takes no
##     focus of its own, and its fields are read-only;
##   - the first focus goes to the forward action, never Cancel (to the first wrong field, or to
##     Name, on a desktop with a keyboard);
##   - Escape (or a pad's B) leaves a form with nothing in flight, and does nothing while a sign-in
##     runs: it never cancels work in flight;
##   - a problem line is a polite live region in the danger tone, and says so with a glyph;
##   - the step's primary carries the title and the first line as its accessibility description,
##     and none once the step changes.

## Continue (a press or Enter in Email): the typed values, for the host to hand to the model.
signal submitted(person_name: String, email: String)
## A field was edited ("name" or "email"): an invalid step goes back to the form.
signal edited(field: String, value: String)
## Try again, from failed or other-account.
signal retry_pressed()
## Cancel, or Escape on a step with nothing in flight.
signal cancelled()
## Open the browser (Polaris Locker) again.
signal reopen_pressed()
## Start using the product, or Done (added; email-bound and other-account's way on).
signal start_pressed()
## Sign in to the account that holds the license (owned), or use another account (email-bound).
signal sign_in_pressed()
## Verify the license's email (email-bound).
signal verify_pressed()

const NAME_MAX := 120
const EMAIL_MAX := 254

@export_enum("form", "invalid", "busy", "added", "owned", "email-bound", "other-account", "failed") var step := "form":
	set(value):
		step = value
		refresh_view()
## `invalid`: the field to fix, "name", "email" or "both".
@export_enum("both", "name", "email") var field := "both":
	set(value):
		field = value
		refresh_view()
## This device as a word ("computer", "phone"); empty is chosen from the platform.
@export var device_kind := "":
	set(value):
		device_kind = value
		refresh_view()
## `other-account`: both emails, masked (never the full address).
@export var typed_email := "":
	set(value):
		typed_email = value
		refresh_view()
@export var signed_email := "":
	set(value):
		signed_email = value
		refresh_view()
## `email-bound`: the email the license was sent to (shown masked).
@export var holder_email := "":
	set(value):
		holder_email = value
		refresh_view()
## `busy` with a code (the view's `waiting`): the code the person checks against the one Polaris Locker shows.
@export var user_code := "":
	set(value):
		user_code = value
		refresh_view()
## `busy` with a code: where to type it (the sign-in page's address) and the page with the code filled
## in (a QR code on a wide window or a TV). Empty draws neither.
@export var address := "":
	set(value):
		address = value
		refresh_view()
@export var link := "":
	set(value):
		link = value
		refresh_view()
## The wait's page has opened once: its button reads "Open Polaris Locker again", not "Open browser".
@export var opened := true:
	set(value):
		opened = value
		refresh_view()
## A catalog key for a problem line this step carries beyond its own (a page that did not open, a
## sign-in that did not finish); "" for none. Drawn in the danger tone, a polite live region.
@export var problem_key := "":
	set(value):
		problem_key = value
		refresh_view()
## `busy` with a code for an account sign-in: the masked email to sign in as ("" for none).
@export var signing_as := "":
	set(value):
		signing_as = value
		refresh_view()
## Opened from Settings: added closes with Done, not Start using.
@export var from_settings := false:
	set(value):
		from_settings = value
		refresh_view()
@export var identity_on := true:
	set(value):
		identity_on = value
		refresh_view()
@export var sync_on := true:
	set(value):
		sync_on = value
		refresh_view()

## The host owns this scene's visibility (PKeyHolderFlow shows one step at a time): `_render()` leaves
## `visible` alone.
var hosted := false
## An account sign-in is starting: the busy bar shows and presses on the step are ignored.
var working := false:
	set(value):
		working = value
		refresh_view()

var model: Dictionary = {}

var _body: VBoxContainer
var _product: PKeyProductHeader
var _mark: TextureRect
var _title: Label
var _lede: Label
var _signing: Label
## The step before the one on screen (the first wrong field takes focus on entering `invalid`).
var _prev_state := ""
var _form: VBoxContainer
var _name_label: Label
var _name_input: LineEdit
var _name_error: Label
var _email_label: Label
var _email_input: LineEdit
var _email_error: Label
var _fine: Label
var _code_block: VBoxContainer
var _code_caption: Label
var _code: Label
var _check: Label
var _address: Label
var _qr_caption: Label
var _qr: PKeyQrRect
var _problem: Label
var _problem_glyph: TextureRect
var _status: Label
var _spacer: Control
var _actions: BoxContainer
var _primary: Button
var _second: Button
var _link: Button
var _link2: Button


func _build() -> void:
	name = "PKeyAddToAccount"
	_body = vbox(card_panel(), "Body", "PKeySections")
	var top := vbox(_body, "Top", "PKeyStack")
	_product = product_header(top, "Product")
	_product.card = true
	_mark = glyph_node(top, "Mark", "success")
	_mark.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	var words := vbox(top, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_lede = label(words, "Lede", "PKeyMuted")
	_signing = label(words, "SigningAs", "PKeyStrong")
	_form = vbox(top, "Form", "PKeyStack")
	var name_block := vbox(_form, "NameField", "PKeyTight")
	_name_label = label(name_block, "NameLabel", "PKeyStrong")
	_name_input = _line_edit(name_block, "NameInput", LineEdit.KEYBOARD_TYPE_DEFAULT, NAME_MAX)
	_name_input.text_changed.connect(func(t: String) -> void: edited.emit("name", t))
	_name_input.text_submitted.connect(func(_t: String) -> void: _email_input.grab_focus())
	_name_error = _problem_line(name_block, "NameError")
	var email_block := vbox(_form, "EmailField", "PKeyTight")
	_email_label = label(email_block, "EmailLabel", "PKeyStrong")
	# The mail keyboard (an @ and a dot within reach), and no word suggestions for an address.
	_email_input = _line_edit(email_block, "EmailInput", LineEdit.KEYBOARD_TYPE_EMAIL_ADDRESS, EMAIL_MAX)
	_email_input.text_changed.connect(func(t: String) -> void: edited.emit("email", t))
	_email_input.text_submitted.connect(func(_t: String) -> void: _on_continue())
	_email_error = _problem_line(email_block, "EmailError")
	_fine = label(email_block, "Fine", "PKeyMuted")
	_code_block = vbox(top, "CodeBlock", "PKeyTight")
	_code_caption = label(_code_block, "CodeCaption", "PKeyMuted")
	_code = label(_code_block, "Code", "PKeyCode", true)
	_check = label(_code_block, "Check", "PKeyMuted")
	_address = label(_code_block, "Address", "PKeyMuted")
	_qr_caption = label(_code_block, "QrCaption", "PKeyMuted")
	_qr = qr_tile(_code_block)
	# Left with the text column; a TV centres it (`_arrange`).
	_qr.get_parent().size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	var problem := glyph_label(top, "Problem", "warning", "PKeyError")
	_problem = problem["label"]
	_problem_glyph = problem["glyph"]
	_live(_problem)
	_status = label(top, "Status", "PKeyMuted")
	_live(_status)
	loading_bar(_body)
	_spacer = spacer(_body)
	_actions = actions_row(_body, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_primary = button(_actions, "Primary", _on_primary, "PKeyPrimary")
	_second = button(_actions, "Second", _on_second)
	_link = button(_actions, "Link", _on_link, "PKeyLink")
	_link2 = button(_actions, "Link2", _on_link2, "PKeyLink")
	for b in [_primary, _second, _link, _link2]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


func _line_edit(parent: Node, node_name: String, keyboard: int, max_chars: int) -> LineEdit:
	var le := LineEdit.new()
	le.name = node_name
	le.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	le.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	le.virtual_keyboard_type = keyboard as LineEdit.VirtualKeyboardType
	le.max_length = max_chars
	le.caret_blink = true
	# Enter submits or moves on; the field stays in edit mode, so a correction typed next is not lost.
	le.keep_editing_on_text_submit = true
	le.context_menu_enabled = true
	parent.add_child(le)
	return le


## A problem line: the danger tone, and a polite live region so a screen reader reads it when it
## appears, without taking the focus.
func _problem_line(parent: Node, node_name: String) -> Label:
	var l := label(parent, node_name, "PKeyError")
	_live(l)
	return l


static func _live(l: Label) -> void:
	if "accessibility_live" in l:
		l.set("accessibility_live", 1)


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
	size_glyph(_mark, 40.0, get_theme_color("font_color", "PKeyStrong"))
	size_glyph(_problem_glyph, 20.0, get_theme_color("font_color", "PKeyError"))
	_qr.get_parent().size_flags_horizontal = Control.SIZE_SHRINK_CENTER if pad_only() else Control.SIZE_SHRINK_BEGIN
	_spacer.visible = phone_screen()
	_fit_code()
	_body.theme_type_variation = &"PKeyTight" if squeeze_level() >= 2 else &"PKeySections"


## The code on one line, never broken: its type steps down (to 14) until it fits the card's width.
func _fit_code() -> void:
	if not _code.visible or _code.text == "":
		return
	_code.autowrap_mode = TextServer.AUTOWRAP_OFF
	_code.remove_theme_font_size_override(&"font_size")
	var natural := _code.get_theme_font_size("font_size")
	var font := _code.get_theme_font("font")
	var size := natural
	var avail := maxf(room_x() - scrollbar_width() - 4.0, 1.0)
	while size > 14 and font.get_string_size(_code.text, HORIZONTAL_ALIGNMENT_CENTER, -1, size).x > avail:
		size -= 2
	if size != natural:
		_code.add_theme_font_size_override(&"font_size", size)


## The form, a wrong field and the wait of the form are one screen: typing never counts as a new one
## (the focus would be moved off the field being typed in).
func _screen_key() -> String:
	var state := String(model.get("state", ""))
	return "form" if state == "form" or state == "invalid" or state == "busy" else state


static func _is_https(url: String) -> bool:
	return url.begins_with("https://") and not url.contains(" ")


func _kind() -> String:
	if device_kind != "":
		return device_kind
	if is_mobile():
		return "phone"
	return "TV" if pad_only() else "computer"


## The model input of this step (ui-matrix `holders`). The typed name and email are not in it.
func input() -> Dictionary:
	var a := {"step": step, "deviceKind": _kind()}
	if step == "invalid":
		a["field"] = field
	if typed_email != "":
		a["typedEmail"] = typed_email
	if signed_email != "":
		a["signedEmail"] = signed_email
	if from_settings:
		a["fromSettings"] = true
	var out := {"addToAccount": a}
	out["presentation"] = {"name": String(PKeyUiTheme.product_identity()["name"])}
	if holder_email != "":
		out["licenseHolder"] = {"email": holder_email}
	if step == "busy" and user_code != "":
		out["deviceCode"] = {"phase": "waiting", "userCode": user_code}
	var off := []
	if not identity_on:
		off.append("identity")
	if not sync_on:
		off.append("sync")
	if not off.is_empty():
		out["services"] = PKeyHolderText.services_without(off)
	if not identity_on:
		out["capabilities"] = {"signIn": false}
	return out


## Follow an AddToAccountModel: its `snapshot()` (the step, the field to fix, the masked emails, the
## code). The model's name and email are the person's own typing; they are not copied back.
func apply_snapshot(snap: Dictionary) -> void:
	typed_email = String(snap.get("typed_email", ""))
	signed_email = String(snap.get("signed_email", ""))
	user_code = String(snap.get("user_code", ""))
	var f := String(snap.get("field", ""))
	if f != "":
		field = f
	step = String(snap.get("step", "form"))


func _render() -> void:
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("AddToAccount", input())
	var state: String = model.get("state", "hidden")
	if not hosted:
		visible = state != "hidden"
	var copy: Array = model.get("copy", [])
	var args := PKeyHolderText.args_of(model)
	_product.refresh()
	var in_form := state == "form" or state == "invalid" or state == "busy"
	var tone_danger: bool = model.get("decisions", {}).get("tone") == "danger"
	var title_key := {
		"form": "activate.recommend.action", "invalid": "activate.recommend.action", "busy": "activate.recommend.action",
		"failed": "activate.recommend.action", "waiting": "activate.attach.waitTitle", "added": "activate.attach.done",
		"owned": "activate.owned.title", "email-bound": "activate.otherEmail.title", "other-account": "activate.otherAccount.title",
	}.get(state, "") as String
	var lede_key := {
		"form": "activate.attach.lede", "invalid": "activate.attach.lede", "busy": "activate.attach.lede",
		"added": "activate.attach.syncOn", "owned": "activate.owned.lede", "email-bound": "activate.otherEmail.body",
		"other-account": "activate.otherAccount.body",
	}.get(state, "") as String
	cat_text(_title, title_key, args)
	var who := "activate.waitingSignIn" if waiting_for_account(state) else ""
	cat_text(_signing, who, {"maskedEmail": signing_as})
	# Short on room the lede goes (3) and then the fine print (4), before the card scrolls.
	var level := squeeze_level()
	var keep_lede := not (in_form and level >= 3)
	cat_text(_lede, lede_key if copy.has(lede_key) and keep_lede else "", args)
	_mark.visible = state == "added"
	# The form: two fields, their problems under them, the fine print under Email.
	_form.visible = in_form
	var bad_name := copy.has("activate.attach.nameRequired")
	var bad_email := copy.has("signin.email.invalid")
	cat_text(_name_label, "activate.attach.name" if in_form else "", args)
	cat_text(_email_label, "signin.email.label" if in_form else "", args)
	cat_text(_name_error, "activate.attach.nameRequired" if bad_name else "", args)
	cat_text(_email_error, "signin.email.invalid" if bad_email else "", args)
	cat_text(_fine, "activate.attach.fine" if in_form and copy.has("activate.attach.fine") and level < 4 else "", args)
	_name_input.theme_type_variation = &"PKeyFieldError" if bad_name else &""
	_email_input.theme_type_variation = &"PKeyFieldError" if bad_email else &""
	# The fields are read-only while the sign-in runs.
	_name_input.editable = state != "busy"
	_email_input.editable = state != "busy"
	name_for_reader(_name_input, _name_label.text)
	name_for_reader(_email_input, _email_label.text)
	# The code to check in Polaris Locker.
	var waiting := state == "waiting"
	_code_block.visible = waiting
	cat_text(_code_caption, "part.code.label" if waiting else "", args)
	_code.text = user_code if waiting else ""
	_code.visible = waiting and user_code != ""
	name_for_reader(_code, String(catalog().format("a11y.code", {"code": user_code})) if _code.visible else "")
	cat_text(_check, "activate.attach.waitCheck" if waiting else "", args)
	# Where to type the code, and a QR code of the page with it filled in on a wide window or a TV.
	var shown_address := PKeySignInController.short_uri(address) if waiting and _is_https(address) else ""
	cat_text(_address, "signin.handoff.url" if shown_address != "" else "", {"url": shown_address})
	var qr_on := waiting and _is_https(link) and (pad_only() or (bool(layout_metrics().get("wide", false)) and not phone_screen()))
	cat_text(_qr_caption, "part.qr.scanInstead" if qr_on else "", args)
	_qr.text = link if qr_on else ""
	_qr.visible = qr_on
	_qr.get_parent().visible = qr_on
	if qr_on:
		var side := qr_side()
		_qr.custom_minimum_size = Vector2(side, side)
		name_for_reader(_qr, String(catalog().format("a11y.qr")))
	# A failure: its own line, in the danger tone, with a glyph; never colour alone.
	var problem_line := problem_key if problem_key != "" and state != "hidden" else ("activate.attach.failed" if state == "failed" else "")
	cat_text(_problem, problem_line, args)
	_problem_glyph.visible = _problem.visible
	_problem_glyph.set_meta(&"pkey_glyph", "warning")
	cat_text(_status, "common.working" if state == "busy" else "", args)
	var first_problem := "activate.attach.nameRequired" if bad_name else ("signin.email.invalid" if bad_email else problem_line)
	fx_error(first_problem if tone_danger else "")
	# The actions of the step.
	var primary_key := String(model.get("decisions", {}).get("primary") if model.get("decisions", {}).get("primary") != null else "")
	var second_key := ""
	var links: Array = []
	match state:
		"busy":
			primary_key = ""
			links = ["signin.handoff.again", "common.cancel"]
		"waiting":
			second_key = "" if pad_only() else ("activate.attach.reopen" if opened else "signin.handoff.openBrowser")
			links = ["common.cancel"]
		"owned", "form", "invalid", "failed":
			links = ["common.cancel"]
		"email-bound":
			second_key = "signin.auto.confirm.other" if primary_key != "signin.auto.confirm.other" and copy.has("signin.auto.confirm.other") else ""
			links = ["signin.done.start"]
		"other-account":
			links = ["signin.done.start"]
	_set_action(_primary, primary_key, copy, args)
	_set_action(_second, second_key, copy, args)
	_set_action(_link, String(links[0]) if links.size() > 0 else "", copy, args)
	_set_action(_link2, String(links[1]) if links.size() > 1 else "", copy, args)
	_actions.visible = state != "hidden"
	_describe_primary()
	set_loading(state == "busy" or working)
	set_process(state == "busy" or working)
	# Entering `invalid` from a submit puts the cursor in the first wrong field; typing in it later is
	# not a new screen, so nothing moves the focus again.
	if state == "invalid" and _prev_state != "invalid" and not pad_only() and is_inside_tree():
		_focus_wrong_field.call_deferred()
	_prev_state = state


func waiting_for_account(state: String) -> bool:
	return state == "waiting" and signing_as != ""


func _focus_wrong_field() -> void:
	if step != "invalid" or not is_visible_in_tree():
		return
	var target := _email_input if field == "email" else _name_input
	if is_focusable(target):
		target.grab_focus()
		target.edit()


func _set_action(b: Button, key: String, copy: Array, args: Dictionary) -> void:
	# The wait's first button reads "Open browser" until the page has opened once (a kit string beyond the model's copy).
	var known := copy.has(key) or (key == "signin.handoff.openBrowser" and copy.has("activate.attach.reopen"))
	cat_text(b, key if known else "", args)
	b.set_meta(&"pkey_key", key if known else "")


## The primary reads the step's title and its first line to a screen reader, and carries nothing
## once the step changes (every render starts from none).
func _describe_primary() -> void:
	if not ("accessibility_description" in _primary):
		return
	var text := ""
	if _primary.visible:
		text = _title.text
		var line := _lede.text if _lede.visible else ""
		if line != "":
			text += ". " + line
	_primary.set("accessibility_description", text)


func _process(_delta: float) -> void:
	_tick_loading()


# ── Values ───────────────────────────────────────────────────────────────────────────────

## What the person typed. Held only in the fields.
func typed_name() -> String:
	return _name_input.text


func typed_email_address() -> String:
	return _email_input.text


func set_values(person_name: String, email: String) -> void:
	_name_input.text = person_name
	_email_input.text = email


## Empty both fields (the flow ended, or the person left).
func clear_values() -> void:
	_name_input.text = ""
	_email_input.text = ""


# ── Presses ──────────────────────────────────────────────────────────────────────────────

func _on_continue() -> void:
	if working or (step != "form" and step != "invalid"):
		return
	submitted.emit(_name_input.text, _email_input.text)


func _on_primary() -> void:
	_route(String(_primary.get_meta(&"pkey_key", "")))


func _on_second() -> void:
	_route(String(_second.get_meta(&"pkey_key", "")))


func _on_link() -> void:
	_route(String(_link.get_meta(&"pkey_key", "")))


func _on_link2() -> void:
	_route(String(_link2.get_meta(&"pkey_key", "")))


func _route(key: String) -> void:
	# An account sign-in is starting: only Cancel is live.
	if working and key != "common.cancel":
		return
	match key:
		"common.continue":
			_on_continue()
		"common.tryAgain":
			retry_pressed.emit()
		"common.cancel":
			cancelled.emit()
		"signin.handoff.again", "activate.attach.reopen", "signin.handoff.openBrowser":
			reopen_pressed.emit()
		"signin.done.start", "common.done":
			start_pressed.emit()
		"signin.key.ownedSignIn", "signin.auto.confirm.other":
			sign_in_pressed.emit()
		"activate.otherEmail.verify":
			verify_pressed.emit()


# ── Focus ────────────────────────────────────────────────────────────────────────────────

func _initial_focus() -> Control:
	match String(model.get("state", "")):
		"busy":
			# The wait has no focus of its own.
			return null
		"form", "invalid":
			# The first wrong field, else Name: always in view at the top of the card. A pad goes to
			# Continue (it cannot type). A phone gets no automatic focus after a touch, so no
			# keyboard opens by itself.
			if pad_only():
				return _primary
			if step == "invalid" and field == "email":
				return _email_input
			return _name_input if is_focusable(_name_input) else _primary
		"waiting":
			return _waiting_focus()
	return _primary if is_focusable(_primary) else null


## The forward action of the wait is to open Polaris Locker again, never Cancel. A TV has no browser to
## open, so the wait is passive: Cancel is then the one control.
func _waiting_focus() -> Control:
	if is_focusable(_second):
		return _second
	return _link if pad_only() and is_focusable(_link) else null


## A busy card takes no focus by itself (the base class would fall back to the first control, which
## is the way out of the wait).
func ensure_focus(force := false) -> bool:
	if String(model.get("state", "")) == "busy" and not _has_focus_inside():
		return false
	return super(force)


func _focus_chain() -> Array:
	return [_name_input, _email_input, _primary, _second, _link, _link2]


## Escape (or a pad's B): leaves a form with nothing in flight; while a sign-in runs or waits it does
## nothing, and never cancels it. Cancel is a button.
func _cancel() -> bool:
	if not visible:
		return false
	match String(model.get("state", "")):
		"form", "invalid", "failed", "owned":
			cancelled.emit()
			return true
		"busy", "waiting":
			return true
		"added":
			# Nothing is in flight: Back goes on, as Start using does.
			start_pressed.emit()
			return true
	return false
