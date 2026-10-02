extends SceneTree
## Writes addons/polaris_key/ui/theme/pkey_theme.tres, the UI kit's default Theme, from the same
## palette as React's `defaultTheme` (packages/sdk-react/src/components/theme.ts): deep-slate
## surfaces, an indigo accent, and a 2 px focus ring on every interactive control so a gamepad or
## TV player always sees where focus is. Editor only:
##
##   godot --headless --path sdks/godot --script tools/gen_theme.gd
##
## The .tres is committed; regenerate it after changing this file. Games restyle by assigning
## their own Theme to a scene (or an ancestor), or by type variation: PKeyTitle, PKeyMuted,
## PKeyCode, PKeyError, PKeyBadge, PKeyBanner, PKeyCard, PKeyPrimary.

const OUT := "res://addons/polaris_key/ui/theme/pkey_theme.tres"

const BACKGROUND := Color("#0c0f17")
const SURFACE := Color("#11141d")
const RAISED := Color("#181c28")
const TEXT := Color("#e6e9f2")
const MUTED := Color("#9aa3bd")
const ACCENT := Color("#5b7cfa")
const ACCENT_HOVER := Color("#7d97ff")
const ACCENT_TEXT := Color("#0b1020")
const RING := Color("#93a8ff")
const BORDER := Color("#262c3b")
const DANGER := Color("#fca5a5")
const RADIUS := 12


func _initialize() -> void:
	var t := Theme.new()
	t.default_font_size = 18

	t.set_stylebox("panel", "PanelContainer", _box(BACKGROUND, BORDER, 0, RADIUS, 24))
	t.set_type_variation("PKeyCard", "PanelContainer")
	t.set_stylebox("panel", "PKeyCard", _box(SURFACE, BORDER, 1, RADIUS, 24))
	t.set_type_variation("PKeyBanner", "PanelContainer")
	t.set_stylebox("panel", "PKeyBanner", _box(SURFACE, BORDER, 1, 8, 10))

	t.set_color("font_color", "Label", TEXT)
	for v in ["PKeyTitle", "PKeyMuted", "PKeyCode", "PKeyError", "PKeyBadge"]:
		t.set_type_variation(v, "Label")
	t.set_font_size("font_size", "PKeyTitle", 28)
	t.set_color("font_color", "PKeyTitle", TEXT)
	t.set_color("font_color", "PKeyMuted", MUTED)
	t.set_font_size("font_size", "PKeyMuted", 16)
	t.set_font_size("font_size", "PKeyCode", 40)
	t.set_color("font_color", "PKeyCode", TEXT)
	t.set_color("font_color", "PKeyError", DANGER)
	t.set_color("font_color", "PKeyBadge", ACCENT_HOVER)
	t.set_font_size("font_size", "PKeyBadge", 14)
	t.set_stylebox("normal", "PKeyBadge", _box(RAISED, ACCENT, 1, 999, 4))

	var focus := _ring()
	for type in ["Button", "CheckButton", "CheckBox", "OptionButton", "LineEdit", "TextEdit"]:
		t.set_stylebox("focus", type, focus)
	for type in ["Button", "OptionButton"]:
		t.set_stylebox("normal", type, _box(RAISED, BORDER, 1, 8, 10))
		t.set_stylebox("hover", type, _box(RAISED.lightened(0.06), ACCENT, 1, 8, 10))
		t.set_stylebox("pressed", type, _box(RAISED.darkened(0.2), ACCENT, 1, 8, 10))
		t.set_stylebox("disabled", type, _box(SURFACE, BORDER, 1, 8, 10))
		t.set_color("font_color", type, TEXT)
		t.set_color("font_hover_color", type, TEXT)
		t.set_color("font_focus_color", type, TEXT)
		t.set_color("font_disabled_color", type, MUTED.darkened(0.3))
	t.set_type_variation("PKeyPrimary", "Button")
	t.set_stylebox("normal", "PKeyPrimary", _box(ACCENT, ACCENT, 1, 8, 10))
	t.set_stylebox("hover", "PKeyPrimary", _box(ACCENT_HOVER, ACCENT_HOVER, 1, 8, 10))
	t.set_stylebox("pressed", "PKeyPrimary", _box(ACCENT.darkened(0.15), ACCENT, 1, 8, 10))
	t.set_color("font_color", "PKeyPrimary", ACCENT_TEXT)
	t.set_color("font_hover_color", "PKeyPrimary", ACCENT_TEXT)
	t.set_color("font_focus_color", "PKeyPrimary", ACCENT_TEXT)
	t.set_color("font_pressed_color", "PKeyPrimary", ACCENT_TEXT)
	for type in ["LineEdit", "TextEdit"]:
		t.set_stylebox("normal", type, _box(SURFACE, BORDER, 1, 8, 10))
		t.set_stylebox("read_only", type, _box(BACKGROUND, BORDER, 1, 8, 10))
		t.set_color("font_color", type, TEXT)
		t.set_color("font_placeholder_color", type, MUTED)
		t.set_color("caret_color", type, RING)
	t.set_color("font_color", "CheckButton", TEXT)
	t.set_color("font_focus_color", "CheckButton", TEXT)
	t.set_stylebox("background", "ProgressBar", _box(RAISED, BORDER, 1, 999, 0))
	t.set_stylebox("fill", "ProgressBar", _box(ACCENT, ACCENT, 0, 999, 0))
	t.set_color("dark", "PKeyQrRect", Color.BLACK)
	t.set_color("light", "PKeyQrRect", Color.WHITE)

	var err := ResourceSaver.save(t, OUT)
	print("gen_theme: wrote %s (%s)" % [OUT, error_string(err)])
	quit(0 if err == OK else 1)


static func _box(bg: Color, border: Color, width: int, radius: int, pad: int) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = border
	s.set_border_width_all(width)
	s.set_corner_radius_all(radius)
	s.set_content_margin_all(pad)
	return s


## The focus ring: drawn over the control, no fill, 2 px of the ring colour, expanded so it never
## hides the control's own border.
static func _ring() -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.draw_center = false
	s.border_color = RING
	s.set_border_width_all(2)
	s.set_corner_radius_all(10)
	s.set_expand_margin_all(3)
	return s
