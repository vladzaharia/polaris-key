import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/securityHeaders.js";

/**
 * Chunk 3's overlays (ADMIN.md §7.2) under the Worker's real CSP: every dialog, confirm, drawer,
 * one-time secret, menu, select, popover, tooltip, toast and the lazy CodeMirror editor in the
 * `#/__kit` gallery, in real Chromium. Each must log zero `securitypolicyviolation` events; each
 * modal overlay must really lock the page behind it (through the react-style-singleton shim,
 * src/lib/styleSingleton.ts) and release the lock when it closes.
 *
 * The gallery is development-only, so this builds a separate bundle with `VITE_PK_KIT=1` into
 * `dist-kit/` (git-ignored). The shipped `dist/` never contains it.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const OUT = "dist-kit";

let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  process.env.VITE_PK_KIT = "1";
  try {
    await build({
      root: here,
      configFile: `${here}vite.config.ts`,
      logLevel: "silent",
      build: { outDir: OUT, emptyOutDir: true },
    });
  } finally {
    delete process.env.VITE_PK_KIT;
  }
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
    build: { outDir: OUT },
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "silent",
  });
  base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.httpServer.close(() => r()));
});

async function open(
  theme: "dark" | "light",
  viewport = { width: 1440, height: 900 },
  consoleErrors?: string[],
  reducedMotion?: "reduce" | "no-preference",
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport,
    colorScheme: theme,
    permissions: ["clipboard-read", "clipboard-write"],
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  await ctx.addInitScript(() => {
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
      ),
    );
  });
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      return route.fulfill({ status: 404, json: { error: "not_found" } });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors?.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors?.push(e.message));
  await page.goto(`${base}/manage.html#/__kit`);
  await page
    .getByRole("heading", { level: 1, name: "Component gallery" })
    .waitFor();
  return page;
}

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

const locked = (page: Page): Promise<boolean> =>
  page.evaluate(() => getComputedStyle(document.body).overflow === "hidden");

const story = (page: Page, id: string): Locator => page.locator(`#story-${id}`);

const report: Record<string, { violations: number; locked: boolean }> = {};

/**
 * Open an overlay, check the scroll lock (modal) or its absence (non-modal), close it, and
 * require zero CSP violations across the whole open/close cycle.
 */
async function check(
  page: Page,
  name: string,
  openIt: () => Promise<void>,
  opts: {
    modal: boolean;
    close?: () => Promise<void>;
  },
): Promise<void> {
  await violations(page);
  await openIt();
  await page.waitForTimeout(300);
  const isLocked = await locked(page);
  if (opts.close) await opts.close();
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const v = await violations(page);
  report[name] = { violations: v.length, locked: isLocked };
  expect(v, `${name}: CSP violations`).toEqual([]);
  expect(isLocked, `${name}: scroll lock`).toBe(opts.modal);
  expect(await locked(page), `${name}: lock not released`).toBe(false);
}

