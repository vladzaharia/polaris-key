/**
 * The App Store Connect budget meter (P5-02's rate budget, moved into Core by A-17a; notes/S-14
 * §5.5, THREAT-MODEL control (f)).
 *
 * Apple meters **per key** over a rolling hour and reports it on every response:
 * `X-Rate-Limit: user-hour-lim:3600;user-hour-rem:…` (measured, A-17h). The client parses it into
 * `AscClient.lastRate`; this module keeps the last observation in KV between runs:
 *
 *   - a product's OWN key has a slot in the product's namespace (`p:<slug>:asc-rate:<id>`);
 *   - the platform TEAM key has ONE platform-wide slot (`plat:asc-rate:app-store.api-key`, outside
 *     the `p:` namespace no slug can reach), because every product that falls back to the team
 *     key, the 15-minute P5-02 poller, A-16's app listing and A-17's flows all spend that one
 *     budget.
 *
 * `budgetAllows` decides who may spend what is left, so a provisioning flow cannot starve every
 * product's poller and a poller can never block an operator:
 *
 *   share left    poll (P5-02)          background (wizard polling, resumes)   operator
 *   ≥ 20 %        every step            yes                                    yes
 *   5–20 %        phased-release step   no                                     yes
 *   < 5 %         nothing               no                                     yes
 *
 * Nothing known (no observation in the last hour) counts as a full budget. The meter is advisory:
 * a KV failure never blocks a call; Apple's own 429 is the hard limit.
 */

import type { Env } from "../platform.js";
import { kvKey } from "../platform.js";
import type { AscRate } from "./client.js";

/** Whose budget a call spends: a product's own key, or the platform team key. */
export type AscBudgetKey =
  | { source: "product"; credentialId: string }
  | { source: "platform" };

/** The last `X-Rate-Limit` seen for a key, and when. */
export interface StoredRate extends AscRate {
  at: number;
}

/** The limit is a rolling hour; an observation older than that says nothing. */
export const RATE_WINDOW = 3600;

/** The team key's one platform-wide slot. */
export const TEAM_RATE_KEY = "plat:asc-rate:app-store.api-key";

function rateKey(product: string, key: AscBudgetKey): string {
  return key.source === "product"
    ? kvKey(product, "asc-rate", key.credentialId)
    : TEAM_RATE_KEY;
}

export async function readRate(
  env: Env,
  product: string,
  key: AscBudgetKey,
  now: number,
): Promise<StoredRate | null> {
  try {
    const raw = await env.HOT.get(rateKey(product, key));
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
  key: AscBudgetKey,
  rate: AscRate | null,
  now: number,
): Promise<void> {
  if (!rate) return;
  try {
    await env.HOT.put(
      rateKey(product, key),
      JSON.stringify({ ...rate, at: now }),
      { expirationTtl: RATE_WINDOW },
    );
  } catch {
    /* the budget is advisory */
  }
}

/** Keep the team key's budget after a team-wide call (the apps listing, provisioning). */
export function recordTeamRate(
  env: Env,
  rate: AscRate | null,
  now: number,
): Promise<void> {
  return writeRate(env, "", { source: "platform" }, rate, now);
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

/**
 * Who is spending: the P5-02 `poll`, `background` work no operator is waiting on step by step
 * (the New-app wizard's 10-second app detection, a resumed flow), or an `operator` pressing a
 * control (never refused by the meter).
 */
export type AscSpend = "poll" | "background" | "operator";

/** Whether `spend` may call now. `poll` callers use `pollBudget` for the finer answer. */
export function budgetAllows(rate: AscRate | null, spend: AscSpend): boolean {
  if (spend === "operator") return true;
  const level = pollBudget(rate);
  if (spend === "poll") return level !== "skip";
  return level === "full";
}
