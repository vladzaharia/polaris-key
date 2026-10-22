class_name PKeyInputGlyphs
extends Control
## One input glyph: monochrome and filled, drawn in the label colour (UI-KITS.md §4.3 "Input"). It
## shows the confirm or back control of the last input device, and honours the confirm swap: where
## the engine swaps accept and cancel (`DisplayServer.get_swap_cancel_ok()`, Japanese consoles
## and Switch), confirm reads B and back reads A on a pad, and a PlayStation pad draws a circle
## for confirm where it would draw a cross.
##
##   var g := PKeyInputGlyphs.new()
##   g.action = &"confirm"       # or &"back"
##   g.kind = &"pad"             # &"keyboard" or &"pad"; PKeyInputGlyphs.last_kind() follows play
##   add_child(g)

const CONFIRM := &"confirm"
const BACK := &"back"
const KEYBOARD := &"keyboard"
const PAD := &"pad"

## Tests: replaces the engine's swap flag (null: ask the engine).
static var swap_override: Variant = null
## Tests: the pad's family, "xbox" or "playstation" (null: read the first connected pad's name).
static var family_override: Variant = null

@export var action: StringName = CONFIRM:
	set(value):
		action = value
		update_minimum_size()
		queue_redraw()
@export var kind: StringName = KEYBOARD:
	set(value):
		kind = value
		update_minimum_size()
		queue_redraw()


## Whether accept and cancel are swapped on this device.
static func confirm_swapped() -> bool:
	if swap_override != null:
		return bool(swap_override)
	return DisplayServer.has_method("get_swap_cancel_ok") and bool(DisplayServer.call("get_swap_cancel_ok"))


## "xbox" (letters) or "playstation" (shapes) from the first connected pad's name.
static func pad_family() -> String:
	if family_override != null:
		return String(family_override)
	for id in Input.get_connected_joypads():
		var n := Input.get_joy_name(id).to_lower()
		if n.contains("playstation") or n.contains("dualsense") or n.contains("dualshock") or n.begins_with("ps"):
			return "playstation"
		return "xbox"
	return "xbox"


## The text the glyph carries: "Enter", "Esc", a letter, or "" for a PlayStation shape.
static func label_for(act: StringName, k: StringName) -> String:
	if k == PAD:
		var swapped := confirm_swapped()
		if pad_family() == "playstation":
			return ""
		var east := act == CONFIRM and swapped or act == BACK and not swapped
		return "B" if east else "A"
	return "Enter" if act == CONFIRM else "Esc"


## The shape a PlayStation glyph draws: "cross" or "circle" ("" for any other).
static func shape_for(act: StringName, k: StringName) -> String:
	if k != PAD or pad_family() != "playstation":
		return ""
	var circle := act == CONFIRM and confirm_swapped() or act == BACK and not confirm_swapped()
	return "circle" if circle else "cross"


## The name a screen reader speaks.
static func spoken(act: StringName, k: StringName) -> String:
	var l := label_for(act, k)
	return l if l != "" else shape_for(act, k)


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	focus_mode = Control.FOCUS_NONE
	_name_it()


func _name_it() -> void:
	tooltip_text = ""
	if "accessibility_name" in self:
		set("accessibility_name", spoken(action, kind))


func _side() -> float:
	return PKeyKitTokens.CONTROL_HEIGHT * 0.5 * _unit()


func _unit() -> float:
	var f := get_theme_font_size("font_size", "Label")
	return float(f) / 18.0 if f > 0 else 1.0


func _get_minimum_size() -> Vector2:
	var s := _side()
	if kind == KEYBOARD:
		var f := get_theme_font("font", "Label")
		var w := f.get_string_size(label_for(action, kind), HORIZONTAL_ALIGNMENT_CENTER, -1, int(s * 0.5)).x
		return Vector2(maxf(s, w + s * 0.6), s)
	return Vector2(s, s)


func _draw() -> void:
	_name_it()
	var fill := get_theme_color("font_color", "Label")
	var ink := Color.BLACK if fill.get_luminance() > 0.5 else Color.WHITE
	var sz := size
	var s := minf(sz.x, sz.y)
	var f := get_theme_font("font", "Label")
	var fs := int(s * 0.5)
	var text := label_for(action, kind)
	if kind == KEYBOARD:
		var r := s * 0.28
		var sb := StyleBoxFlat.new()
		sb.bg_color = fill
		sb.set_corner_radius_all(int(r))
		draw_style_box(sb, Rect2(Vector2.ZERO, sz))
	else:
		draw_circle(sz / 2.0, s / 2.0, fill)
	if text != "":
		var ts := f.get_string_size(text, HORIZONTAL_ALIGNMENT_CENTER, -1, fs)
		var asc := f.get_ascent(fs)
		draw_string(f, Vector2(0.0, (sz.y - ts.y) / 2.0 + asc), text, HORIZONTAL_ALIGNMENT_CENTER, sz.x, fs, ink)
	else:
		var c := sz / 2.0
		var d := s * 0.2
		if shape_for(action, kind) == "circle":
			draw_arc(c, d, 0.0, TAU, 32, ink, maxf(2.0, s * 0.08), true)
		else:
			var w := maxf(2.0, s * 0.08)
			draw_line(c + Vector2(-d, -d), c + Vector2(d, d), ink, w, true)
			draw_line(c + Vector2(-d, d), c + Vector2(d, -d), ink, w, true)
