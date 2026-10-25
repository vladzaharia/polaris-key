class_name PKeyAbout
extends PKeyUiView
## "About <product>" (UI-KITS.md §4.1 About; ui-core's `about_view`): the product, its version,
## Privacy and Get help (https pages the game sets), Open-source licenses and **Copy diagnostics**,
## which puts the game's already redacted text on the clipboard and says "Diagnostics copied". The
## kit never reads diagnostics itself: `diagnostics` is what the game chose to share. Shown over the
## game (`modal`) or as a page of the game's own menu.

## **Open-source licenses** was chosen (the game shows its notices).
signal licenses_requested()
## Escape or a pad's back button.
signal back_requested()

@export var version := ""
@export var privacy_url := ""
@export var support_url := ""
## The redacted text **Copy diagnostics** copies; empty hides the button.
@export_multiline var diagnostics := ""
## Offer **Open-source licenses** (connect `licenses_requested`).
@export var show_licenses := true
@export var modal := false

var model: Dictionary = {}

var _card: BoxContainer
var _product: PKeyProductHeader
var _title: Label
var _version: Label
var _list: VBoxContainer
var _privacy: Button
var _support: Button
var _licenses: Button
var _copy: Button
var _done: Label
var _powered: Control


func _build() -> void:
	name = "PKeyAbout"
	_card = columns(card_panel(), "Body")
	var text := vbox(_card, "Text", "PKeyStack")
	text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_product = product_header(text, "Product")
	_product.card = true
	var words := vbox(text, "Words", "PKeyTight")
	_title = label(words, "Title", "PKeyTitle")
	_version = label(words, "Version", "PKeyMuted", true)
	_list = vbox(text, "Links", "PKeyTight")
	_privacy = button(_list, "Privacy", func() -> void: PKeyOutletAdapter.open_https(privacy_url), "PKeyLink")
	_support = button(_list, "Support", func() -> void: PKeyOutletAdapter.open_https(support_url), "PKeyLink")
	_licenses = button(_list, "Licenses", func() -> void: licenses_requested.emit(), "PKeyLink")
	_copy = button(_list, "CopyDiagnostics", _on_copy, "PKeyLink")
	for b in [_privacy, _support, _licenses, _copy]:
		(b as Button).size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_done = label(text, "Copied", "PKeyMuted")
	_powered = PKeyPoweredBy.new()
	_powered.name = "PoweredBy"
	text.add_child(_powered)


func _bleeds() -> bool:
	return true


func _scrim_wanted() -> bool:
	return modal


func _guard_for_modal() -> bool:
	return modal and visible


func _card_shown() -> bool:
	return true


func squeeze_max() -> int:
	return 1


func _screen_key() -> String:
	return "%s|%s" % [model.get("state", ""), modal]


func _render() -> void:
	var inp := {}
	if PKeyUiTheme.powered_by:
		inp["integrator"] = {"poweredBy": PKeyUiTheme.powered_by_style}
	model = preload("res://addons/polaris_key/ui/model/models.gd").view_of("About", inp)
	var args := {"product": PKeyUiTheme.isolate(String(PKeyUiTheme.product_identity()["name"])), "version": version}
	_product.refresh()
	cat_text(_title, "about.title", args)
	cat_text(_version, "about.version" if version != "" else "", args)
	cat_text(_privacy, "about.privacy" if PKeyOutletAdapter.is_https(privacy_url) else "", args)
	cat_text(_support, "about.support" if PKeyOutletAdapter.is_https(support_url) else "", args)
	cat_text(_licenses, "about.licenses" if show_licenses else "", args)
	cat_text(_copy, "about.copyDiagnostics" if diagnostics != "" else "", args)
	leaves_app(_privacy, PKeyOutletAdapter.is_https(privacy_url))
	leaves_app(_support, PKeyOutletAdapter.is_https(support_url))
	if not _done.has_meta(&"pkey_copied"):
		cat_text(_done, "", args)


func _arrange(m: Dictionary) -> void:
	set_columns(_card, false)
	super(m)


func _apply_width(width: float) -> void:
	if width <= 0.0:
		super(width)
		return
	super(minf(role("card_width"), content_room().x))


func _initial_focus() -> Control:
	for b in [_licenses, _privacy, _support, _copy]:
		if is_focusable(b):
			return b
	return null


func _focus_chain() -> Array:
	return [_privacy, _support, _licenses, _copy]


func _on_copy() -> void:
	DisplayServer.clipboard_set(diagnostics)
	_done.set_meta(&"pkey_copied", true)
	cat_text(_done, "about.diagnosticsCopied")


func _cancel() -> bool:
	if visible:
		close_then(func() -> void:
			back_requested.emit()
			restore_opener())
		return true
	return false
