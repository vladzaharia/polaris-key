/**
 * The `--person` run's account (F-33b.6, plans/F-33b-ST-30c-slices.md §2): one account holding a
 * usable licence in `acme` and in `bolt` and none in `cove`, and one `pkeyp_` `packages:read`
 * token for it, minted through `core/accounts/personalTokens.ts` (what the portal and the console
 * call) into the local D1. Run by `run.mjs` with tsx, after the owners exist:
 *
 *   tsx scripts/registry-clients/person/seed.ts --persist-to <state> --out <file> --holds acme,bolt
 *
 * The token goes to `--out` (a file in the throwaway state directory, mode 600), never to stdout:
 * a run's log carries no credential. KEY_HASH_PEPPER (env) is the pepper the Worker is started with.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { D1Db } from "../../../src/db/d1.ts";
import { insertLicense } from "../../../src/core/licensing/store.ts";
import {
  PACKAGES_READ_SCOPE,
  mintAccountToken,
} from "../../../src/core/accounts/personalTokens.ts";
import type { Env } from "../../../src/platform/env.ts";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const state = argValue("--persist-to");
const out = argValue("--out");
const holds = (argValue("--holds") ?? "").split(",").filter(Boolean);
const pepper = process.env.KEY_HASH_PEPPER;
if (!state || !out || !pepper) {
  console.error(
    "usage: KEY_HASH_PEPPER=… person/seed.ts --persist-to <dir> --out <file> --holds a,b",
  );
  process.exit(2);
}

const proxy = await getPlatformProxy<Env>({
  environment: "test",
  persist: { path: join(state, "v3") },
});
try {
  const db = new D1Db(proxy.env.DB as unknown as D1Database);
  const env = { ...proxy.env, KEY_HASH_PEPPER: pepper } as Env;
  const now = Math.floor(Date.now() / 1000);
  const accountId = "acct_person_harness";
  await db.run(
    "INSERT INTO accounts (id, created_at, modified_at) VALUES (?, ?, ?)",
    accountId,
    now,
    now,
  );
  for (const product of holds) {
    const id = `lic_person_${product}`;
    await insertLicense(db, {
      product,
      id,
      status: "active",
      sub: null,
      name: "Harness Person",
      email: "person@example.com",
      groups_json: null,
      tier_id: null,
      activated_at: now,
      expires_at: null,
      max_offline_days: null,
      overrides_json: null,
      channels_json: null,
      min_version: null,
      max_version: null,
      modified_by: null,
      modified_at: now,
    });
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      accountId,
      product,
      id,
    );
  }
  const minted = await mintAccountToken(
    env,
    db,
    {
      accountId,
      label: "registry-clients harness",
      scope: PACKAGES_READ_SCOPE,
      expiresInDays: 1,
      createdBy: `portal:${accountId}`,
    },
    now,
  );
  if (!minted.ok) throw new Error(`mint refused: ${minted.reason}`);
  writeFileSync(out, minted.token, { mode: 0o600 });
  console.log(
    `seeded one account with a licence in ${holds.join(" and ")} and a packages:read personal token`,
  );
} finally {
  await proxy.dispose();
}