describe("the kit gallery's overlays under the Worker's CSP", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`${theme}: the gallery loads with no violations or console errors`, async () => {
      const errors: string[] = [];
      const page = await open(theme, undefined, errors);
      await page.waitForTimeout(300);
      expect(await violations(page)).toEqual([]);
      expect(errors).toEqual([]);
      await page.context().close();
    });
  }

  it("the gallery settles: no render loop at load or after a theme change, phone or desktop", async () => {
    // A react-table auto-reset once re-rendered every DataTable forever after any second render
    // (a theme change; the virtualizer's first measure on a phone), freezing the page.
    const quiet = (page: Page): Promise<number> =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let n = 0;
            const mo = new MutationObserver((ms) => {
              n += ms.length;
            });
            mo.observe(document, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            setTimeout(() => {
              mo.disconnect();
              resolve(n);
            }, 1000);
          }),
      );
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      const page = await open("dark", viewport);
      await page.waitForTimeout(1000);
      expect(await quiet(page), `${viewport.width}px at rest`).toBe(0);
      await page
        .getByRole("group", { name: "Theme" })
        .getByRole("button", { name: "light" })
        .click();
      await page.waitForTimeout(500);
      expect(
        await quiet(page),
        `${viewport.width}px after a theme change`,
      ).toBe(0);
      await page.context().close();
    }
  });

  it("dialogs, confirms, drawers and the one-time secret lock scroll and log nothing", async () => {
    const page = await open("dark");
    for (const size of ["sm", "md", "lg", "xl"]) {
      await check(
        page,
        `dialog ${size}`,
        async () => {
          await story(page, "dialog")
            .getByRole("button", { name: `Open ${size} dialog` })
            .click();
          await page.getByRole("dialog", { name: "Edit holder" }).waitFor();
        },
        { modal: true },
      );
    }
    for (const label of [
      "Resync from repo…",
      "Disable license…",
      "Yank…",
      "Delete product…",
    ]) {
      await check(
        page,
        `confirm ${label}`,
        async () => {
          await story(page, "confirm-dialog")
            .getByRole("button", { name: label, exact: true })
            .click();
          await page
            .getByRole("alertdialog")
            .or(page.getByRole("dialog"))
            .first()
            .waitFor();
        },
        { modal: true },
      );
    }
    // The typed confirm with a server error stays open with the inline error, then closes.
    await check(
      page,
      "confirm with an inline error",
      async () => {
        await story(page, "confirm-dialog")
          .getByRole("button", { name: "Disable license (server refuses)…" })
          .click();
        const dlg = page
          .getByRole("alertdialog")
          .or(page.getByRole("dialog"))
          .first();
        await dlg.getByRole("button", { name: "Disable license" }).click();
        await dlg.getByText("Someone changed this license").waitFor();
      },
      { modal: true },
    );
    for (const side of ["end", "start"]) {
      await check(
        page,
        `drawer ${side}`,
        async () => {
          await story(page, "drawer")
            .getByRole("button", { name: `Open drawer from the ${side}` })
            .click();
          await page.getByRole("dialog").waitFor();
        },
        { modal: true },
      );
    }
    await check(
      page,
      "one-time secret (close guard)",
      async () => {
        await story(page, "one-time-secret")
          .getByRole("button", { name: "Create license" })
          .click();
        await page.getByRole("dialog", { name: "License created" }).waitFor();
      },
      {
        modal: true,
        close: async () => {
          await page.keyboard.press("Escape");
          // Escape asks first: the key cannot be shown again.
          await page
            .getByRole("button", { name: "Close without copying" })
            .click();
        },
      },
    );
    await page.context().close();
  });

  it("menus, selects, popovers, tooltips, toasts and the code editor log nothing", async () => {
    const page = await open("light");
    await check(
      page,
      "action menu",
      async () => {
        await story(page, "action-menu")
          .getByRole("button", { name: "More actions" })
          .click();
        await page.getByRole("menu").waitFor();
      },
      { modal: true },
    );
    await check(
      page,
      "select",
      async () => {
        await story(page, "form-select")
          .getByRole("combobox", { name: /Usage/ })
          .click();
        await page.getByRole("listbox").waitFor();
      },
      { modal: true },
    );
    await check(
      page,
      "combobox",
      async () => {
        await story(page, "form-combobox")
          .getByRole("button", { name: /^Release/ })
          .first()
          .click();
        await page.getByRole("listbox").first().waitFor();
      },
      { modal: false },
    );
    await check(
      page,
      "source badge popover",
      async () => {
        await story(page, "source-badges").getByRole("button").first().click();
        await page.getByRole("dialog").waitFor();
      },
      { modal: false },
    );
    await check(
      page,
      "table facet popover",
      async () => {
        await story(page, "data-table-default")
          .getByRole("button", { name: /^Status/ })
          .first()
          .click();
        await page.getByRole("dialog").waitFor();
      },
      { modal: false },
    );
    await check(
      page,
      "tooltip (disabled reason)",
      async () => {
        await story(page, "button-states")
          .locator("[aria-disabled=true]")
          .first()
          .focus();
        await page.getByRole("tooltip").waitFor();
      },
      { modal: false },
    );
    await check(
      page,
      "toasts",
      async () => {
        const s = story(page, "toasts");
        await s.getByRole("button", { name: "Success" }).click();
        await s.getByRole("button", { name: /^Error/ }).click();
        await page.getByText("Tier saved").waitFor();
      },
      { modal: false },
    );
    await violations(page);
    await story(page, "form-code-editor").scrollIntoViewIfNeeded();
    await story(page, "form-code-editor")
      .locator(".cm-editor")
      .first()
      .waitFor({ timeout: 15_000 });
    await story(page, "form-code-editor")
      .locator(".cm-content")
      .first()
      .click();
    await page.keyboard.type('{"a": 1}');
    await page.waitForTimeout(300);
    const v = await violations(page);
    report["code editor"] = { violations: v.length, locked: false };
    expect(v, "code editor: CSP violations").toEqual([]);
    await page.context().close();
  });

  it("the phone layout: a dialog becomes a bottom sheet and still locks", async () => {
    const page = await open("dark", { width: 390, height: 844 });
    await check(
      page,
      "dialog (phone)",
      async () => {
        await story(page, "dialog")
          .getByRole("button", { name: "Open md dialog" })
          .click();
        await page.getByRole("dialog", { name: "Edit holder" }).waitFor();
      },
      { modal: true },
    );
    await page.context().close();
  });

  afterAll(() => {
    console.log("kit overlay CSP report", JSON.stringify(report, null, 2));
  });
});

