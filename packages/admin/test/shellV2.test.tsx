import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PAGES, accentOf, PRODUCT_PAGES } from "../src/console/nav.js";
import { SidebarItem } from "../src/console/shell/Sidebar.js";
import { Dialog } from "../src/ui/Dialog.js";
import { Breadcrumbs } from "../src/console/components/Breadcrumbs.js";
import { MastheadContext } from "../src/ui/Masthead.js";
import { PageHeader } from "../src/ui/PageHeader.js";
import { ConfirmDialog } from "../src/ui/ConfirmDialog.js";
import { ALL_ON, boot, resetConsole } from "./consoleHarness.js";

/**
 * Console shell v2 (ST-48; BRAND-TRANSITION B2-B6, B17): the canvas, the masthead's one
 * orientation line, Ship builds' one identity, the neutral-ink primary, the dialog rule and the
 * workbench. The pixels are `e2e/layout.e2e.test.ts`'s (the masthead height, the first-content
 * offset, the canvas inset); these are the structure and the stylesheet rules.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(here, "..", "src", "styles.css"), "utf8");

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("every page names its data-service (B5)", () => {
  it("none renders 'undefined', and each is a service accent token", () => {
    const tokens = new Set([
      "core",
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
      "sync",
      "commerce",
    ]);
    for (const p of ALL_PAGES) {
      const accent = accentOf(p.page);
      expect(String(accent), p.page).not.toBe("undefined");
      expect(tokens.has(accent), `${p.page}: ${accent}`).toBe(true);
    }
  });

  it("Ship builds is ONE Release identity; Update is never a console accent", () => {
    const ship = [
      "releases",
      "channels",
      "rollouts",
      "package-feeds",
      "feed",
      "health",
    ] as const;
    for (const page of ship) expect(accentOf(page), page).toBe("release");
    for (const p of PRODUCT_PAGES)
      expect(accentOf(p.page), p.page).not.toBe("update");
  });
});

describe("the canvas and the masthead (B4)", () => {
  it("draws the canvas with the page's accent and ONE orientation line above the one h1", async () => {
    boot("#/p/djdl/distribution/rollouts", { services: ALL_ON });
    await screen.findByRole("heading", { level: 1, name: /Rollouts/ });
    const main = document.getElementById("content")!;
    expect(main.getAttribute("data-canvas")).toBe("");
    expect(main.getAttribute("data-service")).toBe("release");
    expect(main.className).toContain("border-t-[3px]");
    expect(main.className).toContain("lg:rounded-[18px]");
    expect(main.querySelectorAll("h1")).toHaveLength(1);
    const lines = main.querySelectorAll('nav[aria-label="Breadcrumb"]');
    expect(lines).toHaveLength(1);
    // The chip is decorative; the ancestors are the product and the FEATURE (Ship builds), and
    // never "Platform" on a product page.
    expect(
      lines[0]!
        .querySelector("[data-orientation-chip]")!
        .getAttribute("aria-hidden"),
    ).toBe("true");
    expect(lines[0]!.textContent).toContain("DJDL");
    expect(lines[0]!.textContent).toContain("Ship builds");
    expect(lines[0]!.textContent).not.toContain("Platform");
    expect(main.textContent).not.toMatch(/workspace/i);
  });

  it("draws the 48 px tile aria-hidden on a landing page, and none on a dense data page", async () => {
    // Overview's hero is its own masthead (it draws the logo and the title itself), so the
    // landing page here is Integration.
    boot("#/p/djdl/integration", { services: ALL_ON });
    await screen.findByRole("heading", { level: 1, name: "Integration" });
    const tile = document.querySelector("[data-masthead-tile]");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    expect(tile?.className).toContain("lg:inline-flex");
    cleanup();
    resetConsole();
    boot("#/p/djdl/license/licenses", { services: ALL_ON });
    await screen.findByRole("heading", { level: 1, name: "Licenses" });
    expect(document.querySelector("[data-masthead-tile]")).toBeNull();
  });

  it("folds a record's own crumbs into the one line and stops at the page", () => {
    render(
      <MastheadContext.Provider
        value={{
          accent: "license",
          record: true,
          tile: null,
          orientation: (extra) => (
            <nav aria-label="Breadcrumb" data-orientation="">
              <ol>
                <li>DJDL</li>
                {extra.slice(0, -1).map((c, i) => (
                  <li key={i}>{c.label}</li>
                ))}
              </ol>
            </nav>
          ),
        }}
      >
        <PageHeader
          eyebrow={
            <Breadcrumbs
              items={[{ label: "Licenses" }, { label: "Ada Lovelace" }]}
            />
          }
          title="Ada Lovelace"
        />
      </MastheadContext.Provider>,
    );
    // ONE breadcrumb line, the ancestors only: the h1 is the page.
    const lines = screen.getAllByRole("navigation", { name: "Breadcrumb" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe("DJDLLicenses");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.className).toContain("sm:text-headline-lg sm:leading-10");
  });

  it("sets 36/44 on a collection, 32/40 on a record and 24/32 on a phone", async () => {
    boot("#/p/djdl/license/licenses", { services: ALL_ON });
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Licenses",
    });
    expect(h1.className).toContain("text-2xl leading-8");
    expect(h1.className).toContain("sm:text-4xl sm:leading-11");
    expect(h1.className).toContain("line-clamp-2");
  });
});

describe("the sidebar's selected row (B3, B17)", () => {
  const page = PRODUCT_PAGES.find((p) => p.page === "rollouts")!;
  it("keeps the badge's own status colour and drops font-bold", () => {
    render(<SidebarItem page={page} to="#/x" active rail={false} badge={2} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.className).toContain("bg-accent-subtle");
    expect(link.className).toContain("before:w-[3px]");
    expect(link.className).not.toContain("font-bold");
    const badge = link.querySelector(".text-warning");
    expect(badge).not.toBeNull();
    expect(badge!.className).not.toMatch(/text-accent/);
  });

  it("takes its own service on a sales page in the mixed list", () => {
    const storefronts = PRODUCT_PAGES.find((p) => p.page === "storefronts")!;
    render(
      <SidebarItem page={storefronts} to="#/x" active={false} rail={false} />,
    );
    expect(screen.getByRole("link").getAttribute("data-service")).toBe(
      "distribution",
    );
  });
});

describe("dialogs (B4)", () => {
  it("opens with a 3 px accent top rule and a head band; the title is 20/28", () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Mint key"
        glyph={<i data-g />}
      >
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-tone")).toBe("default");
    expect(dialog.className).toContain(
      "console:border-t-[3px] console:border-t-accent",
    );
    const head = dialog.querySelector("[data-pk-overlay-header]")!;
    expect(head.className).toContain("console:bg-(--pk-admin-band-overlay)");
    expect(head.querySelectorAll("[data-overlay-glyph]")).toHaveLength(1);
    const title = screen.getByRole("heading", { name: "Mint key" });
    expect(title.className).toContain("console:text-xl console:leading-7");
    expect(document.querySelector("[data-pk-backdrop]")).not.toBeNull();
  });

  it("carries no accent rule on a destructive or a caution confirmation", () => {
    for (const intent of ["danger", "caution"] as const) {
      const { unmount } = render(
        <ConfirmDialog
          open
          onOpenChange={() => {}}
          intent={intent}
          title="Delete it"
          onConfirm={() => {}}
        />,
      );
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.getAttribute("data-tone")).toBe(intent);
      expect(dialog.className).not.toContain("border-t-accent");
      unmount();
    }
  });
});

describe("the stylesheet (B2, B6, B17)", () => {
  it("makes the console's primary neutral action ink, scoped to the console", () => {
    expect(STYLES).toContain(
      'html[data-shell="console"] [data-variant="primary"] {\n  background-color: var(--pk-action);',
    );
    expect(STYLES).toContain("var(--pk-action-on)");
    expect(STYLES).toContain("var(--pk-action-disabled)");
  });

  it("points the focus ring at the nearest service's state ring, never inline", () => {
    expect(STYLES).toContain("--pk-focus: var(--pk-state-ring);");
    expect(STYLES).toContain('html[data-shell="console"] [data-service]');
  });

  it("blurs the backdrop and drops it under reduced transparency", () => {
    expect(STYLES).toMatch(
      /html\[data-shell="console"\] \[data-pk-backdrop\] \{\s*backdrop-filter: blur\(6px\)/,
    );
    expect(STYLES).toMatch(
      /prefers-reduced-transparency: reduce\) \{\s*html\[data-shell="console"\] \[data-pk-backdrop\] \{\s*backdrop-filter: none/,
    );
  });

  it("has no glow, wash or gradient in the shell's own rules (the tab fade is a mask)", () => {
    const shell = STYLES.slice(STYLES.indexOf("Console shell v2"));
    expect(shell).not.toMatch(/background(-image)?:[^;]*gradient/);
    expect(shell).not.toMatch(/box-shadow:[^;]*(?:rgb|#)/);
  });
});
