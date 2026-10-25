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
## Show the name beside the icon. Off, the header is the icon alone: a screen whose title names the
## product ("Tidewater Studio 2.5") says it once (UI-KITS.md DL5).
var name_visible := true:
	set(value):
		if name_visible == value:
			return
		name_visible = value
		if _name != null:
			_name.visible = value
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
## The game's wordmark beside the icon (ProductIdentity.wordmark), on a hero or splash header only;
## it stands in for the name's text, and a header without one is exactly the icon and the name.
var _wordmark: TextureRect
var _wordmark_tex: Texture2D = null
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
## The name's type size before `_fit_name` steps it down for a long word, and the override `_size`
## set for it (0: none, the theme's size).
var _name_size := 0
var _name_override := 0


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
	_wordmark = TextureRect.new()
	_wordmark.name = "Wordmark"
	_wordmark.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_wordmark.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_wordmark.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_wordmark.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_wordmark.visible = false
	add_child(_wordmark)
	_name = Label.new()
	_start = _name.horizontal_alignment
	_name.name = "Name"
	_name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_name.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_name.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_name.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	# The product's name is data, never translated (UI-KITS.md §4.7).
	_name.set_meta(PKeyUiView.DATA_META, true)
	_name.resized.connect(_fit_name)
	resized.connect(_fit_name)
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
	_wordmark_tex = id.get("wordmark") as Texture2D
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
	var mark := _wordmark_tex != null and (hero or splash)
	_wordmark.texture = _wordmark_tex if mark else null
	_wordmark.visible = mark
	# The wordmark is the name drawn: the text steps aside so the product is named once (DL5).
	_name.visible = name_visible and not mark
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


## A product's long name never breaks a word across lines: in a narrow pane the name steps down from
## its type size, to the body size at the least, until its widest word fits the label's width.
## Unspaced CJK breaks between any two characters by design and is left alone.
func _fit_name() -> void:
	if _name == null or _name_size <= 0:
		return
	var want := _name_size
	var w := _name.size.x
	_stack_if_cramped()
	if _stacked:
		w = size.x
	if w > 0.0 and _plain != "":
		var font := _name.get_theme_font("font")
		var body := get_theme_font_size("font_size", "Label") if has_theme_font_size("font_size", "Label") else _name_size
		var least := mini(_name_size, body)
		var words: Array = Array(_plain.split(" ", false)).filter(func(word: String) -> bool: return word.unicode_at(0) < 0x2e80 and word.unicode_at(word.length() - 1) < 0x2e80)
		while want > least and font != null and _widest(font, words, want) > w:
			want -= 1
	# 0: no override, the theme's own size (which follows the screen's scale). Only a change is
	# applied: an override re-lays the label out, which resizes it and calls this again.
	var target := want if want < _name_size else _name_override
	var held := _name.get_theme_font_size("font_size") if _name.has_theme_font_size_override("font_size") else 0
	if target == held:
		return
	if target > 0:
		_name.add_theme_font_size_override("font_size", target)
	else:
		_name.remove_theme_font_size_override("font_size")


## Whether the icon sits over the name because beside it the name's widest word would not fit (a
## host's 28 or 36 px type in a narrow pane); a function of the width, so it follows a live resize.
var _stacked := false


func _stack_if_cramped() -> void:
	if centered or _name == null or _plain == "" or size.x <= 0.0 or _wordmark.visible:
		return
	var font := _name.get_theme_font("font")
	var body := get_theme_font_size("font_size", "Label") if has_theme_font_size("font_size", "Label") else _name_size
	var least := mini(_name_size, body)
	var words: Array = Array(_plain.split(" ", false)).filter(func(word: String) -> bool: return word.unicode_at(0) < 0x2e80 and word.unicode_at(word.length() - 1) < 0x2e80)
	var side := maxf(_icon.custom_minimum_size.x, 0.0) if (_icon.visible or _tile.visible) else 0.0
	var beside := size.x - side - float(get_theme_constant("separation"))
	var stack := font != null and _widest(font, words, least) > beside
	if stack == _stacked:
		return
	_stacked = stack
	vertical = stack
	_name.horizontal_alignment = _start
	_icon.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN if stack else Control.SIZE_FILL
	_tile.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN if stack else Control.SIZE_FILL


static func _widest(font: Font, words: Array, size: int) -> float:
	var most := 0.0
	for word in words:
		most = maxf(most, font.get_string_size(word, HORIZONTAL_ALIGNMENT_LEFT, -1, size).x)
	return most


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
	var mark := _wordmark_tex != null and (hero or splash)
	if mark != _wordmark.visible:
		_show(_icon.texture)
	var which := "hero_icon_size" if hero or splash else ("icon_size_card" if card else "icon_size")
	var side := float(_constant(which)) * (2.0 if splash else 1.0)
	# Beside a large title (a game's own 28 or 36 px type) the icon and the name keep up with it:
	# never a small mark and a small name next to a big title.
	var title_size := float(get_theme_font_size("font_size", "PKeyTitle")) if has_theme_font_size("font_size", "PKeyTitle") else 0.0
	if not splash:
		side = maxf(side, roundf(title_size * 1.0))
	_icon.custom_minimum_size = Vector2(side, side)
	if _wordmark.visible:
		# Beside the icon, two thirds of its height, never wider than five of its sides; centred
		# when the header is.
		var h := roundf(side * 0.66)
		var aspect := float(_wordmark_tex.get_width()) / maxf(1.0, float(_wordmark_tex.get_height()))
		_wordmark.custom_minimum_size = Vector2(minf(h * aspect, side * 5.0), h)
		_wordmark.size_flags_horizontal = Control.SIZE_SHRINK_CENTER if (centered or _stacked) else Control.SIZE_SHRINK_BEGIN
	_tile.custom_minimum_size = Vector2(side, side)
	_name.theme_type_variation = "PKeyTitle" if splash or as_title else ("PKeySection" if hero else "PKeyStrong")
	# The size the label itself resolves (its variation, the host's scale) is the floor: the name is
	# never smaller than the body text, and keeps up with a large title.
	_name.remove_theme_font_size_override("font_size")
	var name_size := float(_name.get_theme_font_size("font_size"))
	_name_override = 0
	if not splash and not as_title and roundf(title_size * 0.5) > name_size:
		_name_override = roundi(title_size * 0.5)
		_name.add_theme_font_size_override("font_size", _name_override)
	_name_size = _name.get_theme_font_size("font_size")
	_fit_name()
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
