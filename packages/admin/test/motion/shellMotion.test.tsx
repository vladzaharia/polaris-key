import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PageLoading,
  routeSkeleton,
} from "../../src/console/shell/AppShell.js";
import type { Route } from "../../src/console/routes.js";

/**
 * The console shell's motion (notes/S-23 §4.2, §6.1; MO-10), read as text where jsdom computes
 * nothing: the Tailwind aliases for the motion layer's keyframes, the phone nav drawer's slide
 * from the inline start, the phone sheet, and the skeleton route fallback. The browser check is
 * e2e/kit.e2e.test.ts (exits) and the admin e2e suite (CSP, layout at 390 px).
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "src");
const read = (p: string): string => readFileSync(join(src, p), "utf8");
const styles = read("styles.css");
const motion = read("motion.css");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** `--animate-pk-x: <value>;` declarations in styles.css's @theme. */
function aliases(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of strip(styles).matchAll(/--animate-(pk-[\w-]+):\s*([^;]+);/g))
    out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  return out;
}
const keyframes = (text: string): Set<string> =>
  new Set([...strip(text).matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]!));

afterEach(cleanup);

describe("Tailwind aliases for the motion layer's keyframes", () => {
  const all = aliases();
  const defined = new Set([...keyframes(motion), ...keyframes(styles)]);

  it("aliases every enter, exit, edge and loading keyframe of motion.css", () => {
    for (const name of [
      "pk-enter",
      "pk-exit",
      "pk-fade-in",
      "pk-fade-out",
      "pk-pop-in",
      "pk-from-top",
      "pk-from-bottom",
      "pk-from-left",
      "pk-from-right",
      "pk-drawer-in",
      "pk-drawer-out",
      "pk-sheet-in",
      "pk-sheet-out",
      "pk-shimmer",
    ]) {
      expect(motion, `${name} is a motion.css keyframe`).toContain(
        `@keyframes ${name} `,
      );
      expect(all.get(name), `--animate-${name}`).toMatch(
        new RegExp(`^${name} `),
      );
    }
  });

  it("every alias names a keyframe that exists, timed by tokens only", () => {
    for (const [name, value] of all) {
      const kf = value.split(" ")[0]!;
      expect(defined.has(kf), `${name} → @keyframes ${kf}`).toBe(true);
      const withoutVars = value.replace(/var\([^)]*\)/g, "");
      // Only the spinner (a loading indicator, outside the token set) keeps a literal duration.
      if (name !== "pk-spin")
        expect(withoutVars, `${name}: ${value}`).not.toMatch(/\d+m?s\b/);
    }
  });

  it("enters fill backwards and exits fill forwards", () => {
    for (const [name, value] of all) {
      if (
        /-(in|enter)$|^pk-(enter|pop-in|from-)/.test(name) &&
        name !== "pk-in"
      )
        if (!/collapse|overlay/.test(name))
          expect(value, name).toMatch(/\bbackwards$/);
      if (/-(out|exit)$|^pk-exit$/.test(name) && !/collapse/.test(name))
        expect(value, name).toMatch(/\bforwards$/);
    }
  });

  it("no alias for pk-refetch, which motion.css defines as a class itself", () => {
    expect(all.has("pk-refetch")).toBe(false);
    expect(motion).toContain(".animate-pk-refetch {");
  });

  it("the sidebar's height keyframes use the expand pattern's moderate token", () => {
    expect(all.get("pk-collapse-down")).toMatch(/--pk-duration-moderate/);
    expect(all.get("pk-collapse-up")).toMatch(/--pk-duration-moderate/);
  });
});

