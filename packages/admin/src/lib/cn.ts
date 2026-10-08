import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type steps `styles.css` adds to the brand scale. tailwind-merge reads only the t-shirt
 * sizes as font sizes and files any other `text-<name>` as a text colour, so without this
 * `cn("text-code", "text-fg")` would drop the size as a colour conflict. The arbitrary sizes
 * these steps replaced (a rem or px value in brackets) were always read as sizes
 * (test/tokenAliases.test.ts keeps this list in step with styles.css).
 */
const ADMIN_TEXT_SIZES = [
  "3xs",
  "2xs",
  "code",
  "md",
  "headline",
  "headline-lg",
  "display",
] as const;

const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...ADMIN_TEXT_SIZES] }] } },
});

/** Merge conditional class lists, then de-conflict Tailwind utilities (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
