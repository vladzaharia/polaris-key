/// <reference types="@cloudflare/workers-types" />

/**
 * The link offer (I-43.2; WIRE-CONTRACT-V5 §12.11.4): after the regular sign-in, an app offers to
 * add the person's Google or Apple identity to the account, so the next launch signs in silently.
 *
 *     GET  /<p>/identity/link   → {offer: [{kind, reach}]}   empty without a live step-up
 *     POST /<p>/identity/link   ← {linkHandle, proof} | {subjectToken, nonce, signKey, agreeKey, proof}
 *                               → {linked: {kind, reach}}
 *
 * Both take the device bearer and are gated by `launch.identityExchange` (LG-1).
 *
 * ── THE ORDER OF A POST ─────────────────────────────────────────────────────────────────────
 *
 *   shape, limits, the bearer, the proof (it needs no state: purpose `link`, by the device's
 *   registered key, or by the key the body names for a token), the held-key rule, THEN the step-up
 *   is spent (`signin-fresh` for this product and device), THEN the handle is taken, or the nonce
 *   is taken and the token verified, and the link is written.
 *
 * A handle is taken only when its record names this product, this device and the thumbprint of the
 * key that proved the request. A handle alone therefore does nothing: it needs the device's key
 * and a same-device sign-in at most 300 s old. A request that does not match leaves the handle
 * where it is.
 *
 * ── SCOPE (D-A3) ────────────────────────────────────────────────────────────────────────────
 *
 * An app supplies the token, so the token is not trusted to say whose account it is. A Google link
 * is global (tenant scope `''`) only when the provider vouches for the token's address and that
 * address is already verified on this account; otherwise it is scoped to the developer
 * (`google-client:<id>`). An Apple link is always scoped to the team. A scoped link keeps its
 * address unverified, so it brings no licences and joins nothing.
 *
 * ── NO ORACLE ───────────────────────────────────────────────────────────────────────────────
 *
 * Every refusal of the proof, the key, the nonce, the token or the handle's binding is one
 * `400 invalid_grant` with one body. A verifier's message is never logged or audited.
 */

import type {
  ExchangeKind,
  LinkOfferResponse,
  LinkReach,
  LinkResponse,
} from "@polaris-key/protocol/identity";
import { LINK_HANDLE_PATTERN } from "@polaris-key/protocol/identity";
import { OidcNetworkError } from "../../../core/oidc/client.js";
import { sha256B64url } from "../../../platform/hash.js";
import { randomId } from "../../../platform/crypto.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import { appendAudit } from "../../../core/audit.js";
import { BodyTooLargeError, readBodyText } from "../../../core/cappedBody.js";
import {
  ErrorCode,
  json,
  methodNotAllowed,
  notFound,
  wireError,
} from "../../../core/errors.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import { customerOrigin } from "../../../core/hosts.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { getProduct } from "../../../core/products/store.js";
import {
  deviceSignKey,
  validateDeviceKeys,
} from "../../../core/devices/keys.js";
import { verifyDeviceProof } from "../../../core/devices/proof.js";
import { verifiedAccountEmails } from "../../../core/accounts/verifiedEmails.js";
import { consumeArtefact, getArtefact } from "../../../core/singleUse.js";
import { deviceHolder, deviceOf } from "../attach.js";
import { linkIdentity, type LinkResult } from "../accounts/links.js";
import { listLinks } from "../accounts/repo.js";
import {
  readPlatformSignIn,
  type PlatformSignInAudiences,
} from "../platformSignIn.js";
import { verifyNativeToken, type NativeIdentity } from "../providers/native.js";
import { exchangeLinkRef, type ExchangeLinkRecord } from "./exchange.js";
import { freshLive, spendFresh } from "./fresh.js";
import { consumeExchangeNonce, signKeyThumbprint } from "./nonce.js";

/** The link routes: 30 a minute per client network and 10 per device, both failing closed. */
export const LINK_NETWORK_RATE = {
  bucket: "identityLink",
  limit: 30,
  windowSec: 60,
};
export const LINK_DEVICE_RATE = {
  bucket: "identityLinkDevice",
  limit: 10,
  windowSec: 60,
};

const BODY_CAP = 16 * 1024;
const FIELD_MAX = 4096;
const HANDLE = new RegExp(LINK_HANDLE_PATTERN);

const noStore = (res: Response): Response => {
  res.headers.set("cache-control", "no-store");
  res.headers.set("pragma", "no-cache");
  return res;
};

/** The one refusal of every check on the proof, the key, the nonce, the token and the binding. */
const refused = (): Response => noStore(wireError(400, ErrorCode.InvalidGrant));
const stepUp = (): Response => noStore(wireError(401, "step_up_required"));

