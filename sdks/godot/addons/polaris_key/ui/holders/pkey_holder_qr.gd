class_name PKeyHolderQr
extends PKeyUiView
## The manage QR a TV or console shows for adding the license in Polaris Locker (UK-43.14, D5): the
## key-free link, scanned on a phone. A pad-only screen has no browser to open and the code on it
## can be read by anyone in the room, so the link never carries `#key=`. With no link there is no QR
## and no "Scan" sentence: the step says the link opens nothing here and gives the portal's address as
## text.
##
## The host connects `done_pressed` (Done, and Escape or a pad's B: nothing is in flight here).

## Done: back to the step the person came from.
signal done_pressed()

## The product page in the portal (https, no key), or "" for none.
@export var link := "":
	set(value):
		link = value
		refresh_view()

var _body: VBoxContainer
var _product: PKeyProductHeader
var _title: Label
var _scan: Label
var _qr: PKeyQrRect
var _problem: Label
var _problem_glyph: TextureRect
var _url: Label
var _spacer: Control
var _actions: BoxContainer
var _done: Button


func _build() -> void:
	name = "PKeyHolderQr"
	_body = vbox(card_panel(), "Body", "PKeySections")
	var top := vbox(_body, "Top", "PKeyStack")
	_product = product_header(top, "Product")
	_product.card = true
	_title = label(top, "Title", "PKeyTitle")
	_scan = label(top, "Scan", "PKeyMuted")
	_qr = qr_tile(top)
	var problem := glyph_label(top, "Problem", "warning", "PKeyError")
	_problem = problem["label"]
	_problem_glyph = problem["glyph"]
	if "accessibility_live" in _problem:
		_problem.set("accessibility_live", 1)
	_url = label(top, "Url", "PKeyMuted")
	_spacer = spacer(_body)
	_actions = actions_row(_body, "Actions", BoxContainer.ALIGNMENT_BEGIN)
	_done = button(_actions, "Primary", func() -> void: done_pressed.emit(), "PKeyPrimary")


func _bleeds() -> bool:
	return true


func _opens_at_top() -> bool:
	return true


func _arrange(m: Dictionary) -> void:
	super(m)
	size_glyph(_problem_glyph, 20.0, get_theme_color("font_color", "PKeyError"))
	_spacer.visible = phone_screen()
	var side := qr_side()
	_qr.custom_minimum_size = Vector2(side, side)


func _render() -> void:
	var shown := link if link.begins_with("https://") and not link.contains(" ") else ""
	cat_text(_title, "signin.key.addInLocker")
	cat_text(_scan, "signin.key.scan" if shown != "" else "")
	_qr.text = shown
	_qr.visible = shown != ""
	_qr.get_parent().visible = shown != ""
	if shown != "":
		name_for_reader(_qr, String(catalog().format("a11y.qrManage")))
	cat_text(_problem, "common.linkUnavailable" if shown == "" else "")
	_problem_glyph.visible = _problem.visible
	_problem_glyph.set_meta(&"pkey_glyph", "warning")
	cat_text(_url, "signin.handoff.url", {"url": PKeySignInController.short_uri(shown if shown != "" else PKeyConstants.CUSTOMER_ORIGIN_DEFAULT)})
	cat_text(_done, "common.done")
	_product.refresh()


func _initial_focus() -> Control:
	return _done if is_focusable(_done) else null


func _focus_chain() -> Array:
	return [_done]


## Nothing is in flight: Escape (or a pad's B) is Done.
func _cancel() -> bool:
	if not visible:
		return false
	done_pressed.emit()
	return true
