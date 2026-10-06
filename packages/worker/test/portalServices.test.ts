/**
 * Portal capabilities and downloads are a projection of `products.services_json` (task 7.2).
 *
 * The gap this suite pins: `portal_product_settings.releases_enabled` and the Release service
 * are two switches for two different questions — "show this tenant's customers the Downloads
 * tab" and "this product distributes builds at all" — and only the first of them used to be
 * consulted. A product with Release off therefore advertised `modules.releases: true` and the
 * portal rendered a Downloads tab over an empty truth store, because there is no
 * `release_metadata` for a product that does not run the service that writes it.
 *
 * Everything below is asserted through `handlePortalApi`, not against `portalAuthCapabilities`
 * directly, because the formula that matters is the SERVED one — `handleCapabilities` conjoins
 * `portalEnabled` itself, so a repo-level test could pass while the response still said `true`.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { handlePortalApi, seedRepositoryVisibility } from "./portalHarness.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";

const PORTAL_SECRET = "test-portal-session-secret";

function portalEnv(kv = new KvMock()): Env {
  const env = makeEnv(kv, ["djdl"]);
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  return env;
}

function req(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[PORTAL_CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`https://key.plrs.im${path}`, init) as unknown as Request;
}

async function portalSession(
  env: Env,
  db: ReturnType<typeof makeTestDb>,
  email = "ada@example.com",
): Promise<{ cookie: string; csrf: string; accountId: string }> {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
  const { token, session } = await issuePortalSession(
    env,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    accountId: account.id,
  };
}

/**
 * Enablement written the way the manifest writes it: a FULL set, through the owning writer.
 * Distribution follows Release unless a test says otherwise: P2b-01 backfilled it onto every
 * Release product, and since P2b-04 it is the service that serves a download.
 */
async function setProductServices(
  db: ReturnType<typeof makeTestDb>,
  slug: string,
  services: Partial<ServicesMap>,
): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: services.release?.enabled === true },
        update: { enabled: false },
        identity: { enabled: false },
        ...services,
      },
    }),
    "manifest",
    NOW,
  );
}

/** The portal toggles, spelled out. Absent rows already default to 1 — see
 *  `getPortalProductSettings` — so this is only for the tests that need a NON-default. */
async function setPortalSettings(
  db: ReturnType<typeof makeTestDb>,
  slug: string,
  opts: { portal?: number; releases?: number } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO portal_product_settings
       (product, portal_enabled, oidc_enabled, magic_enabled,
        license_key_claim_enabled, releases_enabled, branding_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    slug,
    opts.portal ?? 1,
    1,
    1,
    1,
    opts.releases ?? 1,
    null,
    NOW,
    NOW,
  );
}

async function capabilities(
  env: Env,
  db: ReturnType<typeof makeTestDb>,
  product?: string,
): Promise<{
  auth: { oidc: boolean; magic: boolean };
  modules: { licensing: boolean; claim: boolean; releases: boolean };
}> {
  const query = product ? `?product=${encodeURIComponent(product)}` : "";
  const res = await handlePortalApi(
    req("GET", `/api/capabilities${query}`),
    env,
    db,
    "/api/capabilities",
    NOW,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    auth: { oidc: boolean; magic: boolean };
    modules: { licensing: boolean; claim: boolean; releases: boolean };
  };
}

/** A release + one artifact, written straight into the truth store the same way
 *  `services/release/store.ts` writes it — so the listing is proven to read THOSE tables. */
async function seedRelease(
  db: ReturnType<typeof makeTestDb>,
  slug: string,
  opts: { releaseId: string; version: string; artifactId: string },
): Promise<void> {
  await db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, title, notes, commit_sha, source_url,
        metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    slug,
    opts.releaseId,
    opts.version,
    `${slug} ${opts.version}`,
    null,
    null,
    `https://github.com/acme/${slug}/releases/tag/v${opts.version}`,
    "authenticated",
    "authenticated",
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    slug,
    opts.releaseId,
    opts.artifactId,
    `${slug}.dmg`,
    "dmg",
    "macos",
    "arm64",
    "application/octet-stream",
    123,
    "sha",
    `https://github.com/acme/${slug}/releases/download/v${opts.version}/${slug}.dmg`,
    null,
    null,
    "authenticated",
    null,
    NOW,
  );
}

