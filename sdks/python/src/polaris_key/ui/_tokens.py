# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
# packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
# `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
# its source and regenerate.
"""Polaris Key design tokens for the Python UI kits (Qt and the terminal).

The palette per scheme, the per-section accents, the kit component tokens and type scale for the
desktop platforms the Qt kit renders (docs/design/UI-KITS.md §2.1), the motion timings and the
accent resolver's surfaces. polaris_key.ui.accent resolves a product's accent against these.
"""

from __future__ import annotations

KIT_VERSION = "1.0.0"

#: The palette per scheme ("dark" is the default), as lower-case "#rrggbb".
THEMES = {
    "dark": {
        "surface_page": "#060912",
        "surface_raised": "#0d111b",
        "surface_overlay": "#121722",
        "surface_sunken": "#020408",
        "text_strong": "#ffffff",
        "text_default": "#dbe4ff",
        "text_muted": "#b5bed3",
        "text_subtle": "#969eb2",
        "text_on_accent": "#060912",
        "border_subtle": "#212633",
        "border_strong": "#61697b",
        "focus": "#9a5cff",
        "success": "#56d57b",
        "success_on": "#060912",
        "success_border": "#3b9555",
        "success_subtle": "#10211f",
        "warning": "#c38d18",
        "warning_on": "#060912",
        "warning_border": "#896100",
        "warning_subtle": "#1d1913",
        "danger": "#f2513f",
        "danger_on": "#060912",
        "danger_border": "#c83b2c",
        "danger_subtle": "#221217",
        "info": "#b688fe",
        "info_on": "#060912",
        "info_border": "#8f54dc",
        "info_subtle": "#1b182e",
        "signed": "#ffc24d",
        "signed_on": "#060912",
        "signed_border": "#ba882e",
        "signed_subtle": "#241f19",
        "signed_mark": "#ffc24d",
        "brand_violet": "#9a5cff",
        "brand_gold": "#ffc24d",
        "danger_solid": "#db3a2b",
        "danger_solid_on": "#ffffff",
        "scrim_color": "#020408",
    },
    "light": {
        "surface_page": "#f6f8ff",
        "surface_raised": "#ffffff",
        "surface_overlay": "#ffffff",
        "surface_sunken": "#ebeef8",
        "text_strong": "#060912",
        "text_default": "#262d40",
        "text_muted": "#48536b",
        "text_subtle": "#5d667b",
        "text_on_accent": "#ffffff",
        "border_subtle": "#dadee9",
        "border_strong": "#7e8699",
        "focus": "#7a2fff",
        "success": "#167337",
        "success_on": "#ffffff",
        "success_border": "#348f4f",
        "success_subtle": "#e0ebeb",
        "warning": "#814d00",
        "warning_on": "#ffffff",
        "warning_border": "#9d6726",
        "warning_subtle": "#eae7e6",
        "danger": "#be2323",
        "danger_on": "#ffffff",
        "danger_border": "#db423c",
        "danger_subtle": "#f0e3e9",
        "info": "#7a2fff",
        "info_on": "#ffffff",
        "info_border": "#8e66f1",
        "info_subtle": "#eae4ff",
        "signed": "#c47300",
        "signed_on": "#060912",
        "signed_border": "#bf7101",
        "signed_subtle": "#f1ebe6",
        "signed_mark": "#d07a00",
        "brand_violet": "#7a2fff",
        "brand_gold": "#d07a00",
        "danger_solid": "#be2323",
        "danger_solid_on": "#ffffff",
        "scrim_color": "#060912",
    },
}

