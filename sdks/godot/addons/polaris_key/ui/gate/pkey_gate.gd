class_name PKeyGateView
extends PKeyUiView
## The licence gate as a full-screen scene (PKeyGateController mirrors React's `screenFor`):
## ok and not-applicable hide the gate and emit `usable`; grace emits `usable` and shows only a
## PKeyStatusBanner strip (or blocks with Retry when `allow_grace` is false); needs-activation
## shows PKeyActivationPanel; revoked says the device was signed out and offers sign-in and
## activation again; expired offers Renew (only when the host can renew: `renew_url` is https, or
## `renew_requested` has a handler) and Use another license (key entry), never Try again;
## version-too-old says
## "update required" with the outlet's action when one is known; version-too-new and
## channel-not-entitled say the build is not available on this licence.
##
## With `sdk` it follows PolarisKey.state_changed. Retry runs `sdk.sync(true)` itself unless
## `managed_retry` is set (PKeyBoot sets it and sends the machine's `retry` instead).
## `show_state()` drives it without an SDK (snapshots).
##
## Layout (PKeyUiView): one card, centred, led by the product's identity (UI-KITS.md §1.2). With
## the activation form on a wide panel (landscape, 680 layout px or more, aspect 1.5 or more) the
## card is wide with two panes, the product as the title on a sunken pane beside the form; a
## message screen is one column; sign-in and offline activation take the whole card in their own
## layouts; on a phone the card is the screen, content on top and actions at the bottom.
##
## One state per screen, each message beside what it is about: a rejected key is an inline error
## under the key field (`show_state(status, error)`); only a network failure (`network_error`) is a
## card of its own, with a warning glyph and Try again (and Continue offline, `can_continue_offline`,
## when a lease allows it).

## The licence lets the game run (ok, grace, not-applicable).
signal usable()
## The player asked to retry (always emitted; acted on here unless `managed_retry`).
signal retry_requested()
## The player chose Continue offline on a network-failure card.
signal continue_offline_requested()
## The player chose Renew and the game handles it (no `renew_url`, or besides it).
signal renew_requested()
## The player chose a license on the license-choice screen: `{kind, id}` (PKeyLicenseChoice.chosen).
signal license_chosen(selection: Dictionary)
## The automatic sign-in the gate started at boot finished (`auto_sign_in`): the ladder's answer.
signal auto_sign_in_finished(result: PKeyAutoSignInResult)

## Let `grace` pass (React's `allowGrace`).
@export var allow_grace := true
## Offer "Continue free" on the activation panel.
@export var offer_enrollment := false:
	set(value):
		offer_enrollment = value
		if activation != null:
			activation.offer_enrollment = value
## Sign-in stops at "Is this you?" before handing back (PKeyActivationPanel.confirm_identity).
@export var confirm_identity := false:
	set(value):
		confirm_identity = value
		if activation != null:
			activation.confirm_identity = value
## The release page a direct build opens on "update required" (see PKeyUpdatePromptController).
@export var release_url := ""
## Where an expired license renews. Only an https URL counts: Renew opens it, then the license is
## re-read. A game that renews itself connects `renew_requested` instead.
@export var renew_url := ""
## Run PolarisKey.identity.auto_sign_in() once, the first time the gate shows the sign-in form: the
## silent rungs only (the platform's own account sheet is the form's button). A confirm shows the
## consent step, a licence choice the choice screen, a full licence its own step; anything else leaves
## the form as it is. false turns it off (Q-12), and `start_auto_sign_in()` runs it by hand.
@export var auto_sign_in := true
## Retry emits `retry_requested` only; the owner decides (PKeyBoot).
var managed_retry := false
## Owned by another scene (PKeyBoot): the owner feeds `show_state()` and decides visibility.
var embedded := false

var status: Dictionary = {}
var loading := true
## A message the caller already worded for a rejected key or a failed sign-in: shown under the key
## field, never as a card.
var error := ""
## The error is a network failure (the gate could not check the licence): a card of its own.
var network_error := false
## A lease allows playing offline: the network-failure card offers Continue offline.
var can_continue_offline := false
## The update answer behind "update required"'s action (PolarisKey.update.update_available).
var update_result: PKeyResult = null
## Override the build's outlet ("" reads PolarisKey.build_info()).
var outlet := ""
var screen := "loading"

