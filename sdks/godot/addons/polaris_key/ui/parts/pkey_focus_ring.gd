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
	visible = _field != null and _field.has_focus() and _field.is_visible_in_tree()
	set_process(visible)
	_follow()
	queue_redraw()


func _process(_delta: float) -> void:
	_follow()


## Sit exactly over the field, whatever transform its ancestors carry (a scale tween, a scroll).
func _follow() -> void:
	if _field == null or not is_instance_valid(_field):
		return
	var t := _field.get_global_transform()
	position = t.origin
	rotation = t.get_rotation()
	scale = t.get_scale()
	if size != _field.size:
		size = _field.size
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
		draw_style_box(g, Rect2(Vector2.ZERO, size))
	if ring is StyleBoxFlat:
		draw_style_box(ring, Rect2(Vector2.ZERO, size))
