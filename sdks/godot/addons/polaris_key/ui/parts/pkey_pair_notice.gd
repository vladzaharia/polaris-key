class_name PKeyPairNotice
extends PanelContainer
## A notice of the pairing screens: one neutral callout with a glyph at its start, its title and
## words, and at most one quiet action. The title and the words are catalog text the screen formats;
## the callout is a polite live region, so a screen reader reads it when it appears without moving
## focus. `action_pressed` is the action's press.

signal action_pressed

var _row: HBoxContainer
var _glyph: TextureRect
var _title: Label
var _body: Label
var _action: Button
var _tone := "info"


func _init() -> void:
	name = "Notice"
	theme_type_variation = "PKeyBanner"
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	visible = false
	var column := VBoxContainer.new()
	column.name = "Column"
	column.theme_type_variation = "PKeyTight"
	add_child(column)
	_row = HBoxContainer.new()
	_row.name = "Head"
	_row.theme_type_variation = "PKeyRow"
	column.add_child(_row)
	_glyph = TextureRect.new()
	_glyph.name = "Glyph"
	_glyph.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_glyph.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_glyph.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_glyph.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	_row.add_child(_glyph)
	_title = _label(_row, "Title", "PKeyStrong")
	_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_body = _label(column, "Body", "PKeyMuted")
	_action = Button.new()
	_action.name = "Action"
	_action.theme_type_variation = "PKeyLink"
	_action.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_action.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_action.pressed.connect(func() -> void: action_pressed.emit())
	_action.set_meta(PKeyUiView.CATALOG_META, true)
	column.add_child(_action)


func _label(parent: Node, node_name: String, variation: String) -> Label:
	var l := Label.new()
	l.name = node_name
	l.theme_type_variation = variation
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	if "accessibility_live" in l:
		l.set("accessibility_live", 1)
	# The screen hands it catalog text, already in the running locale.
	l.set_meta(PKeyUiView.CATALOG_META, true)
	parent.add_child(l)
	return l


## Show the notice (an empty title hides it). `glyph` is "info" or "warning"; `action` is the label of
## its one quiet action, or "" for none.
func show_notice(title: String, body: String, glyph := "info", action := "") -> void:
	visible = title != ""
	_tone = glyph
	_title.text = title
	_body.text = body
	_body.visible = body != ""
	_action.text = action
	_action.visible = action != ""
	_glyph.set_meta(&"pkey_glyph", glyph)


## Give the words up for room (the title stays).
func set_body_hidden(hidden: bool) -> void:
	_body.visible = not hidden and _body.text != ""


## The action, for the focus chain (null while it is hidden).
func action_button() -> Button:
	return _action if _action.visible else null


## Draw the glyph at the screen's scale (`view.size_glyph` needs the view; this takes its numbers).
func size_glyph(view: PKeyUiView, px := 20.0) -> void:
	if not visible:
		return
	var tint := view.get_theme_color(
		"font_color", "PKeyWarning" if _tone == "warning" else "PKeyMuted"
	)
	view.size_glyph(_glyph, px, tint)


func title_text() -> String:
	return _title.text


func body_text() -> String:
	return _body.text