describe("the phone nav drawer slides from the inline start", () => {
  const css = strip(styles);

  it("keyframes translate along -x by the drawer's full width", () => {
    expect(css).toMatch(
      /@keyframes pk-nav-in \{\s*from \{\s*transform: translateX\(-100%\);/,
    );
    expect(css).toMatch(
      /@keyframes pk-nav-out \{\s*to \{\s*transform: translateX\(-100%\);/,
    );
  });

  it("enters slow·emphasized and exits base·exit, out-ranking motion.css's rise", () => {
    expect(css).toMatch(
      /\.pk-nav-drawer\.pk-nav-drawer:not\(\[data-state="closed"\]\) \{\s*animation: pk-nav-in var\(--pk-duration-slow\) var\(--pk-ease-emphasized\)\s*backwards;/,
    );
    expect(css).toMatch(
      /\.pk-nav-drawer\.pk-nav-drawer\[data-state="closed"\] \{\s*animation: pk-nav-out var\(--pk-duration-base\) var\(--pk-ease-exit\) forwards;/,
    );
  });

  it("is an instant swap under both reduced-motion switches", () => {
    const media = css.split("@media (prefers-reduced-motion: reduce)")[1] ?? "";
    expect(media.slice(0, 200)).toMatch(
      /\.pk-nav-drawer\.pk-nav-drawer\.pk-nav-drawer \{\s*animation: none;/,
    );
    expect(css).toMatch(
      /:root\[data-motion="reduce"\] \.pk-nav-drawer\.pk-nav-drawer \{\s*animation: none;/,
    );
  });

  it("the drawer carries it, beside the overlay classes motion.css keys on", () => {
    const shell = read("console/shell/AppShell.tsx");
    expect(shell).toMatch(/animate-pk-in pk-nav-drawer lg:hidden/);
  });
});

describe("the phone sheet", () => {
  it("Dialog's content is marked pk-sheet, which motion.css slides below 640 px", () => {
    expect(read("ui/Dialog.tsx")).toMatch(/"pk-sheet inset-x-0 bottom-0/);
    expect(motion).toMatch(
      /@media \(max-width: 639px\)[\s\S]*?\.pk-sheet\.pk-sheet/,
    );
  });
});

describe("the lazy route fallback is a skeleton", () => {
  const route = (r: Partial<Route> & Pick<Route, "kind">): Route =>
    ({ query: new URLSearchParams(), ...r }) as Route;

  it("draws the template of the page it stands in for", () => {
    expect(
      routeSkeleton(route({ kind: "product", slug: "a", page: "overview" })),
    ).toBe("dashboard");
    expect(
      routeSkeleton(route({ kind: "product", slug: "a", page: "licenses" })),
    ).toBe("table");
    expect(
      routeSkeleton(
        route({ kind: "product", slug: "a", page: "licenses", id: "L1" }),
      ),
    ).toBe("record");
    expect(
      routeSkeleton(route({ kind: "global", page: "platform-settings" })),
    ).toBe("form");
    expect(
      routeSkeleton(route({ kind: "global", page: "platform-deployment" })),
    ).toBe("dashboard");
  });

  it("shows no spinner and no visible Loading… text, after the skeleton grace", () => {
    const { container } = render(
      <PageLoading
        route={route({ kind: "product", slug: "a", page: "licenses" })}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("pk-skeleton-group");
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector('[data-skeleton="table"]')).not.toBeNull();
    expect(root.querySelector('svg, [class*="spin"]')).toBeNull();
    // The polite announcement is the only text, and it is visually hidden.
    const visible = [...root.querySelectorAll("*")].filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent?.trim() &&
        !el.closest("[role=status], [aria-live], .sr-only"),
    );
    expect(visible).toEqual([]);
  });
});

describe("no page pulses", () => {
  it("the platform pages and Home draw pk-skeleton blocks", () => {
    for (const f of [
      "console/pages/platform.tsx",
      "console/pages/platformOperations.tsx",
      "console/pages/platformSettings.tsx",
      "console/pages/platformStores.tsx",
      "console/pages/global/Home.tsx",
    ])
      expect(read(f), f).toContain("pk-skeleton");
  });
});
