extends RefCounted
# @pkey-feature ui.kit
# @pkey-feature ui.kit.manage
# @pkey-feature core.presentation
# The UI kit v1 (P1-10), headless. There is no renderer, so the scenes are pinned as structural
# text: every scene in every state of tests/ui/scenarios.gd against the committed fixtures in
# tests/ui/snapshots/<scene>.txt (visible controls, texts, disabled flags, focus order). Then, for
# the same states:
#
#   focus   from the first control, ui_down alone (and ui_accept on a disclosure such as the
#           settings panel's advanced toggle) reaches every visible, enabled control the tree
#           holds — found by walking the tree, not by asking the scene's own focus chain
#   copy    under a pseudo-locale that wraps every PKeyUiCopy default in ⟦…⟧, every visible
#           Label, Button and placeholder is translated copy, unless the node is marked as data
#
# and the behaviour the acceptance rows name: an enforced setting is a disabled control with
# "Set by …", editing a default setting writes the override store and get_source() becomes
# `local`, a locked update answer is a banner with no dismiss that never covers the game, every
# PKeyActivationResult kind and sign-in ending has its own copy, and COPY DIAGNOSTICS never holds a
# credential.
#
# The product's presentation (core.presentation, plans/HA-14.md §6): the header's name, icon and
# monogram and the accent's source follow the theme rows of ui-matrix.json (the integrator's
# options, then the presentation, then the project), the dark accent applies in the dark scheme,
# the built theme's primary and accent text keep their contrast, the header re-renders on
# `changed` and keeps the texture it shows until the next size resolves, and the names are drawn
# bidi-isolated.
#
#   godot --headless --path sdks/godot -- --pkey-test ui           # check
#   godot --headless --path sdks/godot -- --pkey-test ui update    # rewrite the fixtures (editor)

const SCENARIOS := preload("res://tests/ui/scenarios.gd")
const PRESENTATION := preload("res://tests/support/presentation_fixtures.gd")
const SNAPSHOTS := "res://tests/ui/snapshots"
const UI_MATRIX := "res://tests/corpus/v2/ui-matrix.json"
## The ui-matrix.json theme rows the Godot kit holds: its own, and the presentation and integrator
## rows of the other kits (their `colorScheme` aside: the Godot kit is dark by default).
const THEME_ROWS := [
	"godot: Drift Kart's own accent, dark by default",
	"godot: Drift Kart in the light scheme the game asks for",
	"react: the integrator's accent wins over presentation",
	"qt: no presentation, the bundle names it, ink and a monogram",
	"compose: no accent and no icon falls to ink",
	"react: a long product name",
	"react: the integrator's name and icon win",
]
const PSEUDO_LOCALE := "eo"

var _sc


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	_sc = SCENARIOS.new()
	var update := args.has("update")
	TranslationServer.set_locale("en")
	# An earlier suite's SDK may still be bound to the kit.
	PKeyUiTheme.use_presentation(null)
	var all: Array = _sc.all()
	await _snapshots(t, all, update)
	await _focus(t, all)
	await _headers(t, all)
	await _copy(t, all)
	await _behaviour(t)
	await _motion_and_transparency(t)
	await _game_look(t)
	await _settings_open(t)
	await _key_field(t)
	await _layout(t, all)
	await _spec(t)
	t.check("coverage: states", all.size() >= 60, str(all.size()))
	return true


static func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _build(c: Array) -> Control:
	var v: Control = await c[2].call()
	await _tree().process_frame
	if v.has_method("refresh_view"):
		v.refresh_view()
	return v


func _free(v: Control) -> void:
	v.get_parent().remove_child(v)
	v.queue_free()


## The key field: visible and private (drawn in clear, typed on a keyboard that neither corrects
## nor learns it); Activate goes under the field when the field beside it could not hold its
## placeholder, and a placeholder the field cannot hold even then is dropped, never cut (the label
## says the same).
func _key_field(t: PKeyTestContext) -> void:
	var p: Control = _sc.activation(true, true, false, false)
	await _tree().process_frame
	var key := p.find_child("KeyInput", true, false) as LineEdit
	var row := p.find_child("KeyRow", true, false) as BoxContainer
	t.check("key field: visible and private", key != null and not key.secret and key.virtual_keyboard_type == LineEdit.KEYBOARD_TYPE_PASSWORD)
	# (Beside the field where it fits; under it on a phone's screen, the actions stacked.)
	t.check("key field: Activate beside the field where it fits, under it on a phone", row != null and row.vertical == p.phone_screen() and key.placeholder_text == "Paste your key", "vertical %s phone %s" % [row.vertical if row != null else null, p.phone_screen()])
	# A game's very large type on a narrow panel.
	p.size = Vector2(330, 1400)
	key.add_theme_font_size_override("font_size", 64)
	for i in 6:
		await _tree().process_frame
	var box := key.get_theme_stylebox("normal")
	var pad := box.get_margin(SIDE_LEFT) + box.get_margin(SIDE_RIGHT)
	var whole := key.placeholder_text == "" or PKeyUiView.text_width(key, key.placeholder_text) + pad <= key.size.x + 0.5
	t.check("key field: Activate goes under the field when the hint would not fit beside it", row.vertical, "row %s field %s" % [row.size, key.size])
	t.check("key field: the placeholder shows whole or not at all", whole, "'%s' in %.0f px" % [key.placeholder_text, key.size.x])
	_free(p)


## DL18: `PKeySettingsPanel.open()` is the one line that shows the settings over the game: it
## covers its parent, offers Close (and Escape or a pad's B), gives the focus back and frees itself.
## A panel a game's own menu holds has no Close.
func _settings_open(t: PKeyTestContext) -> void:
	var holder := Control.new()
	holder.size = Vector2(1280, 720)
	_tree().root.add_child(holder)
	var game_button := Button.new()
	game_button.text = "Settings"
	holder.add_child(game_button)
	game_button.grab_focus()
	var p := PKeySettingsPanel.open(holder)
	p.auto_sdk = false
	p.sdk = await _sc.settings_sdk({})
	await _tree().process_frame
	await _tree().process_frame
	var close := p.find_child("Close", true, false) as Button
	t.check("DL18: open() covers its parent, closable, with Close", p.get_parent() == holder and p.closable and close != null and close.is_visible_in_tree() and close.text == "Close", "close %s" % close)
	var closed := [false]
	p.closed.connect(func() -> void: closed[0] = true)
	t.check("DL18: Escape (ui_cancel) closes it", p._cancel() and closed[0])
	await _tree().create_timer(0.4, true, false, true).timeout
	t.check("DL18: closed, it is freed and the game's control has the focus back", not is_instance_valid(p) and game_button.has_focus())
	var embedded: Control = await _sc.settings(false, {})
	await _tree().process_frame
	var none := embedded.find_child("Close", true, false) as Button
	t.check("DL18: a panel the game's menu holds offers no Close", none != null and not none.visible and not embedded._cancel())
	_free(embedded)
	holder.queue_free()


## DL16: the options (and the system where it reports them) hold the shimmer still and draw a
## dialog over the game on an opaque page.
func _motion_and_transparency(t: PKeyTestContext) -> void:
	var opts := PKeyOptions.new()
	opts.ui_reduce_motion = "on"
	opts.ui_reduce_transparency = "on"
	PKeyUiTheme.apply_options(opts)
	t.check("DL16: ui_reduce_motion and ui_reduce_transparency reach the kit", PKeyUiTheme.reduce_motion() and PKeyUiTheme.reduce_transparency())
	var d: Control = _sc.offline(false, "")
	d.busy = true
	d.refresh_view()
	await _tree().process_frame
	var bar := d.find_child("Loading", true, false) as ProgressBar
	t.check("DL16: reduced motion holds the loading shimmer still (a full, quiet line)", bar != null and not bar.indeterminate and is_equal_approx(bar.value, bar.max_value), "indeterminate %s" % (bar.indeterminate if bar != null else null))
	t.check("DL16: reduced transparency puts a dialog over the game on the opaque page", d.theme_type_variation != &"PKeyScrim", String(d.theme_type_variation))
	opts.ui_reduce_motion = "off"
	opts.ui_reduce_transparency = "off"
	PKeyUiTheme.apply_options(opts)
	d.refresh_view()
	await _tree().process_frame
	t.check("DL16: with motion the shimmer moves", bar != null and bar.indeterminate)
	t.check("DL16: without reduced transparency the dialog sits on the scrim", d.theme_type_variation == &"PKeyScrim", String(d.theme_type_variation))
	_free(d)
	PKeyUiTheme.reset()
	t.check("DL16: auto follows the system (off where the engine reports nothing)", PKeyUiTheme.reduce_motion_mode == "auto" and PKeyUiTheme.reduce_motion() == (DisplayServer.has_method("accessibility_should_reduce_animation") and bool(DisplayServer.call("accessibility_should_reduce_animation"))))


## The game look (UK-11b): glass over the scrim and the opaque fallbacks, the system scheme, the
## input glyphs, the sound events, the fade and the PKEY_UI_REDUCE_TRANSPARENCY override.
func _game_look(t: PKeyTestContext) -> void:
	PKeyUiTheme.reset()
	# The forced paths (the CI lanes run the matrix once on each).
	OS.set_environment("PKEY_UI_REDUCE_TRANSPARENCY", "1")
	t.check("env: PKEY_UI_REDUCE_TRANSPARENCY=1 forces the opaque page", PKeyUiTheme.reduce_transparency())
	OS.set_environment("PKEY_UI_REDUCE_TRANSPARENCY", "0")
	t.check("env: =0 forces the scrim", not PKeyUiTheme.reduce_transparency())
	PKeyUiTheme.reduce_transparency_mode = "on"
	t.check("env: an explicit option wins over the variable", PKeyUiTheme.reduce_transparency())
	PKeyUiTheme.reduce_transparency_mode = "auto"
	OS.set_environment("PKEY_UI_REDUCE_TRANSPARENCY", "")
	# Glass: the card over the dimmed game is nearly opaque on the scrim path (until the blur ships), opaque elsewhere.
	PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
	PKeyUiTheme.reduce_transparency_mode = "off"
	PKeyUiTheme.glass_opaque_override = false
	PKeyUiFeedback.log_events = true
	var d: Control = _sc.offline(false, "")
	# On a desktop-sized screen (a phone's sheet is opaque by design).
	var screen := SubViewport.new()
	screen.size = Vector2i(1280, 720)
	_tree().root.add_child(screen)
	d.get_parent().remove_child(d)
	screen.add_child(d)
	d.theme = load(PKeyUiTheme.NEUTRAL_PATH)
	d.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	await _tree().process_frame
	d.refresh_view()
	await _tree().process_frame
	await _tree().process_frame
	var card := d.find_child("Card", true, false) as PanelContainer
	var glass := card.get_theme_stylebox("panel") as StyleBoxFlat if card != null else null
	t.check("glass: the dark card over the scrim is 0.94", glass != null and is_equal_approx(glass.bg_color.a, 0.94) and card.has_meta(&"pkey_glass"), str(glass.bg_color) if glass != null else "no card")
	PKeyUiTheme.scheme = "light"
	d.refresh_view()
	await _tree().process_frame
	await _tree().process_frame
	glass = card.get_theme_stylebox("panel") as StyleBoxFlat
	t.check("glass: the light card over the scrim is 0.96", glass != null and is_equal_approx(glass.bg_color.a, 0.96), str(glass.bg_color) if glass != null else "")
	PKeyUiTheme.scheme = "dark"
	PKeyUiTheme.glass_opaque_override = true
	d.refresh_view()
	await _tree().process_frame
	await _tree().process_frame
	var plain := card.get_theme_stylebox("panel") as StyleBoxFlat
	t.check("glass: opaque under the compatibility renderer, on the web or by override", plain != null and is_equal_approx(plain.bg_color.a, 1.0) and not card.has_meta(&"pkey_glass"), "%s meta %s" % [plain.bg_color if plain != null else null, card.has_meta(&"pkey_glass")])
	PKeyUiTheme.glass_opaque_override = null
	PKeyUiTheme.reduce_transparency_mode = "on"
	d.refresh_view()
	await _tree().process_frame
	t.check("glass: reduced transparency is the opaque page and an opaque card", d.theme_type_variation != &"PKeyScrim" and not card.has_meta(&"pkey_glass") and PKeyUiTheme.glass_opaque())
	t.check("glass: the product tile is opaque", (PKeyUiTheme.current().get_stylebox("panel", "PKeyAvatar") as StyleBoxFlat).bg_color.a == 1.0)
	PKeyUiTheme.reduce_transparency_mode = "off"
	_free(d)
	screen.queue_free()
	await _sound(t)
	await _motion(t)
	await _glyphs(t)
	await _scheme(t)
	await _focus_ring(t)
	await _lead_fixes(t)
	await _slice2(t)
	await _standalone_a(t)
	PKeyUiTheme.reset()


## The sound events: open and close only for a dialog, focus only on navigation, back for dismissals
## and Escape, error for a refusal; the hook, the signal and the options.
func _sound(t: PKeyTestContext) -> void:
	var heard := []
	PKeyUiFeedback.hook = func(e): heard.append(e)
	var sdk := _tree().root.get_node_or_null("PolarisKey")
	var signalled := []
	if sdk != null and sdk.has_signal("ui_sound"):
		sdk.connect("ui_sound", func(e): signalled.append(e))
	PKeyUiFeedback.log_events = true
	PKeyUiFeedback.logged = []
	var d: Control = _sc.sign_in("pending")
	await _tree().process_frame
	await _tree().process_frame
	t.check("sound: opening plays open and nothing else (no focus sound)", heard == [&"open"], str(heard))
	var copy := d.find_child("CopyLink", true, false) as Button
	var cancel := d.find_child("Cancel", true, false) as Button
	heard.clear()
	if copy != null:
		copy.grab_focus()
	t.check("sound: focus from a click or code is silent", not heard.has(&"focus"), str(heard))
	var nav := InputEventKey.new()
	nav.keycode = KEY_DOWN
	nav.pressed = true
	PKeyUiFeedback.note_input(nav)
	if cancel != null:
		cancel.grab_focus()
	t.check("sound: focus right after a navigation input plays focus", heard == [&"focus"], str(heard))
	heard.clear()
	if copy != null:
		copy.pressed.emit()
	t.check("sound: a button that acts plays confirm", heard == [&"confirm"], str(heard))
	heard.clear()
	if cancel != null:
		cancel.pressed.emit()
	t.check("sound: Cancel plays back, not confirm", heard.has(&"back") and not heard.has(&"confirm"), str(heard))
	t.check("sound: the signal on PolarisKey carries the same events", sdk == null or not sdk.has_signal("ui_sound") or signalled.has(&"confirm") and signalled.has(&"back"), str(signalled))
	heard.clear()
	var failed: Control = _sc.sign_in("failed")
	await _tree().process_frame
	await _tree().process_frame
	t.check("sound: a refusal shown plays error", heard.has(&"error"), str(heard))
	_free(failed)
	_free(d)
	# The hook survives configure(): options with none do not wipe it, options with one replace it.
	var o := PKeyOptions.new()
	var hook_before := PKeyUiFeedback.hook
	PKeyUiTheme.apply_options(o)
	t.check("sound: configure() without a hook leaves one set directly", PKeyUiFeedback.hook == hook_before)
	var seen := []
	o.ui_sound_hook = func(e): seen.append(e)
	PKeyUiTheme.apply_options(o)
	PKeyUiFeedback.emit(&"open")
	t.check("sound: PKeyOptions.ui_sound_hook is heard", seen == [&"open"])
	PKeyUiTheme.apply_options(PKeyOptions.new())
	t.check("sound: a later options object without one removes the options' hook", not PKeyUiFeedback.hook.is_valid())
	# Haptics: on, a confirm and an error ask for a haptic; off, none.
	PKeyUiFeedback.haptic_calls = []
	PKeyUiFeedback.haptics = false
	PKeyUiFeedback.emit(&"confirm")
	t.check("haptics: off, nothing is asked", PKeyUiFeedback.haptic_calls.is_empty())
	PKeyUiFeedback.haptics = true
	PKeyUiFeedback.emit(&"confirm")
	PKeyUiFeedback.emit(&"error")
	PKeyUiFeedback.emit(&"focus")
	t.check("haptics: on, confirm and error ask for one and focus does not", PKeyUiFeedback.haptic_calls == [&"confirm", &"error"], str(PKeyUiFeedback.haptic_calls))
	PKeyUiFeedback.reset()


