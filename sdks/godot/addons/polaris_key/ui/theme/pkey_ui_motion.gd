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
const STEP_META := &"pkey_step_tween"
const ENTER_SCALE := 0.98
## Frames to wait after a dialog is shown before the fade starts: the frame that built it takes
## long, and a tween would spend that frame's delta at once.
const SETTLE_FRAMES := 2


## The node a dialog's entry scales: its card, never the view (the view draws the scrim, which must
## cover the whole viewport at every frame). A phone's docked sheet does not scale.
static func card_of(view: Control) -> Control:
	if view == null or not (view is PKeyUiView):
		return null
	var v := view as PKeyUiView
	if v.phone_sheet() or v._card_box == null or not is_instance_valid(v._card_box):
		return null
	return v._card_box


## Fade the dialog `view` in over MOTION_SHEET_IN_MS (the whole view, scrim included) and scale its
## card from 98 % around the card's centre, starting after it has been drawn once.
## Call it when the dialog is shown (a coroutine; callers need not await it).
static func enter(view: Control) -> void:
	if view == null or not view.is_inside_tree():
		return
	_kill(view, ENTER_META)
	cancel(view)
	if PKeyUiTheme.reduce_motion():
		return
	view.modulate.a = 0.0
	var token := Time.get_ticks_usec()
	view.set_meta(ENTER_META, token)
	var tree := view.get_tree()
	for i in SETTLE_FRAMES:
		await tree.process_frame
		if not _live(view, token):
			return
	if PKeyUiTheme.reduce_motion():
		cancel(view)
		return
	var card := card_of(view)
	var tw := view.create_tween()
	tw.set_ignore_time_scale(true)
	tw.set_parallel(true)
	var s := PKeyKitTokens.MOTION_SHEET_IN_MS / 1000.0
	tw.tween_property(view, "modulate:a", 1.0, s).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	if card != null:
		card.pivot_offset = card.size / 2.0
		card.scale = Vector2.ONE * ENTER_SCALE
		tw.tween_property(card, "scale", Vector2.ONE, s).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
		view.set_meta(&"pkey_scaled_card", card)
	view.set_meta(ENTER_META, tw)


## Fade the dialog out over MOTION_SHEET_OUT_MS (card scales to 98 % too), then call `done`.
## Reduced motion calls it at once. The view stays as it was if it is re-shown meanwhile.
static func exit(view: Control, done: Callable) -> void:
	if view == null or not view.is_inside_tree() or PKeyUiTheme.reduce_motion():
		done.call()
		return
	_kill(view, ENTER_META)
	var card := card_of(view)
	var tw := view.create_tween()
	tw.set_ignore_time_scale(true)
	tw.set_parallel(true)
	var s := PKeyKitTokens.MOTION_SHEET_OUT_MS / 1000.0
	tw.tween_property(view, "modulate:a", 0.0, s).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN)
	if card != null:
		card.pivot_offset = card.size / 2.0
		tw.tween_property(card, "scale", Vector2.ONE * ENTER_SCALE, s).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN)
		view.set_meta(&"pkey_scaled_card", card)
	tw.set_parallel(false)
	tw.tween_callback(func() -> void:
		cancel(view)
		done.call())
	view.set_meta(ENTER_META, tw)


## A short crossfade for a step change inside a dialog: `content` dips to 0 and back over
## MOTION_STEP_MS. Call it right after the new step's content is in place.
static func step(content: Control) -> void:
	if content == null or not content.is_inside_tree() or PKeyUiTheme.reduce_motion():
		return
	_kill(content, STEP_META)
	content.modulate.a = 0.0
	var tw := content.create_tween()
	tw.set_ignore_time_scale(true)
	tw.tween_property(content, "modulate:a", 1.0, PKeyKitTokens.MOTION_STEP_MS / 1000.0).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	content.set_meta(STEP_META, tw)


## Put a dialog that closed back as it was (a pending or running fade is dropped).
static func cancel(view: Control) -> void:
	if view == null or not is_instance_valid(view):
		return
	_kill(view, ENTER_META)
	view.modulate.a = 1.0
	view.scale = Vector2.ONE
	if view.has_meta(&"pkey_scaled_card"):
		var c = view.get_meta(&"pkey_scaled_card")
		if is_instance_valid(c):
			(c as Control).scale = Vector2.ONE
		view.remove_meta(&"pkey_scaled_card")


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
