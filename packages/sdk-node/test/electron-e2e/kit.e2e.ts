// The desktop React kit in a real Electron runtime (UK-06.12).
// Not typechecked by the package (tsconfig excludes this folder: it needs the DOM lib and
// Electron's types, which only the sample installs); vitest runs it.
//
// Launches the built sample (examples/ui/electron, Tidewater Studio on its fixtures) with
// Playwright's `_electron.launch`, and drives it from the main process:
//
//   chrome   PKEY_KIT_PLATFORM=windows|macos|linux forces the kit's chrome (the sample passes it
//            to the renderer as ?platform=); the unforced run proves `platform: "auto"` follows
//            the OS the bridge reports.
//   size     BrowserWindow.setSize, to the plan's window rows (the viewport is checked, not
//            assumed); zoom is webContents.setZoomFactor(2).
//   scheme   nativeTheme.themeSource.
//   state    TIDEWATER_STATE pins the gate; the menu items open Settings and the update prompt.
//
// Setup, once (the sample stays outside the pnpm workspace; see sample.mjs):
//   pnpm build && pnpm --filter @polaris-key/node test:electron:setup
// Run (never part of `pnpm test`):
//   pnpm --filter @polaris-key/node test:electron
//   PKEY_KIT_SHOTS=<dir> ...   also writes <dir>/<scene>/<chrome>-1440-<scheme>.png
//   PKEY_E2E_CHROMES=windows   limit the layout matrix (comma list)
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE, sampleProblem } from "./sample.mjs";

const problem = sampleProblem();
if (problem) throw new Error(`Electron e2e: ${problem}`);

const electronPath: string = createRequire(`${SAMPLE}package.json`)("electron");
const SHOTS = process.env.PKEY_KIT_SHOTS;
const CHROMES = (process.env.PKEY_E2E_CHROMES ?? "windows,macos,linux")
  .split(",")
  .filter(Boolean) as ("windows" | "macos" | "linux")[];
/** The kit's `data-pk-platform` per forced chrome (UK-06 U4: linux is gnome in the CSS). */
const VARIANT = { windows: "windows", macos: "macos", linux: "gnome" } as const;
const SCHEMES = ["dark", "light"] as const;
type Scheme = (typeof SCHEMES)[number];

const userData = mkdtempSync(join(tmpdir(), "pk-electron-e2e-"));
const running = new Set<ElectronApplication>();
afterAll(async () => {
  for (const app of [...running]) await close(app);
  rmSync(userData, { recursive: true, force: true });
});

async function close(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  try {
    await Promise.race([
      app.close(),
      new Promise((_, no) => setTimeout(() => no(new Error("close")), 10_000)),
    ]);
  } catch {
    proc.kill("SIGKILL");
  }
  running.delete(app);
}

interface Launched {
  app: ElectronApplication;
  page: Page;
}

let launches = 0;
async function launch(env: {
  state?: string;
  chrome?: string;
}): Promise<Launched> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") childEnv[k] = v;
  delete childEnv.PKEY_KIT_PLATFORM;
  delete childEnv.TIDEWATER_STATE;
  if (env.state) childEnv.TIDEWATER_STATE = env.state;
  if (env.chrome) childEnv.PKEY_KIT_PLATFORM = env.chrome;
  const app = await electron.launch({
    executablePath: electronPath,
    args: [
      SAMPLE,
      `--user-data-dir=${join(userData, String(launches++))}`,
      // A Linux CI container has no setuid sandbox helper.
      ...(process.platform === "linux" && process.env.CI
        ? ["--no-sandbox"]
        : []),
    ],
    env: childEnv,
    timeout: 60_000,
  });
  running.add(app);
  const page = await app.firstWindow();
  await page.waitForSelector(".pk-root, .studio", { timeout: 30_000 });
  return { app, page };
}

/** A menu item's click, by the id the bridge gives it. */
const clickMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);