## The fade: a dialog opened in the frame it was built still fades (it starts after the first
## frames), it reaches full opacity with the clock stopped, and reduced motion shows it at once.
func _motion(t: PKeyTestContext) -> void:
	PKeyUiTheme.reduce_motion_mode = "off"
	var d: Control = _sc.sign_in("pending")
	t.check("motion: built and shown in one frame, the dialog is still transparent", d.modulate.a < 0.05, str(d.modulate.a))
	# R1: only the card scales; the view (the scrim) is never smaller than its viewport, at every frame.
	var covered := true
	var card_scaled := false
	var bad := ""
	for i in 40:
		await _tree().process_frame
		var vp := d.get_viewport().get_visible_rect()
		if d.scale != Vector2.ONE or not d.get_global_rect().encloses(vp):
			covered = false
			bad = "frame %d %s %s" % [i, d.scale, d.get_global_rect()]
		var card0 := PKeyUiMotion.card_of(d)
		if card0 != null and card0.scale.x < 0.999:
			card_scaled = true
	t.check("motion: the scrim covers the whole viewport at every frame of the entry", covered, bad)
	t.check("motion: the card itself scales in from 98 %", card_scaled or PKeyUiMotion.card_of(d) == null)
	await _tree().create_timer(0.1, true, false, true).timeout
	t.check("motion: it is part way (or done) after the settle frames", d.modulate.a > 0.0, str(d.modulate.a))
	await _tree().create_timer(0.35, true, false, true).timeout
	var card1 := PKeyUiMotion.card_of(d)
	t.check("motion: it ends at full alpha and scale", is_equal_approx(d.modulate.a, 1.0) and (card1 == null or is_equal_approx(card1.scale.x, 1.0)), "%s" % d.modulate.a)
	_free(d)
	# The clock stopped (a game pausing with time_scale): the dialog still arrives.
	Engine.time_scale = 0.0
	var z: Control = _sc.sign_in("pending")
	for i in 4:
		await _tree().process_frame
	await _tree().create_timer(0.5, true, false, true).timeout
	var a := z.modulate.a
	Engine.time_scale = 1.0
	t.check("motion: with Engine.time_scale = 0 the dialog reaches full opacity", is_equal_approx(a, 1.0), str(a))
	_free(z)
	PKeyUiTheme.reduce_motion_mode = "on"
	var r: Control = _sc.sign_in("pending")
	await _tree().process_frame
	t.check("motion: reduced motion shows it at once, unscaled", is_equal_approx(r.modulate.a, 1.0) and is_equal_approx(r.scale.x, 1.0))
	_free(r)
	PKeyUiTheme.reduce_motion_mode = "auto"


## The input glyphs: the button bound to ui_accept and ui_cancel, never an OS flag.
func _glyphs(t: PKeyTestContext) -> void:
	PKeyInputGlyphs.family_override = "xbox"
	PKeyUiView.ensure_pad_bindings()
	var k := PKeyInputGlyphs.KEYBOARD
	var p := PKeyInputGlyphs.PAD
	t.check("glyphs: keyboard confirm is Enter, back is Esc", PKeyInputGlyphs.label_for(&"confirm", k) == "Enter" and PKeyInputGlyphs.label_for(&"back", k) == "Esc")
	t.check("glyphs: the default map shows A to confirm and B to go back, on every OS", PKeyInputGlyphs.label_for(&"confirm", p) == "A" and PKeyInputGlyphs.label_for(&"back", p) == "B")
	var accept := InputMap.action_get_events(&"ui_accept").duplicate()
	var cancel := InputMap.action_get_events(&"ui_cancel").duplicate()
	for e in accept:
		if e is InputEventJoypadButton:
			InputMap.action_erase_event(&"ui_accept", e)
	var east := InputEventJoypadButton.new()
	east.button_index = JOY_BUTTON_B
	InputMap.action_add_event(&"ui_accept", east)
	t.check("glyphs: a game that remaps ui_accept to B is shown B", PKeyInputGlyphs.label_for(&"confirm", p) == "B")
	InputMap.action_erase_event(&"ui_accept", east)
	for e in accept:
		if e is InputEventJoypadButton:
			InputMap.action_add_event(&"ui_accept", e)
	PKeyInputGlyphs.family_override = "playstation"
	t.check("glyphs: a PlayStation pad draws a cross to confirm and a circle to go back", PKeyInputGlyphs.shape_for(&"confirm", p) == "cross" and PKeyInputGlyphs.shape_for(&"back", p) == "circle" and PKeyInputGlyphs.label_for(&"confirm", p) == "")
	PKeyInputGlyphs.family_override = "nintendo"
	t.check("glyphs: a Nintendo pad prints B on the south button and A on the east one", PKeyInputGlyphs.label_for(&"confirm", p) == "B" and PKeyInputGlyphs.label_for(&"back", p) == "A")
	PKeyInputGlyphs.family_override = "xbox"
	var g := PKeyInputGlyphs.new()
	g.kind = k
	_tree().root.add_child(g)
	await _tree().process_frame
	var ms := g.get_combined_minimum_size()
	t.check("glyphs: a keycap is at least as wide as it is tall; the letter is at least 17 px", ms.x >= ms.y and ms.y >= 2.0 * 17.0 * 0.8 and g._letter() >= 17, str(ms))
	g.queue_free()
	var panel: Control = _sc.activation(true, false, false, false)
	await _tree().process_frame
	if panel != null:
		_free(panel)
	# The pad family is the last pad used.
	PKeyInputGlyphs.family_override = null
	PKeyInputGlyphs.last_pad_device = 7
	t.check("glyphs: an unconnected last pad falls back to the generic (Xbox) family", PKeyInputGlyphs.pad_family() == "xbox")
	PKeyInputGlyphs.last_pad_device = -1
	PKeyInputGlyphs.family_override = null


## The system scheme: follows the OS, dark where it cannot say, re-checked on focus and on open,
## and the kit never takes the engine's system-theme callback.
func _scheme(t: PKeyTestContext) -> void:
	PKeyUiTheme.scheme_mode = "system"
	PKeyUiTheme.system_dark_override = false
	PKeyUiTheme.resolve_scheme()
	t.check("scheme: system follows a light OS", PKeyUiTheme.scheme == "light")
	PKeyUiTheme.system_dark_override = true
	PKeyUiTheme.recheck_system_scheme()
	t.check("scheme: re-checked (the game regained focus), it follows the OS to dark", PKeyUiTheme.scheme == "dark")
	var o := PKeyOptions.new()
	o.ui_brand_scheme = "system"
	PKeyUiTheme.system_dark_override = false
	PKeyUiTheme.apply_options(o)
	t.check("scheme: ui_brand_scheme = system reaches the kit", PKeyUiTheme.scheme_mode == "system" and PKeyUiTheme.scheme == "light")
	o.ui_brand_scheme = "bogus"
	PKeyUiTheme.apply_options(o)
	t.check("scheme: an unknown value is dark", PKeyUiTheme.scheme == "dark")
	t.check("scheme: the light scrim is 0.35 (UI-KITS Godot row)", is_equal_approx(PKeyKitTokens.SCRIM_LIGHT_OPACITY, 0.35) and is_equal_approx(PKeyKitTokens.SCRIM_LIGHT.a, 0.35))


## Slice 2: the hint bar's verbs, the step crossfade, the exit tween and the TV title-safe toast.
func _slice2(t: PKeyTestContext) -> void:
	PKeyUiTheme.reduce_motion_mode = "off"
	var before_size := _tree().root.size
	_tree().root.size = Vector2i(1280, 720)
	PKeyUiView.pad_only_override = true
	var d: Control = _sc.sign_in("pending")
	for i in 30:
		await _tree().process_frame
	var bar := d.find_child("HintBar", true, false) as PKeyHintBar
	t.check("hint bar: a pad-only sign-in shows 'to select' and 'to go back' beside their glyphs", bar != null and bar.visible and _bar_words(bar) == ["to select", "to go back"], str(_bar_words(bar)) if bar != null else "no bar")
	var touch := InputEventScreenTouch.new()
	bar._input(touch)
	t.check("hint bar: touch hides it", not bar.visible)
	var key := InputEventKey.new()
	bar._input(key)
	t.check("hint bar: the keyboard shows Enter and Esc", bar.visible and bar.get_child_count() == 2)
	PKeyInputGlyphs.family_override = "xbox"
	var accept := InputMap.action_get_events(&"ui_accept").duplicate()
	var shoulder := InputEventJoypadButton.new()
	shoulder.button_index = JOY_BUTTON_START
	for e in accept:
		if e is InputEventJoypadButton:
			InputMap.action_erase_event(&"ui_accept", e)
	InputMap.action_add_event(&"ui_accept", shoulder)
	bar._input(InputEventJoypadButton.new())
	t.check("hint bar: an item whose button has no glyph is left out (Start), the rest stay", _bar_words(bar) == ["to go back"], str(_bar_words(bar)))
	InputMap.action_erase_event(&"ui_accept", shoulder)
	for e in accept:
		if e is InputEventJoypadButton:
			InputMap.action_add_event(&"ui_accept", e)
	PKeyInputGlyphs.family_override = null
	# The step crossfade: a new screen of the same dialog crossfades its content in.
	PKeyUiTheme.reduce_motion_mode = "off"
	await _tree().create_timer(0.4, true, false, true).timeout
	d.show_result(PKeySignInResult.ended(PKeySignInResult.KIND_EXPIRED, PKeyErrors.SIGN_IN_EXPIRED, ""))
	await _tree().process_frame
	var content: Control = d._content()
	t.check("step: a new screen of a dialog crossfades its content", content != null and content.has_meta(PKeyUiMotion.STEP_META) and content.modulate.a < 1.0, str(content.modulate.a) if content != null else "")
	await _tree().create_timer(0.4, true, false, true).timeout
	t.check("step: and ends at full alpha", is_equal_approx(content.modulate.a, 1.0))
	_free(d)
	_tree().root.size = before_size
	PKeyUiView.pad_only_override = null
	PKeyUiTheme.reduce_motion_mode = "on"
	var held := Control.new()
	_tree().root.add_child(held)
	PKeyUiMotion.step(held)
	t.check("step: reduced motion changes nothing", is_equal_approx(held.modulate.a, 1.0))
	held.queue_free()
	# The exit tween: a settings panel fades out before it is freed.
	PKeyUiTheme.reduce_motion_mode = "off"
	var holder := Control.new()
	holder.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_tree().root.add_child(holder)
	var p := PKeySettingsPanel.open(holder)
	p.auto_sdk = false
	p.sdk = await _sc.settings_sdk({})
	for i in 30:
		await _tree().process_frame
	PKeyUiTheme.reduce_motion_mode = "off"
	p.close()
	await _tree().create_timer(0.07, true, false, true).timeout
	t.check("exit: right after close the panel is still there, part way faded", is_instance_valid(p) and p.modulate.a < 1.0 and p.modulate.a > 0.0, str(p.modulate.a) if is_instance_valid(p) else "freed")
	await _tree().create_timer(0.4, true, false, true).timeout
	t.check("exit: then it is freed", not is_instance_valid(p))
	holder.queue_free()
	# The toast keeps inside 5 % of the screen from every edge at TV size, whatever its anchor.
	PKeyUiTheme.reduce_motion_mode = "on"
	for anchor in ["bottom_right", "bottom_center", "top_right"]:
		var vp := SubViewport.new()
		vp.size = Vector2i(3840, 2160)
		vp.size_2d_override = Vector2i(1920, 1080)
		vp.size_2d_override_stretch = true
		_tree().root.add_child(vp)
		var tv: Control = await _sc.toast("update")
		tv.get_parent().remove_child(tv)
		tv.toast_anchor = anchor
		vp.add_child(tv)
		tv.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		for i in 4:
			await _tree().process_frame
		var r: Rect2 = tv._card_box.get_global_rect()
		var m := 0.05 * 1080.0
		t.check("toast: title-safe at 1920x1080 (%s)" % anchor, r.position.x >= m - 1.0 and r.position.y >= m - 1.0 and r.end.x <= 1920.0 - m + 1.0 and r.end.y <= 1080.0 - m + 1.0, str(r))
		vp.queue_free()
	PKeyUiTheme.reduce_motion_mode = "auto"


## Slice 4: the standalone Paywall and DeviceLimit, on the models.
func _standalone_a(t: PKeyTestContext) -> void:
	PKeyUiTheme.reduce_motion_mode = "on"
	# Paywall: the primary is the store's or the portal's, never an invented checkout.
	var pw: PKeyPaywall = _sc.paywall("offers-store")
	var bought := [0]
	var restored := [0]
	pw.purchase_requested.connect(func(): bought[0] += 1)
	pw.restore_requested.connect(func(): restored[0] += 1)
	await _tree().process_frame
	t.check("paywall: the store's primary says Upgrade to the tier and asks the game to purchase", pw._primary.text.contains("Upgrade to") and pw._primary.text.contains("Pro"))
	pw._primary.pressed.emit()
	pw._restore.pressed.emit()
	t.check("paywall: purchase_requested and restore_requested fire", bought[0] == 1 and restored[0] == 1)
	_free(pw)
	var portal: PKeyPaywall = _sc.paywall("offers-portal")
	var opened := [0]
	portal.portal_requested.connect(func(): opened[0] += 1)
	await _tree().process_frame
	t.check("paywall: without a store the primary is Buy in your browser, no redeem without a handler", portal._primary.text == "Buy in your browser" and not portal._redeem.visible)
	portal.offers_url = "http://insecure.example/buy"
	portal.refresh_view()
	portal._primary.pressed.emit()
	t.check("paywall: portal_requested fires; a page that is not https is never opened", opened[0] == 1 and not PKeyOutletAdapter.is_https(portal.offers_url))
	_free(portal)
	var done_pw: PKeyPaywall = _sc.paywall("purchased")
	var finished := [0]
	done_pw.done.connect(func(): finished[0] += 1)
	await _tree().process_frame
	done_pw._primary.pressed.emit()
	t.check("paywall: purchased shows Done and done fires", done_pw._primary.text == "Done" and finished[0] == 1)
	_free(done_pw)
	var busy_pw: PKeyPaywall = _sc.paywall("purchasing")
	await _tree().process_frame
	t.check("paywall: purchasing disables the primary", busy_pw._primary.disabled)
	_free(busy_pw)
	# The catalog's translations, not English with a mask: German.
	TranslationServer.set_locale("de")
	var de_pw: PKeyPaywall = _sc.paywall("offers-portal")
	await _tree().process_frame
	var de_title := de_pw._title.text
	TranslationServer.set_locale("en")
	t.check("paywall: German reads from the catalog's tables", de_title != "" and not de_title.begins_with("Get more with"), de_title)
	_free(de_pw)
	# DeviceLimit: the least recent other device is the one replaced.
	var dl: PKeyDeviceLimit = _sc.device_limit("default")
	var replaced: Array = []
	dl.replace_requested.connect(func(d): replaced.append(d))
	await _tree().process_frame
	t.check("device limit: the preselected device is the least recently used other one", dl._pick.visible and dl._pick_name.text.contains("Work laptop"))
	t.check("device limit: its lede names this device", dl._lede.text.contains("this Mac"), dl._lede.text)
	dl._primary.pressed.emit()
	t.check("device limit: Replace and continue hands the game that device", replaced.size() == 1 and replaced[0].get("name") == "Work laptop")
	_free(dl)
	var br: PKeyDeviceLimit = _sc.device_limit("browser")
	var manage := [0]
	br.manage_opened.connect(func(): manage[0] += 1)
	await _tree().process_frame
	t.check("device limit: browser mode offers Open in browser", br._primary.text == "Open in browser")
	br._primary.pressed.emit()
	t.check("device limit: manage_opened fires", manage[0] == 1)
	_free(br)
	var tv: PKeyDeviceLimit = _sc.device_limit("browser-tv")
	await _tree().process_frame
	t.check("device limit: a TV shows a QR code and no browser button", tv._qr.visible and not tv._primary.visible)
	_free(tv)
	var fl: PKeyDeviceLimit = _sc.device_limit("failed")
	var retried := [0]
	fl.retry_requested.connect(func(): retried[0] += 1)
	await _tree().process_frame
	fl._primary.pressed.emit()
	t.check("device limit: a failed replacement offers Try again", retried[0] == 1)
	var backs := [0]
	fl.back_requested.connect(func(): backs[0] += 1)
	fl._cancel()
	t.check("device limit: Escape asks to go back", backs[0] == 1)
	_free(fl)
	PKeyUiTheme.reduce_motion_mode = "auto"