#: Per scheme, each section's accent; "bit" is None on core, which draws no bit.
SERVICE_ACCENTS = {
    "dark": {
        "core": {
            "solid": "#9a5cff",
            "fg": "#9a5cff",
            "on": "#060912",
            "subtle": "#18132e",
            "bit": None,
        },
        "license": {
            "solid": "#c6e940",
            "fg": "#c6e940",
            "on": "#060912",
            "subtle": "#1d2418",
            "bit": "#c6e940",
        },
        "config": {
            "solid": "#fac700",
            "fg": "#fac700",
            "on": "#060912",
            "subtle": "#232010",
            "bit": "#fac700",
        },
        "release": {
            "solid": "#00dbfd",
            "fg": "#00dbfd",
            "on": "#060912",
            "subtle": "#05222e",
            "bit": "#00dbfd",
        },
        "distribution": {
            "solid": "#39d075",
            "fg": "#39d075",
            "on": "#060912",
            "subtle": "#0c211e",
            "bit": "#39d075",
        },
        "update": {
            "solid": "#fe8001",
            "fg": "#fe8001",
            "on": "#060912",
            "subtle": "#241710",
            "bit": "#fe8001",
        },
        "identity": {
            "solid": "#d77df2",
            "fg": "#d77df2",
            "on": "#060912",
            "subtle": "#1f172d",
            "bit": "#d77df2",
        },
    },
    "light": {
        "core": {
            "solid": "#7a2fff",
            "fg": "#7a2fff",
            "on": "#ffffff",
            "subtle": "#eae4ff",
            "bit": None,
        },
        "license": {
            "solid": "#708d00",
            "fg": "#556e00",
            "on": "#060912",
            "subtle": "#e9ede6",
            "bit": "#708d00",
        },
        "config": {
            "solid": "#8b6902",
            "fg": "#866500",
            "on": "#ffffff",
            "subtle": "#ebeae6",
            "bit": "#8b6902",
        },
        "release": {
            "solid": "#0390a6",
            "fg": "#007487",
            "on": "#060912",
            "subtle": "#deeef6",
            "bit": "#0390a6",
        },
        "distribution": {
            "solid": "#05773b",
            "fg": "#05773b",
            "on": "#ffffff",
            "subtle": "#deebeb",
            "bit": "#05773b",
        },
        "update": {
            "solid": "#b95800",
            "fg": "#aa5000",
            "on": "#ffffff",
            "subtle": "#f0e8e6",
            "bit": "#b95800",
        },
        "identity": {
            "solid": "#9e34ae",
            "fg": "#9e34ae",
            "on": "#ffffff",
            "subtle": "#ede4f7",
            "bit": "#9e34ae",
        },
    },
}

#: The four surfaces the accent resolver checks contrast on: page, raised, overlay, sunken.
ACCENT_SURFACES = {
    "dark": ["#060912", "#0d111b", "#121722", "#020408"],
    "light": ["#f6f8ff", "#ffffff", "#ffffff", "#ebeef8"],
}

#: The 1 px inner top edge on raised surfaces and primaries: a colour at an opacity.
HIGHLIGHT = {
    "dark": {
        "color": "#ffffff",
        "opacity": 0.05,
    },
    "light": {
        "color": "#ffffff",
        "opacity": 0.9,
    },
}

#: Font families (bundled in polaris_key/ui/fonts) and the weights the kits use.
FONT_FAMILY = "Rubik"
MONO_FAMILY = "JetBrains Mono"
FONT_WEIGHT = {
    "regular": 400,
    "medium": 500,
    "semibold": 600,
    "bold": 700,
}

#: Space (px) and radius (px) scales.
SPACE = {
    "0": 0,
    "1": 4,
    "2": 8,
    "3": 12,
    "4": 16,
    "5": 20,
    "6": 24,
    "8": 32,
    "10": 40,
    "12": 48,
    "16": 64,
    "20": 80,
    "24": 96,
    "0.5": 2,
    "1.5": 6,
}
RADIUS = {
    "none": 0,
    "xs": 2,
    "sm": 4,
    "md": 6,
    "lg": 10,
    "xl": 18,
}

#: Motion durations (ms) and measures.
MOTION_MS = {
    "instant": 0,
    "micro": 80,
    "fast": 120,
    "base": 200,
    "moderate": 260,
    "slow": 320,
    "deliberate": 480,
    "shimmer": 1600,
}
MOTION = {
    "step": 200,
    "sheet_in": 320,
    "sheet_out": 200,
    "press": 120,
    "progress": 200,
    "waiting": 0,
    "success": 320,
}
PRESS_SCALE = 0.98

#: A radius meaning "fully rounded" (half the control's height).
CAPSULE = "capsule"
#: The concentric rule: inner radius = outer radius - inset, never below this.
CONCENTRIC_MIN = 8

