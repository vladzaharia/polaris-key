/**
 * P3-03 — CI-signed release records through the real dispatcher: the upload route's `seqs`, the
 * submit's record ingest (one code, `release_record_rejected`, a test per reason) and storage
 * that never rewrites a record; the sync's `release_key_is_product_key`; and the declared keys
 * as key-inventory observations. Records are signed with the corpus's release test keys.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { verifyJws } from "@polaris-key/jws";
import { releaseRecordClaims } from "@polaris-key/client-core/record";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_PUB } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import {
  RELEASE_KID,
  RELEASE_KID_2027,
  RELEASE_PEM_2027,
  RELEASE_PUB,
  recordFor,
  releaseKeysJson,
  signRecord,
} from "./releaseKeysFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import {
  releaseKeyFingerprints,
  releaseKeysForSync,
} from "../src/services/release/records.js";
import { releaseKeyObservationStatements } from "../src/services/distribution/availability.js";

installDigestStream();

const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

const RELEASE_DOC = {
  release: {
    provider: { type: "github", owner: "acme", repo: "djdl" },
    binaryName: "djdl",
    releaseKeys: [{ kid: RELEASE_KID, publicKey: RELEASE_PUB }],
    deliverables: {
      app: {
        kind: "app",
        versioning: { scheme: "semver" },
        artifacts: [
          {
            id: "web",
            platform: "web",
            arch: "wasm32",
            format: "zip",
            match: "djdl-*-web.zip",
          },
          {
            id: "ios",
            platform: "ios",
            arch: "arm64",
            format: "ipa",
            match: "djdl-*-ios.ipa",
          },
        ],
      },
    },
  },
};
const PRODUCT_DOC = {
  slug: SLUG,
  name: "djdl",
  modules: {
    license: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
  },
};

function parsed() {
  const res = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest;
}

const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};

let db: Db;
let env: Env;
let r2: R2Mock;
let token: string;
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db, { release_keys_json: releaseKeysJson() });
  await db.batch(
    manifestDeliverableStatements(SLUG, parsed().release!.app!, NOW),
  );
  token = (
    await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:publish"],
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    })
  ).token;
});

afterEach(() => vi.useRealTimers());

function post(path: string, body: unknown) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/publish/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const WEB = new TextEncoder().encode("web build bytes, version 1.3.0");
const WEB_SHA = sha(WEB);

/** A descriptor with a self-hosted web build and a store-only iOS build. */
function descriptor(version = "1.3.0", seq?: number): Record<string, any> {
  return {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    ...(seq !== undefined ? { seq } : {}),
    channel: "stable",
    notes: "Fixes.",
    builds: [
      {
        id: "web",
        platform: "web",
        arch: "wasm32",
        format: "zip",
        artifacts: [
          {
            name: `djdl-${version}-web.zip`,
            role: "payload",
            sha256: WEB_SHA,
            size: WEB.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${WEB_SHA}` }],
          },
        ],
      },
      {
        id: "ios",
        platform: "ios",
        arch: "arm64",
        format: "ipa",
        buildNumber: "4022",
        artifacts: [],
      },
    ],
  };
}

/** A ticket with the web bytes staged, and the seq the upload route answered for `version`. */
async function staged(version = "1.3.0") {
  const res = await post("uploads", {
    objects: [{ sha256: WEB_SHA, size: WEB.length }],
    releases: [{ deliverable: "app", version }],
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, any>;
  r2.seed(`${body.prefix}${WEB_SHA}`, WEB, { withSha256: true });
  return {
    ticket: body.ticket as string,
    seq: body.seqs[0].seq as number,
    body,
  };
}

async function counts() {
  const n = async (t: string) =>
    (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
  return {
    releases: await n("release_metadata"),
    records: await n("release_records"),
  };
}

describe("POST /release/publish/uploads — seqs", () => {
  it("answers each named release's seq: the next one for a new release, the stored one for an existing release", async () => {
    const first = await post("uploads", {
      objects: [{ sha256: WEB_SHA, size: WEB.length }],
      releases: [
        { deliverable: "app", version: "1.3.0" },
        { deliverable: "app", version: "1.4.0" },
      ],
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).seqs).toEqual([
      { deliverable: "app", version: "1.3.0", seq: 1 },
      { deliverable: "app", version: "1.4.0", seq: 2 },
    ]);
    // Publish 1.3.0; a re-run asking again gets its stored seq (idempotent).
    const s = await staged();
    const jws = await signRecord(
      recordFor(descriptor("1.3.0", s.seq), { seq: s.seq, issuedAt: NOW }),
    );
    const res = await post("submit", {
      ticket: s.ticket,
      descriptor: descriptor("1.3.0", s.seq),
      record: jws,
    });
    expect(res.status).toBe(200);
    const again = await post("uploads", {
      objects: [{ sha256: WEB_SHA, size: WEB.length }],
      releases: [
        { deliverable: "app", version: "1.3.0" },
        { deliverable: "app", version: "1.4.0" },
      ],
    });
    // P4-02: an existing release's entry carries its record's hash.
    expect(((await again.json()) as any).seqs).toEqual([
      { deliverable: "app", version: "1.3.0", seq: 1, recordSha256: sha(jws) },
      { deliverable: "app", version: "1.4.0", seq: 2 },
    ]);
  });

  it("refuses malformed releases 400", async () => {
    for (const releases of [
      "app",
      [{ deliverable: "App", version: "1.0.0" }],
      [{ deliverable: "app", version: " 1.0" }],
      Array.from({ length: 17 }, (_, i) => ({
        deliverable: "app",
        version: `1.0.${i}`,
      })),
    ]) {
      const res = await post("uploads", {
        objects: [{ sha256: WEB_SHA, size: WEB.length }],
        releases,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: "bad_releases" });
    }
  });
});

describe("POST /release/publish/submit — the release record", () => {
  it("stores a valid record exactly as sent, keyed by its SHA-256; its builds equal the descriptor's", async () => {
    const s = await staged();
    const d = descriptor("1.3.0", s.seq);
    const jws = await signRecord(recordFor(d, { seq: s.seq, issuedAt: NOW }));
    const res = await post("submit", {
      ticket: s.ticket,
      descriptor: d,
      record: jws,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      ok: true,
      outcome: "created",
      record: { sha256: sha(jws), stored: true },
    });
    const row = await db.first<Record<string, unknown>>(
      "SELECT * FROM release_records WHERE product = ?",
      SLUG,
    );
    expect(row).toMatchObject({
      deliverable_id: "app",
      release_id: "app@1.3.0",
      seq: 1,
      kind: "app",
      record_sha256: sha(jws),
      kid: RELEASE_KID,
      jws,
    });
    // It verifies against the release key alone, with the typ, and passes the v4 claims.
    const v = await verifyJws(
      jws,
      { [RELEASE_KID]: RELEASE_PUB },
      { typ: "pkey-release+jws" },
    );
    expect(v).not.toBeNull();
    expect(
      releaseRecordClaims(v!.payload, {
        expectedAud: SLUG,
        nonWire: v!.nonWireIntegers,
      }),
    ).toBe(true);
    const payload = v!.payload as Record<string, any>;
    expect(payload.builds.map((b: any) => b.id)).toEqual(["web", "ios"]);
    expect(payload.builds[1].artifacts).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain("locations");
  });

  it("a dry run checks the record and stores nothing", async () => {
    const s = await staged();
    const d = descriptor("1.3.0", s.seq);
    const jws = await signRecord(recordFor(d, { seq: s.seq, issuedAt: NOW }));
    const res = await post("submit", {
      ticket: s.ticket,
      descriptor: d,
      record: jws,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      dryRun: true,
      record: { sha256: sha(jws), kid: RELEASE_KID },
    });
    expect(await counts()).toEqual({ releases: 0, records: 0 });
  });

  it("a submit without a record still publishes (a product not yet signing records)", async () => {
    const s = await staged();
    const res = await post("submit", {
      ticket: s.ticket,
      descriptor: descriptor("1.3.0", s.seq),
    });
    expect(res.status).toBe(200);
    expect(await counts()).toEqual({ releases: 1, records: 0 });
  });

  const REFUSALS: {
    reason: string;
    status: number;
    make: (seq: number) => Promise<{ descriptor: unknown; record: unknown }>;
  }[] = [
    {
      reason: "typ",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        return {
          descriptor: d,
          record: await signRecord(recordFor(d, { seq, issuedAt: NOW }), {
            typ: "pkey-feed+jws",
          }),
        };
      },
    },
    {
      reason: "typ",
      status: 400,
      make: async (seq) => ({
        descriptor: descriptor("1.3.0", seq),
        record: "not-a-jws",
      }),
    },
    {
      // A key the product does not declare (the rotation key, undeclared here).
      reason: "kid",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        return {
          descriptor: d,
          record: await signRecord(recordFor(d, { seq, issuedAt: NOW }), {
            pem: RELEASE_PEM_2027,
            kid: RELEASE_KID_2027,
          }),
        };
      },
    },
    {
      // Bad signature: signed by the 2027 key under the declared 2026 kid.
      reason: "signature",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        return {
          descriptor: d,
          record: await signRecord(recordFor(d, { seq, issuedAt: NOW }), {
            pem: RELEASE_PEM_2027,
          }),
        };
      },
    },
    {
      // Wrong aud: a record for another product.
      reason: "claims",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        return {
          descriptor: d,
          record: await signRecord({
            ...recordFor(d, { seq, issuedAt: NOW }),
            aud: "other",
          }),
        };
      },
    },
    {
      // A fractional integer claim: refused by the claims, decided from the token.
      reason: "claims",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        return {
          descriptor: d,
          record: await signRecord({
            ...recordFor(d, { seq, issuedAt: NOW }),
            issuedAt: NOW + 0.5,
          }),
        };
      },
    },
    {
      // P2-04's descriptor grammar accepts `1.3.0-01`; SemVer 2.0's (the clients') does not.
      reason: "scheme",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0-01", seq);
        return {
          descriptor: d,
          record: await signRecord(recordFor(d, { seq, issuedAt: NOW })),
        };
      },
    },
    {
      // A hash mismatch: the record names other bytes for the web payload.
      reason: "descriptor-mismatch",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        const r = recordFor(d, { seq, issuedAt: NOW }) as any;
        r.builds[0].artifacts[0].sha256 = "a".repeat(64);
        return { descriptor: d, record: await signRecord(r) };
      },
    },
    {
      // A size mismatch.
      reason: "descriptor-mismatch",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        const r = recordFor(d, { seq, issuedAt: NOW }) as any;
        r.builds[0].artifacts[0].size += 1;
        return { descriptor: d, record: await signRecord(r) };
      },
    },
    {
      // A build the descriptor does not have.
      reason: "descriptor-mismatch",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        const r = recordFor(d, { seq, issuedAt: NOW }) as any;
        r.builds.pop();
        return { descriptor: d, record: await signRecord(r) };
      },
    },
    {
      // A descriptor without its explicit seq: the ingest would number the release itself, and a
      // concurrent publish could leave the release stored without its record.
      reason: "descriptor-mismatch",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0");
        return {
          descriptor: d,
          record: await signRecord(recordFor(d, { seq, issuedAt: NOW })),
        };
      },
    },
    {
      // The descriptor's seq and the record's differ.
      reason: "descriptor-mismatch",
      status: 400,
      make: async (seq) => {
        const d = descriptor("1.3.0", seq);
        return {
          descriptor: d,
          record: await signRecord(
            recordFor(descriptor("1.3.0", seq + 4), {
              seq: seq + 4,
              issuedAt: NOW,
            }),
          ),
        };
      },
    },
  ];

  it("a non-increasing seq (another publish took it) is refused seq_not_increasing and stores nothing of the release", async () => {
    // Both CI runs asked the upload route before either submitted: both were answered seq 1.
    const a = await staged("1.2.0");
    const b = await staged("1.3.0");
    expect([a.seq, b.seq]).toEqual([1, 1]);
    const da = descriptor("1.2.0", a.seq);
    const first = await post("submit", {
      ticket: a.ticket,
      descriptor: da,
      record: await signRecord(recordFor(da, { seq: a.seq, issuedAt: NOW })),
    });
    expect(first.status).toBe(200);
    const db_ = descriptor("1.3.0", b.seq);
    const second = await post("submit", {
      ticket: b.ticket,
      descriptor: db_,
      record: await signRecord(recordFor(db_, { seq: b.seq, issuedAt: NOW })),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ reason: "seq_not_increasing" });
    expect(await counts()).toEqual({ releases: 1, records: 1 });
    const audits = await db.all<{ target_id: string }>(
      "SELECT target_id FROM audit WHERE product = ? AND action = 'release.publish'",
      SLUG,
    );
    expect(audits).toEqual([{ target_id: "app@1.2.0" }]);
    // The ticket was never claimed, so the retry (asking again: seq 2) goes through.
    const again = await staged("1.3.0");
    expect(again.seq).toBe(2);
    const dc = descriptor("1.3.0", again.seq);
    const retry = await post("submit", {
      ticket: again.ticket,
      descriptor: dc,
      record: await signRecord(
        recordFor(dc, { seq: again.seq, issuedAt: NOW }),
      ),
    });
    expect(retry.status).toBe(200);
    expect(await counts()).toEqual({ releases: 2, records: 2 });
  });

  for (const r of REFUSALS) {
    it(`refuses release_record_rejected (${r.reason}) and stores nothing`, async () => {
      const s = await staged();
      const { descriptor: d, record } = await r.make(s.seq);
      const res = await post("submit", {
        ticket: s.ticket,
        descriptor: d,
        record,
      });
      expect(res.status).toBe(r.status);
      expect(await res.json()).toMatchObject({
        error: "release_record_rejected",
        reason: r.reason,
      });
      expect(await counts()).toEqual({ releases: 0, records: 0 });
      // Nothing was promoted either: the record is checked before anything is.
      expect(r2.has(`blobs/sha256/${WEB_SHA}`)).toBe(false);
    });
  }

  it("refuses a release key that is a product signing key (product-key)", async () => {
    // Stored directly: the sync would never write it (release_key_is_product_key).
    await db.run(
      "UPDATE release_config SET release_keys_json = ? WHERE product = ?",
      JSON.stringify([{ kid: "pkey-test-prod-2026", publicKey: TEST_PUB }]),
      SLUG,
    );
    const s = await staged();
    const d = descriptor("1.3.0", s.seq);
    const jws = await signRecord(recordFor(d, { seq: s.seq, issuedAt: NOW }), {
      kid: "pkey-test-prod-2026",
    });
    const res = await post("submit", {
      ticket: s.ticket,
      descriptor: d,
      record: jws,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "release_record_rejected",
      reason: "product-key",
    });
    expect(await counts()).toEqual({ releases: 0, records: 0 });
  });

  it("a product with no releaseKeys accepts no record (kid)", async () => {
    await db.run(
      "UPDATE release_config SET release_keys_json = NULL WHERE product = ?",
      SLUG,
    );
    const s = await staged();
    const d = descriptor("1.3.0", s.seq);
    const res = await post("submit", {
      ticket: s.ticket,
      descriptor: d,
      record: await signRecord(recordFor(d, { seq: s.seq, issuedAt: NOW })),
    });
    expect(await res.json()).toMatchObject({ reason: "kid" });
  });

  it("never rewrites a record: a re-run of the same release keeps the first one", async () => {
    const s = await staged();
    const d = descriptor("1.3.0", s.seq);
    const first = await signRecord(recordFor(d, { seq: s.seq, issuedAt: NOW }));
    expect(
      (await post("submit", { ticket: s.ticket, descriptor: d, record: first }))
        .status,
    ).toBe(200);
    const again = await staged();
    const second = await signRecord(
      recordFor(d, { seq: again.seq, issuedAt: NOW + 60 }),
    );
    const res = await post("submit", {
      ticket: again.ticket,
      descriptor: d,
      record: second,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      outcome: "unchanged",
      record: { sha256: sha(first), stored: false },
    });
    expect(await counts()).toEqual({ releases: 1, records: 1 });
  });

  it("stores a record for a release published earlier without one (a re-run once releaseKeys exist)", async () => {
    const s = await staged();
    const d = descriptor("1.3.0", s.seq);
    expect(
      (await post("submit", { ticket: s.ticket, descriptor: d })).status,
    ).toBe(200);
    const again = await staged();
    const jws = await signRecord(
      recordFor(d, { seq: again.seq, issuedAt: NOW }),
    );
    const res = await post("submit", {
      ticket: again.ticket,
      descriptor: d,
      record: jws,
    });
    expect(await res.json()).toMatchObject({
      outcome: "unchanged",
      record: { sha256: sha(jws), stored: true },
    });
  });
});

describe("declared release keys at sync", () => {
  it("refuses a release key equal to a product signing key, current or retired, and keeps the previous set", async () => {
    const ok = await releaseKeysForSync(db, SLUG, [
      { kid: RELEASE_KID, publicKey: RELEASE_PUB },
    ]);
    expect(ok).toEqual({ ok: true, json: releaseKeysJson() });
    const refused = await releaseKeysForSync(db, SLUG, [
      { kid: RELEASE_KID, publicKey: RELEASE_PUB },
      { kid: "oops", publicKey: TEST_PUB },
    ]);
    expect(refused).toMatchObject({
      ok: false,
      refused: [{ kid: "oops", code: "release_key_is_product_key" }],
    });
    // A key the same batch mints (a link's first signing key) counts too.
    const minted = await releaseKeysForSync(
      db,
      SLUG,
      [{ kid: RELEASE_KID, publicKey: RELEASE_PUB }],
      [RELEASE_PUB],
    );
    expect(minted.ok).toBe(false);
  });

  it("discovery's fingerprints are lowercase hex SHA-256 of the raw keys", async () => {
    const raw = Buffer.from(RELEASE_PUB, "base64url");
    expect(
      await releaseKeyFingerprints({ release_keys_json: releaseKeysJson() }),
    ).toEqual([sha(raw)]);
  });

  it("records the declared keys as release-purpose key observations, never as inventory entries", async () => {
    const stmts = releaseKeyObservationStatements(parsed(), SLUG, NOW);
    await db.batch(stmts);
    await db.batch(stmts); // idempotent
    const rows = await db.all<Record<string, unknown>>(
      "SELECT purpose, fingerprint_sha256, source FROM dist_keys WHERE product = ?",
      SLUG,
    );
    expect(rows).toEqual([
      {
        purpose: "release",
        fingerprint_sha256: sha(Buffer.from(RELEASE_PUB, "base64url")),
        source: "ci",
      },
    ]);
  });
});