/** Replace the main process's `shell.openExternal` with a recorder: no test opens a real
 *  browser. `openedLinks` reads (and clears) what it was asked to open. */
const stubShell = (app: ElectronApplication) =>
  app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened?: string[] };
    g.__opened = [];
    shell.openExternal = async (url: string) => {
      g.__opened!.push(url);
    };
  });
const openedLinks = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as { __opened?: string[] };
    const out = g.__opened ?? [];
    g.__opened = [];
    return out;
  });

/** A launch of the sample for a describe block, with the shell stubbed. */
function launchedWithShell(state: string): () => Launched {
  let l: Launched;
  beforeAll(async () => {
    l = await launch({ state });
    await stubShell(l.app);
  });
  afterAll(async () => {
    if (l) await close(l.app);
  });
  return () => l;
}

const MANAGE = "polaris-key.manageLicense";
const CHECK = "polaris-key.checkForUpdates";

/** The component the kit is showing (`data-component` of its roots). */
const components = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".pk-root")].map((r) =>
      r.getAttribute("data-component"),
    ),
  );

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );

// ---------------------------------------------------------------------------------------------
// The boards: seven screens, each reached the way a person reaches it.

interface Scene {
  id: string;
  state: string;
  /** Drive the window from the gate to the screen. */
  reach(l: Launched): Promise<void>;
  /** The `data-component` that proves it is showing. */
  component: string;
  /** Text the screen must show. */
  text: RegExp;
}

const SCENES: Scene[] = [
  {
    id: "welcome",
    state: "needs-activation",
    reach: async () => undefined,
    component: "PolarisKeyGate",
    text: /Welcome to Tidewater Studio/,
  },
  {
    id: "activate",
    state: "needs-activation",
    reach: async ({ page }) => {
      await page.getByRole("button", { name: "Use a license key" }).click();
    },
    component: "PolarisKeyGate",
    text: /Enter your license key/,
  },
  {
    id: "device-limit",
    state: "needs-activation",
    reach: async ({ page }) => {
      await page.getByRole("button", { name: "Use a license key" }).click();
      await page
        .getByRole("textbox")
        .fill("pkey_tidewater_AAAAAAAAAAAAAAAAAAAAAA");
      await page.keyboard.press("Enter");
    },
    component: "PolarisKeyGate",
    text: /Device limit reached/,
  },
  {
    id: "expired",
    state: "expired",
    reach: async () => undefined,
    component: "PolarisKeyGate",
    text: /License expired/,
  },
  {
    id: "grace",
    state: "grace",
    reach: async () => undefined,
    component: "PolarisKeyGate",
    text: /Offline grace/,
  },
  {
    id: "version-too-old",
    state: "version-too-old",
    reach: async () => undefined,
    component: "PolarisKeyGate",
    text: /Update required/,
  },
  {
    id: "version-too-new",
    state: "version-too-new",
    reach: async () => undefined,
    component: "PolarisKeyGate",
    text: /Not available on this license/,
  },
  {
    id: "channel-not-entitled",
    state: "channel-not-entitled",
    reach: async () => undefined,
    component: "PolarisKeyGate",
    text: /Channel not included/,
  },
  {
    id: "settings",
    state: "ok",
    reach: async ({ app }) => clickMenu(app, MANAGE),
    component: "Settings",
    text: /Sample rate/,
  },
  {
    id: "update",
    state: "ok",
    reach: async ({ app }) => clickMenu(app, CHECK),
    component: "UpdatePrompt",
    text: /What's new/,
  },
];

// ---------------------------------------------------------------------------------------------
// Window size, zoom, scheme.

interface Size {
  label: string;
  width: number;
  height: number;
  zoom: number;
}

