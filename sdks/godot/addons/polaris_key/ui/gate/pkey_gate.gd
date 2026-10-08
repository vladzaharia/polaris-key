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
## the activation form in landscape the card is wide and has two columns, the product and what
## the screen says on one side and the form on the other; a message screen is one narrower
## column; sign-in and offline activation take the whole card in their own layouts.

## The licence lets the game run (ok, grace, not-applicable).
signal usable()
## The player asked to retry (always emitted; acted on here unless `managed_retry`).
signal retry_requested()

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
var error := ""
## The update answer behind "update required"'s action (PolarisKey.update.update_available).
var update_result: PKeyResult = null
## Override the build's outlet ("" reads PolarisKey.build_info()).
var outlet := ""
var screen := "loading"

var activation: PKeyActivationPanel
var banner: PKeyStatusBanner
var _card: PanelContainer
var _split: BoxContainer
var _aside: VBoxContainer
var _head: VBoxContainer
var _main: VBoxContainer
var _product: PKeyProductHeader
var _powered_by: TextureRect
var _title: Label
var _body: Label
var _detail: Label
var _error: Label
var _update: Button
var _retry: Button
var _banner_slot: MarginContainer
var _center: CenterContainer
var _bound := false
var _was_usable := false


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
	var box := vbox(scroll_area(_card), "Body", "PKeySections")
	_split = columns(box, "Split")
	_aside = vbox(_split, "Aside", "PKeyStack")
	_aside.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_aside.size_flags_stretch_ratio = 0.8
	_product = product_header(_aside, "Product", true)
	_head = vbox(_aside, "Head", "PKeyTight")
	_title = label(_head, "Title", "PKeyTitle")
	_body = label(_head, "Message", "PKeyMuted")
	_detail = label(_head, "Detail", "PKeyMuted")
	# The caller's message (an activation or sign-in error it already worded): data here.
	_error = label(_head, "Error", "PKeyError", true)
	_main = vbox(_split, "Main", "PKeySections")
	_main.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	activation = PKeyActivationPanel.new()
	activation.auto_sdk = false
	activation.show_product = false
	activation.activated.connect(_on_activated)
	# Sign-in and offline activation take the whole card: the gate re-renders around them.
	activation.mode_changed.connect(func(_m: String) -> void: refresh_view())
	_main.add_child(activation)
	var actions := actions_row(_main, "Actions", FlowContainer.ALIGNMENT_BEGIN)
	_update = button(actions, "UpdateAction", _on_update, "PKeyPrimary")
	_retry = button(actions, "Retry", _on_retry)
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


## Two columns: the activation form beside the product and the message, in landscape.
func _two_columns() -> bool:
	return activation.visible and activation.mode == "main" and is_landscape()


## The card's content width (logical pixels): what the activation panel wants while it shows,
## else one column.
func _content_wanted() -> float:
	if activation.visible and activation.mode != "main":
		return activation.preferred_width()
	if _two_columns():
		return role("card_width_wide") - 2.0 * role("card_padding")
	return role("card_width") - 2.0 * role("card_padding")


func _apply_width(_width: float) -> void:
	_card.custom_minimum_size.x = card_width(_content_wanted() + side_padding(_card))


func _arrange(m: Dictionary) -> void:
	var two := _two_columns()
	activation.adopt_intro(_aside if two else null)
	set_columns(_split, two)
	# In two columns the actions sit under the form; the form's own column order is unchanged.
	super(m)
	_fit_brand()
	fit_scrolls(available_height() - end_padding(_card), outer_view() == self or embedded)


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


func _render() -> void:
	var t := c()
	var st := String(status.get("status", ""))
	screen = PKeyGateController.screen_for(st, loading, error, allow_grace)
	var url := PKeyUpdatePromptController.update_url(update_result, _outlet(), release_url)
	var ctl := PKeyGateController.controls_for(screen, url != "")
	var cp := PKeyGateController.copy_for(screen, st, status.get("allowed_range"))
	var is_usable := PKeyGateController.is_usable_screen(screen)
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
	show_text(_title, t.text(cp["title"]) if cp["title"] != "" else "")
	show_text(_body, t.text(cp["body"]) if cp["body"] != "" else "")
	var detail = cp["detail"]
	show_text(_detail, t.text(detail[0], detail[1]) if detail is Array else "")
	show_text(_error, error if screen == "error" else "")
	activation.visible = ctl["activation"]
	# One title per card: the activation panel's own only when the gate shows none above it.
	activation.show_title = not _title.visible
	# Sign-in and offline activation lead with their own layouts; everything else leads with the
	# product.
	var sub := activation.visible and activation.mode != "main"
	_aside.visible = not sub
	_head.visible = _title.visible or _body.visible or _detail.visible or _error.visible
	_product.refresh()
	activation.sign_in_dialog.show_product = sub
	show_text(_update, t.text("update_action") if ctl["update_action"] and not sub else "")
	show_text(_retry, t.text("retry") if ctl["retry"] and not sub else "")
	if is_usable and not _was_usable:
		_was_usable = true
		usable.emit.call_deferred()
	elif not is_usable:
		_was_usable = false


func _focus_chain() -> Array:
	var out: Array = []
	if activation.visible:
		out.append_array(activation._focus_chain())
	out.append_array([_update, _retry])
	return out


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


func _on_retry() -> void:
	retry_requested.emit()
	if managed_retry or sdk == null or not sdk.has_method("sync"):
		return
	show_loading()
	await sdk.sync(true)
	show_state(sdk.status())


func _cancel() -> bool:
	return activation.visible and activation._cancel()
