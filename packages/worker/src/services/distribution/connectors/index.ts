/**
 * Store connectors (P5-02 on; README §3.8 "Connectors and credential custody").
 *
 * A connector keeps Distribution's availability, submissions and staged rollouts in step with
 * one store, from that store's own API: App Store Connect (`asc/`, P5-02), Google Play (`play/`,
 * P5-03) and the Microsoft Store (`msstore/`, P5-04, read-only). Each is one
 * `DistributionConnector`:
 *
 *   - `poll(ctx)` — run on the connector cron for every product with Distribution on; a product
 *     the connector is not set up for (no outlet of its kinds, no credential) is skipped before
 *     any call. Answers what it did; it does not throw for one product's failure.
 *   - `webhook(ctx)` — optional: `POST /<product>/distribution/hooks/<kind>`. `null` (Core's
 *     service not-found shape) when the product is not set up for it.
 *   - `controls` — operator actions under `…/distribution/connectors/<kind>/<control>` in the
 *     console API; each audited and followed by a re-read.
 *   - `reads` — optional: `GET …/distribution/connectors/<kind>/<path>`, a live read of the store
 *     for an operator flow (A-17d's Distribute: builds, versions, preflight).
 *   - `status(ctx)` — what the console shows: setup, tracked objects (unresolved ones flagged),
 *     recent events.
 *
 * Credentials are reached only through P5-01: `core/outletCredentials.ts` (`openOutletCredential`,
 * audited) and `core/outletTokens.ts` (cached store tokens). No connector writes a credential.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { ProductPublic } from "../../../core/products.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import type { ServiceContext } from "../../../core/registry.js";
import type { FetchImpl } from "../../../core/asc/client.js";
import type { ConnectorControl, ConnectorRead } from "./asc/controls.js";
import { ascConnector } from "./asc/index.js";
import { msStoreConnector } from "./msstore/index.js";
import { playConnector } from "./play/index.js";

/** What a poll is given: one product, outside any request. */
export interface ConnectorContext {
  env: Env;
  db: Db;
  product: ProductPublic;
  hooks: ServiceHooks;
  now: number;
  /** Injected by tests; the global `fetch` otherwise. */
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

/** What one connector's poll of one product did. */
export interface PollOutcome {
  connector: string;
  /** Why nothing (or less than everything) ran: `not-configured`, `rate-budget`, … */
  skipped?: string;
  /** Store API requests sent. */
  calls: number;
  /** Objects whose state was written. */
  applied: number;
  /** A status line, never a response body. */
  error?: string;
}

export interface DistributionConnector {
  /** The connector kind: the `source` it writes and the path segment it answers on. */
  kind: string;
  label: string;
  /** The outlet kinds it serves. */
  outletKinds: readonly string[];
  poll(ctx: ConnectorContext): Promise<PollOutcome>;
  webhook?(ctx: ServiceContext): Promise<Response | null>;
  controls: Readonly<Record<string, ConnectorControl>>;
  reads?: Readonly<Record<string, ConnectorRead>>;
  status(ctx: {
    env: Env;
    db: Db;
    product: string;
    now: number;
  }): Promise<Record<string, unknown>>;
}

/** Every connector this build has. */
export const CONNECTORS: readonly DistributionConnector[] = [
  ascConnector,
  playConnector,
  msStoreConnector,
];

export function connectorOf(kind: string): DistributionConnector | null {
  return CONNECTORS.find((c) => c.kind === kind) ?? null;
}

/**
 * One poll tick for one product: every connector, fault-isolated (one connector's throw is its
 * own `error`, never another's). Old webhook events are pruned by the nightly maintenance sweep
 * (`scheduled.ts`, step `connectorEvents:<product>`), which reaches every product — deleted and
 * Distribution-off ones included — and not here.
 */
export async function pollConnectors(
  ctx: ConnectorContext,
): Promise<PollOutcome[]> {
  const out: PollOutcome[] = [];
  for (const c of CONNECTORS) {
    try {
      out.push(await c.poll(ctx));
    } catch (e) {
      out.push({
        connector: c.kind,
        calls: 0,
        applied: 0,
        error: e instanceof Error ? e.message : "poll failed",
      });
    }
  }
  return out;
}

export type { ConnectorControl };
