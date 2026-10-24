class_name PKeyDeviceLimit
extends PKeyUiView
## "Your license is on 3 of 3 devices": the Replace a device screen as a card of its own (UI-KITS.md
## §4.1 DeviceLimit; ui-core's `device_limit_view` is the reference), for a game that shows the
## limit outside the gate. A full license is a limit, not an error (DL6): **Replace and continue**
## is its fix. The words are catalog keys from the model's view (`PKeyDeviceLimitController`).
##
## The game sets what it knows (`used`, `limit`, `devices`, `manage_url`) and answers the signals;
## the scene removes nothing itself. States (the model's): default (the least recently used other
## device is preselected, with what happens to it), browser-mode (a manage page opens in the
## browser, or as a QR code on a TV), busy, removed, failed (**Try again**), hidden.

## **Replace and continue**: the game signs `device` (a roster row) out and continues.
signal replace_requested(device: Dictionary)
## **Open in browser** was chosen (after the https page was opened).
signal manage_opened()
## **Try again** after a failed replacement.
signal retry_requested()
## **Back**, Escape or a pad's back button.
signal back_requested()

## How many devices the license is on and its limit (-1: not known).
@export var used := -1
@export var limit := -1
## The roster: `{id, name, platform, formFactor, lastSeenDays, current}` rows (PKeyDevicesController.rows()).
var devices: Array = []
## The https page where a device is replaced ("" none: the roster is replaced here).
@export var manage_url := ""
## This device's form factor ("iphone", "mac", "computer", "tv"…): "To use it on this iPhone".
@export var form_factor := ""
## A replacement is running.
@export var pending := false
## "", "done" or "failed", and the name of the device it was about.
@export var outcome := ""
@export var replaced_name := ""
## A pad-only device (a TV or a console): the manage page is a QR code, not a button.
@export var pad := false
## Dim the game behind it instead of replacing it with a page.
@export var modal := false

var model: Dictionary = {}

var _card: BoxContainer
var _right: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _lede: Label
var _meter: PKeySeatMeter
var _caption: Label
var _pick: VBoxContainer
var _pick_glyph: TextureRect
var _pick_name: Label
var _pick_meta: Label
var _pick_tag: Label
var _consequence: Label
var _qr: PKeyQrRect
var _qr_caption: Label
var _actions: BoxContainer
var _primary: Button
var _back: Button
var _hint_bar: PKeyHintBar
var _chosen: Dictionary = {}


func _build() -> void:
	name = "PKeyDeviceLimit"
	_card = columns(card_panel(), "Body")
	var text := vbox(_card, "Text", "PKeyStack")
	text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_right = vbox(_card, "Right", "PKeyStack")
	_right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_right.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_product = product_header(text, "Product")
	_product.card = true
	var words := vbox(text, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_lede = label(words, "Lede", "PKeyMuted")
	_meter = PKeySeatMeter.new()
	_meter.name = "Seats"
	text.add_child(_meter)
	_caption = label(text, "Caption", "PKeyMuted")
	_pick = vbox(_right, "Pick", "PKeyTight")
	_pick_tag = label(_pick, "Tag", "PKeyMuted")
	var head := hbox(_pick, "Head")
	_pick_glyph = glyph_node(head, "Glyph", "device_computer")
	var who := vbox(head, "Who", "PKeyTight")
	who.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_pick_name = label(who, "Name", "PKeyStrong", true)
	_pick_meta = label(who, "Meta", "PKeyMuted")
	_consequence = label(_right, "Consequence", "PKeyMuted")
	_qr = qr_tile(_right, "ManageQr")
	_qr.get_parent().size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_qr_caption = label(_right, "ManageCaption", "PKeyMuted")
	loading_bar(text)
	_actions = actions_row(_right, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_primary = button(_actions, "Primary", _on_primary, "PKeyPrimary")
	_back = button(_actions, "Back", _on_back)
	_hint_bar = hint_bar(_right, "HintBar", [{"action": PKeyInputGlyphs.CONFIRM, "key": "part.hint.select"}, {"action": PKeyInputGlyphs.BACK, "key": "common.back"}])


func _bleeds() -> bool:
	return true


func _scrim_wanted() -> bool:
	return modal


func _guard_for_modal() -> bool:
	return modal and visible


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 3


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), modal]


## A landscape screen that holds both columns: the state on one side, the way out on the other.
func _side_by_side() -> bool:
	if phone_screen() or not is_landscape():
		return false
	return room_x() + 1.0 >= (role("card_width") - 2.0 * role("card_padding")) * 1.45


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width_wide" if _side_by_side() else "card_width"), content_room().x))


