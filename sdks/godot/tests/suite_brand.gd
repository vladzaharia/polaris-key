extends RefCounted
# The generated brand tokens (packages/brand, `pnpm gen:brand`) load in the engine and agree with
# the launch kit: the kit primitives, the optical-cut thresholds, the section-bit rule (no bit on
# core, the accent in a service section, never below 48 px) and the shared delivery accent.
#
#   godot --headless --path sdks/godot -- --pkey-test brand

const Brand := preload("res://addons/polaris_key/ui/theme/brand_tokens_generated.gd")


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	t.check("kit violet (dark)", Brand.KIT_VIOLET_DARK.to_html(false) == "9a5cff", Brand.KIT_VIOLET_DARK.to_html(false))
	t.check("kit violet (light)", Brand.KIT_VIOLET_LIGHT.to_html(false) == "7a2fff")
	t.check("kit gold (dark)", Brand.KIT_GOLD_DARK.to_html(false) == "ffc24d")
	t.check("kit gold (light)", Brand.KIT_GOLD_LIGHT.to_html(false) == "d07a00")
	t.check("dark page is the kit ground", Brand.Dark.SURFACE_PAGE.to_html(false) == "060912")
	t.check("light page is the kit ground", Brand.Light.SURFACE_PAGE.to_html(false) == "f6f8ff")
	t.check("core accent is the kit violet", Brand.service_accent("core", true) == Brand.KIT_VIOLET_DARK)
	t.check("core has no bit", not Brand.has_section_bit("core"))
	t.check("core bit answers transparent", Brand.section_bit("core", true).a == 0.0 and Brand.section_bit("core", false).a == 0.0)
	t.check("unknown section has no bit", not Brand.has_section_bit("nope"))
	t.check("every service section has a bit", Brand.has_section_bit("license") and Brand.has_section_bit("identity"))
	t.check("a service bit is its accent", Brand.section_bit("config", true) == Brand.service_accent("config", true))
	t.check("delivery family shares one accent", Brand.service_accent("distribution", false) == Brand.service_accent("update", false))
	t.check("unknown section falls back to core", Brand.service_accent("nope", true) == Brand.KIT_VIOLET_DARK)
	t.check("every section has an accent", Brand.SERVICE_IDS.size() == 7)
	t.check("16 px is the favicon cut", Brand.optical_cut(16) == "favicon")
	t.check("24 px is the service cut", Brand.optical_cut(24) == "service")
	t.check("32 px is the service cut", Brand.optical_cut(32) == "service")
	t.check("33 px is the display cut", Brand.optical_cut(33) == "display")
	t.check("no bit at 47 px", not Brand.bit_visible(47))
	t.check("bit at 48 px", Brand.bit_visible(48))
	t.check("badge minimum (compact)", Brand.BADGE_MIN_COMPACT == Vector2i(232, 88))
	t.check("phrase", Brand.POWERED_BY_PHRASE == "Powered by Polaris Key")
	return true