func _bar_words(bar: PKeyHintBar) -> Array:
	var out := []
	for row in bar.get_children():
		for ch in row.get_children():
			if ch is Label:
				out.append((ch as Label).text)
	return out


## Slice 1's lead fix list: echo navigation, error coverage, glyphs that disagree or do not exist,
## all-device pad bindings, and the ring clipped to a scroll area.
func _lead_fixes(t: PKeyTestContext) -> void:
	# n1: a held key (echo) is navigation.
	PKeyUiFeedback.reset()
	PKeyUiFeedback.log_events = true
	var echo := InputEventKey.new()
	echo.keycode = KEY_DOWN
	echo.physical_keycode = KEY_DOWN
	echo.pressed = true
	echo.echo = true
	PKeyUiFeedback.note_input(echo)
	PKeyUiFeedback._on_focus()
	t.check("n1: a held direction (key repeat) plays focus", PKeyUiFeedback.logged == [&"focus"], str(PKeyUiFeedback.logged))
	# n2: a rejected offline response and the account tab's error play error.
	PKeyUiFeedback.reset()
	PKeyUiFeedback.log_events = true
	var off: Control = _sc.offline(false, "bundle-jws-rejected")
	await _tree().process_frame
	await _tree().process_frame
	t.check("n2: the offline dialog's rejected response plays error", PKeyUiFeedback.logged.has(&"error"), str(PKeyUiFeedback.logged))
	_free(off)
	PKeyUiFeedback.logged = []
	var acct: Control = _sc.account("signed-in")
	acct.cloud_sync = "error"
	acct.refresh_view()
	await _tree().process_frame
	t.check("n2: the account tab's sync error plays error", PKeyUiFeedback.logged.has(&"error"), str(PKeyUiFeedback.logged))
	_free(acct)
	# n3: a bound shoulder button has no glyph.
	PKeyInputGlyphs.family_override = "xbox"
	var accept := InputMap.action_get_events(&"ui_accept").duplicate()
	for e in accept:
		if e is InputEventJoypadButton:
			InputMap.action_erase_event(&"ui_accept", e)
	var rb := InputEventJoypadButton.new()
	rb.button_index = JOY_BUTTON_RIGHT_SHOULDER
	InputMap.action_add_event(&"ui_accept", rb)
	t.check("n3: ui_accept on a shoulder button has no glyph, not a wrong one", not PKeyInputGlyphs.has_glyph(&"confirm", PKeyInputGlyphs.PAD) and PKeyInputGlyphs.has_glyph(&"back", PKeyInputGlyphs.PAD))
	InputMap.action_erase_event(&"ui_accept", rb)
	# n5: accept moved to east: the glyph follows the binding (B) and the words are only the verb.
	var east := InputEventJoypadButton.new()
	east.button_index = JOY_BUTTON_B
	InputMap.action_add_event(&"ui_accept", east)
	var panel: Control = _sc.activation(true, false, false, false)
	panel._input_kind = &"pad"
	panel.refresh_view()
	await _tree().process_frame
	t.check("n5: accept on east shows B with 'to select', never '[B] A to select'", panel._hint_bar.visible and _bar_words(panel._hint_bar) == ["to select"] and PKeyInputGlyphs.label_for(&"confirm", PKeyInputGlyphs.PAD) == "B")
	_free(panel)
	InputMap.action_erase_event(&"ui_accept", east)
	for e in accept:
		if e is InputEventJoypadButton:
			InputMap.action_add_event(&"ui_accept", e)
	PKeyInputGlyphs.family_override = null
	# Older bug: the kit's pad bindings answer every device.
	PKeyUiView.ensure_pad_bindings()
	var press := InputEventJoypadButton.new()
	press.device = 3
	press.pressed = true
	press.button_index = JOY_BUTTON_A
	var press_b := InputEventJoypadButton.new()
	press_b.device = 3
	press_b.pressed = true
	press_b.button_index = JOY_BUTTON_B
	t.check("pads: device 3 confirms and goes back on kit screens", InputMap.event_is_action(press, &"ui_accept") and InputMap.event_is_action(press_b, &"ui_cancel"))
	# n4: a field scrolled half out of its scroll area draws only the visible part of the ring.
	if PKeyFocusRing.needed():
		var sc := ScrollContainer.new()
		sc.custom_minimum_size = Vector2(300, 100)
		sc.size = Vector2(300, 100)
		var box := VBoxContainer.new()
		var pad := Control.new()
		pad.custom_minimum_size = Vector2(10, 60)
		box.add_child(pad)
		var te := TextEdit.new()
		te.custom_minimum_size = Vector2(280, 120)
		box.add_child(te)
		sc.add_child(box)
		_tree().root.add_child(sc)
		PKeyFocusRing.attach(te)
		await _tree().process_frame
		await _tree().process_frame
		te.grab_focus()
		await _tree().process_frame
		await _tree().process_frame
		var ring := te.get_node_or_null(^"FocusRing") as Control
		var vis := sc.get_global_rect()
		t.check("n4: the ring is clipped to the scroll area", ring != null and ring.visible and ring.clip_contents and vis.encloses(Rect2(ring.global_position, ring.size * ring.scale)) , "%s vs %s" % [ring.get_global_rect() if ring != null else null, vis])
		sc.modulate.a = 0.5
		await _tree().process_frame
		await _tree().process_frame
		t.check("n4: the ring follows the fade of its ancestors", ring != null and is_equal_approx(ring.modulate.a, 0.5), str(ring.modulate.a) if ring != null else "")
		sc.queue_free()


## The ring of a multi-line field on engines before 4.6 is drawn from a top-level child.
func _focus_ring(t: PKeyTestContext) -> void:
	var d: Control = _sc.offline(false, "")
	await _tree().process_frame
	var paste := d.find_child("Paste", true, false) as TextEdit
	var ring := paste.get_node_or_null(^"FocusRing") if paste != null else null
	if PKeyFocusRing.needed():
		t.check("focus ring: before 4.6 the paste field's ring is drawn by a top-level child", ring != null and (ring as Control).top_level and paste.get_theme_stylebox("focus") is StyleBoxEmpty)
		paste.grab_focus()
		await _tree().process_frame
		t.check("focus ring: it shows while the field has focus and sits over it", ring != null and (ring as Control).visible and (ring as Control).size.x > 0.0)
		paste.release_focus()
		await _tree().process_frame
		t.check("focus ring: and hides when focus leaves", ring != null and not (ring as Control).visible)
	else:
		t.check("focus ring: from 4.6 the engine draws it and the kit adds nothing", ring == null)
	_free(d)


# ── Snapshots ────────────────────────────────────────────────────────────────────────────

func _snapshots(t: PKeyTestContext, all: Array, update: bool) -> void:
	var by_scene := {}
	for c in all:
		var v := await _build(c)
		var text := "== %s ==\n%s\n" % [c[1], PKeyUiSnapshot.take(v)]
		by_scene[c[0]] = String(by_scene.get(c[0], "")) + text
		_free(v)
	var matched := 0
	for scene in by_scene:
		var path := "%s/%s.txt" % [SNAPSHOTS, scene]
		var got: String = by_scene[scene]
		if update:
			DirAccess.make_dir_recursive_absolute(SNAPSHOTS)
			var f := FileAccess.open(path, FileAccess.WRITE)
			if f != null:
				f.store_string(got)
				f.close()
			t.info("wrote %s" % path)
		var want := FileAccess.get_file_as_string(path) if FileAccess.file_exists(path) else ""
		if t.check("snapshot: %s" % scene, got == want, _first_diff(want, got)):
			matched += 1
	t.check("snapshot: coverage", matched == by_scene.size() and by_scene.size() >= 10, "%d/%d scenes" % [matched, by_scene.size()])


static func _first_diff(want: String, got: String) -> String:
	if want == "":
		return "no fixture (run with `ui update` in the editor)"
	var a := want.split("\n")
	var b := got.split("\n")
	for i in maxi(a.size(), b.size()):
		var x := a[i] if i < a.size() else "<end>"
		var y := b[i] if i < b.size() else "<end>"
		if x != y:
			return "line %d: want [%s] got [%s]" % [i + 1, x, y]
	return ""


# ── Layout ───────────────────────────────────────────────────────────────────────────────

## Owner requirement (2026-10-04): every panel is centred, at a comfortable width, from a phone in
## portrait to 4K, in the neutral look and in both Polaris Key looks (whose page panel pads the
## view). Each scene's first state, plus the states in LAYOUT_EXTRA, is laid out full-screen at
## each size; its centred node must sit in the middle of the view (horizontally, and vertically
## when it fits), no wider than its max width, and inside the viewport with the gutter.
const LAYOUT_SIZES := [Vector2i(1280, 720), Vector2i(1920, 1080), Vector2i(3840, 2160), Vector2i(720, 1280), Vector2i(480, 854)]
const LAYOUT_LOOKS := ["neutral", "brand-dark", "brand-light"]
## [scene, state]: boot's embedded gate, the tallest settings state, the gate after an error.
const LAYOUT_EXTRA := [["boot", "waiting needs-activation"], ["settings", "advanced shown"], ["gate", "needs-activation after an error"]]


static func _apply_look(look: String) -> void:
	PKeyUiTheme.reset()
	if look.begins_with("brand"):
		PKeyUiTheme.branding = PKeyUiTheme.BRANDING_POLARIS_KEY
		PKeyUiTheme.scheme = "light" if look == "brand-light" else "dark"
		PKeyUiTheme.powered_by = true


func _layout(t: PKeyTestContext, all: Array) -> void:
	# Layout is measured at rest (the entry scales the card for 280 ms; the motion tests own that).
	PKeyUiTheme.reduce_motion_mode = "on"
	var root := _tree().root
	var before := root.size
	var cases: Array = []
	var seen := {}
	for c in all:
		if seen.has(c[0]) or c[0] in ["badge", "banner", "update_progress", "toast"]:
			continue
		var probe: PKeyUiView = await _build(c)
		var visible := probe.visible and _centred(probe) != null and _centred(probe).is_visible_in_tree()
		_free(probe)
		if not visible:
			continue
		seen[c[0]] = true
		cases.append(c)
	for c in all:
		if LAYOUT_EXTRA.any(func(x): return x[0] == c[0] and x[1] == c[1]) and not cases.has(c):
			cases.append(c)
	var checked := 0
	for look in LAYOUT_LOOKS:
		for c in cases:
			for sz in LAYOUT_SIZES:
				root.size = sz
				var v: PKeyUiView = await _build(c)
				# A scenario configures a fake SDK (which applies its default ui_* options).
				_apply_look(look)
				PKeyUiTheme.reduce_motion_mode = "on"
				PKeyUiMotion.cancel(v)
				v.refresh_view()
				v.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
				v.refresh_view()
				for i in 3:
					await _tree().process_frame
				var node := _centred(v)
				var r := node.get_global_rect()
				var vr := v.get_global_rect()
				var dx := absf(r.get_center().x - vr.get_center().x)
				# A banner floats at the top of whatever rect it is given; only its sides are centred.
				var fits_v: bool = r.size.y <= vr.size.y and not (v is PKeyUpdatePrompt and v.presentation() == "banner")
				var dy := absf(r.get_center().y - vr.get_center().y) if fits_v else 0.0
				# A two-column landscape card is as wide as a wide card (PKeyUiTheme.MEASURES).
				var maxw: float = maxf(v.max_content_width, float(PKeyUiTheme.MEASURES["card_width_wide"]))
				var ok: bool = dx <= 1.5 and dy <= 1.5 and r.size.x <= maxw + 1.0 and r.position.x >= PKeyUiView.GUTTER - 1.0 and r.end.x <= sz.x - PKeyUiView.GUTTER + 1.0
				# A phone's portrait screen is full-bleed for the scenes that bleed: the page fills it.
				if v.phone_screen() and node != null:
					# (a gate's card keeps the page margin to the edge; a dialog's is edge to edge)
					ok = r.size.x >= vr.size.x - 2.0 * v.role("page_margin") - 1.0
				if t.check("layout: %s / %s centred at %dx%d (%s)" % [c[0], c[1], sz.x, sz.y, look], ok, "rect %s in %s" % [r, vr]):
					checked += 1
				_free(v)
	PKeyUiTheme.reset()
	root.size = before
	# The strips: the badge's chips and the banner's lines are centred across the given width.
	for c in all:
		if c[0] == "badge" and c[1] == "two grants":
			var b: PKeyUiView = await _build(c)
			var chips := b.find_child("Chips", true, false)
			t.check("layout: badge chips centred", chips != null and int(chips.get("alignment")) == 1)
			_free(b)
		elif c[0] == "banner" and c[1] == "grace":
			var b: PKeyUiView = await _build(c)
			var line := b.find_child("Line0", true, false) as Label
			# The banner is a centred card; its glyph and lines read from the start.
			t.check("layout: banner lines start-aligned beside the glyph", line != null and line.horizontal_alignment == HORIZONTAL_ALIGNMENT_LEFT)
			_free(b)
	t.check("layout: coverage", seen.size() >= 8 and cases.size() == seen.size() + LAYOUT_EXTRA.size() and checked == cases.size() * LAYOUT_SIZES.size() * LAYOUT_LOOKS.size(), "%d checks over %s" % [checked, cases.map(func(x): return "%s / %s" % [x[0], x[1]])])