/** The tenant scopes a product's Google and Apple links live under; empty for a kind it lacks. */
function scopesOf(
  audiences: PlatformSignInAudiences,
): Record<ExchangeKind, string[]> {
  const server = audiences.google.serverClientId;
  const { teamId, bundleIds } = audiences.apple;
  return {
    google: server ? ["", `google-client:${server}`] : [],
    apple: teamId && bundleIds.length > 0 ? [`apple-team:${teamId}`] : [],
    // §12.11.7: the game kinds are wired by I-14.8; until then no scope, so no offer.
    gamecenter: [],
    pgs: [],
  };
}

export async function handleLink(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  // LG-1: with the gate off the route does not exist.
  if (!(await launchGateOn(env, db, "launch.identityExchange")))
    return notFound();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const within = (
    rate: typeof LINK_NETWORK_RATE,
    id: string,
  ): Promise<boolean> => rateLimitOk(env, product.slug, { ...rate, id }, now);
  if (!(await within(LINK_NETWORK_RATE, clientNetwork(req))))
    return noStore(wireError(429, "rate_limited"));
  const auth = await deviceOf(req, env, db, product, now);
  if (auth instanceof Response) return noStore(auth);
  const { deviceId, valid } = auth;
  if (!(await within(LINK_DEVICE_RATE, deviceId)))
    return noStore(wireError(429, "rate_limited"));
  return req.method === "GET"
    ? offer(env, db, product, deviceId, valid.device.subject, now)
    : link(req, env, db, product, deviceId, valid.device.subject, now);
}

/** `GET`: the kinds the person could add, while a same-device sign-in is live. Spends nothing. */
async function offer(
  env: Env,
  db: Db,
  product: Product,
  deviceId: string,
  bound: string | null | undefined,
  now: number,
): Promise<Response> {
  const empty = (): Response =>
    noStore(json({ offer: [] } satisfies LinkOfferResponse));
  if (!(await freshLive(env, product.slug, deviceId, bound))) return empty();
  const holder = await deviceHolder(env, db, product.slug, bound, now);
  if (!holder || holder === "unavailable") return empty();
  const row = await getProduct(db, product.slug);
  if (!row) return empty();
  const scopes = scopesOf(await readPlatformSignIn(db, row));
  const held = await listLinks(db, holder.accountId);
  const out: LinkOfferResponse["offer"] = [];
  for (const kind of ["google", "apple"] as const) {
    if (scopes[kind].length === 0) continue;
    // A link of the kind in any scope of this product ends the offer.
    if (
      held.some((l) => l.kind === kind && scopes[kind].includes(l.tenant_scope))
    )
      continue;
    out.push({ kind, reach: null });
  }
  return noStore(json({ offer: out } satisfies LinkOfferResponse));
}

interface Parsed {
  linkHandle?: string;
  subjectToken?: string;
  nonce?: string;
  signKey?: string;
  agreeKey?: string;
  proof: string;
}

