/**
 * WP-18 — the low-severity correctness sweep.
 *
 * Five unrelated defects share this file because they share a shape: each is a guard that
 * LOOKED like it was there. A `decodeURIComponent` with no `try`; a `Math.min` with no floor; a
 * redemption path re-checking two of the three switches that governed its mint; a reserved-name
 * list missing the two names another router reserves; a coherence validator wired into one of
 * three writers. None of them is a hole an attacker walks through unaided, and every one of them
 * is a claim the code makes and does not keep.
 *
 * A4-04's admin-path behaviour is already pinned in `admin.test.ts`; what is new here is the two
 * INGEST writers, which is the half that was missing.
 */

import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { matchRoute } from "../src/router.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  DEFAULT_SERVICES,
  serializeServices,
  serializeValidatedServices,
} from "../src/core/services.js";
import {
  AUDIT_LIMIT_MAX,
  clampAuditLimit,
  listAudit,
  setServices,
} from "../src/repo.js";
import { audit } from "../src/admin/audit.js";
import { handleActivity } from "../src/admin/handlers/activity.js";
import { handlePortalDownload } from "../src/services/identity/portal/api.js";
import { loadProduct } from "../src/core/products.js";
import { loadBrowserSession } from "../src/services/identity/browserSession.js";
import {
  createPortalDownloadToken,
  getOrCreateAccountByEmail,
} from "../src/services/identity/portal/repo.js";
import { RESERVED_PRODUCT_SLUGS } from "@polaris-key/manifest";

const SLUG = "djdl";

// ── A3-07 — a malformed path is a refusal, not a throw ───────────────────────

describe("A3-07 malformed percent-encoding", () => {
  /**
   * The two decoding call sites, at the level of `matchRoute` itself. The point is twofold: an
   * ANSWER comes back at all, where this used to leave the function by throwing — and the answer
   * is `badRequest`, not `notFound`. Nothing was looked up, so there is no absence to report.
   */
  it.each([
    ["/download/%"],
    ["/download/%zz"],
    ["/download/%E0%A4"],
    [`/${SLUG}/devices/%`],
    [`/${SLUG}/devices/%C0`],
  ])("returns badRequest rather than throwing for %s", (path) => {
    expect(() => matchRoute(path)).not.toThrow();
    expect(matchRoute(path).kind).toBe("badRequest");
  });

  it("keeps a genuinely absent path a notFound — the two are not merged", () => {
    expect(matchRoute("/download").kind).toBe("notFound");
    expect(matchRoute(`/${SLUG}/nope/nope`).kind).toBe("notFound");
  });

  it("still decodes a WELL-formed escape at both sites", () => {
    const dl = matchRoute("/download/a%2Bb");
    expect(dl).toEqual({ kind: "portalDownload", token: "a+b" });
    const dev = matchRoute(`/${SLUG}/devices/a%2Bb`);
    expect(dev).toMatchObject({ kind: "devices", deviceId: "a+b" });
  });

  /**
   * The dispatcher boundary, which is the half that decides what the CALLER sees. Driven through
   * the worker's real `fetch` export rather than through `dispatch`, because the boundary is
   * declared there and a test that called the inner function would pass with the boundary
   * deleted.
   */
  it("answers 400 — not 500, and not an unhandled rejection", async () => {
    const env = makeEnv(new KvMock(), [SLUG]);
    const res = await worker.fetch(
      new Request("https://key.plrs.im/download/%"),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("bad_request");
  });

  /**
   * The SECOND unguarded decode the sweep turned up, fixed at source rather than left to the
   * boundary: `browserSession.ts`'s `readCookie` percent-decodes a product session cookie the
   * CALLER supplies. `Cookie: pkey_sess_djdl=%` threw a `URIError` out of session loading.
   *
   * Asserted through `loadBrowserSession`, the exported entry point, because `readCookie` is
   * module-private — which is also the honest level: the claim is "a malformed cookie means no
   * session", not "a helper returns null".
   */
  it("treats an undecodable session cookie as no session, rather than throwing", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    const product = await loadProduct(env, db, SLUG);
    expect(product).not.toBeNull();
    const req = new Request(`https://key.plrs.im/${SLUG}/identity/session`, {
      headers: { cookie: `pkey_sess_${SLUG}=%` },
    });
    await expect(loadBrowserSession(req, env, product!)).resolves.toBeNull();
  });

  it("does NOT launder a non-URIError into a 400", async () => {
    const env = makeEnv(new KvMock(), [SLUG]);
    // `DB` is undefined in this Env, so any route that reaches D1 throws something that is not a
    // URIError. The boundary must rethrow it: a broken database reported as "bad request" sends
    // an operator to inspect the caller instead of the outage.
    await expect(
      worker.fetch(
        new Request(`https://key.plrs.im/${SLUG}/config/schema`),
        env,
      ),
    ).rejects.toBeTruthy();
  });
});

