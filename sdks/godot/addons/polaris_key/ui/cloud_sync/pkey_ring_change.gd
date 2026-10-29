class_name PKeyRingChange
extends PKeyUiView
## Your sync key changed (ui-matrix `cloudSync`; ui-core's `ring_change_view`): another device set up
## a new key for the synced data, and this one will not open it on its own (S5). The screen names
## the device (`by`, drawn bidi-isolated; a neutral line when none is named) and offers, in order:
##
##   Use recovery code   the primary and the safer way in (opens UnlockSync)
##   That was me         only with `served`, the ring the person was shown: it hands exactly that
##                       ring to `keyring.accept_ring_change` and nothing a fresh read says
##   Cancel
##
## Without `served` there is nothing to accept, only the recovery code. After an Accept that did not
## open a root the screen says so (`failed`) and Accept stays available. Unless the game handles it
## (`host_handles`), Accept runs `PolarisKey.keyring.accept_ring_change` (`PKeyCloudSyncController`).
## Hidden when the Sync service is off (`sync_on`).

## Accepting opened the ring: this device holds the key again.
signal accepted()
## Use recovery code was chosen: show `PKeyUnlockSync`.
signal use_code_requested()
## Cancel (or Escape).
signal cancelled()
## `host_handles`: That was me was chosen for this ring (`{ring_id, epoch, root_kid}`).
signal accept_requested(served: Dictionary)

## The name of the device that set the key up (`changed.by`), or "".
@export var by := "":
	set(value):
		by = value
		refresh_view()
## Accepting did not open a root.
@export var failed := false:
	set(value):
		failed = value
		refresh_view()
## An accept is running.
@export var busy := false:
	set(value):
		busy = value
		refresh_view()
@export var sync_on := true:
	set(value):
		sync_on = value
		refresh_view()
@export var host_handles := false
## The ring the person was shown: `{ring_id, epoch, root_kid}` (`changed.served`), or empty.
var served: Dictionary = {}:
	set(value):
		served = value
		refresh_view()

var model: Dictionary = {}

var _product: PKeyProductHeader
var _cols: BoxContainer
var _body: VBoxContainer
var _title: Label
var _body_text: Label
var _warning: Label
var _error: Label
var _warning_glyph: TextureRect
var _error_glyph: TextureRect
var _actions: BoxContainer
var _use_code: Button
var _accept: Button
var _cancel_button: Button


func _build() -> void:
	name = "PKeyRingChange"
	_body = vbox(card_panel(), "Body", "PKeyStack")
	var body := _body
	_product = product_header(body, "Product")
	_product.card = true
	# The title spans the card; in landscape the words sit beside the actions.
	_title = label(vbox(body, "Head", "PKeyTight"), "Title", "PKeyTitle")
	_cols = columns(body, "Columns")
	var left := vbox(_cols, "Left", "PKeyStack")
	left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var right := vbox(_cols, "Right", "PKeyStack")
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var words := vbox(left, "Words", "PKeyTight")
	_body_text = label(words, "BodyText", "PKeyMuted")
	var warn := glyph_label(words, "Warning", "warning", "PKeyMuted")
	_warning = warn["label"]
	_warning_glyph = warn["glyph"]
	var err := glyph_label(words, "Error", "warning", "PKeyError")
	_error = err["label"]
	_error_glyph = err["glyph"]
	loading_bar(right)
	_actions = actions_row(right, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_use_code = button(_actions, "UseCode", _on_use_code, "PKeyPrimary")
	_accept = button(_actions, "Accept", _on_accept)
	_cancel_button = button(_actions, "Cancel", _on_cancel, "PKeyLink")
	for b in [_use_code, _accept, _cancel_button]:
		(b as Button).autowrap_mode = TextServer.AUTOWRAP_WORD_SMART


func _bleeds() -> bool:
	return true


## Opens at the title, unless even the tightest arrangement scrolls: then at the focused primary.
func _opens_at_top() -> bool:
	return squeeze_level() < squeeze_max()


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 4


func _process(_delta: float) -> void:
	_tick_loading()


func _arrange(m: Dictionary) -> void:
	var two := two_pane_fits()
	set_columns(_cols, two)
	# Beside the words the three actions stack at the column's width, never one wide row.
	_actions.set_meta(&"pkey_force_stack", two)
	_cols.get_child(0).size_flags_stretch_ratio = 1.3 if two else 1.0
	super(m)
	_product.visible = squeeze_level() < 1
	size_glyph(_warning_glyph, 20.0, get_theme_color("font_color", "PKeyWarning"))
	size_glyph(_error_glyph, 20.0, get_theme_color("font_color", "PKeyError"))
	# Short on room, the gaps between the parts close before the card scrolls.
	_body.theme_type_variation = &"PKeyTight" if squeeze_level() >= 2 else &"PKeyStack"


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide" if two_pane_fits() else "card_width"), content_room().x))


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), sync_on]


