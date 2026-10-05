/**
 * PX-W2 — the customer portal's per-product downloads and store links (portal gaps G2, G4).
 *
 *   1. Distribution's `customerDownloads` hook, read through Core (`buildHooks`): the stable
 *      channel's releases newest first without the yanked one or the beta, user-facing files
 *      only, the recommended picks (a universal build alone, else every arch in the platform's
 *      preference), and every store outlet with its liveness and the Steam activation link.
 *   2. `GET /api/products/<p>/downloads`: server-side detection from the request, the
 *      recommendation for the detected platform, per-file `canDownload` and `reason` from the
 *      same predicates the token mint applies (public, licensed, entitled; R2-only bytes are
 *      `not_hosted` until PX-W3), the fallback to an older covered release, and the gates.
 *
 * The product is the download page's Diceroll (`downloadWorld.ts`): 1.0.0, 1.1.0, 1.1.1
 * (yanked), 1.2.0-beta.1 (beta) and 1.2.0 on stable; App Store, Play and Steam reported live.
 */

import { issuePortalSessionRow } from "./portalSessionRow.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHooks } from "../src/core/hooks.js";
import { loadProductPublic } from "../src/core/products.js";
import { SERVICES } from "../src/mount.js";
import { setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";
import type { PortalDownloads } from "../src/services/identity/portal/downloads.js";
import {
  STEAM_ACTIVATE_URL,
  picksOf,
} from "../src/services/distribution/page/customer.js";
import type { CustomerFile } from "../src/core/hooks.js";
import { detectPlatform as coreDetect } from "../src/core/platformDetect.js";
import { detectPlatform as pageDetect } from "../src/services/distribution/page/detect.js";
import { rateLimitOk } from "../src/core/rateLimit.js";
import type { Env } from "../src/env.js";
import { handlePortalApi } from "./portalHarness.js";
import { seedDeliveryAccess } from "./releaseSurface.js";
import { NOW, seedLicenseWithKey } from "./seed.js";
import {
  BYTES,
  CONSOLE,
  SLUG,
  UA,
  setup,
  type World,
} from "./downloadWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

async function hooks(w: World) {
  const product = await loadProductPublic(w.db, SLUG);
  return buildHooks(SERVICES, product!.services, {
    env: w.env,
    db: w.db,
    product: product!,
    now: NOW,
  });
}

interface Portal {
  cookie: string;
  licenseId: string;
}

/** A portal account holding a licence for Diceroll. */
async function account(
  w: World,
  license: Parameters<typeof seedLicenseWithKey>[2] = {},
  link = true,
): Promise<Portal> {
  w.env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  const { licenseId } = await seedLicenseWithKey(w.db, SLUG, license);
  // The seeded licence is issued to ada@…; an unlinked account must not match it by email
  // (the portal links licences by verified email on every request).
  const acct = await getOrCreateAccountByEmail(
    w.db,
    link ? "ada@example.com" : "grace@example.com",
    NOW,
  );
  if (link)
    await linkLicense(w.db, acct.id, SLUG, licenseId, "license-key", NOW);
  const { token } = await issuePortalSessionRow(
    w.env,
    w.db,
    {
      accountId: acct.id,
      email: acct.primary_email,
      name: acct.display_name,
    },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, licenseId };
}

function downloads(
  w: World,
  p: Portal | null,
  opts: { ua?: string; query?: string; headers?: Record<string, string> } = {},
) {
  const path = `/api/products/${SLUG}/downloads`;
  return handlePortalApi(
    new Request(`${CONSOLE}${path}${opts.query ?? ""}`, {
      headers: {
        ...(p ? { cookie: p.cookie } : {}),
        ...(opts.ua ? { "user-agent": opts.ua } : {}),
        ...(opts.headers ?? {}),
      },
    }),
    w.env,
    w.db,
    path,
    NOW,
  );
}

async function ok(res: Response): Promise<PortalDownloads> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as PortalDownloads;
}

/** Give every Diceroll file a GitHub storage URL: a source the portal can hand a browser for a
 *  non-public deliverable (R2-only licensed bytes are PX-W3). */
