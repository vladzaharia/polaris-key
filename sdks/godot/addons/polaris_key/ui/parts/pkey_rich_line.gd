class_name PKeyRichLine
extends RichTextLabel
## A line of catalog text whose lead-in is bold (`**Cloud Sync** across your devices`). The text is
## never handed to a markup parser: `show_lead()` splits it on `**` (ui-core's `leadParts`) and draws
## each run itself with `push_bold()` and `add_text()`, so a name or an argument that holds `[b]` or
## brackets is drawn as typed. It sizes to its text, takes no focus and no pointer, and follows the
## theme of the label type it stands in for (`PKeyMuted` and so on).

const Holders := preload("res://addons/polaris_key/ui/model/holders.gd")

## The Label type variation whose colour, font and size this line follows ("" is the plain Label).
var variation := ""

var _text := ""
var _styling := false


func _init() -> void:
	bbcode_enabled = false
	fit_content = true
	scroll_active = false
	autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	selection_enabled = false
	context_menu_enabled = false
	shortcut_keys_enabled = false
	focus_mode = Control.FOCUS_NONE
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# A catalog string, already in the running locale.
	set_meta(&"pkey_catalog_text", true)


## Draw `text` (empty hides the line): the runs between `**` pairs bold, everything else as given.
func show_lead(text: String) -> void:
	_text = text
	visible = text != ""
	clear()
	for run in Holders.lead_parts(text):
		if run["strong"]:
			push_bold()
		add_text(String(run["text"]))
		if run["strong"]:
			pop()
	_style()


## What a reader hears and a test compares: the text without its markers.
func plain() -> String:
	return get_parsed_text()


func _notification(what: int) -> void:
	if what == NOTIFICATION_THEME_CHANGED and not _styling:
		_style()


func _style() -> void:
	if _styling or not is_inside_tree():
		return
	_styling = true
	var type := variation if variation != "" else "Label"
	var normal := get_theme_font("font", type)
	var strong := get_theme_font("font", "PKeyStrong")
	var size := get_theme_font_size("font_size", type)
	if normal != null and strong != null and strong == normal:
		# The theme has one weight: embolden it, so the lead-in still stands out.
		var heavy := FontVariation.new()
		heavy.base_font = normal
		heavy.variation_embolden = 0.5  # ui-lint: allow godot-weights a game theme with one weight gets synthetic emphasis on the lead-in
		strong = heavy
	add_theme_color_override(&"default_color", get_theme_color("font_color", type))
	if normal != null:
		add_theme_font_override(&"normal_font", normal)
	if strong != null:
		add_theme_font_override(&"bold_font", strong)  # ui-lint: allow godot-weights push_bold draws the lead-in in the theme's PKeyStrong weight, never a 700
	add_theme_font_size_override(&"normal_font_size", size)
	add_theme_font_size_override(&"bold_font_size", size)
	add_theme_constant_override(&"line_separation", get_theme_constant("line_spacing", type))
	_styling = false
