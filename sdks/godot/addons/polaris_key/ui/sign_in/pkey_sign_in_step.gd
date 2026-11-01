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
## nearby-wait: the person chose one of the devices that answered (`approvers`).
signal approver_chosen(approver_id: String)

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
## The https page Replace opens on the device-limit step; empty names the fix in words instead.
@export var manage_url := "":
	set(value):
		manage_url = value
		refresh_view()
## The provider's name, or "" for the default.
@export var provider := "":
	set(value):
		provider = value
		refresh_view()
## The licence the consent anchors, for the confirm step's licence line: `{name, tierName, term, position,
## limit}` (`PKeyGateController.consent_step().anchor`; term is "perpetual" or the end as epoch seconds,
## position and limit the seat this device takes). {} when the consent names none.
var anchor: Dictionary = {}:
	set(value):
		anchor = value
		refresh_view()
## Continue is in flight: more presses are ignored and the thin indicator shows.
var busy := false:
	set(value):
		busy = value
		refresh_view()
## A catalog key whose line shows under the licence lines in the error colour ("" for none): Continue
## failed and the grant is still good, so Continue tries again.
var error_key := "":
	set(value):
		error_key = value
		refresh_view()

## nearby-wait: the devices that answered, `[{id, label (String or null), platform}]`, until one is chosen
## (each is a button; a pad reaches them in order). Empty once a code shows.
var approvers: Array = []:
	set(value):
		approvers = value
		refresh_view()
## nearby-done: the sign-in is held for the person's confirmation. The title leads with the active mark
## (`◆ Signed in as ...`): the account is not theirs yet.
var pending := false:
	set(value):
		pending = value
		refresh_view()

var model: Dictionary = {}


var _body: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _lede: Label
var _lines: Array = []
## The confirm step's two labelled groups (SIGN-IN §3.19): the licence, and what the app also gets.
var _license_group: VBoxContainer
var _license_label: Label
var _license_value: Label
var _gets_group: VBoxContainer
var _gets_label: Label
var _gets_profile: Label
var _gets_pairwise: Label
var _error: Label
## nearby-wait: the code to tap on the approving device, and the devices to choose from.
var _code_label: Label
var _approver_box: VBoxContainer
var _approver_buttons: Array = []
var _approver_sig := ""
## The device limit's QR code for a device with only a pad (no browser to open).
var _qr: PKeyQrRect
var _qr_caption: Label
var _qr_box: VBoxContainer
var _actions: BoxContainer
var _spacer: Control
var _primary: Button
var _secondary: Button
var _secondary2: Button