/** The plan's window rows, then 200 % zoom of three of them. */
const SIZES: Size[] = (
  [
    [390, 844],
    [844, 390],
    [640, 360],
    [820, 1180],
    [1180, 820],
    [1440, 900],
    [1920, 1080],
  ] as const
).map(([width, height]) => ({
  label: `${width}x${height}`,
  width,
  height,
  zoom: 1,
}));
// The default window and the short one: a sheet's Done must stay in view in both.
for (const [width, height] of [
  [900, 600],
  [760, 420],
] as const)
  SIZES.push({ label: `${width}x${height}`, width, height, zoom: 1 });
for (const [width, height] of [
  [390, 844],
  [844, 390],
  [1440, 900],
] as const)
  SIZES.push({ label: `${width}x${height}@200`, width, height, zoom: 2 });

/** Resize through `BrowserWindow.setSize` so the web viewport is `width x height` CSS pixels at
 *  zoom 1 (the frame the OS adds is measured and added), then zoom. A display too small for the
 *  size (the OS clamps a window to the screen) gets the same viewport from device emulation: the
 *  layout under test is the same, only the window is smaller. Returns whether it was emulated. */
async function resize(
  { app, page }: Launched,
  size: Size,
): Promise<{ emulated: boolean }> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.webContents.disableDeviceEmulation();
    win.setMinimumSize(0, 0);
    win.webContents.setZoomFactor(1);
    const [ow, oh] = win.getSize();
    const [cw, ch] = win.getContentSize();
    win.setSize(s.width + ow! - cw!, s.height + oh! - ch!);
    win.webContents.setZoomFactor(s.zoom);
  }, size);
  const want = {
    w: Math.round(size.width / size.zoom),
    h: Math.round(size.height / size.zoom),
  };
  const reached = async (tries: number) => {
    for (let i = 0; i < tries; i++) {
      const got = await page.evaluate(() => ({
        w: innerWidth,
        h: innerHeight,
      }));
      if (Math.abs(got.w - want.w) <= 1 && Math.abs(got.h - want.h) <= 1)
        return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  if (!(await reached(15))) {
    await app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0]!.webContents.enableDeviceEmulation({
        screenPosition: "desktop",
        screenSize: { width: s.width, height: s.height },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0,
        viewSize: { width: s.width, height: s.height },
        scale: 1,
      });
    }, size);
    if (!(await reached(30)))
      throw new Error(`the window did not reach ${size.label}`);
    await frames(page);
    return { emulated: true };
  }
  await frames(page);
  return { emulated: false };
}

async function setScheme(
  { app, page }: Launched,
  scheme: Scheme,
): Promise<void> {
  await app.evaluate(({ nativeTheme }, s) => {
    nativeTheme.themeSource = s;
  }, scheme);
  // Playwright pins a page to its default "light" emulation until told to follow the window.
  await page.emulateMedia({ colorScheme: null });
  // The renderer's prefers-color-scheme follows, then the kit's data-theme.
  await page.waitForFunction(
    (s) =>
      matchMedia("(prefers-color-scheme: dark)").matches === (s === "dark") &&
      [...document.querySelectorAll(".pk-root")].every(
        (r) => r.getAttribute("data-theme") === s,
      ),
    scheme,
    { timeout: 10_000 },
  );
  await frames(page);
}

/** Wait until the kit shows `component` (an element can be "hidden" to Playwright while it fills
 *  the window, so this reads the DOM). */
const showing = (page: Page, component: string, timeout = 20_000) =>
  page.waitForFunction(
    (c) => document.querySelector(`.pk-root[data-component="${c}"]`) !== null,
    component,
    { timeout },
  );

// ---------------------------------------------------------------------------------------------
// The layout rules of the browser lane (chrome.sizes.browser.test.tsx), measured in the page.

interface LayoutFacts {
  platform: string | null;
  theme: string | null;
  sideways: string | null;
  primary: string | null;
  /** A sheet's Done button outside the window. */
  done: string | null;
  small: string[];
  titleBar: string[];
}

