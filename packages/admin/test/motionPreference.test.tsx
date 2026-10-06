import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MOTION_STORAGE_KEY,
  applyStoredMotionPreference,
  readMotionPreference,
  setMotionPreference,
} from "../src/components/motionPreference.js";
import { ThemeProvider } from "../src/components/theme.js";
import { ThemeMenu } from "../src/console/shell/ThemeMenu.js";
import { reducedMotion } from "../src/ui/motion/index.js";

/**
 * The in-app reduce-motion preference (notes/S-23 D3, §6.6; MO-12): System or Reduced, stored per
 * browser under pk-admin-motion, applied as html[data-motion] by both entry modules before render
 * (never by the hashed pre-paint script), and honoured by the tokens, motion.css and Tailwind's
 * motion-reduce: / motion-safe: variants.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const read = (p: string): string => readFileSync(join(pkg, p), "utf8");
const root = document.documentElement;

function reset(): void {
  root.removeAttribute("data-motion");
  root.removeAttribute("data-theme");
  window.localStorage.clear();
}
beforeEach(reset);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  reset();
});

describe("storage and the attribute", () => {
  it("defaults to system: no attribute", () => {
    expect(readMotionPreference()).toBe("system");
    expect(applyStoredMotionPreference()).toBe("system");
    expect(root.hasAttribute("data-motion")).toBe(false);
  });

  it("applies a stored reduce at start-up, as after a reload", () => {
    window.localStorage.setItem(MOTION_STORAGE_KEY, "reduce");
    expect(applyStoredMotionPreference()).toBe("reduce");
    expect(root.getAttribute("data-motion")).toBe("reduce");
    expect(reducedMotion()).toBe(true);
  });

  it("ignores an unknown stored value", () => {
    window.localStorage.setItem(MOTION_STORAGE_KEY, "fast");
    expect(applyStoredMotionPreference()).toBe("system");
    expect(root.hasAttribute("data-motion")).toBe(false);
  });

  it("sets and clears the attribute at once and persists both choices", () => {
    setMotionPreference("reduce");
    expect(root.getAttribute("data-motion")).toBe("reduce");
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("reduce");
    setMotionPreference("system");
    expect(root.hasAttribute("data-motion")).toBe(false);
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("system");
  });

  it("still applies when storage throws (private mode)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    setMotionPreference("reduce");
    expect(root.getAttribute("data-motion")).toBe("reduce");
    vi.restoreAllMocks();
  });

  it("is applied by both entry modules before render, not by the pre-paint script", () => {
    for (const entry of ["src/main.tsx", "src/portal/main.tsx"]) {
      const text = read(entry);
      const call = text.indexOf("applyStoredMotionPreference();");
      expect(call, entry).toBeGreaterThan(0);
      expect(call, entry).toBeLessThan(text.indexOf("createRoot(root)"));
    }
    for (const shell of ["index.html", "manage.html"])
      expect(read(shell), shell).not.toMatch(/pk-admin-motion|data-motion/);
  });
});

describe("every duration token resolves to 0 ms under the preference", () => {
  const tokens = read("../brand/css/tokens.css").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const block = (selector: string): string => {
    const at = tokens.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return tokens.slice(at, tokens.indexOf("}", at));
  };
  const durations = (body: string): Map<string, string> =>
    new Map(
      [...body.matchAll(/(--pk-duration-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
        m[1]!,
        m[2]!.trim(),
      ]),
    );
  const all = durations(tokens);

  it("redeclares each --pk-duration-* as 0ms on :root[data-motion=reduce]", () => {
    expect(all.size).toBeGreaterThan(4);
    const reduced = durations(block(':root[data-motion="reduce"]'));
    for (const name of all.keys()) expect(reduced.get(name), name).toBe("0ms");
  });
});

describe("Tailwind's motion variants follow the preference too", () => {
  const styles = read("src/styles.css");

  it("motion-reduce: applies under the OS query or html[data-motion=reduce]", () => {
    const at = styles.indexOf("@custom-variant motion-reduce");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = styles.slice(at, styles.indexOf("@custom-variant", at + 1));
    expect(body).toContain("@media (prefers-reduced-motion: reduce)");
    expect(body).toContain(':root[data-motion="reduce"] *');
  });

  it('motion-safe: stops under html[data-motion="reduce"]', () => {
    const at = styles.indexOf("@custom-variant motion-safe");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(styles.slice(at)).toContain(':root:not([data-motion="reduce"])');
  });
});

describe("the console's Motion row, beside the theme", () => {
  beforeEach(() => {
    (
      Element.prototype as unknown as { hasPointerCapture: () => boolean }
    ).hasPointerCapture = () => false;
    (
      Element.prototype as unknown as { scrollIntoView: () => void }
    ).scrollIntoView = () => undefined;
  });

  async function openMenu(): Promise<HTMLElement> {
    await userEvent.click(screen.getByRole("button", { name: /^Theme: / }));
    const menu = await screen.findByRole("menu");
    return within(menu).getByRole("group", { name: "Motion" });
  }

  it("offers System and Reduced; Reduced sets data-motion at once and survives a reload", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    render(
      <ThemeProvider>
        <ThemeMenu />
      </ThemeProvider>,
    );
    let group = await openMenu();
    const items = within(group).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      "SystemFull now",
      "Reduced",
    ]);
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");

    await userEvent.click(items[1]!);
    expect(root.getAttribute("data-motion")).toBe("reduce");
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("reduce");

    // A reload: the attribute goes, the entry module puts it back from storage.
    cleanup();
    root.removeAttribute("data-motion");
    applyStoredMotionPreference();
    expect(root.getAttribute("data-motion")).toBe("reduce");
    render(
      <ThemeProvider>
        <ThemeMenu />
      </ThemeProvider>,
    );
    group = await openMenu();
    const reduced = within(group).getByRole("menuitemradio", {
      name: /^Reduced/,
    });
    expect(reduced.getAttribute("aria-checked")).toBe("true");

    await userEvent.click(
      within(group).getByRole("menuitemradio", { name: /^System/ }),
    );
    expect(root.hasAttribute("data-motion")).toBe(false);
  });
});
