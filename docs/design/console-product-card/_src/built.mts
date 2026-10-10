// Screenshots the BUILT console's Home and Products with the B card, over fixture data that
// mirrors the mockup's six products, so the build can be compared with the board
// (b-ledger.html). Logos come from a fixture image host under the Worker's own CSP for it.
//
//   mise exec node@22 -- pnpm --filter @polaris-key/admin build
//   mise exec node@22 -- node_modules/.bin/tsx docs/design/console-product-card/_src/built.mts
//
// Output: shots/built-<home|products>-<desktop|phone>-<dark|light>.png at device scale 2
// (1280 and 390 wide; tall enough for the whole page). Fails on a CSP violation or a page error.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const ADMIN = join(repo, "packages/admin/");
const req = createRequire(ADMIN);
const { chromium } = req("playwright") as typeof import("playwright");
const { preview } = (await import(
  req.resolve("vite")
)) as typeof import("vite");
const sharp = createRequire(join(repo, "packages/brand/package.json"))(
  "sharp",
) as typeof import("sharp");
const { resolve } = await import(join(ADMIN, "e2e/layoutFixtures.ts"));
const { artPng, squirclePng } = await import(join(ADMIN, "e2e/artPng.ts"));
const { appSecurityHeaders } = await import(
  join(repo, "packages/worker/src/core/securityHeaders.ts")
);

const IMG = "https://img.built.test";
const CSP = appSecurityHeaders(new Headers(), { imgOrigin: IMG }).get(
  "content-security-policy",
)!;
const out = join(here, "..", "shots");
const NOW = Math.floor(Date.now() / 1000);
const H = 3600;
const DAY = 86_400;

type Rgb = [number, number, number];
const ALL = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
];
const services = (...on: string[]) =>
  Object.fromEntries(ALL.map((s) => [s, { enabled: on.includes(s) }]));
const icon = (slug: string) => {
  const sha = createHash("sha256").update(slug).digest("hex");
  const url = `${IMG}/${slug}/a/${sha}`;
  return { url, w64: `${url}/64.webp`, w128: `${url}/128.webp` };
};
const ART: Record<string, () => Buffer> = {
  tidewater: () =>
    artPng(
      128,
      128,
      [
        [47, 131, 120],
        [36, 104, 96],
      ] as Rgb[],
      [246, 213, 142],
    ),
  "drift-kart": () =>
    squirclePng(128, [[255, 106, 61]] as Rgb[], [255, 244, 236], [190, 70, 30]),
  metronome: () => artPng(128, 128, [[38, 40, 46]] as Rgb[], [242, 230, 207]),
  harbor: () =>
    artPng(
      128,
      128,
      [
        [47, 107, 58],
        [36, 90, 47],
      ] as Rgb[],
      [244, 241, 232],
    ),
};

const base = (
  resolve("/manage/api/products/djdl") as { product: Record<string, unknown> }
).product;
const healthy = (syncedAt?: number) => ({
  status: "ok",
  healthy: true,
  nextActions: [],
  ...(syncedAt ? { sync: { status: "ok", lastSyncedAt: syncedAt } } : {}),
});
const LONG =
  "Northwind Broadcast Audio Workstation — Enterprise Edition for Studios";
const LONG_SLUG = "northwind-broadcast-audio-workstation";

const PRODUCTS = [
  {
    ...base,
    slug: "tidewater",
    name: "Tidewater Studio",
    services: services(
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
    ),
    releaseSource: "github",
    presentation: { icon: icon("tidewater") },
    setup: healthy(NOW - 2 * H),
    modifiedAt: NOW - 2 * H,
  },
  {
    ...base,
    slug: "drift-kart",
    name: "Drift Kart",
    services: services(
      "license",
      "config",
      "release",
      "distribution",
      "update",
    ),
    releaseSource: "github",
    presentation: { icon: icon("drift-kart") },
    setup: {
      status: "needs-attention",
      healthy: false,
      nextActions: [
        {
          id: "release",
          label: "Review release setup",
          route: "#/p/drift-kart/release/releases",
        },
        {
          id: "edge-mint:studio",
          label: "Review and approve edge-mint recipe studio",
        },
      ],
      sync: { status: "ok", lastSyncedAt: NOW - DAY },
    },
    modifiedAt: NOW - DAY,
  },
  {
    ...base,
    slug: "atlas-notes",
    name: "Atlas Notes",
    services: services("license", "config", "identity"),
    releaseSource: "manual",
    presentation: { icon: null },
    setup: healthy(),
    modifiedAt: NOW - 3 * DAY,
  },
  {
    ...base,
    slug: "metronome",
    name: "Metronome",
    services: services("license"),
    releaseSource: "manual",
    presentation: { icon: icon("metronome") },
    setup: healthy(),
    modifiedAt: NOW - 7 * DAY,
  },
  {
    ...base,
    slug: "harbor",
    name: "Harbor",
    services: services(...ALL),
    releaseSource: "github",
    presentation: { icon: icon("harbor") },
    setup: healthy(NOW - 8 * DAY),
    modifiedAt: NOW - 8 * DAY,
  },
  {
    ...base,
    slug: LONG_SLUG,
    name: LONG,
    services: services("license", "config", "identity", "sync"),
    releaseSource: "github",
    presentation: { icon: null },
    setup: {
      status: "needs-attention",
      healthy: false,
      secrets: [
        {
          name: "OIDC_CLIENT_SECRET",
          configured: false,
          sources: ["OIDC client secret"],
        },
      ],
      nextActions: [
        {
          id: "secret:OIDC_CLIENT_SECRET",
          label: "Set required secret OIDC_CLIENT_SECRET",
        },
      ],
      sync: { status: "ok", lastSyncedAt: NOW - 9 * DAY },
    },
    modifiedAt: NOW - 9 * DAY,
  },
];
const SCHEMA: Record<string, number> = {
  tidewater: 8,
  "drift-kart": 3,
  "atlas-notes": 2,
  metronome: 0,
  harbor: 14,
  [LONG_SLUG]: 5,
};
const SUMMARY = {
  products: {
    tidewater: {
      license: { active: 1284 },
      release: { version: "2.4.0", channel: "stable" },
      distribution: { storefronts: 3 },
      identity: { users: 312 },
    },
    "drift-kart": {
      license: { active: 46 },
      release: { version: "0.9.2", channel: "beta" },
      distribution: { storefronts: 1 },
    },
    "atlas-notes": { license: { active: 208 }, identity: { users: 1940 } },
    metronome: { license: { active: 12 } },
    harbor: {
      license: { active: 9412 },
      release: { version: "5.1.0", channel: "stable" },
      distribution: { storefronts: 6 },
      identity: { users: 8077 },
    },
    [LONG_SLUG]: { license: { active: 64 }, identity: { users: 71 } },
  },
};
const me = resolve("/manage/api/me") as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  "/manage/api/products": { products: PRODUCTS },
  "/manage/api/summary": SUMMARY,
  "/manage/api/me": {
    ...me,
    products: PRODUCTS.map((p) => ({
      slug: p.slug,
      name: p.name,
      schemaVersion: SCHEMA[p.slug],
    })),
  },
};

