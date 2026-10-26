import { existsSync, mkdirSync } from "node:fs";
import { closeContext } from "./teardown.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";
import { axe } from "./portalHarness.js";

/**
 * A-32.12: the Publish from CI drawer in real Chromium under the Worker's CSP, both themes. Opened
 * from the first-release panel and from Keys; step 1 (the setup pull request, and the one-command
 * fallback when GitHub refuses), step 2 and Done; the phone width, 320 px and 200 % text.
 *
 * Set `PK_SHOTS_DIR` to also save a screenshot of each there.
 */

const here = fileURLToPath(new URL("..", import.meta.url));
const CSP = appSecurityHeaders().get("content-security-policy")!;
const SHOTS = process.env.PK_SHOTS_DIR;
const NOW = Math.floor(Date.now() / 1000);
const API = "/manage/api/products/djdl";

const checks = (ready: boolean) => [
  noApp ? { id: "app", state: "missing" } : { id: "app", state: "ok" },
  { id: "release-manifest", state: ready ? "ok" : "missing" },
  { id: "workflow", state: ready ? "ok" : "missing" },
  { id: "environment", state: "ok" },
  { id: "ruleset", state: "ok" },
  { id: "publisher", state: "ok", detail: ".github/workflows/release.yml" },
];

let ready = false;
let released = false;
let refuse = false;
/** `.pkey/release` already declares releaseKeys: the pull request can stand alone. */
let keyed = true;
let noApp = false;
let noPublisher = false;

const routes = (): Record<string, unknown> => ({
  ...CORE_ROUTES,
  "/manage/api/me": {
    ...(CORE_ROUTES["/manage/api/me"] as Record<string, unknown>),
    authAt: NOW,
  },
  [`${API}/release/releases`]: {
    releases: released
      ? [
          {
            releaseId: "app@0.1.0",
            version: "0.1.0",
            title: null,
            publishedAt: NOW * 1000,
            sourceUrl: null,
            status: "published",
            artifacts: [],
            deliverable: "app",
            seq: 1,
            channel: "stable",
            yank: null,
            builds: [],
            signer: { kind: "release", kid: "rk_2026", recordSha256: "ab" },
          },
        ]
      : [],
    channels: [],
    floors: [],
  },
  ...(noPublisher
    ? { [`${API}/ci-publisher`]: { ok: true, policy: null } }
    : {}),
  [`${API}/release/ci-readiness`]: {
    repository: "vladzaharia/djdl",
    capabilities: {
      pullRequest: true,
      workflow: true,
      environment: true,
      ruleset: true,
    },
    environmentName: "release",
    checks: checks(ready),
    workflowPreview: "name: release\non:\n  push:\n    tags: ['v*']\n",
    releaseKeys: keyed,
    links: {
      install: "https://github.com/apps/polaris-key/installations/new",
      installation: "https://github.com/settings/installations/42",
    },
  },
  [`${API}/release/setup/pull-request`]: {
    repository: "vladzaharia/djdl",
    capabilities: {},
    state: "none",
    pullRequest: null,
  },
});

let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  if (!existsSync(`${here}dist/manage.html`))
    throw new Error(
      "Build the console first: pnpm --filter @polaris-key/admin build",
    );
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  server = await preview({
    root: here,
    configFile: `${here}vite.config.ts`,
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
  width: number,
  hash = "release/releases",
  zoom = false,
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width, height: width >= 1000 ? 900 : 780 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(
    ([t, z]) => {
      window.localStorage.setItem("pk-admin-theme", t as string);
      (window as unknown as { __v: string[] }).__v = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as unknown as { __v: string[] }).__v.push(
          `${e.violatedDirective} ${e.blockedURI} ${e.sample}`,
        ),
      );
      if (z)
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.style.fontSize = "200%";
        });
    },
    [theme, zoom],
  );
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/manage/api/")) {
      if (
        route.request().method() === "POST" &&
        url.pathname.endsWith("/release/setup/pull-request")
      )
        return refuse
          ? route.fulfill({
              status: 409,
              json: {
                error: "app_permission",
                reason: "app_permission",
                permission: "pull_requests: write",
                oneCommand: "pkey ci init",
              },
            })
          : route.fulfill({
              status: 201,
              json: {
                ok: true,
                repository: "vladzaharia/djdl",
                branch: "pkey/setup",
                pullRequest: {
                  number: 7,
                  url: "https://github.com/vladzaharia/djdl/pull/7",
                  created: true,
                },
                files: [
                  { path: ".pkey/release", written: true },
                  { path: ".github/workflows/release.yml", written: true },
                ],
                summary: { outlets: [], workflow: true },
              },
            });
      const body = routes()[url.pathname];
      return body
        ? route.fulfill({ json: body })
        : route.fulfill({ status: 404, json: { error: "not_found" } });
    }
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (url.pathname.endsWith(".html"))
      headers["content-security-policy"] = CSP;
    return route.fulfill({ response: res, headers });
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/manage.html#/p/djdl/${hash}`);
  return page;
}

const reset = (): void => {
  ready = false;
  released = false;
  refuse = false;
  keyed = true;
  noApp = false;
  noPublisher = false;
};

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __v: string[] }).__v.splice(0));

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const sideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]') as HTMLElement | null;
    return (
      document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1 ||
      (d !== null && d.scrollWidth > d.clientWidth + 1)
    );
  });

