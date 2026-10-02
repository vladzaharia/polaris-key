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
	var center := _center
	_card = PanelContainer.new()
	_card.name = "Card"
	_card.theme_type_variation = "PKeyCard"
	_card.custom_minimum_size = Vector2(420, 0)
	center.add_child(_card)
	var box := vbox(_card, "Body", 12)
	_title = label(box, "Title", "PKeyTitle")
	_body = label(box, "Message", "PKeyMuted")
	_detail = label(box, "Detail", "PKeyMuted")
	# The caller's message (an activation or sign-in error it already worded): data here.
	_error = label(box, "Error", "PKeyError", true)
	activation = PKeyActivationPanel.new()
	activation.auto_sdk = false
	activation.activated.connect(_on_activated)
	box.add_child(activation)
	var actions := hbox(box, "Actions")
	_update = button(actions, "UpdateAction", _on_update, "PKeyPrimary")
	_retry = button(actions, "Retry", _on_retry)
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
	show_text(_update, t.text("update_action") if ctl["update_action"] else "")
	show_text(_retry, t.text("retry") if ctl["retry"] else "")
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