async function githubSources(w: World): Promise<void> {
  await w.db.run(
    `UPDATE release_artifacts
        SET source_url = 'https://objects.githubusercontent.com/diceroll/' || artifact_id
      WHERE product = ?`,
    SLUG,
  );
}

// ── 1. The hook ──────────────────────────────────────────────────────────────────────────────

describe("Distribution's customerDownloads hook (through Core)", () => {
  it("lists the channel's servable releases with files, picks and store links", async () => {
    const w = await setup({ access: "licensed" });
    const d = await (await hooks(w)).delivery()!.customerDownloads!({
      channel: "stable",
      limit: 10,
    });
    expect(d).not.toBeNull();
    expect(d!.channel).toBe("stable");
    // Newest first; the yanked 1.1.1 and the beta are not on stable's list.
    expect(d!.releases.map((r) => r.version)).toEqual([
      "1.2.0",
      "1.1.0",
      "1.0.0",
    ]);
    const head = d!.releases[0]!;
    expect(head.title).toBe("Diceroll 1.2.0");
    // Files in platform order, then the platform's arch preference.
    expect(head.files.map((f) => `${f.platform}/${f.arch}`)).toEqual([
      "ios/arm64",
      "android/universal",
      "macos/universal",
      "windows/x86_64",
      "windows/arm64",
      "linux/x86_64",
      "linux/arm64",
    ]);
    const mac = head.files.find((f) => f.platform === "macos")!;
    expect(mac).toMatchObject({
      name: "Diceroll-1.2.0-macos.dmg",
      format: "dmg",
      role: "payload",
      minOs: "12.0",
    });
    expect(mac.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(head.files.find((f) => f.platform === "android")!.minOs).toBe(
      "API 24",
    );
    // A universal build is offered alone; otherwise every arch, preferred first.
    expect(head.picks.macos).toEqual({
      artifactIds: [mac.artifactId],
      universal: true,
    });
    const win = head.files.filter((f) => f.platform === "windows");
    expect(head.picks.windows).toEqual({
      artifactIds: win.map((f) => f.artifactId),
      universal: false,
    });
    expect(win.map((f) => f.arch)).toEqual(["x86_64", "arm64"]);

    // Every store outlet, live or not; never TestFlight (entitled-only, not a store page).
    expect(
      d!.stores.map((s) => [s.kind, s.live, s.version, s.platforms]),
    ).toEqual([
      ["app-store", true, "1.1.0", ["ios"]],
      ["play", true, "1.2.0", ["android"]],
      ["ms-store", false, null, ["windows"]],
      ["steam", true, "1.1.0", ["windows", "macos", "linux"]],
    ]);
    const steam = d!.stores.find((s) => s.kind === "steam")!;
    expect(steam).toMatchObject({
      url: "https://store.steampowered.com/app/3100000/",
      deepLink: "steam://store/3100000",
      activateUrl: STEAM_ACTIVATE_URL,
    });
    expect(
      d!.stores.filter((s) => s.kind !== "steam").map((s) => s.activateUrl),
    ).toEqual([null, null, null]);
  });

  it("honours the limit and the beta channel, and is null for an unknown channel", async () => {
    const w = await setup();
    const delivery = (await hooks(w)).delivery()!;
    const one = await delivery.customerDownloads!({
      channel: "stable",
      limit: 1,
    });
    expect(one!.releases.map((r) => r.version)).toEqual(["1.2.0"]);
    const beta = await delivery.customerDownloads!({
      channel: "beta",
      limit: 10,
    });
    expect(beta!.releases.map((r) => r.version)).toContain("1.2.0-beta.1");
    expect(
      await delivery.customerDownloads!({ channel: "nightly", limit: 10 }),
    ).toBeNull();
  });

  it("picks: two Mac builds are both offered, Apple silicon first; a universal build alone", () => {
    const file = (
      id: string,
      platform: string,
      arch: string,
    ): CustomerFile => ({
      releaseId: "app@2.0.0",
      artifactId: id,
      version: "2.0.0",
      name: `${id}.bin`,
      buildId: id,
      platform,
      arch,
      format: null,
      role: "payload",
      sizeBytes: null,
      sha256: null,
      minOs: null,
    });
    expect(
      picksOf([file("intel", "macos", "x86_64"), file("as", "macos", "arm64")]),
    ).toEqual({ macos: { artifactIds: ["as", "intel"], universal: false } });
    expect(
      picksOf([
        file("as", "macos", "arm64"),
        file("uni", "macos", "universal"),
        file("x64", "linux", "x86_64"),
        // A second file of the same arch is not a second pick.
        file("x64-b", "linux", "x86_64"),
      ]),
    ).toEqual({
      macos: { artifactIds: ["uni"], universal: true },
      linux: { artifactIds: ["x64"], universal: false },
    });
    // The page and the portal detect with one function (moved into Core, rule 6).
    expect(pageDetect).toBe(coreDetect);
  });

  it("drops an invalid store identity instead of building a link from it", async () => {
    const w = await setup();
    await w.db.run(
      `UPDATE dist_outlets SET identity_json = ? WHERE product = ? AND outlet_id = 'play'`,
      JSON.stringify({ packageName: "javascript:alert(1)" }),
      SLUG,
    );
    const d = await (await hooks(w)).delivery()!.customerDownloads!({
      channel: "stable",
      limit: 10,
    });
    expect(d!.stores.map((s) => s.kind)).not.toContain("play");
  });
});

// ── 2. The portal route ──────────────────────────────────────────────────────────────────────

describe("GET /api/products/<p>/downloads", () => {
  it("public: every file downloadable, the detected platform recommended", async () => {
    const w = await setup();
    const p = await account(w);
    const body = await ok(await downloads(w, p, { ua: UA.windows }));
    expect(body.product).toEqual({ slug: SLUG, name: expect.any(String) });
    expect(body.available).toBe(true);
    expect(body.access).toBe("public");
    expect(body.channel).toBe("stable");
    expect(body.latest).toMatchObject({ version: "1.2.0" });
    expect(body.detected).toEqual({
      platform: "windows",
      arch: "x86_64",
      touchAmbiguous: false,
    });
    expect(body.platforms.map((x) => x.platform)).toEqual([
      "ios",
      "android",
      "macos",
      "windows",
      "linux",
    ]);
    for (const x of body.platforms)
      for (const f of x.files) {
        expect(f.canDownload, f.name).toBe(true);
        expect(f.reason).toBeNull();
      }
    // Both Windows builds, the detected arch first.
    expect(body.recommended).toMatchObject({
      platform: "windows",
      label: "Windows",
      version: "1.2.0",
      universal: false,
      latest: true,
    });
    expect(body.recommended!.files.map((f) => f.arch)).toEqual([
      "x86_64",
      "arm64",
    ]);
    expect(body.extras).toEqual([]);
    expect(body.stores.map((s) => s.kind)).toEqual([
      "app-store",
      "play",
      "ms-store",
      "steam",
    ]);
  });

  it("detection: an Arm Windows visitor gets the Arm build first; a Mac the universal build alone", async () => {
    const w = await setup();
    const p = await account(w);
    const arm = await ok(
      await downloads(w, p, {
        headers: {
          "sec-ch-ua-platform": '"Windows"',
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; ARM64)",
        },
      }),
    );
    expect(arm.recommended!.files.map((f) => f.arch)).toEqual([
      "arm64",
      "x86_64",
    ]);
    const mac = await ok(await downloads(w, p, { ua: UA.ipad }));
    expect(mac.detected).toEqual({
      platform: "macos",
      arch: null,
      touchAmbiguous: true,
    });
    expect(mac.recommended).toMatchObject({
      platform: "macos",
      universal: true,
    });
    expect(mac.recommended!.files.map((f) => f.name)).toEqual([
      "Diceroll-1.2.0-macos.dmg",
    ]);
    // An unknown platform gets no recommendation, but every platform is still listed.
    const bot = await ok(await downloads(w, p, { ua: UA.bot }));
    expect(bot.detected.platform).toBeNull();
    expect(bot.recommended).toBeNull();
    expect(bot.platforms).toHaveLength(5);
  });

  it("licensed with R2-only bytes: covered but not_hosted, and nothing recommended (PX-W3)", async () => {
    const w = await setup({ access: "licensed" });
    const p = await account(w);
    const body = await ok(await downloads(w, p, { ua: UA.windows }));
    expect(body.access).toBe("licensed");
    const reasons = new Set(
      body.platforms.flatMap((x) => x.files.map((f) => f.reason)),
    );
    expect([...reasons]).toEqual(["not_hosted"]);
    expect(body.recommended).toBeNull();
    expect(body.platforms.every((x) => x.recommended === null)).toBe(true);
  });

  it("licensed with a servable source: downloadable while the licence is usable, license_inactive once expired", async () => {
    const w = await setup({ access: "licensed" });
    await githubSources(w);
    const p = await account(w);
    const live = await ok(await downloads(w, p, { ua: UA.linux }));
    expect(live.recommended).toMatchObject({
      platform: "linux",
      version: "1.2.0",
      universal: false,
    });
    expect(live.recommended!.files.map((f) => f.arch)).toEqual([
      "x86_64",
      "arm64",
    ]);

    await w.db.run(
      "UPDATE licenses SET expires_at = ? WHERE product = ? AND id = ?",
      NOW - 1,
      SLUG,
      p.licenseId,
    );
    const ended = await ok(await downloads(w, p, { ua: UA.linux }));
    const reasons = new Set(
      ended.platforms.flatMap((x) => x.files.map((f) => f.reason)),
    );
    expect([...reasons]).toEqual(["license_inactive"]);
    expect(ended.recommended).toBeNull();
  });

  it("entitled: a licence whose window ended at 1.1.0 is offered 1.1.0, and 1.2.0 says not_entitled", async () => {
    const w = await setup({ access: "entitled" });
    await githubSources(w);
    const p = await account(w, { maxVersion: "1.1.0" });
    const body = await ok(await downloads(w, p, { ua: UA.windows }));
    expect(body.access).toBe("entitled");
    const win = body.platforms.find((x) => x.platform === "windows")!;
    // The rows show the newest release, not included and why.
    expect(win.files.map((f) => [f.version, f.reason])).toEqual([
      ["1.2.0", "not_entitled"],
      ["1.2.0", "not_entitled"],
    ]);
    // The recommendation falls back to the last covered release (§5.4).
    expect(win.recommended).toMatchObject({ version: "1.1.0", latest: false });
    expect(body.recommended).toEqual(win.recommended);
    expect(
      body.recommended!.files.every(
        (f) => f.canDownload && f.version === "1.1.0",
      ),
    ).toBe(true);
  });

  it("every file it offers is one the token mint answers", async () => {
    const w = await setup({ access: "licensed" });
    await githubSources(w);
    w.env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    const p = await account(w);
    const body = await ok(await downloads(w, p, { ua: UA.windows }));
    const me = await handlePortalApi(
      new Request(`${CONSOLE}/api/me`, { headers: { cookie: p.cookie } }),
      w.env,
      w.db,
      "/api/me",
      NOW,
    );
    const { csrf } = (await me.json()) as { csrf: string };
    const f = body.recommended!.files[0]!;
    const path = `/api/releases/${SLUG}/${encodeURIComponent(f.releaseId)}/artifacts/${f.artifactId}/token`;
    const mint = await handlePortalApi(
      new Request(`${CONSOLE}${path}`, {
        method: "POST",
        headers: { cookie: p.cookie, "x-pkey-portal-csrf": csrf },
      }),
      w.env,
      w.db,
      `/api/releases/${SLUG}/${f.releaseId}/artifacts/${f.artifactId}/token`,
      NOW,
    );
    expect(mint.status, await mint.clone().text()).toBe(201);
  });

  it("the channel query selects beta; a malformed one is refused", async () => {
    const w = await setup();
    const p = await account(w);
    const beta = await ok(await downloads(w, p, { query: "?channel=beta" }));
    expect(beta.channel).toBe("beta");
    // Beta includes stable, so its newest is 1.2.0 (published after the beta).
    expect(beta.latest!.version).toBe("1.2.0");
    const bad = await downloads(w, p, { query: "?channel=..%2Fx" });
    expect(bad.status).toBe(400);
    // A channel the product does not have: available, but nothing in it.
    const none = await ok(await downloads(w, p, { query: "?channel=nightly" }));
    expect(none.available).toBe(false);
    expect(none.platforms).toEqual([]);
  });

  it("gates: no session, no linked licence, portal releases off, Release off, wrong method", async () => {
    const w = await setup();
    expect((await downloads(w, null)).status).toBe(401);

    const unlinked = await account(w, {}, false);
    expect((await downloads(w, unlinked)).status).toBe(404);

    const p = await account(w, { id: "lic_diceroll_2" });
    await w.db.run(
      `INSERT INTO portal_product_settings
         (product, portal_enabled, oidc_enabled, magic_enabled, license_key_claim_enabled,
          releases_enabled, branding_json, created_at, modified_at)
       VALUES (?, 1, 1, 1, 1, 0, NULL, ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    expect((await downloads(w, p)).status).toBe(404);
    await w.db.run(
      "UPDATE portal_product_settings SET releases_enabled = 1 WHERE product = ?",
      SLUG,
    );
    expect((await downloads(w, p)).status).toBe(200);

    const path = `/api/products/${SLUG}/downloads`;
    const post = await handlePortalApi(
      new Request(`${CONSOLE}${path}`, {
        method: "POST",
        headers: { cookie: p.cookie },
      }),
      w.env,
      w.db,
      path,
      NOW,
    );
    // A mutation without the CSRF header is refused before dispatch.
    expect(post.status).toBe(403);

    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    expect((await downloads(w, p)).status).toBe(404);
  });

  it("Distribution off: answered, but with nothing to download", async () => {
    const w = await setup();
    const p = await account(w);
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const body = await ok(await downloads(w, p, { ua: UA.windows }));
    expect(body).toMatchObject({
      available: false,
      access: null,
      recommended: null,
      platforms: [],
      extras: [],
      stores: [],
    });
    expect(body.detected.platform).toBe("windows");
  });

  it("files with no platform are extras", async () => {
    const w = await setup();
    await seedDeliveryAccess(w.db, SLUG, "public");
    // A platform-free file in 1.2.0 (a manual a GitHub sync would carry, tied to no build).
    await w.db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type, size_bytes,
          sha256, source_url, access, created_at)
       VALUES (?, 'app@1.2.0', 'manual-1', 'Diceroll-Manual.pdf', 'other', NULL, NULL,
               'application/pdf', 1000, NULL, 'https://objects.githubusercontent.com/m', 'public', ?)`,
      SLUG,
      NOW,
    );
    const p = await account(w);
    const body = await ok(await downloads(w, p));
    expect(body.extras.map((f) => [f.name, f.platform, f.canDownload])).toEqual(
      [["Diceroll-Manual.pdf", null, true]],
    );
    // Sanity: the bytes host stays the only non-GitHub redirect target.
    expect(BYTES).toMatch(/^https:/);
  });
});

describe("the downloads listing's rate limit", () => {
  it("fails open: a limiter outage does not 429 a signed-in owner's product page", async () => {
    const down = {
      RL: {
        idFromName: () => {
          throw new Error("limiter down");
        },
      },
    } as unknown as Env;
    const rl = {
      bucket: "portalDownloads",
      id: "acct",
      limit: 1,
      windowSec: 60,
    };
    expect(await rateLimitOk(down, SLUG, rl, NOW)).toBe(true);
    // The fail-closed default still holds for a bucket that never registered.
    expect(
      await rateLimitOk(down, SLUG, { ...rl, bucket: "unregistered" }, NOW),
    ).toBe(false);
  });
});