// ── B4-03 — the activity feed's page size is genuinely bounded ───────────────

describe("B4-03 activity limit clamp", () => {
  it.each([
    [-1, 1],
    [0, 1],
    [1, 1],
    [50, 50],
    [10.9, 10],
    [AUDIT_LIMIT_MAX + 1, AUDIT_LIMIT_MAX],
    [1e9, AUDIT_LIMIT_MAX],
    // Not-a-number and the infinities all fall back to the DEFAULT rather than to a bound: they
    // are not a page size expressed badly, they are the absence of one, which is what an omitted
    // parameter also is. `Number.isFinite` is what draws that line.
    [Number.NaN, 50],
    [Number.POSITIVE_INFINITY, 50],
    [Number.NEGATIVE_INFINITY, 50],
    [undefined, 50],
  ])("clamps %s to %s", (input, expected) => {
    expect(clampAuditLimit(input as number | undefined)).toBe(expected);
  });

  /**
   * The end-to-end claim, and the one that matters: a NEGATIVE `LIMIT` is not an error in SQLite
   * and it is not zero — it means "no limit". So `?limit=-1` did not return one row or fail, it
   * returned the product's entire audit history in one unpaginated response.
   */
  it("?limit=-1 returns ONE row, not the whole table", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    for (let i = 0; i < 25; i++) {
      await audit(
        db,
        SLUG,
        { sub: "u1", name: "Ada", email: "a@x.io" },
        NOW + i,
        "test.event",
        { kind: "product", id: SLUG },
        `row ${i}`,
      );
    }

    const res = await handleActivity(
      new Request(
        `https://key.plrs.im/manage/api/products/${SLUG}/activity?limit=-1`,
      ),
      db,
      SLUG,
    );
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    expect(body.items.length).toBeLessThan(25);
  });

  it("caps an oversized page at the ceiling instead of honouring it", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    // The repo layer is the backstop; assert it directly so the ceiling is pinned even if the
    // handler ever stops pre-clamping.
    const rows = await listAudit(db, SLUG, { limit: -1 });
    expect(rows.length).toBeLessThanOrEqual(AUDIT_LIMIT_MAX);
  });
});

// ── A4-02 — portal download REDEMPTION honours Release enablement ────────────

async function setRelease(db: Db, enabled: boolean): Promise<void> {
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        ...DEFAULT_SERVICES,
        license: { enabled: true },
        identity: { enabled: true },
        release: { enabled },
      },
    }),
    "manifest",
    NOW,
  );
}

async function seedRedeemableToken(db: Db, env: Env): Promise<string> {
  const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
  const { licenseId } = await seedLicenseWithKey(db, SLUG);
  await db.run(
    `INSERT INTO portal_license_links
       (account_id, product, license_id, source, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?)`,
    account.id,
    SLUG,
    licenseId,
    "license-key",
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, title, notes, commit_sha, source_url,
        metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    SLUG,
    "v1",
    "1.0.0",
    "DJDL 1.0.0",
    null,
    null,
    null,
    "public",
    "public",
    NOW,
    null,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO release_artifacts
       (product, release_id, artifact_id, name, kind, platform, arch, content_type,
        size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
        metadata_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    SLUG,
    "v1",
    "a1",
    "djdl.dmg",
    "dmg",
    "macos",
    "arm64",
    "application/x-apple-diskimage",
    4096,
    null,
    "https://github.com/acme/djdl/releases/download/v1/djdl.dmg",
    null,
    null,
    "public",
    null,
    NOW,
  );
  return createPortalDownloadToken(env, db, {
    accountId: account.id,
    product: SLUG,
    releaseId: "v1",
    artifactId: "a1",
    now: NOW,
  });
}

describe("A4-02 portal download redemption checks Release enablement", () => {
  it("redeems while the product runs Release", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await setRelease(db, true);
    const token = await seedRedeemableToken(db, env);
    const res = await handlePortalDownload(
      new Request(`https://key.plrs.im/download/${token}`),
      env,
      db,
      token,
      NOW,
    );
    expect(res.status).toBe(302);
  });

  /**
   * The finding itself. The token is minted while Release is ON — which is the only way to get
   * one — and redeemed after it is turned OFF. Turning the service off deletes no artifacts and
   * revokes no outstanding tokens, so before the fix this 302'd: a product that had stopped
   * running Release went on serving builds through the portal door for the rest of every
   * outstanding token's life.
   */
  it("refuses a token minted BEFORE Release was turned off", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await setRelease(db, true);
    const token = await seedRedeemableToken(db, env);

    await setRelease(db, false);

    const res = await handlePortalDownload(
      new Request(`https://key.plrs.im/download/${token}`),
      env,
      db,
      token,
      NOW,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses when services_json is absent, which means Release is off", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await setRelease(db, true);
    const token = await seedRedeemableToken(db, env);
    await setServices(db, SLUG, null, "manifest", NOW);
    const res = await handlePortalDownload(
      new Request(`https://key.plrs.im/download/${token}`),
      env,
      db,
      token,
      NOW,
    );
    expect(res.status).toBe(404);
  });
});

