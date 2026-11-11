/**
 * I-21.15: a manifest apply audits the registered clients it changes: one `identity.clients` row
 * (`setting.resync`), the declared set before and after, as `identity.provisioning` does. The console
 * records its own client changes; this is the manifest's side. An unchanged manifest writes nothing.
 */
import { describe, expect, it } from "vitest";
import type { ParsedManifest } from "@polaris-key/manifest";
import { identityManifest } from "../../../../src/services/identity/ingest.js";
import type { IngestContext } from "../../../../src/core/ingest/types.js";
import type { Db } from "../../../../src/db/types.js";
import { makeTestDb } from "../../../helpers.js";
import { NOW, seedProduct } from "../../../seed.js";

const client = (over: Record<string, unknown> = {}) => ({
  key: "forum",
  name: "Forum",
  type: "spa",
  redirectUris: ["https://forum.example.net/cb"],
  postLogoutRedirectUris: [],
  scopes: ["openid", "profile"],
  claimsRequired: ["name"],
  ...over,
});

/** One apply of `clients`, as Core runs it: the contributor's statements and audit rows in a batch. */
async function apply(db: Db, clients: unknown[], at: number): Promise<void> {
  const manifest = {
    identity: { clients },
    provisioning: [],
  } as unknown as ParsedManifest;
  const ctx = {
    db,
    mode: "apply",
    scope: "product",
    slug: "acme",
    manifest,
    now: at,
    source: { sha: "0123456789abcdef0123" },
    enabled: true,
  } as unknown as IngestContext;
  const out = await identityManifest.prepare(ctx);
  await db.batch([...out.statements, ...out.audits]);
}

/** The audit rows with the structured `{ effective }` sides unwrapped. */
async function rows(db: Db) {
  const all = await db.all<{ before_json: string; after_json: string }>(
    `SELECT before_json, after_json FROM audit
      WHERE product = 'acme' AND target_id = 'identity.clients' ORDER BY at, id`,
  );
  const side = (j: string) => (JSON.parse(j) as { effective: any }).effective;
  return all.map((r) => ({
    before: side(r.before_json),
    after: side(r.after_json),
  }));
}

describe("the manifest's client audit", () => {
  it("records a declared client, a change, a dropped client, and nothing for a repeat", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await apply(db, [client()], NOW);
    let all = await rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.before).toEqual([]);
    expect(all[0]!.after).toMatchObject([
      {
        key: "forum",
        name: "Forum",
        type: "spa",
        scopes: ["openid", "profile"],
      },
    ]);
    // An unchanged resync writes none.
    await apply(db, [client()], NOW + 1);
    expect(await rows(db)).toHaveLength(1);
    // A changed redirect and scope.
    await apply(
      db,
      [
        client({
          redirectUris: ["https://forum.example.net/cb2"],
          scopes: ["openid"],
        }),
      ],
      NOW + 2,
    );
    all = await rows(db);
    expect(all).toHaveLength(2);
    expect(all[1]!.before[0].redirectUris).toEqual([
      "https://forum.example.net/cb",
    ]);
    expect(all[1]!.after[0].redirectUris).toEqual([
      "https://forum.example.net/cb2",
    ]);
    // The file drops it: the declared set goes empty, and a repeat of that is quiet.
    await apply(db, [], NOW + 3);
    all = await rows(db);
    expect(all).toHaveLength(3);
    expect(all[2]!.after).toEqual([]);
    await apply(db, [], NOW + 4);
    expect(await rows(db)).toHaveLength(3);
  });

  it("holds no secret, id or token: names and addresses the developer declared only", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await apply(db, [client()], NOW);
    const text = JSON.stringify(await rows(db));
    expect(text).not.toMatch(/cl_[A-Za-z0-9_-]{22}|pkeycs_|pkeyo_/);
  });
});