describe("portal capabilities follow services_json", () => {
  it("refuses to advertise downloads when the Release service is off, however the portal toggle is set", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    // The exact shape the gap describes: the tenant WANTS the tab (`releases_enabled = 1`) but
    // the product does not run the service that would fill it.
    await setPortalSettings(db, "djdl", { releases: 1 });
    await setProductServices(db, "djdl", { release: { enabled: false } });

    const caps = await capabilities(env, db, "djdl");

    expect(caps.modules.releases).toBe(false);
    // …and nothing else moved. `licensing` and `claim` are still the portal toggles alone, so a
    // regression that started conjoining every module with `services_json` would fail here.
    expect(caps.modules.licensing).toBe(true);
    expect(caps.modules.claim).toBe(true);
  });

  it("advertises downloads once the same product turns the Release service on", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await setPortalSettings(db, "djdl", { releases: 1 });
    await setProductServices(db, "djdl", { release: { enabled: true } });

    expect((await capabilities(env, db, "djdl")).modules.releases).toBe(true);

    // The portal toggle is still the other half of the conjunction: a tenant that runs Release
    // for its own update feed but does not want a customer-facing Downloads tab keeps that.
    await db.run(
      "UPDATE portal_product_settings SET releases_enabled = 0 WHERE product = ?",
      "djdl",
    );
    expect((await capabilities(env, db, "djdl")).modules.releases).toBe(false);
  });

  it("answers the unscoped platform aggregate with ANY product that has all three on", async () => {
    // R5-06 keeps the unscoped answer as the documented platform-wide aggregate for the root
    // login page, which has no product context. Task 7.2 only adds a term to it.
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    await setProductServices(db, "djdl", { release: { enabled: true } });
    await setProductServices(db, "acme", { release: { enabled: false } });

    expect((await capabilities(env, db)).modules.releases).toBe(true);

    await setProductServices(db, "djdl", { release: { enabled: false } });
    expect((await capabilities(env, db)).modules.releases).toBe(false);
  });

  it("conjoins the three flags WITHIN a product before aggregating across products", async () => {
    // The aggregate must not be assembled from three independent `some` passes: one product with
    // the portal open and one product running Release is not a product that can serve downloads.
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "open-no-release");
    await seedProduct(db, "release-no-portal");
    await setProductServices(db, "open-no-release", {
      release: { enabled: false },
    });
    await setProductServices(db, "release-no-portal", {
      release: { enabled: true },
    });
    await setPortalSettings(db, "release-no-portal", { portal: 0 });

    expect((await capabilities(env, db)).modules.releases).toBe(false);
  });

  it("falls back to DEFAULT_SERVICES — Release OFF — for an absent or unreadable services_json", async () => {
    // The fail-safe direction, and the one worth pinning: `parseServices` discards a record it
    // cannot fully understand and returns the defaults, where Release is off. So a hand-edit in
    // the D1 console, or a column written by a future writer this build has never seen, costs a
    // tenant its Downloads tab rather than exposing a truth store nobody meant to publish.
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "absent");
    await seedProduct(db, "malformed");
    await seedProduct(db, "unknown-key");
    // `absent` keeps the NULL `seedProduct` leaves behind — the pre-column state.
    await setServices(db, "malformed", "{not json", "manifest", NOW);
    // Structurally valid JSON, but a key this build does not recognise: `parseServices` discards
    // the WHOLE record rather than half-honouring it, so `release: true` beside it buys nothing.
    await setServices(
      db,
      "unknown-key",
      JSON.stringify({ release: { enabled: true }, telemetry: { enabled: 1 } }),
      "manifest",
      NOW,
    );

    for (const slug of ["absent", "malformed", "unknown-key"]) {
      const caps = await capabilities(env, db, slug);
      expect(`${slug}=${caps.modules.releases}`).toBe(`${slug}=false`);
    }
    expect((await capabilities(env, db)).modules.releases).toBe(false);
  });
});