/** The body's one of two shapes, or null. Strings only, each bounded. */
async function parseBody(req: Request): Promise<Parsed | null> {
  let o: unknown;
  try {
    o = JSON.parse(await readBodyText(req, BODY_CAP));
  } catch (e) {
    if (e instanceof BodyTooLargeError) return null;
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof r[k] === "string" && (r[k] as string).length <= FIELD_MAX
      ? (r[k] as string)
      : undefined;
  const proof = str("proof");
  if (!proof) return null;
  const linkHandle = str("linkHandle");
  if (linkHandle !== undefined) {
    // The handle form carries nothing else.
    if (!HANDLE.test(linkHandle) || Object.keys(r).length !== 2) return null;
    return { linkHandle, proof };
  }
  const subjectToken = str("subjectToken");
  const nonce = str("nonce");
  const signKey = str("signKey");
  const agreeKey = str("agreeKey");
  if (!subjectToken || !nonce || !signKey || !agreeKey) return null;
  return { subjectToken, nonce, signKey, agreeKey, proof };
}

/** What a link is made from: the verified identity, however the request carried it. */
interface LinkSource {
  kind: ExchangeKind;
  issuerKey: string;
  subject: string;
  tenantScopes: string[];
  email: string | null;
  emailVerified: boolean;
}

async function link(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  deviceId: string,
  bound: string | null | undefined,
  now: number,
): Promise<Response> {
  const body = await parseBody(req);
  if (!body) return noStore(wireError(400, ErrorCode.BadRequest));
  const held = await deviceSignKey(db, product.slug, deviceId);

  // The proof first: it needs no state, so nobody without the key spends a step-up, a nonce or a
  // handle. A handle names no key, so its proof is by the key the device holds.
  let signKey: string;
  if (body.linkHandle !== undefined) {
    if (held === null) return refused();
    signKey = held;
    if (
      !(await verifyDeviceProof({
        purpose: "link",
        product: product.slug,
        deviceId,
        value: body.linkHandle,
        tokenHash: "-",
        signKey,
        sig: body.proof,
      }))
    )
      return refused();
  } else {
    signKey = body.signKey!;
    if (
      !validateDeviceKeys({ signKey, agreeKey: body.agreeKey! }) ||
      !(await verifyDeviceProof({
        purpose: "link",
        product: product.slug,
        deviceId,
        value: `${body.nonce!}.${signKey}`,
        tokenHash: await sha256B64url(body.subjectToken!),
        signKey,
        sig: body.proof,
      }))
    )
      return refused();
    // A device that holds a signing key must present that key.
    if (held !== null && held !== signKey) return refused();
  }

  const holder = await deviceHolder(env, db, product.slug, bound, now);
  if (holder === "unavailable") return noStore(wireError(503, "unavailable"));
  if (!holder) return stepUp();
  // The step-up is read here and spent once the handle or token has checked out, so a missing
  // handle or an unreachable provider does not burn it.
  if (!(await freshLive(env, product.slug, deviceId, bound))) return stepUp();

  let source: LinkSource;
  if (body.linkHandle !== undefined) {
    const ref = await exchangeLinkRef(env, product.slug, body.linkHandle);
    const raw = await getArtefact(env, ref);
    if (!raw) return noStore(wireError(404, ErrorCode.NotFound));
    let rec: ExchangeLinkRecord;
    try {
      rec = JSON.parse(raw) as ExchangeLinkRecord;
    } catch {
      return refused();
    }
    // The binding is read before the take, so a request that does not match leaves the handle live.
    if (
      rec.product !== product.slug ||
      rec.deviceId !== deviceId ||
      rec.keyThumbprint !== (await signKeyThumbprint(signKey))
    )
      return refused();
    // A handle issued to one person is not spent into another's account.
    if (rec.boundSubject && rec.boundSubject !== bound) return refused();
    if (!(await spendFresh(env, product.slug, deviceId, bound)))
      return stepUp();
    if ((await consumeArtefact(env, ref)) === null)
      return noStore(wireError(404, ErrorCode.NotFound));
    source = {
      kind: rec.kind,
      issuerKey: rec.issuerKey,
      subject: rec.subject,
      tenantScopes: rec.tenantScopes,
      email: rec.email,
      emailVerified: rec.emailVerified,
    };
  } else {
    const spent = await consumeExchangeNonce(
      env,
      product.slug,
      body.nonce!,
      deviceId,
      signKey,
    );
    if (!spent || spent.agreeKey !== body.agreeKey) return refused();
    const row = await getProduct(db, product.slug);
    if (!row) return refused();
    let id: NativeIdentity;
    try {
      id = await verifyNativeToken(
        body.subjectToken!,
        body.nonce!,
        await readPlatformSignIn(db, row),
        env as unknown as Readonly<Record<string, unknown>>,
      );
    } catch (e) {
      if (e instanceof OidcNetworkError)
        return noStore(wireError(503, "unavailable"));
      return refused();
    }
    if (!(await spendFresh(env, product.slug, deviceId, bound)))
      return stepUp();
    source = {
      kind: id.kind,
      issuerKey: id.issuerKey,
      subject: id.subject,
      tenantScopes: id.tenantScopes,
      email: id.email,
      emailVerified: id.emailVerified,
    };
  }

  // The scope (D-A3). The token's tenant scopes are ordered: Google lists the global scope first.
  const globalOk =
    source.kind === "google" &&
    source.emailVerified &&
    source.email !== null &&
    (await verifiedAccountEmails(db, holder.accountId)).some(
      (e) => e.trim().toLowerCase() === source.email,
    );
  const scoped = source.tenantScopes.find((s) => s !== "");
  const tenantScope = globalOk ? "" : scoped;
  if (tenantScope === undefined) return refused();
  const reach: LinkReach = tenantScope === "" ? "global" : "developer";

  const origin = customerOrigin(env, req) ?? new URL(req.url).origin;
  const result: LinkResult = await linkIdentity(
    { db, env, now, origin },
    // The proof of the account's step-up is the one just spent: a same-device sign-in, 300 s at most.
    { accountId: holder.accountId, authenticatedAt: now },
    {
      issuerKey: source.issuerKey,
      tenantScope,
      subject: source.subject,
      kind: source.kind,
      // A scoped link keeps its address unverified: it brings no licences and joins nothing.
      email: source.email,
      emailVerified: globalOk,
      amr: [source.kind],
    },
    {
      app: product.name,
      // The linked identity's own verified address hears of it too.
      alsoTo: source.emailVerified ? source.email : null,
    },
  );
  if (!result.ok) {
    if (result.error === "link_conflict")
      return noStore(wireError(409, "link_conflict"));
    if (result.error === "not_found")
      return noStore(wireError(404, ErrorCode.NotFound));
    if (result.error === "step_up_required") return stepUp();
    return refused();
  }

  if (!result.already)
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: holder.subject,
      actor_name: null,
      actor_email: null,
      action: "identity.link.added",
      target_kind: "device",
      target_id: deviceId,
      parent_id: null,
      summary: `Added a ${source.kind} sign-in through the app (reach: ${reach}, via: app)`,
    });
  const out: LinkResponse = { linked: { kind: source.kind, reach } };
  return noStore(json(out));
}
