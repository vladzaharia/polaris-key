class_name PKeyGateView
extends PKeyUiView
## The licence gate as a full-screen scene (PKeyGateController mirrors React's `screenFor`):
## ok and not-applicable hide the gate and emit `usable`; grace emits `usable` and shows only a
## PKeyStatusBanner strip (or blocks with Retry when `allow_grace` is false); needs-activation
## shows PKeyActivationPanel; revoked says the device was signed out and offers sign-in and
## activation again; expired asks to connect and retries (sync(true)); version-too-old says
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

## Let `grace` pass (React's `allowGrace`).
@export var allow_grace := true
## Offer "Continue free" on the activation panel.
@export var offer_enrollment := false:
	set(value):
		offer_enrollment = value
		if activation != null:
			activation.offer_enrollment = value
## The release page a direct build opens on "update required" (see PKeyUpdatePromptController).
@export var release_url := ""
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
var banner: PKeyStatusBanner
var _card: PanelContainer
var _split: BoxContainer
var _pane: PanelContainer
var _aside: VBoxContainer
var _head: VBoxContainer
var _main: VBoxContainer
var _product: PKeyProductHeader
var _powered_by: TextureRect
var _glyph: TextureRect
var _title: Label
var _body: Label
var _detail: Label
var _update: Button
var _retry: Button
var _offline_btn: Button
var _actions: BoxContainer
var _spacer: Control
var _banner_slot: MarginContainer
var _center: CenterContainer
var _bound := false
var _was_usable := false


func _bleeds() -> bool:
	return true


