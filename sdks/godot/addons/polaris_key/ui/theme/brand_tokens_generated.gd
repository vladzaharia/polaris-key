# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
# packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
# `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
# its source and regenerate.
class_name PKeyBrand
extends RefCounted
## Polaris Key brand tokens for Godot UI: the kit primitives, the dark and light semantic
## palettes, the per-section accents and the optical-size thresholds. Read them as
## `PKeyBrand.Dark.SURFACE_PAGE`, `PKeyBrand.service_accent("config", true)`.
##
## Dark is the default theme (the kit's page ground #060912). Choose the optical cut by the
## DISPLAYED size: below 24 px the 16 px favicon cut, 24-32 px the service cut, above that the
## display master. The default mark has no terminal bit; a service section's bit (its accent)
## shows only at a glyph of 48 px or more, and core draws none.


## Kit primitives, verbatim (kit/08-developer/tokens.json).
const KIT_VIOLET_DARK := Color(0.603922, 0.360784, 1.0, 1.0)
const KIT_VIOLET_LIGHT := Color(0.478431, 0.184314, 1.0, 1.0)
const KIT_GOLD_DARK := Color(1.0, 0.760784, 0.301961, 1.0)
const KIT_GOLD_LIGHT := Color(0.815686, 0.478431, 0.0, 1.0)
const KIT_PAGE_DARK := Color(0.023529, 0.035294, 0.070588, 1.0)
const KIT_PAGE_LIGHT := Color(0.964706, 0.972549, 1.0, 1.0)
const KIT_STAR_DARK := Color(1.0, 1.0, 1.0, 1.0)
const KIT_STAR_LIGHT := Color(0.478431, 0.184314, 1.0, 1.0)
const KIT_MUTED_DARK := Color(0.858824, 0.894118, 1.0, 1.0)
const KIT_MUTED_LIGHT := Color(0.282353, 0.32549, 0.419608, 1.0)

## Optical sizes and minimums (CSS/logical pixels, never physical).
const FAVICON_BELOW := 24
const SERVICE_MAX := 32
const GOLD_MINIMUM_GLYPH := 48
const CLEAR_SPACE_RATIO := 0.25
const POWERED_BY_PHRASE := "Powered by Polaris Key"
const BADGE_MIN_HORIZONTAL := Vector2i(376, 144)
const BADGE_MIN_COMPACT := Vector2i(232, 88)
const BADGE_MIN_STACKED := Vector2i(288, 336)

## Section ids: core plus every service slug.
const SERVICE_IDS: Array[String] = ["core", "license", "config", "release", "distribution", "update", "identity"]


