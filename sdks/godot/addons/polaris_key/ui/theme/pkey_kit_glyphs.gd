class_name PKeyKitGlyphs
extends RefCounted
## The component glyphs the kit draws beside its rows and strips (UI-KITS.md §2.1): a device by
## form factor (Devices), a check (LicenseChoice), the toast statuses and the portal link mark.
## The same Lucide paths the React kit draws (packages/sdk-react/src/kit/parts.tsx, GLYPHS), on the
## kit's 24-unit grid at a 2 px line. Hand-written next to PKeyKitIcons, which holds the engine
## control icons the brand generator writes; PKeyUiTheme.glyph() looks a name up in both. Each is
## an SVG template; {fg} is filled with the glyph's colour.

const ICONS := {
	"device_computer": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"12\" rx=\"2\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M2 20h20\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
	"device_phone": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><rect x=\"5\" y=\"2\" width=\"14\" height=\"20\" rx=\"2\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M12 18h.01\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
	"device_tablet": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"2\" width=\"16\" height=\"20\" rx=\"2\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M12 18h.01\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
	"device_tv": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><rect x=\"2\" y=\"3\" width=\"20\" height=\"14\" rx=\"2\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M7 21h10\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
	"check": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M20 6 9 17l-5-5\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
	"success": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\"/><path d=\"m9 12 2 2 4-4\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
	"info": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\"/><path d=\"M12 16v-4M12 8h.01\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
	"external": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
}


## The names of every glyph.
static func names() -> Array:
	return ICONS.keys()


## The glyph for a device's form factor: a phone (iphone, phone), a tablet (ipad, tablet), a TV, and
## a computer for everything else (mac, computer, other).
static func device(form_factor: Variant) -> String:
	match String(form_factor) if form_factor != null else "":
		"iphone", "phone":
			return "device_phone"
		"ipad", "tablet":
			return "device_tablet"
		"tv":
			return "device_tv"
	return "device_computer"


## The glyph's SVG with {fg} filled, or "" for a name this class does not hold.
static func svg(name: String, fg: Color) -> String:
	var src: String = ICONS.get(name, "")
	if src == "":
		return ""
	return src.replace("{fg}", "#" + fg.to_html(false))
