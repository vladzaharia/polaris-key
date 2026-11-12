class_name PKeyTimeRing
extends Control
## The ring beside "Expires in 4:51": a track and the share of the window's five minutes that is
## left. It is decoration (the minute is read from the text), so it takes no focus or pointer.

const WINDOW_SECONDS := 300.0

## Seconds left of the window.
var seconds_left := 0.0:
	set(value):
		seconds_left = value
		queue_redraw()


func _init() -> void:
	name = "Ring"
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	focus_mode = Control.FOCUS_NONE
	size_flags_vertical = Control.SIZE_SHRINK_CENTER


func _draw() -> void:
	var side := minf(size.x, size.y)
	if side <= 0.0:
		return
	var centre := size / 2.0
	var width := maxf(2.0, side / 8.0)
	var radius := side / 2.0 - width
	var track := get_theme_color("font_color", "PKeyMuted")
	track.a = 0.25
	draw_arc(centre, radius, 0.0, TAU, 48, track, width, true)
	var share := clampf(seconds_left / WINDOW_SECONDS, 0.0, 1.0)
	if share > 0.0:
		draw_arc(
			centre,
			radius,
			-PI / 2.0,
			-PI / 2.0 + TAU * share,
			48,
			get_theme_color("font_color", "PKeyLink"),
			width,
			true
		)
