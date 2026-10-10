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
## ui_product_icon, else the product's presentation from discovery (its name and verified icon),
## else the project's `application/config/name` and `application/config/icon`. Sizes follow the
## theme (its PKeyLayout constants), so the header scales with the screen. A presented icon is
## asked for at the size this header draws it (`PKeyPresentationSource.icon(side, screen scale)`);
## the texture shown stays until that one resolves. The name is drawn bidi-isolated
## (PKeyUiTheme.isolate); `product_name()` is the plain name.

## Lead a screen (larger icon, section-sized name) rather than head a step.
var hero := false:
	set(value):
		hero = value
		_size()
## The product's icon on a card of its own (an update, the settings): 56 px at scale 1.
var card := false:
	set(value):
		card = value
		_size()
## The name in the title type, for a pane that names the product as its title.
var as_title := false:
	set(value):
		as_title = value
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
			# Back to the label's own start alignment (mirrored with the layout direction).
			_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER if value else _start
			_icon.size_flags_horizontal = Control.SIZE_SHRINK_CENTER if value else Control.SIZE_FILL
			_tile.size_flags_horizontal = Control.SIZE_SHRINK_CENTER if value else Control.SIZE_FILL

var _icon: TextureRect
var _tile: PanelContainer
var _initial: Label
var _name: Label
var _start: HorizontalAlignment
## The plain name shown, the presented icon this header fetched (and that icon's hash), and the
## request it last made ("<sha>|<side>|<scale>").
var _plain := ""
var _fetched: Texture2D = null
var _fetched_sha := ""
var _asked := ""


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
	_start = _name.horizontal_alignment
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
	if _presented() and _fetched != null and _fetched_sha == PKeyUiTheme.presentation_icon_sha:
		icon = _fetched
	_plain = title
	_name.text = PKeyUiTheme.isolate(title)
	_initial.text = initial_of(title)
	_show(icon)
	_size()


## The product's name as shown (without the bidi isolates the label draws around it).
func product_name() -> String:
	return _plain


func _show(icon: Texture2D) -> void:
	_icon.texture = icon
	_icon.visible = icon != null
	_tile.visible = icon == null and _plain != ""
	visible = _plain != "" or icon != null


## True when the icon comes from the product's presentation (the integrator set none).
func _presented() -> bool:
	return PKeyUiTheme.product_icon == null and PKeyUiTheme.presentation != null and PKeyUiTheme.presentation_icon_sha != ""


## Ask the presentation for the icon at `side` logical pixels on this screen's scale, once per size.
func _request_icon(side: float) -> void:
	if not _presented() or side <= 0.0:
		return
	var k := _screen_scale()
	var sha := PKeyUiTheme.presentation_icon_sha
	var key := "%s|%d|%.3f" % [sha, roundi(side), k]
	if key == _asked:
		return
	_asked = key
	PKeyUiTheme.presentation.icon_to(side, k, _on_icon.bind(key, sha))


func _on_icon(tex: ImageTexture, key: String, sha: String) -> void:
	if tex == null or key != _asked or sha != PKeyUiTheme.presentation_icon_sha or not _presented():
		return
	_fetched = tex
	_fetched_sha = sha
	_show(tex)


## Physical pixels per logical one where this header draws (the window's stretch and any scale
## above it); 1 outside the tree.
func _screen_scale() -> float:
	if not is_inside_tree():
		return 1.0
	var s := get_screen_transform().get_scale()
	var k := maxf(absf(s.x), absf(s.y))
	return k if is_finite(k) and k > 0.0 else 1.0


## The monogram's letter: the name's first character that is not a space, a bidi control or a
## zero-width mark.
static func initial_of(title: String) -> String:
	for i in title.length():
		var c := title.unicode_at(i)
		if c == 0x20 or c == 0xa0 or c == 0x61c or c == 0xfeff or (c >= 0x200b and c <= 0x200f) or (c >= 0x202a and c <= 0x202e) or (c >= 0x2066 and c <= 0x2069):
			continue
		return title.substr(i, 1)
	return ""


func _size() -> void:
	if _name == null:
		return
	var which := "hero_icon_size" if hero or splash else ("icon_size_card" if card else "icon_size")
	var side := float(_constant(which)) * (2.0 if splash else 1.0)
	# Beside a large title (a game's own 28 or 36 px type) the icon and the name keep up with it:
	# never a small mark and a small name next to a big title.
	var title_size := float(get_theme_font_size("font_size", "PKeyTitle")) if has_theme_font_size("font_size", "PKeyTitle") else 0.0
	if not splash:
		side = maxf(side, roundf(title_size * 1.0))
	_icon.custom_minimum_size = Vector2(side, side)
	_tile.custom_minimum_size = Vector2(side, side)
	_name.theme_type_variation = "PKeyTitle" if splash or as_title else ("PKeySection" if hero else "PKeyStrong")
	# The size the label itself resolves (its variation, the host's scale) is the floor: the name is
	# never smaller than the body text, and keeps up with a large title.
	_name.remove_theme_font_size_override("font_size")
	var name_size := float(_name.get_theme_font_size("font_size"))
	if not splash and not as_title and roundf(title_size * 0.5) > name_size:
		_name.add_theme_font_size_override("font_size", roundi(title_size * 0.5))
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
	_request_icon(side)


func _constant(n: StringName) -> int:
	if has_theme_constant(n, PKeyUiTheme.LAYOUT_TYPE):
		return get_theme_constant(n, PKeyUiTheme.LAYOUT_TYPE)
	return PKeyUiTheme.MEASURES.get(n, 40)