var activation: PKeyActivationPanel
## A sign-in that found several licenses asks which this device uses: the gate's license-choice
## screen (`show_license_choice()`).
var license_choice: PKeyLicenseChoice
var choosing := false
## Automatic sign-in's own steps (confirm, device-limit), drawn in the form's place.
var auto_step: PKeySignInStep
var banner: PKeyStatusBanner
var _card: PanelContainer
var _split: BoxContainer
var _pane: PanelContainer
var _aside: VBoxContainer
var _head: VBoxContainer
var _main: VBoxContainer
var _product: PKeyProductHeader
var _glyph: TextureRect
var _title: Label
var _body: Label
var _detail: Label
## The form's lede on a phone, where the product heads the page and the form docks to the bottom.
var _lede: Label
var _update: Button
var _retry: Button
var _offline_btn: Button
var _renew: Button
var _other: Button
## Expired: the player chose Use another license, so key entry shows.
var _keying := false
var _actions: BoxContainer
var _spacer: Control
var _banner_slot: MarginContainer
var _center: CenterContainer
var _bound := false
var _was_usable := false
var _retrying := false
var _auto_started := false
## "" | "confirm" | "choose" | "device-limit": which automatic sign-in answer the gate is showing.
var _auto_state := ""
var _auto_result: PKeyAutoSignInResult = null
## The silent rungs are running: a quiet thin indicator shows (after 250 ms, for at most 1.5 s).
var _auto_running := false
var _auto_bar := true
## Replace a device opened the browser: the sign-in runs once more when the person is back.
var _replacing := false
## Continue (or a choice) is in flight: more presses are ignored.
var _completing := false
## A sign-in this device started finished and the link offer is being asked for or shown: the gate holds
## (the game does not run under the offer) until it is answered.
var _link_hold := false
## The offer is being closed: the step stays (busy) until the licence state is read again.
var _link_finishing := false
## The offer entry on screen ({kind, reach}) and how its last try failed ("", stale, refused, network).
var _link_entry: Dictionary = {}
var _link_problem := ""
## Sign in again (a stale offer) is running: the hold and the handle stay, and the offer returns when it ends.
var _link_resign := false
## The link offer's flow (PKeyGateLink).
var _link_flow := PKeyGateLink.new(self)
## After "Use another account" the focus goes to Polaris Locker's sign-in, not the key field.
var _focus_sign_in := false


func _process(_delta: float) -> void:
	_tick_loading()
	# The check is taking long enough to show: the card (identity, label, shimmer) appears now.
	if screen == "loading" and not _card.visible and _loading_due():
		refresh_view()


## DL7: a wait shows nothing for its first 250 ms.
func _loading_due() -> bool:
	return _loading_since > 0 and Time.get_ticks_msec() - _loading_since >= 250


func _bleeds() -> bool:
	return true


## A gate over the game holds the input; one embedded in the boot is the boot's to report.
func _captures_input() -> bool:
	return true


func _on_child_copied() -> void:
	if sdk != null and is_instance_valid(sdk) and sdk.has_method("toasts"):
		sdk.toasts().show_copied()


## "Signed in as <name>" and the tier, as a toast that outlives the gate (the shared toast host).
func _on_signed_in(r: PKeySignInOutcome) -> void:
	if not r.ok or sdk == null or not is_instance_valid(sdk) or not sdk.has_method("toasts"):
		return
	var t := c()
	var facts := PKeyAccountController.facts(sdk)
	var who := String(r.identity.get("name", r.identity.get("email", ""))) if r.identity is Dictionary else ""
	if who == "":
		who = String(facts["holder"])
	var tier := String(facts["tier"])
	who = toast_name(who)
	if who != "" and tier != "":
		# One catalog line, "Signed in as {name} · {tier} license", so no kit joins two with a separator.
		sdk.toasts().show_success(String(catalog().format("signin.desktop.toast", {"name": PKeyUiTheme.isolate(who), "tier": PKeyUiTheme.isolate(tier)})))
		return
	sdk.toasts().show_success(t.text("account_holder", PKeyUiTheme.isolate(who)) if who != "" else t.text("sign_in_ok"), t.text("account_tier", PKeyUiTheme.isolate(tier)) if tier != "" else "")


## A name for a toast's one line: long ones (an email, a double-barrelled surname) end in an ellipsis
## rather than breaking a word across lines.
static func toast_name(name: String) -> String:
	return name if name.length() <= 20 else name.left(19) + "\u2026"


## The gate squeezes for the dialog it holds (sign-in, offline activation, the device limit).
func squeeze_max() -> int:
	return 4