describe("portal downloads listing", () => {
  it("serves the release truth store, and only for products running the Release service", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    // Both licenses carry ada@example.com, so the per-request link sweep links both products to
    // the session account — the listing's difference is the service flag and nothing else.
    await seedLicenseWithKey(db, "djdl");
    await seedLicenseWithKey(db, "acme");
    await setProductServices(db, "djdl", { release: { enabled: true } });
    await setProductServices(db, "acme", { release: { enabled: true } });
    await seedRelease(db, "djdl", {
      releaseId: "rel_djdl_1",
      version: "1.2.3",
      artifactId: "art_djdl_1",
    });
    await seedRelease(db, "acme", {
      releaseId: "rel_acme_1",
      version: "4.5.6",
      artifactId: "art_acme_1",
    });
    const session = await portalSession(env, db);

    const listAll = await handlePortalApi(
      req("GET", "/api/releases", { cookie: session.cookie }),
      env,
      db,
      "/api/releases",
      NOW,
    );
    expect(listAll.status).toBe(200);
    const both = (await listAll.json()) as {
      releases: Array<{
        product: string;
        version: string;
        artifacts: Array<{ artifactId: string; name: string }>;
      }>;
    };
    // The rows were inserted straight into `release_metadata`/`release_artifacts` and nowhere
    // else, so coming back at all is the proof that the listing reads the truth store.
    expect(both.releases.map((r) => r.product).sort()).toEqual([
      "acme",
      "djdl",
    ]);
    const djdl = both.releases.find((r) => r.product === "djdl")!;
    expect(djdl.version).toBe("1.2.3");
    expect(djdl.artifacts).toEqual([
      expect.objectContaining({ artifactId: "art_djdl_1", name: "djdl.dmg" }),
    ]);

    await setProductServices(db, "acme", { release: { enabled: false } });

    const listOne = await handlePortalApi(
      req("GET", "/api/releases", { cookie: session.cookie }),
      env,
      db,
      "/api/releases",
      NOW,
    );
    const remaining = (await listOne.json()) as {
      releases: Array<{ product: string }>;
    };
    // `acme`'s rows are untouched in the truth store; it is the enablement authority, not a
    // delete, that stops them being served.
    expect(remaining.releases.map((r) => r.product)).toEqual(["djdl"]);
    expect(
      await db.first("SELECT 1 FROM release_metadata WHERE product = 'acme'"),
    ).not.toBeNull();
  });

  it("lists only downloadable artifacts, never signature or checksum sidecars", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedLicenseWithKey(db, "djdl");
    await setProductServices(db, "djdl", { release: { enabled: true } });
    await seedRelease(db, "djdl", {
      releaseId: "rel_1",
      version: "1.2.3",
      artifactId: "art_dmg",
    });
    for (const [id, name, kind] of [
      ["art_sig", "djdl.dmg.sig", "signature"],
      ["art_sum", "SHA256SUMS.sha256", "checksum"],
    ] as const) {
      await db.run(
        `INSERT INTO release_artifacts
           (product, release_id, artifact_id, name, kind, platform, arch, content_type,
            size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
            metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "djdl",
        "rel_1",
        id,
        name,
        kind,
        null,
        null,
        "application/octet-stream",
        64,
        null,
        `https://github.com/acme/djdl/releases/download/v1.2.3/${name}`,
        null,
        null,
        "authenticated",
        null,
        NOW,
      );
    }
    const session = await portalSession(env, db);

    const res = await handlePortalApi(
      req("GET", "/api/releases", { cookie: session.cookie }),
      env,
      db,
      "/api/releases",
      NOW,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<{ artifacts: Array<{ name: string }> }>;
    };
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]!.artifacts.map((a) => a.name)).toEqual([
      "djdl.dmg",
    ]);
  });

  it("contributes nothing for a product whose services_json cannot be read", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedLicenseWithKey(db, "djdl");
    await setServices(db, "djdl", "{not json", "manifest", NOW);
    await seedRelease(db, "djdl", {
      releaseId: "rel_1",
      version: "1.2.3",
      artifactId: "art_1",
    });
    const session = await portalSession(env, db);

    const res = await handlePortalApi(
      req("GET", "/api/releases", { cookie: session.cookie }),
      env,
      db,
      "/api/releases",
      NOW,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ releases: [] });
  });
});

describe("portal download tokens follow services_json", () => {
  /** POST the mint endpoint for one artifact and hand back the raw response. */
  async function mint(
    env: Env,
    db: ReturnType<typeof makeTestDb>,
    session: { cookie: string; csrf: string },
    slug: string,
    releaseId: string,
    artifactId: string,
  ): Promise<Response> {
    const path = `/api/releases/${slug}/${releaseId}/artifacts/${artifactId}/token`;
    return handlePortalApi(
      req("POST", path, { cookie: session.cookie, csrf: session.csrf }),
      env,
      db,
      path,
      NOW,
    );
  }

  it("mints for a product running Release and refuses once it is turned off", async () => {
    // The capability hides the tab and the listing hides the rows, but the MINT is the only one
    // of the three reachable without either — an artifact id from before the switch was flipped
    // is enough. Turning Release off does not delete `release_artifacts`, so without this term
    // the enablement authority would govern what the portal SHOWS and not what it HANDS OUT.
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedLicenseWithKey(db, "djdl");
    await setProductServices(db, "djdl", { release: { enabled: true } });
    await seedRelease(db, "djdl", {
      releaseId: "rel_1",
      version: "1.2.3",
      artifactId: "art_1",
    });
    // The file's only source is its GitHub URL, which a browser can follow from a public repo.
    await seedRepositoryVisibility(env, db, "djdl", "public");
    const session = await portalSession(env, db);

    const granted = await mint(env, db, session, "djdl", "rel_1", "art_1");
    expect(granted.status).toBe(201);
    expect((await granted.json()) as { url: string }).toMatchObject({
      url: expect.stringMatching(/^\/download\//),
    });

    await setProductServices(db, "djdl", { release: { enabled: false } });

    const refused = await mint(env, db, session, "djdl", "rel_1", "art_1");
    // 404, not 403: the rest of this endpoint hides an unreachable artifact rather than
    // confirming it exists, and a service being off must not be the one condition that answers
    // differently — that difference is itself the disclosure.
    expect(refused.status).toBe(404);
    // …and the refusal is enablement, not deletion.
    expect(
      await db.first(
        "SELECT 1 FROM release_artifacts WHERE product = 'djdl' AND artifact_id = 'art_1'",
      ),
    ).not.toBeNull();
  });

  it("refuses when services_json is unreadable, because Release defaults OFF", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedLicenseWithKey(db, "djdl");
    await seedRelease(db, "djdl", {
      releaseId: "rel_1",
      version: "1.2.3",
      artifactId: "art_1",
    });
    await setServices(db, "djdl", "{not json", "manifest", NOW);
    const session = await portalSession(env, db);
    expect(
      (await mint(env, db, session, "djdl", "rel_1", "art_1")).status,
    ).toBe(404);
  });
});
