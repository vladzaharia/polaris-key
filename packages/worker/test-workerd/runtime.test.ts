/// <reference types="@cloudflare/workers-types" />
// ── The workerd smoke lane ───────────────────────────────────────────────────────────────
//
// Every assertion here exists because it would pass in Node and could fail in workerd. The
// lane is small on purpose: R10-01 (the R10 audit findings, verified in
// the VERIFY-R10-01 audit note) was a 100%-down release blocker that hundreds of
// Node tests could not see, because `environment: "node"` permits the runtime code generation
// workerd forbids. Broad coverage lives in the Node lane; what lives here is runtime truth.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Catalog } from "@polaris-key/catalog";
import { signJws, verifyJws } from "@polaris-key/jws";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "../src/core/payload.js";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import djdlCatalog from "../../../products/djdl/catalog.json";
import { D1Db } from "../src/db/d1.js";
import { validatePayload } from "../src/core/payload.js";
import { signJwtEs256, signJwtRs256 } from "../src/core/jwt.js";
import {
  parseSignature,
  signatureMatches,
} from "../src/services/distribution/connectors/asc/webhook.js";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import {
  readUpdateHealth,
  recordUpdateEvents,
  staticScope,
} from "../src/core/updateHealth.js";
import type { Env as WorkerEnv } from "../src/env.js";
import type { ServiceHooks } from "../src/core/hooks.js";
import { playSetup } from "../src/services/distribution/connectors/play/setup.js";
import { playRun } from "../src/services/distribution/connectors/play/run.js";
import { syncPlay } from "../src/services/distribution/connectors/play/poll.js";
import { PlayFake } from "../test/playFake.js";
import playPublisher from "../test/fixtures/play/publisher.json";
import playReporting from "../test/fixtures/play/reporting.json";
import { resolveMsStoreSetup } from "../src/services/distribution/connectors/msstore/setup.js";
import {
  applyMsStoreState,
  msStoreRun,
  readMsStoreState,
} from "../src/services/distribution/connectors/msstore/poll.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  MsStoreFake,
  SELLER_ID,
  STORE_ID,
  TENANT_ID,
  type StoreFixtures,
} from "../test/msstoreFake.js";
import msStoreFixtures from "../test/fixtures/msstore/store.json";
import {
  NOW,
  TEST_KID,
  TEST_PEM,
  TEST_PUB,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";

const SLUG = "djdl";
const TRUST = { [TEST_KID]: TEST_PUB };

/** A fresh `Catalog` over the real djdl catalog (28 entries, 16 defaulted config keys). */
function djdl(): Catalog {
  return new Catalog(djdlCatalog as never);
}

describe("workerd runtime control", () => {
  // THE CANARY. If this ever stops throwing, either the lane silently fell back to a
  // permissive runtime or workerd relaxed the restriction — and in both cases every other
  // assertion in this file has quietly stopped proving anything. VERIFY-R10-01 §E1 recorded
  // exactly this on real workerd at compat dates 2024-01-01 through 2026-04-07: codegen is
  // legal at module scope and throws `EvalError` in request phase.
  it("forbids code generation from strings at request time", () => {
    // Deliberately reached indirectly: the point is to observe the runtime refusing, and a
    // literal call site would be flagged by the very lint this restriction exists to enforce.
    const compileFromSource = Function as unknown as (src: string) => unknown;
    expect(() => compileFromSource("return 1")).toThrowError(
      /[Cc]ode generation/,
    );
    const indirectEval = globalThis.eval as (src: string) => unknown;
    expect(() => indirectEval("1")).toThrowError(/[Cc]ode generation/);
  });

  it("refuses the exact construction Ajv's compile() used", () => {
    // Ajv built validator SOURCE and handed it to the `Function` constructor with named
    // parameters. This is that shape, reduced to one line. It is the thing that turned every
    // `GET /<product>/config` into a 500, so the lane asserts the runtime still forbids it —
    // if workerd ever permitted this again, the catalog assertions below would stop being
    // evidence of anything and this test says so first.
    const ajvShapedCompile = (): unknown =>
      (Function as unknown as (...args: string[]) => unknown)(
        "data",
        'return typeof data === "string";',
      );
    expect(ajvShapedCompile).toThrowError(/[Cc]ode generation/);
  });

  it("exposes WebCrypto Ed25519 at the worker's compatibility date", async () => {
    // `wrangler.toml` pins compatibility_date = 2026-04-07 with this as the stated reason.
    // The Node lane proves nothing about it: Node's WebCrypto has had Ed25519 for years.
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    expect(pair.privateKey.algorithm.name).toBe("Ed25519");
  });
});

describe("catalog validation under workerd (R10-01 regression)", () => {
  // The defect: `Catalog` validated by generating JavaScript and handing it to the `Function`
  // constructor, so *any* value check threw `EvalError` mid-request. One config key sufficed.
  it("validates a value against the real djdl catalog without generating code", () => {
    const catalog = djdl();
    const entry = catalog
      .entriesByKind("config")
      .find((e) => e.default !== undefined);
    expect(entry).toBeTruthy();
    expect(catalog.validateKeyValue(entry!.key, entry!.default).ok).toBe(true);
    expect(catalog.validateKeyValue("no.such.key", 1).ok).toBe(false);
  });

  it("analyses every djdl fragment at publish time without generating code", () => {
    // `compileAll()` is what `PUT /manage/api/products/<slug>/schema` runs. Under Ajv this
    // threw, which is why VERIFY-R10-01 §E2 recorded a 422 on every admin publish.
    expect(() => djdl().compileAll()).not.toThrow();
  });

  it("prunes a defaulted payload through validatePayload without generating code", () => {
    // `licensing.ts`'s composition: seed catalog defaults, then re-validate before signing.
    // §E2b: djdl has 16 defaulted keys, and a single one was enough to 500 the request.
    const catalog = djdl();
    const payload: ManagedPayload = {
      config: {},
      secrets: {},
      entitlements: {},
    };
    for (const entry of catalog.entries) {
      if (entry.kind !== "config" || entry.default === undefined) continue;
      payload.config[entry.key] = {
        state: entry.managementDefault ?? "default",
        value: entry.default as ManagedEntry["value"],
        updatedAt: 1_700_000_000,
      };
    }
    expect(Object.keys(payload.config).length).toBeGreaterThan(0);
    const pruned = validatePayload(payload, djdl());
    // Nothing was silently dropped: a throw here used to become 500 `catalog_unavailable`,
    // and a fail-open catch elsewhere used to drop keys instead.
    expect(Object.keys(pruned.config)).toEqual(Object.keys(payload.config));
  });

  it("answers a ReDoS-prone pattern in bounded time (R10-09)", () => {
    // `(x+x+)+y` is the 8-character pattern measured at ~54 s on the host `RegExp`. The
    // linear matcher must answer immediately and must never fall back to `RegExp`.
    const catalog = new Catalog({
      schemaVersion: 1,
      entries: [
        {
          key: "redos",
          kind: "config",
          category: "c",
          label: "l",
          description: "",
          schema: { type: "string", pattern: "(x+x+)+y" },
        },
      ],
    } as never);
    const started = Date.now();
    expect(catalog.validateKeyValue("redos", "x".repeat(41)).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("JWS signing on workerd WebCrypto", () => {
  it("signs and verifies with the committed Ed25519 test key", async () => {
    const jws = await signJws({ hello: "world" }, TEST_PEM, TEST_KID);
    const verified = await verifyJws<{ hello: string }>(jws, TRUST);
    expect(verified?.payload.hello).toBe("world");
  });
});

describe("ES256 and RS256 JWT signing on workerd WebCrypto (core/jwt.ts, P5-01)", () => {
  // Edge-mint, the GitHub App client and the outlet connectors (App Store Connect, Google) all
  // sign through `core/jwt.ts`. Node's WebCrypto proves nothing about workerd's: this is the
  // runtime that actually imports the PKCS#8 keys and produces the signatures.
  async function pkcs8Pem(key: CryptoKey): Promise<string> {
    const der = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer,
    );
    let bin = "";
    for (const b of der) bin += String.fromCharCode(b);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
  }
  const b64urlBytes = (s: string): Uint8Array =>
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );

  it("signs an ES256 JWT that verifies with the public key", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwt = await signJwtEs256(
      { iss: "issuer", aud: "appstoreconnect-v1" },
      await pkcs8Pem(pair.privateKey),
      "KID",
    );
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        b64urlBytes(sig),
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
  });

  it("signs an RS256 JWT that verifies with the public key", async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwt = await signJwtRs256(
      { iss: "svc@example.iam.gserviceaccount.com" },
      await pkcs8Pem(pair.privateKey),
    );
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        pair.publicKey,
        b64urlBytes(sig),
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
  });
});

describe("GET /<product>/config/document end to end on workerd", () => {
  // RE-PATHED for wire v3 (§R1). The pre-suite `/activate` and the fused `/config` document are
  // gone: activation is `POST /<p>/license/activate`, and the one document split into
  // `/<p>/license/document` (the grant) and `/<p>/config/document` (the settings). This lane
  // exists to catch what only workerd can fail, so it drives the routes the worker actually
  // serves — a smoke test pointed at a 404 proves the runtime nothing.
  it("activates a key and returns a signed, verifiable config document", async () => {
    // Real D1 (migrated in `setup.ts`), real KV, real Durable Object rate limiter, and the
    // real `src/index.ts` module graph — driven over HTTP, not by calling handlers directly.
    const db = new D1Db(env.DB);
    await seedProduct(env, db, SLUG, djdlCatalog);
    const { key } = await seedLicenseWithKey(db, SLUG);

    const activated = await SELF.fetch(
      `https://key.plrs.im/${SLUG}/license/activate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "x-pkey-device": "workerd-smoke-1",
        },
      },
    );
    expect(activated.status).toBe(200);
    const { token } = (await activated.json()) as { token: string };
    expect(token).toBeTruthy();

    const res = await SELF.fetch(
      `https://key.plrs.im/${SLUG}/config/document`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-pkey-version": "1.2.3",
        },
      },
    );
    // THE R10-01 ASSERTION. Before the interpreting validator this was
    // `500 {"error":"catalog_unavailable"}` on every poll, for every device, warm or cold.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwt");

    const jws = await res.text();
    const verified = await verifyJws<ConfigDoc>(jws, TRUST);
    expect(verified).not.toBeNull();
    expect(verified!.kid).toBe(TEST_KID);
    expect(verified!.payload.aud).toBe(SLUG);
    // Catalog defaults survived the pre-signing prune rather than being dropped fail-closed.
    expect(Object.keys(verified!.payload.config).length).toBeGreaterThan(0);
  });

  it("serves the licence document over the same activation", async () => {
    // The other half of the v3 split, on the same credential: a `pkeyt_` token is a DEVICE
    // principal, and both documents are minted for it.
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "djdl2", djdlCatalog);
    const { key, licenseId } = await seedLicenseWithKey(db, "djdl2");
    const activated = await SELF.fetch(
      "https://key.plrs.im/djdl2/license/activate",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "x-pkey-device": "workerd-smoke-2",
        },
      },
    );
    expect(activated.status).toBe(200);
    const { token } = (await activated.json()) as { token: string };

    const res = await SELF.fetch("https://key.plrs.im/djdl2/license/document", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      },
    });
    expect(res.status).toBe(200);
    const verified = await verifyJws<{ aud: string; licenseId: string }>(
      await res.text(),
      TRUST,
    );
    expect(verified!.payload.aud).toBe("djdl2");
    expect(verified!.payload.licenseId).toBe(licenseId);
  });

  it("routes the permanent aliases to the same handlers as the canonical paths", async () => {
    // §R1/D-07: `/<p>/appcast.xml`, `/<p>/version` and `/<p>/install.sh` are kept forever. Both
    // spellings go through the real router, and Release/Update are not enabled for this product,
    // so both must produce the registry's single not-found — the property being checked is that
    // the alias reaches the SAME dispatch, not that it serves a feed.
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "djdl3", djdlCatalog);
    for (const [aliasPath, canonical] of [
      ["/djdl3/appcast.xml", "/djdl3/update/appcast.xml"],
      ["/djdl3/version", "/djdl3/update/version"],
      ["/djdl3/install.sh", "/djdl3/release/install.sh"],
      ["/djdl3/beta/appcast.xml", "/djdl3/update/beta/appcast.xml"],
    ]) {
      const aliased = await SELF.fetch(`https://key.plrs.im${aliasPath}`);
      const direct = await SELF.fetch(`https://key.plrs.im${canonical}`);
      expect(aliased.status).toBe(direct.status);
      expect(await aliased.text()).toBe(await direct.text());
    }
  });

  it("removes the pre-suite paths wire v3 retired", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "djdl4", djdlCatalog);
    for (const path of [
      "/djdl4/activate",
      "/djdl4/config",
      "/djdl4/cli/1.2.3/djdl-arm64",
      "/djdl4/dmg/1.2.3/djdl-arm64.dmg",
      "/djdl4/changelog",
    ]) {
      const res = await SELF.fetch(`https://key.plrs.im${path}`);
      expect(res.status).toBe(404);
    }
  });
});