func _build() -> void:
	name = "PKeyGate"
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_center = CenterContainer.new()
	_center.name = "Center"
	add_child(_center)
	_card = PanelContainer.new()
	_card.name = "Card"
	_card.theme_type_variation = "PKeyCard"
	_center.add_child(_card)
	_card_box = _card
	var box := vbox(scroll_area(_card), "Body", "PKeySections")
	loading_bar(box)
	_split = columns(box, "Split")
	_pane = PanelContainer.new()
	_pane.name = "Pane"
	_pane.theme_type_variation = "PKeyRail"
	_pane.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_pane.size_flags_stretch_ratio = 0.8
	_split.add_child(_pane)
	_aside = vbox(_pane, "Aside", "PKeyStack")
	_aside.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_product = product_header(_aside, "Product", true)
	_head = vbox(_aside, "Head", "PKeyTight")
	_glyph = glyph_node(_head, "Glyph", "warning")
	_title = label(_head, "Title", "PKeyTitle")
	_body = label(_head, "Message", "PKeyMuted")
	_detail = label(_head, "Detail", "PKeyMuted")
	_lede = label(_head, "Lede", "PKeyMuted")
	_lede.visible = false
	_main = vbox(_split, "Form", "PKeySections")
	_main.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_main.size_flags_vertical = Control.SIZE_EXPAND_FILL
	activation = PKeyActivationPanel.new()
	activation.auto_sdk = false
	activation.confirm_identity = confirm_identity
	activation.show_product = false
	activation.activated.connect(_on_activated)
	activation.sign_in_dialog.finished.connect(_on_signed_in)
	activation.sign_in_dialog.platform_answer.connect(_on_platform_answer)
	# Sign-in and offline activation take the whole card: the gate re-renders around them.
	activation.mode_changed.connect(func(m: String) -> void:
		_focus_sign_in = false
		refresh_view()
		if m == "main" and _link_resign:
			_link_flow.resign_ended.call_deferred())
	_main.add_child(activation)
	license_choice = PKeyLicenseChoice.new()
	license_choice.auto_sdk = false
	license_choice.show_product = false
	license_choice.visible = false
	license_choice.chosen.connect(func(selection: Dictionary) -> void: license_chosen.emit(selection))
	license_choice.chosen.connect(_on_auto_license_chosen)
	license_choice.replace_requested.connect(_on_auto_replace_requested)
	license_choice.replace_confirmed.connect(_on_auto_replace_confirmed)
	license_choice.other_account_requested.connect(_on_auto_other_account)
	license_choice.key_requested.connect(_on_auto_other_account)
	_main.add_child(license_choice)
	auto_step = PKeySignInStep.new()
	auto_step.visible = false
	auto_step.primary_pressed.connect(_on_auto_primary)
	auto_step.secondary_pressed.connect(_on_auto_secondary)
	_main.add_child(auto_step)
	_spacer = spacer(_main)
	_actions = actions_row(_main, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_update = button(_actions, "UpdateAction", _on_update, "PKeyPrimary")
	_renew = button(_actions, "Renew", _on_renew, "PKeyPrimary")
	# Renew reads the shared catalog (`status.renew`), not PKeyUiCopy: the copy test treats it as data.
	_renew.set_meta(PKeyUiView.DATA_META, true)
	_other = button(_actions, "UseAnotherLicense", _on_use_another)
	_retry = button(_actions, "Retry", _on_retry, "PKeyPrimary")
	_offline_btn = button(_actions, "ContinueOffline", _on_continue_offline)
	_banner_slot = MarginContainer.new()
	_banner_slot.name = "BannerSlot"
	_banner_slot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_banner_slot.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	# The gate is a Container, which ignores a child's anchors: the slot asks for its own height
	# only, at the top, so grace shows a strip and never covers the game.
	_banner_slot.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	add_child(_banner_slot)
	banner = PKeyStatusBanner.new()
	banner.auto_sdk = false
	_banner_slot.add_child(banner)


## Two panes: the product on its own pane beside the activation form, on a wide panel, with the
## form on screen (not a dialog inside it, not a full license, not a network failure).
func _two_panes() -> bool:
	return activation.visible and activation.mode == "main" and not activation.in_limit_view() and bool(layout_metrics().get("wide", false)) and not phone_bleed()


## The activation panel's own sub-screens (sign-in, offline activation, a full license) lead with
## their own header: the gate's pane gives way.
func _activation_owns_screen() -> bool:
	return _auto_on() or (activation.visible and (activation.mode != "main" or activation.in_limit_view()))


## An automatic sign-in step (confirm, device-limit) is on screen in the form's place.
func _auto_on() -> bool:
	return _auto_state == "confirm" or _auto_state == "device-limit" or _auto_state in PKeyGateController.LINK_STEPS or _holding()


## The offer is being asked for and no step is on screen: the busy "Finishing sign-in" card stands in, so the
## finished sign-in dialog (and its Close) never shows under the hold.
func _holding() -> bool:
	return _link_hold and _auto_state == "" and not _link_resign


## The link offer holds the gate (being asked for, or one of its steps on screen).
func _linking() -> bool:
	return _link_hold or _auto_state in PKeyGateController.LINK_STEPS


## The card's content width (logical pixels): what the activation panel wants while a dialog of
## it shows, two panes' worth, or one column.
func _content_wanted() -> float:
	if _auto_on():
		return role("card_width") - 2.0 * role("card_padding")
	if _activation_owns_screen():
		return activation.preferred_width()
	if _two_panes():
		return role("card_width_wide") - 2.0 * role("card_padding")
	return role("card_width") - 2.0 * role("card_padding")


func _apply_width(_width: float) -> void:
	if side_bleed():
		var side_room := content_room()
		_card.custom_minimum_size = Vector2(maxf(side_room.x - card_padding_x(), 0.0), 0.0)
		return
	if phone_bleed():
		var room := content_room()
		_card.custom_minimum_size = Vector2(maxf(room.x - card_padding_x(), 0.0), room.y)
		return
	_card.custom_minimum_size = Vector2(card_width(_content_wanted() + side_padding(_card)), 0.0)


func _arrange(m: Dictionary) -> void:
	var two := _two_panes()
	var bleed := phone_bleed()
	set_columns(_split, two)
	_split.size_flags_vertical = Control.SIZE_EXPAND_FILL if bleed else Control.SIZE_FILL
	# DL1: the passport pane holds the product and nothing else; a refusal's title and message lead
	# the end pane, above the form it concerns. In one column they sit under the product.
	# (Deferred: a child's _ready can ask for this layout while the form is still setting up its
	# children, and a node cannot move out of a parent that is busy.)
	# Squeezed, the title goes back under the product: the end pane then holds the form alone
	# (DL3: decoration and secondary lines give way before the form scrolls).
	var head_in_end := two and squeeze_level() == 0
	var head_home: Node = _main if head_in_end else _aside
	if _head.get_parent() != head_home:
		_move_head.call_deferred(head_in_end)
	_pane.visible = (_product.visible or (_head.visible and not head_in_end)) and not _activation_owns_screen()
	# The last squeeze step drops the secondary line (the version range, say) before any scrolling.
	_detail.visible = _detail.text != "" and squeeze_level() < 3
	if two:
		if _pane.has_theme_stylebox_override("panel"):
			_pane.remove_theme_stylebox_override("panel")
	elif not _pane.has_theme_stylebox_override("panel"):
		_pane.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	# On a phone the activation form docks to the bottom of the page, the primary on top, under the
	# product and the form's lede at the top (DL1: full-bleed, top-aligned, actions docked).
	var docked_form: bool = bleed and activation.visible and not _activation_owns_screen()
	# The product names the screen when it has the pane, and heads a phone's page; otherwise a
	# leading header over the title.
	_product.hero = two or docked_form
	_product.as_title = two or docked_form
	_product.centered = two
	show_text(_lede, activation.lede_text() if docked_form and squeeze_level() < 3 else "")
	_aside.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var lead := HORIZONTAL_ALIGNMENT_CENTER if _glyph.visible else _title_start
	_title.horizontal_alignment = lead
	_body.horizontal_alignment = lead
	_detail.horizontal_alignment = lead
	_lede.horizontal_alignment = lead
	size_glyph(_glyph, 40.0, get_theme_color("font_color", "PKeyWarning"))
	_split.alignment = BoxContainer.ALIGNMENT_BEGIN
	_main.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_main.alignment = BoxContainer.ALIGNMENT_END if docked_form else BoxContainer.ALIGNMENT_BEGIN
	# A message docks its own actions to the bottom.
	_spacer.visible = bleed and not _activation_owns_screen() and not docked_form
	# A dialog the gate holds fills the page on a phone, docking its own actions to the bottom.
	activation.size_flags_vertical = Control.SIZE_EXPAND_FILL if bleed and _activation_owns_screen() else Control.SIZE_FILL
	# ... and so does an automatic sign-in step: its actions dock to the bottom like the other gate screens.
	auto_step.size_flags_vertical = Control.SIZE_EXPAND_FILL if bleed and _auto_on() else Control.SIZE_FILL
	if bleed or side_bleed():
		_card.theme_type_variation = &""
		if not _card.has_theme_stylebox_override("panel"):
			_card.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	else:
		if _card.has_theme_stylebox_override("panel"):
			_card.remove_theme_stylebox_override("panel")
		_card.theme_type_variation = &"PKeyCard"
	super(m)
	fit_scrolls(available_height(), outer_view() == self or embedded)


## Move the refusal's title and message between the passport pane's column and the end pane.
func _move_head(two: bool) -> void:
	if not is_inside_tree() or _head.get_parent() == null:
		return
	place(_head, _main if two else _aside, 0 if two else -1)
	queue_layout()


## A label's own start alignment (mirrored with the layout direction).
var _title_start: HorizontalAlignment


func _ready() -> void:
	super()
	_title_start = _title.horizontal_alignment
	activation.sdk = sdk
	license_choice.sdk = sdk
	banner.sdk = sdk
	if sdk != null and not _bound and not embedded and sdk.has_signal("state_changed"):
		_bound = true
		sdk.state_changed.connect(func(s: Dictionary): show_state(s))
		if sdk.get("update") != null:
			sdk.update.update_available.connect(_on_update_available)
		if sdk.get("core") != null and sdk.core.started:
			show_state(sdk.status())


## Render a licence state ({status, grace_until?, last_verified_at?, allowed_range?}).
func show_state(s: Dictionary, p_error := "") -> void:
	if String(s.get("status", "")) != "expired":
		_keying = false
	status = s
	loading = false
	error = p_error
	refresh_view()


func show_loading() -> void:
	loading = true
	refresh_view()


## A sign-in found several licenses: ask which this device uses (PKeyLicenseChoice's `show_choices()`
## view). The screen holds until `end_license_choice()`; `license_chosen` carries the answer.
func show_license_choice(view: Dictionary, pick := "") -> void:
	choosing = true
	loading = false
	license_choice.show_choices(view, pick)
	refresh_view()


func end_license_choice() -> void:
	choosing = false
	refresh_view()


func _outlet() -> String:
	if outlet != "":
		return outlet
	if sdk != null and sdk.has_method("build_info"):
		var o = sdk.build_info().get("outlet")
		return o if o is String else ""
	return ""


func _product_name() -> String:
	return String(PKeyUiTheme.product_identity()["name"])


## `key`'s text, with the product's name where its template asks for one.
func _tr_product(t: PKeyUiCopy, key: String) -> String:
	return t.text(key, _product_name()) if t.template(key).contains("%s") else t.text(key)


func _screen_key() -> String:
	return "%s|%s|%s|%s|%s|%s" % [screen, activation.mode, "limit" if activation.in_limit_view() else "", "net" if network_error else "", "key" if _keying else "", _auto_state]


## An automatic sign-in step opens at its title, with its primary in the first viewport.
func _opens_at_top() -> bool:
	return _auto_on()


func _render() -> void:
	var t := c()
	var st := String(status.get("status", ""))
	screen = PKeyGateController.screen_for(st, loading, error, allow_grace, choosing)
	var url := PKeyUpdatePromptController.update_url(update_result, _outlet(), release_url)
	var ctl := PKeyGateController.controls_for(screen, url != "")
	var cp := PKeyGateController.copy_for(screen, st, status.get("allowed_range"))
	var is_usable := PKeyGateController.is_usable_screen(screen) and not _linking()
	var net := screen == "error" and network_error
	var inline := screen == "error" and not network_error
	if not embedded:
		visible = screen != "usable" or _linking()
	# Loading shows nothing for its first 250 ms, then the identity, a muted label and the shimmer
	# (DL7); a license check that finishes sooner never flashes a card.
	var waiting := screen == "loading"
	var ladder := _auto_running and _auto_bar
	set_loading(waiting or _retrying or ladder)
	_card.visible = not is_usable and not (waiting and not _loading_due())
	# Grace lets the game run: no backdrop, no input captured, only the banner strip.
	mouse_filter = Control.MOUSE_FILTER_IGNORE if is_usable else Control.MOUSE_FILTER_STOP
	# The full-rect CenterContainer would catch the game's clicks (a Container passes by default).
	_center.mouse_filter = Control.MOUSE_FILTER_IGNORE if is_usable else Control.MOUSE_FILTER_PASS
	self_modulate.a = 0.0 if is_usable else 1.0
	_banner_slot.visible = ctl["banner"]
	if ctl["banner"]:
		banner.show_state(status)
	_product.refresh()
	set_process(_retrying or waiting or ladder)
	# One state per screen: a rejected key is the activation form with its message inline.
	var title_key: String = cp["title"]
	var body_key: String = cp["body"]
	if net:
		title_key = "gate_error_title"
		body_key = "gate_error_body"
	elif inline:
		title_key = ""
		body_key = ""
	show_text(_title, _tr_product(t, title_key) if title_key != "" else "")
	show_text(_body, _tr_product(t, body_key) if body_key != "" else "")
	var detail = cp["detail"]
	var detail_text := ""
	if detail is Array:
		detail_text = t.text(detail[0], detail[1])
	elif screen == "not-available":
		var range_v = status.get("allowed_range")
		if st == "version-too-new" and range_v is Dictionary and range_v.get("max") is String and range_v["max"] != "":
			detail_text = t.text("not_available_max", range_v["max"])
	show_text(_detail, detail_text)
	_glyph.visible = net
	var expired_keying := screen == "expired" and _keying
	var wants_form: bool = (ctl["activation"] or expired_keying) and not net
	if _holding():
		auto_step.step = "finishing"
		auto_step.busy = true
	var auto_on := _auto_on()
	activation.visible = (wants_form or _link_resign) and not auto_on
	auto_step.visible = auto_on and not net
	license_choice.visible = screen == "license-choice"
	# A refusal's own title leads its screen; only the Welcome form says what to do.
	activation.show_lede = screen == "activation" or screen == "error"
	activation.form_title = t.text("use_another_license") if screen == "not-available" or expired_keying else ""
	if inline:
		if activation.message != error:
			activation.show_message(error)

	show_text(_update, t.text("status_update") if ctl["update_action"] else "")
	leaves_app(_update, ctl["update_action"] and PKeyUpdatePromptController.update_url(update_result, _outlet(), release_url) != "")
	# Expired: Renew when the host can renew (the primary), Use another license always; one primary.
	var expired_actions := screen == "expired" and not _keying
	var renew_on := expired_actions and can_renew()
	show_text(_renew, _catalog_text("status.renew") if renew_on else "")
	leaves_app(_renew, renew_on and _renew_target() != "")
	show_text(_other, t.text("use_another_license") if expired_actions else "")
	_other.theme_type_variation = &"" if renew_on else &"PKeyPrimary"
	var retry_on: bool = (ctl["retry"] and not inline)
	show_text(_retry, t.text("retry") if retry_on else "")
	# A lone action is the primary; beside the update action, or beside a way forward, Try again is not.
	_retry.theme_type_variation = &"PKeyPrimary" if (retry_on and not _update.visible and screen != "not-available") else &""
	show_text(_offline_btn, t.text("gate_continue_offline") if net and can_continue_offline else "")
	if is_usable and not _was_usable:
		_was_usable = true
		usable.emit.call_deferred()
	elif not is_usable:
		_was_usable = false
	_maybe_start_auto_sign_in()


func _focus_chain() -> Array:
	var out: Array = []
	if auto_step.visible:
		out.append_array(auto_step._focus_chain())
	if activation.visible:
		out.append_array(activation._focus_chain())
	if license_choice.visible:
		out.append_array(license_choice._focus_chain())
	out.append_array([_renew, _other, _update, _retry, _offline_btn])
	# Grace's strip (Reconnect, Dismiss) is part of this view's chain: a pad reaches it from here.
	if banner != null and banner.is_visible_in_tree():
		out.append_array(banner._focus_chain())
	return out


## Grace lets the game run: its strip never takes the focus from the game on its own; the first
## direction press while nothing is focused asks for it.
func ensure_focus(force := false) -> bool:
	if PKeyGateController.is_usable_screen(screen) and not force:
		return false
	return super(force)


## A stop card puts the focus on Try again (or the update action); the form on its first control,
## which on a pad-only device is Sign in.
func _initial_focus() -> Control:
	if _focus_sign_in and activation.visible and activation.mode == "main" and is_focusable(activation.locker_sign_in_button()):
		return activation.locker_sign_in_button()
	if auto_step.visible:
		return auto_step._initial_focus()
	if license_choice.visible:
		return license_choice._initial_focus()
	if activation.visible:
		return activation._initial_focus()
	for b in [_renew, _other, _update, _retry, _offline_btn]:
		if is_focusable(b):
			return b
	return null


func _on_update_available(r: PKeyResult) -> void:
	update_result = r
	refresh_view()


func _on_activated() -> void:
	_link_resign = false
	# A sign-in this device started (the browser) can end on the link offer; any other activation goes on.
	if await _link_flow.offer():
		return
	if sdk != null and sdk.has_method("status"):
		show_state(sdk.status())


func _on_update() -> void:
	var url := PKeyUpdatePromptController.update_url(update_result, _outlet(), release_url)
	if url != "":
		OS.shell_open(url)


## The renew URL when it is a usable https page, else "".
func _renew_target() -> String:
	var u := renew_url.strip_edges()
	return u if u.begins_with("https://") and u.length() > 8 and not u.contains(" ") else ""


## The host can renew: an https `renew_url`, or a handler on `renew_requested`.
func can_renew() -> bool:
	return _renew_target() != "" or not renew_requested.get_connections().is_empty()


## Text from the shared copy catalog (the model's `status.*` keys).
func _catalog_text(key: String) -> String:
	return String(catalog().format(key))


func _on_renew() -> void:
	renew_requested.emit()
	var url := _renew_target()
	if url == "":
		return
	OS.shell_open(url)
	# The player may have renewed in the browser: read the license again.
	if managed_retry:
		retry_requested.emit()
		return
	if sdk == null or not sdk.has_method("sync"):
		return
	_retrying = true
	refresh_view()
	await sdk.sync(true)
	_retrying = false
	show_state(sdk.status())


func _on_use_another() -> void:
	_keying = true
	refresh_view()
	ensure_focus(true)


func _on_continue_offline() -> void:
	continue_offline_requested.emit()


func _on_retry() -> void:
	retry_requested.emit()
	if managed_retry or sdk == null or not sdk.has_method("sync"):
		return
	# The card stays (and keeps the focus on Try again) with a thin indicator while the check runs:
	# swapping it for an empty loading screen would drop the focus.
	_retrying = true
	refresh_view()
	await sdk.sync(true)
	_retrying = false
	show_state(sdk.status())


func _cancel() -> bool:
	# The offer is being asked for, linked or closed: Escape and B change nothing.
	if _holding() or _link_finishing or (_completing and _auto_state in PKeyGateController.LINK_STEPS):
		return true
	if auto_step.visible and _auto_state in PKeyGateController.LINK_STEPS:
		# Escape on the offer closes it without remembering a decline.
		_link_flow.finish(false)
		return true
	if auto_step.visible:
		_leave_auto_sign_in()
		return true
	if license_choice.visible and license_choice._cancel():
		return true
	# The licence choice reached through automatic sign-in: Escape gives the grant up (the form returns).
	if _auto_state == "choose" and license_choice.visible:
		_leave_auto_sign_in()
		return true
	return activation.visible and activation._cancel()


# ── Automatic sign-in (I-48.9) ───────────────────────────────────────────────────────────────

func _notification(what: int) -> void:
	# Back from Replace a device in the browser: the provider sign-in runs once more (§3.19).
	if what == NOTIFICATION_APPLICATION_FOCUS_IN and _replacing and _auto_state == "device-limit":
		_replacing = false
		start_auto_sign_in(true)


func _maybe_start_auto_sign_in() -> void:
	if screen != "activation" or not auto_sign_in or _auto_started or not _can_auto_sign_in():
		return
	start_auto_sign_in.call_deferred()


func _can_auto_sign_in() -> bool:
	return sdk != null and is_instance_valid(sdk) and sdk.get("identity") != null and sdk.get("core") != null and sdk.core.started


## The person has started something of their own on the form: Sign in's dialog, an activation, a key
## typed. A late automatic answer never replaces it.
func _person_acted() -> bool:
	return activation.mode != "main" or activation.busy or activation.key_text() != ""


## Run the ladder's silent rungs now (once per gate unless `force`), install this runtime's platform
## providers first, and show the answer. A coroutine; `auto_sign_in_finished` carries the result.
## While it runs the gate shows a quiet thin indicator (after 250 ms, for 1.5 s at most); an answer that
## arrives after the person has started signing in by hand is dropped, and its grant given up.
func start_auto_sign_in(force := false) -> void:
	if (_auto_started and not force) or not _can_auto_sign_in():
		return
	_auto_started = true
	_auto_running = true
	_auto_bar = true
	auto_step.busy = _auto_on()
	refresh_view()
	get_tree().create_timer(1.5).timeout.connect(func() -> void:
		if _auto_running and is_instance_valid(self):
			_auto_bar = false
			refresh_view())
	PKeyPlatformProviders.install(sdk.identity)
	var result: PKeyAutoSignInResult = await sdk.identity.auto_sign_in()
	if not is_instance_valid(self):
		return
	_auto_running = false
	auto_step.busy = false
	if not _auto_on() and _person_acted() and PKeyGateController.auto_action(result) in ["confirm", "choose", "device-limit"]:
		_drop_auto(result)
		refresh_view()
		auto_sign_in_finished.emit(result)
		return
	await _apply_auto(result)
	refresh_view()
	auto_sign_in_finished.emit(result)


## Give an automatic answer's grant up without showing it.
func _drop_auto(result: PKeyAutoSignInResult) -> void:
	var grant := String(result.pending.get("grant", "")) if result != null else ""
	if grant != "" and sdk != null and is_instance_valid(sdk):
		sdk.identity.choice.cancel(grant)


func _apply_auto(result: PKeyAutoSignInResult) -> void:
	_auto_result = result
	match PKeyGateController.auto_action(result):
		"signed-in":
			_end_auto()
			await sdk.sync(true)
			show_state(sdk.status())
		"confirm":
			var consent: Dictionary = result.pending.get("consent", {}) if result.pending.get("consent") is Dictionary else {}
			var shown := PKeyGateController.consent_step(consent)
			auto_step.email = shown["email"]
			auto_step.exchange_kind = shown["kind"]
			auto_step.license_line = shown["license_line"]
			auto_step.anchor = shown["anchor"]
			auto_step.also_gets = shown["also_gets"]
			auto_step.error_key = ""
			auto_step.busy = false
			_show_auto("confirm")
		"choose":
			_auto_state = "choose"
			license_choice.other_account_link = true
			_focus_sign_in = false
			show_license_choice(result.pending.get("view", {}) if result.pending.get("view") is Dictionary else {})
			ensure_focus(true)
		"device-limit":
			auto_step.manage_url = PKeyGateController.manage_link(result)
			auto_step.busy = false
			_show_auto("device-limit")
		_:
			# Nothing to show: the form (after a step the re-run replaced, back to it).
			if _auto_state != "":
				_end_auto()
				refresh_view()


## The automatic sign-in's step is over: nothing of it stays on screen.
func _end_auto() -> void:
	_auto_state = ""
	_link_hold = false
	_link_finishing = false
	_link_entry = {}
	_link_problem = ""
	_link_resign = false
	choosing = false
	_auto_result = null
	_replacing = false
	license_choice.other_account_link = false
	auto_step.busy = false
	auto_step.error_key = ""


## The sign-in dialog's platform sign-in (Apple's sheet, Google) ended in something the gate draws.
func _on_platform_answer(result: PKeyAutoSignInResult) -> void:
	await _apply_auto(result)


func _show_auto(step: String) -> void:
	_auto_state = step
	_focus_sign_in = false
	auto_step.step = step
	refresh_view()
	ensure_focus(true)


## Continue on the consent step completes the grant with the claims it showed. On the device-limit
## step, Replace opens the Worker's manage page (the sign-in runs again when the person is back);
## where there is no link, or no browser, the primary is Try again.
func _on_auto_primary(step: String) -> void:
	if step in PKeyGateController.LINK_STEPS:
		await _link_flow.primary(step)
		return
	if step == "device-limit":
		var url := PKeyGateController.manage_link(_auto_result)
		if url != "" and not PKeyUiView.pad_only():
			_replacing = true
			OS.shell_open(url)
			return
		if not _auto_running:
			start_auto_sign_in(true)
		return
	if step != "confirm" or _auto_result == null:
		return
	var claims: Array = PKeyGateController.consent_step(_auto_result.pending.get("consent", {})).get("claims", [])
	await _complete_auto(null, {"claims": claims})


## Use another account: give the grant up and show the regular form, on Polaris Locker's sign-in.
func _on_auto_secondary(step: String) -> void:
	if step in PKeyGateController.LINK_STEPS:
		_link_flow.secondary(step)
		return
	_leave_auto_sign_in()


## The licence choice's own "Use another account" (and a key request, which an automatic choice offers
## as the same way out).
func _on_auto_other_account() -> void:
	if _auto_state == "choose":
		_leave_auto_sign_in()


func _leave_auto_sign_in() -> void:
	var grant := _held_grant()
	_end_auto()
	_focus_sign_in = true
	refresh_view()
	ensure_focus(true)
	if grant != "" and sdk != null and is_instance_valid(sdk):
		sdk.identity.choice.cancel(grant)


func _held_grant() -> String:
	return String(_auto_result.pending.get("grant", "")) if _auto_result != null else ""


func _on_auto_license_chosen(selection: Dictionary) -> void:
	if _auto_state != "choose":
		return
	var kind := String(selection.get("kind", ""))
	var choice := {"kind": kind}
	if kind == "license":
		choice["license_id"] = String(selection.get("id", ""))
	await _complete_auto(choice, null)


## Replace a device on a full licence: the licence's devices, in place.
func _on_auto_replace_requested(license_id: String) -> void:
	var grant := _held_grant()
	if _auto_state != "choose" or grant == "" or sdk == null or not is_instance_valid(sdk):
		return
	var r: PKeyChoiceResult = await sdk.identity.choice.devices(grant, license_id)
	if not is_instance_valid(self) or _auto_state != "choose":
		return
	if r.ok and not r.view.is_empty():
		license_choice.open_replace(license_id, r.view)
	else:
		license_choice.show_raced()


func _on_auto_replace_confirmed(license_id: String, device: Dictionary) -> void:
	if _auto_state != "choose" or String(device.get("id", "")) == "":
		return
	await _complete_auto({"kind": "license", "license_id": license_id, "replace_device_id": String(device["id"])}, null)


func _complete_auto(choice: Variant, consent: Variant) -> void:
	var grant := _held_grant()
	if grant == "" or sdk == null or not is_instance_valid(sdk) or _completing:
		return
	_completing = true
	auto_step.busy = _auto_state == "confirm"
	var r: PKeyChoiceResult = await sdk.identity.choice.complete(grant, choice, consent)
	_completing = false
	if not is_instance_valid(self):
		return
	auto_step.busy = false
	if not r.ok and r.view is Dictionary and r.view.get("choices") is Array:
		# A refusal the person can fix (a full licence, a choice still due) carries a fresh view.
		_auto_state = "choose"
		license_choice.other_account_link = true
		show_license_choice(r.view)
		return
	if not r.ok and _auto_state == "confirm" and r.code != &"invalid_grant":
		# The grant is still good (the network failed, say): the step stays, with the kit's own error line,
		# and Continue tries again. The grant is given up only when the person leaves.
		auto_step.error_key = "core.codes.network.message"
		return
	var failure := ""
	if not r.ok:
		# The grant expired or was used: back to the form, with the kit's line, and the grant given up.
		failure = String(catalog().format("core.codes.invalid_grant.message"))
		sdk.identity.choice.cancel(grant)
	_end_auto()
	show_state(sdk.status(), failure)
