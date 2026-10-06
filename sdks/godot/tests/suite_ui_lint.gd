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

	var branded := UiLint.unthemed_icons(PKeyUiTheme.build(true))
	t.info("branded theme: %d engine icons still stock (UK-11 themes them): %s" % [branded.size(), ", ".join(branded.slice(0, 12))])
	return true