describe("App Store Connect webhooks on workerd (P5-02)", () => {
  it("verifies an hmacsha256 signature with workerd's WebCrypto HMAC", async () => {
    // RFC 4231-style public vector: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog").
    const body = new TextEncoder().encode(
      "The quick brown fox jumps over the lazy dog",
    );
    const good = parseSignature(
      "hmacsha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
    expect(good).not.toBeNull();
    expect(await signatureMatches("key", body, good!)).toBe(true);
    expect(await signatureMatches("other", body, good!)).toBe(false);
    expect(
      parseSignature(
        "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
      ),
    ).toBeNull();
  });

  it("applies migration 0041 and answers the service not-found shape for a product without the connector", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "djdl5", djdlCatalog);
    await db.run(
      `INSERT INTO dist_connector_events
         (product, connector, event_id, event_type, outcome, payload_json, received_at)
       VALUES ('djdl5', 'asc', 'e-1', 'PING', 'stored', '{}', 1)`,
    );
    const row = await db.first<{ outcome: string }>(
      "SELECT outcome FROM dist_connector_events WHERE product = 'djdl5'",
    );
    expect(row?.outcome).toBe("stored");
    const res = await SELF.fetch(
      "https://key.plrs.im/djdl5/distribution/hooks/asc",
      {
        method: "POST",
        headers: { "x-apple-signature": `hmacsha256=${"0".repeat(64)}` },
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });
});

describe("Google Play connector on workerd (P5-03)", () => {
  it("applies migration 0042, mints a service-account token with workerd's RSA and reads a throwaway edit into D1", async () => {
    const workerEnv = env as unknown as WorkerEnv;
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "djdl6", djdlCatalog);
    await db.run(
      `INSERT INTO dist_connector_settings (product, connector, settings_json, updated_at, updated_by)
       VALUES ('djdl6', 'play', '{}', 1, 'u1')`,
    );
    await db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
       VALUES ('djdl6', 'play', 'play', ?, 1, 1)`,
      JSON.stringify({
        packageName: "gg.acme.djdl",
        tracks: { stable: "production" },
      }),
    );
    // An RSA key generated by workerd's own WebCrypto, stored through P5-01's custody.
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    );
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
    const email = "pkey-release@acme-djdl.iam.gserviceaccount.com";
    const put = await putOutletCredential(workerEnv, db, {
      product: "djdl6",
      credentialId: "play",
      kind: "google-service-account",
      outletId: null,
      value: { client_email: email, private_key: pem },
      // The operator's pin (P5-02f): the connector runs only for the package it names.
      pin: "gg.acme.djdl",
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(put.ok).toBe(true);
    const setup = await playSetup(workerEnv, db, "djdl6");
    expect(setup?.packageName).toBe("gg.acme.djdl");
    const fake = new PlayFake(
      { publisher: playPublisher, reporting: playReporting },
      pair.publicKey,
      email,
    );
    const hooks: ServiceHooks = {
      releaseCatalog: () => null,
      delivery: () => null,
      outletCapabilities: async () => null,
    };
    const run = playRun({
      env: workerEnv,
      db,
      product: "djdl6",
      hooks,
      now: NOW,
      setup: setup!,
      use: "play:poll",
      fetchImpl: fake.fetchImpl,
    });
    const { tracks } = await syncPlay(run);
    expect(tracks.map((t) => t.track)).toEqual([
      "production",
      "beta",
      "alpha",
      "qa",
    ]);
    expect(fake.openEdits()).toEqual([]);
    expect(fake.tokenRequests).toHaveLength(1);
    const objects = await db.all<{
      object_id: string;
      outlet_id: string | null;
    }>(
      "SELECT object_id, outlet_id FROM dist_connector_objects WHERE product = 'djdl6' ORDER BY object_id",
    );
    expect(objects).toEqual([
      { object_id: "alpha", outlet_id: null },
      { object_id: "beta", outlet_id: null },
      { object_id: "production", outlet_id: "play" },
      { object_id: "qa", outlet_id: null },
    ]);
  });
});

describe("Microsoft Store connector on workerd (P5-04)", () => {
  it("mints an Entra token into the sealed KV cache and reads the app's submissions into D1, GETs only", async () => {
    const workerEnv = env as unknown as WorkerEnv;
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "djdl7", djdlCatalog);
    await db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
       VALUES ('djdl7', 'ms-store', 'ms-store', ?, 1, 1)`,
      JSON.stringify({
        productId: STORE_ID,
        flights: { beta: "Beta testers" },
      }),
    );
    const put = await putOutletCredential(workerEnv, db, {
      product: "djdl7",
      credentialId: "partner-center",
      kind: "ms-partner-center",
      outletId: null,
      value: {
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        sellerId: SELLER_ID,
      },
      pin: STORE_ID,
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    expect(put.ok).toBe(true);
    const { setup } = await resolveMsStoreSetup(workerEnv, db, "djdl7");
    expect(setup?.productId).toBe(STORE_ID);
    const fake = new MsStoreFake(msStoreFixtures as unknown as StoreFixtures);
    const hooks: ServiceHooks = {
      releaseCatalog: () => null,
      delivery: () => null,
      outletCapabilities: async () => null,
    };
    const run = () =>
      msStoreRun({
        env: workerEnv,
        db,
        product: "djdl7",
        hooks,
        now: NOW,
        setup: setup!,
        use: "ms-store:poll",
        fetchImpl: fake.fetchImpl,
      });
    const first = run();
    await applyMsStoreState(first, await readMsStoreState(first));
    // A second run is served from the sealed KV cache: still one token exchange.
    const second = run();
    await readMsStoreState(second);
    expect(fake.tokenRequests).toHaveLength(1);
    expect(new Set(fake.requests.map((r) => r.method))).toEqual(
      new Set(["GET"]),
    );
    const objects = await db.all<{ object_type: string; object_id: string }>(
      "SELECT object_type, object_id FROM dist_connector_objects WHERE product = 'djdl7' ORDER BY object_type, object_id",
    );
    expect(objects.map((o) => o.object_type)).toEqual([
      "application",
      "flight",
      "flight",
      "submission",
      "submission",
      "submission",
      "submission",
    ]);
  });
});

describe("update-health counters on a real Durable Object (P6-03)", () => {
  it("binds UPDATE_HEALTH from wrangler.toml and counts, dedupes and reads on SQLite-backed storage", async () => {
    const ns = env.UPDATE_HEALTH;
    expect(ns).toBeDefined();
    const workerEnv = env as unknown as WorkerEnv;
    const now = Math.floor(Date.now() / 1000);
    const scope = staticScope({
      outlets: ["direct"],
      channels: ["stable"],
      releases: ["app|v9.9.9-workerd"],
    });
    const entry = {
      eventId: "workerd-1",
      event: "update_reverted" as const,
      deliverable: "app",
      release: "v9.9.9-workerd",
      outlet: "direct",
      channel: "stable",
      at: now - 60,
    };
    expect(
      await recordUpdateEvents(
        workerEnv,
        "workerd",
        "DEVICEWORKERD000000000000000001",
        [entry],
        now,
        scope,
      ),
    ).toBe(1);
    // The same event again counts nothing; another device's counts once more.
    expect(
      await recordUpdateEvents(
        workerEnv,
        "workerd",
        "DEVICEWORKERD000000000000000001",
        [entry],
        now,
        scope,
      ),
    ).toBe(0);
    expect(
      await recordUpdateEvents(
        workerEnv,
        "workerd",
        "DEVICEWORKERD000000000000000002",
        [entry],
        now,
        scope,
      ),
    ).toBe(1);
    const read = await readUpdateHealth(workerEnv, {
      product: "workerd",
      deliverable: "app",
      release: "v9.9.9-workerd",
      windowHours: 2,
      now,
    });
    expect(read).toEqual({
      counts: [
        {
          outlet: "direct",
          channel: "stable",
          event: "update_reverted",
          events: 2,
          devices: 2,
        },
      ],
      truncated: false,
    });
  });
});