## The node a scene centres: the card of a full-screen scene, else its `_content()`.
static func _centred(v: PKeyUiView) -> Control:
	if v is PKeyGateView:
		return v.find_child("Card", true, false) as Control
	if v is PKeyBoot:
		if (v as PKeyBoot).gate.is_visible_in_tree():
			return (v as PKeyBoot).gate.find_child("Card", true, false) as Control
		var shell := v.find_child("Shell", true, false) as Control
		if shell != null and shell.is_visible_in_tree():
			return shell
		return v.find_child("Card", true, false) as Control
	return v._content()


# ── Focus ────────────────────────────────────────────────────────────────────────────────

func _press(action: String) -> void:
	var down := InputEventAction.new()
	down.action = action
	down.pressed = true
	_tree().root.push_input(down)
	var up := InputEventAction.new()
	up.action = action
	up.pressed = false
	_tree().root.push_input(up)


func _focus(t: PKeyTestContext, all: Array) -> void:
	var walked := 0
	for c in all:
		var v := await _build(c)
		var want: Array = PKeyUiSnapshot.interactive(v)
		var seen := {}
		var accepted := {}
		var chain: Array = v.focus_order()
		if not chain.is_empty():
			chain[0].grab_focus()
			await _tree().process_frame
			var steps := 0
			var limit := (want.size() + 2) * 4 + 8
			while steps < limit:
				var f := _tree().root.gui_get_focus_owner()
				if f != null:
					seen[f] = true
					if f.has_meta(PKeyUiView.DISCLOSURE_META) and not accepted.has(f):
						accepted[f] = true
						_press("ui_accept")
						await _tree().process_frame
						want = PKeyUiSnapshot.interactive(v)
				_press("ui_down")
				await _tree().process_frame
				steps += 1
		# Every control a pad can reach has a name a screen reader can read (Godot 4.5+ has the
		# property; a button reads its own text).
		var unnamed: Array = []
		for ctl in chain:
			if not ("accessibility_name" in ctl):
				continue
			var named := String(ctl.get("accessibility_name")) != "" or (ctl is BaseButton and String(ctl.get("text")) != "")
			if not named:
				unnamed.append(String(v.get_path_to(ctl)))
		if "accessibility_name" in v:
			t.check("accessibility: %s / %s names every control" % [c[0], c[1]], unnamed.is_empty(), str(unnamed))
		var missing: Array = want.filter(func(x): return not seen.has(x))
		var names: Array = missing.map(func(x): return String(v.get_path_to(x)))
		if t.check("focus: %s / %s reaches every control with ui_down" % [c[0], c[1]], missing.is_empty() and (want.is_empty() or not seen.is_empty()), "missing %s" % [names]):
			walked += 1
		_free(v)
	t.check("focus: coverage", walked == all.size(), "%d/%d" % [walked, all.size()])


# ── Copy ─────────────────────────────────────────────────────────────────────────────────

func _copy(t: PKeyTestContext, all: Array) -> void:
	var pseudo := Translation.new()
	pseudo.locale = PSEUDO_LOCALE
	for k in PKeyUiCopy.DEFAULTS:
		var s: String = PKeyUiCopy.DEFAULTS[k]
		pseudo.add_message(s, "⟦%s⟧" % s)
	TranslationServer.add_translation(pseudo)
	TranslationServer.set_locale(PSEUDO_LOCALE)
	var clean := 0
	var walked := 0
	for c in all:
		var v := await _build(c)
		var bad: Array = []
		for pair in PKeyUiSnapshot.texts(v):
			var n: Node = pair[0]
			var text: String = pair[1]
			if n.has_meta(PKeyUiView.DATA_META) or n.has_meta(PKeyUiView.CATALOG_META):
				continue
			if not text.begins_with("⟦"):
				bad.append("%s \"%s\"" % [v.get_path_to(n), text])
		walked += 1
		if t.check("copy: %s / %s shows only PKeyUiCopy text" % [c[0], c[1]], bad.is_empty(), str(bad)):
			clean += 1
		_free(v)
	TranslationServer.set_locale("en")
	TranslationServer.remove_translation(pseudo)
	t.check("copy: coverage", clean == walked and walked == all.size(), "%d/%d" % [clean, walked])
	# Overrides replace a default before translation.
	var copy := PKeyUiCopy.new()
	copy.overrides = {"activation_title": "Unlock Diceroll"}
	t.check("copy: an override replaces the default", copy.text("activation_title") == "Unlock Diceroll" and copy.text("key_submit") == "Activate")
	t.check("copy: arguments are formatted after translation", copy.text("settings_set_by", "djdl") == "Set by djdl")


# ── Behaviour ────────────────────────────────────────────────────────────────────────────

func _behaviour(t: PKeyTestContext) -> void:
	await _settings(t)
	await _update_prompt(t)
	await _play(t)
	await _dialogs_take_focus(t)
	await _gate_limit_focus(t)
	await _focus_follows_screen(t)
	await _never_covering(t)
	_activation_copy(t)
	_sign_in_copy(t)
	await _gate(t)
	_dev_menu(t)
	_controllers(t)
	await _presentation(t)


func _row_nodes(p: PKeySettingsPanel, key: String) -> Dictionary:
	return p._controls.get(key, {})


func _settings(t: PKeyTestContext) -> void:
	var sdk: Node = await _sc.settings_sdk({})
	var p := PKeySettingsPanel.new()
	p.sdk = sdk
	_sc.add(p)
	await _tree().process_frame
	var keys: Array = p.rows.map(func(r): return r["key"])
	t.check("settings: hidden keys are never rows (document hidden, catalog hidden, secrets, flags)", not keys.has("game.tuning") and not keys.has("debug.overlay") and not keys.has("leaderboard.key") and not keys.has("extras.skins"), str(keys))
	t.check("settings: grouped by category, sorted by ui.order, the locked rows last as Managed settings", keys == ["audio.volume", "audio.muted", "audio.pitch", "ui.theme", "ui.reducedMotion", "net.proxyUrl", "net.proxyPassword", "notes.motd", "game.killSwitch"], str(keys))
	var kill := _row_nodes(p, "game.killSwitch")
	var kill_input: Control = kill.get("input")
	t.check("settings: an enforced setting is text, never a dimmed control", kill_input is Label and not (kill_input as Label).text.is_empty() and not kill_input is BaseButton, str(kill_input))
	t.check("settings: an enforced setting says who set it (the product's name) with a lock", (kill["set_by"] as Label).visible and (kill["set_by"] as Label).text == "Set by %s" % PKeyUiTheme.isolate(PKeySettingsController.product_name(sdk)) and not PKeySettingsController.product_name(sdk).is_empty() and (kill["lock"] as Control).visible and (kill["lock_row"] as Control).visible)
	var before: StringName = sdk.config.get_source("audio.volume")
	var vol := _row_nodes(p, "audio.volume")
	var spin: Range = vol.get("input")
	spin.value = 35
	await _tree().process_frame
	var store: PKeyOverrideStore = sdk.config.get_override_store()
	t.check("settings: editing a default setting writes the override store", store.has_override("audio.volume") and store.get_override("audio.volume") == 35, str(store.values))
	t.check("settings: ... and get_source() becomes local", before == &"remote-default" and sdk.config.get_source("audio.volume") == &"local" and sdk.config.get_value("audio.volume") == 35, "%s -> %s" % [before, sdk.config.get_source("audio.volume")])
	vol = _row_nodes(p, "audio.volume")
	t.check("settings: a local row shows its badge and Reset to default", (vol["status"] as Label).text == "Changed by you" and (vol["reset"] as Button).visible)
	(vol["reset"] as Button).pressed.emit()
	await _tree().process_frame
	t.check("settings: Reset to default clears the override", not store.has_override("audio.volume") and sdk.config.get_source("audio.volume") == &"remote-default")
	# An enforced key ignores an attempted write and keeps the saved player value untouched.
	p._write("game.killSwitch", false)
	t.check("settings: an enforced key is never written", not store.has_override("game.killSwitch"))
	# dependsOn follows the value it depends on.
	var theme_row := _row_nodes(p, "ui.theme")
	(theme_row["input"] as OptionButton).select(1)
	(theme_row["input"] as OptionButton).item_selected.emit(1)
	await _tree().process_frame
	t.check("settings: dependsOn hides a row when its condition fails", not p._controls.has("ui.reducedMotion") and sdk.config.get_value("ui.theme") == "light")
	_free(p)
	sdk.queue_free()


static func _joy_button(button: int) -> void:
	for pressed in [true, false]:
		var e := InputEventJoypadButton.new()
		e.button_index = button
		e.pressed = pressed
		_tree().root.push_input(e)


## A dialog opened over a focused game control takes the focus (a pad's A answers the dialog, never
## the game's button), a pad's B closes it, and the game's control has its focus back (the pad's
## real button events, and the engine's default input map without a joypad binding).
func _dialogs_take_focus(t: PKeyTestContext) -> void:
	PKeyUiView.pointer_last = false
	PKeyUiView._pointer_known = true
	PKeyUiView.mobile_override = false
	PKeyUiView.pad_only_override = false
	# The pad bindings: a joypad A and B on ui_accept and ui_cancel, once, the game's own kept.
	PKeyUiView.ensure_pad_bindings()
	for pair in [["ui_accept", JOY_BUTTON_A], ["ui_cancel", JOY_BUTTON_B]]:
		var pads := InputMap.action_get_events(pair[0]).filter(func(e): return e is InputEventJoypadButton and (e as InputEventJoypadButton).button_index == pair[1])
		t.check("dialog focus: %s has the pad's joypad binding exactly once" % pair[0], pads.size() == 1, str(pads.size()))
	var cases := {
		"update modal": func() -> Control:
			var p := PKeyUpdatePrompt.new()
			p.outlet = "direct"
			p.modal = true
			p.show_when_current = true
			p.auto_sdk = false
			_tree().root.add_child(p)
			p.show_result(_sc.update_check({"action": "binary", "method": "download", "release": {"version": "1.5.0", "seq": 15, "sha256": "ab"}, "build": "macos-dmg", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}))
			return p,
		"standalone sign-in": func() -> Control:
			var d := PKeySignInDialog.new()
			d.now_source = func(): return SCENARIOS.NOW
			d.auto_sdk = false
			_tree().root.add_child(d)
			d.show_prompt(_sc.prompt_fixture())
			d.closed.connect(func() -> void: d.visible = false)
			return d,
		"standalone offline": func() -> Control:
			var d := PKeyOfflineDialog.new()
			d.web_override = 0
			d.product = "djdl"
			d.device_id = "Q2hYlBg0Zx9uR7m1VvC4tKpE8sWnJ3aD"
			d.auto_sdk = false
			_tree().root.add_child(d)
			d.refresh_view()
			d.closed.connect(func() -> void: d.visible = false)
			return d,
	}
	for name in cases:
		var game := Button.new()
		game.text = "Game menu"
		var pressed := [0]
		game.pressed.connect(func() -> void: pressed[0] += 1)
		_tree().root.add_child(game)
		game.grab_focus()
		await _tree().process_frame
		var dialog: Control = cases[name].call()
		await _tree().create_timer(0.35).timeout
		var owner := _tree().root.gui_get_focus_owner()
		t.check("dialog focus: %s takes the focus from the game's control" % name, owner != null and dialog.is_ancestor_of(owner), str(owner))
		_joy_button(JOY_BUTTON_A)
		await _tree().process_frame
		t.check("dialog focus: %s, a pad's A never presses the game's button" % name, pressed[0] == 0, str(pressed[0]))
		_joy_button(JOY_BUTTON_B)
		await _tree().process_frame
		await _tree().process_frame
		t.check("dialog focus: %s, a pad's B closes it and the game's control has the focus again" % name, not dialog.is_visible_in_tree() and _tree().root.gui_get_focus_owner() == game, "%s visible %s focus %s" % [name, dialog.is_visible_in_tree(), _tree().root.gui_get_focus_owner()])
		_free(dialog)
		_free(game)
	# Settings freed instead of hidden: the game's control has its focus back too.
	var game := Button.new()
	game.text = "Game menu"
	_tree().root.add_child(game)
	game.grab_focus()
	await _tree().process_frame
	var sdk: Node = await _sc.settings_sdk({})
	var panel := PKeySettingsPanel.new()
	panel.sdk = sdk
	panel.auto_sdk = false
	_tree().root.add_child(panel)
	await _tree().create_timer(0.35).timeout
	var owner := _tree().root.gui_get_focus_owner()
	t.check("dialog focus: settings takes the focus from the game's control", owner != null and panel.is_ancestor_of(owner), str(owner))
	panel.get_parent().remove_child(panel)
	panel.queue_free()
	await _tree().process_frame
	await _tree().process_frame
	t.check("dialog focus: settings freed by the game gives the focus back", _tree().root.gui_get_focus_owner() == game, str(_tree().root.gui_get_focus_owner()))
	# A view the game moves to another parent keeps the control that opened it; closing it later
	# still gives that control the focus back.
	game.grab_focus()
	await _tree().process_frame
	var moved := PKeySettingsPanel.new()
	moved.sdk = sdk
	moved.auto_sdk = false
	_tree().root.add_child(moved)
	await _tree().create_timer(0.35).timeout
	var stand_in := Control.new()
	_tree().root.add_child(stand_in)
	moved.get_parent().remove_child(moved)
	stand_in.add_child(moved)
	await _tree().process_frame
	await _tree().process_frame
	t.check("dialog focus: a re-parented view keeps its opener", moved.get("_opener") == game, str(moved.get("_opener")))
	moved.visible = false
	await _tree().process_frame
	await _tree().process_frame
	t.check("dialog focus: a re-parented view, once closed, gives the focus back", _tree().root.gui_get_focus_owner() == game, str(_tree().root.gui_get_focus_owner()))
	_free(stand_in)
	sdk.queue_free()
	_free(game)


## A stand-in SDK whose license answers the device limit after a short wait (the real busy -> await
## -> result path, not a direct `show_result`).
class LimitLicense:
	extends RefCounted

	func activate_with_key(_key: String) -> PKeyActivationResult:
		await (Engine.get_main_loop() as SceneTree).create_timer(0.3).timeout
		var r := PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyErrors.DEVICE_LIMIT, "", 403)
		r.limit = 3
		r.device_count = 3
		r.manage_url = "https://key.plrs.im/activate?product=djdl"
		return r


class LimitSdk:
	extends Node
	signal state_changed(s)
	var license := LimitLicense.new()

	func status() -> Dictionary:
		return {"status": "needs-activation"}


static func _key_event(vp: Viewport, code: int) -> void:
	for pressed in [true, false]:
		var e := InputEventKey.new()
		e.keycode = code
		e.physical_keycode = code
		e.pressed = pressed
		vp.push_input(e)


static func _joy_in(vp: Viewport, button: int) -> void:
	for pressed in [true, false]:
		var e := InputEventJoypadButton.new()
		e.button_index = button
		e.pressed = pressed
		vp.push_input(e)


