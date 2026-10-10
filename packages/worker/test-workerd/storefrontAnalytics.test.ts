/// <reference types="@cloudflare/workers-types" />
// ── The storefront's impression count on miniflare's D1 (PS-04) ─────────────────────────────
//
// The Node lane (`test/portalStorefront.test.ts`) covers the rules against better-sqlite3. This
// file runs the one batch `recordImpressions` writes against the real D1, which is what proves the
// part better-sqlite3 could get wrong: that D1 applies the migration, and that inside a D1 batch
// each counter upsert's `changes()` reads the dedupe insert just before it, so a product counts
// once per account and day however often it is shown.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  recordImpressions,
  storefrontDay,
} from "../src/services/identity/portal/store/analytics.js";
import { D1Db } from "../src/db/d1.js";
import type { Env as WorkerEnv } from "../src/platform/env.js";
import { NOW } from "./seed.js";

const LANE = { timeout: 60_000 };

function lane(): { env: WorkerEnv; db: D1Db } {
  return {
    env: {
      ...(env as unknown as WorkerEnv),
      KEY_HASH_PEPPER: "workerd-storefront-pepper",
    },
    db: new D1Db(env.DB),
  };
}

describe("storefront impressions on D1", LANE, () => {
  it("counts each product once per account and day, in one batch", async () => {
    const { env: e, db } = lane();
    const shown = [
      { product: "moss", kind: "auto_issue" as const },
      { product: "open", kind: "open" as const },
    ];
    await recordImpressions(e, db, "acct_one", shown, NOW);
    await recordImpressions(e, db, "acct_one", shown, NOW + 60);
    await recordImpressions(e, db, "acct_two", shown.slice(0, 1), NOW + 120);
    const rows = await db.all<{
      product: string;
      path_kind: string;
      impressions: number;
    }>(
      "SELECT product, path_kind, impressions FROM storefront_daily WHERE day = ? ORDER BY product",
      storefrontDay(NOW),
    );
    expect(rows).toEqual([
      { product: "moss", path_kind: "auto_issue", impressions: 2 },
      { product: "open", path_kind: "open", impressions: 1 },
    ]);
    const seen = await db.all<{ account_key: string }>(
      "SELECT account_key FROM storefront_seen",
    );
    expect(seen).toHaveLength(3);
    for (const { account_key } of seen)
      expect(account_key).toMatch(/^[0-9a-f]{32}$/);
  });
});