function measure(opts: { zoomed: boolean }): LayoutFacts {
  const visible = (el: Element): DOMRect | null => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const cs = getComputedStyle(el);
    return cs.visibility === "hidden" || cs.display === "none" ? null : r;
  };
  const name = (el: Element) =>
    `<${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""}> "${(el.textContent ?? "").trim().slice(0, 24)}"`;
  const roots = [...document.querySelectorAll(".pk-root")];
  const kit = roots[roots.length - 1];

  // No sideways scroll. Below the 320 px reflow floor (a phone at 200 %) a page may scroll.
  const doc = document.documentElement;
  const sideways =
    doc.clientWidth >= 320 && doc.scrollWidth > doc.clientWidth + 1
      ? `the page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`
      : null;

  // The primary action is in the first viewport (200 % reflows and scrolls to it: tight layout).
  let primary: string | null = null;
  if (!opts.zoomed && kit) {
    const btn = [
      ...kit.querySelectorAll<HTMLElement>('.btn[data-variant="primary"]'),
    ].find(visible);
    if (btn) {
      const r = btn.getBoundingClientRect();
      if (
        r.top < -0.5 ||
        r.bottom > innerHeight + 0.5 ||
        r.left < -0.5 ||
        r.right > innerWidth + 0.5
      )
        primary = `${name(btn)} at ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)} in ${innerWidth}x${innerHeight}`;
    }
  }

  // A sheet's Done (Settings) is in the window: the sheet is capped and scrolls its body.
  let done: string | null = null;
  const doneBtn = document.querySelector<HTMLElement>(
    'dialog [data-key="common.done"]',
  );
  if (doneBtn && !opts.zoomed) {
    const r = doneBtn.getBoundingClientRect();
    if (r.top < -0.5 || r.bottom > innerHeight + 0.5)
      done = `Done at ${Math.round(r.top)}..${Math.round(r.bottom)} in ${innerHeight}`;
  }

  // Targets of 24 px under a fine pointer.
  const small: string[] = [];
  for (const el of document.querySelectorAll(
    ".pk-root .btn, .pk-root input, .pk-root [role=radio], .pk-root a[href]",
  )) {
    const r = visible(el);
    if (r && (r.width < 24 || r.height < 24))
      small.push(
        `${name(el)} is ${Math.round(r.width)}x${Math.round(r.height)}`,
      );
  }

  // Nothing is drawn as a title bar: no drag region, no banner, no title-bar element.
  const titleBar: string[] = [];
  for (const el of document.querySelectorAll("*"))
    if (getComputedStyle(el).getPropertyValue("-webkit-app-region") === "drag")
      titleBar.push(`${name(el)} is a drag region`);
  for (const el of document.querySelectorAll(
    '[role=banner], [class*="titlebar" i], [class*="title-bar" i], [data-part="titlebar"]',
  ))
    titleBar.push(`${name(el)} looks like a title bar`);

  return {
    platform: kit?.getAttribute("data-pk-platform") ?? null,
    theme: kit?.getAttribute("data-theme") ?? null,
    sideways,
    primary,
    done,
    small,
    titleBar,
  };
}

/** Layout findings the kit still has, pinned so the suite stays honest in both directions: the
 *  check must still fail here (it turns red the day the kit is fixed: drop the row). */
const KNOWN_PRIMARY_BELOW_FOLD: Record<string, string> = {};

// ---------------------------------------------------------------------------------------------
// The layout matrix: chrome x scene (one launch each) x scheme x size.

