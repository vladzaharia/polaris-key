/**
 * What a `.pkey/` push may not rewrite on its own, and what it leaves a trace of.
 *
 *   - the Sparkle verification key (the update feed's trust anchor): a push may set it where none
 *     is stored and clear it, but may not swap it in one step, and the refusal precedes every
 *     write, so nothing else in the refused manifest lands either;
 *   - the audit trail: every manifest-written field a resync changes (the release block, the
 *     compat window, the OIDC row, provisioning, service enablement) leaves one `setting.resync`
 *     row naming it, an unchanged manifest leaves none, a field an operator owns leaves none, and
 *     a key is never logged (only whether it is set);
 *   - a value that cannot be sealed is refused rather than stored in cleartext.
 *
 * Every case drives the real path: `linkRepo` registers the product from a stubbed GitHub and
 * `resyncRepo` re-reads a changed `.pkey/`.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { TEST_RSA_PKCS8 } from "../../releaseFixtures.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import type { FetchImpl } from "../../../src/services/release/githubApp.js";
import { linkRepo } from "../../../src/services/release/linkRepo.js";
import { resyncRepo } from "../../../src/services/release/resync.js";
import { planResync } from "../../../src/services/release/linkExisting.js";
import { getReleaseConfig } from "../../../src/services/release/config.js";
import { sealedProfilePayload } from "../../../src/core/ingest/manifestSecrets.js";
import { ingestFor } from "../../../src/core/ingest/pipeline.js";
import { SERVICES } from "../../../src/mount.js";
import { withDefaultHead } from "../../githubHead.js";

const SLUG = "acme";
const KEY_A = "AAAA1111";
const KEY_B = "BBBB2222";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

/** A linked product: its database and the environment it was linked in. */
interface Ctx {
  db: Db;
  env: Env;
}

interface Over {
  release?: Record<string, unknown>;
  product?: Record<string, unknown>;
}

function docs(over: Over = {}): Record<string, string> {
  return {
    ".pkey/schema.json": JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          key: "run.name",
          kind: "config",
          category: "general",
          label: "run.name",
          description: "",
          schema: { type: "string" },
        },
      ],
    }),
    ".pkey/product.json": JSON.stringify({
      slug: SLUG,
      name: "Acme",
      compatMin: "1.0.0",
      compatMax: "9.0.0",
      defaultMaxOfflineDays: 14,
      defaultDeviceLimit: 3,
      profiles: [{ id: "standard", name: "standard" }],
      tiers: [{ id: "standard", label: "Standard", profileId: "standard" }],
      provisioning: [],
      ...over.product,
    }),
    ".pkey/release.json": JSON.stringify({
      release: {
        ghOwner: "acme-org",
        ghRepo: "acme-app",
        binaryName: "acme",
        betaBranch: "main",
        summaryMarker: "pkey:summary",
        sparkleEd25519Pub: KEY_A,
        ...over.release,
      },
    }),
  };
}

/** GitHub, stubbed: installation discovery, the token exchange, `.pkey/` contents, releases. */
function github(over: Over = {}): FetchImpl {
  const files = docs(over);
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files)) {
        if (url.includes(`/contents/${path}`)) {
          const content = Buffer.from(body, "utf8").toString("base64");
          return new Response(JSON.stringify({ content, encoding: "base64" }), {
            status: 200,
          });
        }
      }
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases?per_page"))
      return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

async function linked(over: Over = {}): Promise<Ctx> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  const res = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    NOW,
    github(over),
    ingestFor(SERVICES),
  );
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return { db, env };
}

function resync(ctx: Ctx, over: Over = {}, at = NOW + 60) {
  return resyncRepo(
    ctx.env,
    ctx.db,
    SLUG,
    at,
    github(over),
    ingestFor(SERVICES),
  );
}

interface AuditRow {
  target_id: string;
  summary: string;
  before_json: string | null;
  after_json: string | null;
}

/** Every `setting.resync` audit row the product has, by key. */
function resyncAudits(ctx: Ctx): Promise<AuditRow[]> {
  return ctx.db.all<AuditRow>(
    `SELECT target_id, summary, before_json, after_json FROM audit
      WHERE product = ? AND action = 'setting.resync' ORDER BY target_id, at`,
    SLUG,
  );
}

