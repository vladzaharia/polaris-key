import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from "../src/components/theme.js";
import { ThemeMenu } from "../src/console/shell/ThemeMenu.js";

/**
 * The theme contract (docs/design/BRAND.md §3): dark first, following the OS, with a persisted
 * System / Dark / Light override on <html data-theme>, applied before first paint by an inline
 * script the Worker's CSP allows by hash.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const SHELLS = ["index.html", "manage.html"] as const;

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?<a>[^>]*)>(?<b>[\s\S]*?)<\/script>/g)]
    .filter((m) => !/\ssrc\s*=/.test(m.groups!.a!) && m.groups!.b!.length > 0)
    .map((m) => m.groups!.b!);
}

const shellScripts = SHELLS.map((f) =>
  inlineScripts(readFileSync(join(pkg, f), "utf8")),
);
const PRE_PAINT = shellScripts[0]![0]!;

/** A controllable prefers-color-scheme. */
function mockSystem(initial: "dark" | "light"): {
  set: (t: "dark" | "light") => void;
} {
  let light = initial === "light";
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return query.includes("light") ? light : !light;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    })),
  );
  return {
    set: (t) => {
      light = t === "light";
      for (const l of listeners) l();
    },
  };
}

function resetDocument(): void {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  root.classList.remove("dark", "light");
  window.localStorage.clear();
}

beforeEach(resetDocument);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetDocument();
});

describe("the pre-paint theme script", () => {
  it("is in <head> of both shells, before any stylesheet or module, and byte-identical", () => {
    for (const [i, file] of SHELLS.entries()) {
      expect(shellScripts[i], file).toHaveLength(1);
      expect(shellScripts[i]![0], file).toBe(PRE_PAINT);
      const html = readFileSync(join(pkg, file), "utf8");
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head.indexOf(PRE_PAINT), file).toBeGreaterThan(-1);
      expect(head.indexOf(PRE_PAINT)).toBeLessThan(head.indexOf("<title>"));
    }
  });

  it("is allowed by the Worker's CSP hash (packages/worker/src/adminCsp.ts)", () => {
    const hash = `'sha256-${createHash("sha256").update(PRE_PAINT, "utf8").digest("base64")}'`;
    const adminCsp = readFileSync(
      join(pkg, "..", "worker", "src", "adminCsp.ts"),
      "utf8",
    );
    expect(adminCsp).toContain(`"${hash}"`);
  });

  it.each([
    [null, null],
    ["system", null],
    ["dark", "dark"],
    ["light", "light"],
    ["sepia", null],
  ])("stored %j → data-theme %j", (stored, expected) => {
    if (stored !== null) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    new Function(PRE_PAINT)();
    expect(document.documentElement.getAttribute("data-theme")).toBe(expected);
  });

  it("never throws when storage is unavailable", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    expect(() => new Function(PRE_PAINT)()).not.toThrow();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    getItem.mockRestore();
  });

  it("reads the same storage key the provider writes", () => {
    expect(PRE_PAINT).toContain(`"${THEME_STORAGE_KEY}"`);
  });
});

describe("the theme menu", () => {
  function Showing(): React.ReactElement {
    const { theme } = useTheme();
    return <output aria-label="showing">{theme}</output>;
  }

  function renderMenu(): void {
    render(
      <ThemeProvider>
        <ThemeMenu />
        <Showing />
      </ThemeProvider>,
    );
  }

  const root = document.documentElement;
  const showing = (): string | null =>
    screen.getByLabelText("showing").textContent;
  const stored = (): string | null =>
    window.localStorage.getItem(THEME_STORAGE_KEY);

  /** Open the menu and pick a theme by its label. */
  async function choose(label: "System" | "Dark" | "Light"): Promise<void> {
    await userEvent.click(screen.getByRole("button", { name: /^Theme: / }));
    const menu = await screen.findByRole("menu");
    const group = within(menu).getByRole("group", { name: "Theme" });
    await userEvent.click(
      within(group).getByRole("menuitemradio", {
        name: new RegExp(`^${label}`),
      }),
    );
  }

  beforeEach(() => {
    (
      Element.prototype as unknown as { hasPointerCapture: () => boolean }
    ).hasPointerCapture = () => false;
    (
      Element.prototype as unknown as { scrollIntoView: () => void }
    ).scrollIntoView = () => undefined;
  });

  it("offers System, Dark and Light as radio choices, the current one checked", async () => {
    mockSystem("light");
    renderMenu();
    await userEvent.click(
      screen.getByRole("button", { name: "Theme: System" }),
    );
    const menu = await screen.findByRole("menu");
    const group = within(menu).getByRole("group", { name: "Theme" });
    const items = within(group).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      "SystemLight now",
      "Dark",
      "Light",
    ]);
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");
    expect(items[1]!.getAttribute("aria-checked")).toBe("false");
  });

  it("persists each choice on <html> and in storage, and returns to System", async () => {
    mockSystem("light");
    renderMenu();

    // System: no attribute (tokens.css follows the OS), resolved from the OS.
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(showing()).toBe("light");
    expect(stored()).toBe("system");

    await choose("Dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(showing()).toBe("dark");
    expect(stored()).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeTruthy();

    await choose("Light");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(showing()).toBe("light");
    expect(stored()).toBe("light");

    await choose("System");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(stored()).toBe("system");
  });

  it("restores a persisted choice on the next load", () => {
    mockSystem("light");
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderMenu();
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(showing()).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeTruthy();
  });

  it("follows the OS live while on System, and is dark when the OS gives no answer", () => {
    const system = mockSystem("dark");
    renderMenu();
    expect(showing()).toBe("dark");
    act(() => system.set("light"));
    expect(showing()).toBe("light");
    expect(root.hasAttribute("data-theme")).toBe(false);
    cleanup();

    vi.unstubAllGlobals(); // no matchMedia at all
    renderMenu();
    expect(showing()).toBe("dark");
  });
});
