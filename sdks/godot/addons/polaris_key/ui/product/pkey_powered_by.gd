class_name PKeyPoweredBy
extends BoxContainer
## The optional "Powered by Polaris Locker" attribution (UI-KITS.md §1.6, LK-00 §14.2): the Locker
## micro mark at 16 px and the phrase in live text (`line`), or the Locker `powered-by` badge at its
## 320 x 104 minimum where 320 px are free, else the line (`badge`). Never cropped, never smaller.
## Shown only when `PKeyUiTheme.powered_by` is on; the art is PKeyBrandMarks (the Locker kit's own
## SVGs, rasterised at 2x). `texture` is the art being drawn, or null when nothing is shown, so a
## screen that makes room for the attribution asks `texture == null` and `custom_minimum_size`.

## The art in use: the badge, the micro mark, or null (off or not rasterised).
var texture: Texture2D = null

var _mark: TextureRect
var _label: Label
var _badge: TextureRect
## The phrase, from the screen's copy, and the ground, kept to draw again when the room changes.
var _phrase := PKeyBrand.POWERED_BY_PHRASE
var _dark := true


func _init() -> void:
	vertical = false
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	alignment = BoxContainer.ALIGNMENT_CENTER
	visible = false
	_mark = _rect("Mark")
	_label = Label.new()
	_label.name = "Phrase"
	_label.theme_type_variation = "PKeyMuted"
	_label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_label.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_badge = _rect("Badge")
	add_child(_mark)
	add_child(_label)
	add_child(_badge)
	tooltip_text = PKeyBrand.POWERED_BY_PHRASE
	if "accessibility_name" in self:
		set("accessibility_name", PKeyBrand.POWERED_BY_PHRASE)


func _rect(node_name: String) -> TextureRect:
	var r := TextureRect.new()
	r.name = node_name
	r.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	r.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	r.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	return r


## Draw (or hide) the attribution for the theme's state: `phrase` is the catalog's
## "part.poweredBy", `dark` the ground, `free_width` the width the screen leaves for it.
func render(phrase: String, dark: bool, free_width: float) -> void:
	_phrase = phrase if phrase != "" else PKeyBrand.POWERED_BY_PHRASE
	_dark = dark
	var parent := get_parent_control()
	if parent != null and not parent.resized.is_connected(_refit):
		parent.resized.connect(_refit)
	var style := PKeyUiTheme.powered_by_style()
	if style == "":
		texture = null
		visible = false
		return
	var use_badge := style == "badge" and free_width >= float(PKeyBrand.BADGE_MIN.x)
	_badge.visible = use_badge
	_mark.visible = not use_badge
	_label.visible = not use_badge
	if use_badge:
		texture = PKeyUiTheme.powered_by_texture(dark)
		_badge.texture = texture
		_badge.custom_minimum_size = PKeyUiTheme.powered_by_size()
	else:
		texture = PKeyUiTheme.micro_mark_texture(dark)
		_mark.texture = texture
		var side := float(PKeyBrand.POWERED_BY_MARK_SIZE)
		_mark.custom_minimum_size = Vector2(side, side)
		_label.text = _phrase
	custom_minimum_size = _badge.custom_minimum_size if use_badge else Vector2(0, float(PKeyBrand.POWERED_BY_MARK_SIZE))
	tooltip_text = _phrase
	if "accessibility_name" in self:
		set("accessibility_name", _phrase)
	visible = texture != null


## The parent was resized: swap the badge and the line when 320 px became free or stopped being.
func _refit() -> void:
	var parent := get_parent_control()
	if parent == null or PKeyUiTheme.powered_by_style() != "badge":
		return
	var want_badge := parent.size.x >= float(PKeyBrand.BADGE_MIN.x)
	if want_badge != _badge.visible:
		render(_phrase, _dark, parent.size.x)
