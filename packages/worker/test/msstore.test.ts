/**
 * P5-04 — the Microsoft Store status connector on the connector cron, against the fake Microsoft
 * (`msstoreFake.ts`, payloads recorded from the documentation): the Entra token cached and
 * refreshed through P5-01's sealed cache, every submission status mapped, a failed certification
 * recorded as rejected with its details, a package rollout mirrored in basis points, flights
 * mapped to channels through the manifest (an unmapped one ignored and logged), GET-only reads,
 * the 409 "not readable" case, Pricing Version 2, and the products that are skipped.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  checkOutletCredentialPin,
  putOutletCredential,
  validateOutletCredentialPin,
} from "../src/core/outletCredentials.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProductPublic } from "../src/core/products.js";
import { setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import { SERVICES } from "../src/mount.js";
import {
  CONNECTOR_POLL_CRON,
  handleScheduled,
  runConnectorPolls,
} from "../src/scheduled.js";
import { upsertBuild } from "../src/services/release/model.js";
import { connectorOf } from "../src/services/distribution/connectors/index.js";
import { pollConnectors } from "../src/services/distribution/connectors/index.js";
import {
  MsStoreClient,
  STORE_API_ORIGIN,
} from "../src/services/distribution/connectors/msstore/client.js";
import {
  STATUS_MAP,
  STORE_STATUSES,
  parseSubmission,
  percentToBp,
} from "../src/services/distribution/connectors/msstore/map.js";
import { entraTokenUrl } from "../src/services/distribution/connectors/msstore/token.js";
import { makeTestDb } from "./helpers.js";
import {
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";
import { addOutlet, audits, availability, rollouts } from "./ascWorld.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  MsStoreFake,
  SELLER_ID,
  STORE_ID,
  TENANT_ID,
  type StoreFixtures,
} from "./msstoreFake.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(join(HERE, "fixtures", "msstore", "store.json"), "utf8"),
) as StoreFixtures;

const PUBLISHED = "1152921504621086517";
const PENDING = "1152921504621243487";
const BETA_FLIGHT = "7bfc11d5-f710-47c5-8a98-e04bb5aad310";
const BETA_SUB = "1152921504621086600";
const INSIDERS_FLIGHT = "cd2e368a-0da5-4026-9f34-0e7934bc6f23";

interface World {
  env: Env;
  db: Db;
  fake: MsStoreFake;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
}

async function world(
  opts: {
    outlet?: boolean;
    flights?: Record<string, string> | null;
    credential?: boolean;
    /** The pin (default: the outlet's Store ID; `null`: none). */
    pin?: string | null;
  } = {},
): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  const builds: Array<[string, string, string, string, string]> = [
    ["v1.0.0", "windows-x64", "x86_64", "msix", "1.0.0.0"],
    ["v1.1.0", "windows-x64", "x86_64", "msix", "1.1.0.0"],
    ["v1.1.0", "windows-arm64", "arm64", "msixbundle", "1.1.0.0"],
    // Same version string, not an MSIX build: never matched.
    ["v1.1.0", "windows-exe", "x86_64", "exe", "1.1.0.0"],
  ];
  for (const [releaseId, buildId, arch, format, buildNumber] of builds)
    await upsertBuild(
      db,
      {
        product: SLUG,
        releaseId,
        buildId,
        platform: "windows",
        arch,
        format,
        buildNumber,
      },
      NOW,
    );
  if (opts.outlet !== false)
    await addOutlet(db, "ms-store", "ms-store", {
      productId: STORE_ID,
      packageFamilyName: "Acme.Djdl_ng6try80pwt52",
      ...(opts.flights === null
        ? {}
        : { flights: opts.flights ?? { beta: "Beta testers" } }),
    });
  if (opts.credential !== false) {
    const r = await putOutletCredential(env, db, {
      product: SLUG,
      credentialId: "partner-center",
      kind: "ms-partner-center",
      outletId: null,
      value: {
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        sellerId: SELLER_ID,
      },
      ...(opts.pin === null ? {} : { pin: opts.pin ?? STORE_ID }),
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    if (!r.ok) throw new Error(r.message);
  }
  const fake = new MsStoreFake(FIXTURES);
  const fetchImpl = (input: string, init?: RequestInit) => {
    const host = new URL(input).hostname;
    return host.endsWith("microsoft.com") ||
      host.endsWith("microsoftonline.com")
      ? fake.fetchImpl(input, init)
      : gh.fetchImpl(input, init);
  };
  return { env, db, fake, fetchImpl };
}

async function withFetch<T>(w: World, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = w.fetchImpl as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

/** One connector-cron tick through the real `scheduled.ts` entry. */
const poll = (w: World, now = NOW) =>
  withFetch(w, () => runConnectorPolls(w.env, w.db, now));

/** The ms-store outcome of one tick, through `pollConnectors` with an injected fetch. */
async function pollDirect(w: World, now = NOW) {
  const product = (await loadProductPublic(w.db, SLUG))!;
  const hooks = buildHooks(SERVICES, product.services, {
    env: w.env,
    db: w.db,
    product,
    now,
  });
  const outcomes = await pollConnectors({
    env: w.env,
    db: w.db,
    product,
    hooks,
    now,
    fetchImpl: w.fetchImpl,
    sleep: async () => {},
  });
  return outcomes.find((o) => o.connector === "ms-store")!;
}

async function submissions(db: Db) {
  return db.all<{
    release_id: string;
    outlet_id: string;
    state: string;
    submitted_at: number | null;
    reviewed_at: number | null;
    detail_json: string | null;
    source: string;
  }>(
    `SELECT release_id, outlet_id, state, submitted_at, reviewed_at, detail_json, source
       FROM dist_submissions WHERE product = ? ORDER BY release_id, outlet_id`,
    SLUG,
  );
}

async function objects(db: Db) {
  return db.all<{
    object_type: string;
    object_id: string;
    outlet_id: string | null;
    release_id: string | null;
    store_state: string | null;
    state: string | null;
    terminal: number;
    detail_json: string;
  }>(
    `SELECT object_type, object_id, outlet_id, release_id, store_state, state, terminal, detail_json
       FROM dist_connector_objects WHERE product = ? AND connector = 'ms-store'
      ORDER BY object_type, object_id`,
    SLUG,
  );
}

const avail = async (db: Db) =>
  Object.fromEntries(
    (await availability(db))
      .filter((r) => r.outlet_id === "ms-store")
      .map((r) => [`${r.release_id}/${r.build_id}`, r.state]),
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the poll", () => {
  it("reads the app, its pending and published submissions, the flights and the mapped flight's submission — GETs only", async () => {
    const w = await world();
    const report = await poll(w);
    expect(report.failures).toEqual({});
    expect(w.fake.calls()).toEqual([
      "GET ",
      `GET submissions/${PENDING}`,
      `GET submissions/${PUBLISHED}`,
      "GET listflights",
      `GET flights/${BETA_FLIGHT}/submissions/${BETA_SUB}`,
    ]);
    expect(w.fake.requests.every((r) => r.app === STORE_ID)).toBe(true);
    expect(
      w.fake.requests.every((r) => r.authorization === "Bearer msst.test-1"),
    ).toBe(true);
    expect(w.fake.foreignHost).toEqual([]);
  });

  it("never sends anything but GET to the Store API, across every path the poller takes", async () => {
    const w = await world();
    await poll(w);
    w.fake.patchSubmission(PENDING, FIXTURES.certificationFailed);
    await poll(w, NOW + 900);
    w.fake.notReadable = true;
    await poll(w, NOW + 1800);
    w.fake.notReadable = false;
    w.fake.failNext(503, 1);
    await poll(w, NOW + 2700);
    expect(w.fake.requests.length).toBeGreaterThan(10);
    expect(new Set(w.fake.requests.map((r) => r.method))).toEqual(
      new Set(["GET"]),
    );
    // And the client cannot be asked for another method: it has none to take.
    const src = readFileSync(
      join(HERE, "../src/services/distribution/connectors/msstore/client.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
    expect(src).toMatch(/method: "GET"/);
  });

  it("maps the submissions onto availability by package version = build number (windows, MSIX)", async () => {
    const w = await world();
    await poll(w);
    expect(await avail(w.db)).toEqual({
      // Published at a 25 % gradual rollout: live.
      "v1.0.0/windows-x64": "live",
      // In certification on the main submission AND published in the beta flight: live wins.
      "v1.1.0/windows-x64": "live",
      // Both v1.1.0 builds are package version 1.1.0.0, so the flight's package covers both.
      "v1.1.0/windows-arm64": "live",
    });
    const rows = (await availability(w.db)).filter(
      (r) => r.outlet_id === "ms-store",
    );
    expect(rows.every((r) => r.source === "ms-store")).toBe(true);
    // The exe build with the same version string is never matched.
    expect(rows.some((r) => r.build_id === "windows-exe")).toBe(false);
  });

  it("records each release's submission: the main submission speaks before a flight's", async () => {
    const w = await world();
    await poll(w);
    const subs = await submissions(w.db);
    expect(
      subs.map((s) => [s.release_id, s.outlet_id, s.state, s.source]),
    ).toEqual([
      ["v1.0.0", "ms-store", "released", "ms-store"],
      ["v1.1.0", "ms-store", "in-review", "ms-store"],
    ]);
    const pending = JSON.parse(subs[1]!.detail_json!);
    expect(pending).toMatchObject({
      storeStatus: "Certification",
      submissionId: PENDING,
      role: "pending",
      channels: ["stable"],
      packageVersions: ["1.1.0.0"],
      warnings: [{ code: "ListingOptOutWarning" }],
    });
  });

  it("mirrors a package rollout at 25 % as 2,500 bp, and a flight's full release on its channel", async () => {
    const w = await world();
    await poll(w);
    expect(
      (await rollouts(w.db)).map((r) => [
        r.release_id,
        r.outlet_id,
        r.channel,
        r.rollout_bp,
        r.state,
        r.mirrored,
        r.source,
      ]),
    ).toEqual([
      ["v1.1.0", "ms-store", "beta", 10000, "complete", 1, "ms-store"],
      ["v1.0.0", "ms-store", "stable", 2500, "active", 1, "ms-store"],
    ]);
    expect(percentToBp(25)).toBe(2500);
    expect(percentToBp(12.345)).toBe(1235);
  });

  it("a stopped rollout mirrors halted and serves no one new (approved); a completed one is 10,000 bp", async () => {
    const w = await world({ flights: null });
    w.fake.setRollout(PUBLISHED, {
      isPackageRollout: true,
      packageRolloutPercentage: 40.0,
      packageRolloutStatus: "PackageRolloutStopped",
      fallbackSubmissionId: "1152921504621000001",
    });
    await poll(w);
    let stable = (await rollouts(w.db)).find((r) => r.channel === "stable")!;
    expect([stable.state, stable.rollout_bp]).toEqual(["halted", 4000]);
    expect((await avail(w.db))["v1.0.0/windows-x64"]).toBe("approved");

    w.fake.setRollout(PUBLISHED, {
      isPackageRollout: true,
      packageRolloutPercentage: 100.0,
      packageRolloutStatus: "PackageRolloutComplete",
      fallbackSubmissionId: "0",
    });
    await poll(w, NOW + 900);
    stable = (await rollouts(w.db)).find((r) => r.channel === "stable")!;
    expect([stable.state, stable.rollout_bp]).toEqual(["complete", 10000]);
    expect((await avail(w.db))["v1.0.0/windows-x64"]).toBe("live");
  });

  it("maps every submission status", async () => {
    const w = await world({ flights: null });
    // Keep v1.0.0's published submission out of the way: only v1.1.0's pending one changes.
    let t = NOW;
    const seen: Record<string, [string | undefined, string | undefined]> = {};
    for (const status of STORE_STATUSES) {
      w.fake.patchSubmission(PENDING, { status });
      t += 900;
      const outcome = await withFetch(w, () => pollDirect(w, t));
      expect(outcome.error, status).toBeUndefined();
      const sub = (await submissions(w.db)).find(
        (s) => s.release_id === "v1.1.0",
      );
      const a = await avail(w.db);
      seen[status] = [
        STATUS_MAP[status].submission === null ? undefined : sub?.state,
        STATUS_MAP[status].availability === null
          ? undefined
          : a["v1.1.0/windows-x64"],
      ];
    }
    expect(seen).toEqual({
      None: [undefined, undefined],
      Canceled: ["cancelled", "removed"],
      PendingCommit: ["prepared", "pending"],
      CommitStarted: ["submitted", "processing"],
      CommitFailed: ["rejected", "rejected"],
      PendingPublication: ["pending-developer-release", "approved"],
      Publishing: ["approved", "approved"],
      Published: ["released", "live"],
      PublishFailed: ["approved", "approved"],
      PreProcessing: ["submitted", "processing"],
      PreProcessingFailed: ["rejected", "rejected"],
      Certification: ["in-review", "in-review"],
      CertificationFailed: ["rejected", "rejected"],
      Release: ["approved", "approved"],
      ReleaseFailed: ["approved", "approved"],
    });
    // A status this build does not know is read fail-closed: no write, never live.
    expect(parseSubmission({ id: "1", status: "Teleporting" })?.status).toBe(
      null,
    );
  });

  it("records a failed certification as rejected with its details and the report's date", async () => {
    const w = await world({ flights: null });
    await poll(w);
    const before = (await submissions(w.db)).find(
      (s) => s.release_id === "v1.1.0",
    )!;
    expect(before.state).toBe("in-review");
    w.fake.patchSubmission(PENDING, FIXTURES.certificationFailed);
    await poll(w, NOW + 900);
    const sub = (await submissions(w.db)).find(
      (s) => s.release_id === "v1.1.0",
    )!;
    expect(sub.state).toBe("rejected");
    // The newest certification report's date (2023-11-14T20:00:00Z), not the poll's clock.
    expect(sub.reviewed_at).toBe(1699992000);
    const detail = JSON.parse(sub.detail_json!);
    expect(detail).toMatchObject({
      storeStatus: "CertificationFailed",
      failed: true,
      errors: [
        {
          code: "Other",
          details:
            "10.1.4.4 Inaccurate Functionality: the product crashed on launch.",
        },
      ],
      certificationReports: [1699992000],
    });
    // The report URL is not kept.
    expect(sub.detail_json).not.toContain("partner.microsoft.com");
    expect((await avail(w.db))["v1.1.0/windows-x64"]).toBe("rejected");
    const audit = (await audits(w.db)).filter(
      (a) => a.action === "distribution.submission.report",
    );
    expect(audit.at(-1)).toMatchObject({
      actor_sub: "connector:ms-store",
      summary:
        "Microsoft Store reported the ms-store submission of v1.1.0: in-review → rejected",
    });
  });

  it("records submitted_at and reviewed_at as certification moves, so time in certification shows", async () => {
    const w = await world({ flights: null });
    w.fake.patchSubmission(PENDING, { status: "CommitStarted" });
    await poll(w);
    w.fake.patchSubmission(PENDING, { status: "Certification" });
    await poll(w, NOW + 900);
    w.fake.patchSubmission(PENDING, {
      status: "Release",
      statusDetails: { errors: [], warnings: [], certificationReports: [] },
    });
    await poll(w, NOW + 7200);
    const sub = (await submissions(w.db)).find(
      (s) => s.release_id === "v1.1.0",
    )!;
    expect([sub.state, sub.submitted_at, sub.reviewed_at]).toEqual([
      "approved",
      NOW,
      NOW + 7200,
    ]);
  });

  it("never stores the submission's fileUploadUrl (a writable SAS URI), the token or the client secret", async () => {
    const w = await world();
    await poll(w);
    const tables = await w.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    for (const { name } of tables) {
      const rows = await w.db.all<Record<string, unknown>>(
        `SELECT * FROM "${name}"`,
      );
      const dump = JSON.stringify(rows);
      expect(dump, name).not.toMatch(
        /FIXTUREsasSIGNATURE|blob\.core\.windows\.net/,
      );
      expect(dump, name).not.toContain(CLIENT_SECRET);
      expect(dump, name).not.toContain("msst.test-");
    }
  });

  it("an app on Pricing Version 2 (unknown price tier) still reads status, rollout and flights", async () => {
    const w = await world();
    for (const id of [PUBLISHED, PENDING])
      w.fake.patchSubmission(id, FIXTURES.pricingVersion2);
    const report = await poll(w);
    expect(report.failures).toEqual({});
    expect((await avail(w.db))["v1.0.0/windows-x64"]).toBe("live");
    expect(
      (await rollouts(w.db)).find((r) => r.channel === "stable")?.rollout_bp,
    ).toBe(2500);
    expect((await submissions(w.db)).map((s) => s.state)).toEqual([
      "released",
      "in-review",
    ]);
  });

  it("a 409 (mandatory updates, Store-managed consumables) is 'not readable': skipped, not an error, nothing written", async () => {
    const w = await world();
    w.fake.notReadable = true;
    const outcome = await withFetch(w, () => pollDirect(w));
    expect(outcome).toMatchObject({
      connector: "ms-store",
      skipped: "not-readable",
      applied: 0,
    });
    expect(outcome.error).toBeUndefined();
    expect(await avail(w.db)).toEqual({});
    expect(await submissions(w.db)).toEqual([]);
    const app = (await objects(w.db)).find(
      (o) => o.object_type === "application",
    )!;
    expect(app.store_state).toBe("not-readable");
    // The cron invocation does not fail for it.
    const report = await poll(w, NOW + 900);
    expect(report.failures).toEqual({});
    const status = await connectorOf("ms-store")!.status({
      env: w.env,
      db: w.db,
      product: SLUG,
      now: NOW,
    });
    expect(status.readable).toBe(false);
  });

  it("a failed read writes nothing; the next tick reads again and writes", async () => {
    const w = await world();
    w.fake.failNext(503, 1);
    const outcome = await withFetch(w, () => pollDirect(w));
    expect(outcome.error).toBe("Microsoft Store GET application: HTTP 503");
    expect(await avail(w.db)).toEqual({});
    expect(await objects(w.db)).toEqual([]);
    await poll(w, NOW + 900);
    expect(Object.keys(await avail(w.db))).toHaveLength(3);

    // A failure after some reads succeeded (the last one, a flight submission) writes nothing
    // either: the writes start only once the whole state is in hand.
    const w2 = await world();
    w2.fake.flightSubmissions.get(BETA_FLIGHT)!.delete(BETA_SUB);
    const late = await withFetch(w2, () => pollDirect(w2));
    expect(late.error).toBe("Microsoft Store GET flight submission: HTTP 404");
    expect(late.calls).toBe(5);
    expect(await avail(w2.db)).toEqual({});
    expect(await submissions(w2.db)).toEqual([]);
    expect(await objects(w2.db)).toEqual([]);
    expect(await rollouts(w2.db)).toEqual([]);
  });

  it("backs off on 429 and succeeds", async () => {
    const w = await world();
    w.fake.fail429(2);
    const outcome = await withFetch(w, () => pollDirect(w));
    expect(outcome.error).toBeUndefined();
    expect(Object.keys(await avail(w.db))).toHaveLength(3);
  });

  it("a second tick over unchanged state writes no audit row", async () => {
    const w = await world();
    await poll(w);
    const n = (await audits(w.db)).length;
    await poll(w, NOW + 900);
    expect((await audits(w.db)).length).toBe(n);
  });
});

describe("the Entra token", () => {
  it("is cached and refreshed: one audited open and one exchange per token lifetime", async () => {
    const w = await world();
    await poll(w);
    await poll(w, NOW + 900);
    await poll(w, NOW + 3000);
    expect(w.fake.tokenRequests).toHaveLength(1);
    // 3599 s less the 300 s margin: at NOW + 3300 the cache no longer serves it.
    await poll(w, NOW + 3300);
    expect(w.fake.tokenRequests).toHaveLength(2);
    expect(w.fake.tokenRequests[0]).toEqual({
      tenant: TENANT_ID,
      form: {
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        resource: "https://manage.devcenter.microsoft.com",
      },
    });
    const opens = (await audits(w.db)).filter(
      (a) => a.action === "outlet_credential.use",
    );
    expect(opens).toEqual([
      {
        action: "outlet_credential.use",
        actor_sub: "system:distribution",
        target_id: "partner-center",
        summary: "ms-store:poll: opened",
      },
      {
        action: "outlet_credential.use",
        actor_sub: "system:distribution",
        target_id: "partner-center",
        summary: "ms-store:poll: opened",
      },
    ]);
    // Every API request of the last tick carried the refreshed token.
    expect(w.fake.requests.at(-1)?.authorization).toBe("Bearer msst.test-2");
  });

  it("is cached sealed: the KV entry is ciphertext, never the token", async () => {
    const w = await world();
    await poll(w);
    const kv = (w.env.HOT as unknown as { store?: Map<string, unknown> }).store;
    if (kv)
      for (const v of kv.values())
        expect(JSON.stringify(v)).not.toContain("msst.test-");
  });

  it("a refused exchange is the tick's error (status only) and recorded on the credential", async () => {
    const w = await world();
    w.fake.tokenResponse = { token_type: "Bearer" };
    const outcome = await withFetch(w, () => pollDirect(w));
    expect(outcome.error).toBe("entra token exchange returned no token");
    const row = await w.db.first<{ last_error: string | null }>(
      "SELECT last_error FROM outlet_credentials WHERE product = ? AND credential_id = 'partner-center'",
      SLUG,
    );
    expect(row?.last_error).toBe("entra token exchange returned no token");
  });

  it("goes only to login.microsoftonline.com, with a tenant id that is a GUID or a domain", () => {
    expect(entraTokenUrl(TENANT_ID)).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/token`,
    );
    expect(entraTokenUrl("contoso.onmicrosoft.com")).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/token",
    );
    for (const bad of [
      "evil.example/../x",
      "@evil.example",
      "a/b",
      "",
      "x".repeat(300),
      "contoso.onmicrosoft.com?x=1",
    ])
      expect(entraTokenUrl(bad), bad).toBeNull();
  });
});

describe("flights", () => {
  it("maps a flight to its channel through the manifest, by friendly name or flight id", async () => {
    const w = await world({ flights: { beta: BETA_FLIGHT.toUpperCase() } });
    await poll(w);
    expect(
      (await rollouts(w.db)).find((r) => r.channel === "beta")?.release_id,
    ).toBe("v1.1.0");
    const flight = (await objects(w.db)).find(
      (o) => o.object_id === BETA_FLIGHT,
    )!;
    expect([flight.outlet_id, flight.store_state]).toEqual([
      "ms-store",
      "mapped",
    ]);
  });

  it("an unknown flight is ignored and logged: listed, stored unmapped, never read, nothing written", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const w = await world();
    await poll(w);
    expect(w.fake.requests.some((r) => r.path.includes(INSIDERS_FLIGHT))).toBe(
      false,
    );
    const insiders = (await objects(w.db)).find(
      (o) => o.object_id === INSIDERS_FLIGHT,
    )!;
    expect([insiders.outlet_id, insiders.store_state]).toEqual([
      null,
      "unmapped",
    ]);
    const logged = info.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("msstore.flight.unmapped"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({
      product: SLUG,
      flightId: INSIDERS_FLIGHT,
      friendlyName: "Insiders",
    });
    // Logged once, not every tick.
    await poll(w, NOW + 900);
    expect(
      info.mock.calls.filter((c) =>
        String(c[0]).includes("msstore.flight.unmapped"),
      ),
    ).toHaveLength(1);
    expect((await rollouts(w.db)).map((r) => r.channel).sort()).toEqual([
      "beta",
      "stable",
    ]);
    const status = await connectorOf("ms-store")!.status({
      env: w.env,
      db: w.db,
      product: SLUG,
      now: NOW,
    });
    expect(status.unmapped).toEqual([INSIDERS_FLIGHT]);
  });

  it("a mapped flight Partner Center does not list is reported missing, and the poll still runs", async () => {
    const w = await world({
      flights: { beta: "Beta testers", canary: "Canary" },
    });
    await poll(w);
    const status = await connectorOf("ms-store")!.status({
      env: w.env,
      db: w.db,
      product: SLUG,
      now: NOW,
    });
    expect(
      (status.setup as { missingFlights: string[] }).missingFlights,
    ).toEqual(["Canary"]);
  });

  it("an app with no flights (listflights 404) reads the main submissions only", async () => {
    const w = await world();
    w.fake.flights = [];
    const report = await poll(w);
    expect(report.failures).toEqual({});
    expect((await rollouts(w.db)).map((r) => r.channel)).toEqual(["stable"]);
  });
});

describe("products that are skipped", () => {
  it("without an ms-store outlet or without the credential: no call, no open", async () => {
    for (const w of [
      await world({ outlet: false }),
      await world({ credential: false }),
    ]) {
      const outcome = await withFetch(w, () => pollDirect(w));
      expect(outcome).toEqual({
        connector: "ms-store",
        skipped: "not-configured",
        calls: 0,
        applied: 0,
      });
      expect(w.fake.requests).toEqual([]);
      expect(w.fake.tokenRequests).toEqual([]);
      expect(
        (await audits(w.db)).filter(
          (a) => a.action === "outlet_credential.use",
        ),
      ).toEqual([]);
    }
  });

  it("with an unpinned or mispinned credential: inert, no call, says why", async () => {
    for (const [pin, reason] of [
      [null, "credential-pin-missing"],
      ["9NBLGGH4ZZZZ", "credential-pin-mismatch"],
    ] as const) {
      const w = await world({ pin });
      const outcome = await withFetch(w, () => pollDirect(w));
      expect(outcome).toMatchObject({ skipped: reason, calls: 0 });
      expect(w.fake.requests).toEqual([]);
      expect(w.fake.tokenRequests).toEqual([]);
      const status = await connectorOf("ms-store")!.status({
        env: w.env,
        db: w.db,
        product: SLUG,
        now: NOW,
      });
      expect(status).toMatchObject({
        configured: false,
        inert: {
          reason: pin === null ? "pin_missing" : "pin_mismatch",
          manifestProductId: STORE_ID,
          credential: "partner-center",
          pinnedProductId: pin,
        },
      });
    }
  });

  it("with Distribution disabled: the service's poll never runs", async () => {
    const w = await world();
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
    const report = await poll(w);
    expect(report.results[SLUG]).toEqual({});
    expect(w.fake.requests).toEqual([]);
    expect(w.fake.tokenRequests).toEqual([]);
  });
});

describe("the ms-partner-center pin", () => {
  it("validates a 12-character Store ID and compares exactly", () => {
    expect(validateOutletCredentialPin("ms-partner-center", STORE_ID)).toEqual({
      ok: true,
      value: STORE_ID,
    });
    for (const bad of ["9NBLGGH4R31", "9NBLGGH4R3155", "9NBLGGH4R31/", ""])
      expect(validateOutletCredentialPin("ms-partner-center", bad).ok).toBe(
        false,
      );
    const info = { kind: "ms-partner-center", meta: { productId: STORE_ID } };
    expect(checkOutletCredentialPin(info, STORE_ID).ok).toBe(true);
    expect(checkOutletCredentialPin(info, "9nblggh4r315").ok).toBe(false);
  });
});

describe("the client", () => {
  it("builds paths only under the one app on the Store API host", () => {
    const c = new MsStoreClient({
      applicationId: STORE_ID,
      token: async () => "t",
    });
    expect(c.url([]).toString()).toBe(
      `${STORE_API_ORIGIN}/v1.0/my/applications/${STORE_ID}`,
    );
    expect(c.url(["submissions", "1"]).toString()).toBe(
      `${STORE_API_ORIGIN}/v1.0/my/applications/${STORE_ID}/submissions/1`,
    );
    expect(() => c.url([".."])).toThrow();
    expect(c.url(["a/b"]).pathname).toBe(
      `/v1.0/my/applications/${STORE_ID}/a%2Fb`,
    );
    expect(
      () =>
        new MsStoreClient({ applicationId: "../x", token: async () => "t" }),
    ).toThrow();
  });

  it("no msstore connector file opens a sealed value or names the credential table", () => {
    const dir = join(HERE, "../src/services/distribution/connectors/msstore");
    for (const name of readdirSync(dir)) {
      const src = readFileSync(join(dir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, name).not.toMatch(/keyvault|\bopen\s*\(|\bseal\s*\(/);
      expect(src, name).not.toMatch(/\boutlet_credentials\b/);
    }
  });
});

describe("the connector cron", () => {
  it("handleScheduled on CONNECTOR_POLL_CRON runs the Microsoft Store poll", async () => {
    const w = await world();
    await withFetch(w, () => handleScheduled(w.env, w.db, CONNECTOR_POLL_CRON));
    expect(w.fake.calls()[0]).toBe("GET ");
    expect(Object.keys(await avail(w.db))).toHaveLength(3);
  });

  it("a failed Microsoft Store read fails the invocation with a status line", async () => {
    const w = await world();
    w.fake.failNext(500, 1);
    await expect(
      withFetch(w, () => handleScheduled(w.env, w.db, CONNECTOR_POLL_CRON)),
    ).rejects.toThrow(/ms-store: Microsoft Store GET application: HTTP 500/);
  });
});