/**
 * Exit animations (notes/S-23 §6.1; MO-02): every Radix overlay keeps its `animate-pk-in` /
 * `animate-pk-overlay-in` class, and src/motion.css gives its `data-state="closed"` state an exit
 * on the motion tokens, which Radix waits for before it unmounts. This records each closing node's
 * `getAnimations()` the moment it flips to closed. Under reduced motion the swap is instant: no
 * animation, the node gone at once, and nothing left running.
 */
interface ExitRecord {
  kind: "content" | "scrim";
  animations: Array<{ name: string; duration: number }>;
  connectedAfter: boolean;
}

/** Start recording the overlays that close from now on. */
async function armExitProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __exits: Array<{ el: Element; kind: string; animations: unknown[] }>;
      __exitProbe?: MutationObserver;
    };
    w.__exitProbe?.disconnect();
    w.__exits = [];
    w.__exitProbe = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as Element;
        if (el.getAttribute("data-state") !== "closed") continue;
        if (!el.matches(".animate-pk-in, .animate-pk-overlay-in, .pk-drawer"))
          continue;
        w.__exits.push({
          el,
          kind: el.matches(".animate-pk-overlay-in") ? "scrim" : "content",
          animations: el.getAnimations().map((a) => ({
            name: (a as CSSAnimation).animationName,
            duration: Number(a.effect?.getTiming().duration ?? 0),
          })),
        });
      }
    });
    w.__exitProbe.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
  });
}

/** What closed since armExitProbe, and whether each node has been removed since. */
async function readExitProbe(page: Page): Promise<ExitRecord[]> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __exits: Array<{
        el: Element;
        kind: "content" | "scrim";
        animations: Array<{ name: string; duration: number }>;
      }>;
    };
    return w.__exits.map((x) => ({
      kind: x.kind,
      animations: x.animations,
      connectedAfter: x.el.isConnected,
    }));
  });
}

/**
 * Animations still running on the page, aside from the spinners (loading indicators that keep
 * turning) and the gallery's legacy `animate-pulse` skeletons (allowlisted until MO-09).
 */
const running = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document
      .getAnimations()
      .map((a) => (a as CSSAnimation).animationName ?? "")
      .filter((n) => !/spin/.test(n) && n !== "pulse"),
  );

/**
 * Closing an overlay returns focus to its trigger, which can open that trigger's own tooltip;
 * blur it and let that tooltip close before the next overlay, so each probe sees its own node.
 */
async function settleFocus(page: Page): Promise<void> {
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.waitForTimeout(400);
}