const server = await preview({
  root: ADMIN,
  configFile: join(ADMIN, "vite.config.ts"),
  preview: { port: 0, strictPort: false, host: "127.0.0.1" },
  logLevel: "silent",
});
const baseUrl = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
const browser = await chromium.launch();
const shots: string[] = [];
let failed = false;
try {
  for (const [page, hash] of [
    ["home", "#/"],
    ["products", "#/products"],
  ] as const) {
    for (const [name, vp] of [
      ["desktop", { width: 1280, height: 800 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      for (const theme of ["dark", "light"] as const) {
        const tag = `${page} ${name} ${theme}`;
        const ctx = await browser.newContext({
          viewport: vp,
          colorScheme: theme,
          reducedMotion: "reduce",
          deviceScaleFactor: 2,
          isMobile: name === "phone",
          hasTouch: name === "phone",
        });
        await ctx.addInitScript((t) => {
          window.localStorage.setItem("pk-admin-theme", t);
          (window as unknown as { __v: string[] }).__v = [];
          document.addEventListener("securitypolicyviolation", (e) =>
            (window as unknown as { __v: string[] }).__v.push(
              `${e.violatedDirective} ${e.blockedURI}`,
            ),
          );
        }, theme);
        await ctx.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin === IMG) {
            const art = ART[url.pathname.split("/")[1] ?? ""];
            if (!art) return route.fulfill({ status: 404, body: "" });
            return route.fulfill({
              body: art(),
              headers: {
                "content-type": "image/png",
                "access-control-allow-origin": "*",
              },
            });
          }
          if (url.pathname.startsWith("/manage/api/")) {
            const body = OVERRIDES[url.pathname] ?? resolve(url.pathname);
            if (body === undefined)
              return route.fulfill({
                status: 404,
                json: { error: "not_found" },
              });
            return route.fulfill({ json: body });
          }
          const res = await route.fetch();
          const headers = { ...res.headers() };
          if (url.pathname.endsWith(".html"))
            headers["content-security-policy"] = CSP;
          return route.fulfill({ response: res, headers });
        });
        const pg = await ctx.newPage();
        pg.on("pageerror", (e) => {
          failed = true;
          console.error(`${tag}: ${e.message}`);
        });
        await pg.goto(`${baseUrl}/manage.html${hash}`);
        await pg
          .locator("[data-page-title]")
          .first()
          .waitFor({ timeout: 15000 });
        await pg.waitForFunction(
          () =>
            !document.querySelector(
              ".pk-skeleton, [data-fact-skeleton], [aria-busy=true]",
            ) && Array.from(document.images).every((i) => i.complete),
          undefined,
          { timeout: 15000 },
        );
        await pg.waitForTimeout(300);
        const violations = await pg.evaluate(
          () => (window as unknown as { __v: string[] }).__v,
        );
        if (violations.length) {
          failed = true;
          console.error(`${tag}: CSP ${violations.join(", ")}`);
        }
        // Grow the viewport to the page's height so the scroll container shows everything.
        const h = await pg.evaluate(() => {
          const main = document.getElementById("content");
          const extra = main ? main.scrollHeight - main.clientHeight : 0;
          return document.documentElement.clientHeight + Math.max(0, extra);
        });
        await pg.setViewportSize({
          width: vp.width,
          height: Math.max(vp.height, h),
        });
        await pg.waitForTimeout(200);
        const path = join(out, `built-${page}-${name}-${theme}.png`);
        await pg.screenshot({ path });
        shots.push(path);
        console.log(tag);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.httpServer.close(() => r()));
}
for (const path of shots) {
  const buf = await sharp(path)
    .png({ palette: true, quality: 90, effort: 10 })
    .toBuffer();
  await sharp(buf).toFile(path);
}
if (failed) process.exit(1);
