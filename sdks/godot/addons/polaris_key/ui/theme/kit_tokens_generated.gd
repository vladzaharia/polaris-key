# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
# packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
# `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
# its source and regenerate.
class_name PKeyKitTokens
extends RefCounted
## The Godot kit's component tokens (docs/design/UI-KITS.md §2.1, §4.8): sizes at 720p (the kit
## scales with the window's content scale), the type scale, the motion timings, the highlight
## edge, the danger solid behind white labels and the scrim. Colours of the palette are in
## PKeyBrand (brand_tokens_generated.gd).

## A radius value meaning "fully rounded" (half the control's height).
const CAPSULE := -1.0
## The concentric rule: inner radius = outer radius - inset, never below this.
const CONCENTRIC_MIN := 8.0

## Component measures.
const CONTROL_HEIGHT := 60.0
const RADIUS_CONTROL := 16.0
const RADIUS_PANEL := 28.0
const CARD_PAD := 44.0
const FOCUS_SYSTEM := false
const FOCUS_WIDTH := 3.0
const FOCUS_OFFSET := 2.0
const FOCUS_INNER := 0.0
const FOCUS_GLOW := 8.0
const HAS_SCRIM := true
const SCRIM_DARK_OPACITY := 0.42
const SCRIM_DARK_BLUR := 0.0
const SCRIM_LIGHT_OPACITY := 0.2
const SCRIM_LIGHT_BLUR := 0.0

## Type scale (px at 720p). Weights are 400, 500 and 600 only.
const TYPE_DISPLAY := {"size": 36.0, "line_height": 44.0, "weight": 600, "tracking": 0.0, "mono": false}
const TYPE_TITLE := {"size": 32.0, "line_height": 40.0, "weight": 600, "tracking": 0.0, "mono": false}
const TYPE_BODY := {"size": 18.0, "line_height": 26.0, "weight": 400, "tracking": 0.0, "mono": false}
const TYPE_LABEL := {"size": 19.0, "line_height": 26.0, "weight": 500, "tracking": 0.0, "mono": false}
const TYPE_BUTTON := {"size": 19.0, "line_height": 26.0, "weight": 500, "tracking": 0.0, "mono": false}
const TYPE_META := {"size": 16.0, "line_height": 22.0, "weight": 400, "tracking": 0.0, "mono": false}
const TYPE_FOOTNOTE := {"size": 16.0, "line_height": 22.0, "weight": 400, "tracking": 0.0, "mono": false}
const TYPE_CODE := {"size": 52.0, "line_height": 60.0, "weight": 600, "tracking": 0.06, "mono": true}

## Font families: the bundled variable Rubik and JetBrains Mono (fonts/).
const FONT_FAMILY := "Rubik"
const MONO_FAMILY := "JetBrains Mono"
const RUBIK_VARIABLE_PATH := "res://addons/polaris_key/ui/theme/fonts/rubik_variable.tres"
const JETBRAINS_MONO_VARIABLE_PATH := "res://addons/polaris_key/ui/theme/fonts/jetbrains_mono_variable.tres"

## Motion (ms; UI-KITS §4.8).
const MOTION_STEP_MS := 220
const MOTION_SHEET_IN_MS := 280
const MOTION_SHEET_OUT_MS := 160
const MOTION_PRESS_MS := 120
const MOTION_PROGRESS_MS := 200
const MOTION_WAITING_MS := 0
const MOTION_SUCCESS_MS := 320
## Brand motion durations (ms) and distances (px at 720p; notes/S-23 §5). Zero the durations when
## reduced motion is on.
const DURATION_MICRO_MS := 80
const DURATION_FAST_MS := 120
const DURATION_BASE_MS := 200
const DURATION_MODERATE_MS := 260
const DURATION_SLOW_MS := 320
const DURATION_DELIBERATE_MS := 480
const DURATION_SHIMMER_MS := 1600
const MOTION_DISTANCE_XS := 2.0
const MOTION_DISTANCE_SM := 4.0
const MOTION_DISTANCE_MD := 8.0
const MOTION_DISTANCE_LG := 12.0
const MOTION_DISTANCE_XL := 24.0
const PRESS_SCALE := 0.98
const SHEET_RISE := 24.0
const OVERSHOOT := 1.04

## Theme colours the palette does not carry.
const HIGHLIGHT_DARK := Color(1.0, 1.0, 1.0, 0.05)
const DANGER_SOLID_DARK := Color(0.858824, 0.227451, 0.168627, 1.0) # #db3a2b
const DANGER_ON_DARK := Color(1.0, 1.0, 1.0, 1.0)
const SCRIM_DARK := Color(0.007843, 0.015686, 0.031373, 0.42)
const HIGHLIGHT_LIGHT := Color(1.0, 1.0, 1.0, 0.9)
const DANGER_SOLID_LIGHT := Color(0.745098, 0.137255, 0.137255, 1.0) # #be2323
const DANGER_ON_LIGHT := Color(1.0, 1.0, 1.0, 1.0)
const SCRIM_LIGHT := Color(0.023529, 0.035294, 0.070588, 0.2)


## The inner radius of a surface of radius `outer` inset by `inset`.
static func concentric_radius(outer: float, inset: float) -> float:
	return maxf(CONCENTRIC_MIN, outer - inset)
