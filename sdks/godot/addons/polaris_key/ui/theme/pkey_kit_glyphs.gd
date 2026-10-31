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
	# The Apple logo, filled in {fg}: only for Sign in with Apple's own button (PKeyProviderButton), which
	# Apple's rules draw as the logo and "Continue with Apple" in black, white or white with an outline.
	"apple": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path fill=\"{fg}\" d=\"M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701\"/></svg>",
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