## The device limit reached through the gate (type a key, Activate by pad A, Enter in the field, or a
## result handed in directly): the limit view's primary has the focus, with its ring, afterwards.
## The activation panel sits inside the gate, which owns the focus (it was `<none>` before).
func _gate_limit_focus(t: PKeyTestContext) -> void:
	PKeyUiView.pointer_last = false
	PKeyUiView._pointer_known = true
	PKeyUiView.mobile_override = false
	PKeyUiView.pad_only_override = false
	PKeyUiView.ensure_pad_bindings()
	for how in ["pad A on Activate", "Enter in the key field", "a result handed in directly"]:
		var sdk := LimitSdk.new()
		_tree().root.add_child(sdk)
		var vp := SubViewport.new()
		vp.size = Vector2i(1280, 720)
		_tree().root.add_child(vp)
		var g := PKeyGateView.new()
		g.auto_sdk = false
		g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, true, false))
		vp.add_child(g)
		g.sdk = sdk
		g.activation.sdk = sdk
		g.show_state({"status": "needs-activation"})
		await _tree().create_timer(0.1).timeout
		var key := g.find_child("KeyInput", true, false) as LineEdit
		key.grab_focus()
		key.text = "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV"
		await _tree().process_frame
		match how:
			"pad A on Activate":
				(g.find_child("Activate", true, false) as Button).grab_focus()
				await _tree().process_frame
				_joy_in(vp, JOY_BUTTON_A)
			"Enter in the key field":
				_key_event(vp, KEY_ENTER)
			_:
				var r: PKeyActivationResult = await sdk.license.activate_with_key("k")
				g.activation.show_result(r, "k")
		await _tree().create_timer(0.8).timeout
		var f := vp.gui_get_focus_owner()
		var shows := not g.activation.limit.is_empty()
		t.check("gate limit focus: %s reaches the device limit" % how, shows)
		t.check("gate limit focus: %s, the limit view's primary has the focus" % how, shows and f != null and f.name == "FreeDevice", str(f))
		var ring := f != null and f.has_focus() and f.focus_mode != Control.FOCUS_NONE and not (f.get_theme_stylebox("focus") is StyleBoxEmpty) and f.is_visible_in_tree() and g.get_global_rect().encloses(f.get_global_rect())
		t.check("gate limit focus: %s, the focused control draws a ring and is on screen" % how, ring, "%s %s %s %s" % [f, f.get_theme_stylebox("focus") if f else null, f.get_global_rect() if f else null, g.get_global_rect()])
		vp.queue_free()
		sdk.queue_free()


## The sign-in starts with focus on Cancel (nothing else exists yet); when the code arrives, and
## again when it expires, the focus moves to the new screen's primary.
func _focus_follows_screen(t: PKeyTestContext) -> void:
	PKeyUiView.pointer_last = false
	PKeyUiView._pointer_known = true
	var d := PKeySignInDialog.new()
	d.now_source = func(): return SCENARIOS.NOW
	d.auto_sdk = false
	_tree().root.add_child(d)
	d.show_starting()
	await _tree().create_timer(0.35).timeout
	t.check("focus follows the screen: sign-in starting holds focus inside", d._has_focus_inside())
	d.show_prompt(_sc.prompt_fixture())
	await _tree().process_frame
	await _tree().process_frame
	var f := _tree().root.gui_get_focus_owner()
	t.check("focus follows the screen: the code arriving moves focus from Cancel to Open browser", f != null and f.name == "OpenBrowser", str(f))
	d.show_result(PKeySignInResult.ended(PKeySignInResult.KIND_EXPIRED, PKeyErrors.SIGN_IN_EXPIRED, ""))
	await _tree().process_frame
	await _tree().process_frame
	f = _tree().root.gui_get_focus_owner()
	t.check("focus follows the screen: an expired code moves focus to Get a new code", f != null and f.name == "TryAgain", str(f))
	_free(d)


## The kit in a running game (KX-GD-PLAY): it keeps running while the tree is paused, says when it
## takes the input, shows an update only as a toast while `in_play`, and draws the changelog facts.
func _play(t: PKeyTestContext) -> void:
	# The headless runner's window is tiny, and a short screen gives the notes up (squeeze): measure on a game-sized one.
	var saved_size := _tree().root.size
	_tree().root.size = Vector2i(1152, 900)
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	var offer: PKeyUpdateCheck = _sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false})
	var locked: PKeyUpdateCheck = _sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false})
	var sdk: Node = load("res://addons/polaris_key/polaris_key.gd").new()
	sdk.name = "PlaySdk"
	_tree().root.add_child(sdk)
	PKeyUiTheme.product_name = "Tidewater"
	# Paused tree: every kit node runs, the autoload included; the game can override it.
	var fresh_prompt := PKeyUpdatePrompt.new()
	var fresh_toast := PKeyToast.new()
	t.check("play: the SDK and every view run while the tree is paused", sdk.process_mode == Node.PROCESS_MODE_ALWAYS and fresh_prompt.process_mode == Node.PROCESS_MODE_ALWAYS and fresh_toast.process_mode == Node.PROCESS_MODE_ALWAYS)
	fresh_prompt.free()
	fresh_toast.free()
	var p := PKeyUpdatePrompt.new()
	p.modal = true
	p.outlet = "direct"
	p.release_url = "https://example.com/dl"
	p.process_mode = Node.PROCESS_MODE_PAUSABLE
	t.check("play: the game can override the process mode", p.process_mode == Node.PROCESS_MODE_PAUSABLE)
	p.process_mode = Node.PROCESS_MODE_ALWAYS
	p.auto_sdk = false
	p.sdk = sdk
	_tree().root.add_child(p)
	_tree().paused = true
	t.check("play: a prompt in a paused tree can process", p.can_process())
	_tree().paused = false
	# in_play: an available update is a toast; the prompt waits.
	var caught: Array = []
	sdk.input_captured.connect(func(on: bool) -> void: caught.append(on))
	t.check("play: in_play is false by default and nothing is captured", sdk.in_play == false and not sdk.is_input_captured())
	sdk.in_play = true
	p.show_result(offer)
	await _tree().process_frame
	var host: PKeyToast = sdk.toasts()
	t.check("play: in play an available update is only a toast", p.presentation() == "toast" and not p.visible and host.current.get("kind") == "update" and host.current.get("version") == "1.5.0", str(host.current))
	t.check("play: the toast sits at the SDK's anchor (bottom centre by default) and takes no input", host.toast_anchor == "bottom_center" and caught.is_empty() and not sdk.is_input_captured())
	sdk.toast_anchor = "top_right"
	t.check("play: PolarisKey.toast_anchor places it", host.toast_anchor == "top_right")
	sdk.toast_anchor = "bottom_center"
	# A locked answer is a banner, in play too.
	p.show_result(locked)
	t.check("play: a mandatory answer stays the banner in play", p.presentation() == "banner" and p.visible)
	p.show_result(offer)
	await _tree().process_frame
	# The toast runs out: the prompt still shows once play ends, the modal on Later with the guard.
	host.dismiss()
	t.check("play: Dismiss on the toast is Later", p.is_dismissed and not p.visible)
	p.show_result(offer)
	await _tree().process_frame
	host._close("timeout")
	t.check("play: a toast that ran out is not a dismissal", not p.is_dismissed and p.presentation() == "")
	sdk.in_play = false
	await _tree().process_frame
	await _tree().process_frame
	t.check("play: when play ends the modal opens", p.presentation() == "modal" and p.visible and host.current.is_empty())
	var focus := _tree().root.gui_get_focus_owner()
	t.check("play: the modal focuses Later and ignores input for 250 ms", focus != null and focus.name == "Dismiss" and p._guard_until > Time.get_ticks_msec(), str(focus))
	t.check("play: the modal says the kit holds the input", caught == [true] and sdk.is_input_captured(), str(caught))
	p._on_dismiss()
	t.check("play: dismissing gives the input back", caught == [true, false] and not sdk.is_input_captured(), str(caught))
	# What's new, You have, All changes.
	p.is_dismissed = false
	p._notes["1.5.0"] = {"lines": ["Faster loading", "New tide table"], "url": "https://example.com/r/1.5.0"}
	p.show_result(offer)
	await _tree().process_frame
	var head := p.find_child("WhatsNew", true, false) as Label
	var lines := p.find_child("WhatsNewLines", true, false) as Label
	var all := p.find_child("AllChanges", true, false) as Button
	t.check("play: the modal draws What's new, its lines and the All changes link", head.visible and head.text == "What's new" and lines.text == "Faster loading\nNew tide table" and all.visible and all.text == "All changes in 1.5.0", "%s|%s|%s" % [head.text, lines.text, all.text])
	# A short screen gives the notes up before the action leaves it.
	_tree().root.size = Vector2i(844, 390)
	for i in 6:
		await _tree().process_frame
	var action := p.find_child("Action", true, false) as Button
	t.check("play: on a short screen the notes give way and the action stays", (not lines.visible or lines.text.count("\n") < 2) and action.get_global_rect().end.y <= 390.5, "squeeze %d lines '%s' action %s" % [p.squeeze_level(), lines.text, action.get_global_rect()])
	_tree().root.size = Vector2i(1152, 900)
	for i in 3:
		await _tree().process_frame
	p._notes["1.5.0"] = {"lines": [], "url": ""}
	p.refresh_view()
	t.check("play: no summary hides the label, no page hides the link", not head.visible and not all.visible)
	t.check("play: notes are at most three plain lines", PKeyUpdatePromptController.summary_lines("- one\n\n* two\r\n## three\nfour\n") == ["one", "two", "three"] and PKeyUpdatePromptController.summary_lines(null) == [] and PKeyUpdatePromptController.summary_lines("<b>x</b>") == ["<b>x</b>"])
	var entries := [PKeyChangelogEntry.from_dict({"version": "1.4.0", "tag": "v1.4.0", "summary": "old", "url": "https://x/1.4"}), PKeyChangelogEntry.from_dict({"version": "1.5.0", "tag": "v1.5.0", "summary": "new", "url": "https://x/1.5"})]
	t.check("play: the entry is the offered version's", PKeyUpdatePromptController.entry_for(entries, "1.5.0").url == "https://x/1.5" and PKeyUpdatePromptController.entry_for(entries, "9.9.9") == null)
	_free(p)
	await _tree().process_frame
	t.check("play: freeing the modal gives the input back", not sdk.is_input_captured())
	# Gate and boot: Signed in and Copied toasts through the shared host.
	var g := PKeyGateView.new()
	g.auto_sdk = false
	g.sdk = sdk
	_tree().root.add_child(g)
	g._on_signed_in(PKeySignInResult.signed_in({"name": "Mara"}, "", true, null))
	t.check("play: the gate toasts the sign-in", host.current.get("kind") == "success" and String(host.current.get("title")).contains("Mara") and String(host.current.get("title")).begins_with("Signed in as"), str(host.current))
	g.note_copied()
	t.check("play: the gate toasts a copied link", host.current.get("kind") == "copied")
	var b := PKeyBoot.new()
	b.auto_sdk = false
	b.sdk = sdk
	_tree().root.add_child(b)
	host.dismiss()
	b.gate.note_copied()
	t.check("play: the boot toasts a copied code", host.current.get("kind") == "copied")
	_free(g)
	_free(b)
	PKeyUiTheme.reset()
	sdk.queue_free()
	_tree().root.size = saved_size
	# Let the frees land before the next test times a 250 ms input guard against its own frames.
	for i in 3:
		await _tree().process_frame


func _update_prompt(t: PKeyTestContext) -> void:
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	var locked: PKeyUpdateCheck = _sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false})
	var p := PKeyUpdatePrompt.new()
	p.modal = true
	p.outlet = "direct"
	p.release_url = "https://example.com/dl"
	_sc.add(p)
	p.show_result(_sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}))
	t.check("update: a dismissable answer may be modal", p.presentation() == "modal")
	p.show_result(locked)
	var dismiss := p.find_child("Dismiss", true, false) as Button
	t.check("update: a mandatory answer is a banner even when modal is asked", p.presentation() == "banner" and p.anchor_bottom == 0.0, "%s anchor_bottom=%s" % [p.presentation(), p.anchor_bottom])
	t.check("update: a locked answer has no dismiss", not dismiss.visible)
	p._on_dismiss()
	t.check("update: a locked answer cannot be dismissed", p.visible)
	p.show_result(_sc.update_check({"action": "blocked", "reason": "app-floor", "discardStaged": false}))
	t.check("update: a blocked answer is locked, never covering", p.presentation() == "banner" and p.model["locked"] and not dismiss.visible and p.anchor_bottom == 0.0)
	p.show_result(_sc.update_check({"action": "none", "reason": "up-to-date", "behind": false, "discardStaged": false}))
	p.show_when_current = false
	p.refresh_view()
	t.check("update: none shows nothing", not p.visible)
	_free(p)
	# Per build: a store, Steam or itch build never opens a download page.
	var m := PKeyUpdatePromptController.model(PKeyVersionCheck.of("2.0.0", "", "https://example.com/r", true), "steam")
	t.check("update: a v3 answer on a Steam build offers no download page", m["action"] == "" and m["visible"])
	m = PKeyUpdatePromptController.model(PKeyVersionCheck.of("2.0.0", "", "https://example.com/r", true), "direct")
	t.check("update: a v3 answer on a direct build opens its release page", m["action_url"] == "https://example.com/r")
	# The v3 `url` is unsigned: only an https link is ever offered to OS.shell_open.
	for bad in ["file:///etc/passwd", "myapp://run", "http://example.com/r", "https://"]:
		m = PKeyUpdatePromptController.model(PKeyVersionCheck.of("2.0.0", "", bad, true), "direct")
		t.check("update: a v3 url %s offers no action" % bad, m["action"] == "" and m["action_url"] == "" and m["visible"])
	t.check("update: update_url drops a non-https release_url", PKeyUpdatePromptController.update_url(null, "direct", "file:///x") == "")
	# plans/P4-13.md §2.6: `packs` shows nothing (the boot's FETCH applies it); a content floor is a
	# locked banner with its own body; revoked REQUIRED content is the hard stop's copy, with the
	# offer's action for an offer and none for blocked.
	var packs_answer = _sc.update_check({"action": "packs", "install": [], "revoke": ["djdl.levels"], "set": [], "discardStaged": false})
	m = PKeyUpdatePromptController.model(packs_answer, "direct")
	t.check("update: a packs answer shows nothing", not m["visible"] and not m["required"])
	m = PKeyUpdatePromptController.model(_sc.update_check({"action": "blocked", "reason": "content-floor", "discardStaged": false}), "direct")
	t.check("update: a content floor is a locked banner with the content-floor body", m["visible"] and m["locked"] and not m["required"] and m["body"] == "update_content_floor_body")
	m = PKeyUpdatePromptController.model(_sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false, "contentBlock": "content-floor"}), "direct", "https://example.com/dl")
	t.check("update: an offer made mandatory by a content floor keeps its action", m["locked"] and not m["required"] and m["body"] == "update_content_floor_body" and m["action"] != "")
	m = PKeyUpdatePromptController.model(_sc.update_check({"action": "blocked", "reason": "revoked-content", "discardStaged": false}), "direct", "https://example.com/dl")
	t.check("update: revoked content blocked is the hard stop's copy with no action", m["visible"] and m["required"] and m["locked"] and m["title"] == "update_revoked_title" and m["body"] == "update_revoked_body" and m["action"] == "" and m["action_url"] == "")
	m = PKeyUpdatePromptController.model(_sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false, "contentBlock": "revoked-content"}), "direct", "https://example.com/dl")
	t.check("update: a revoked-content offer keeps the offer's action under the hard stop's copy", m["required"] and m["title"] == "update_revoked_title" and m["action"] != "")