## The dark theme (default).
class Dark:
	const SURFACE_PAGE := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SURFACE_RAISED := Color(0.05098, 0.066667, 0.105882, 1.0) # #0d111b
	const SURFACE_OVERLAY := Color(0.070588, 0.090196, 0.133333, 1.0) # #121722
	const SURFACE_SUNKEN := Color(0.007843, 0.015686, 0.031373, 1.0) # #020408
	const TEXT_STRONG := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const TEXT_DEFAULT := Color(0.858824, 0.894118, 1.0, 1.0) # #dbe4ff
	const TEXT_MUTED := Color(0.709804, 0.745098, 0.827451, 1.0) # #b5bed3
	const TEXT_SUBTLE := Color(0.588235, 0.619608, 0.698039, 1.0) # #969eb2
	const TEXT_ON_ACCENT := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const BORDER_SUBTLE := Color(0.129412, 0.14902, 0.2, 1.0) # #212633
	const BORDER_STRONG := Color(0.380392, 0.411765, 0.482353, 1.0) # #61697b
	const FOCUS := Color(0.603922, 0.360784, 1.0, 1.0) # #9a5cff
	const SUCCESS := Color(0.337255, 0.835294, 0.482353, 1.0) # #56d57b
	const SUCCESS_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SUCCESS_BORDER := Color(0.231373, 0.584314, 0.333333, 1.0) # #3b9555
	const SUCCESS_SUBTLE := Color(0.062745, 0.129412, 0.121569, 1.0) # #10211f
	const WARNING := Color(1.0, 0.560784, 0.341176, 1.0) # #ff8f57
	const WARNING_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const WARNING_BORDER := Color(0.760784, 0.380392, 0.176471, 1.0) # #c2612d
	const WARNING_SUBTLE := Color(0.141176, 0.098039, 0.101961, 1.0) # #24191a
	const DANGER := Color(0.94902, 0.317647, 0.247059, 1.0) # #f2513f
	const DANGER_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const DANGER_BORDER := Color(0.784314, 0.231373, 0.172549, 1.0) # #c83b2c
	const DANGER_SUBTLE := Color(0.133333, 0.070588, 0.090196, 1.0) # #221217
	const INFO := Color(0.713725, 0.533333, 0.996078, 1.0) # #b688fe
	const INFO_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const INFO_BORDER := Color(0.560784, 0.329412, 0.862745, 1.0) # #8f54dc
	const INFO_SUBTLE := Color(0.105882, 0.094118, 0.180392, 1.0) # #1b182e
	const SIGNED := Color(1.0, 0.760784, 0.301961, 1.0) # #ffc24d
	const SIGNED_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SIGNED_BORDER := Color(0.729412, 0.533333, 0.180392, 1.0) # #ba882e
	const SIGNED_SUBTLE := Color(0.141176, 0.121569, 0.098039, 1.0) # #241f19
	const SIGNED_MARK := Color(1.0, 0.760784, 0.301961, 1.0) # #ffc24d
	const BRAND_VIOLET := Color(0.603922, 0.360784, 1.0, 1.0) # #9a5cff
	const BRAND_STAR := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const BRAND_GOLD := Color(1.0, 0.760784, 0.301961, 1.0) # #ffc24d
	const SERVICE_CORE := Color(0.603922, 0.360784, 1.0, 1.0) # #9a5cff
	const SERVICE_CORE_FG := Color(0.603922, 0.360784, 1.0, 1.0) # #9a5cff
	const SERVICE_CORE_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_CORE_SUBTLE := Color(0.094118, 0.07451, 0.180392, 1.0) # #18132e
	const SERVICE_LICENSE := Color(0.776471, 0.913725, 0.25098, 1.0) # #c6e940
	const SERVICE_LICENSE_FG := Color(0.776471, 0.913725, 0.25098, 1.0) # #c6e940
	const SERVICE_LICENSE_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_LICENSE_SUBTLE := Color(0.113725, 0.141176, 0.094118, 1.0) # #1d2418
	const SERVICE_LICENSE_BIT := Color(0.776471, 0.913725, 0.25098, 1.0) # #c6e940
	const SERVICE_CONFIG := Color(0.070588, 0.737255, 0.835294, 1.0) # #12bcd5
	const SERVICE_CONFIG_FG := Color(0.070588, 0.737255, 0.835294, 1.0) # #12bcd5
	const SERVICE_CONFIG_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_CONFIG_SUBTLE := Color(0.027451, 0.117647, 0.160784, 1.0) # #071e29
	const SERVICE_CONFIG_BIT := Color(0.070588, 0.737255, 0.835294, 1.0) # #12bcd5
	const SERVICE_RELEASE := Color(0.003922, 0.972549, 0.898039, 1.0) # #01f8e5
	const SERVICE_RELEASE_FG := Color(0.003922, 0.972549, 0.898039, 1.0) # #01f8e5
	const SERVICE_RELEASE_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_RELEASE_SUBTLE := Color(0.019608, 0.14902, 0.168627, 1.0) # #05262b
	const SERVICE_RELEASE_BIT := Color(0.003922, 0.972549, 0.898039, 1.0) # #01f8e5
	const SERVICE_DISTRIBUTION := Color(0.223529, 0.815686, 0.458824, 1.0) # #39d075
	const SERVICE_DISTRIBUTION_FG := Color(0.223529, 0.815686, 0.458824, 1.0) # #39d075
	const SERVICE_DISTRIBUTION_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_DISTRIBUTION_SUBTLE := Color(0.047059, 0.129412, 0.117647, 1.0) # #0c211e
	const SERVICE_DISTRIBUTION_BIT := Color(0.223529, 0.815686, 0.458824, 1.0) # #39d075
	const SERVICE_UPDATE := Color(0.996078, 0.501961, 0.003922, 1.0) # #fe8001
	const SERVICE_UPDATE_FG := Color(0.996078, 0.501961, 0.003922, 1.0) # #fe8001
	const SERVICE_UPDATE_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_UPDATE_SUBTLE := Color(0.141176, 0.090196, 0.062745, 1.0) # #241710
	const SERVICE_UPDATE_BIT := Color(0.996078, 0.501961, 0.003922, 1.0) # #fe8001
	const SERVICE_IDENTITY := Color(0.843137, 0.490196, 0.94902, 1.0) # #d77df2
	const SERVICE_IDENTITY_FG := Color(0.843137, 0.490196, 0.94902, 1.0) # #d77df2
	const SERVICE_IDENTITY_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_IDENTITY_SUBTLE := Color(0.121569, 0.090196, 0.176471, 1.0) # #1f172d
	const SERVICE_IDENTITY_BIT := Color(0.843137, 0.490196, 0.94902, 1.0) # #d77df2


