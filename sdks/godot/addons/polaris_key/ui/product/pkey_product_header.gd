class_name PKeyProductHeader
extends BoxContainer
## The product's identity at the head of a kit screen (UI-KITS.md §1.2, the product is the hero):
## its icon, or a monogram tile of its initial when it has none, beside its name. Never a Polaris
## Key mark. `hero` sizes it to lead a screen (the gate's and the boot's identity, the theme's
## `hero_icon_size` and the section type step); otherwise it is the small header of a focused step
## (`icon_size`, the body type in the strong colour). `centered` stacks the icon over the name,
## both centred, for a centred column (a portrait screen, the boot splash).
##
## The identity is PKeyUiTheme.product_identity(): PKeyOptions.ui_product_name and
## ui_product_icon, else the project's `application/config/name` and `application/config/icon`.
## Sizes follow the theme (its PKeyLayout constants), so the header scales with the screen.

## Lead a screen (larger icon, section-sized name) rather than head a step.
var hero := false:
	set(value):
		hero = value
		_size()
## Lead a splash (the boot screen): twice the hero icon, the name in the title type.
var splash := false:
	set(value):
		splash = value
		_size()
## Stack the icon over the name, centred (else the icon beside the name, leading).
var centered := false:
	set(value):
		if centered == value:
			return
		centered = value
		vertical = value
		alignment = BoxContainer.ALIGNMENT_CENTER if value else BoxContainer.ALIGNMENT_BEGIN
		if _name != null:
			_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER if value else HORIZONTAL_ALIGNMENT_LEFT
			_icon.size_flags_horizontal = Control.SIZE_SHRINK_CENTER if value else Control.SIZE_FILL
			_tile.size_flags_horizontal = Control.SIZE_SHRINK_CENTER if value else Control.SIZE_FILL

var _icon: TextureRect
var _tile: PanelContainer
var _initial: Label
var _name: Label


func _init() -> void:
	vertical = false
	theme_type_variation = "PKeyRow"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	alignment = BoxContainer.ALIGNMENT_BEGIN
	_icon = TextureRect.new()
	_icon.name = "Icon"
	_icon.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_icon.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_icon.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	add_child(_icon)
	_tile = PanelContainer.new()
	_tile.name = "Monogram"
	_tile.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_tile.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	add_child(_tile)
	_initial = Label.new()
	_initial.name = "Initial"
	_initial.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_initial.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_initial.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_initial.set_meta(PKeyUiView.DATA_META, true)
	_tile.add_child(_initial)
	_name = Label.new()
	_name.name = "Name"
	_name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_name.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_name.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_name.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	# The product's name is data, never translated (UI-KITS.md §4.7).
	_name.set_meta(PKeyUiView.DATA_META, true)
	add_child(_name)
	refresh()


func _notification(what: int) -> void:
	if what == NOTIFICATION_THEME_CHANGED:
		_size()


## Read the identity again (after PKeyUiTheme.apply_options()).
func refresh() -> void:
	var id := PKeyUiTheme.product_identity()
	var title: String = id["name"]
	var icon: Texture2D = id["icon"]
	_name.text = title
	_icon.texture = icon
	_icon.visible = icon != null
	_tile.visible = icon == null and title != ""
	_initial.text = title.strip_edges().left(1).to_upper()
	visible = title != "" or icon != null
	_size()


## The product's name as shown.
func product_name() -> String:
	return _name.text


func _size() -> void:
	if _name == null:
		return
	var side := float(_constant("hero_icon_size" if hero or splash else "icon_size")) * (2.0 if splash else 1.0)
	_icon.custom_minimum_size = Vector2(side, side)
	_tile.custom_minimum_size = Vector2(side, side)
	_name.theme_type_variation = "PKeyTitle" if splash else ("PKeySection" if hero else "PKeyStrong")
	var ink := get_theme_color("font_color", "PKeyTitle") if has_theme_color("font_color", "PKeyTitle") else get_theme_color("font_color", "Label")
	var tile := StyleBoxFlat.new()
	tile.bg_color = Color(ink, 0.12)
	tile.set_corner_radius_all(roundi(side * 0.24))
	_tile.add_theme_stylebox_override("panel", tile)
	_initial.add_theme_font_size_override("font_size", maxi(8, roundi(side * 0.5)))
	_initial.add_theme_color_override("font_color", ink)
	var bold := get_theme_font("font", "PKeyTitle") if has_theme_font("font", "PKeyTitle") else null
	if bold != null:
		_initial.add_theme_font_override("font", bold)


func _constant(n: StringName) -> int:
	if has_theme_constant(n, PKeyUiTheme.LAYOUT_TYPE):
		return get_theme_constant(n, PKeyUiTheme.LAYOUT_TYPE)
	return PKeyUiTheme.MEASURES.get(n, 40)
