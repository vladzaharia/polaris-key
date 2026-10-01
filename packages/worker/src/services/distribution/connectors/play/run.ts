/**
 * Building one Google Play connector run (P5-03): the setup and clients whose bearer tokens come
 * from P5-01's `googleAccessToken` — cached sealed in KV per scope and credential version, the
 * credential opened (and audited under `use`) only on a miss. The connector never sees the
 * service-account key; it reaches the credential only through that helper, which calls
 * `openOutletCredential`.
 */

import type { Db, Env } from "../../../../core/platform.js";
import type { ServiceHooks } from "../../../../core/hooks.js";
import { googleAccessToken } from "../../../../core/outletTokens.js";
import { recordOutletCredentialResult } from "../../../../core/outletCredentials.js";
import {
  ANDROID_PUBLISHER_ORIGIN,
  ANDROID_PUBLISHER_SCOPE,
  GoogleApiClient,
  PLAY_REPORTING_ORIGIN,
  PLAY_REPORTING_SCOPE,
  PlayError,
  PlayPublisher,
  type FetchImpl,
} from "./client.js";
import type { PlaySetup } from "./setup.js";

/** Everything one connector run needs: one product, one setup, the clients. */
export interface PlayRun {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  setup: PlaySetup;
  publisher: PlayPublisher;
  /** The Reporting API client; built lazily, so a run with vitals off never mints its token. */
  reporting(): GoogleApiClient;
  /** Requests sent by every client of this run. */
  calls(): number;
}

/** The audited `use` of the Reporting API token's open. */
export const PLAY_VITALS_USE = "play:vitals";

export interface PlayRunOptions {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  setup: PlaySetup;
  /** The audited `use` of a token-minting open for the Android Publisher API: `play:poll` or
   *  `play:control`. The Reporting API token is always minted under `play:vitals`. */
  use: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

export function playRun(o: PlayRunOptions): PlayRun {
  const token = (scope: string, use: string) => () =>
    googleAccessToken(
      o.env,
      o.db,
      o.product,
      o.setup.credentialId,
      [scope],
      use,
      o.now,
      o.fetchImpl ?? ((u, i) => fetch(u, i)),
    );
  const common = {
    packageName: o.setup.packageName,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  };
  const publisher = new PlayPublisher(
    new GoogleApiClient({
      ...common,
      origin: ANDROID_PUBLISHER_ORIGIN,
      token: token(ANDROID_PUBLISHER_SCOPE, o.use),
    }),
  );
  let reporting: GoogleApiClient | null = null;
  return {
    env: o.env,
    db: o.db,
    product: o.product,
    hooks: o.hooks,
    now: o.now,
    setup: o.setup,
    publisher,
    reporting() {
      reporting ??= new GoogleApiClient({
        ...common,
        origin: PLAY_REPORTING_ORIGIN,
        token: token(PLAY_REPORTING_SCOPE, PLAY_VITALS_USE),
      });
      return reporting;
    },
    calls() {
      return publisher.calls + (reporting?.calls ?? 0);
    },
  };
}

/** A status line safe to store and show: a `PlayError` or token-exchange message (both carry an
 *  HTTP status only), else a generic line. */
export function errorLine(e: unknown): string {
  if (e instanceof PlayError) return e.message;
  if (e instanceof Error && e.message.startsWith("google token "))
    return e.message;
  return "Google Play run failed";
}

/** Record a run's outcome on the credential's health columns. */
export async function finishRun(run: PlayRun, error: unknown): Promise<void> {
  if (run.calls() === 0 && !error) return;
  await recordOutletCredentialResult(
    run.db,
    run.product,
    run.setup.credentialId,
    error ? { ok: false, error: errorLine(error) } : { ok: true },
    run.now,
  );
}
