// The provider sign-in marks (docs/design/UI-KITS.md §3.6, SIGN-IN.md §3.2): the logos a "Continue
// with <provider>" button carries, with the fills and label colours the provider's own branding
// guidelines require. A provider keeps its own mark, fill and label colours; the product accent
// never tints them. One source: the elements and React kits read it directly; `pnpm gen brand`
// writes it into the Swift, Compose, Python and Godot kits.
//
// Apple is not here on purpose: every kit draws the system Sign in with Apple control.
//
// Google: the standard four-colour "G" (Google Identity branding guidelines, "Sign in with Google"
// button assets). The artwork is used unmodified: never recoloured, stretched or tinted.

/** The Google "G" grid; the artwork's viewBox. */
export const GOOGLE_G_GRID = 48;

/** The G's SVG paths in drawing order, each with its fixed brand fill. */
export const GOOGLE_G_PATHS = [
  {
    fill: "#EA4335",
    d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z",
  },
  {
    fill: "#4285F4",
    d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z",
  },
  {
    fill: "#FBBC05",
    d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z",
  },
  {
    fill: "#34A853",
    d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z",
  },
] as const;

/** A provider button's colours: fill, hairline border (null: none) and label. */
export interface ProviderButtonFill {
  fill: string;
  border: string | null;
  label: string;
}

/**
 * Google's three button fills. Light and dark follow the scheme; neutral is the quiet alternative
 * on either. The border is 1 px, inside the button.
 */
export const GOOGLE_BUTTON_FILLS = {
  light: { fill: "#FFFFFF", border: "#747775", label: "#1F1F1F" },
  dark: { fill: "#131314", border: "#8E918F", label: "#E3E3E3" },
  neutral: { fill: "#F2F2F2", border: null, label: "#1F1F1F" },
} as const satisfies Record<string, ProviderButtonFill>;

export type GoogleButtonFill = keyof typeof GOOGLE_BUTTON_FILLS;

/** The fill a kit uses by default in each colour scheme. */
export const GOOGLE_BUTTON_FOR_SCHEME = {
  light: "light",
  dark: "dark",
} as const satisfies Record<"light" | "dark", GoogleButtonFill>;

/** The G is drawn at this fraction of the button's height, left of the label with the gap below. */
export const GOOGLE_G_HEIGHT_RATIO = 0.5;
/** The gap between the G and the label, in the button's px (dp, points). */
export const GOOGLE_G_LABEL_GAP = 10;

/** The copy key of the label: "Continue with {provider}", with `provider` = "Google". */
export const GOOGLE_BUTTON_COPY_KEY = "signin.provider.continue";

/** The G as one SVG document (a string, no React), for the web kits. */
export function googleGSvg(size: number = GOOGLE_G_GRID): string {
  const paths = GOOGLE_G_PATHS.map(
    (p) => `<path fill="${p.fill}" d="${p.d}"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${GOOGLE_G_GRID} ${GOOGLE_G_GRID}" aria-hidden="true" focusable="false">${paths}</svg>`;
}