# A locked update answer and grace's banner are strips, measured: a Container parent ignores a
# child's anchors, so `anchor_bottom == 0` proves nothing once the view sits in PKeyBoot, the
# gate or a game's own layout. Each check compares rendered heights after a layout pass.
func _never_covering(t: PKeyTestContext) -> void:
	# The headless runner's window is tiny; measure on a game-sized screen.
	var saved_size := _tree().root.size
	_tree().root.size = Vector2i(1152, 900)
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	var answers := {
		"mandatory": _sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false}),
		"blocked": _sc.update_check({"action": "blocked", "reason": "app-floor", "discardStaged": false}),
	}
	for kind in answers:
		var boot := PKeyBoot.new()
		_sc.add(boot)
		boot.prompt.modal = true
		boot.prompt.show_result(answers[kind])
		boot.refresh_view()
		await _tree().process_frame
		await _tree().process_frame
		var pr := boot.prompt.get_global_rect()
		var br := boot.get_global_rect()
		var dismiss := boot.prompt.find_child("Dismiss", true, false) as Button
		t.check("never covering: a %s answer in PKeyBoot is a strip at the top" % kind, boot.prompt.is_visible_in_tree() and boot.prompt.presentation() == "banner" and pr.size.y > 0.0 and pr.size.y < br.size.y * 0.25 and is_equal_approx(pr.position.y, br.position.y), "prompt %s in boot %s" % [pr, br])
		t.check("never covering: a %s answer in PKeyBoot has no dismiss" % kind, not dismiss.visible)
		t.check("never covering: PKeyBoot's prompt overlay takes no input", boot.get_node("Overlay").mouse_filter == Control.MOUSE_FILTER_IGNORE)
		_free(boot)
	# A game's own layout: the prompt inside a container still asks only for its own height.
	var frame := PanelContainer.new()
	frame.size = Vector2(900, 1400)
	_tree().root.add_child(frame)
	var p := PKeyUpdatePrompt.new()
	p.auto_sdk = false
	p.modal = true
	frame.add_child(p)
	p.show_result(answers["blocked"])
	await _tree().process_frame
	await _tree().process_frame
	t.check("never covering: a locked answer inside a game's container is a strip", p.size.y > 0.0 and p.size.y < frame.size.y * 0.25, str(p.get_rect()))
	frame.get_parent().remove_child(frame)
	frame.queue_free()
	# Grace: the gate shows only the banner strip and lets the game take its input.
	var g := PKeyGateView.new()
	_sc.add(g)
	g.show_state({"status": "grace", "grace_until": 0})
	await _tree().process_frame
	await _tree().process_frame
	var slot := g.get_node("BannerSlot") as Control
	var gr := g.get_global_rect()
	var sr := slot.get_global_rect()
	t.check("never covering: grace's banner is a strip at the top of the gate", slot.is_visible_in_tree() and sr.size.y > 0.0 and sr.size.y < gr.size.y * 0.25 and is_equal_approx(sr.position.y, gr.position.y), "banner %s in gate %s" % [sr, gr])
	t.check("never covering: in grace no full-rect control catches the game's clicks", g.mouse_filter == Control.MOUSE_FILTER_IGNORE and (g.get_node("Center") as Control).mouse_filter == Control.MOUSE_FILTER_IGNORE and slot.mouse_filter == Control.MOUSE_FILTER_IGNORE)
	_free(g)
	_tree().root.size = saved_size


func _activation_copy(t: PKeyTestContext) -> void:
	var kinds := [
		PKeyActivationResult.KIND_OK, PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyActivationResult.KIND_UNAUTHORIZED,
		PKeyActivationResult.KIND_FINGERPRINT_REQUIRED, PKeyActivationResult.KIND_ENROLL_DISABLED, PKeyActivationResult.KIND_ENROLL_CLAIMED,
		PKeyActivationResult.KIND_LICENSE_DISABLED, PKeyActivationResult.KIND_HARDWARE_MISMATCH, PKeyActivationResult.KIND_RATE_LIMITED,
		PKeyActivationResult.KIND_UNSUPPORTED, PKeyActivationResult.KIND_ERROR,
		PKeyActivationResult.KIND_LICENSE_EXPIRED, PKeyActivationResult.KIND_ATTESTATION_REQUIRED, PKeyActivationResult.KIND_REFUSED,
	]
	var keys := {}
	for k in kinds:
		var m := PKeyActivationController.message_for(PKeyActivationResult.of(k, &"x", ""))
		keys[m[0]] = true
		t.check("activation: %s has its own copy" % k, PKeyUiCopy.DEFAULTS.has(m[0]), m[0])
	t.check("activation: every kind reads differently", keys.size() == kinds.size())
	# SDK parity §3.2: a refusal reads by its code, a missing code falls back to a generic line
	# with the code, never the raw body.
	var c := PKeyUiCopy.new()
	var refused := PKeyActivationController.message_for(PKeyActivationResult.of(PKeyActivationResult.KIND_REFUSED, &"registration_closed", "raw body", 403))
	t.check("copy: refused registration_closed reads its own copy", refused[0] == "error_registration_closed")
	var unknown := PKeyActivationController.message_for(PKeyActivationResult.of(PKeyActivationResult.KIND_REFUSED, &"brand_new_code", "raw body", 403))
	t.check("copy: an unknown code falls back to the generic line with the code", unknown == ["error_generic", "brand_new_code"] and c.text(unknown[0], unknown[1]).contains("brand_new_code") and not c.text(unknown[0], unknown[1]).contains("raw body"))
	for code in ["registration_closed", "attestation_required", "attestation_rejected", "attestation_unavailable", "managed_by_admin", "not_entitled", "license_expired", "catalog_unavailable", "value_not_representable", "document_not_representable", "mint-unavailable", "unavailable", "pack-not-entitled", "pack-not-pinned", "pack-revoked", "pack-type-unsupported", "pack-no-variant", "plan-insufficient-disk", "network-error", "timeout", "no-token"]:
		t.check("copy: %s has its own message" % code, PKeyUiCopy.code_key(code)[0] == "error_" + code)
	for code in PKeyConstants.ERROR_CODE_VALUES:
		if PKeyUiCopy.DEFAULTS.has("error_" + code):
			continue
		t.check("copy: %s still reads as words" % code, c.for_code(code) != "" and c.for_code(code) != code)
	for reason in ["no_license", "binding_mismatch", "bound_elsewhere", "unbound", "not_owned", "test_purchase", "invalid_ticket"]:
		t.check("copy: commerce reason %s wins over its code" % reason, PKeyUiCopy.code_key("forbidden", reason)[0] == "reason_" + reason)
	var body := PKeyErrors.read_body('{"error":{"code":"forbidden","reason":"bound_elsewhere"}}'.to_utf8_buffer())
	var fr := PKeyResult.failure(&"forbidden", "x", {"status": 403, "error": body})
	t.check("copy: for_result reads the server's reason", c.for_result(fr) == c.text("reason_bound_elsewhere"))
	var empty := PKeyUiCopy.DEFAULTS.keys().filter(func(k): return String(PKeyUiCopy.DEFAULTS[k]).strip_edges() == "")
	t.check("copy: no template is empty", empty.is_empty(), str(empty))


func _sign_in_copy(t: PKeyTestContext) -> void:
	for k in [PKeySignInResult.KIND_OK, PKeySignInResult.KIND_EXPIRED, PKeySignInResult.KIND_CANCELLED, PKeySignInResult.KIND_DENIED, PKeySignInResult.KIND_DEVICE_MISMATCH, PKeySignInResult.KIND_RATE_LIMITED, PKeySignInResult.KIND_SERVICE_UNAVAILABLE, PKeySignInResult.KIND_TIMEOUT, PKeySignInResult.KIND_ERROR]:
		t.check("sign-in: %s has copy" % k, PKeyUiCopy.DEFAULTS.has(PKeySignInController.message_for(k)))


func _gate(t: PKeyTestContext) -> void:
	var g := PKeyGateView.new()
	_sc.add(g)
	var usable := [0]
	var retried := [0]
	g.usable.connect(func(): usable[0] += 1)
	g.retry_requested.connect(func(): retried[0] += 1)
	g.managed_retry = true
	g.show_state({"status": "ok"})
	await _tree().process_frame
	t.check("gate: ok hides the gate and emits usable", not g.visible and usable[0] == 1)
	g.show_state({"status": "not-applicable"})
	await _tree().process_frame
	t.check("gate: not-applicable stays usable without a second emit", not g.visible and usable[0] == 1)
	g.show_state({"status": "grace", "grace_until": 0})
	await _tree().process_frame
	t.check("gate: grace is usable, shows only the banner and lets input through", g.visible and g.screen == "grace" and g.mouse_filter == Control.MOUSE_FILTER_IGNORE and not g.get_node("Center/Card").visible)
	g.allow_grace = false
	g.show_state({"status": "grace", "grace_until": 0})
	t.check("gate: grace with allow_grace false blocks", g.screen == "grace-blocked" and g.get_node("Center/Card").visible)
	g.show_state({"status": "expired"})
	await _tree().process_frame
	var other := g.find_child("UseAnotherLicense", true, false) as Button
	t.check("gate: expired without a renew path offers Use another license alone, as the primary", g.find_child("Renew", true, false).text == "" and other.text == "Use another license" and other.theme_type_variation == &"PKeyPrimary" and g.find_child("Retry", true, false).text == "")
	other.pressed.emit()
	await _tree().process_frame
	t.check("gate: Use another license goes to key entry", g.activation.visible and g.find_child("KeyInput", true, false) != null)
	g.show_state({"status": "ok"})
	g.show_state({"status": "expired"})
	g.renew_url = "http://insecure.example/renew"
	g.refresh_view()
	t.check("gate: a non-https renew_url is no renew path", not g.can_renew())
	g.renew_url = "https://example.com/renew"
	g.refresh_view()
	await _tree().process_frame
	var renew := g.find_child("Renew", true, false) as Button
	t.check("gate: expired with an https renew_url draws Renew first, with the new-window glyph, and no Try again", renew.text == "Renew" and renew.icon != null and renew.theme_type_variation == &"PKeyPrimary" and g.find_child("UseAnotherLicense", true, false).text == "Use another license" and g.find_child("Retry", true, false).text == "")
	g.renew_url = ""
	var renewed := [0]
	g.renew_requested.connect(func(): renewed[0] += 1)
	g.refresh_view()
	await _tree().process_frame
	t.check("gate: a renew handler alone draws Renew without the glyph", renew.text == "Renew" and renew.icon == null)
	renew.pressed.emit()
	t.check("gate: Renew emits renew_requested", renewed[0] == 1)
	_free(g)


func _dev_menu(t: PKeyTestContext) -> void:
	var f: Dictionary = _sc.dev_facts("steam")
	f["token"] = "pkeyt_SECRETSECRETSECRETSECRETSECRETSECRET00"
	var text := PKeyDevMenuController.diagnostics(f)
	t.check("dev menu: diagnostics carry the eight facts", text.split("\n").size() == 8 and text.contains("device: Q2hY") and text.contains("outlet: steam") and text.contains("build: 1.2.0 (42)"), text)
	t.check("dev menu: diagnostics never carry a token", not text.contains("pkeyt_"))
	t.check("dev menu: a Steam build's channel is locked; direct and the editor are not", PKeyDevMenuController.channel_lock("steam") == "steam" and PKeyDevMenuController.channel_lock("direct") == "" and PKeyDevMenuController.channel_lock("") == "")
	var d := PKeyDevMenuSection.new()
	d.facts_override = _sc.dev_facts("")
	d.entitled_override = ["beta"]
	var ids: Array = d.rows().map(func(r): return r["id"])
	t.check("dev menu: rows() offers the same section as data", ids == ["channel", "build", "outlet", "sdk", "engine", "device", "gate", "last_sync", "copy_diagnostics", "force_check"], str(ids))
	d.free()


