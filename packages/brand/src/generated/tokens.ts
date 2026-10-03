// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

import type { ResolvedTheme } from "../tokens/resolve.js";
import type { ServiceId, Theme } from "../tokens/source.js";

/** Every semantic colour, resolved to hex, per theme. */
export const THEME_TOKENS = {
  dark: {
    surface: {
      page: "#060912",
      raised: "#0d111b",
      overlay: "#121722",
      sunken: "#020408",
    },
    text: {
      strong: "#ffffff",
      default: "#dbe4ff",
      muted: "#b5bed3",
      subtle: "#969eb2",
      onAccent: "#060912",
    },
    border: { subtle: "#212633", strong: "#61697b" },
    focus: "#9a5cff",
    accent: {
      violet: {
        solid: "#9a5cff",
        fg: "#9a5cff",
        on: "#060912",
        subtle: "#18132e",
      },
      chartreuse: {
        solid: "#c6e940",
        fg: "#c6e940",
        on: "#060912",
        subtle: "#1d2418",
      },
      yellow: {
        solid: "#fac700",
        fg: "#fac700",
        on: "#060912",
        subtle: "#232010",
      },
      cyan: {
        solid: "#00dbfd",
        fg: "#00dbfd",
        on: "#060912",
        subtle: "#05222e",
      },
      green: {
        solid: "#39d075",
        fg: "#39d075",
        on: "#060912",
        subtle: "#0c211e",
      },
      tangerine: {
        solid: "#fe8001",
        fg: "#fe8001",
        on: "#060912",
        subtle: "#241710",
      },
      orchid: {
        solid: "#d77df2",
        fg: "#d77df2",
        on: "#060912",
        subtle: "#1f172d",
      },
    },
    status: {
      success: {
        fg: "#56d57b",
        on: "#060912",
        border: "#3b9555",
        subtle: "#10211f",
      },
      warning: {
        fg: "#c38d18",
        on: "#060912",
        border: "#896100",
        subtle: "#1d1913",
      },
      danger: {
        fg: "#f2513f",
        on: "#060912",
        border: "#c83b2c",
        subtle: "#221217",
      },
      info: {
        fg: "#b688fe",
        on: "#060912",
        border: "#8f54dc",
        subtle: "#1b182e",
      },
    },
    signed: {
      mark: "#ffc24d",
      solid: "#ffc24d",
      on: "#060912",
      border: "#ba882e",
      subtle: "#241f19",
    },
  },
  light: {
    surface: {
      page: "#f6f8ff",
      raised: "#ffffff",
      overlay: "#ffffff",
      sunken: "#ebeef8",
    },
    text: {
      strong: "#060912",
      default: "#262d40",
      muted: "#48536b",
      subtle: "#5d667b",
      onAccent: "#ffffff",
    },
    border: { subtle: "#dadee9", strong: "#7e8699" },
    focus: "#7a2fff",
    accent: {
      violet: {
        solid: "#7a2fff",
        fg: "#7a2fff",
        on: "#ffffff",
        subtle: "#eae4ff",
      },
      chartreuse: {
        solid: "#708d00",
        fg: "#556e00",
        on: "#060912",
        subtle: "#e9ede6",
      },
      yellow: {
        solid: "#8b6902",
        fg: "#866500",
        on: "#ffffff",
        subtle: "#ebeae6",
      },
      cyan: {
        solid: "#0390a6",
        fg: "#007487",
        on: "#060912",
        subtle: "#deeef6",
      },
      green: {
        solid: "#05773b",
        fg: "#05773b",
        on: "#ffffff",
        subtle: "#deebeb",
      },
      tangerine: {
        solid: "#b95800",
        fg: "#aa5000",
        on: "#ffffff",
        subtle: "#f0e8e6",
      },
      orchid: {
        solid: "#9e34ae",
        fg: "#9e34ae",
        on: "#ffffff",
        subtle: "#ede4f7",
      },
    },
    status: {
      success: {
        fg: "#167337",
        on: "#ffffff",
        border: "#348f4f",
        subtle: "#e0ebeb",
      },
      warning: {
        fg: "#814d00",
        on: "#ffffff",
        border: "#9d6726",
        subtle: "#eae7e6",
      },
      danger: {
        fg: "#be2323",
        on: "#ffffff",
        border: "#db423c",
        subtle: "#f0e3e9",
      },
      info: {
        fg: "#7a2fff",
        on: "#ffffff",
        border: "#8e66f1",
        subtle: "#eae4ff",
      },
    },
    signed: {
      mark: "#d07a00",
      solid: "#c47300",
      on: "#060912",
      border: "#bf7101",
      subtle: "#f1ebe6",
    },
  },
} as const satisfies Record<Theme, ResolvedTheme>;

/**
 * Per theme, each section's accent (solid, fg, on, subtle) and its section-bit colour; bit is
 * null on core, which draws no bit.
 */
export const SERVICE_ACCENTS = {
  dark: {
    core: {
      solid: "#9a5cff",
      fg: "#9a5cff",
      on: "#060912",
      subtle: "#18132e",
      bit: null,
    },
    license: {
      solid: "#c6e940",
      fg: "#c6e940",
      on: "#060912",
      subtle: "#1d2418",
      bit: "#c6e940",
    },
    config: {
      solid: "#fac700",
      fg: "#fac700",
      on: "#060912",
      subtle: "#232010",
      bit: "#fac700",
    },
    release: {
      solid: "#00dbfd",
      fg: "#00dbfd",
      on: "#060912",
      subtle: "#05222e",
      bit: "#00dbfd",
    },
    distribution: {
      solid: "#39d075",
      fg: "#39d075",
      on: "#060912",
      subtle: "#0c211e",
      bit: "#39d075",
    },
    update: {
      solid: "#fe8001",
      fg: "#fe8001",
      on: "#060912",
      subtle: "#241710",
      bit: "#fe8001",
    },
    identity: {
      solid: "#d77df2",
      fg: "#d77df2",
      on: "#060912",
      subtle: "#1f172d",
      bit: "#d77df2",
    },
  },
  light: {
    core: {
      solid: "#7a2fff",
      fg: "#7a2fff",
      on: "#ffffff",
      subtle: "#eae4ff",
      bit: null,
    },
    license: {
      solid: "#708d00",
      fg: "#556e00",
      on: "#060912",
      subtle: "#e9ede6",
      bit: "#708d00",
    },
    config: {
      solid: "#8b6902",
      fg: "#866500",
      on: "#ffffff",
      subtle: "#ebeae6",
      bit: "#8b6902",
    },
    release: {
      solid: "#0390a6",
      fg: "#007487",
      on: "#060912",
      subtle: "#deeef6",
      bit: "#0390a6",
    },
    distribution: {
      solid: "#05773b",
      fg: "#05773b",
      on: "#ffffff",
      subtle: "#deebeb",
      bit: "#05773b",
    },
    update: {
      solid: "#b95800",
      fg: "#aa5000",
      on: "#ffffff",
      subtle: "#f0e8e6",
      bit: "#b95800",
    },
    identity: {
      solid: "#9e34ae",
      fg: "#9e34ae",
      on: "#ffffff",
      subtle: "#ede4f7",
      bit: "#9e34ae",
    },
  },
} as const satisfies Record<
  Theme,
  Record<
    ServiceId,
    {
      solid: string;
      fg: string;
      on: string;
      subtle: string;
      bit: string | null;
    }
  >
>;