func _render() -> void:
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("RingChange", PKeyRingChange.input(by, not served.is_empty(), failed, sync_on))
	var state: String = model.get("state", "hidden")
	visible = state != "hidden"
	_product.refresh()
	var args := {"device": PKeyUiTheme.isolate(by.strip_edges())}
	var copy: Array = model.get("copy", [])
	cat_text(_title, "ringChange.title" if visible else "")
	# The line naming the device is what the person decides on: it never goes. Short on room the
	# product header gives way, then the gaps, then the card scrolls.
	var body_key := "ringChange.body" if copy.has("ringChange.body") else ("ringChange.bodyUnknown" if visible else "")
	cat_text(_body_text, body_key, args)
	var warning_key := "ringChange.warning" if copy.has("ringChange.warning") else ("ringChange.warningNoServed" if visible else "")
	# After a failed accept the failure line already names both ways on (try again, or the recovery
	# code), so the tightest arrangement leaves the warning out rather than scroll the actions away.
	cat_text(_warning, "" if state == "failed" and squeeze_level() >= squeeze_max() else warning_key)
	cat_text(_error, "ringChange.failed" if state == "failed" else "")
	fx_error("ringChange.failed" if state == "failed" else "")
	_warning_glyph.visible = _warning.visible
	_error_glyph.visible = _error.visible
	cat_text(_use_code, "ringChange.useCode" if visible else "")
	cat_text(_accept, "ringChange.accept" if copy.has("ringChange.accept") else "")
	cat_text(_cancel_button, "common.cancel" if visible else "")
	_accept.disabled = busy
	_use_code.disabled = busy
	_cancel_button.disabled = busy
	set_loading(busy)
	set_process(busy)


## The model input (ui-matrix `ringChange`).
static func input(p_by: String, has_served: bool, p_failed: bool, p_sync_on := true) -> Dictionary:
	var r := {}
	if p_by.strip_edges() != "":
		r["by"] = p_by
	if has_served:
		r["served"] = {"ringId": "", "epoch": 0, "rootKid": ""}
	if p_failed:
		r["failed"] = true
	var out := {"ringChange": r}
	if not p_sync_on:
		out["services"] = ["license", "config", "release", "distribution", "update", "identity"]
	return out


func _initial_focus() -> Control:
	# The safe default: a pad's A on open opens the recovery code, never accepts the ring.
	return _use_code if is_focusable(_use_code) else _cancel_button


func _focus_chain() -> Array:
	return [_use_code, _accept, _cancel_button]


func _cancel() -> bool:
	if not visible:
		return false
	if not busy:
		_on_cancel()
	return true


func _on_use_code() -> void:
	use_code_requested.emit()


func _on_cancel() -> void:
	cancelled.emit()


func _on_accept() -> void:
	if served.is_empty() or busy:
		return
	if host_handles:
		accept_requested.emit(served.duplicate())
		return
	busy = true
	failed = false
	var r: PKeyResult = await PKeyCloudSyncController.accept(sdk, served)
	if not is_instance_valid(self):
		return
	busy = false
	if r.ok and r.detail is Dictionary and r.detail.get("kind") == "ring-changed":
		# The ring moved again while the person was deciding: show the new ring and its device and
		# ask again, never the old one.
		var now: Dictionary = r.detail
		by = String(now["by"]) if now.get("by") is String else ""
		served = now["served"] if now.get("served") is Dictionary else {}
		failed = false
		ensure_focus(true)
		return
	if r.ok:
		accepted.emit()
		return
	failed = true