for (const chrome of CHROMES)
  describe(`layout, forced ${chrome} chrome`, () => {
    for (const scene of SCENES)
      describe(scene.id, () => {
        let l: Launched;
        beforeAll(async () => {
          l = await launch({ state: scene.state, chrome });
          await scene.reach(l);
          await l.page.waitForFunction(
            ([component, text]) =>
              [...document.querySelectorAll(".pk-root")].some(
                (r) =>
                  r.getAttribute("data-component") === component &&
                  new RegExp(text!).test((r as HTMLElement).innerText),
              ),
            [scene.component, scene.text.source],
            { timeout: 20_000 },
          );
        });
        afterAll(async () => {
          if (l) await close(l.app);
        });

        for (const scheme of SCHEMES)
          for (const size of SIZES)
            it(`${size.label} ${scheme}`, async () => {
              await setScheme(l, scheme);
              await resize(l, size);
              const facts = await l.page.evaluate(measure, {
                zoomed: size.zoom > 1,
              });
              expect(facts.platform, "data-pk-platform").toBe(VARIANT[chrome]);
              expect(facts.theme, "data-theme").toBe(scheme);
              expect(facts.sideways, "sideways scroll").toBeNull();
              const known =
                KNOWN_PRIMARY_BELOW_FOLD[`${chrome} ${scene.id} ${size.label}`];
              if (known) expect(facts.primary, known).not.toBeNull();
              else
                expect(
                  facts.primary,
                  "primary action in the first viewport",
                ).toBeNull();
              expect(facts.done, "a sheet's Done in the window").toBeNull();
              expect(facts.small.join("\n"), "targets under 24 px").toBe("");
              expect(facts.titleBar.join("\n"), "a drawn title bar").toBe("");
              // A resize must not change the screen.
              expect(await components(l.page)).toContain(scene.component);
              if (SHOTS && size.label === "1440x900") {
                const file = join(
                  SHOTS,
                  scene.id,
                  `${chrome}-1440-${scheme}.png`,
                );
                mkdirSync(dirname(file), { recursive: true });
                await l.page.screenshot({ path: file });
              }
            });
      });
  });

// ---------------------------------------------------------------------------------------------
// Wiring.

type Bridge = {
  version: number;
  getSyncState(): Promise<{ host?: { os: string } }>;
  invoke(service: string, method: string, args?: unknown): Promise<any>;
  onUpdateProgress(
    cb: (p: { done: number; total?: number | null }) => void,
  ): () => void;
};

describe("sign in and links out, wired", () => {
  const launched = launchedWithShell("needs-activation");

  it("Sign In shows TDWR-4821, Open Browser opens the page, and the app opens once approved", async () => {
    const l = launched();
    await l.page.getByRole("button", { name: "Sign In" }).click();
    await l.page.waitForFunction(
      () => /TDWR-4821/.test(document.body.innerText),
      undefined,
      { timeout: 10_000 },
    );
    await l.page.getByRole("button", { name: /Open browser/i }).click();
    expect(await openedLinks(l.app)).toEqual([
      "https://polaris.locker/device?user_code=TDWR-4821",
    ]);
    // The fixture approves about four seconds in; the gate then shows the app.
    await l.page.waitForSelector(".studio", { timeout: 20_000 });
    expect(
      await l.page.evaluate(
        () => document.querySelector(".studio")?.textContent,
      ),
    ).toMatch(/Welcome back/);
  });
});

describe("replace a device leaves the app, wired", () => {
  const launched = launchedWithShell("needs-activation");

  it("Replace a device opens the manage page in the system browser", async () => {
    const l = launched();
    await l.page.getByRole("button", { name: "Use a license key" }).click();
    await l.page
      .getByRole("textbox")
      .fill("pkey_tidewater_AAAAAAAAAAAAAAAAAAAAAA");
    await l.page.keyboard.press("Enter");
    await l.page.waitForFunction(
      () => /Device limit reached/.test(document.body.innerText),
      undefined,
      { timeout: 20_000 },
    );
    await l.page.getByRole("button", { name: /Replace a device/i }).click();
    const opened = await openedLinks(l.app);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(
      /^https:\/\/polaris\.locker\/activate\?product=tidewater/,
    );
  });
});