func _controllers(t: PKeyTestContext) -> void:
	# PX-W8: "Replace a device" — a button where a browser is at hand, a QR code where a joypad is
	# the only input; the link carries the key fragment (on /activate only) and the game's return.
	t.check("manage: desktop, web and touch phones get a button", PKeyActivationController.manage_presentation("Windows", false, 1) == "button" and PKeyActivationController.manage_presentation("Web", false, 0) == "button" and PKeyActivationController.manage_presentation("Android", true, 1) == "button")
	t.check("manage: a TV or console gets a QR code", PKeyActivationController.manage_presentation("Android", false, 1) == "qr" and PKeyActivationController.manage_presentation("Switch", false, 1) == "qr")
	var limited := PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyErrors.DEVICE_LIMIT, "", 403)
	limited.manage_url = "https://key.plrs.im/activate?product=djdl&next=free-device"
	var link := PKeyActivationController.manage_link(limited, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", "mygame://done")
	t.check("manage: the offered link", link == "https://key.plrs.im/activate?product=djdl&next=free-device&return=mygame%3A%2F%2Fdone#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", link)
	t.check("manage: a QR link never carries the key", PKeyActivationController.manage_link(limited, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV", "mygame://done", true) == "https://key.plrs.im/activate?product=djdl&next=free-device&return=mygame%3A%2F%2Fdone")
	limited.manage_url = "https://key.plrs.im/#/p/djdl/free-device?license=lic_1"
	t.check("manage: the key never rides on a free-device link", PKeyActivationController.manage_link(limited, "pkey_x") == "https://key.plrs.im/#/p/djdl/free-device?license=lic_1")
	limited.manage_url = null
	t.check("manage: no link, no offer", PKeyActivationController.manage_link(limited, "k") == "" and PKeyActivationController.manage_link(PKeyActivationResult.of(PKeyActivationResult.KIND_UNAUTHORIZED, &"x", ""), "k") == "")
	var copy := PKeyUiCopy.DEFAULTS
	t.check("manage: copy", copy.get("free_device") == "Replace a device" and copy.has("free_device_scan"))
	var caps := PKeyActivationController.capabilities(true, true, true, true)
	t.check("activation: Continue free is never offered on web", not caps["continue_free"] and caps["key_entry"] and caps["sign_in"] and caps["offline"])
	t.check("activation: without License there is no key entry, no enrolment, no offline file", PKeyActivationController.capabilities(false, false, true, false) == {"key_entry": false, "sign_in": false, "continue_free": false, "offline": false})
	# SDK parity §3.18: key entry is hidden on store outlets automatically (App Store 3.1.1, Play).
	var store := PKeyActivationController.capabilities(true, true, true, false, true)
	t.check("activation: a store outlet hides key entry and the offline file, keeps sign-in and enrolment", not store["key_entry"] and not store["offline"] and store["sign_in"] and store["continue_free"], str(store))
	# It follows the outlet's effective capabilities (commerce `store-iap`), never a list of its own.
	for kind in ["app-store", "testflight", "play", "play-testing", "ms-store"]:
		t.check("activation: %s hides key entry" % kind, PKeyActivationController.store_hides_key_entry(kind))
	for kind in ["direct", "steam", "itch", "web", "flathub", "unknown", ""]:
		t.check("activation: %s keeps key entry" % kind, not PKeyActivationController.store_hides_key_entry(kind))
	for kind in PKeyDecision.CAPABILITY_DEFAULTS:
		var commerce: String = PKeyDecision.effective_capabilities(kind, {"platform": ""})["commerce"]
		t.check("activation: %s key entry follows commerce %s" % [kind, commerce], PKeyActivationController.store_hides_key_entry(kind) == (commerce == "store-iap"))
	var panel := PKeyActivationPanel.new()
	panel.auto_sdk = false
	_sc.add(panel)
	panel.show_result(PKeyActivationResult.of(PKeyActivationResult.KIND_DEVICE_LIMIT, PKeyErrors.DEVICE_LIMIT, "", 403))
	t.check("activation: device-limit without a served link offers no Replace a device", panel.last_kind == PKeyActivationResult.KIND_DEVICE_LIMIT and not panel._manage.visible)
	_free(panel)
	var screens := {}
	for st in ["ok", "grace", "expired", "revoked", "needs-activation", "version-too-old", "version-too-new", "channel-not-entitled", "not-applicable"]:
		screens[st] = PKeyGateController.screen_for(st)
	t.check("gate: screenFor", screens == {"ok": "usable", "grace": "grace", "expired": "expired", "revoked": "revoked", "needs-activation": "activation", "version-too-old": "update-required", "version-too-new": "not-available", "channel-not-entitled": "not-available", "not-applicable": "usable"}, str(screens))
	t.check("gate: not-applicable precedes an error", PKeyGateController.screen_for("not-applicable", false, "boom") == "usable" and PKeyGateController.screen_for("needs-activation", false, "boom") == "error")
	var lines := PKeyBannerController.lines({"status": "grace", "grace_until": 1000.0 + 3 * 86400, "last_verified_at": 1000.0 - 7200}, 1000.0)
	t.check("banner: grace days and last checked", lines == [["banner_grace", "3 days"], ["banner_checked", "2 hours"]], str(lines))


# ── The product's presentation ───────────────────────────────────────────────────────────

## Every screen the kit shows carries the product's header (UI-KITS.md §1.2): its icon or a
## monogram beside its name, visible in the tree. Not a screen: the gate while it lets the game
## through (usable, grace) or loads, the update strip and banner (a card inside the game's own
## screen), the progress strip and the toast (a card over the game), and the settings panel (it heads
## itself with the same header).
const NO_HEADER := ["ok", "grace", "grace (allow_grace false)", "not-applicable", "loading", "background pill", "update available"]


func _headers(t: PKeyTestContext, all: Array) -> void:
	var checked := 0
	var missing: PackedStringArray = []
	for c in all:
		if c[0] in ["badge", "banner", "dev_menu", "settings", "update_progress", "toast"] or String(c[1]) in NO_HEADER:
			continue
		var v: Control = await _build(c)
		var ok := false
		for n in v.find_children("*", "PKeyProductHeader", true, false):
			var h := n as PKeyProductHeader
			if h.is_visible_in_tree() and h.product_name() != "" and (h.find_child("Icon", false, false).visible or h.find_child("Monogram", false, false).visible):
				ok = true
		if not ok:
			missing.append("%s / %s" % [c[0], c[1]])
		checked += 1
		_free(v)
	t.check("header: every kit screen carries the product's icon or monogram and name", missing.is_empty(), "missing: %s" % ", ".join(missing))
	t.check("header: coverage", checked >= 60, str(checked))


## The gate's hero header after a render.
func _header(v: Control) -> PKeyProductHeader:
	return v.find_child("Product", true, false) as PKeyProductHeader


func _icon_kind(h: PKeyProductHeader) -> String:
	if h.find_child("Icon", false, false).visible:
		return "image"
	return "monogram" if h.find_child("Monogram", false, false).visible else "none"


func _presentation(t: PKeyTestContext) -> void:
	await _theme_rows(t)
	_accent_dark(t)
	_contrast(t)
	await _rerender(t)
	await _keeps_texture(t)
	await _identity_order(t)
	await _kx_identity(t)
	await _set_by(t)
	PKeyUiTheme.reset()


## ui-matrix.json's theme rows, applied to the Godot kit.
func _theme_rows(t: PKeyTestContext) -> void:
	var m = PKeyTestFixtures.read_json(UI_MATRIX)
	var rows := {}
	for r in (m["theme"] if m is Dictionary else []):
		rows[r["name"]] = r
	var ran := 0
	for name in THEME_ROWS:
		if not t.check("theme row present: %s" % name, rows.has(name)):
			continue
		var input: Dictionary = rows[name]["input"]
		var want: Dictionary = rows[name]["expect"]
		PKeyUiTheme.reset()
		PKeyUiTheme.scheme = "light" if input.get("colorScheme") == "light" else "dark"
		var p = input.get("presentation")
		if p is Dictionary:
			var fields := {}
			for k in ["name", "developerName", "accent"]:
				if p.has(k):
					fields[k] = p[k]
			PRESENTATION.present(fields, p.get("icon") == true)
		var integrator: Dictionary = input.get("integrator", {})
		if integrator.get("accent") is String:
			PKeyUiTheme.accent = Color(integrator["accent"])
		if integrator.get("name") is String:
			PKeyUiTheme.product_name = integrator["name"]
		if integrator.get("icon") == true:
			PKeyUiTheme.product_icon = ImageTexture.create_from_image(PRESENTATION.icon_image(64, Color("#2f6fde")))
		var v: Control = await _sc.gate("needs-activation", true, "")
		v.refresh_view()
		await _tree().process_frame
		var h := _header(v)
		var got := {"name": h.product_name(), "accentSource": PKeyUiTheme.accent_source(), "icon": _icon_kind(h)}
		# A row the bundle names: this project stands in for the bundle (user:// follows the
		# project's name, so it is not renamed for the row).
		var bundle: bool = not (p is Dictionary and p.has("name")) and not integrator.has("name")
		var expect := {"name": str(ProjectSettings.get_setting("application/config/name")) if bundle else want["name"], "accentSource": want["accentSource"], "icon": want["icon"]}
		if String(input.get("kit")) == "godot":
			got["colorScheme"] = PKeyUiTheme.scheme
			expect["colorScheme"] = want["colorScheme"]
		if t.check("theme row: %s" % name, got == expect, "got %s, want %s" % [got, expect]):
			ran += 1
		_free(v)
	PKeyUiTheme.reset()
	t.check("theme rows: coverage", ran == THEME_ROWS.size(), "%d/%d" % [ran, THEME_ROWS.size()])


## accentDark is the product's accent in the dark scheme; accent in the light one.
func _accent_dark(t: PKeyTestContext) -> void:
	PKeyUiTheme.reset()
	PRESENTATION.present({"name": "Drift Kart", "accent": "#ff6a3d", "accentDark": "#5ee6f0"}, false)
	PKeyUiTheme.scheme = "dark"
	t.check("accent: the dark scheme takes accentDark", PKeyUiTheme.accent_hex() == "#5ee6f0" and PKeyUiTheme.accent_source() == "product", PKeyUiTheme.accent_hex())
	PKeyUiTheme.scheme = "light"
	t.check("accent: the light scheme takes accent", PKeyUiTheme.accent_hex() == "#ff6a3d" and PKeyUiTheme.accent_source() == "product", PKeyUiTheme.accent_hex())
	PRESENTATION.present({"name": "Drift Kart", "accentDark": "#5ee6f0"}, false)
	t.check("accent: accentDark alone does not colour the light scheme (ink without an icon)", PKeyUiTheme.accent_source() == "ink", PKeyUiTheme.accent_source())
	PKeyUiTheme.scheme = "dark"
	t.check("accent: accentDark alone colours the dark scheme", PKeyUiTheme.accent_hex() == "#5ee6f0")
	PKeyUiTheme.accent = Color("#2f6fde")
	t.check("accent: ui_accent wins over both", PKeyUiTheme.accent_hex() == "#2f6fde" and PKeyUiTheme.accent_source() == "integrator")
	PKeyUiTheme.reset()


## Drift Kart's accent on the built theme: the primary's label on its fill (4.5:1), the fill on the
## page (3:1) and the accent's text on the page (4.5:1), in both schemes.
func _contrast(t: PKeyTestContext) -> void:
	for scheme in ["dark", "light"]:
		PKeyUiTheme.reset()
		PRESENTATION.present(PRESENTATION.DRIFT_KART, false)
		PKeyUiTheme.scheme = scheme
		var th := PKeyUiTheme.current()
		var page := "#" + Color(PKeyUiTheme.palette(scheme == "dark")["page"]).to_html(false)
		var fill := "#" + (th.get_stylebox("normal", "PKeyPrimary") as StyleBoxFlat).bg_color.to_html(false)
		var label := "#" + th.get_color("font_color", "PKeyPrimary").to_html(false)
		var link := "#" + th.get_color("font_color", "PKeyLink").to_html(false)
		var detail := "fill %s label %s link %s page %s" % [fill, label, link, page]
		t.check("contrast (%s): the primary's label on Drift Kart's fill is at least 4.5:1" % scheme, PKeyAccent.contrast(label, fill) >= 4.5, detail)
		t.check("contrast (%s): the fill on the page is at least 3:1" % scheme, PKeyAccent.contrast(fill, page) >= 3.0, detail)
		t.check("contrast (%s): accent text on the page is at least 4.5:1" % scheme, PKeyAccent.contrast(link, page) >= 4.5, detail)
	PKeyUiTheme.reset()


## A new member re-renders every kit view (PKeyUiTheme.refresh_views on `changed`).
func _rerender(t: PKeyTestContext) -> void:
	PKeyUiTheme.reset()
	var src := PRESENTATION.present(PRESENTATION.DRIFT_KART, true)
	var v: Control = await _sc.gate("needs-activation", true, "")
	await _tree().process_frame
	var h := _header(v)
	var label := h.find_child("Name", false, false) as Label
	t.check("header: the presented name and icon", h.product_name() == "Drift Kart" and _icon_kind(h) == "image" and label.text == PKeyUiTheme.isolate("Drift Kart"), label.text)
	var renamed := PRESENTATION.member({"name": PRESENTATION.RTL_NAME, "accent": "#3d9bff"}, src.current()["icon"])
	src.accept(PRESENTATION.manifest(renamed))
	for i in 3:
		await _tree().process_frame
	t.check("header: re-renders on changed", h.product_name() == PRESENTATION.RTL_NAME and label.text == PKeyUiTheme.isolate(PRESENTATION.RTL_NAME) and _icon_kind(h) == "image", label.text)
	t.check("header: a right-to-left name is drawn between FSI and PDI", label.text.begins_with(String.chr(0x2068)) and label.text.ends_with(String.chr(0x2069)))
	t.check("theme: the new accent", PKeyUiTheme.accent_hex() == "#3d9bff")
	src.accept(PRESENTATION.manifest(null))
	for i in 3:
		await _tree().process_frame
	t.check("header: a member that goes away falls back to the project", h.product_name() == str(ProjectSettings.get_setting("application/config/name")) and _icon_kind(h) == "monogram" and PKeyUiTheme.accent_source() == "ink")
	_free(v)
	PKeyUiTheme.reset()


## The header asks for its own size, and keeps the texture it shows while (and if) the next one
## does not resolve.
func _keeps_texture(t: PKeyTestContext) -> void:
	PKeyUiTheme.reset()
	PKeyTestFixtures.remove_tree(PRESENTATION.UI_CACHE)
	DirAccess.make_dir_recursive_absolute(PRESENTATION.UI_CACHE)
	var small := PRESENTATION.webp(16, Color("#ff6a3d"))
	var large := PRESENTATION.webp(32, Color("#ff6a3d"))
	var ic := PRESENTATION.icon(PRESENTATION.png(64), "image/png", [[64, small], [128, large]], PRESENTATION.ORIGIN, 64)
	# Only the 64 px size is on disk; with no transport the 128 px one never resolves.
	var f := FileAccess.open(PRESENTATION.UI_CACHE.path_join(PRESENTATION.sha(small)), FileAccess.WRITE)
	f.store_buffer(small)
	f.close()
	var src := PKeyPresentationSource.new()
	src.cache_dir = PRESENTATION.UI_CACHE
	src.product = "djdl"
	src.decodable = ["image/webp"]
	src.accept(PRESENTATION.manifest(PRESENTATION.member(PRESENTATION.DRIFT_KART, ic)))
	PKeyUiTheme.use_presentation(src)
	var header := PKeyProductHeader.new()
	header.hero = true
	_tree().root.add_child(header)
	await _tree().process_frame
	var icon := header.find_child("Icon", false, false) as TextureRect
	t.check("header: a 64 px hero takes the 64 px size", icon.visible and icon.texture != null and icon.texture.get_width() == 16, str(icon.texture))
	var shown := icon.texture
	header.splash = true
	header.refresh()
	for i in 3:
		await _tree().process_frame
	t.check("header: a larger size that does not resolve keeps the texture shown", icon.visible and icon.texture == shown)
	header.queue_free()
	PKeyUiTheme.reset()


## The identity order: the integrator's name and icon, then the presentation, then the project (the
## development project's name hidden only there).
func _identity_order(t: PKeyTestContext) -> void:
	PKeyUiTheme.reset()
	PKeyUiTheme.hide_dev_project_name = true
	var header := PKeyProductHeader.new()
	_tree().root.add_child(header)
	header.refresh()
	t.check("identity: no presentation, the development project's name stays hidden", header.product_name() == "" and not header.visible)
	PRESENTATION.present(PRESENTATION.DRIFT_KART, true)
	header.refresh()
	t.check("identity: a presented name shows even in the development project", header.product_name() == "Drift Kart" and header.visible and _icon_kind(header) == "image")
	PKeyUiTheme.hide_dev_project_name = false
	PKeyUiTheme.product_name = "Tidewater"
	var own := ImageTexture.create_from_image(PRESENTATION.icon_image(32, Color("#2f6fde")))
	PKeyUiTheme.product_icon = own
	header.refresh()
	var icon := header.find_child("Icon", false, false) as TextureRect
	t.check("identity: ui_product_name and ui_product_icon win over the presentation", header.product_name() == "Tidewater" and icon.texture == own)
	t.check("identity: the integrator's icon is never replaced by a fetch", PKeyUiTheme.product_identity()["icon"] == own and icon.texture == own)
	header.queue_free()
	PKeyUiTheme.reset()


## KX-GD-ID: the live verdict on the key field, the input hints, and the wordmark and art.
func _kx_identity(t: PKeyTestContext) -> void:
	var whole := "pkey_tidewater_" + "A".repeat(22)
	var v := PKeyActivationController.key_verdict(whole)
	t.check("verdict: a whole key reads 'Key for <Product>' from its prefix", v.get("copy") == "key_for_product" and not v["danger"], str(v))
	t.check("verdict: a key still being typed says nothing", PKeyActivationController.key_verdict("pkey_tidewater_AB").is_empty() and PKeyActivationController.key_verdict("").is_empty())
	var cut := PKeyActivationController.key_verdict("pkey_tidewater_" + "A".repeat(10), true)
	t.check("verdict: a cut-short key on submit counts its characters", cut.get("copy") == "key_cut_short" and cut["danger"] and cut["args"] == ["pkey_tidewater_", 10, 22], str(cut))
	t.check("verdict: the tier is unknown before the server answers", PKeyActivationController.done_verdict(null).is_empty())
	t.check("hints: keyboard activates, a pad selects, touch has none", PKeyActivationController.input_hint(&"keyboard") == "hint_activate" and PKeyActivationController.input_hint(&"pad") == "hint_select" and PKeyActivationController.input_hint(&"touch") == "")
	PKeyUiTheme.reset()
	PKeyUiTheme.product_name = "Tidewater"
	var panel := PKeyActivationPanel.new()
	panel.auto_sdk = false
	panel.set_capabilities({"key_entry": true, "sign_in": false, "continue_free": false, "offline": false})
	_sc.add(panel)
	await _tree().process_frame
	t.check("verdict: nothing under an empty field, no hint before any input", not panel._verdict.visible and not panel._hint_bar.visible)
	panel._key.text = whole
	panel._key.text_changed.emit(whole)
	await _tree().process_frame
	t.check("verdict: 'Key for Tidewater' under the field", panel._verdict.visible and panel._verdict.text == "Key for Tidewater", panel._verdict.text)
	panel._key.text = "pkey_tidewater_" + "A".repeat(10)
	panel._on_submit()
	await _tree().process_frame
	t.check("verdict: a cut-short key is not sent and says so", panel._msg_key.text == "This key is cut short: after pkey_tidewater_ it has 10 of 22 characters." and not panel.busy, panel._msg_key.text)
	var ev := InputEventJoypadButton.new()
	ev.button_index = JOY_BUTTON_A
	panel._input(ev)
	await _tree().process_frame
	t.check("hints: a pad shows the A glyph and 'to select'", panel._hint_bar.visible and _bar_words(panel._hint_bar) == ["to select"], str(_bar_words(panel._hint_bar)))
	var key_ev := InputEventKey.new()
	panel._input(key_ev)
	await _tree().process_frame
	t.check("hints: the keyboard shows the Enter glyph and 'to activate'", _bar_words(panel._hint_bar) == ["to activate"], str(_bar_words(panel._hint_bar)))
	var touch := InputEventScreenTouch.new()
	panel._input(touch)
	await _tree().process_frame
	t.check("hints: touch shows none", not panel._hint_bar.visible)
	# The panel's _input also tells PKeyUiView what the last input was: leave it as found.
	PKeyUiView.pointer_last = false
	PKeyUiView._pointer_known = false
	_free(panel)
	# Wordmark and art are integrator data: absent, the header and panes are as they were.
	var header := PKeyProductHeader.new()
	header.hero = true
	_tree().root.add_child(header)
	header.refresh()
	var mark := header.find_child("Wordmark", false, false) as TextureRect
	t.check("wordmark: none by default, the name shows", not mark.visible and header.find_child("Name", false, false).visible)
	var img := Image.create(120, 30, false, Image.FORMAT_RGBA8)
	img.fill(Color.WHITE)
	PKeyUiTheme.product_wordmark = ImageTexture.create_from_image(img)
	PKeyUiTheme.product_art = ImageTexture.create_from_image(img)
	header.refresh()
	t.check("wordmark: beside the icon on a hero header, standing in for the name's text", mark.visible and not header.find_child("Name", false, false).visible)
	header.hero = false
	header.refresh()
	t.check("wordmark: a step header keeps icon and name", not mark.visible and header.find_child("Name", false, false).visible)
	header.queue_free()
	var art := PKeyUiTheme.art_ground("Art")
	t.check("art: shown for the pane with art, hidden without", PKeyUiTheme.show_art(art, true) and art.visible and not PKeyUiTheme.show_art(art, false) and not art.visible)
	art.free()
	PKeyUiTheme.reset()
	t.check("art and wordmark: reset puts the look back", PKeyUiTheme.product_art == null and PKeyUiTheme.product_wordmark == null)


## "Set by" names the presented developer, else the presented name, bidi-isolated.
func _set_by(t: PKeyTestContext) -> void:
	var sdk: Node = await _sc.settings_sdk({})
	sdk.presentation_source.cache_dir = PRESENTATION.UI_CACHE
	sdk.presentation_source.accept(PRESENTATION.manifest(PRESENTATION.member({"name": "Drift Kart", "developerName": PRESENTATION.RTL_NAME})))
	t.check("set by: the presented developer", PKeySettingsController.product_name(sdk) == PRESENTATION.RTL_NAME)
	var p := PKeySettingsPanel.new()
	p.sdk = sdk
	_sc.add(p)
	await _tree().process_frame
	var kill := _row_nodes(p, "game.killSwitch")
	t.check("set by: drawn bidi-isolated", (kill["set_by"] as Label).text == "Set by %s" % PKeyUiTheme.isolate(PRESENTATION.RTL_NAME), (kill["set_by"] as Label).text)
	sdk.presentation_source.accept(PRESENTATION.manifest(PRESENTATION.member({"name": "Drift Kart"})))
	t.check("set by: else the presented name", PKeySettingsController.product_name(sdk) == "Drift Kart")
	_free(p)
	sdk.queue_free()
	PKeyUiTheme.reset()


# ── UI-KITS.md conformance (KP-godot-spec) ────────────────────────────────────────────────────

const _COPY_FORMAT := preload("res://addons/polaris_key/ui/model/copy_format.gd")
## The kit's DEFAULTS keys whose English text is a catalog string (packages/brand/kit-copy/en.json,
## the generated en.po): the catalog is the source of truth for copy (DL8).
const CATALOG_KEYS := {
	"activation_subtitle": "welcome.lede",
	"activation_subtitle_key": "welcome.ledeKeyOnly",
	"activation_subtitle_sign_in": "welcome.ledeSignInOnly",
	"key_label": "part.keyField.label",
	"key_placeholder": "part.keyField.placeholder",
	"sign_in": "welcome.signIn",
	"continue_free": "welcome.continueFree",
	"offline_activation": "welcome.offline",
	"free_device": "deviceLimit.title",
	"different_key": "signin.key.differentKey",
	"retry": "common.tryAgain",
	"cancel": "common.cancel",
	"sign_in_code_title": "signin.handoff.codeTitle",
	"sign_in_go_to": "signin.handoff.url",
	"sign_in_scan_tv": "signInHandoff.scanTv",
	"sign_in_expires": "signin.handoff.expires",
	"sign_in_copy_link": "signin.handoff.copyLink",
	"sign_in_open_browser": "signin.handoff.openBrowser",
	"sign_in_use_key": "signin.choice.keyInstead",
	"update_dismiss": "update.later",
	"update_action": "update.install",
	"update_install": "update.install",
	"update_restart": "update.restartNow",
	"update_modal_title": "update.title",
	"update_notes": "update.whatsNew",
	"update_all_changes": "update.allChanges",
	"status_update": "status.update",
	"banner_last_day": "grace.lastDay",
	"banner_reconnect": "common.reconnect",
	"banner_dismiss": "common.dismiss",
	"settings_managed": "account.managedSettings",
	"settings_search": "settings.search",
	"settings_empty": "settings.empty",
	"settings_offline": "settings.loadFailed",
	"settings_reset": "settings.reset",
	"settings_advanced": "settings.advanced",
	"boot_syncing": "boot.syncing",
	"boot_consent_body": "boot.consent.body",
	"boot_consent_body_metered": "boot.consent.bodyMetered",
	"boot_declined_body": "boot.declined.body",
	"gate_error_title": "gate.error.title",
	"boot_offline_title": "boot.offline.title",
}


## A message with its placeholders ({name}, %s, %d, a leading "#") made one marker.
static func _shape(msg: String) -> String:
	var re := RegEx.new()
	re.compile("\\{[A-Za-z]+\\}|%s|%d")
	return re.sub(msg, "§", true)


func _stage_gate(size: Vector2i) -> Array:
	var vp := SubViewport.new()
	vp.size = size
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	_tree().root.add_child(vp)
	var g := PKeyGateView.new()
	g.auto_sdk = false
	g.activation.set_capabilities(PKeyActivationController.capabilities(true, true, true, false))
	g.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	vp.add_child(g)
	return [vp, g]


func _spec(t: PKeyTestContext) -> void:
	# DL8: every English string the kit shares with the catalog reads exactly as the catalog does.
	var cat = _COPY_FORMAT.new({"locale": "en"})
	var drift: Array = []
	for k in CATALOG_KEYS:
		var want := _shape(cat.format(CATALOG_KEYS[k]))
		var got := _shape(String(PKeyUiCopy.DEFAULTS[k]))
		if want != got or want == "":
			drift.append("%s: '%s' vs catalog '%s'" % [k, got, want])
	t.check("spec: kit copy reads as the catalog (DL8)", drift.is_empty(), "; ".join(drift.slice(0, 4)))
	# §1.5 rule 11: separators are "·", never a dash.
	t.check("spec: the grace line separates with a middle dot", String(PKeyUiCopy.DEFAULTS["banner_grace"]).contains("·") and not String(PKeyUiCopy.DEFAULTS["banner_grace"]).contains("—"))

	# DL12: the product header's name is weight 500.
	var strong := PKeyUiTheme.build(true).get_font("font", "PKeyStrong")
	var wght := PKeyUiTheme.weight_variation(500).variation_opentype
	t.check("spec: PKeyStrong (the product header's name) draws at weight 500 (DL12)", strong is FontVariation and (strong as FontVariation).variation_opentype == wght)

	# §4.3 Welcome: the lede leads the form, and the extras are links in one row (no full-width button).
	var p: Control = _sc.activation(true, true, true, false)
	await _tree().process_frame
	await _tree().process_frame
	var lede := p.find_child("Lede", true, false) as Label
	var form := p.find_child("Form", true, false)
	t.check("spec: Welcome says what to do, in the catalog's words", lede != null and (lede.visible or p.phone_bleed()) and PKeyUiCopy.new().text("activation_subtitle") == "Sign in or use a license key to continue.")
	var extras := p.find_child("Extras", true, false) as HFlowContainer
	t.check("spec: Welcome's extras are one row", extras != null and extras.get_node("ContinueFree") != null and extras.get_node("OfflineActivation") != null)
	t.check("spec: the extras are links, not buttons beside the primary", extras != null and extras.get_node("ContinueFree").theme_type_variation == &"PKeyLink" and extras.get_node("OfflineActivation").theme_type_variation == &"PKeyLink")
	if form != null:
		var order: Array = []
		for ch in form.get_children():
			if ch.visible:
				order.append(ch.name)
		t.check("spec: the lede sits above the key field on keyboard platforms", order.find("Lede") < order.find("KeyField") or not order.has("Lede"), str(order))
	_free(p)

	# DL1/DL5: in two panes the passport holds the product only; the refusal's title leads the end pane.
	var st := _stage_gate(Vector2i(1280, 720))
	var g: PKeyGateView = st[1]
	g.show_state({"status": "revoked"})
	for i in 6:
		await _tree().process_frame
	var title := g.find_child("Title", true, false) as Label
	var pane := g.find_child("Pane", true, false)
	t.check("spec: a refusal's title is in the end pane, not the passport (DL1)", title != null and title.visible and not pane.is_ancestor_of(title) and g.find_child("Form", true, false).is_ancestor_of(title), str(title.get_path()) if title != null else "no title")
	g.show_state({"status": "channel-not-entitled"})
	for i in 4:
		await _tree().process_frame
	t.check("spec: a channel the license lacks has its own title (StatusScreen Must not)", (g.find_child("Title", true, false) as Label).text == "Channel not included" and PKeyGateController.copy_for("not-available", "version-too-new")["title"] == "not_available_title")
	g.show_loading()
	await _tree().process_frame
	t.check("spec: loading shows nothing for its first 250 ms (DL7)", not g._card.visible)
	await _tree().create_timer(0.4).timeout
	t.check("spec: then the identity, a label and the shimmer (DL7)", g._card.visible and g._loading_bar.visible and g.find_child("Message", true, false).visible)
	(st[0] as Node).queue_free()

	# §4.3 SignInHandoff code view.
	var d: PKeySignInDialog = _sc.sign_in("pending")
	await _tree().process_frame
	await _tree().process_frame
	t.check("spec: the device-code title is Sign in with a code", (d.find_child("Title", true, false) as Label).text == "Sign in with a code")
	var expires := (d.find_child("Expires", true, false) as Label).text
	var ring := d.find_child("Ring", true, false) as PKeyCountdownRing
	t.check("spec: the countdown is a determinate ring beside 'Code expires in m:ss' (§1.5 rule 4)", expires == "Code expires in 2:05" and ring != null and ring.visible and ring.fraction > 0.0 and ring.fraction < 1.0, "%s %s" % [expires, ring.fraction if ring != null else "no ring"])
	var address := d.find_child("Address", true, false) as Label
	var code_at := d.find_child("UserCode", true, false).get_index()
	t.check("spec: without a QR code the address follows the code as 'Or go to <address>', with no fragment above it", address.text == "Or go to polaris.locker/device" and not (d.find_child("Instructions", true, false) as Label).visible and address.get_index() > code_at, address.text)
	t.check("spec: the header sits a stack gap above the title", d.find_child("Header", true, false).theme_type_variation == &"PKeyStack")
	_free(d)

	# GraceBanner: the last day, Reconnect, Dismiss for the session.
	PKeyStatusBanner.reset_dismissed()
	var day := PKeyBannerController.lines({"status": "grace", "grace_until": SCENARIOS.NOW + 3600}, SCENARIOS.NOW)
	var days := PKeyBannerController.lines({"status": "grace", "grace_until": SCENARIOS.NOW + 3 * 86400}, SCENARIOS.NOW)
	t.check("spec: under a day left says it is the last day; more counts days", day[0][0] == "banner_last_day" and days[0][0] == "banner_grace")
	var b := PKeyStatusBanner.new()
	b.auto_sdk = false
	b.now_source = func(): return SCENARIOS.NOW
	_sc.add(b)
	b.show_state({"status": "grace", "grace_until": SCENARIOS.NOW + 3 * 86400})
	await _tree().process_frame
	var asked := [false]
	b.reconnect_requested.connect(func(): asked[0] = true)
	var rec := b.find_child("Reconnect", true, false) as Button
	var dis := b.find_child("Dismiss", true, false) as Button
	t.check("spec: grace carries Reconnect and Dismiss", rec.visible and dis.visible and rec.text == "Reconnect" and dis.text == "Dismiss")
	rec.pressed.emit()
	t.check("spec: Reconnect asks to reconnect", asked[0])
	dis.pressed.emit()
	await _tree().process_frame
	t.check("spec: Dismiss hides the banner for the session", not b.visible)
	b.show_state({"status": "grace", "grace_until": SCENARIOS.NOW + 3600})
	await _tree().process_frame
	t.check("spec: the last day comes back as a different message", b.visible)
	PKeyStatusBanner.reset_dismissed()
	_free(b)

	# UpdatePrompt: the catalog's verbs and a title that names the product once.
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	var up := PKeyUpdatePrompt.new()
	up.modal = true
	up.outlet = "direct"
	up.release_url = "https://example.com/dl"
	_sc.add(up)
	up.show_result(_sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false}))
	await _tree().process_frame
	t.check("spec: the update's verbs are Update now and Later", (up.find_child("Action", true, false) as Button).text == "Update now" and (up.find_child("Dismiss", true, false) as Button).text == "Later")
	var utitle := (up.find_child("Title", true, false) as Label).text
	var uname := up.find_child("Name", true, false) as Label
	t.check("spec: the update's title is '<Product> <version>' and the header is the icon alone (DL5)", utitle.ends_with(" 1.5.0") and utitle.length() > 6 and uname != null and not uname.visible, utitle)
	_free(up)

	# Settings: locked rows are "Managed settings", last.
	var rows := [{"category": "B", "order": 2.0, "position": 1, "key": "b", "enforced": false}, {"category": PKeySettingsController.MANAGED, "order": 0.0, "position": 0, "key": "m", "enforced": true}, {"category": "A", "order": 1.0, "position": 2, "key": "a", "enforced": false}]
	PKeySettingsController._sort(rows)
	t.check("spec: the rows a policy locks close the list as Managed settings", rows.map(func(r): return r["key"]) == ["a", "b", "m"], str(rows.map(func(r): return r["key"])))
