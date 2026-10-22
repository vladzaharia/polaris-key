class_name PKeyUiFeedback
extends RefCounted
## UI sound hooks and haptics (UI-KITS.md §4.3, the Godot row). The kit ships no audio: it tells the
## host, and the game plays its own sound in its own bus. Events (StringNames):
##
##   &"open"     a dialog opened over the game (and only that: no focus sound with it)
##   &"close"    a dialog closed
##   &"focus"    focus moved by navigation (keyboard or pad); never by a mouse click or on open
##   &"confirm"  a button that does something was pressed
##   &"back"     Cancel, Later, Close or Dismiss was pressed, or Escape or the pad's back button
##   &"error"    a refusal or a failed action was shown
##
## Three ways to hear them: `PolarisKey.ui_sound` (a signal, survives `configure()`), the Callable
## `PKeyOptions.ui_sound_hook`, or `PKeyUiFeedback.hook` set directly. `PKeyOptions.ui_haptics` (off
## by default) adds a short vibration on a handheld (Android needs the VIBRATE permission) and a
## weak rumble on the pad last used, for confirm, back, error, open and close.

const EVENTS := [&"open", &"close", &"focus", &"confirm", &"back", &"error"]
## [handheld milliseconds, pad rumble weak, strong, seconds].
const HAPTICS := {
	&"confirm": [18, 0.25, 0.0, 0.05],
	&"back": [12, 0.15, 0.0, 0.04],
	&"open": [12, 0.15, 0.0, 0.04],
	&"close": [12, 0.1, 0.0, 0.04],
	&"error": [40, 0.0, 0.4, 0.09],
}
## Buttons named like these dismiss: `back`, not `confirm`.
const BACK_NAMES := ["Cancel", "Later", "Close", "Dismiss", "NotNow", "Back"]
## How long after a navigation input a focus change counts as navigation (ms).
const NAV_WINDOW_MS := 150

## The host's hook: a Callable(event: StringName). Empty for none.
static var hook := Callable()
## Vibrate and rumble.
static var haptics := false
## Tests: every event emitted, and every event that asked for a haptic, since `reset()`.
static var log_events := false
static var logged: Array = []
static var haptic_calls: Array = []
static var _options_hook := Callable()
static var _nav_stamp := -100000


static func emit(event: StringName) -> void:
	if log_events:
		logged.append(event)
	if hook.is_valid():
		hook.call(event)
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null and tree.root != null:
		var sdk := tree.root.get_node_or_null("PolarisKey")
		if sdk != null and sdk.has_signal("ui_sound"):
			sdk.emit_signal("ui_sound", event)
	if haptics and HAPTICS.has(event):
		_haptic(event)


static func _haptic(event: StringName) -> void:
	if log_events:
		haptic_calls.append(event)
	var h: Array = HAPTICS[event]
	if OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios"):
		Input.vibrate_handheld(int(h[0]))
	var pad := PKeyInputGlyphs.last_pad_device
	if pad >= 0 and Input.get_connected_joypads().has(pad):
		Input.start_joy_vibration(pad, float(h[1]), float(h[2]), float(h[3]))


## Set from the options: a valid Callable replaces the hook; an options object with none removes
## only a hook an earlier options object set, never one set directly.
static func use_options_hook(c: Variant) -> void:
	if typeof(c) == TYPE_CALLABLE and (c as Callable).is_valid():
		hook = c
		_options_hook = c
	elif _options_hook.is_valid() and hook == _options_hook:
		hook = Callable()
		_options_hook = Callable()


## A view saw an input event: a navigation input opens the window in which a focus change is
## navigation, and a pad button remembers the pad.
static func note_input(event: InputEvent) -> void:
	if event is InputEventJoypadButton or event is InputEventJoypadMotion:
		PKeyInputGlyphs.last_pad_device = event.device
	if not (event is InputEventKey or event is InputEventJoypadButton or event is InputEventJoypadMotion):
		return
	for a in ["ui_up", "ui_down", "ui_left", "ui_right", "ui_focus_next", "ui_focus_prev"]:
		if event.is_action_pressed(a):
			_nav_stamp = Time.get_ticks_msec()
			return


## Wire the feedback of a button or field once: focus on navigation, and for a button its press
## sound (back or confirm) and the press scale.
static func attach(c: Control) -> void:
	if c.has_meta(&"pkey_fx"):
		return
	c.set_meta(&"pkey_fx", true)
	c.focus_entered.connect(_on_focus)
	if c is BaseButton:
		var b := c as BaseButton
		b.pressed.connect(func() -> void: emit(&"back" if BACK_NAMES.has(String(b.name)) else &"confirm"))
		b.button_down.connect(PKeyUiMotion.press.bind(b, true))
		b.button_up.connect(PKeyUiMotion.press.bind(b, false))


static func _on_focus() -> void:
	if Time.get_ticks_msec() - _nav_stamp <= NAV_WINDOW_MS:
		emit(&"focus")


static func reset() -> void:
	hook = Callable()
	_options_hook = Callable()
	haptics = false
	log_events = false
	logged = []
	haptic_calls = []
	_nav_stamp = -100000
