// I-09: the manifest's `identity:` block at link and resync (plans/I-27.md §3). The row-backed
// settings (`identity.keyEntry.limit`, `identity.terms`, `identity.redirectPaths`) become claimable
// `product_settings` rows whatever Identity's enablement; `identity.keyEntry.claimByKey` reaches its
// column (`portal_product_settings.claim_by_key`) only while Identity is on. A console claim is
// never overwritten, and an undeclared claimByKey leaves the column alone.

import { describe, expect, it } from "vitest";
import { parseManifest, type ParsedManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct, setClaimByKey } from "./seed.js";
import type { Db } from "../src/db/types.js";
import { identityService } from "../src/services/identity/index.js";

const SCHEMA = JSON.stringify({ schemaVersion: 1, entries: [] });

function parsed(identity: unknown, modules?: unknown): ParsedManifest {
  const res = parseManifest({
    product: JSON.stringify({
      slug: "acme",
      name: "Acme",
      modules: modules ?? {
        license: { enabled: true },
        identity: { enabled: true },
      },
      web: { origins: ["https://app.acme.example"] },
      ...(identity === undefined ? {} : { identity }),
    }),
    schema: SCHEMA,
  });
  if (!res.ok) throw new Error(res.errors.join("; "));
  return res.manifest;
}

/** What Core runs at an ingest: every service's always-statements, then the enabled ones'. */
async function ingest(db: Db, m: ParsedManifest, at = NOW): Promise<void> {
  const always = identityService.manifestIngestAlways?.(m, "acme", at) ?? [];
  const enabled = m.services.identity.enabled
    ? (identityService.manifestIngest?.(m, "acme", at) ?? [])
    : [];
  await db.batch([...always, ...enabled]);
}

async function row(db: Db, key: string) {
  return db.first<{ value_json: string; source: string }>(
    "SELECT value_json, source FROM product_settings WHERE product = 'acme' AND key = ?",
    key,
  );
}

async function claimByKey(db: Db): Promise<number | null> {
  return (
    (
      await db.first<{ claim_by_key: number }>(
        "SELECT claim_by_key FROM portal_product_settings WHERE product = 'acme'",
      )
    )?.claim_by_key ?? null
  );
}

const BLOCK = {
  keyEntry: { limit: 3, claimByKey: true },
  terms: { version: "2026-10", url: "https://acme.example/terms" },
  redirectPaths: ["/auth/callback"],
};

describe("the identity block at link and resync (I-09)", () => {
  it("writes the claimable rows and claimByKey's column", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await ingest(db, parsed(BLOCK));
    expect(await row(db, "identity.keyEntry.limit")).toEqual({
      value_json: "3",
      source: "manifest",
    });
    expect(JSON.parse((await row(db, "identity.terms"))!.value_json)).toEqual(
      BLOCK.terms,
    );
    expect(
      JSON.parse((await row(db, "identity.redirectPaths"))!.value_json),
    ).toEqual(["/auth/callback"]);
    expect(await claimByKey(db)).toBe(1);
    // One audit row for the column's change; none when a resync repeats it.
    const audits = async () =>
      (
        await db.all<{ target_id: string }>(
          "SELECT target_id FROM audit WHERE product = 'acme' AND action = 'setting.resync' AND target_id = 'identity.keyEntry.claimByKey'",
        )
      ).length;
    expect(await audits()).toBe(1);
    await ingest(db, parsed(BLOCK), NOW + 1);
    expect(await audits()).toBe(1);
  });

  it("omit-clears the rows, but leaves an undeclared claimByKey as it is", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await ingest(db, parsed(BLOCK));
    await ingest(db, parsed(undefined), NOW + 1);
    expect(await row(db, "identity.keyEntry.limit")).toBeNull();
    expect(await row(db, "identity.terms")).toBeNull();
    // The console's value from before the block existed is not reset by a resync.
    expect(await claimByKey(db)).toBe(1);
    await ingest(db, parsed({ keyEntry: { claimByKey: false } }), NOW + 2);
    expect(await claimByKey(db)).toBe(0);
  });

  it("writes claimByKey only while Identity is on", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await ingest(db, parsed(BLOCK, { license: { enabled: true } }));
    // The rows are ready for when Identity is turned on; the claim rule (read for every product)
    // does not change.
    expect(await row(db, "identity.keyEntry.limit")).not.toBeNull();
    expect(await claimByKey(db)).toBeNull();
  });

  it("never overwrites a console claim", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await setClaimByKey(db, "acme", false);
    for (const key of [
      "identity.keyEntry.claimByKey",
      "identity.keyEntry.limit",
    ])
      await db.run(
        `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
         VALUES ('acme', ?, ?, 'console', ?, 'op')`,
        key,
        key === "identity.keyEntry.limit" ? "50" : null,
        NOW,
      );
    await ingest(db, parsed(BLOCK), NOW + 1);
    expect(await claimByKey(db)).toBe(0);
    expect(await row(db, "identity.keyEntry.limit")).toEqual({
      value_json: "50",
      source: "console",
    });
  });
});
