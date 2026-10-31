/**
 * The Play Games verifier for the token exchange (I-14.7, WIRE-CONTRACT-V5 §12.11.7).
 *
 * Core's `redeemAndVerify` redeems the server auth code and asks Google which player and
 * application it was granted to; this module turns that answer into the identity the exchange looks
 * a link up for, or into one of the two refusals the exchange answers:
 *
 * - `invalid_grant`: the setup, the code or Google's answer for the application is refused. One
 *   answer for all of them, so the cause is not told to the caller;
 * - `unavailable`: Google was unreachable or failed.
 *
 * **Link key.** `(pgs, 'pgs-app:<applicationId>', player_id)`. When no link is found under that id
 * and Google sent an `alternate_player_id`, the lookup tries it too (`findPgsLink`). The scope is
 * per application, so a player id from one game never matches another game's link. The email is
 * null and the reach is `developer`.
 *
 * **Tokens.** The access token and any refresh token stay inside Core's redeemer and are dropped
 * there; this module sees neither, and it logs and audits nothing. Only the reason is returned,
 * never Core's detail.
 *
 * Wiring the exchange route, the link offer and discovery is I-14.8.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { redeemAndVerify } from "../../../core/stores/playGames/serverAuth.js";
import type { OidcFetch } from "../../../core/oidc/client.js";
import type { PlatformSignInAudiences } from "../platformSignIn.js";

/** The account link's issuer key for Play Games: the provider kind. */
export const PGS_ISSUER_KEY = "pgs";

/** The tenant scope a Play Games link is stored under. */
export const pgsScope = (applicationId: string): string =>
  `pgs-app:${applicationId}`;

export interface PlayGamesIdentity {
  kind: "pgs";
  issuerKey: typeof PGS_ISSUER_KEY;
  /** Google's `player_id`. */
  subject: string;
  /** Google's `alternate_player_id`, tried after `subject` finds no link. */
  alternateSubject: string | null;
  /** The one scope to look the link up under. */
  tenantScopes: [string];
  email: null;
  emailVerified: false;
  reach: "developer";
}

export type PlayGamesOutcome =
  | { ok: true; identity: PlayGamesIdentity }
  | { ok: false; reason: "invalid_grant" | "unavailable" | "rate_limited" };

export interface PlayGamesVerifyOpts {
  /** Unix seconds. */
  now?: number;
  fetchImpl?: OidcFetch;
}

/** Verify a server auth code for `product` against its Play Games settings. */
export async function verifyPlayGamesCode(
  env: Env,
  db: Db,
  product: string,
  audiences: PlatformSignInAudiences,
  code: string,
  opts: PlayGamesVerifyOpts = {},
): Promise<PlayGamesOutcome> {
  const { applicationId, serverClientId } = audiences.playGames;
  if (!applicationId || !serverClientId)
    return { ok: false, reason: "invalid_grant" };
  const r = await redeemAndVerify(env, db, {
    product,
    applicationId,
    serverClientId,
    code,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  return {
    ok: true,
    identity: {
      kind: "pgs",
      issuerKey: PGS_ISSUER_KEY,
      subject: r.playerId,
      alternateSubject: r.alternatePlayerId,
      tenantScopes: [pgsScope(applicationId)],
      email: null,
      emailVerified: false,
      reach: "developer",
    },
  };
}

/**
 * Look a link up by `player_id`, then by the alternate id. `find` is the caller's lookup for one
 * subject; the first hit wins, and the subject that hit is returned with it.
 */
export async function findPgsLink<T>(
  identity: Pick<PlayGamesIdentity, "subject" | "alternateSubject">,
  find: (subject: string) => Promise<T | null>,
): Promise<{ subject: string; found: T } | null> {
  const subjects = [identity.subject];
  if (
    identity.alternateSubject !== null &&
    identity.alternateSubject !== identity.subject
  )
    subjects.push(identity.alternateSubject);
  for (const subject of subjects) {
    const found = await find(subject);
    if (found !== null) return { subject, found };
  }
  return null;
}