#: Component measures per desktop platform (px; points on macOS).
KIT = {
    "macos": {
        "control_height": 28,
        "control_height_hero": 36,
        "radius_control": "capsule",
        "radius_form": 10,
        "radius_sheet": 18,
        "card_pad": 24,
        "card_pad_compact": 22,
        "focus_system": True,
        "focus_width": 0,
        "focus_offset": 0,
        "focus_inner": 0,
        "focus_glow": 0,
        "has_scrim": False,
        "scrim_dark_opacity": 0,
        "scrim_dark_blur": 0,
        "scrim_light_opacity": 0,
        "scrim_light_blur": 0,
        "radius_surface": 18,
    },
    "windows": {
        "control_height": 32,
        "radius_control": 4,
        "radius_overlay": 8,
        "card_pad": 24,
        "focus_system": False,
        "focus_width": 2,
        "focus_offset": 0,
        "focus_inner": 1,
        "focus_glow": 0,
        "has_scrim": True,
        "scrim_dark_opacity": 0.3,
        "scrim_dark_blur": 0,
        "scrim_light_opacity": 0.3,
        "scrim_light_blur": 0,
        "radius_surface": 8,
    },
    "gnome": {
        "control_height": 34,
        "radius_control": 8,
        "radius_dialog": 14,
        "card_pad": 24,
        "focus_system": False,
        "focus_width": 2,
        "focus_offset": -2,
        "focus_inner": 0,
        "focus_glow": 0,
        "has_scrim": True,
        "scrim_dark_opacity": 0.35,
        "scrim_dark_blur": 0,
        "scrim_light_opacity": 0.12,
        "scrim_light_blur": 0,
        "radius_surface": 14,
    },
}

#: The QSS placeholders polaris_key.ui.qt fills in qt/polaris_key_{dark,light}.qss, as "@pk-<name>@".
QSS_PLACEHOLDERS = ["accent", "accent-on", "accent-fg", "accent-subtle", "focus", "control-height", "radius-control", "radius-surface", "card-pad"]

#: Type scale per desktop platform. Weights are 400, 500 and 600 only.
TYPE_SCALE = {
    "macos": {
        "display": {
            "size": 26,
            "line_height": 32,
            "weight": 600,
            "tracking": 0,
            "mono": False,
        },
        "title": {
            "size": 22,
            "line_height": 28,
            "weight": 600,
            "tracking": 0,
            "mono": False,
        },
        "body": {
            "size": 13,
            "line_height": 16,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "label": {
            "size": 13,
            "line_height": 16,
            "weight": 500,
            "tracking": 0,
            "mono": False,
        },
        "button": {
            "size": 13,
            "line_height": 16,
            "weight": 500,
            "tracking": 0,
            "mono": False,
        },
        "meta": {
            "size": 12,
            "line_height": 15,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "footnote": {
            "size": 12,
            "line_height": 15,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "code": {
            "size": 28,
            "line_height": 34,
            "weight": 600,
            "tracking": 0.06,
            "mono": True,
        },
    },
    "windows": {
        "display": {
            "size": 40,
            "line_height": 52,
            "weight": 600,
            "tracking": 0,
            "mono": False,
        },
        "title": {
            "size": 28,
            "line_height": 36,
            "weight": 600,
            "tracking": 0,
            "mono": False,
        },
        "body": {
            "size": 14,
            "line_height": 20,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "label": {
            "size": 14,
            "line_height": 20,
            "weight": 500,
            "tracking": 0,
            "mono": False,
        },
        "button": {
            "size": 14,
            "line_height": 20,
            "weight": 500,
            "tracking": 0,
            "mono": False,
        },
        "meta": {
            "size": 12,
            "line_height": 16,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "footnote": {
            "size": 12,
            "line_height": 16,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "code": {
            "size": 28,
            "line_height": 36,
            "weight": 500,
            "tracking": 0.06,
            "mono": True,
        },
    },
    "gnome": {
        "display": {
            "size": 28,
            "line_height": 34,
            "weight": 600,
            "tracking": 0,
            "mono": False,
        },
        "title": {
            "size": 22,
            "line_height": 28,
            "weight": 600,
            "tracking": 0,
            "mono": False,
        },
        "body": {
            "size": 15,
            "line_height": 21,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "label": {
            "size": 15,
            "line_height": 21,
            "weight": 500,
            "tracking": 0,
            "mono": False,
        },
        "button": {
            "size": 15,
            "line_height": 21,
            "weight": 500,
            "tracking": 0,
            "mono": False,
        },
        "meta": {
            "size": 13,
            "line_height": 18,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "footnote": {
            "size": 13,
            "line_height": 18,
            "weight": 400,
            "tracking": 0,
            "mono": False,
        },
        "code": {
            "size": 28,
            "line_height": 34,
            "weight": 500,
            "tracking": 0.06,
            "mono": True,
        },
    },
}


def concentric_radius(outer: float, inset: float) -> float:
    """The inner radius of a surface of radius `outer` inset by `inset`."""
    return max(CONCENTRIC_MIN, outer - inset)
