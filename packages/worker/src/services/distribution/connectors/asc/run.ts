/**
 * Building one App Store Connect connector run (P5-02): the setup, a client whose bearer token
 * comes from P5-01's `ascToken` (memoised per isolate, the credential opened — and audited under
 * `use` — only on a miss), and the per-key rate budget kept in KV between runs (Core's meter,
 * `core/storefront/budget.ts`).
 */

import type { Db, Env } from "../../../../core/platform.js";
import type { ServiceHooks } from "../../../../core/hooks.js";
import { ascToken, platformAscToken } from "../../../../core/outletTokens.js";
import { recordOutletCredentialResult } from "../../../../core/outletCredentials.js";
import { recordPlatformCredentialResult } from "../../../../core/platformCredentials.js";
import {
  AscClient,
  AscError,
  AscWriteDenied,
  type FetchImpl,
} from "../../../../core/asc/client.js";
import { writeRate } from "../../../../core/storefront/budget.js";
import type { AscRun } from "./apply.js";
import { ASC_PLATFORM_CREDENTIAL, type AscSetup } from "./setup.js";

export interface AscRunOptions {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  setup: AscSetup;
  /** The audited `use` of a token-minting open: `asc:poll`, `asc:webhook`, `asc:control`. */
  use: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

export function ascRun(o: AscRunOptions): AscRun {
  const cred = o.setup.credential;
  const client = new AscClient({
    // A-16: the platform team key is minted only for the app this product's platform pin names
    // (`platformAscToken` checks it before its memo; the open checks it again).
    token: () =>
      cred.source === "product"
        ? ascToken(o.env, o.db, o.product, cred.credentialId, o.use, o.now)
        : platformAscToken(
            o.env,
            o.db,
            { product: o.product, pin: o.setup.appleId },
            o.use,
            o.now,
          ),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  return {
    env: o.env,
    db: o.db,
    product: o.product,
    hooks: o.hooks,
    now: o.now,
    setup: o.setup,
    client,
  };
}

// ── The rate budget ──────────────────────────────────────────────────────────────────────────
// The meter itself is Core's (`core/storefront/budget.ts`, A-17a), shared with the platform team key's
// listing and A-17's provisioning flows; a product key's slot and the team key's one slot are
// chosen there from the setup's credential reference.

/** Record a run's outcome on the credential's health columns and keep its rate budget. */
export async function finishRun(run: AscRun, error: unknown): Promise<void> {
  const cred = run.setup.credential;
  await writeRate(
    run.env,
    "app-store",
    run.product,
    cred,
    run.client.lastRate,
    run.now,
  );
  // A write-gate refusal is the Worker's own decision, not the credential's health.
  if (run.client.calls === 0 && (!error || error instanceof AscWriteDenied))
    return;
  const result = error
    ? {
        ok: false as const,
        error:
          error instanceof AscError
            ? error.message
            : "App Store Connect run failed",
      }
    : { ok: true as const };
  if (cred.source === "product")
    await recordOutletCredentialResult(
      run.db,
      run.product,
      cred.credentialId,
      result,
      run.now,
    );
  else
    await recordPlatformCredentialResult(
      run.db,
      ASC_PLATFORM_CREDENTIAL,
      result,
      run.now,
    );
}
