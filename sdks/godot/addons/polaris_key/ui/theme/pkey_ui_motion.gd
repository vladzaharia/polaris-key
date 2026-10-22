class_name PKeyUiMotion
extends RefCounted
## The kit's motion (UI-KITS.md §4.8, SIGN-IN.md §3.18): a dialog over the game fades in, a pressed
## button settles to 98 %. Durations are the kit tokens (PKeyKitTokens.MOTION_*). Every call is a
## no-op under `PKeyUiTheme.reduce_motion()` (DL16): the state is already in place, no tween runs.
## Only alpha and scale move, never a position or a size, so a container's layout and the
## measures the `ui_matrix` suite takes do not change while a tween runs.

const ENTER_META := &"pkey_enter_tween"
const PRESS_META := &"pkey_press_tween"


## Fade the dialog `view` in over MOTION_SHEET_IN_MS. Call it when the dialog is shown.
static func enter(view: Control) -> void:
	if view == null or not view.is_inside_tree():
		return
	_kill(view, ENTER_META)
	if PKeyUiTheme.reduce_motion():
		view.modulate.a = 1.0
		return
	view.modulate.a = 0.0
	var tw := view.create_tween()
	tw.tween_property(view, "modulate:a", 1.0, PKeyKitTokens.MOTION_SHEET_IN_MS / 1000.0).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	view.set_meta(ENTER_META, tw)


## Settle a button to PRESS_SCALE while it is held and back on release (MOTION_PRESS_MS).
static func press(b: Control, down: bool) -> void:
	if b == null or not b.is_inside_tree() or PKeyUiTheme.reduce_motion():
		return
	_kill(b, PRESS_META)
	b.pivot_offset = b.size / 2.0
	var to := Vector2.ONE * (PKeyKitTokens.PRESS_SCALE if down else 1.0)
	var tw := b.create_tween()
	tw.tween_property(b, "scale", to, PKeyKitTokens.MOTION_PRESS_MS / 1000.0).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	b.set_meta(PRESS_META, tw)


static func _kill(n: Node, key: StringName) -> void:
	if not n.has_meta(key):
		return
	var prev = n.get_meta(key)
	if prev is Tween and (prev as Tween).is_valid():
		(prev as Tween).kill()
