/**
 * P2b-06 — the public download page (`services/distribution/page/`): its model
 * (`GET /<p>/distribution/download.json`, console host), its HTML (`GET /<p>/distribution/download`
 * and `GET /<p>`, BYTES HOST ONLY), the QR encoder, platform detection, and the bytes host's
 * document rule (`core/bytesHost.ts` `inertDocumentPolicy`).
 *
 * The product is Diceroll-shaped, every release ingested through the real descriptor ingest:
 *
 *     1.0.0   stable
 *     1.1.0   stable   reported live on app-store, play and steam
 *     1.1.1   stable   YANKED (and reported live on steam: still never shown)
 *     1.2.0-beta.1  beta
 *     1.2.0   stable   halted on altstore, paused on direct; live on play
 *
 * so the page offers 1.1.0 where 1.2.0 is held back, never 1.1.1, never the beta.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { enableServices } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { dispatch } from "../src/dispatch.js";
import {
  dispatchBytesHost,
  inertDocumentPolicy,
  type ByteRoute,
} from "../src/core/bytesHost.js";
import { notFound } from "../src/core/errors.js";
import { BYTE_ROUTES } from "../src/mount.js";
import {
  encodeQr,
  qrCapacity,
  qrRows,
  qrSvg,
} from "../src/services/distribution/page/qr.js";
import { detectPlatform } from "../src/services/distribution/page/detect.js";
import {
  esc,
  renderDownloadPage,
  safeHref,
} from "../src/services/distribution/page/render.js";
import {
  notesSummary,
  type DownloadModel,
} from "../src/services/distribution/page/model.js";
import {
  consoleOriginOf,
  pageCsp,
} from "../src/services/distribution/page/index.js";
import {
  APK_SIGNING,
  BYTES,
  CONSOLE,
  FDROID_FP,
  HERE,
  HOSTILE_LISTING,
  SLUG,
  UA,
  UPLOAD_KEY,
  model,
  onBytes,
  onConsole,
  setup,
} from "./downloadWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

// ── QR ───────────────────────────────────────────────────────────────────────────────────────

describe("QR encoder", () => {
  // The Godot addon's encoder is held to these; this port is held to the same.
  const fixtures = JSON.parse(
    readFileSync(
      join(
        HERE,
        "..",
        "..",
        "..",
        "sdks",
        "godot",
        "tests",
        "qr",
        "fixtures.json",
      ),
      "utf8",
    ),
  ) as {
    reference: string;
    cases: Array<{
      text: string;
      forcedVersion: number | null;
      forcedMask: number | null;
      version: number;
      mask: number;
      rows: string[];
    }>;
  };

  it("matches the reference encoder (qrcodegen) on every fixture", () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(15);
    for (const c of fixtures.cases) {
      const min = c.forcedVersion ?? 1;
      const at = encodeQr(c.text, min, c.mask)!;
      expect(at.version, c.text).toBe(c.version);
      expect(qrRows(at), c.text).toEqual(c.rows);
      if (c.forcedMask === null) {
        const auto = encodeQr(c.text, min)!;
        expect(auto.mask, `mask choice: ${c.text}`).toBe(c.mask);
        expect(qrRows(auto)).toEqual(c.rows);
      }
    }
  });

  it("capacity and bounds", () => {
    expect(qrCapacity(1)).toBe(14);
    expect(qrCapacity(10)).toBe(213);
    expect(encodeQr("x".repeat(214))).toBeNull();
    expect(encodeQr("x", 0)).toBeNull();
    expect(encodeQr("x", 11)).toBeNull();
    expect(encodeQr("x", 1, 8)).toBeNull();
  });

  it("renders deterministic SVG made of numbers only", () => {
    const text = `altstore://source?url=${encodeURIComponent(`${CONSOLE}/${SLUG}/distribution/altstore/stable/source.json`)}`;
    const a = qrSvg(text, esc("QR <code>"));
    expect(a).toBe(qrSvg(text, esc("QR <code>")));
    expect(a).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="qr" viewBox="0 0 \d+ \d+"/,
    );
    expect(a).toContain('aria-label="QR &lt;code&gt;"');
    // The encoded text never appears in the markup.
    expect(a).not.toContain("altstore");
    expect(a!.replace(/aria-label="[^"]*"/, "")).toMatch(/^[<>\w\s="/:.\-#]+$/);
  });
});

// ── Detection ────────────────────────────────────────────────────────────────────────────────

describe("platform detection", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("prefers User-Agent Client Hints, falls back to the UA", () => {
    expect(
      detectPlatform(
        h({ "sec-ch-ua-platform": '"Windows"', "user-agent": UA.windows }),
      ),
    ).toEqual({
      platform: "windows",
      arch: "x86_64",
      touchAmbiguous: false,
    });
    expect(
      detectPlatform(
        h({ "sec-ch-ua-platform": '"Android"', "sec-ch-ua-mobile": "?1" }),
      ).platform,
    ).toBe("android");
    expect(detectPlatform(h({ "sec-ch-ua-platform": '"macOS"' }))).toEqual({
      platform: "macos",
      arch: null,
      touchAmbiguous: false,
    });
    expect(detectPlatform(h({ "user-agent": UA.iphone })).platform).toBe("ios");
    expect(detectPlatform(h({ "user-agent": UA.android })).platform).toBe(
      "android",
    );
    expect(detectPlatform(h({ "user-agent": UA.linux }))).toEqual({
      platform: "linux",
      arch: "x86_64",
      touchAmbiguous: false,
    });
    expect(detectPlatform(h({ "user-agent": UA.linuxArm })).arch).toBe("arm64");
    expect(detectPlatform(h({ "user-agent": UA.cros })).platform).toBeNull();
    expect(detectPlatform(h({ "user-agent": UA.bot })).platform).toBeNull();
    expect(detectPlatform(h({})).platform).toBeNull();
  });

  it("an iPad's Safari says Macintosh: the Mac answer is marked ambiguous for CSS to settle", () => {
    expect(detectPlatform(h({ "user-agent": UA.ipad }))).toEqual({
      platform: "macos",
      arch: null,
      touchAmbiguous: true,
    });
  });

  it("a malformed hint is ignored", () => {
    expect(
      detectPlatform(
        h({ "sec-ch-ua-platform": "Windows<script>", "user-agent": UA.linux }),
      ).platform,
    ).toBe("linux");
  });
});

// ── The bytes host's document rule ───────────────────────────────────────────────────────────

describe("the bytes host's document rule (inertDocumentPolicy)", () => {
  it("admits the page's own policy", async () => {
    const csp = await pageCsp();
    expect(inertDocumentPolicy(csp)).toBe(true);
    expect(csp).toMatch(/\bsandbox\b/);
    expect(csp).not.toMatch(
      /allow-scripts|allow-same-origin|script-src|connect-src/,
    );
  });

  it("refuses anything that would let the document run script or reach out", () => {
    const base =
      "default-src 'none'; style-src 'sha256-" +
      "A".repeat(43) +
      "='; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-downloads";
    expect(inertDocumentPolicy(base)).toBe(true);
    for (const bad of [
      null,
      "",
      base.replace("; sandbox allow-downloads", ""),
      base.replace("sandbox allow-downloads", "sandbox allow-scripts"),
      base.replace("sandbox allow-downloads", "sandbox allow-same-origin"),
      base.replace("sandbox allow-downloads", "sandbox allow-forms"),
      base.replace("default-src 'none'", "default-src 'self'"),
      base.replace("frame-ancestors 'none'", "frame-ancestors *"),
      base.replace("; base-uri 'none'", ""),
      `${base}; script-src 'sha256-${"A".repeat(43)}='`,
      `${base}; connect-src https://key.example.test`,
      base.replace(/style-src [^;]+/, "style-src 'unsafe-inline'"),
      `${base}; img-src *`,
      `${base}, default-src *`,
      `${base}; sandbox`,
    ])
      expect(inertDocumentPolicy(bad), String(bad)).toBe(false);
  });

  it("a document route answering HTML under a looser policy is replaced by not-found", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await enableServices(db, true, "acme");
    const env = makeEnv(new KvMock(), []);
    env.BLOB_ORIGIN = BYTES;
    const html = (
      csp: string | null,
      extra: Record<string, string> = {},
    ): ByteRoute => ({
      name: "test.page",
      service: "distribution",
      document: true,
      match: (p) => (p === "/acme" ? { product: "acme", params: {} } : null),
      handle: async () =>
        new Response("<!doctype html><script>alert(1)</script>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...(csp ? { "content-security-policy": csp } : {}),
            "set-cookie": "a=b",
            "access-control-allow-origin": "*",
            ...extra,
          },
        }),
    });
    const good = await pageCsp();
    for (const route of [
      html(null),
      html("default-src *"),
      html(good.replace("sandbox", "sandbox allow-scripts")),
      html(good, { "content-disposition": "attachment" }),
      html(good, { "content-type": "image/svg+xml" }),
    ]) {
      const res = await dispatchBytesHost(
        new Request(`${BYTES}/acme`),
        env,
        db,
        [route],
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("content-security-policy")).toMatch(
        /^sandbox; default-src 'none'/,
      );
    }
    const ok = await dispatchBytesHost(new Request(`${BYTES}/acme`), env, db, [
      html(good),
    ]);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toBe(good);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("set-cookie")).toBeNull();
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    // No preflight and no CORS for a document.
    const pre = await dispatchBytesHost(
      new Request(`${BYTES}/acme`, {
        method: "OPTIONS",
        headers: { origin: "https://x.test" },
      }),
      env,
      db,
      [html(good)],
    );
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    // An error answer from a document route follows the ordinary rule.
    const err: ByteRoute = { ...html(good), handle: async () => notFound() };
    const nf = await dispatchBytesHost(new Request(`${BYTES}/acme`), env, db, [
      err,
    ]);
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not_found" });
  });

  it("the page route is registered as the one document route, matching both spellings", () => {
    const docs = BYTE_ROUTES.filter((r) => r.document);
    expect(docs.map((r) => [r.name, r.service])).toEqual([
      ["distribution.page", "distribution"],
    ]);
    const page = docs[0]!;
    for (const p of [
      "/diceroll",
      "/diceroll/",
      "/diceroll/distribution/download",
      "/diceroll/distribution/download/",
    ])
      expect(page.match(p), p).toEqual({ product: "diceroll", params: {} });
    for (const p of [
      "/",
      "/Diceroll",
      "/diceroll/distribution/download.json",
      "/diceroll/distribution",
      "/a/b",
    ])
      expect(page.match(p), p).toBeNull();
  });
});

// ── The model ────────────────────────────────────────────────────────────────────────────────

describe("download.json (the page model)", () => {
  it("lists SHA-256, size and minimum OS per build, newest servable release only", async () => {
    const w = await setup();
    const m = await model(w);
    expect(m.schemaVersion).toBe(1);
    expect(m.channel).toBe("stable");
    expect(m.pageUrl).toBe(`${BYTES}/${SLUG}`);
    const builds = m.platforms.flatMap((g) => g.builds);
    expect(builds.length).toBeGreaterThan(0);
    for (const b of builds) {
      expect(b.sha256, b.name).toMatch(/^[0-9a-f]{64}$/);
      expect(b.size, b.name).toBeGreaterThan(0);
      expect(
        b.url.startsWith(`${BYTES}/${SLUG}/distribution/files/`),
        b.url,
      ).toBe(true);
    }
    const mac = m.platforms.find((g) => g.platform === "macos")!;
    // 1.2.0 is paused on direct: the desktop downloads stay on 1.1.0.
    expect(mac.builds.map((b) => [b.version, b.minOs, b.format])).toEqual([
      ["1.1.0", "12.0", "dmg"],
    ]);
    const android = m.platforms.find((g) => g.platform === "android")!;
    expect(android.builds[0]!.minOs).toBe("API 24");
    // The yanked, held and beta releases never appear anywhere in the model.
    const text = JSON.stringify(m);
    expect(text).not.toContain("1.1.1");
    expect(text).not.toContain("beta.1");
  });

  it("each platform has one primary action, by the platform's priority", async () => {
    const w = await setup();
    const m = await model(w);
    const primary = Object.fromEntries(
      m.platforms.map((g) => [
        g.platform,
        m.actions.find((a) => a.id === g.primary)?.kind,
      ]),
    );
    expect(primary).toEqual({
      ios: "app-store",
      android: "play",
      macos: "download",
      windows: "download",
      linux: "download",
    });
    for (const g of m.platforms) expect(g.actions[0]).toBe(g.primary);
  });

  it("store links come from validated identities, and only once a release is reported live", async () => {
    const w = await setup();
    const m = await model(w);
    const by = (kind: string) => m.actions.filter((a) => a.kind === kind);
    expect(by("app-store")[0]).toMatchObject({
      url: "https://apps.apple.com/app/id6740000002",
      version: "1.1.0",
    });
    // 1.2.0 is live on Play and held nowhere there.
    expect(by("play")[0]).toMatchObject({
      url: "https://play.google.com/store/apps/details?id=gg.vlad.diceroll",
      version: "1.2.0",
    });
    // Steam's newest live report is the yanked 1.1.1: it shows 1.1.0.
    expect(by("steam")[0]).toMatchObject({
      url: "https://store.steampowered.com/app/3100000/",
      deepLink: "steam://store/3100000",
      platforms: ["windows", "macos", "linux"],
      version: "1.1.0",
    });
    expect(by("ms-store")).toEqual([]);
    expect(m.actions.some((a) => a.outletId === "testflight")).toBe(false);
  });

  it("AltStore, SideStore, AltStore PAL, Obtainium, F-Droid and Scoop link the console's feeds", async () => {
    const w = await setup();
    const m = await model(w);
    const by = (kind: string) => m.actions.find((a) => a.kind === kind)!;
    const source = `${CONSOLE}/${SLUG}/distribution/altstore/stable/source.json`;
    expect(by("altstore")).toMatchObject({
      url: source,
      deepLink: `altstore://source?url=${encodeURIComponent(source)}`,
      qr: `altstore://source?url=${encodeURIComponent(source)}`,
      // 1.2.0 is halted on altstore.
      version: "1.1.0",
    });
    expect(by("sidestore").deepLink).toBe(
      `sidestore://source?url=${encodeURIComponent(source)}`,
    );
    expect(by("altstore-pal").deepLink).toBe(
      `altstore-pal://source?url=${encodeURIComponent(`${CONSOLE}/${SLUG}/distribution/altstore-pal/stable/source.json`)}`,
    );
    const obt = by("obtainium");
    expect(obt.deepLink!.startsWith("obtainium://app/")).toBe(true);
    const config = JSON.parse(
      decodeURIComponent(obt.deepLink!.slice("obtainium://app/".length)),
    );
    expect(config.id).toBe("gg.vlad.diceroll");
    // The Obtainium feed document is the same config the page links.
    const feed = await onConsole(
      w,
      `/${SLUG}/distribution/obtainium/stable.json`,
    );
    expect(config).toEqual(await feed.json());
    expect(obt.url).toBe(
      `https://apps.obtainium.imranr.dev/redirect?r=${encodeURIComponent(obt.deepLink!)}`,
    );
    const repo = `${CONSOLE}/${SLUG}/distribution/fdroid/stable/repo`;
    expect(by("fdroid")).toMatchObject({
      url: `${repo}?fingerprint=${FDROID_FP}`,
      deepLink: `fdroidrepos://${repo.slice("https://".length)}?fingerprint=${FDROID_FP}`,
      qr: `${repo}?fingerprint=${FDROID_FP}`,
      fingerprint: FDROID_FP,
    });
    expect(by("scoop").command).toBe(
      `scoop install ${CONSOLE}/${SLUG}/distribution/scoop/stable.json`,
    );
    expect(by("homebrew").command).toBe("brew install --cask diceroll");
  });

  it("the key inventory's public fingerprints, never an upload key or a CI observation", async () => {
    const w = await setup();
    const m = await model(w);
    expect(m.keys).toEqual([
      { purpose: "android-app-signing", sha256: APK_SIGNING, outletId: null },
      { purpose: "fdroid-repo", sha256: FDROID_FP, outletId: null },
    ]);
  });

  it("the release summary is the notes' summary block, only while metadata is public", async () => {
    const w = await setup();
    expect((await model(w)).release).toMatchObject({
      version: "1.2.0",
      title: "Diceroll 1.2.0",
      summary: "What's new in 1.2.0.",
    });
    await w.db.run(
      "UPDATE release_config SET metadata_access = 'licensed' WHERE product = ?",
      SLUG,
    );
    // metadata no longer public: feedReaders still answers (artifacts are public) but no notes.
    expect((await model(w)).release?.summary).toBeNull();
  });

  it("no console origin: the feed rows are left out, nothing links a host that lacks them", async () => {
    const w = await setup({ consoleOrigin: null });
    const page = await onBytes(w, `/${SLUG}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain("altstore://");
    expect(html).not.toContain("obtainium://");
    expect(html).not.toContain("fdroidrepos://");
    expect(html).not.toContain("scoop install");
    expect(html).toContain("https://apps.apple.com/app/id6740000002");
  });

  it("a non-public deliverable, or Distribution off, has no model and no page", async () => {
    for (const access of ["licensed", "entitled", "authenticated"]) {
      const w = await setup({ access });
      expect(
        (await onConsole(w, `/${SLUG}/distribution/download.json`)).status,
        access,
      ).toBe(404);
      expect((await onBytes(w, `/${SLUG}`)).status, access).toBe(404);
    }
    const w = await setup();
    await w.db.run(
      `UPDATE products SET services_json = json_set(services_json, '$.services.distribution.enabled', json('false'),
         '$.services.update.enabled', json('false')) WHERE slug = ?`,
      SLUG,
    );
    expect(
      (await onConsole(w, `/${SLUG}/distribution/download.json`)).status,
    ).toBe(404);
    expect((await onBytes(w, `/${SLUG}`)).status).toBe(404);
  });

  it("is served as a feed: JSON, ETag, short cache, 304 on If-None-Match", async () => {
    const w = await setup();
    const res = await onConsole(w, `/${SLUG}/distribution/download.json`);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await onConsole(w, `/${SLUG}/distribution/download.json`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });
});

// ── The page ─────────────────────────────────────────────────────────────────────────────────

describe("the page on the bytes host", () => {
  it("HTML under its own sandboxed CSP, nosniff, no cookies either way", async () => {
    const w = await setup();
    const res = await onBytes(w, `/${SLUG}/distribution/download`, {
      headers: { cookie: "__Host-pkey_admin=stolen", "user-agent": UA.windows },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(await pageCsp());
    expect(inertDocumentPolicy(csp)).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("vary")).toContain("Sec-CH-UA-Platform");
    const html = await res.text();
    expect(html).not.toMatch(
      /<script|<iframe|<object|<embed|<form|<link|<img|\son\w+=/i,
    );
    expect(html).not.toContain("stolen");
    // The style element's hash is the one in the policy.
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const hash = createHash("sha256").update(style).digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
  });

  it("/<product> on the bytes host serves the same page", async () => {
    const w = await setup();
    const headers = { "user-agent": UA.android };
    const a = await (
      await onBytes(w, `/${SLUG}/distribution/download`, { headers })
    ).text();
    const b = await (await onBytes(w, `/${SLUG}`, { headers })).text();
    expect(b).toBe(a);
  });

  it("on the console host both page paths and /<product> are the plain not-found", async () => {
    const w = await setup();
    for (const path of [
      `/${SLUG}/distribution/download`,
      `/${SLUG}`,
      `/${SLUG}/`,
    ]) {
      const res = await onConsole(w, path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).not.toContain("text/html");
    }
    // And the model is not on the bytes host.
    expect(
      (await onBytes(w, `/${SLUG}/distribution/download.json`)).status,
    ).toBe(404);
  });

  it("one primary action per platform fixture", async () => {
    const w = await setup();
    const expectations: Array<
      [string, Record<string, string>, string, string]
    > = [
      ["iPhone", { "user-agent": UA.iphone }, "ios", "app-store"],
      ["Android", { "user-agent": UA.android }, "android", "play"],
      [
        "Android (hints)",
        { "sec-ch-ua-platform": '"Android"' },
        "android",
        "play",
      ],
      ["Windows", { "user-agent": UA.windows }, "windows", "download"],
      ["Linux", { "user-agent": UA.linux }, "linux", "download"],
      ["Mac (hints)", { "sec-ch-ua-platform": '"macOS"' }, "macos", "download"],
    ];
    for (const [label, headers, platform, kind] of expectations) {
      const html = await (await onBytes(w, `/${SLUG}`, { headers })).text();
      const primaries = [
        ...html.matchAll(
          /<div class="primary[^"]*" data-platform="([a-z]+)" data-action="([a-z-]+)">/g,
        ),
      ];
      expect(
        primaries.map((p) => [p[1], p[2]]),
        label,
      ).toEqual([[platform, kind]]);
    }
  });

  it("the Windows primary downloads the visitor's arch; Linux on ARM gets the AppImage", async () => {
    const w = await setup();
    const win = await (
      await onBytes(w, `/${SLUG}`, { headers: { "user-agent": UA.windows } })
    ).text();
    expect(win).toMatch(
      /class="button" href="[^"]+windows-x86_64\.zip" title="[^"]*Windows · x64 \(x86_64\)"[^>]*>Download for Windows/,
    );
    const arm = await (
      await onBytes(w, `/${SLUG}`, { headers: { "user-agent": UA.linuxArm } })
    ).text();
    expect(arm).toMatch(
      /class="button" href="[^"]+arm64\.AppImage" title="[^"]*Linux · ARM64"[^>]*>Download for Linux/,
    );
  });

  it("names every build by platform and arch together, never by a bare arch", async () => {
    const w = await setup();
    const html = await (
      await onBytes(w, `/${SLUG}`, { headers: { "user-agent": UA.bot } })
    ).text();
    const table = html.slice(html.indexOf('id="files-title"'));
    const cells = [
      ...table.matchAll(
        /<tr><td>[^<]*<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td>/g,
      ),
    ].map((m) => [m[1], m[2]]);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells).toContainEqual(["Windows", "x64 (x86_64)"]);
    expect(cells).toContainEqual(["Linux", "ARM64"]);
    for (const [platform] of cells) {
      expect([
        "iPhone and iPad",
        "Android",
        "macOS",
        "Windows",
        "Linux",
      ]).toContain(platform);
    }
    // Every direct-download link carries its build's full label as tooltip and accessible name.
    expect(html).toMatch(
      /title="Windows · x64 \(x86_64\)" aria-label="[^"]+, Windows · x64 \(x86_64\)"/,
    );
    // The meta line under a link reads "macOS Universal", "Windows x64", … — never "· arm64 ·".
    expect(html).not.toMatch(/ · (arm64|x86_64) · /);
  });

  it("an iPad (a Mac user agent) gets the Mac and iOS primaries, CSS picks by pointer", async () => {
    const w = await setup();
    const html = await (
      await onBytes(w, `/${SLUG}`, { headers: { "user-agent": UA.ipad } })
    ).text();
    expect(html).toContain(
      '<div class="primary pointer-only" data-platform="macos" data-action="download">',
    );
    expect(html).toContain(
      '<div class="primary touch-only" data-platform="ios" data-action="app-store">',
    );
    expect(html).toContain(
      "@media (hover:none) and (pointer:coarse){.touch-only{display:block}.pointer-only{display:none}}",
    );
  });

  it("an undetected platform is offered every platform's primary", async () => {
    const w = await setup();
    const html = await (
      await onBytes(w, `/${SLUG}`, { headers: { "user-agent": UA.bot } })
    ).text();
    expect(html).toContain("Choose your platform");
    const primaries = [
      ...html.matchAll(/data-platform="([a-z]+)" data-action/g),
    ].map((m) => m[1]);
    expect(primaries).toEqual(["ios", "android", "macos", "windows", "linux"]);
  });

  it("shows the F-Droid fingerprint, the signing keys, QR codes and every way to get it", async () => {
    const w = await setup();
    const html = await (await onBytes(w, `/${SLUG}`)).text();
    expect(html).toContain(
      `Repository fingerprint (SHA-256): <code class="sha">${FDROID_FP}</code>`,
    );
    expect(html).toContain(APK_SIGNING);
    expect(html).not.toContain(UPLOAD_KEY);
    // A QR code for every add-source link that fits the encoder: AltStore, SideStore, AltStore
    // PAL and F-Droid. An Obtainium app config is too long for one; its https link stands in.
    const m = await model(w);
    expect(
      m.actions
        .filter((a) => a.qr !== null)
        .map((a) => a.kind)
        .sort(),
    ).toEqual(["altstore", "altstore-pal", "fdroid", "sidestore"]);
    expect((html.match(/<svg /g) ?? []).length).toBe(4);
    for (const needle of [
      "altstore://source?url=",
      "sidestore://source?url=",
      "altstore-pal://source?url=",
      "obtainium://app/",
      "https://apps.obtainium.imranr.dev/redirect?r=",
      "fdroidrepos://",
      "scoop install",
      "brew install --cask diceroll",
      "https://store.steampowered.com/app/3100000/",
    ])
      expect(html, needle).toContain(needle);
    expect(html).toContain("What&#39;s new in 1.2.0.");
  });
});

// ── Escaping ─────────────────────────────────────────────────────────────────────────────────

describe("escaping", () => {
  it("a listing with <script>, quotes and a javascript: URL renders inert", async () => {
    const w = await setup({ listing: HOSTILE_LISTING });
    const res = await onBytes(w, `/${SLUG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<b>/);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain(
      "Dice&lt;script&gt;alert(1)&lt;/script&gt;&quot;roll&#39;",
    );
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;Vlad&lt;/b&gt;");
    // The model drops the unusable website rather than passing it on.
    const m = await model(w);
    expect(m.listing.website).toBeNull();
    expect(m.listing.name).toBe(HOSTILE_LISTING.name);
  });

  it("safeHref admits https and the Worker's deep-link schemes only", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "http://example.test/",
      'https://example.test/"onmouseover="x',
      "//example.test/",
      "file:///etc/passwd",
      "intent://x#Intent;end",
      null,
    ])
      expect(safeHref(bad), String(bad)).toBeNull();
    expect(safeHref("https://example.test/a?b=1&c=2")).toBe(
      "https://example.test/a?b=1&amp;c=2",
    );
    expect(safeHref("altstore://source?url=https%3A%2F%2Fx")).toBe(
      "altstore://source?url=https%3A%2F%2Fx",
    );
  });

  it("a model with hostile values in every string renders inert", () => {
    const evil = `"><script>alert(1)</script>`;
    const m: DownloadModel = {
      schemaVersion: 1,
      product: { slug: "x", name: evil },
      channel: "stable",
      pageUrl: null,
      listing: {
        name: evil,
        subtitle: evil,
        description: evil,
        developerName: evil,
        website: "javascript:alert(1)",
      },
      release: {
        releaseId: evil,
        version: evil,
        title: evil,
        publishedAt: 0,
        summary: evil,
      },
      platforms: [
        {
          platform: "android",
          label: evil,
          primary: "a",
          actions: ["a", "b"],
          builds: [],
        },
      ],
      actions: [
        {
          id: "a",
          kind: "play",
          outletId: evil,
          platforms: ["android"],
          label: evil,
          url: "javascript:alert(1)",
          deepLink: "data:text/html,x",
          qr: evil,
          command: evil,
          fingerprint: evil,
          version: evil,
          build: null,
        },
        {
          id: "b",
          kind: "fdroid",
          outletId: evil,
          platforms: ["android"],
          label: evil,
          url: "vbscript:x",
          deepLink: "javascript://x",
          qr: null,
          command: null,
          fingerprint: evil,
          version: null,
          build: null,
        },
      ],
      keys: [{ purpose: evil, sha256: evil, outletId: null }],
    };
    const html = renderDownloadPage(m, {
      platform: "android",
      arch: null,
      touchAmbiguous: false,
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:|vbscript:|data:text/i);
    expect(html).not.toContain(evil);
    expect(html).not.toContain("<script");
  });
});

describe("notesSummary", () => {
  it("prefers the summary block, else the first paragraph, plain text", () => {
    expect(
      notesSummary(
        "<!-- pkey:summary -->**Big** [news](https://x).<!-- /pkey:summary -->",
      ),
    ).toBe("Big news.");
    expect(notesSummary("First para.\n\nSecond.\n\n## Heading\n\nBody")).toBe(
      "First para.",
    );
    expect(notesSummary("## Only a heading")).toBeNull();
    expect(notesSummary(null)).toBeNull();
    expect(notesSummary("x".repeat(700))!.length).toBe(601);
  });

  it("strips list markers, headings, links and comments; a split marker pair still counts", () => {
    expect(
      notesSummary(
        "<!--\n  pkey:summary\n-->\n- **Faster** saves\n<!-- note -->\n<!-- /pkey:summary -->",
      ),
    ).toBe("Faster saves");
    expect(notesSummary("  # Title\n\nBody")).toBe("Title");
    // A closing marker before the opening one is not a block.
    expect(notesSummary("<!-- /pkey:summary -->x<!-- pkey:summary -->")).toBe(
      "x",
    );
  });

  // Release notes are repo-writer text (a descriptor allows 20,000 code points, a GitHub release
  // body more) and the summary is built on the public, unauthenticated request path. Each input
  // here took seconds to minutes against the earlier single-pattern implementation.
  it("runs in linear time on adversarial notes", () => {
    const n = 20_000;
    const inputs = [
      `<!-- pkey:summary -->${" ".repeat(n)}`,
      `<!-- pkey:summary -->${" ".repeat(n)}x`,
      `<!-- pkey:summary -->${"\n".repeat(n)}`,
      `<!-- pkey:summary -->x${"\n".repeat(n)}<!-- /pkey:summary -->`,
      `x${"\n".repeat(n)}`,
      `${"\n ".repeat(n)}x`,
      "[".repeat(n),
      "<!--".repeat(n),
      `${"<!-- pkey:summary ".repeat(n / 10)}`,
      `- ${" ".repeat(n)}`,
      "\t".repeat(n) + "#",
      "x".repeat(200_000),
    ];
    for (const notes of inputs) {
      const started = performance.now();
      notesSummary(notes);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

// ── Configuration ────────────────────────────────────────────────────────────────────────────

describe("CONSOLE_ORIGIN", () => {
  it("is read as an origin, never as the bytes host itself", () => {
    const e = (v: unknown, blob = BYTES) =>
      ({ BLOB_ORIGIN: blob, CONSOLE_ORIGIN: v }) as unknown as Env;
    expect(consoleOriginOf(e("https://key.plrs.im/"))).toBe(
      "https://key.plrs.im",
    );
    expect(consoleOriginOf(e(undefined))).toBeNull();
    expect(consoleOriginOf(e(""))).toBeNull();
    expect(consoleOriginOf(e("not a url"))).toBeNull();
    expect(consoleOriginOf(e("javascript:alert(1)"))).toBeNull();
    expect(consoleOriginOf(e(`${BYTES}/`))).toBeNull();
    expect(consoleOriginOf(e("https://DL.example.test."))).toBeNull();
  });

  it("each committed environment names its own console host, beside its dl host", () => {
    const toml = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    for (const [env, consoleHost, dlHost] of [
      ["prod", "key.plrs.im", "dl.plrs.im"],
      ["staging", "key-staging.plrs.im", "dl-staging.plrs.im"],
      ["dev", "key-dev.plrs.im", "dl-dev.plrs.im"],
    ] as const) {
      const block = toml
        .split(`[env.${env}]`)[1]!
        .split(/\n\[env\.(?!\w+\.)/)[0]!;
      expect(block, env).toContain(`CONSOLE_ORIGIN = "https://${consoleHost}"`);
      expect(block, env).toContain(`pattern = "${consoleHost}"`);
      expect(block, env).toContain(`BLOB_ORIGIN = "https://${dlHost}"`);
    }
  });
});

// ── Cost ─────────────────────────────────────────────────────────────────────────────────────

describe("cost", () => {
  it("a page build is a bounded number of D1 reads", async () => {
    const w = await setup();
    let reads = 0;
    const inner = w.db;
    const counted: Db = {
      all: (sql, ...p) => {
        reads++;
        return inner.all(sql, ...p);
      },
      first: (sql, ...p) => {
        reads++;
        return inner.first(sql, ...p);
      },
      runChanges: (sql, ...p) => inner.runChanges(sql, ...p),
      run: (sql, ...p) => inner.run(sql, ...p),
      batch: (st) => inner.batch(st),
    };
    const res = await dispatch(new Request(`${BYTES}/${SLUG}`), w.env, counted);
    expect(res.status).toBe(200);
    // Ten outlets, five releases: one selection per outlet over memoised catalog reads.
    expect(reads).toBeLessThanOrEqual(120);
  });
});
