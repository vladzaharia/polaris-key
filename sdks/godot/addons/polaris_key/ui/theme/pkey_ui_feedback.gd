class_name PKeyUiFeedback
extends RefCounted
## UI sound hooks and haptics (UI-KITS.md §4.3, the Godot row). The kit ships no audio: it calls the
## host's hook, and the game plays its own sound in its own bus. Events, all StringNames:
##
##   &"focus"    focus moved onto a button or field
##   &"confirm"  a button was pressed
##   &"open"     a dialog opened over the game
##   &"close"    a dialog closed
##
## `PKeyOptions.ui_sound_hook` is a Callable taking the event. `PKeyOptions.ui_haptics` (off by
## default) adds a short vibration on a handheld for `confirm`, `open` and `close`. Neither runs
## in a headless run.

const EVENTS := [&"focus", &"confirm", &"open", &"close"]
const HAPTIC_MS := {&"confirm": 18, &"open": 12, &"close": 12}

## The host's hook: a Callable(event: StringName). Empty for none.
static var hook := Callable()
## Vibrate a handheld on confirm, open and close.
static var haptics := false
## Tests: every event emitted since `reset()`.
static var log_events := false
static var logged: Array = []


static func emit(event: StringName) -> void:
	if log_events:
		logged.append(event)
	if hook.is_valid():
		hook.call(event)
	if haptics and HAPTIC_MS.has(event) and (OS.has_feature("mobile") or OS.has_feature("android") or OS.has_feature("ios")):
		Input.vibrate_handheld(int(HAPTIC_MS[event]))


## Wire the feedback of a button or field once: focus, and press for a button.
static func attach(c: Control) -> void:
	if c.has_meta(&"pkey_fx"):
		return
	c.set_meta(&"pkey_fx", true)
	c.focus_entered.connect(emit.bind(&"focus"))
	if c is BaseButton:
		var b := c as BaseButton
		b.pressed.connect(emit.bind(&"confirm"))
		b.button_down.connect(PKeyUiMotion.press.bind(b, true))
		b.button_up.connect(PKeyUiMotion.press.bind(b, false))


static func reset() -> void:
	hook = Callable()
	haptics = false
	log_events = false
	logged = []
