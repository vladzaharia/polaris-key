class_name PKeyProviderButton
extends RefCounted
## A platform provider's own button on the sign-in form (UI-KITS.md §3.6): the provider keeps its
## fill, logo and label colours, never the product accent and never a glow.
##
##   Apple   black on a light scheme, white on a dark one (Apple's rules: the logo and "Continue with
##           Apple", no other colour, the control's radius and height follow the theme)
##   Google  `GOOGLE_BUTTON`'s light fill in a light scheme and its dark fill in a dark one, the
##           four-colour G unmodified at `GOOGLE_G_HEIGHT_RATIO` of the height, `GOOGLE_G_LABEL_GAP`
##           px before "Continue with Google" (the generated tokens, kit_icons_generated.gd)
##
## `apply()` styles a Button: set its text first (`signin.provider.continue` with the provider's name).

const APPLE := "apple"
const GOOGLE := "google"
const APPLE_INK_ON_DARK := Color("#000000")
const APPLE_FILL_ON_DARK := Color("#FFFFFF")
const STATES := ["normal", "hover", "pressed", "hover_pressed", "disabled"]


## The provider's name as the button says it ("Apple", "Google"), "" for a kind with no button.
static func provider_name(kind: String) -> String:
	match kind:
		APPLE:
			return "Apple"
		GOOGLE:
			return "Google"
	return ""


## The fill, border (alpha 0: none) and label colour of `kind` in the scheme.
static func colours(kind: String, dark: bool) -> Dictionary:
	if kind == GOOGLE:
		var spec: Dictionary = PKeyKitIcons.GOOGLE_BUTTON[PKeyKitIcons.GOOGLE_BUTTON_FOR_SCHEME["dark" if dark else "light"]]
		var border = spec.get("border")
		return {"fill": Color(String(spec["fill"])), "border": Color(String(border)) if border != null else Color(0, 0, 0, 0), "label": Color(String(spec["label"]))}
	# Apple: white on a dark scheme, black on a light one; on white the system control has no border.
	var ink := APPLE_INK_ON_DARK if dark else APPLE_FILL_ON_DARK
	var fill := APPLE_FILL_ON_DARK if dark else APPLE_INK_ON_DARK
	return {"fill": fill, "border": Color(0, 0, 0, 0), "label": ink}


## Draw `b` as `kind`'s button for `view` (its scale, its theme's control box).
static func apply(b: Button, kind: String, view: PKeyUiView) -> void:
	if b == null or provider_name(kind) == "":
		return
	var dark := PKeyUiTheme.is_dark(view)
	var c := colours(kind, dark)
	var base := b.get_theme_stylebox("normal", "Button")
	# The radius is the theme's control radius (the primary's box), so the row matches its neighbours.
	var shape := view.get_theme_stylebox("normal", "PKeyPrimary")
	var radius := (shape as StyleBoxFlat).get_corner_radius(CORNER_TOP_LEFT) if shape is StyleBoxFlat else PKeyUiTheme.RADIUS_CONTROL
	for state in STATES:
		var box: StyleBoxFlat = (base as StyleBoxFlat).duplicate() as StyleBoxFlat if base is StyleBoxFlat else StyleBoxFlat.new()
		box.bg_color = c["fill"] if state != "disabled" else Color(c["fill"], 0.5)
		var border: Color = c["border"]
		box.border_color = border
		box.set_border_width_all(1 if border.a > 0.0 else 0)
		box.shadow_size = 0
		box.set_corner_radius_all(radius)
		b.add_theme_stylebox_override(state, box)
	var ink: Color = c["label"]
	for state in ["font_color", "font_hover_color", "font_pressed_color", "font_hover_pressed_color", "font_focus_color"]:
		b.add_theme_color_override(state, ink)
	b.add_theme_color_override("font_disabled_color", Color(ink, 0.5))
	var m := view.layout_metrics()
	var scale := float(m["scale"])
	var height := view.role("control_height")
	# Google's G is half the height; Apple's logo is the label's height or a little more.
	var px := height * (PKeyKitIcons.GOOGLE_G_HEIGHT_RATIO if kind == GOOGLE else 0.42)
	var k := scale * float(m["physical"])
	b.icon = PKeyUiTheme.glyph("google_g" if kind == GOOGLE else "apple", ink, px, k * 2.0)
	b.icon_alignment = HORIZONTAL_ALIGNMENT_LEFT
	b.expand_icon = false
	b.add_theme_constant_override("icon_max_width", maxi(12, roundi(px * scale)))
	b.add_theme_constant_override("h_separation", roundi(float(PKeyKitIcons.GOOGLE_G_LABEL_GAP) * scale))
	for state in ["normal", "hover", "pressed", "hover_pressed", "focus", "disabled"]:
		b.add_theme_color_override("icon_%s_color" % state, Color.WHITE)
	b.set_meta(&"pkey_provider", kind)