## The gate squeezes for the dialog it holds (sign-in, offline activation, the device limit).
func squeeze_max() -> int:
	return 3


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
	_main = vbox(_split, "Form", "PKeySections")
	_main.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_main.size_flags_vertical = Control.SIZE_EXPAND_FILL
	activation = PKeyActivationPanel.new()
	activation.auto_sdk = false
	activation.show_product = false
	activation.activated.connect(_on_activated)
	# Sign-in and offline activation take the whole card: the gate re-renders around them.
	activation.mode_changed.connect(func(_m: String) -> void: refresh_view())
	_main.add_child(activation)
	_spacer = spacer(_main)
	_actions = actions_row(_main, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_update = button(_actions, "UpdateAction", _on_update, "PKeyPrimary")
	_retry = button(_actions, "Retry", _on_retry, "PKeyPrimary")
	_offline_btn = button(_actions, "ContinueOffline", _on_continue_offline)
	_powered_by = brand_node(box, "PoweredBy", BRAND_POWERED_BY)
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
	return activation.visible and activation.mode == "main" and activation.limit.is_empty() and bool(layout_metrics().get("wide", false)) and not phone_bleed()


## The activation panel's own sub-screens (sign-in, offline activation, a full license) lead with
## their own header: the gate's pane gives way.
func _activation_owns_screen() -> bool:
	return activation.visible and (activation.mode != "main" or not activation.limit.is_empty())


## The card's content width (logical pixels): what the activation panel wants while a dialog of
## it shows, two panes' worth, or one column.
func _content_wanted() -> float:
	if activation.visible and activation.mode != "main":
		return activation.preferred_width()
	if _two_panes():
		return role("card_width_wide") - 2.0 * role("card_padding")
	return role("card_width") - 2.0 * role("card_padding")


func _apply_width(_width: float) -> void:
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
	_pane.visible = (_product.visible or _head.visible) and not _activation_owns_screen()
	# The last squeeze step drops the secondary line (the version range, say) before any scrolling.
	_detail.visible = _detail.text != "" and squeeze_level() < 3
	if two:
		if _pane.has_theme_stylebox_override("panel"):
			_pane.remove_theme_stylebox_override("panel")
	elif not _pane.has_theme_stylebox_override("panel"):
		_pane.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	# The product names the screen when it has the pane; otherwise a leading header over the title.
	_product.hero = two
	_product.as_title = two
	_product.centered = two
	_aside.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var lead := HORIZONTAL_ALIGNMENT_CENTER if _glyph.visible else _title_start
	_title.horizontal_alignment = lead
	_body.horizontal_alignment = lead
	_detail.horizontal_alignment = lead
	size_glyph(_glyph, 40.0, get_theme_color("font_color", "PKeyWarning"))
	_spacer.visible = bleed and not _activation_owns_screen()
	# A dialog the gate holds fills the page on a phone, docking its own actions to the bottom.
	activation.size_flags_vertical = Control.SIZE_EXPAND_FILL if bleed and _activation_owns_screen() else Control.SIZE_FILL
	if bleed:
		_card.theme_type_variation = &""
		if not _card.has_theme_stylebox_override("panel"):
			_card.add_theme_stylebox_override("panel", StyleBoxEmpty.new())
	else:
		if _card.has_theme_stylebox_override("panel"):
			_card.remove_theme_stylebox_override("panel")
		_card.theme_type_variation = &"PKeyCard"
	super(m)
	_fit_brand()
	fit_scrolls(available_height(), outer_view() == self or embedded)


## A label's own start alignment (mirrored with the layout direction).
var _title_start: HorizontalAlignment


## The Powered-by badge shows at its kit minimum or not at all: it gives way when the card would
## not fit the screen with it.
func _fit_brand() -> void:
	if _powered_by.texture == null:
		return
	if _card.size.x < 1.0:
		# Not laid out yet: wrapped text has no width to measure against; decide on the next pass.
		_powered_by.visible = true
		return
	_powered_by.visible = false
	var room := content_room().y
	var need := _card.get_combined_minimum_size().y + _powered_by.custom_minimum_size.y + role("section_gap")
	_powered_by.visible = need <= room


func _ready() -> void:
	super()
	_title_start = _title.horizontal_alignment
	activation.sdk = sdk
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
	status = s
	loading = false
	error = p_error
	refresh_view()


func show_loading() -> void:
	loading = true
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
	return "%s|%s|%s|%s" % [screen, activation.mode, "limit" if not activation.limit.is_empty() else "", "net" if network_error else ""]


func _render() -> void:
	var t := c()
	var st := String(status.get("status", ""))
	screen = PKeyGateController.screen_for(st, loading, error, allow_grace)
	var url := PKeyUpdatePromptController.update_url(update_result, _outlet(), release_url)
	var ctl := PKeyGateController.controls_for(screen, url != "")
	var cp := PKeyGateController.copy_for(screen, st, status.get("allowed_range"))
	var is_usable := PKeyGateController.is_usable_screen(screen)
	var net := screen == "error" and network_error
	var inline := screen == "error" and not network_error
	if not embedded:
		visible = screen != "usable"
	_card.visible = not is_usable
	# Grace lets the game run: no backdrop, no input captured, only the banner strip.
	mouse_filter = Control.MOUSE_FILTER_IGNORE if is_usable else Control.MOUSE_FILTER_STOP
	# The full-rect CenterContainer would catch the game's clicks (a Container passes by default).
	_center.mouse_filter = Control.MOUSE_FILTER_IGNORE if is_usable else Control.MOUSE_FILTER_PASS
	self_modulate.a = 0.0 if is_usable else 1.0
	_banner_slot.visible = ctl["banner"]
	if ctl["banner"]:
		banner.show_state(status)
	_product.refresh()
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
	var wants_form: bool = ctl["activation"] and not net
	activation.visible = wants_form
	activation.form_title = t.text("use_another_license") if screen == "not-available" else ""
	if inline:
		if activation.message != error:
			activation.show_message(error)

	show_text(_update, t.text("update_action") if ctl["update_action"] else "")
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


func _focus_chain() -> Array:
	var out: Array = []
	if activation.visible:
		out.append_array(activation._focus_chain())
	out.append_array([_update, _retry, _offline_btn])
	return out


## A stop card puts the focus on Try again (or the update action); the form on its first control,
## which on a pad-only device is Sign in.
func _initial_focus() -> Control:
	if activation.visible:
		return activation._initial_focus()
	for b in [_update, _retry, _offline_btn]:
		if is_focusable(b):
			return b
	return null


func _on_update_available(r: PKeyResult) -> void:
	update_result = r
	refresh_view()


func _on_activated() -> void:
	if sdk != null and sdk.has_method("status"):
		show_state(sdk.status())


func _on_update() -> void:
	var url := PKeyUpdatePromptController.update_url(update_result, _outlet(), release_url)
	if url != "":
		OS.shell_open(url)


func _on_continue_offline() -> void:
	continue_offline_requested.emit()


func _on_retry() -> void:
	retry_requested.emit()
	if managed_retry or sdk == null or not sdk.has_method("sync"):
		return
	show_loading()
	await sdk.sync(true)
	show_state(sdk.status())


func _cancel() -> bool:
	return activation.visible and activation._cancel()