## The light theme.
class Light:
	const SURFACE_PAGE := Color(0.964706, 0.972549, 1.0, 1.0) # #f6f8ff
	const SURFACE_RAISED := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const SURFACE_OVERLAY := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const SURFACE_SUNKEN := Color(0.921569, 0.933333, 0.972549, 1.0) # #ebeef8
	const TEXT_STRONG := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const TEXT_DEFAULT := Color(0.14902, 0.176471, 0.25098, 1.0) # #262d40
	const TEXT_MUTED := Color(0.282353, 0.32549, 0.419608, 1.0) # #48536b
	const TEXT_SUBTLE := Color(0.364706, 0.4, 0.482353, 1.0) # #5d667b
	const TEXT_ON_ACCENT := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const BORDER_SUBTLE := Color(0.854902, 0.870588, 0.913725, 1.0) # #dadee9
	const BORDER_STRONG := Color(0.494118, 0.52549, 0.6, 1.0) # #7e8699
	const FOCUS := Color(0.478431, 0.184314, 1.0, 1.0) # #7a2fff
	const SUCCESS := Color(0.086275, 0.45098, 0.215686, 1.0) # #167337
	const SUCCESS_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const SUCCESS_BORDER := Color(0.203922, 0.560784, 0.309804, 1.0) # #348f4f
	const SUCCESS_SUBTLE := Color(0.878431, 0.921569, 0.921569, 1.0) # #e0ebeb
	const WARNING := Color(0.635294, 0.254902, 0.070588, 1.0) # #a24112
	const WARNING_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const WARNING_BORDER := Color(0.780392, 0.364706, 0.160784, 1.0) # #c75d29
	const WARNING_SUBTLE := Color(0.933333, 0.901961, 0.905882, 1.0) # #eee6e7
	const DANGER := Color(0.745098, 0.137255, 0.137255, 1.0) # #be2323
	const DANGER_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const DANGER_BORDER := Color(0.858824, 0.258824, 0.235294, 1.0) # #db423c
	const DANGER_SUBTLE := Color(0.941176, 0.890196, 0.913725, 1.0) # #f0e3e9
	const INFO := Color(0.478431, 0.184314, 1.0, 1.0) # #7a2fff
	const INFO_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const INFO_BORDER := Color(0.556863, 0.4, 0.945098, 1.0) # #8e66f1
	const INFO_SUBTLE := Color(0.917647, 0.894118, 1.0, 1.0) # #eae4ff
	const SIGNED := Color(0.768627, 0.45098, 0.0, 1.0) # #c47300
	const SIGNED_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SIGNED_BORDER := Color(0.74902, 0.443137, 0.003922, 1.0) # #bf7101
	const SIGNED_SUBTLE := Color(0.945098, 0.921569, 0.901961, 1.0) # #f1ebe6
	const SIGNED_MARK := Color(0.815686, 0.478431, 0.0, 1.0) # #d07a00
	const BRAND_VIOLET := Color(0.478431, 0.184314, 1.0, 1.0) # #7a2fff
	const BRAND_STAR := Color(0.478431, 0.184314, 1.0, 1.0) # #7a2fff
	const BRAND_GOLD := Color(0.815686, 0.478431, 0.0, 1.0) # #d07a00
	const SERVICE_CORE := Color(0.478431, 0.184314, 1.0, 1.0) # #7a2fff
	const SERVICE_CORE_FG := Color(0.478431, 0.184314, 1.0, 1.0) # #7a2fff
	const SERVICE_CORE_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const SERVICE_CORE_SUBTLE := Color(0.917647, 0.894118, 1.0, 1.0) # #eae4ff
	const SERVICE_LICENSE := Color(0.439216, 0.552941, 0.0, 1.0) # #708d00
	const SERVICE_LICENSE_FG := Color(0.333333, 0.431373, 0.0, 1.0) # #556e00
	const SERVICE_LICENSE_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_LICENSE_SUBTLE := Color(0.913725, 0.929412, 0.901961, 1.0) # #e9ede6
	const SERVICE_LICENSE_BIT := Color(0.439216, 0.552941, 0.0, 1.0) # #708d00
	const SERVICE_CONFIG := Color(0.0, 0.384314, 0.439216, 1.0) # #006270
	const SERVICE_CONFIG_FG := Color(0.0, 0.384314, 0.439216, 1.0) # #006270
	const SERVICE_CONFIG_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const SERVICE_CONFIG_SUBTLE := Color(0.866667, 0.913725, 0.945098, 1.0) # #dde9f1
	const SERVICE_CONFIG_BIT := Color(0.0, 0.384314, 0.439216, 1.0) # #006270
	const SERVICE_RELEASE := Color(0.0, 0.580392, 0.54902, 1.0) # #00948c
	const SERVICE_RELEASE_FG := Color(0.0, 0.462745, 0.435294, 1.0) # #00766f
	const SERVICE_RELEASE_ON := Color(0.023529, 0.035294, 0.070588, 1.0) # #060912
	const SERVICE_RELEASE_SUBTLE := Color(0.866667, 0.933333, 0.956863, 1.0) # #ddeef4
	const SERVICE_RELEASE_BIT := Color(0.0, 0.580392, 0.54902, 1.0) # #00948c
	const SERVICE_DISTRIBUTION := Color(0.019608, 0.466667, 0.231373, 1.0) # #05773b
	const SERVICE_DISTRIBUTION_FG := Color(0.019608, 0.466667, 0.231373, 1.0) # #05773b
	const SERVICE_DISTRIBUTION_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const SERVICE_DISTRIBUTION_SUBTLE := Color(0.870588, 0.921569, 0.921569, 1.0) # #deebeb
	const SERVICE_DISTRIBUTION_BIT := Color(0.019608, 0.466667, 0.231373, 1.0) # #05773b
	const SERVICE_UPDATE := Color(0.592157, 0.27451, 0.0, 1.0) # #974600
	const SERVICE_UPDATE_FG := Color(0.592157, 0.27451, 0.0, 1.0) # #974600
	const SERVICE_UPDATE_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const SERVICE_UPDATE_SUBTLE := Color(0.929412, 0.901961, 0.901961, 1.0) # #ede6e6
	const SERVICE_UPDATE_BIT := Color(0.592157, 0.27451, 0.0, 1.0) # #974600
	const SERVICE_IDENTITY := Color(0.619608, 0.203922, 0.682353, 1.0) # #9e34ae
	const SERVICE_IDENTITY_FG := Color(0.619608, 0.203922, 0.682353, 1.0) # #9e34ae
	const SERVICE_IDENTITY_ON := Color(1.0, 1.0, 1.0, 1.0) # #ffffff
	const SERVICE_IDENTITY_SUBTLE := Color(0.929412, 0.894118, 0.968627, 1.0) # #ede4f7
	const SERVICE_IDENTITY_BIT := Color(0.619608, 0.203922, 0.682353, 1.0) # #9e34ae


