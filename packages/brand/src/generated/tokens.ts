// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen brand --check` fails the green gate on any difference. To change a value, edit
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
    action: {
      fill: "#f6f8ff",
      on: "#060912",
      hover: "#dee0e7",
      pressed: "#c1c3cb",
      disabledFill: "#2c2f38",
      disabledOn: "#969eb2",
    },
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
      teal: {
        solid: "#14f8e1",
        fg: "#14f8e1",
        on: "#060912",
        subtle: "#08262b",
      },
    },
    state: {
      core: {
        ring: "#9a5cff",
        selectedFill: "#18132e",
        hoverTint: "#100f23",
        checkedFill: "#9a5cff",
        checkedOn: "#060912",
        checkedEdge: "#9a5cff",
        contextEdge: "#9a5cff",
      },
      license: {
        ring: "#c6e940",
        selectedFill: "#1d2418",
        hoverTint: "#131915",
        checkedFill: "#c6e940",
        checkedOn: "#060912",
        checkedEdge: "#c6e940",
        contextEdge: "#c6e940",
      },
      config: {
        ring: "#fac700",
        selectedFill: "#232010",
        hoverTint: "#171611",
        checkedFill: "#fac700",
        checkedOn: "#060912",
        checkedEdge: "#fac700",
        contextEdge: "#fac700",
      },
      release: {
        ring: "#00dbfd",
        selectedFill: "#05222e",
        hoverTint: "#061822",
        checkedFill: "#00dbfd",
        checkedOn: "#060912",
        checkedEdge: "#00dbfd",
        contextEdge: "#00dbfd",
      },
      distribution: {
        ring: "#39d075",
        selectedFill: "#0c211e",
        hoverTint: "#0a1719",
        checkedFill: "#39d075",
        checkedOn: "#060912",
        checkedEdge: "#39d075",
        contextEdge: "#39d075",
      },
      update: {
        ring: "#fe8001",
        selectedFill: "#241710",
        hoverTint: "#171111",
        checkedFill: "#fe8001",
        checkedOn: "#060912",
        checkedEdge: "#fe8001",
        contextEdge: "#fe8001",
      },
      identity: {
        ring: "#d77df2",
        selectedFill: "#1f172d",
        hoverTint: "#151122",
        checkedFill: "#d77df2",
        checkedOn: "#060912",
        checkedEdge: "#d77df2",
        contextEdge: "#d77df2",
      },
      sync: {
        ring: "#14f8e1",
        selectedFill: "#08262b",
        hoverTint: "#071a20",
        checkedFill: "#14f8e1",
        checkedOn: "#060912",
        checkedEdge: "#14f8e1",
        contextEdge: "#14f8e1",
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
    action: {
      fill: "#060912",
      on: "#ffffff",
      hover: "#23262e",
      pressed: "#444750",
      disabledFill: "#d4d7de",
      disabledOn: "#5d667b",
    },
    accent: {
      violet: {
        solid: "#7a2fff",
        fg: "#7a2fff",
        on: "#ffffff",
        subtle: "#eae4ff",
      },
      chartreuse: {
        solid: "#6d8600",
        fg: "#556e00",
        on: "#060912",
        subtle: "#e8ede6",
      },
      yellow: {
        solid: "#8b6902",
        fg: "#866500",
        on: "#ffffff",
        subtle: "#ebeae6",
      },
      cyan: {
        solid: "#008ca3",
        fg: "#007487",
        on: "#060912",
        subtle: "#ddedf6",
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
      teal: {
        solid: "#086260",
        fg: "#086260",
        on: "#ffffff",
        subtle: "#dee9ef",
      },
    },
    state: {
      core: {
        ring: "#7a2fff",
        selectedFill: "#eae4ff",
        hoverTint: "#efecff",
        checkedFill: "#7a2fff",
        checkedOn: "#ffffff",
        checkedEdge: "#7a2fff",
        contextEdge: "#7a2fff",
      },
      license: {
        ring: "#556e00",
        selectedFill: "#e8ede6",
        hoverTint: "#eef1f0",
        checkedFill: "#6d8600",
        checkedOn: "#060912",
        checkedEdge: "#556e00",
        contextEdge: "#556e00",
      },
      config: {
        ring: "#866500",
        selectedFill: "#ebeae6",
        hoverTint: "#f0eff0",
        checkedFill: "#8b6902",
        checkedOn: "#ffffff",
        checkedEdge: "#866500",
        contextEdge: "#866500",
      },
      release: {
        ring: "#007487",
        selectedFill: "#ddedf6",
        hoverTint: "#e7f2f9",
        checkedFill: "#008ca3",
        checkedOn: "#060912",
        checkedEdge: "#007487",
        contextEdge: "#007487",
      },
      distribution: {
        ring: "#05773b",
        selectedFill: "#deebeb",
        hoverTint: "#e8f0f3",
        checkedFill: "#05773b",
        checkedOn: "#ffffff",
        checkedEdge: "#05773b",
        contextEdge: "#05773b",
      },
      update: {
        ring: "#aa5000",
        selectedFill: "#f0e8e6",
        hoverTint: "#f2eef0",
        checkedFill: "#b95800",
        checkedOn: "#ffffff",
        checkedEdge: "#aa5000",
        contextEdge: "#aa5000",
      },
      identity: {
        ring: "#9e34ae",
        selectedFill: "#ede4f7",
        hoverTint: "#f1ecfa",
        checkedFill: "#9e34ae",
        checkedOn: "#ffffff",
        checkedEdge: "#9e34ae",
        contextEdge: "#9e34ae",
      },
      sync: {
        ring: "#086260",
        selectedFill: "#dee9ef",
        hoverTint: "#e8eff5",
        checkedFill: "#086260",
        checkedOn: "#ffffff",
        checkedEdge: "#086260",
        contextEdge: "#086260",
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
    sync: {
      solid: "#14f8e1",
      fg: "#14f8e1",
      on: "#060912",
      subtle: "#08262b",
      bit: "#14f8e1",
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
      solid: "#6d8600",
      fg: "#556e00",
      on: "#060912",
      subtle: "#e8ede6",
      bit: "#6d8600",
    },
    config: {
      solid: "#8b6902",
      fg: "#866500",
      on: "#ffffff",
      subtle: "#ebeae6",
      bit: "#8b6902",
    },
    release: {
      solid: "#008ca3",
      fg: "#007487",
      on: "#060912",
      subtle: "#ddedf6",
      bit: "#008ca3",
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
    sync: {
      solid: "#086260",
      fg: "#086260",
      on: "#ffffff",
      subtle: "#dee9ef",
      bit: "#086260",
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
