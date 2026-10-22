extends RefCounted
# The Godot per-kit equivalent of the modernity lint (UI-KITS.md §7.3): every engine control icon
# is set by the brand theme (tests/support/ui_lint.gd). This suite proves the helper: it fails a
# theme that leaves engine icons stock and passes one that sets them all. The branded theme's
# current coverage is reported as INFO; UK-11 (the Godot kit) turns it into a check when it
# themes every icon.
#
#   godot --headless --path sdks/godot -- --pkey-test ui_lint

const UiLint := preload("res://tests/support/ui_lint.gd")
const PKeyUiTheme := preload("res://addons/polaris_key/ui/theme/pkey_ui_theme.gd")


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	var stock := ThemeDB.get_default_theme()
	var empty := Theme.new()
	var missing := UiLint.unthemed_icons(empty)
	t.check("an empty theme leaves engine icons stock", missing.size() > 10, str(missing.size()))
	t.check("the check box tick is among them", missing.has("CheckBox/checked"), ", ".join(missing.slice(0, 6)))

	var full := Theme.new()
	var blank := ImageTexture.create_from_image(Image.create(2, 2, false, Image.FORMAT_RGBA8))
	for type in UiLint.KIT_TYPES:
		for icon in stock.get_icon_list(type):
			full.set_icon(icon, type, blank)
	t.check("a theme that sets every icon passes", UiLint.unthemed_icons(full).is_empty())

	var variant := Theme.new()
	variant.set_type_variation("PKeySwitch", "CheckButton")
	for icon in stock.get_icon_list("CheckButton"):
		variant.set_icon(icon, "CheckButton", blank)
	t.check("a type variation inherits its base's icons", UiLint.unthemed_icons(variant, ["PKeySwitch"]).is_empty())

	_refusal_tone(t)
	await _initial_focus(t)

	var branded := UiLint.unthemed_icons(PKeyUiTheme.build(true))
	t.info("branded theme: %d engine icons still stock (UK-11 themes them): %s" % [branded.size(), ", ".join(branded.slice(0, 12))])
	return true


const REFUSALS := ["^Sign out of .+ on another device, then try again\\.$"]
const REFUSAL_TEXT := "Sign out of Tidewater on another device, then try again."


## DL6 (UK-55): a refusal in the danger variation, in the danger colour, or beside an invalid field
## fails; a neutral callout passes.
func _refusal_tone(t: PKeyTestContext) -> void:
	var screen := VBoxContainer.new()
	var neutral := Label.new()
	neutral.text = REFUSAL_TEXT
	screen.add_child(neutral)
	t.check("a neutral refusal callout passes DL6", UiLint.refusal_tone(screen, REFUSALS).is_empty())

	var danger_text := Label.new()
	danger_text.text = REFUSAL_TEXT
	danger_text.theme_type_variation = UiLint.DANGER_TEXT
	var s2 := VBoxContainer.new()
	s2.add_child(danger_text)
	t.check("a refusal drawn as PKeyError fails DL6", UiLint.refusal_tone(s2, REFUSALS).size() == 1)

	var red := Color(0.86, 0.2, 0.2)
	var coloured := Label.new()
	coloured.text = REFUSAL_TEXT
	coloured.add_theme_color_override("font_color", red)
	var s3 := VBoxContainer.new()
	s3.add_child(coloured)
	t.check("a refusal in the danger colour fails DL6", UiLint.refusal_tone(s3, REFUSALS, [red]).size() == 1)

	var s4 := VBoxContainer.new()
	var field := LineEdit.new()
	field.theme_type_variation = UiLint.INVALID_FIELD
	s4.add_child(field)
	var beside := Label.new()
	beside.text = REFUSAL_TEXT
	s4.add_child(beside)
	t.check("a refusal beside an invalid field fails DL6", UiLint.refusal_tone(s4, REFUSALS).size() == 1)

	var other := Label.new()
	other.text = "That key is not valid."
	other.theme_type_variation = UiLint.DANGER_TEXT
	var s5 := VBoxContainer.new()
	s5.add_child(other)
	t.check("a bad-input error in danger is not a refusal", UiLint.refusal_tone(s5, REFUSALS).is_empty())
	for n in [screen, s2, s3, s4, s5]:
		n.free()


## DL9 (UK-55): the focus owner is inside the screen once it is shown.
func _initial_focus(t: PKeyTestContext) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	var screen := VBoxContainer.new()
	var primary := Button.new()
	primary.text = "Replace and continue"
	screen.add_child(primary)
	tree.root.add_child(screen)
	await tree.process_frame
	t.check("a screen with no focus fails DL9", UiLint.initial_focus(screen) != "")
	primary.grab_focus()
	t.check("a screen whose primary has focus passes DL9", UiLint.initial_focus(screen) == "", UiLint.initial_focus(screen))
	var outside := Button.new()
	tree.root.add_child(outside)
	outside.grab_focus()
	t.check("focus outside the screen fails DL9", UiLint.initial_focus(screen) != "")
	screen.queue_free()
	outside.queue_free()
