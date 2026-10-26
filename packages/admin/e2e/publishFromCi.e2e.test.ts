import { existsSync, mkdirSync } from "node:fs";
import { closeContext } from "./teardown.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { appSecurityHeaders } from "../../worker/src/core/securityHeaders.js";
import { CORE_ROUTES } from "./coreFixtures.js";

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
  { id: "app", state: "ok" },
  { id: "release-manifest", state: ready ? "ok" : "missing" },
  { id: "workflow", state: ready ? "ok" : "missing" },
  { id: "environment", state: "ok" },
  { id: "ruleset", state: "ok" },
  { id: "publisher", state: "ok", detail: ".github/workflows/release.yml" },
];

let ready = false;
let released = false;
let refuse = false;

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
  [`${API}/release/ci-readiness`]: {
    repository: "vladzaharia/djdl",
    capabilities: {
      pullRequest: true,
      workflow: true,
      environment: true,
      ruleset: true,
    },
    checks: checks(ready),
    workflowPreview: "name: release\non:\n  push:\n    tags: ['v*']\n",
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
      ready = false;
      released = false;
      refuse = false;
      const page = await open(theme, width);
      await page.getByRole("button", { name: "Publish from CI…" }).click();
      const dialog = page.getByRole("dialog", { name: "Publish from CI" });
      await dialog
        .getByRole("heading", { name: "1. Run one command" })
        .waitFor();
      await shot(page, `step1-command-${theme}-${width}`);
      await dialog.getByRole("tab", { name: /Let Polaris Key/ }).click();
      await dialog
        .getByRole("button", { name: "Open the pull request" })
        .click();
      await dialog.getByText("Merge pull request #7").waitFor();
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
        .getByText(/0\.1\.0 is published/)
        .waitFor({ timeout: 12_000 });
      await shot(page, `done-${theme}-${width}`);
      expect(await sideways(page)).toBe(false);
      expect(await violations(page)).toEqual([]);
      await closeContext(page.context());
    }, 60_000);
  }

  it("a permission refusal falls back to the one command", async () => {
    ready = false;
    released = false;
    refuse = true;
    const page = await open("dark", 1440);
    await page.getByRole("button", { name: "Publish from CI…" }).click();
    const dialog = page.getByRole("dialog", { name: "Publish from CI" });
    await dialog.getByRole("tab", { name: /Let Polaris Key/ }).click();
    await dialog.getByRole("button", { name: "Open the pull request" }).click();
    await dialog
      .getByRole("alert")
      .getByText(/pull_requests: write/)
      .waitFor();
    await dialog.getByRole("tab", { name: "One command" }).click();
    await dialog.getByText(/pkey ci init --channel stable/).waitFor();
    await shot(page, "refusal-dark-1440");
    expect(await violations(page)).toEqual([]);
    await closeContext(page.context());
  });

  it("Keys opens it; 320 px and 200 % text keep it reachable", async () => {
    ready = false;
    released = false;
    refuse = false;
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
});
