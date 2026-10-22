class_name PKeyCountdownRing
extends Control
## The determinate countdown ring (UI-KITS.md §1.5 rule 4): a wait with a known end, a sign-in
## code's lifetime, drains linearly in the accent beside the time. 20 logical px with a 2 px stroke
## (`side` and `stroke`, set by the screen for its scale). It draws a still arc: the owner sets
## `fraction` (the share left, 1 down to 0) as often as the time changes, once a second for a code,
## which is also what reduced motion asks for (DL16: the countdown steps once a second).

## The share of the wait that is left: 1 full, 0 empty.
var fraction := 1.0:
	set(value):
		value = clampf(value, 0.0, 1.0)
		if is_equal_approx(value, fraction):
			return
		fraction = value
		queue_redraw()
## The ring's side and its stroke, in physical pixels of the screen it draws on.
var side := 20.0:
	set(value):
		side = value
		custom_minimum_size = Vector2(side, side)
		queue_redraw()
var stroke := 2.0:
	set(value):
		stroke = value
		queue_redraw()


func _init() -> void:
	name = "Ring"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	size_flags_vertical = Control.SIZE_SHRINK_CENTER
	custom_minimum_size = Vector2(side, side)


func _notification(what: int) -> void:
	if what == NOTIFICATION_THEME_CHANGED:
		queue_redraw()


func _draw() -> void:
	var color := get_theme_color("font_color", "PKeyLink")
	var r := maxf((minf(size.x, size.y) - stroke) * 0.5, 1.0)
	var c := size * 0.5
	# The part already gone, faint; the part left, solid, from twelve o'clock round to where it ends.
	draw_arc(c, r, 0.0, TAU, 48, Color(color, 0.22), stroke, true)
	if fraction > 0.0:
		draw_arc(c, r, -PI * 0.5, -PI * 0.5 + TAU * fraction, 48, color, stroke, true)
