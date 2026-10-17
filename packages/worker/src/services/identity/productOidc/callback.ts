/// <reference types="@cloudflare/workers-types" />

import { activateFromIdentity } from "./activate.js";
import {
  checkAuthorizationIss,
  discover,
  exchangeCode,
  OidcGrantRefusedError,
  OidcNetworkError,
  verifyIdToken,
  type DiscoveredIssuer,
} from "../../../core/oidc/client.js";
import { representabilityIssue } from "@polaris-key/catalog";
import { hashKey } from "../../../platform/crypto.js";
import { platformOidcConfig } from "../../../platform/platformOidc.js";
import { type Env } from "../../../platform/env.js";
import { parseFlowRecord } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import { type Product } from "../../../core/products.js";
import { errorResponse } from "../../../core/errors.js";
import { clientNetwork } from "../../../core/rateLimit.js";
import { getLicense } from "../../../core/licensing/store.js";
import {
  createBrowserSession,
  type BrowserSessionSubject,
} from "../browserSession.js";
import { readBinder } from "../licenseChoice.js";
import {
  attachClaimedLicenses,
  claimPlatformSubject,
  platformSignInEnded,
  platformSubjectStanding,
  platformSubjectLink,
} from "../accounts/platformMigration.js";
import {
  deleteArtefact,
  getArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { legacyRelyingParty } from "./browserFlow.js";
import { beginLicenseChoice } from "./chooser.js";
import {
  type FlowRecord,
  type ResolvedOidcConfig,
  flowKey,
  rateLimited,
  redirectUriAllowed,
  resolveOidcConfig,
} from "./config.js";
import {
  type OidcIdentity,
  getOidcConfig,
  identityRefusal,
} from "../../../core/licensing/issue.js";
import {
  joinOfferNotice,
  platformSignInEndedPage,
  productAccountDisabledPage,
  signedInPage,
} from "./pages.js";

export function mapClaims(payload: Record<string, unknown>): OidcIdentity {
  const groups = Array.isArray(payload.groups)
    ? (payload.groups.filter((g) => typeof g === "string") as string[])
    : [];
  // Only a VERIFIED email is trusted: this value is persisted on the license, signed into the
  // config document's identity profile, and is what the portal auto-links accounts on. An
  // unverified claim is attacker-chosen, so we store nothing rather than that (R8-05b).
  //
  // Both are signed into the licence document's profile, so a value no signed document could
  // carry (a lone surrogate, plans/P3-01.md §2.2) is stored as null rather than refused: the
  // provider chose it, the user cannot fix it, and sign-in should still succeed.
  const verifiedEmail =
    payload.email_verified === true && typeof payload.email === "string"
      ? payload.email
      : undefined;
  const email =
    verifiedEmail !== undefined && representabilityIssue(verifiedEmail) === null
      ? verifiedEmail
      : undefined;
  const rawName =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() ||
    (email ?? "");
  const name = representabilityIssue(rawName) === null ? rawName : "";
  return {
    // No String() coercion: a non-string `sub` is a type-confusion hazard (123 vs "123"), and
    // an empty one collapses every such identity onto a single license row (R8-05a). The
    // caller rejects the empty result — see handleAuthCallback.
    sub: typeof payload.sub === "string" ? payload.sub : "",
    email,
    name: name || undefined,
    groups,
    claims: payload,
  };
}

/** GET /<product>/identity/auth/callback — exchange the code, verify the ID token, mint a license. */
export async function handleAuthCallback(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state)
    return errorResponse(400, "bad_request", "missing code/state");
  const limited = await rateLimited(
    env,
    product,
    now,
    {
      bucket: "authCallback",
      id: clientNetwork(req),
      limit: 60,
      windowSec: 60,
    },
    { bucket: "authCallbackState", id: state, limit: 5, windowSec: 60 },
  );
  if (limited) return limited;
  const stateKey = await flowKey(env, product.slug, state);
  // The browser binder is checked BEFORE the single-use claim, so a
  // callback from another browser neither finishes the flow nor burns it.
  const pending = await getArtefact(env, stateKey);
  const pendingFlow = pending ? parseFlowRecord<FlowRecord>(pending) : null;
  const callbackBinder = readBinder(req);
  if (
    !pendingFlow?.binder ||
    !callbackBinder ||
    (await hashKey(callbackBinder, env.KEY_HASH_PEPPER)) !== pendingFlow.binder
  )
    return errorResponse(400, "bad_request", "unknown state");
  // Single-use state (R8-04). Claim the flow before any outbound call so a second callback
  // can never overwrite the license a poller is already waiting on; a replay gets exactly the
  // same generic answer as an unknown state. The claim is one atomic compare-and-set in the
  // single-use store (G15): of two racing callbacks, exactly one sees `consumedAt` absent.
  const claim = await updateArtefact(env, stateKey, {
    expect: { consumedAt: null },
    set: { consumedAt: now },
  });
  if (!claim.ok || !claim.payload)
    return errorResponse(400, "bad_request", "unknown state");
  const flow = parseFlowRecord<FlowRecord>(claim.payload);
  if (!flow) {
    await deleteArtefact(env, stateKey);
    return errorResponse(400, "bad_request", "unknown state");
  }
  const oidc = await resolveOidcConfig(env, db, product);
  if (oidc instanceof Response) {
    await deleteArtefact(env, stateKey);
    return oidc;
  }
  // Defense in depth: the stored flow's redirect_uri must still be allow-listed.
  if (!redirectUriAllowed(oidc.row, flow.redirectUri)) {
    await deleteArtefact(env, stateKey);
    return errorResponse(400, "bad_request", "redirect_uri not allow-listed");
  }
  // I-17: past the sunset the platform IdP signs no end user in; no code is exchanged for one.
  if (
    (oidc.row.provider ?? "platform") === "platform" &&
    platformSignInEnded(env, now)
  ) {
    await deleteArtefact(env, stateKey);
    return platformSignInEndedPage();
  }

  // I-30: the one relying-party client. Discovery, the token POST (it carries the client
  // secret; the issuer may be repo-written) and the JWKS all go through its gated fetch: https,
  // the issuer's host only, no redirects, a timeout and a byte cap; keys are verified with
  // `createLocalJWKSet`, and RFC 9207's `iss` is checked when the IdP sends one.
  const rp = legacyRelyingParty(oidc);
  let discovered: DiscoveredIssuer;
  let idToken: string;
  try {
    discovered = await discover(rp);
  } catch {
    await deleteArtefact(env, stateKey);
    return errorResponse(502, "oidc_error", "token exchange failed");
  }
  try {
    checkAuthorizationIss(discovered, url.searchParams.get("iss"));
  } catch {
    await deleteArtefact(env, stateKey);
    return errorResponse(401, "unauthorized", "id token invalid");
  }
  try {
    idToken = (
      await exchangeCode(discovered, rp, {
        code,
        redirectUri: flow.redirectUri,
        codeVerifier: flow.verifier,
      })
    ).id_token;
  } catch (err) {
    // Delete the flow rather than recording a reason — pollers must not be able to
    // enumerate IdP failure modes (D8). The poll surface returns a generic error.
    await deleteArtefact(env, stateKey);
    return errorResponse(
      502,
      "oidc_error",
      err instanceof OidcNetworkError || err instanceof OidcGrantRefusedError
        ? "token exchange failed"
        : "no id_token",
    );
  }
  let claims: Record<string, unknown>;
  try {
    // Reject unconditionally on a missing or mismatched nonce — a token with no nonce must
    // never satisfy the binding to this flow (replay / token-injection defense).
    claims = (await verifyIdToken(discovered, rp, idToken, {
      audience: oidc.clientId,
      nonce: flow.nonce,
    })) as Record<string, unknown>;
  } catch {
    await deleteArtefact(env, stateKey);
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  // An identity with no subject is not an identity: `getLicenseBySub(…, "")` would match every
  // other subject-less row, so distinct people would share one license. Admin and portal both
  // reject this already (console/auth.ts:216, portal/auth.ts:280) — so does the product flow now
  // (R8-05a). Same generic 401 as any other bad ID token.
  const identity = mapClaims(claims);
  if (!identity.sub) {
    await deleteArtefact(env, stateKey);
    return errorResponse(401, "unauthorized", "id token invalid");
  }

  // N9 (the I-17 review): a subject whose Polaris Key account can no longer sign in (disabled,
  // or its deletion under way, or erased and brought back by a D1 restore: I-11's ledger) does not
  // sign in to a product either, in every migration mode and whichever way the flow would end
  // (the claim, I-26's chooser, the device-code poll, a new or existing `sub`-keyed licence).
  // Refused before any of them, so nothing is minted or written; the flow is dropped, so the poll
  // then answers `timeout`. A subject with no account signs in exactly as before.
  if (
    await signInAccountRefused(
      env,
      db,
      oidc.row.provider,
      oidc.issuer,
      identity.sub,
      now,
    )
  ) {
    await deleteArtefact(env, stateKey);
    return productAccountDisabledPage(product, flow);
  }

  // I-17: moving end users off the platform IdP. With `PLATFORM_OIDC_MIGRATION` off (the
  // default) this writes nothing and the sign-in continues exactly as before.
  const migration = await migratePlatformSubject(
    env,
    db,
    product,
    oidc,
    stateKey,
    flow,
    identity,
    now,
  );
  if (migration instanceof Response) return migration;

  // The callback never claims, migrates or disables an existing license (P1-06 security fix).
  // The only flows that carry a device id are device-code flows (`/device/start`; a record
  // with `deviceId` but no `viaDeviceCode` predates the marker and is the same kind of flow),
  // and a device-code flow is confirmed with the PUBLIC user code — read off a stream, a photo
  // or guessed. Applying the device's enrolled license here let whoever confirmed first and
  // signed in under their own identity take the victim device's anonymous license (claim) or
  // retire it into theirs (migrate). So a device-code sign-in yields exactly what an ordinary
  // sign-in for that identity yields: its own license (`getLicenseBySub`) or a new one under
  // the existing group/default-tier policy. Attaching the device's anonymous license to the
  // account is P1-07's opt-in, applied at `/device/poll` by the device-code holder after the
  // player accepts the signed-in identity on the device. A browser-redirect flow carries no
  // device id and so never merged; its behaviour is unchanged.
  //
  // So a flow `/device/start` began does not activate here at all (P1-07). The callback checks,
  // read-only, that activation would succeed (so the browser still hears "not entitled" at
  // once), stores the verified identity on the flow and stops: no licence row is created,
  // claimed or changed until the device-code holder polls. That keeps the claim case possible
  // for the opt-in (an identity with no licence yet takes over the device's anonymous row in
  // place, instead of being handed a fresh row it would then have to abandon), and it keeps the
  // decision with the only party that holds the device code.
  // I-26: on a `provider: platform` product, a person whose Polaris Key account already owns a
  // usable licence chooses which one this device uses; nothing is minted here. Without the
  // trigger this returns null and the sign-in continues exactly as before.
  const chooser = await beginLicenseChoice(
    req,
    env,
    db,
    product,
    oidc,
    state,
    stateKey,
    flow,
    identity,
    now,
  );
  if (chooser) return chooser;

  if (flow.viaDeviceCode) {
    if (await identityRefusal(db, product, identity, now)) {
      await deleteArtefact(env, stateKey);
      return errorResponse(403, "forbidden", "not entitled");
    }
    flow.identity = identity;
    await updateArtefact(env, stateKey, { set: { identity } });
    return signedInPage([], migration.notice);
  }
  const result = await activateFromIdentity(db, product, identity, now, {
    env,
  });
  if ("error" in result) {
    // Failed activation: drop the flow so the poller gets a generic error, not the reason.
    await deleteArtefact(env, stateKey);
    return errorResponse(403, "forbidden", "not entitled");
  }
  if (flow.claimAccount)
    await attachClaimedLicenses(db, flow.claimAccount, now);
  return completeBrowserFlow(
    req,
    env,
    db,
    product,
    stateKey,
    flow,
    result.licenseId,
    identity.sub,
    now,
    [],
    migration.notice,
  );
}

/**
 * I-17's claim at a product callback (`accounts/platformMigration.ts`). Only a `provider:
 * platform` product's sign-in is the platform IdP's; a custom-issuer product never claims.
 *
 *   - past the sunset, or `operators-only` and the subject holds no method: the flow is dropped
 *     and the browser told this way of signing in has ended (the poll then answers `timeout`);
 *   - signed in: the account is kept on the flow, so the licence this flow activates attaches;
 *   - a join offer: the sign-in completes as before, and the page offers the join on the portal,
 *     where the email step asks for proof of the other account (product routes never see the
 *     account realm's cookies, so the offer cannot open here);
 *   - a disabled account (N9): the flow is dropped and the browser told this account can't sign
 *     in. The callback's own check refuses it first; this covers an account disabled between the
 *     two reads;
 *   - anything else (`off`, an ambiguous email): exactly as before.
 */
export async function migratePlatformSubject(
  env: Env,
  db: Db,
  product: Product,
  oidc: ResolvedOidcConfig,
  stateKey: ArtefactRef,
  flow: FlowRecord,
  identity: OidcIdentity,
  now: number,
): Promise<Response | { notice: string | null }> {
  if ((oidc.row.provider ?? "platform") !== "platform") return { notice: null };
  const groups = identity.claims.groups;
  const claim = await claimPlatformSubject(
    db,
    env,
    {
      issuer: oidc.issuer,
      sub: identity.sub,
      // `mapClaims` keeps only a verified address, so its presence is the verification.
      email: identity.email ?? null,
      emailVerified: identity.email !== undefined,
      displayName: identity.name ?? null,
      groups: Array.isArray(groups)
        ? groups.filter((g): g is string => typeof g === "string")
        : undefined,
      product: product.slug,
    },
    now,
  );
  switch (claim.status) {
    case "ended":
      await deleteArtefact(env, stateKey);
      return platformSignInEndedPage();
    case "signed_in":
      flow.claimAccount = claim.result.account.id;
      await updateArtefact(env, stateKey, {
        set: { claimAccount: claim.result.account.id },
      });
      return { notice: null };
    case "join_offer":
      return { notice: joinOfferNotice(claim.email) };
    case "refused":
      if (claim.result.reason === "account_disabled") {
        await deleteArtefact(env, stateKey);
        return productAccountDisabledPage(product, flow);
      }
      return { notice: null };
    default:
      return { notice: null };
  }
}

/**
 * N9: whether this product sign-in's subject belongs to a Polaris Key account that can no longer
 * sign in (`platformSubjectStanding`: anything but `allowed` refuses, so an erasure ledger that
 * cannot be read refuses too). Only a `provider: platform` product's subject is the platform
 * IdP's, the one a Polaris Key account holds; a custom issuer's subject resolves no account, so
 * its sign-in is unchanged.
 */
export async function signInAccountRefused(
  env: Env,
  db: Db,
  provider: string | null,
  issuer: string,
  sub: string,
  now: number,
): Promise<boolean> {
  if ((provider ?? "platform") !== "platform") return false;
  return (
    (await platformSubjectStanding(env, db, issuer, sub, now)) !== "allowed"
  );
}

/**
 * What a browser session opened by this sign-in is bound to: on a `provider: platform` product,
 * the platform-IdP subject itself (N9's check runs on it at every read, so an account it joins
 * or is moved to later counts too) and the account holding its method now, if any (kept for
 * erasure, which deletes the method); otherwise nothing. The session then ends when either can
 * no longer sign in (`loadBrowserSession`); a custom issuer's subject opens a session bound to
 * nothing, as before. Read-only, and like {@link pollAccountRefused} it reads the provider from
 * the product's row and the issuer from the Worker's secrets.
 */
export async function browserSessionBinding(
  env: Env,
  db: Db,
  product: Product,
  sub: string,
): Promise<{
  subject: BrowserSessionSubject;
  accountId: string | null;
} | null> {
  const row = await getOidcConfig(db, product.slug);
  if ((row?.provider ?? "platform") !== "platform") return null;
  const platform = platformOidcConfig(env);
  if (!platform) return null;
  const link = await platformSubjectLink(db, platform.issuer, sub);
  return {
    subject: { issuer: platform.issuer, sub: sub.trim() },
    accountId: link?.account_id ?? null,
  };
}

/**
 * The end of a browser-redirect flow once its licence is known: a `returnTo` flow gets the
 * browser session and a redirect back; any other gets `licenseId` recorded for the poll and the
 * "signed in" page. Shared by the callback and the licence chooser's choice (I-26).
 */
export async function completeBrowserFlow(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  stateKey: ArtefactRef,
  flow: FlowRecord,
  licenseId: string,
  /** The verified subject that signed in: a `returnTo` flow's browser session is bound to it
   *  and to its account, if it has one ({@link browserSessionBinding}). */
  sub: string,
  now: number,
  extraCookies: string[] = [],
  /** I-17: TRUSTED markup the "signed in" page adds (the join offer); a `returnTo` flow has no
   *  page to show it on. */
  notice: string | null = null,
): Promise<Response> {
  flow.licenseId = licenseId;
  if (flow.returnTo) {
    const license = await getLicense(db, product.slug, licenseId);
    if (!license) {
      await deleteArtefact(env, stateKey);
      return errorResponse(401, "unauthorized", "license unavailable");
    }
    const binding = await browserSessionBinding(env, db, product, sub);
    const session = await createBrowserSession(
      env,
      db,
      product,
      license,
      now,
      req,
      {
        subject: binding?.subject ?? null,
        accountId: binding?.accountId ?? null,
      },
    );
    await deleteArtefact(env, stateKey);
    if (!session.ok) {
      return errorResponse(
        session.status,
        session.code,
        session.message,
        session.extra,
      );
    }
    const headers = new Headers({ location: flow.returnTo });
    headers.append("set-cookie", session.cookie);
    for (const c of extraCookies) headers.append("set-cookie", c);
    // 302 from the callback (a GET), as before; the chooser's POST answers 303.
    return new Response(null, {
      status: req.method === "POST" ? 303 : 302,
      headers,
    });
  }
  await updateArtefact(env, stateKey, { set: { licenseId } });
  return signedInPage(extraCookies, notice);
}
