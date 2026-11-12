class_name PKeyPairCode
extends RichTextLabel
## The pairing code on the show screen: eight digits as two groups of four, the largest text on the
## screen, drawn in the theme's `PKeyCode` type. The digits that changed in the last rotation are lit
## in the accent colour (and bold), so a wrong guess that changed the code is seen, not only read.
## The text is never parsed as markup: the digits are drawn one run at a time.

## The digit positions (0-8, the space counted) that are lit.
var lit: Array = []

var _text := ""
var _styling := false
## The type size the code was stepped down to so it fits (0: the theme's own size).
var _fit_size := 0


func _init() -> void:
	name = "Code"
	bbcode_enabled = false
	fit_content = true
	scroll_active = false
	autowrap_mode = TextServer.AUTOWRAP_OFF
	selection_enabled = false
	context_menu_enabled = false
	shortcut_keys_enabled = false
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	set_meta(&"pkey_data", true)
	# The tile takes focus for a screen reader when the control that was pressed left the page.
	focus_mode = accessibility_focus() as Control.FocusMode


## The engine's accessibility-only focus mode (4.5 and later; a reader can land on the control, the
## keyboard and a pad cannot), else none.
static func accessibility_focus() -> int:
	if ClassDB.class_has_integer_constant("Control", "FOCUS_ACCESSIBILITY"):
		return ClassDB.class_get_integer_constant("Control", "FOCUS_ACCESSIBILITY")
	return Control.FOCUS_NONE


## Move the focus to `c` for a screen reader, which is the only thing that can land on an
## accessibility-only control (the engine warns about any other).
static func focus_for_reader(c: Control) -> void:
	if (
		c.is_inside_tree()
		and c.get_tree().is_accessibility_enabled()
		and c.focus_mode != Control.FOCUS_NONE
	):
		c.grab_focus()


## Draw `code` ("4812 3456") with the positions in `positions` lit; empty hides the code.
func show_code(code: String, positions: Array = []) -> void:
	_text = code
	lit = positions
	visible = code != ""
	_draw_runs()


## What a reader hears and a test compares: the code as shown.
func plain() -> String:
	return get_parsed_text()


func _draw_runs() -> void:
	clear()
	_style()
	var light := _theme_color("PKeyLink", ink_color())
	for i in _text.length():
		var on := lit.has(i)
		if on:
			push_color(light)
			push_bold()
		add_text(_text[i])
		if on:
			pop()
			pop()


## The code's own colour: the theme's `PKeyCode` when it has one (the kit looks), else the plain text
## colour of a Label in this theme (a game's own look has no PKeyCode type, and the engine's fallback is
## black).
func ink_color() -> Color:
	return _theme_color("PKeyCode", get_theme_color("font_color", "Label"))


func _theme_color(type: String, fallback: Color) -> Color:
	return get_theme_color("font_color", type) if has_theme_color("font_color", type) else fallback


func _notification(what: int) -> void:
	if what == NOTIFICATION_THEME_CHANGED and not _styling and _text != "":
		_draw_runs()


func _style() -> void:
	if _styling:
		return
	_styling = true
	var font := get_theme_font("font", "PKeyCode")
	var size := _fit_size if _fit_size > 0 else get_theme_font_size("font_size", "PKeyCode")
	add_theme_color_override(&"default_color", ink_color())
	if font != null:
		add_theme_font_override(&"normal_font", font)
		add_theme_font_override(&"bold_font", font)
	add_theme_font_size_override(&"normal_font_size", size)
	add_theme_font_size_override(&"bold_font_size", size)
	_styling = false


## Step the type down (to 14) until the code fits `room` on one line; the theme's size comes back when
## it does. With `grow` above the theme's size the code is made as large as `grow` and the room allow
## (the hero of a screen read across the room).
func fit_to(room: float, grow := 0.0) -> void:
	if _text == "":
		return
	var natural := get_theme_font_size("font_size", "PKeyCode")
	var font := get_theme_font("font", "PKeyCode")
	var size := maxi(natural, int(grow))
	while size > 14 and font.get_string_size(_text, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x > room:
		size -= 2
	var want := 0 if size == natural else size
	if want == _fit_size:
		return
	_fit_size = want
	_draw_runs()