const keysOf = (rows: AuditRow[]) => rows.map((r) => r.target_id);

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("a push cannot swap the Sparkle verification key", () => {
  it("refuses a replacement and writes nothing else of the manifest", async () => {
    const ctx = await linked();
    expect((await getReleaseConfig(ctx.db, SLUG))?.sparkle_ed25519_pub).toBe(
      KEY_A,
    );

    const res = await resync(ctx, {
      release: { sparkleEd25519Pub: KEY_B, binaryName: "acme-two" },
    });

    expect(res.ok).toBe(false);
    const error = !res.ok ? res.error : "";
    // The refusal names the key and, since nothing else can write it, how to rotate on purpose.
    expect(error).toContain("Sparkle public key");
    expect(error).toContain("removed");
    const cfg = await getReleaseConfig(ctx.db, SLUG);
    expect(cfg?.sparkle_ed25519_pub).toBe(KEY_A);
    expect(cfg?.binary_name).toBe("acme");
    expect(await resyncAudits(ctx)).toEqual([]);
  });

  it("the resync dry run lists the refusal as what blocks the resync", async () => {
    const ctx = await linked();

    const plan = await planResync(
      ctx.env,
      ctx.db,
      SLUG,
      NOW + 60,
      github({ release: { sparkleEd25519Pub: KEY_B } }),
      ingestFor(SERVICES),
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(
      plan.plan.conflicts.some(
        (c) => c.area === "release" && c.summary.includes("Sparkle public key"),
      ),
    ).toBe(true);
  });

  it("allows the same key, clearing it, and setting one where none is stored", async () => {
    const ctx = await linked();

    expect((await resync(ctx)).ok).toBe(true);
    expect(await resyncAudits(ctx)).toEqual([]);

    const cleared = await resync(
      ctx,
      { release: { sparkleEd25519Pub: undefined } },
      NOW + 120,
    );
    expect(cleared.ok).toBe(true);
    expect((await getReleaseConfig(ctx.db, SLUG))?.sparkle_ed25519_pub).toBe(
      null,
    );

    const set = await resync(
      ctx,
      { release: { sparkleEd25519Pub: KEY_B } },
      NOW + 180,
    );
    expect(set.ok).toBe(true);
    expect((await getReleaseConfig(ctx.db, SLUG))?.sparkle_ed25519_pub).toBe(
      KEY_B,
    );

    // Each step left a row, and the rows say whether a key is set, never which key.
    const rows = await resyncAudits(ctx);
    expect(keysOf(rows)).toEqual([
      "release.sparkleEd25519Pub",
      "release.sparkleEd25519Pub",
    ]);
    expect(rows.map((r) => [r.before_json, r.after_json])).toEqual([
      ['{"effective":{"set":true}}', '{"effective":{"set":false}}'],
      ['{"effective":{"set":false}}', '{"effective":{"set":true}}'],
    ]);
    for (const row of rows) {
      const all = JSON.stringify(row);
      expect(all).not.toContain(KEY_A);
      expect(all).not.toContain(KEY_B);
    }
  });
});

describe("a resync leaves one audit row per manifest-written field it changes", () => {
  it("an unchanged manifest writes none", async () => {
    const ctx = await linked();

    expect((await resync(ctx)).ok).toBe(true);
    expect((await resync(ctx, {}, NOW + 120)).ok).toBe(true);

    expect(await resyncAudits(ctx)).toEqual([]);
  });

  it("names each changed field of the release block, the compat window and the access modes once", async () => {
    const ctx = await linked();

    const res = await resync(ctx, {
      release: {
        binaryName: "acme-two",
        betaBranch: "dev",
        summaryMarker: "pkey:notes",
        channelWorkflow: "channel.yml",
        manualChannels: [{ name: "nightly", regex: "v.*-nightly" }],
        access: { metadata: "licensed", artifacts: "licensed" },
      },
      product: { compatMin: "1.1.0" },
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const keys = keysOf(await resyncAudits(ctx));
    expect([...keys].sort()).toEqual(
      [
        "distribution.access",
        "release.betaBranch",
        "release.binaryName",
        "release.channelWorkflow",
        "release.compatWindow",
        "release.manualChannels",
        "release.summaryMarker",
        "update.metadataAccess",
      ].sort(),
    );
    // The key the push did not touch is not named.
    expect(keys).not.toContain("release.sparkleEd25519Pub");
  });

  it("names the OIDC row, the provisioning hooks and the service set, and only when they change", async () => {
    const ctx = await linked();
    const extras = (entitlementValue: boolean): Over => ({
      product: {
        oidc: {
          provider: "platform",
          redirectUris: ["https://app.acme.example/cb"],
        },
        provisioning: [
          { claim: "plan", entitlementKey: "pro", entitlementValue },
        ],
        modules: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
        },
      },
    });

    const first = await resync(ctx, extras(true));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect([...keysOf(await resyncAudits(ctx))].sort()).toEqual([
      "core.services",
      "identity.oidc",
      "identity.provisioning",
    ]);

    // The same manifest again changes nothing, so adds nothing.
    expect((await resync(ctx, extras(true), NOW + 120)).ok).toBe(true);
    expect(await resyncAudits(ctx)).toHaveLength(3);

    // One changed hook is one more row.
    expect((await resync(ctx, extras(false), NOW + 180)).ok).toBe(true);
    const rows = await resyncAudits(ctx);
    expect(rows).toHaveLength(4);
    expect(
      rows.filter((r) => r.target_id === "identity.provisioning"),
    ).toHaveLength(2);
  });

  it("leaves no row for a field an operator owns", async () => {
    const ctx = await linked();
    await ctx.db.run(
      "UPDATE products SET services_source = 'admin' WHERE slug = ?",
      SLUG,
    );
    await ctx.db.run(
      "UPDATE release_config SET access_source = 'admin' WHERE product = ?",
      SLUG,
    );
    // The artifacts mode is owned by Distribution's own row, which is what the ingest guards.
    await ctx.db.run(
      "UPDATE dist_access SET source = 'admin' WHERE product = ? AND deliverable_id = 'app'",
      SLUG,
    );

    const res = await resync(ctx, {
      release: { access: { metadata: "licensed", artifacts: "licensed" } },
      product: {
        modules: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
        },
      },
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    expect(await resyncAudits(ctx)).toEqual([]);
  });

  it("audits the delivery-access row the ingest moves, from and to, once; never an unchanged or operator-owned one", async () => {
    const ctx = await linked();
    const mode = () =>
      ctx.db.first<{ mode: string }>(
        "SELECT mode FROM dist_access WHERE product = ? AND deliverable_id = 'app'",
        SLUG,
      );
    const accessRows = async () =>
      (await resyncAudits(ctx)).filter(
        (r) => r.target_id === "distribution.access",
      );
    const licensed = { release: { access: { artifacts: "licensed" } } };

    expect((await resync(ctx, licensed)).ok).toBe(true);
    expect((await mode())?.mode).toBe("licensed");
    expect(
      (await accessRows()).map((r) => [r.before_json, r.after_json]),
    ).toEqual([['{"effective":"public"}', '{"effective":"licensed"}']]);

    // The same manifest again moves nothing, so adds nothing.
    expect((await resync(ctx, licensed, NOW + 120)).ok).toBe(true);
    expect(await accessRows()).toHaveLength(1);

    // An operator claim stops the ingest, and with it the audit row for a write it skipped.
    await ctx.db.run(
      "UPDATE dist_access SET source = 'admin' WHERE product = ? AND deliverable_id = 'app'",
      SLUG,
    );
    const open = { release: { access: { artifacts: "public" } } };
    expect((await resync(ctx, open, NOW + 180)).ok).toBe(true);
    expect((await mode())?.mode).toBe("licensed");
    expect(await accessRows()).toHaveLength(1);
  });
});

describe("a secret that cannot be sealed is refused, never stored in cleartext", () => {
  it("sealedProfilePayload refuses without a KEK", async () => {
    // An Env with no `PLATFORM_KEK*` at all: sealing throws, and the ingest turns that into a
    // refusal instead of writing the value through.
    const noKek = {} as Env;
    const res = await sealedProfilePayload(
      noKek,
      SLUG,
      "standard",
      { secrets: { "api.key": { state: "enforced", value: "plain-value" } } },
      () => true,
      null,
    );

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("cannot seal");
    expect(JSON.stringify(res)).not.toContain("plain-value");
  });
});
