class_name PKeyUiMotion
extends RefCounted
## The kit's motion (UI-KITS.md §4.8, SIGN-IN.md §3.18): a dialog over the game fades in from 98 %
## scale, a pressed button settles to 98 %. Durations are the kit tokens (PKeyKitTokens.MOTION_*).
## Every call is a no-op under `PKeyUiTheme.reduce_motion()` (DL16): the state is already in place.
## Only alpha and scale move, never a position or a size, so a container's layout does not change.
## The tweens ignore `Engine.time_scale`: a game that pauses or slows with it still gets a visible
## dialog, because the dialog holds the input.

const ENTER_META := &"pkey_enter_tween"
const PRESS_META := &"pkey_press_tween"
const ENTER_SCALE := 0.98
## Frames to wait after a dialog is shown before the fade starts: the frame that built it takes
## long, and a tween would spend that frame's delta at once.
const SETTLE_FRAMES := 2


## Fade the dialog `view` in over MOTION_SHEET_IN_MS, starting after it has been drawn once.
## Call it when the dialog is shown (a coroutine; callers need not await it).
static func enter(view: Control) -> void:
	if view == null or not view.is_inside_tree():
		return
	_kill(view, ENTER_META)
	if PKeyUiTheme.reduce_motion():
		view.modulate.a = 1.0
		view.scale = Vector2.ONE
		return
	view.modulate.a = 0.0
	view.pivot_offset = view.size / 2.0
	view.scale = Vector2.ONE * ENTER_SCALE
	var token := Time.get_ticks_usec()
	view.set_meta(ENTER_META, token)
	var tree := view.get_tree()
	for i in SETTLE_FRAMES:
		await tree.process_frame
		if not _live(view, token):
			return
	view.pivot_offset = view.size / 2.0
	var tw := view.create_tween()
	tw.set_ignore_time_scale(true)
	tw.set_parallel(true)
	var s := PKeyKitTokens.MOTION_SHEET_IN_MS / 1000.0
	tw.tween_property(view, "modulate:a", 1.0, s).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(view, "scale", Vector2.ONE, s).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	view.set_meta(ENTER_META, tw)


## Put a dialog that closed back as it was (a pending or running fade is dropped).
static func cancel(view: Control) -> void:
	if view == null or not is_instance_valid(view):
		return
	_kill(view, ENTER_META)
	view.modulate.a = 1.0
	view.scale = Vector2.ONE


## Settle a button to PRESS_SCALE while it is held and back on release (MOTION_PRESS_MS).
static func press(b: Control, down: bool) -> void:
	if b == null or not b.is_inside_tree() or PKeyUiTheme.reduce_motion():
		return
	_kill(b, PRESS_META)
	b.pivot_offset = b.size / 2.0
	var to := Vector2.ONE * (PKeyKitTokens.PRESS_SCALE if down else 1.0)
	var tw := b.create_tween()
	tw.set_ignore_time_scale(true)
	tw.tween_property(b, "scale", to, PKeyKitTokens.MOTION_PRESS_MS / 1000.0).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	b.set_meta(PRESS_META, tw)


static func _live(view: Variant, token: int) -> bool:
	return is_instance_valid(view) and (view as Control).is_inside_tree() and view.has_meta(ENTER_META) and view.get_meta(ENTER_META) is int and int(view.get_meta(ENTER_META)) == token


static func _kill(n: Node, key: StringName) -> void:
	if not n.has_meta(key):
		return
	var prev = n.get_meta(key)
	if prev is Tween and (prev as Tween).is_valid():
		(prev as Tween).kill()
	n.remove_meta(key)
