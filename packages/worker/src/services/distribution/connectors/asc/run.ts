/**
 * Building one App Store Connect connector run (P5-02): the setup, a client whose bearer token
 * comes from P5-01's `ascToken` (memoised per isolate, the credential opened — and audited under
 * `use` — only on a miss), and the per-key rate budget kept in KV between runs.
 */

import type { Db, Env } from "../../../../core/platform.js";
import { kvKey } from "../../../../core/platform.js";
import type { ServiceHooks } from "../../../../core/hooks.js";
import { ascToken, platformAscToken } from "../../../../core/outletTokens.js";
import { recordOutletCredentialResult } from "../../../../core/outletCredentials.js";
import { recordPlatformCredentialResult } from "../../../../core/platformCredentials.js";
import { AscClient, AscError, type AscRate, type FetchImpl } from "./client.js";
import type { AscRun } from "./apply.js";
import {
  ASC_PLATFORM_CREDENTIAL,
  type AscCredentialRef,
  type AscSetup,
} from "./setup.js";

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

/** The last `X-Rate-Limit` seen for a key, and when. */
export interface StoredRate extends AscRate {
  at: number;
}

/** The limit is a rolling hour; an observation older than that says nothing. */
const RATE_WINDOW = 3600;

/** Apple's budget is per KEY: a product key's budget is the product's, while the platform team
 *  key's is shared by every product that falls back to it, so it has one platform-wide slot
 *  (outside the `p:` product namespace, which no slug can reach). */
function rateKey(product: string, cred: AscCredentialRef): string {
  return cred.source === "product"
    ? kvKey(product, "asc-rate", cred.credentialId)
    : `plat:asc-rate:${ASC_PLATFORM_CREDENTIAL}`;
}

export async function readRate(
  env: Env,
  product: string,
  cred: AscCredentialRef,
  now: number,
): Promise<StoredRate | null> {
  try {
    const raw = await env.HOT.get(rateKey(product, cred));
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredRate;
    if (
      typeof v.limit !== "number" ||
      typeof v.remaining !== "number" ||
      typeof v.at !== "number" ||
      now - v.at > RATE_WINDOW
    )
      return null;
    return v;
  } catch {
    return null;
  }
}

export async function writeRate(
  env: Env,
  product: string,
  cred: AscCredentialRef,
  rate: AscRate | null,
  now: number,
): Promise<void> {
  if (!rate) return;
  try {
    await env.HOT.put(
      rateKey(product, cred),
      JSON.stringify({ ...rate, at: now }),
      { expirationTtl: RATE_WINDOW },
    );
  } catch {
    /* the budget is advisory */
  }
}

/**
 * How much the poller may spend, from the remaining share of the hourly limit:
 *
 *   - `full`    ≥ 20 % left (or nothing known): every step;
 *   - `reduced` 5–20 % left: the phased-release step only (nothing else has an operator waiting
 *               on it minute by minute; webhooks still arrive);
 *   - `skip`    < 5 % left: nothing this tick. Controls an operator presses are never skipped.
 */
export type PollBudget = "full" | "reduced" | "skip";

export function pollBudget(rate: AscRate | null): PollBudget {
  if (!rate || rate.limit <= 0) return "full";
  const share = rate.remaining / rate.limit;
  if (share < 0.05) return "skip";
  if (share < 0.2) return "reduced";
  return "full";
}

/** Record a run's outcome on the credential's health columns and keep its rate budget. */
export async function finishRun(run: AscRun, error: unknown): Promise<void> {
  const cred = run.setup.credential;
  await writeRate(run.env, run.product, cred, run.client.lastRate, run.now);
  if (run.client.calls === 0 && !error) return;
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