const _SERVICE_DARK := {
	"core": Color(0.603922, 0.360784, 1.0, 1.0),
	"license": Color(0.776471, 0.913725, 0.25098, 1.0),
	"config": Color(0.070588, 0.737255, 0.835294, 1.0),
	"release": Color(0.003922, 0.972549, 0.898039, 1.0),
	"distribution": Color(0.223529, 0.815686, 0.458824, 1.0),
	"update": Color(0.996078, 0.501961, 0.003922, 1.0),
	"identity": Color(0.843137, 0.490196, 0.94902, 1.0),
}
const _SERVICE_LIGHT := {
	"core": Color(0.478431, 0.184314, 1.0, 1.0),
	"license": Color(0.439216, 0.552941, 0.0, 1.0),
	"config": Color(0.0, 0.384314, 0.439216, 1.0),
	"release": Color(0.0, 0.580392, 0.54902, 1.0),
	"distribution": Color(0.019608, 0.466667, 0.231373, 1.0),
	"update": Color(0.592157, 0.27451, 0.0, 1.0),
	"identity": Color(0.619608, 0.203922, 0.682353, 1.0),
}
const _SERVICE_FG_DARK := {
	"core": Color(0.603922, 0.360784, 1.0, 1.0),
	"license": Color(0.776471, 0.913725, 0.25098, 1.0),
	"config": Color(0.070588, 0.737255, 0.835294, 1.0),
	"release": Color(0.003922, 0.972549, 0.898039, 1.0),
	"distribution": Color(0.223529, 0.815686, 0.458824, 1.0),
	"update": Color(0.996078, 0.501961, 0.003922, 1.0),
	"identity": Color(0.843137, 0.490196, 0.94902, 1.0),
}
const _SERVICE_FG_LIGHT := {
	"core": Color(0.478431, 0.184314, 1.0, 1.0),
	"license": Color(0.333333, 0.431373, 0.0, 1.0),
	"config": Color(0.0, 0.384314, 0.439216, 1.0),
	"release": Color(0.0, 0.462745, 0.435294, 1.0),
	"distribution": Color(0.019608, 0.466667, 0.231373, 1.0),
	"update": Color(0.592157, 0.27451, 0.0, 1.0),
	"identity": Color(0.619608, 0.203922, 0.682353, 1.0),
}
const _BIT_DARK := {
	"license": Color(0.776471, 0.913725, 0.25098, 1.0),
	"config": Color(0.070588, 0.737255, 0.835294, 1.0),
	"release": Color(0.003922, 0.972549, 0.898039, 1.0),
	"distribution": Color(0.223529, 0.815686, 0.458824, 1.0),
	"update": Color(0.996078, 0.501961, 0.003922, 1.0),
	"identity": Color(0.843137, 0.490196, 0.94902, 1.0),
}
const _BIT_LIGHT := {
	"license": Color(0.439216, 0.552941, 0.0, 1.0),
	"config": Color(0.0, 0.384314, 0.439216, 1.0),
	"release": Color(0.0, 0.580392, 0.54902, 1.0),
	"distribution": Color(0.019608, 0.466667, 0.231373, 1.0),
	"update": Color(0.592157, 0.27451, 0.0, 1.0),
	"identity": Color(0.619608, 0.203922, 0.682353, 1.0),
}


