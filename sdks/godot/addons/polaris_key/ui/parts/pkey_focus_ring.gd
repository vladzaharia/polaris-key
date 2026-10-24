class_name PKeyFocusRing
extends Control
## The focus ring of a multi-line text field on Godot before 4.6, where the engine draws a TextEdit's
## focus style inside the field's own clip and shows four corner wedges at most. `attach()` hides
## the field's own focus style and draws the ring (the theme's `focus` style of TextEdit, its
## 3 px edge) and its glow (fading outlines, outside the field only, so the text is never tinted)
## from a top-level child that no ancestor clips. 4.6 and later draw it right: `attach()` does
## nothing there.

const GLOW_STEPS := 4

var _field: TextEdit


## Whether this engine needs the ring drawn here.
static func needed() -> bool:
	var v := Engine.get_version_info()
	return int(v["major"]) * 100 + int(v["minor"]) < 406


## Draw `field`'s focus ring (when the engine needs it). Returns the ring node or null.
static func attach(field: TextEdit) -> PKeyFocusRing:
	if not needed() or field == null or field.has_meta(&"pkey_ring"):
		return null
	var r := PKeyFocusRing.new()
	r.name = "FocusRing"
	r._field = field
	field.set_meta(&"pkey_ring", r)
	r.top_level = true
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	r.focus_mode = Control.FOCUS_NONE
	r.visible = false
	field.add_child(r, false, Node.INTERNAL_MODE_FRONT)
	field.add_theme_stylebox_override("focus", StyleBoxEmpty.new())
	field.focus_entered.connect(r._sync)
	field.focus_exited.connect(r._sync)
	field.visibility_changed.connect(r._sync)
	return r


func _sync() -> void:
	var on := _field != null and _field.has_focus() and _field.is_visible_in_tree()
	set_process(on)
	if on:
		_follow()
	else:
		visible = false


func _process(_delta: float) -> void:
	_follow()


## The ring node sits over the nearest scrolling ancestor's visible rect (or the field's own rect when
## none clips it) and clips to it, so a field scrolled half out shows only its visible part of the
## ring. It follows the field's own transform and the fade of every ancestor (a dialog's entry).
var _origin := Vector2.ZERO


func _follow() -> void:
	if _field == null or not is_instance_valid(_field):
		return
	var t := _field.get_global_transform()
	var clip := Rect2(t.origin, _field.size * t.get_scale()).grow(24.0 * t.get_scale().x)
	var n := _field.get_parent()
	var a := 1.0
	var c: CanvasItem = _field
	while c != null:
		a *= c.modulate.a * c.self_modulate.a
		c = c.get_parent() as CanvasItem if c.get_parent() is CanvasItem else null
	while n != null:
		if n is ScrollContainer or (n is Control and (n as Control).clip_contents):
			clip = clip.intersection((n as Control).get_global_rect())
		n = n.get_parent()
	clip_contents = true
	position = clip.position
	size = clip.size / t.get_scale()
	scale = t.get_scale()
	_origin = (t.origin - clip.position) / t.get_scale()
	modulate.a = a
	visible = _field.has_focus() and _field.is_visible_in_tree() and clip.has_area()
	queue_redraw()


func _draw() -> void:
	if _field == null:
		return
	var ring := get_theme_stylebox("focus", "TextEdit")
	var colour := Color.WHITE
	var radius := int(PKeyKitTokens.RADIUS_CONTROL)
	if ring is StyleBoxFlat:
		colour = (ring as StyleBoxFlat).border_color
		radius = (ring as StyleBoxFlat).corner_radius_top_left
	var reach := int(PKeyKitTokens.FOCUS_OFFSET + PKeyKitTokens.FOCUS_WIDTH)
	for i in range(GLOW_STEPS, 0, -1):
		var g := StyleBoxFlat.new()
		g.draw_center = false
		g.set_border_width_all(2)
		g.border_color = colour
		g.border_color.a = 0.3 * float(GLOW_STEPS - i + 1) / float(GLOW_STEPS * 3)
		g.set_corner_radius_all(radius + reach + i * 2)
		g.set_expand_margin_all(reach + i * 2)
		draw_style_box(g, Rect2(_origin, _field.size))
	if ring is StyleBoxFlat:
		draw_style_box(ring, Rect2(_origin, _field.size))