func _render() -> void:
	var tv := pad or pad_only()
	model = PKeyDeviceLimitController.view(PKeyDeviceLimitController.input({
		"used": used, "limit": limit, "devices": devices, "manage_url": manage_url, "pending": pending,
		"outcome": outcome, "replaced": replaced_name, "form_factor": form_factor, "pad": tv,
	}))
	var state := String(model.get("state", "hidden"))
	visible = state != "hidden"
	if not visible:
		return
	var args: Dictionary = (model.get("args", {}) as Dictionary).duplicate()
	args["product"] = PKeyUiTheme.isolate(String(PKeyUiTheme.product_identity()["name"]))
	if args.has("device"):
		args["device"] = PKeyUiTheme.isolate(String(args["device"]))
	args["formFactor"] = form_factor if form_factor != "" else "other"
	var copy: Array = model.get("copy", [])
	_product.refresh()
	var title := ""
	var lede := ""
	_chosen = {}
	match state:
		"default":
			title = "deviceLimit.heading" if used >= 0 and limit >= 0 else "deviceLimit.title"
			lede = "deviceLimit.lede"
		"browser-mode":
			title = "deviceLimit.title"
			lede = "deviceLimit.browser"
		"busy":
			title = "deviceLimit.primary"
		"removed":
			title = "deviceLimit.removed"
		"failed":
			title = "deviceLimit.failed"
	cat_text(_title, title, args)
	cat_text(_lede, lede if squeeze_level() < 1 else "", args)
	var known := limit >= 0 and used >= 0 and state in ["default", "browser-mode", "busy"]
	_meter.show_seats(used, limit, 1.0) if known else _meter.hide()
	cat_text(_caption, "part.seatMeter.caption" if known and copy.has("part.seatMeter.caption") else "", args)
	if known:
		name_for_reader(_meter, String(catalog().format("a11y.seatMeter", args)))
	# The preselected device and what happens to it.
	var picked = PKeyDeviceLimitController.pick(devices) if state == "default" else null
	_pick.visible = picked != null
	_consequence.visible = picked != null and squeeze_level() < 2
	if picked != null:
		_chosen = picked
		var t := c()
		_pick_glyph.set_meta(&"pkey_glyph", PKeyKitGlyphs.device(picked.get("formFactor")))
		_pick_name.text = PKeyUiTheme.isolate(String(picked.get("name", ""))) if String(picked.get("name", "")) != "" else t.text("devices_unnamed")
		_pick_meta.text = PKeyDevicesController.meta_text(picked, t)
		cat_text(_pick_tag, "signin.replace.leastRecent" if squeeze_level() < 3 else "", args)
		var cargs := args.duplicate()
		cargs["device"] = PKeyUiTheme.isolate(String(picked.get("name", ""))) if String(picked.get("name", "")) != "" else t.text("devices_unnamed")
		cargs["thisDevice"] = String(catalog().format("part.thisDevice", {"formFactor": form_factor if form_factor != "" else "other"}))
		cat_text(_consequence, "deviceLimit.consequence" if squeeze_level() < 2 else "", cargs)
	# The manage page: a QR code on a TV (nothing opens a browser there), else a button.
	var qr_here := state == "browser-mode" and tv and PKeyOutletAdapter.is_https(manage_url)
	_qr.text = manage_url if qr_here else ""
	_qr.visible = qr_here and not _qr.encode_failed
	_qr.get_parent().visible = _qr.visible
	cat_text(_qr_caption, "deviceLimit.scan" if _qr.visible else "", args)
	var primary := PKeyDeviceLimitController.primary_of(model)
	cat_text(_primary, primary, args)
	_primary.disabled = state == "busy"
	leaves_app(_primary, primary == "deviceLimit.openBrowser")
	cat_text(_back, "common.back" if copy.has("common.back") else "", args)
	set_loading(state == "busy")


func _arrange(m: Dictionary) -> void:
	_hint_bar.enabled = visible
	set_columns(_card, _side_by_side())
	_right.size_flags_vertical = Control.SIZE_EXPAND_FILL if phone_screen() else Control.SIZE_SHRINK_CENTER
	_actions.size_flags_horizontal = Control.SIZE_FILL
	var qr := qr_side(content_room().y * 0.45)
	if squeeze_level() >= 1:
		qr = maxf(roundf(qr * 0.7), QR_MIN_PHYSICAL / float(m["physical"]))
	_qr.custom_minimum_size = Vector2(qr, qr)
	super(m)
	size_glyph(_pick_glyph, 28.0, get_theme_color("font_color", "Label"))


func _initial_focus() -> Control:
	return _primary if is_focusable(_primary) else (_back if is_focusable(_back) else null)


func _focus_chain() -> Array:
	return [_primary, _back]


func _on_back() -> void:
	close_then(func() -> void:
		back_requested.emit()
		restore_opener())


func _on_primary() -> void:
	match PKeyDeviceLimitController.primary_of(model):
		"deviceLimit.primary":
			if not _chosen.is_empty():
				replace_requested.emit(_chosen)
		"deviceLimit.openBrowser":
			PKeyOutletAdapter.open_https(manage_url)
			manage_opened.emit()
		"common.tryAgain":
			retry_requested.emit()


func _cancel() -> bool:
	if visible and model.get("state") in ["default", "browser-mode", "failed"]:
		_on_back()
		return true
	return false