func _build() -> void:
	name = "PKeySignInStep"
	# The largest gap sits between the body and the actions; groups are one step apart; a title and its
	# subtitle sit together (SIGN-IN §3.19 rule 4).
	_body = vbox(card_panel(), "Body", "PKeySections")
	var top := vbox(_body, "Top", "PKeyStack")
	_product = product_header(top, "Product")
	_product.card = true
	var words := vbox(top, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_lede = label(words, "Lede", "PKeyMuted")
	# An address breaks at its "@" and "." (soft breaks), and only past those anywhere.
	_lede.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	for i in 7:
		_lines.append(label(words, "Line%d" % i, "PKeyMuted"))
	_license_group = vbox(top, "LicenseGroup", "PKeyTight")
	_license_label = label(_license_group, "LicenseLabel", "PKeyMuted")
	_license_value = label(_license_group, "LicenseLine", "PKeyStrong")
	_gets_group = vbox(top, "AlsoGets", "PKeyTight")
	_gets_label = label(_gets_group, "AlsoGetsLabel", "PKeyMuted")
	_gets_profile = label(_gets_group, "Profile")
	_gets_pairwise = label(_gets_group, "Pairwise", "PKeyMuted")
	_error = label(top, "Error", "PKeyError")
	_approver_box = vbox(top, "Approvers", "PKeyTight")
	_code_label = label(top, "NearbyCode", "PKeyCode", true)
	_code_label.autowrap_mode = TextServer.AUTOWRAP_OFF
	_qr_box = vbox(top, "Remedy", "PKeyTight")
	_qr = qr_tile(_qr_box)
	_qr.get_parent().size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_qr_caption = label(_qr_box, "RemedyCaption", "PKeyMuted")
	loading_bar(_body)
	_spacer = spacer(_body)
	_actions = actions_row(_body, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_primary = button(_actions, "Primary", func() -> void: _on_primary(), "PKeyPrimary")
	_secondary = button(_actions, "Secondary", func() -> void: secondary_pressed.emit(step), "PKeyLink")
	_secondary2 = button(_actions, "Secondary2", func() -> void: secondary_pressed.emit(step), "PKeyLink")
	for b in [_primary, _secondary, _secondary2]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


## Continue (or the step's primary) was pressed: ignored while one is in flight.
func _on_primary() -> void:
	if busy:
		return
	primary_pressed.emit(step)


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
	if _qr != null:
		var q := qr_side(content_room().y * 0.4)
		if squeeze_level() >= 1:
			q = maxf(roundf(q * 0.7), QR_MIN_PHYSICAL / float(m["physical"]))
		_qr.custom_minimum_size = Vector2(q, q)


func _screen_key() -> String:
	return step


## This device as a phrase inside a sentence ("this Mac"), from the platform's form factor.
static func this_device() -> String:
	var form: String = PKeyDevicesController.FORM_FACTORS.get(PKeyHeaders.update_platform(), "other")
	return String(catalog().format("part.thisDevice", {"formFactor": form}))


## The licence's term in words: "Lifetime", or "Until 2027-01-01".
static func term_text(term: Variant) -> String:
	if term is String and term == "perpetual":
		return String(catalog().format("signin.term.lifetime"))
	if PKeyClaims.is_number(term):
		return String(catalog().format("signin.term.until", {"date": PKeyLicenseChoiceController.date_text(float(term))}))
	return ""


## An address that may break after its "@" and "." (zero-width spaces), never in the middle of a word
## unless it has to.
static func soft_breaks(text: String) -> String:
	return text.replace("@", "@\u200b").replace(".", ".\u200b")


## What the licence line needs, as the catalog args, or {} when a part is unknown (a line missing an
## argument is left out, never drawn with a placeholder: SIGN-IN §3.19 rule 3).
func _license_args() -> Dictionary:
	var term := term_text(anchor.get("term"))
	var position := int(anchor.get("position", 0)) if PKeyClaims.is_number(anchor.get("position")) else 0
	var limit := int(anchor.get("limit", 0)) if PKeyClaims.is_number(anchor.get("limit")) else 0
	var name_text := String(anchor.get("name", "")) if anchor.get("name") is String else ""
	if name_text == "" or term == "" or position < 1 or limit < 1:
		return {}
	return {"license": PKeyUiTheme.isolate(name_text), "term": term, "device": this_device(), "position": str(position), "limit": str(limit)}


func _render() -> void:
	var license_args := _license_args() if license_line == "existing" else {}
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
	if license_line == "new" or (license_line == "existing" and not license_args.is_empty()):
		auto["license"] = license_line
	if also_gets:
		auto["alsoGets"] = true
	if code != "":
		auto["code"] = code
	if manage_url != "":
		auto["manageUrl"] = manage_url
	var tier_name := tier if tier != "" else (String(anchor.get("tierName", "")) if anchor.get("tierName") is String else "")
	if tier_name != "":
		inp["account"] = {"tier": tier_name}
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("SignIn", inp)
	var id := PKeyUiTheme.product_identity()
	var app := PKeyUiTheme.isolate(String(id["name"]))
	var args := {
		"app": app,
		"product": app,
		"developer": PKeyUiTheme.isolate(developer),
		"email": PKeyUiTheme.isolate(soft_breaks(email)),
		"provider": PKeyUiTheme.isolate(provider if provider != "" else PKeyConstants.SIGN_IN_PROVIDER_NAME),
		"tier": PKeyUiTheme.isolate(tier_name),
		"code": code,
	}
	args.merge(license_args, true)
	_product.refresh()
	var row: Array = LAYOUT.get(step, LAYOUT["nearby-done"])
	# The copy the model names is the copy drawn: each body line is one the model chose.
	var copy: Array = model.get("copy", [])
	var level := squeeze_level()
	cat_text(_title, row[0], args)
	var confirm := step == "confirm"
	if confirm:
		_render_confirm(copy, args, tier_name != "", level)
		for l in _lines:
			cat_text(l, "", args)
	else:
		_render_plain(copy, row, args)
		_license_group.visible = false
		_gets_group.visible = false
		cat_text(_lede, "", args)
	_render_nearby(args)
	# Continue failed: its own line in the error colour, with Continue as the retry.
	if error_key != "" and confirm:
		cat_text(_error, error_key)
	else:
		cat_text(_error, "")
	# The primary: the model's, except a device limit the person cannot fix here (no link, or no browser
	# on a pad), where it is Try again: the sign-in runs once more.
	var primary_key := String(model["decisions"].get("primary") if model.get("decisions") != null and model["decisions"].get("primary") != null else "")
	var limit_qr := step == "device-limit" and pad_only() and primary_key != ""
	var limit_retry := step == "device-limit" and (primary_key == "" or limit_qr)
	if limit_retry:
		_primary.set_meta(DATA_META, true)
		_primary.remove_meta(CATALOG_META)
		show_text(_primary, c().text("retry"))
		leaves_app(_primary, false)
	else:
		_primary.remove_meta(DATA_META)
		cat_text(_primary, primary_key, args)
		# Replace opens the browser: the new-window glyph (SIGN-IN §3.19).
		leaves_app(_primary, step == "device-limit" and primary_key != "")
	# The QR code for the page Replace opens, on a device with only a pad.
	var link_ok := limit_qr and manage_url != ""
	_qr.text = manage_url if link_ok else ""
	_qr.visible = link_ok and not _qr.encode_failed
	_qr.get_parent().visible = _qr.visible
	cat_text(_qr_caption, "deviceLimit.scan" if _qr.visible else "")
	_qr_box.visible = _qr.visible
	var sec: Array = row[2].duplicate()
	if step == "device-limit" and outer_view() != self:
		# Nested in the gate, whose Welcome is the sign-in form: "Use another account" already goes there.
		sec.erase("common.cancel")
	cat_text(_secondary, sec[0] if sec.size() > 0 else "", args)
	cat_text(_secondary2, sec[1] if sec.size() > 1 else "", args)
	# The wait for the other device shows the thin indicator, never a spinner in the title.
	set_loading(step == "nearby-wait" or busy)
	set_process(step == "nearby-wait" or busy)


## nearby-wait: the devices that answered (until one is chosen), then the code to tap there. nearby-done: the
## title leads with the active mark while the sign-in is held. Nothing else shows these.
func _render_nearby(args: Dictionary) -> void:
	var waiting := step == "nearby-wait"
	var choosing := waiting and code == "" and not approvers.is_empty()
	# The "tap this code" line belongs to a code that is on screen.
	if waiting and code == "" and _lines.size() > 1:
		cat_text(_lines[1], "", args)
	_approver_box.visible = choosing
	# The rows are rebuilt only when the list changes, so a focused row keeps the focus through a redraw.
	var sig := JSON.stringify(approvers) if choosing else ""
	if sig != _approver_sig:
		_approver_sig = sig
		for b: Button in _approver_buttons:
			b.queue_free()
		_approver_buttons.clear()
	if choosing and _approver_buttons.is_empty():
		for a: Dictionary in approvers:
			var id := String(a.get("id", ""))
			var device := String(a["label"]) if a.get("label") is String and a["label"] != "" else String(a.get("platform", ""))
			var b := button(_approver_box, "Approver%d" % _approver_buttons.size(), func() -> void: approver_chosen.emit(id))
			b.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			cat_text(b, "signin.nearby.bodyOn", {"app": args["app"], "device": PKeyUiTheme.isolate(device)})
			_approver_buttons.append(b)
	_code_label.visible = waiting and code != ""
	_code_label.text = code if waiting and code != "" else ""
	if step == "nearby-done" and pending and _title.visible:
		_title.text = "\u25c6 " + _title.text


## The plain steps: the title, then the model's body lines in order.
func _render_plain(copy: Array, row: Array, args: Dictionary) -> void:
	var lines: Array = (row[1] as Array).filter(func(k): return copy.has(k))
	for i in _lines.size():
		cat_text(_lines[i], lines[i] if i < lines.size() else "", args)


## The confirm step (SIGN-IN §3.19): the account as the title's subtitle; "License for this device"
## over the strong licence line; "{app} will also get" over the profile and the pairwise line. A label
## draws only with its value, and a line missing an argument is not drawn.
func _render_confirm(copy: Array, args: Dictionary, tier_known: bool, level: int) -> void:
	cat_text(_lede, "signin.auto.confirm.as" if copy.has("signin.auto.confirm.as") else ("signin.auto.confirm.asApple" if copy.has("signin.auto.confirm.asApple") else ""), args)
	var value := ""
	if copy.has("signin.consent.licenseLine"):
		value = "signin.consent.licenseLine"
	elif copy.has("signin.consent.newLicense"):
		# No tier is known for a licence that does not exist yet: the tier-less line, never an empty argument.
		value = "signin.consent.newLicense" if tier_known else "signin.choice.metaNew"
	var has_value := value != "" and copy.has("signin.consent.license")
	_license_group.visible = has_value
	cat_text(_license_label, "signin.consent.license" if has_value else "", args)
	cat_text(_license_value, value if has_value else "", args)
	var gets := copy.has("signin.consent.alsoGets") and level < 3
	_gets_group.visible = gets
	cat_text(_gets_label, "signin.consent.alsoGets" if gets else "", args)
	cat_text(_gets_profile, "signin.consent.profile" if gets and copy.has("signin.consent.profile") else "", args)
	# Secondary lines give way before the actions scroll (DL3).
	cat_text(_gets_pairwise, "signin.consent.pairwise" if gets and copy.has("signin.consent.pairwise") and level < 2 else "", args)


func _initial_focus() -> Control:
	for b: Button in _approver_buttons:
		if is_instance_valid(b) and not b.is_queued_for_deletion() and is_focusable(b):
			return b
	if is_focusable(_primary):
		return _primary
	return _secondary if is_focusable(_secondary) else null


func _focus_chain() -> Array:
	var out: Array = _approver_buttons.filter(func(b): return is_instance_valid(b) and not b.is_queued_for_deletion())
	out.append_array([_primary, _secondary, _secondary2])
	return out


func _process(_delta: float) -> void:
	_tick_loading()