describe("overlay exit animations (MO-02)", () => {
  const overlays: Array<{
    name: string;
    open: (page: Page) => Promise<void>;
    content: { name: string; duration: number };
    scrim?: boolean;
  }> = [
    // First, on a fresh page: a tooltip opens on keyboard focus, and the overlays below return
    // focus to their triggers as they close, which Radix's tooltip then treats differently.
    {
      name: "tooltip",
      open: async (page) => {
        await story(page, "button-states")
          .locator("[aria-disabled=true]")
          .first()
          .focus();
        await page.getByRole("tooltip").waitFor();
      },
      content: { name: "pk-fade-out", duration: 120 },
    },
    {
      name: "dialog",
      open: async (page) => {
        await story(page, "dialog")
          .getByRole("button", { name: "Open md dialog" })
          .click();
        await page.getByRole("dialog", { name: "Edit holder" }).waitFor();
      },
      content: { name: "pk-exit", duration: 200 },
      scrim: true,
    },
    {
      name: "drawer",
      open: async (page) => {
        await story(page, "drawer")
          .getByRole("button", { name: "Open drawer from the end" })
          .click();
        await page.getByRole("dialog").waitFor();
      },
      // The drawer slides back to its edge (MO-08), not the dialog's fall.
      content: { name: "pk-drawer-out", duration: 200 },
    },
    {
      name: "action menu",
      open: async (page) => {
        await story(page, "action-menu")
          .getByRole("button", { name: "More actions" })
          .click();
        await page.getByRole("menu").waitFor();
      },
      content: { name: "pk-fade-out", duration: 120 },
    },
    {
      name: "select",
      open: async (page) => {
        await story(page, "form-select")
          .getByRole("combobox", { name: /Usage/ })
          .click();
        await page.getByRole("listbox").waitFor();
      },
      content: { name: "pk-fade-out", duration: 120 },
    },
    {
      name: "popover",
      open: async (page) => {
        await story(page, "source-badges").getByRole("button").first().click();
        await page.getByRole("dialog").waitFor();
      },
      content: { name: "pk-fade-out", duration: 120 },
    },
  ];

  it("each overlay animates out on the tokens, then unmounts", async () => {
    const page = await open("dark", undefined, undefined, "no-preference");
    for (const o of overlays) {
      await settleFocus(page);
      await o.open(page);
      await page.waitForTimeout(400);
      await armExitProbe(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      const exits = await readExitProbe(page);
      const content = exits.find((x) => x.kind === "content");
      expect(content, `${o.name}: a closing node was seen`).toBeTruthy();
      expect(content!.animations, `${o.name}: exit animation`).toEqual([
        o.content,
      ]);
      expect(content!.connectedAfter, `${o.name}: unmounted after`).toBe(false);
      if (o.scrim) {
        const scrim = exits.find((x) => x.kind === "scrim");
        expect(scrim?.animations, `${o.name}: scrim exit`).toEqual([
          { name: "pk-fade-out", duration: 200 },
        ]);
      }
      expect(await running(page), `${o.name}: nothing left running`).toEqual(
        [],
      );
    }
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("under reduced motion each overlay closes instantly with no animation", async () => {
    const page = await open("dark", undefined, undefined, "reduce");
    for (const o of overlays) {
      await settleFocus(page);
      await o.open(page);
      await page.waitForTimeout(100);
      expect(await running(page), `${o.name}: no enter animation`).toEqual([]);
      await armExitProbe(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
      const exits = await readExitProbe(page);
      for (const x of exits) {
        expect(x.animations, `${o.name}: no exit animation`).toEqual([]);
        expect(x.connectedAfter, `${o.name}: gone at once`).toBe(false);
      }
      expect(await running(page), `${o.name}: nothing running`).toEqual([]);
    }
    await page.context().close();
  });

  it("the refetch bar's sweep is defined, and stops under reduced motion", async () => {
    for (const motion of ["no-preference", "reduce"] as const) {
      const page = await open("dark", undefined, undefined, motion);
      const names = await page.evaluate(() => {
        const bar = document.createElement("div");
        bar.className = "animate-pk-refetch";
        document.body.append(bar);
        const n = bar
          .getAnimations()
          .map((a) => (a as CSSAnimation).animationName);
        bar.remove();
        return n;
      });
      expect(names, motion).toEqual(motion === "reduce" ? [] : ["pk-refetch"]);
      await page.context().close();
    }
  });
});

/**
 * MO-08 (notes/S-23 §6.1 enter and press, §4.2): the drawer slides in from its own edge; buttons,
 * icon buttons, switches and radio cards press (0.98 on :active, never when disabled); a filled
 * button's hover eases its background instead of snapping a filter; the copy swap pops. Under
 * reduced motion each is an instant swap: no scale, no transition, nothing left running.
 */
describe("controls and the drawer (MO-08)", () => {
  /** The animations on the open drawer panel, right after it mounts. */
  async function drawerEnter(
    page: Page,
    side: "end" | "start",
  ): Promise<{
    animations: Array<{ name: string; duration: number }>;
    from: string;
  }> {
    await story(page, "drawer")
      .getByRole("button", { name: `Open drawer from the ${side}` })
      .click();
    const panel = page.getByRole("dialog");
    await panel.waitFor();
    const out = await panel.evaluate((el) => ({
      animations: el.getAnimations().map((a) => ({
        name: (a as CSSAnimation).animationName,
        duration: Number(a.effect?.getTiming().duration ?? 0),
      })),
      from: getComputedStyle(el).getPropertyValue("--pk-drawer-from").trim(),
    }));
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await settleFocus(page);
    return out;
  }

  /** The press: the element's transform while the pointer is held down on it. */
  async function pressed(page: Page, target: Locator): Promise<string> {
    await target.scrollIntoViewIfNeeded();
    await target.hover();
    await page.mouse.down();
    await page.waitForTimeout(200);
    const transform = await target.evaluate(
      (el) => getComputedStyle(el).transform,
    );
    await page.mouse.up();
    await page.waitForTimeout(300);
    return transform;
  }

  const SCALED = "matrix(0.98, 0, 0, 0.98, 0, 0)";

  it("the drawer slides in from its edge on the tokens", async () => {
    const page = await open("dark", undefined, undefined, "no-preference");
    const end = await drawerEnter(page, "end");
    expect(end.animations).toEqual([{ name: "pk-drawer-in", duration: 320 }]);
    expect(end.from).toBe("");
    const start = await drawerEnter(page, "start");
    expect(start.animations).toEqual([{ name: "pk-drawer-in", duration: 320 }]);
    expect(start.from).toBe("-100%");
    expect(await running(page)).toEqual([]);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("buttons, icon buttons, switches and radio cards press; disabled ones do not", async () => {
    const page = await open("dark", undefined, undefined, "no-preference");
    const variants = story(page, "button-variants");
    for (const name of ["Primary", "Outline", "Ghost", "Delete product…"])
      expect(
        await pressed(page, variants.getByRole("button", { name })),
        name,
      ).toBe(SCALED);
    expect(
      await pressed(
        page,
        story(page, "icon-button").getByRole("button").first(),
      ),
      "icon button",
    ).toBe(SCALED);
    const choices = story(page, "form-choices");
    expect(
      await pressed(page, choices.getByRole("switch").first()),
      "switch",
    ).toBe(SCALED);
    expect(
      await pressed(page, choices.getByRole("radio", { name: /^Public/ })),
      "radio card",
    ).toBe(SCALED);
    const states = story(page, "button-states");
    expect(
      await pressed(
        page,
        states.getByRole("button", { name: "Plain disabled" }),
      ),
      "disabled",
    ).toBe("none");
    expect(
      await pressed(page, states.getByRole("button", { name: /^Saving/ })),
      "busy",
    ).toBe("none");
    expect(
      await pressed(page, states.getByRole("button", { name: "Retire" })),
      "disabled with a reason",
    ).toBe("none");
    await settleFocus(page);
    expect(await running(page)).toEqual([]);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("a primary button's hover eases its background (no filter), and the copy swap pops", async () => {
    const page = await open("dark", undefined, undefined, "no-preference");
    const primary = story(page, "button-variants").getByRole("button", {
      name: "Primary",
    });
    // Record what starts, rather than sampling: a `micro` transition can end before a sample.
    await page.evaluate(() => {
      const w = window as unknown as { __started: string[] };
      w.__started = [];
      document.addEventListener("transitionrun", (e) =>
        w.__started.push(`transition:${e.propertyName}`),
      );
      document.addEventListener("animationstart", (e) =>
        w.__started.push(
          `animation:${e.animationName}:${(e.target as Element).textContent}`,
        ),
      );
    });
    const started = (): Promise<string[]> =>
      page.evaluate(() =>
        (window as unknown as { __started: string[] }).__started.splice(0),
      );
    const before = await primary.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await started();
    await primary.hover();
    await page.waitForTimeout(300);
    expect(await started()).toContain("transition:background-color");
    expect(await primary.evaluate((el) => getComputedStyle(el).filter)).toBe(
      "none",
    );
    expect(
      await primary.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).not.toBe(before);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);

    const copy = story(page, "copy-button").getByRole("button", {
      name: "Copy JWKS URL",
    });
    await started();
    await copy.click();
    await copy.getByText("Copied").waitFor();
    await page.waitForTimeout(500);
    expect(await started()).toContain("animation:pk-pop-in:Copied");
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });

  it("under reduced motion every one of them is an instant swap", async () => {
    const page = await open("dark", undefined, undefined, "reduce");
    const end = await drawerEnter(page, "end");
    expect(end.animations).toEqual([]);
    const primary = story(page, "button-variants").getByRole("button", {
      name: "Primary",
    });
    expect(await pressed(page, primary)).toBe("none");
    await primary.hover();
    expect(await running(page), "hover").toEqual([]);
    const choices = story(page, "form-choices");
    const sw = choices.getByRole("switch").first();
    expect(await pressed(page, sw)).toBe("none");
    expect(await running(page), "switch pressed").toEqual([]);
    await choices.getByRole("radio", { name: /^Authenticated/ }).click();
    expect(await running(page), "radio card chosen").toEqual([]);
    const copy = story(page, "copy-button").getByRole("button", {
      name: "Copy JWKS URL",
    });
    await copy.click();
    await copy.getByText("Copied").waitFor();
    expect(await running(page), "copied").toEqual([]);
    expect(
      await page.evaluate(() =>
        document.documentElement.hasAttribute("data-vt"),
      ),
      "no View Transition started",
    ).toBe(false);
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  });
});