describe("the bridge and the shell, wired", () => {
  let l: Launched;
  beforeAll(async () => {
    // No forced chrome: `platform: "auto"` follows the OS the bridge reports.
    l = await launch({ state: "ok" });
  });
  afterAll(async () => {
    if (l) await close(l.app);
  });

  it("platform auto follows host.os from the bridge", async () => {
    const os =
      ({ darwin: "macos", win32: "windows" } as Record<string, string>)[
        process.platform
      ] ?? "linux";
    const host = await l.page.evaluate(async () => {
      const b = (window as unknown as { polarisKey: Bridge }).polarisKey;
      return (await b.getSyncState()).host?.os;
    });
    expect(host).toBe(os);
    // A gate screen draws the chrome `auto` picked.
    const gate = await launch({ state: "needs-activation" });
    try {
      await showing(gate.page, "PolarisKeyGate");
      const variant = await gate.page.evaluate(() =>
        document.querySelector(".pk-root")?.getAttribute("data-pk-platform"),
      );
      expect(variant).toBe(os === "linux" ? "gnome" : os);
    } finally {
      await close(gate.app);
    }
  });

  it("the preload exposes only window.polarisKey", async () => {
    const page = await l.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        keys: Object.keys(w.polarisKey as object).sort(),
        version: (w.polarisKey as { version: unknown }).version,
        leaks: [
          "require",
          "process",
          "electron",
          "ipcRenderer",
          "Buffer",
        ].filter((n) => typeof w[n] !== "undefined"),
        own: Object.getOwnPropertyNames(window),
      };
    });
    expect(page.version).toBe(4);
    expect(page.leaks, "node or electron globals in the page").toEqual([]);
    // The same page in a sandboxed window with no preload: what the page has extra is the preload's.
    const bare: string[] = await l.app.evaluate(
      async ({ BrowserWindow }, url) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: { contextIsolation: true, sandbox: true },
        });
        await win.loadURL(url);
        await new Promise((r) => setTimeout(r, 1000));
        const names: string[] = await win.webContents.executeJavaScript(
          "Object.getOwnPropertyNames(window)",
        );
        win.destroy();
        return names;
      },
      l.page.url(),
    );
    const extra = page.own.filter((n) => !bare.includes(n));
    expect(extra).toEqual(["polarisKey"]);
    expect(page.keys).toEqual(
      expect.arrayContaining([
        "getSyncState",
        "invoke",
        "onOpen",
        "onUpdateProgress",
        "openExternal",
        "submitKey",
        "version",
      ]),
    );
  });

  it("an iframe gets no bridge", async () => {
    const result = await l.page.evaluate(
      () =>
        new Promise<{ bridge: string; node: string }>((resolve) => {
          const f = document.createElement("iframe");
          f.src = `${location.protocol}//${location.host}/index.html`;
          f.onload = () => {
            const w = f.contentWindow as unknown as Record<string, unknown>;
            let bridge = "";
            let node = "";
            try {
              bridge = typeof w.polarisKey;
              node = typeof w.require;
            } catch (e) {
              bridge = "blocked";
              node = String(e);
            }
            f.remove();
            resolve({ bridge, node });
          };
          f.onerror = () => resolve({ bridge: "error", node: "" });
          document.body.append(f);
        }),
    );
    expect(["undefined", "blocked", "error"]).toContain(result.bridge);
    expect(result.node).not.toBe("function");
  });

  it("a popup is refused, and an https one leaves for the system browser", async () => {
    const windows = () =>
      l.app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
    await stubShell(l.app);
    const before = await windows();
    await l.page.evaluate(() => {
      window.open("https://example.com/", "_blank");
      window.open("http://example.com/", "_blank");
      window.open("javascript:alert(1)", "_blank");
    });
    await l.page.waitForTimeout(500);
    expect(await windows()).toBe(before);
    // Only the https one reached the shell.
    expect(await openedLinks(l.app)).toEqual(["https://example.com/"]);
  });

  it("the bridge's openExternal opens https only", async () => {
    await stubShell(l.app);
    const out = await l.page.evaluate(async () => {
      const b = (
        window as unknown as {
          polarisKey: { openExternal(u: string): Promise<boolean> };
        }
      ).polarisKey;
      const refused: string[] = [];
      for (const u of ["http://polaris.locker/", "javascript:alert(1)", "x"])
        await b.openExternal(u).catch(() => {
          refused.push(u);
        });
      return { ok: await b.openExternal("https://polaris.locker/a"), refused };
    });
    expect(out).toEqual({
      ok: true,
      refused: ["http://polaris.locker/", "javascript:alert(1)", "x"],
    });
    expect(await openedLinks(l.app)).toEqual(["https://polaris.locker/a"]);
  });

  it("the menu items exist, with their labels, where the OS puts them", async () => {
    const items = await l.app.evaluate(
      ({ Menu }, ids) => {
        const menu = Menu.getApplicationMenu()!;
        return ids.map((id) => {
          const item = menu.getMenuItemById(id);
          let parent: string | null = null;
          for (const top of menu.items)
            if (top.submenu?.items.some((i) => i.id === id)) parent = top.label;
          return item ? { id, label: item.label, parent } : null;
        });
      },
      [CHECK, MANAGE],
    );
    expect(items[0]?.label).toMatch(/^Check for [Uu]pdates/);
    expect(items[1]?.label).toMatch(/^Manage [Ll]icen[sc]e/);
    const appName = await l.app.evaluate(({ app }) => app.name);
    const home = process.platform === "darwin" ? appName : "Help";
    expect(items.map((i) => i?.parent)).toEqual([home, home]);
  });

  it('open("settings") shows Settings, and the update item the update prompt', async () => {
    await clickMenu(l.app, MANAGE);
    await showing(l.page, "Settings");
    await l.page.waitForFunction(
      () =>
        /Sample rate/.test(
          document.querySelector<HTMLElement>(
            '.pk-root[data-component="Settings"]',
          )?.innerText ?? "",
        ),
      undefined,
      { timeout: 10_000 },
    );
    await clickMenu(l.app, CHECK);
    await showing(l.page, "UpdatePrompt");
  });

  it("update progress carries real bytes over the bridge", async () => {
    const seen = await l.page.evaluate(async () => {
      const b = (window as unknown as { polarisKey: Bridge }).polarisKey;
      const events: { done: number; total: number | null }[] = [];
      const off = b.onUpdateProgress((p) =>
        events.push({ done: p.done, total: p.total ?? null }),
      );
      const check = await b.invoke("update", "decide", {});
      const outcome = await b.invoke("update", "install", {
        decision: check.decision,
      });
      off();
      return { events, kind: outcome.kind as string };
    });
    expect(seen.kind).toBe("restartRequired");
    expect(seen.events.length).toBeGreaterThan(2);
    const dones = seen.events.map((e) => e.done);
    expect([...dones].sort((a, b) => a - b)).toEqual(dones);
    expect(seen.events.every((e) => e.total === 61_000_000)).toBe(true);
    expect(dones.at(-1)).toBe(61_000_000);
    expect(dones[0]).toBeGreaterThan(0);
  });

  it("the update prompt installs in the app and shows progress in MB", async () => {
    await clickMenu(l.app, CHECK);
    await showing(l.page, "UpdatePrompt");
    await l.page
      .getByRole("button", { name: /^(Install|Update now)/ })
      .first()
      .click();
    await l.page.waitForFunction(
      () => /\d+(\.\d+)?\s?MB/.test(document.body.innerText),
      undefined,
      { timeout: 10_000 },
    );
  });

  // Last: Playwright keeps waiting for the navigation the window refused.
  it("a navigation away from the app is refused", async () => {
    const before = l.page.url();
    await l.page.evaluate(() => {
      location.href = "https://example.com/";
    });
    await l.page.waitForTimeout(800);
    expect(l.page.url()).toBe(before);
    expect(await l.page.evaluate(() => typeof (window as any).polarisKey)).toBe(
      "object",
    );
  });
});