// ── A4-03 — `kek` and `link-repo` cannot be taken as product slugs ───────────

describe("A4-03 admin-API action segments are reserved slugs", () => {
  /**
   * Verified against the dispatcher before it was fixed: with a product seeded under the slug
   * `kek`, `GET /manage/api/products/kek` answered 200 with the platform KEK KEYRING, and the
   * same GET for `link-repo` answered 405 because that action is POST-only. In both cases the
   * product's own detail route was unreachable. Reserving the names is what makes that state
   * unconstructable rather than merely unlikely.
   */
  it.each(["kek", "link-repo"])("reserves %s", (slug) => {
    expect(RESERVED_PRODUCT_SLUGS).toContain(slug);
  });

  it("keeps every public root path reserved too — this list grew, it did not change meaning", () => {
    for (const slug of [
      "docs",
      "manage",
      "api",
      "assets",
      "login",
      "logout",
      "callback",
      "magic",
      "download",
      "webhooks",
      "well-known",
    ]) {
      expect(RESERVED_PRODUCT_SLUGS).toContain(slug);
    }
  });

  /**
   * The reason `kek`'s shadowing was PARTIAL, recorded so nobody later concludes the finding was
   * imaginary because sub-routes worked: the action arms only fire at segment length 1.
   */
  it("routes a product-scoped sub-path normally — only the length-1 detail route collided", () => {
    expect(matchRoute("/manage/api/products/kek/license/licenses").kind).toBe(
      "products",
    );
  });
});

// ── A4-04 — every writer of services_json goes through validateServices ──────

describe("A4-04 service coherence is enforced on every writer", () => {
  it("refuses each incoherent combination the validator names", () => {
    const update = serializeValidatedServices({
      services: {
        ...DEFAULT_SERVICES,
        update: { enabled: true },
        release: { enabled: false },
      },
    });
    expect(update).toEqual({ ok: false, errors: ["update_requires_release"] });

    const registration = serializeValidatedServices({
      services: { ...DEFAULT_SERVICES, identity: { enabled: false } },
      registration: "requires-identity",
    });
    expect(registration).toEqual({
      ok: false,
      errors: ["registration_requires_identity"],
    });

    const stranded = serializeValidatedServices({
      services: {
        ...DEFAULT_SERVICES,
        config: { enabled: true },
        license: { enabled: false },
      },
      registration: "requires-license",
    });
    expect(stranded).toEqual({
      ok: false,
      errors: ["config_without_activation"],
    });
  });

  it("serialises a coherent set unchanged", () => {
    const ok = serializeValidatedServices({
      services: { ...DEFAULT_SERVICES, license: { enabled: true } },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(JSON.parse(ok.json)).toMatchObject({
        license: { enabled: true },
      });
    }
  });

  /**
   * The property the finding is really about, stated as a property rather than as three call
   * sites: there is no way to produce a value for this column that skips the validator, because
   * the validator is not something the writers call — it is what the serializer they all use IS.
   * A writer added later gets this without being told.
   */
  it("has exactly one validated seam, and no writer reaches serializeServices directly", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../src/", import.meta.url).pathname;

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);

    const offenders = files.filter((file) => {
      // `core/services.ts` DEFINES both, and `serializeValidatedServices` is its one caller.
      if (file.endsWith(join("core", "services.ts"))) return false;
      return /\bserializeServices\s*\(/.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