describe("Publish from CI under the Worker's CSP", () => {
  for (const [theme, width] of [
    ["dark", 1440],
    ["light", 390],
  ] as const) {
    it(`first-release panel to Done (${theme}, ${width})`, async () => {
      reset();
      const page = await open(theme, width);
      await page.getByRole("button", { name: "Publish from CI…" }).click();
      const dialog = page.getByRole("dialog", { name: "Publish from CI" });
      await dialog
        .getByRole("heading", { name: "1. Run one command" })
        .waitFor();
      await shot(page, `step1-command-${theme}-${width}`);
      await dialog
        .getByRole("button", { name: "Open the pull request" })
        .click();
      await dialog
        .getByRole("heading", { name: "1. Merge pull request #7" })
        .waitFor();
      await shot(page, `step1-pr-${theme}-${width}`);
      ready = true;
      await dialog
        .getByText(/^After step 1|Waiting for the release/)
        .first()
        .waitFor();
      await dialog.getByText(/Waiting for the release from CI/).waitFor({
        timeout: 12_000,
      });
      await shot(page, `step2-wait-${theme}-${width}`);
      released = true;
      await dialog
        .getByText(/0\.1\.0 is live on stable/)
        .waitFor({ timeout: 12_000 });
      await dialog
        .getByRole("link", { name: "Publish 0.1.0 everywhere" })
        .waitFor();
      await dialog.getByRole("link", { name: "Set up storefronts" }).waitFor();
      await shot(page, `done-${theme}-${width}`);
      // Done's View release leaves the page under the drawer for the release itself.
      await dialog.getByRole("link", { name: "View release" }).click();
      await page.waitForFunction(() => location.hash.includes("releases/"));
      expect(await sideways(page)).toBe(false);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    }, 60_000);
  }

  it("a permission refusal falls back to the one command", async () => {
    reset();
    refuse = true;
    const page = await open("dark", 1440);
    await page.getByRole("button", { name: "Publish from CI…" }).click();
    const dialog = page.getByRole("dialog", { name: "Publish from CI" });
    await dialog.getByRole("button", { name: "Open the pull request" }).click();
    await dialog
      .getByRole("alert")
      .getByText(/Pull requests: Read and write/)
      .waitFor();
    // The command is selected for you, and the pull request button is off.
    await dialog.getByText(/pkey ci init --channel stable/).waitFor();
    expect(
      await dialog
        .getByRole("tab", { name: "One command" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await dialog.getByRole("tab", { name: "Pull request" }).click();
    expect(
      await dialog
        .getByRole("button", { name: "Open the pull request" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await shot(page, "refusal-dark-1440");
    expect(await violations(page)).toEqual([]);
    await closeContext(page.context());
  });

  it("Keys opens it; 320 px and 200 % text keep it reachable", async () => {
    reset();
    for (const [name, width, zoom] of [
      ["320", 320, false],
      ["zoom200", 1280, true],
    ] as const) {
      const page = await open("light", width, "settings/keys", zoom);
      await page.getByRole("button", { name: "Publish from CI…" }).click();
      const dialog = page.getByRole("dialog", { name: "Publish from CI" });
      await dialog
        .getByRole("heading", { name: "1. Run one command" })
        .waitFor();
      await shot(page, `keys-${name}`);
      expect(await sideways(page)).toBe(false);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    }
  });

  it("?setup=ci opens the drawer after a reload; the first view is calm; no link-in-text-block", async () => {
    reset();
    ready = true;
    const page = await open("dark", 1440, "settings/keys?setup=ci");
    const dialog = page.getByRole("dialog", { name: "Publish from CI" });
    await dialog.getByRole("heading", { name: "2. Push a tag" }).waitFor();
    await shot(page, "deep-link-dark-1440");
    expect(await dialog.locator('[data-state="failed"]').count()).toBe(0);
    expect(
      (await axe(page)).filter((l) => l.includes("link-in-text-block")),
    ).toEqual([]);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(page.url()).not.toContain("setup=ci");
    await closeContext(page.context());
  });

  it("the first view is neutral To do rows, not red failures (dark, light, 390)", async () => {
    for (const [theme, width] of [
      ["dark", 1440],
      ["light", 390],
    ] as const) {
      reset();
      keyed = false;
      const page = await open(theme, width);
      await page.getByRole("button", { name: "Publish from CI…" }).click();
      const dialog = page.getByRole("dialog", { name: "Publish from CI" });
      await dialog.getByText("It also creates the release key.").waitFor();
      await dialog.getByText("To do").first().waitFor();
      expect(await dialog.locator('[data-state="failed"]').count()).toBe(0);
      expect(
        await dialog.getByRole("tab", { name: "Pull request" }).count(),
      ).toBe(0);
      await shot(page, `first-view-${theme}-${width}`);
      await closeContext(page.context());
    }
  });

  it("an App that is not installed is one row with one install link", async () => {
    reset();
    noApp = true;
    const page = await open("dark", 1440);
    await page.getByRole("button", { name: "Publish from CI…" }).click();
    const dialog = page.getByRole("dialog", { name: "Publish from CI" });
    const install = dialog.getByRole("link", {
      name: "Install the GitHub App",
    });
    await install.waitFor();
    expect(await install.getAttribute("href")).toBe(
      "https://github.com/apps/polaris-key/installations/new",
    );
    expect(await dialog.locator("li[data-state]").count()).toBe(1);
    await shot(page, "app-not-installed-dark-1440");
    await closeContext(page.context());
  });

  it("Keys offers 'Set up publishing from CI…' before a publisher exists", async () => {
    reset();
    noPublisher = true;
    const page = await open("light", 1440, "settings/keys");
    await page
      .getByRole("button", { name: "Set up publishing from CI…" })
      .click();
    await page.getByRole("dialog", { name: "Publish from CI" }).waitFor();
    expect(page.url()).toContain("setup=ci");
    await shot(page, "keys-no-publisher-light-1440");
    await closeContext(page.context());
  });
});
