/**
 * How a baseline file name maps onto the component catalog, for the `build/ui/` component pages.
 *
 * The catalog is packages/brand/kit-copy/components.json: every docs/design/UI-KITS.md §4.1
 * component with its states, under §4.1's names. A kit names a baseline after the component and
 * state it renders, in kebab case, with the theme last (ui-qa's convention, UI-KITS.md §7.1):
 *
 *   devices-list-dark.png                  flat: <component>-<state>[-<variant>]-<theme>.png
 *   devices-list-390-light.png             a variant of the same state (a size, a preset)
 *   boot-consent/phone-branded-dark.png    Roborazzi: <component>-<state>/<variant>-<theme>.png
 *   devices/phone-branded-light.png        no state: the component's default render
 *
 * The component is the longest catalog name that prefixes the file's name (so `sign-in-handoff-…`
 * is SignInHandoff, not SignIn), and the state the longest of its states that prefixes the rest.
 * A name that matches no component is kept with `component: null`: the framework pages list those
 * so a kit can see which of its baselines no component page shows. This module is pure (no
 * import.meta.glob), so test/ui.test.ts can pin it.
 */

import catalogJson from "../../../brand/kit-copy/components.json";

export type Theme = "dark" | "light";

/** Component name → its states in catalog order. */
export type Catalog = Readonly<Record<string, readonly string[]>>;

export interface ShotName {
  /** A catalog component, or null when the name matches none. */
  component: string | null;
  /** One of the component's states, or "" for its default render. */
  state: string;
  /** What is left of the name ("390", "phone-branded"), or "". */
  variant: string;
  /** The name without its theme: the state directory or the flat stem. */
  name: string;
  theme: Theme;
}

export const CATALOG: Catalog = Object.fromEntries(
  Object.entries(
    (
      catalogJson as {
        components: Record<string, { states: Record<string, unknown> }>;
      }
    ).components,
  ).map(([name, c]) => [name, Object.keys(c.states)]),
);

/** `SignInHandoff` → `sign-in-handoff`. */
export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** The theme token in a file stem, and the stem without it (ui-qa's report reads names the same way). */
export function splitTheme(stem: string): {
  rest: string;
  theme: Theme | null;
} {
  const m = stem.match(/(^|[-_.])(dark|light)(?=$|[-_.])/);
  if (m === null || m.index === undefined) return { rest: stem, theme: null };
  const rest = (
    stem.slice(0, m.index) + stem.slice(m.index + m[0].length)
  ).replace(/^[-_.]|[-_.]$/g, "");
  return { rest, theme: m[2] as Theme };
}

/** The longest candidate equal to `id` or followed in it by "-", and what follows. */
function longestPrefix(
  id: string,
  candidates: readonly string[],
): { match: string; rest: string } | null {
  let best: string | null = null;
  for (const c of candidates) {
    if (
      (id === c || id.startsWith(`${c}-`)) &&
      (best === null || c.length > best.length)
    ) {
      best = c;
    }
  }
  if (best === null) return null;
  return { match: best, rest: id.slice(best.length + 1) };
}

/**
 * Classify one baseline by its path inside the kit's baseline directory. Null for a file that
 * names no theme: the docs show baselines in pairs, dark and light.
 */
export function classify(
  relPath: string,
  catalog: Catalog = CATALOG,
): ShotName | null {
  const parts = relPath.split("/");
  const stem = parts[parts.length - 1]!.replace(/\.[a-z]+$/, "");
  const { rest, theme } = splitTheme(stem);
  if (theme === null) return null;
  const nested = parts.length > 1;
  const name = nested ? parts[0]! : rest;
  const fileVariant = nested ? rest : "";

  const names = Object.keys(catalog);
  const byKebab = new Map(names.map((n) => [kebab(n), n]));
  const component = longestPrefix(name, [...byKebab.keys()]);
  if (component === null) {
    return { component: null, state: "", variant: fileVariant, name, theme };
  }
  const componentName = byKebab.get(component.match)!;
  const state = longestPrefix(component.rest, catalog[componentName]!);
  const extra = state === null ? component.rest : state.rest;
  return {
    component: componentName,
    state: state?.match ?? "",
    variant: [extra, fileVariant].filter((s) => s !== "").join(" "),
    name,
    theme,
  };
}