## A section's accent (indicators, fills). Unknown ids answer the core violet.
static func service_accent(service: String, dark: bool = true) -> Color:
	var table: Dictionary = _SERVICE_DARK if dark else _SERVICE_LIGHT
	return table.get(service, table["core"])


## A section's text colour (>= 4.5:1 on every surface of the theme).
static func service_fg(service: String, dark: bool = true) -> Color:
	var table: Dictionary = _SERVICE_FG_DARK if dark else _SERVICE_FG_LIGHT
	return table.get(service, table["core"])


## Whether a section draws the K's terminal bit: every service section does; core (the platform)
## and unknown ids do not. The default Polaris Key mark has no bit.
static func has_section_bit(service: String) -> bool:
	return _BIT_DARK.has(service)


## The K's terminal-bit colour for a service section (its accent). Core and unknown ids have no
## bit and answer transparent; check has_section_bit() and leave the bit out instead.
static func section_bit(service: String, dark: bool = true) -> Color:
	var table: Dictionary = _BIT_DARK if dark else _BIT_LIGHT
	return table.get(service, Color(0, 0, 0, 0))


## Which optical cut a mark displayed at `size` logical pixels uses.
static func optical_cut(size: float) -> String:
	if size < FAVICON_BELOW:
		return "favicon"
	if size <= SERVICE_MAX:
		return "service"
	return "display"


## Whether the K's terminal bit may be drawn at this displayed glyph size.
static func bit_visible(size: float) -> bool:
	return size >= GOLD_MINIMUM_GLYPH
