# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
# packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
# `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
# its source and regenerate.
class_name PKeyKitIcons
extends RefCounted
## The Godot kit's engine control icons (docs/design/UI-KITS.md §2.1): checkbox, radio, toggle,
## chevrons, close and clear, drawn on a 24-unit grid in the kit's line weight. Each is an SVG
## template; {fg}, {bg} and {track} are filled with the theme's colours by svg(), and the kit
## rasterises the result (Image.load_svg_from_string) at the scale it needs. Strings, not imported
## .svg files, because an import's parameters differ between engine versions.

const ICONS := {
	"checkbox_checked": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"6\" fill=\"{bg}\"/><path d=\"M7.5 12.5l3 3 6-7\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2.25\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
	"checkbox_unchecked": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"5\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\"/></svg>",
	"radio_checked": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"{bg}\"/><circle cx=\"12\" cy=\"12\" r=\"4\" fill=\"{fg}\"/></svg>",
	"radio_unchecked": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\"/></svg>",
	"toggle_on": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"44\" height=\"24\" viewBox=\"0 0 44 24\"><rect x=\"1\" y=\"1\" width=\"42\" height=\"22\" rx=\"11\" fill=\"{track}\"/><circle cx=\"32\" cy=\"12\" r=\"8\" fill=\"{fg}\"/></svg>",
	"toggle_off": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"44\" height=\"24\" viewBox=\"0 0 44 24\"><rect x=\"1\" y=\"1\" width=\"42\" height=\"22\" rx=\"11\" fill=\"{track}\"/><circle cx=\"12\" cy=\"12\" r=\"8\" fill=\"{fg}\"/></svg>",
	"chevron_down": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M7 10l5 5 5-5\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
	"chevron_up": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M7 14l5-5 5 5\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
	"chevron_right": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M10 7l5 5-5 5\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
	"chevron_left": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M14 7l-5 5 5 5\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
	"close": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M7 7l10 10M17 7L7 17\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
	"lock": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><rect x=\"5\" y=\"11\" width=\"14\" height=\"9\" rx=\"2.5\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\"/><path d=\"M8 11V8a4 4 0 0 1 8 0v3\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
	"cloud_off": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M7 18h10a4 4 0 0 0 1.2-7.8A6 6 0 0 0 7.3 9.2 4.5 4.5 0 0 0 7 18z\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M4 4l16 16\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
	"warning": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M12 4l9 16H3z\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linejoin=\"round\"/><path d=\"M12 10v4.5\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/><circle cx=\"12\" cy=\"17.2\" r=\"1.1\" fill=\"{fg}\"/></svg>",
	"clear": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"{bg}\"/><path d=\"M9 9l6 6M15 9l-6 6\" fill=\"none\" stroke=\"{fg}\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>",
}


## The names of every icon.
static func names() -> Array:
	return ICONS.keys()


## The icon's SVG with its placeholders filled. Missing colours default to `fg`.
static func svg(name: String, fg: Color, bg: Color = Color.TRANSPARENT, track: Color = Color.TRANSPARENT) -> String:
	var src: String = ICONS.get(name, "")
	if src == "":
		return ""
	var hex := func(c: Color) -> String: return "#" + c.to_html(false)
	var out := src.replace("{fg}", hex.call(fg))
	out = out.replace("{bg}", hex.call(bg if bg.a > 0.0 else fg))
	out = out.replace("{track}", hex.call(track if track.a > 0.0 else fg))
	return out
