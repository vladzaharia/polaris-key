class_name PKeyInputGlyphs
extends Control
## One input glyph: monochrome and filled, drawn in the label colour (UI-KITS.md §4.3 "Input"). It
## shows the confirm or back control of the last input device. On a pad the button is the one bound
## to `ui_accept` or `ui_cancel` in the InputMap (the kit binds south and east when the game binds
## none), so a game that remaps them is followed and a default map is never swapped: south is A on
## an Xbox pad, a cross on a PlayStation pad, B on a Nintendo pad. The pad family is the last pad
## used (`last_pad_device`, which the kit's views keep), else the first connected.
##
##   var g := PKeyInputGlyphs.new()
##   g.action = &"confirm"       # or &"back"
##   g.kind = &"pad"             # &"keyboard" or &"pad"
##   add_child(g)

const CONFIRM := &"confirm"
const BACK := &"back"
const KEYBOARD := &"keyboard"
const PAD := &"pad"

## The pad that sent the last button or stick input; -1 before any.
static var last_pad_device := -1
## Tests: the pad's family, "xbox", "playstation" or "nintendo" (null: read the pad's name).
static var family_override: Variant = null

## The least letter size, logical px: the hint floor.
const LETTER_FLOOR := 17

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


## The joypad button (JOY_BUTTON_*) bound to `act`'s UI action: the first InputEventJoypadButton of
## `ui_accept` or `ui_cancel`, else south for confirm and east for back.
static func pad_button(act: StringName) -> int:
	var action_name := &"ui_accept" if act == CONFIRM else &"ui_cancel"
	if InputMap.has_action(action_name):
		for e in InputMap.action_get_events(action_name):
			if e is InputEventJoypadButton:
				return (e as InputEventJoypadButton).button_index
	return JOY_BUTTON_A if act == CONFIRM else JOY_BUTTON_B


## "xbox", "playstation" or "nintendo", from the name of the last pad used.
static func pad_family() -> String:
	if family_override != null:
		return String(family_override)
	var id := last_pad_device
	if id < 0 or not Input.get_connected_joypads().has(id):
		var pads := Input.get_connected_joypads()
		if pads.is_empty():
			return "xbox"
		id = pads[0]
	var n := Input.get_joy_name(id).to_lower()
	if n.contains("playstation") or n.contains("dualsense") or n.contains("dualshock") or n.begins_with("ps"):
		return "playstation"
	if n.contains("nintendo") or n.contains("switch") or n.contains("joy-con") or n.contains("joycon"):
		return "nintendo"
	return "xbox"


## The text the glyph carries: a key's text ("Enter", "Esc"…), a pad letter, or "" for a PlayStation shape.
static func label_for(act: StringName, k: StringName) -> String:
	if k != PAD:
		return key_label(act)
	var b := pad_button(act)
	match pad_family():
		"playstation":
			return ""
		"nintendo":
			# Positional buttons: the south button is printed B, the east one A.
			return {JOY_BUTTON_A: "B", JOY_BUTTON_B: "A", JOY_BUTTON_X: "Y", JOY_BUTTON_Y: "X"}.get(b, "")
	return {JOY_BUTTON_A: "A", JOY_BUTTON_B: "B", JOY_BUTTON_X: "X", JOY_BUTTON_Y: "Y"}.get(b, "")


## The shape a PlayStation glyph draws ("cross", "circle", "square", "triangle"), else "".
static func shape_for(act: StringName, k: StringName) -> String:
	if k != PAD or pad_family() != "playstation":
		return ""
	return {JOY_BUTTON_A: "cross", JOY_BUTTON_B: "circle", JOY_BUTTON_X: "square", JOY_BUTTON_Y: "triangle"}.get(pad_button(act), "")


## The keycap text of the keyboard key bound to `ui_accept` or `ui_cancel` ("Enter", "Esc", "Space",
## "E"…): the first InputEventKey of the action, else Enter and Esc.
static func key_label(act: StringName) -> String:
	var action_name := &"ui_accept" if act == CONFIRM else &"ui_cancel"
	if InputMap.has_action(action_name):
		for e in InputMap.action_get_events(action_name):
			if e is InputEventKey:
				var k := e as InputEventKey
				var code := k.keycode if k.keycode != KEY_NONE else k.physical_keycode
				if code == KEY_ESCAPE:
					return "Esc"
				if code != KEY_NONE:
					var t := OS.get_keycode_string(code)
					if t != "":
						return t
	return "Enter" if act == CONFIRM else "Esc"


## Whether there is a glyph to draw: a keyboard always, a pad only when the bound button is one of
## the four face buttons (a shoulder or Start has no glyph here, and none is better than a wrong one).
static func has_glyph(act: StringName, k: StringName) -> bool:
	return k != PAD or spoken(act, k) != ""


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


func _unit() -> float:
	var f := get_theme_font_size("font_size", "Label")
	return float(f) / 18.0 if f > 0 else 1.0


func _letter() -> int:
	return maxi(LETTER_FLOOR, int(PKeyKitTokens.CONTROL_HEIGHT * 0.5 * _unit() * 0.58))


func _side() -> float:
	return maxf(PKeyKitTokens.CONTROL_HEIGHT * 0.5 * _unit(), float(_letter()) * 1.7)


func _get_minimum_size() -> Vector2:
	var s := _side()
	if kind == KEYBOARD:
		var f := get_theme_font("font", "Label")
		var w := f.get_string_size(label_for(action, kind), HORIZONTAL_ALIGNMENT_CENTER, -1, _letter()).x
		return Vector2(maxf(s, w + s * 0.6), s)
	return Vector2(s, s)


func _draw() -> void:
	_name_it()
	if not has_glyph(action, kind):
		return
	# A raised neutral disc (or keycap) in the text colour at a low alpha, the letter and shape in the
	# text colour: quiet beside the buttons, readable on dark and light.
	var fg := get_theme_color("font_color", "Label")
	var sz := size
	var s := minf(sz.x, sz.y)
	var f := get_theme_font("font", "Label")
	var fs := _letter()
	var text := label_for(action, kind)
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(fg, 0.16)
	sb.border_color = Color(fg, 0.34)
	sb.set_border_width_all(1)
	sb.set_corner_radius_all(int(s * 0.28) if kind == KEYBOARD else int(s))
	draw_style_box(sb, Rect2(Vector2.ZERO, sz))
	if text != "":
		var ts := f.get_string_size(text, HORIZONTAL_ALIGNMENT_CENTER, -1, fs)
		draw_string(f, Vector2(0.0, (sz.y - ts.y) / 2.0 + f.get_ascent(fs)), text, HORIZONTAL_ALIGNMENT_CENTER, sz.x, fs, fg)
		return
	var c := sz / 2.0
	var d := s * 0.2
	var w := maxf(2.0, s * 0.08)
	match shape_for(action, kind):
		"circle":
			draw_arc(c, d, 0.0, TAU, 32, fg, w, true)
		"square":
			draw_rect(Rect2(c - Vector2(d, d), Vector2(d, d) * 2.0), fg, false, w)
		"triangle":
			var pts := PackedVector2Array([c + Vector2(0, -d), c + Vector2(d, d * 0.8), c + Vector2(-d, d * 0.8), c + Vector2(0, -d)])
			draw_polyline(pts, fg, w, true)
		_:
			draw_line(c + Vector2(-d, -d), c + Vector2(d, d), fg, w, true)
			draw_line(c + Vector2(-d, d), c + Vector2(d, -d), fg, w, true)
