/**
 * Connected apps (I-21.15; plans/I-34-I-21.15.md §3, §4; V5 §12.13.7): the registered clients a
 * person signed in to with a product's account, for Polaris Locker's Account page.
 *
 *   `GET    /api/me/connected-apps`                       the list, grouped by product
 *   `PATCH  /api/me/connected-apps/<product>/<clientId>`  Change what <Client> gets
 *   `DELETE /api/me/connected-apps/<product>/<clientId>`  Disconnect
 *
 * Every read and write is keyed by `(product, session account, client)`: a client that is another
 * person's, unknown or malformed is one `404 not_found`. Change only flips the optional claims the
 * client's scopes reach and the person already decided; a required claim, a line (`entitlements`,
 * `offline`), an undecided claim and an unknown item are `400 bad_request`, and the grant's scopes
 * are never touched. Disconnect deletes the grant and revokes every refresh family of that account
 * and client in one batch (with its audit row), so `userinfo` and `refresh` refuse at once.
 *
 * Nothing here is a secret: the answer holds names, claim items and times, never a scope hash, a
 * token, a redirect URI or a secret.
 */

import type { IssuerClaim } from "@polaris-key/protocol/identity";
import { CLIENT_ID_PATTERN } from "@polaris-key/protocol/identity";
import { auditStatement, sql } from "../../../core/audit.js";
import { existingSubjectFor } from "../../../core/accounts/accountSubjects.js";
import { loadProductPublic } from "../../../core/products.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { batchCounts } from "../../../db/batch.js";
import type { Db } from "../../../db/types.js";
import { randomId } from "../../../platform/crypto.js";
import type { Env } from "../../../platform/env.js";
import { appSecurityHeaders } from "../../../core/securityHeaders.js";
import { clientRecordFor } from "../passthrough/client.js";
import { getClient, type ClientRecord } from "../issuer/clientsRepo.js";
import { claimsOfScopes, lineScopes } from "../issuer/coverage.js";
import {
  changeGrantClaimsStatement,
  disconnectStatements,
  getClientGrant,
  listAllAccountGrants,
  type ClientGrant,
} from "../issuer/grantsRepo.js";
import { registeredClientRecord } from "../issuer/registeredView.js";
import { issuerServed } from "../issuer/served.js";
import {
  err,
  notFound,
  portalJson,
  readBody,
  type PortalHooksFor,
} from "./api.js";
import type { PortalSession } from "./session.js";

/** The budget a Change or a Disconnect spends: 20 per 60 s per account, failing closed. */
export const CLIENT_DISCONNECT_RATE = {
  bucket: "portalClientDisconnect",
  limit: 20,
  windowSec: 60,
};

const CLIENT_ID_RE = new RegExp(CLIENT_ID_PATTERN);
const CLAIM_ITEMS = ["name", "picture", "email"] as const;

/** What a client can get: a claim (a switch unless the client requires it) or a line (never a switch). */
export type ConnectedItem =
  | "name"
  | "picture"
  | "email"
  | "entitlements"
  | "offline";

export interface ConnectedGet {
  item: ConnectedItem;
  granted: boolean;
  /** A required claim or a line: it has no switch; Disconnect removes it. */
  fixed: boolean;
}

export interface ConnectedClient {
  clientId: string;
  name: string;
  developer: string | null;
  /** Another company's client (it names a developer of its own). */
  partner: boolean;
  /** A same-origin `/media/…` path, or `null`. */
  iconUrl: string | null;
  /** Where it returns people: the host of its `https` redirect, `null` for an app on this device. */
  returnHost: string | null;
  /** `false` while the client is disabled or the issuer or Identity is off. */
  available: boolean;
  gets: ConnectedGet[];
  grantedAt: number;
  lastUsedAt: number | null;
}

export interface ConnectedProduct {
  product: string;
  name: string;
  iconUrl: string | null;
  clients: ConnectedClient[];
}

/**
 * What the client gets under this grant, in ConsentStep's order. An optional claim the person never
 * decided (the client widened its scopes since) is left out: it receives nothing until asked, and
 * there is nothing to switch.
 */
export function connectedGets(
  client: Pick<ClientRecord, "scopes" | "claims">,
  grant: Pick<ClientGrant, "claimsGranted" | "claimsDeclined" | "scopes">,
): ConnectedGet[] {
  const gets: ConnectedGet[] = [];
  for (const c of claimsOfScopes(client.scopes)) {
    const required = client.claims.required.includes(c);
    const granted = grant.claimsGranted.includes(c);
    if (!required && !granted && !grant.claimsDeclined.includes(c)) continue;
    gets.push({ item: c, granted, fixed: required });
  }
  for (const line of lineScopes(client.scopes))
    gets.push({
      item: line === "offline_access" ? "offline" : "entitlements",
      granted: grant.scopes.includes(line),
      fixed: true,
    });
  return gets;
}

async function connectedClient(
  env: Env,
  db: Db,
  product: { slug: string },
  productDeveloper: string | null,
  client: ClientRecord,
  grant: ClientGrant,
  productOn: boolean,
  issuerOn: boolean,
): Promise<ConnectedClient> {
  const shown = await registeredClientRecord(
    env,
    db,
    product,
    client,
    client.redirectUris[0] ?? "",
    productDeveloper,
  );
  return {
    clientId: client.clientId,
    name: shown.name,
    developer: shown.developerName,
    partner: shown.partner,
    iconUrl: shown.iconUrl,
    returnHost: shown.returnHost,
    available: client.status === "active" && productOn && issuerOn,
    gets: connectedGets(client, grant),
    grantedAt: grant.grantedAt,
    lastUsedAt: grant.lastUsedAt,
  };
}

/** `GET /api/me/connected-apps`. */
export async function handleConnectedApps(
  env: Env,
  db: Db,
  session: PortalSession,
  hooksFor: PortalHooksFor | undefined,
  now: number,
): Promise<Response> {
  const byProduct = new Map<string, ClientGrant[]>();
  for (const g of await listAllAccountGrants(db, session.accountId))
    byProduct.set(g.product, [...(byProduct.get(g.product) ?? []), g]);
  const products: ConnectedProduct[] = [];
  for (const [slug, grants] of byProduct) {
    const product = await loadProductPublic(db, slug);
    if (!product) continue;
    const app = await clientRecordFor(env, db, product, "web", now, hooksFor);
    const productOn = product.services.identity.enabled;
    const issuerOn = productOn && (await issuerServed(db, slug));
    const clients: ConnectedClient[] = [];
    for (const g of grants) {
      const client = await getClient(db, slug, g.clientId);
      if (!client) continue;
      clients.push(
        await connectedClient(
          env,
          db,
          product,
          app.developerName,
          client,
          g,
          productOn,
          issuerOn,
        ),
      );
    }
    if (clients.length === 0) continue;
    clients.sort(
      (a, b) =>
        (b.lastUsedAt ?? b.grantedAt) - (a.lastUsedAt ?? a.grantedAt) ||
        (a.clientId < b.clientId ? -1 : 1),
    );
    products.push({
      product: slug,
      name: app.appName,
      iconUrl: app.iconUrl,
      clients,
    });
  }
  const used = (p: ConnectedProduct) =>
    Math.max(...p.clients.map((c) => c.lastUsedAt ?? c.grantedAt));
  products.sort(
    (a, b) => used(b) - used(a) || (a.product < b.product ? -1 : 1),
  );
  return portalJson({ products });
}

/** The product and client of a path, both the caller's to name, or `null` (one `404`). */
async function ownGrant(
  db: Db,
  session: PortalSession,
  product: string,
  clientId: string,
): Promise<{ client: ClientRecord; grant: ClientGrant } | null> {
  if (!CLIENT_ID_RE.test(clientId)) return null;
  const grant = await getClientGrant(db, product, session.accountId, clientId);
  const client = grant ? await getClient(db, product, clientId) : null;
  return grant && client ? { client, grant } : null;
}

/** Charge the shared Change and Disconnect budget; the `429` when it is spent. */
async function limited(
  env: Env,
  session: PortalSession,
  product: string,
  now: number,
): Promise<Response | null> {
  const ok = await rateLimitOk(
    env,
    product,
    { ...CLIENT_DISCONNECT_RATE, id: `${product}:${session.accountId}` },
    now,
  );
  return ok ? null : err(429, "rate_limited", "too many attempts");
}

/** What a Change body may hold: `{ claims: { name?, picture?, email?: boolean } }`, nothing else. */
function parseChange(
  body: Record<string, unknown>,
): Partial<Record<IssuerClaim, boolean>> | null {
  const claims = body.claims;
  if (Object.keys(body).length !== 1) return null;
  if (!claims || typeof claims !== "object" || Array.isArray(claims))
    return null;
  const out: Partial<Record<IssuerClaim, boolean>> = {};
  for (const [k, v] of Object.entries(claims)) {
    if (!CLAIM_ITEMS.some((c) => c === k) || typeof v !== "boolean")
      return null;
    out[k as IssuerClaim] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** `PATCH /api/me/connected-apps/<product>/<clientId>`: Change what <Client> gets. */
export async function handleConnectedAppChange(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  hooksFor: PortalHooksFor | undefined,
  product: string,
  clientId: string,
  now: number,
): Promise<Response> {
  const found = await ownGrant(db, session, product, clientId);
  if (!found) return notFound();
  const refused = await limited(env, session, product, now);
  if (refused) return refused;
  const want = parseChange(await readBody(req));
  if (!want) return err(400, "bad_request", "Send the claims to change.");
  const { client, grant } = found;
  // Only a changeable item: reached by the scopes, not required, and already decided.
  const changeable = connectedGets(client, grant).filter((g) => !g.fixed);
  const asked = Object.keys(want) as IssuerClaim[];
  if (!asked.every((c) => changeable.some((g) => g.item === c)))
    return err(400, "bad_request", "That cannot be changed.");
  const decided = (c: IssuerClaim) =>
    grant.claimsGranted.includes(c) || grant.claimsDeclined.includes(c);
  const claimsGranted = CLAIM_ITEMS.filter(
    (c) => decided(c) && (want[c] ?? grant.claimsGranted.includes(c)),
  );
  const claimsDeclined = CLAIM_ITEMS.filter(
    (c) => decided(c) && !claimsGranted.includes(c),
  );
  const flipped = asked.filter(
    (c) => grant.claimsGranted.includes(c) !== claimsGranted.includes(c),
  );
  if (flipped.length > 0) {
    const subject = await existingSubjectFor(db, session.accountId, product);
    const counts = await batchCounts(db, [
      changeGrantClaimsStatement(
        {
          product,
          accountId: session.accountId,
          clientId,
          claimsGranted,
          claimsDeclined,
        },
        now,
      ),
      auditStatement(
        {
          product,
          id: randomId("aud"),
          at: now,
          actor_sub: subject,
          actor_name: null,
          actor_email: null,
          action: "identity.client.change",
          target_kind: "client",
          target_id: clientId,
          parent_id: null,
          summary: `Changed what a client gets: ${flipped.join(", ")}`,
        },
        sql(
          `WHERE EXISTS (SELECT 1 FROM identity_client_grants
                          WHERE product = ? AND account_id = ? AND client_id = ?)`,
          product,
          session.accountId,
          clientId,
        ),
      ),
    ]);
    // A Disconnect that landed in between: the grant is gone, so is the answer.
    if (counts[0] !== 1) return notFound();
  }
  const fresh = await ownGrant(db, session, product, clientId);
  if (!fresh) return notFound();
  const pub = await loadProductPublic(db, product);
  if (!pub) return notFound();
  const app = await clientRecordFor(env, db, pub, "web", now, hooksFor);
  const on = pub.services.identity.enabled;
  return portalJson(
    await connectedClient(
      env,
      db,
      pub,
      app.developerName,
      fresh.client,
      fresh.grant,
      on,
      on && (await issuerServed(db, product)),
    ),
  );
}

/** `DELETE /api/me/connected-apps/<product>/<clientId>`: Disconnect. `204`; a second one is `404`. */
export async function handleConnectedAppDisconnect(
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  clientId: string,
  now: number,
): Promise<Response> {
  if (!(await ownGrant(db, session, product, clientId))) return notFound();
  const refused = await limited(env, session, product, now);
  if (refused) return refused;
  const subject = await existingSubjectFor(db, session.accountId, product);
  // One batch: the row of audit (only while the grant exists), the families, then the grant.
  const counts = await batchCounts(db, [
    auditStatement(
      {
        product,
        id: randomId("aud"),
        at: now,
        actor_sub: subject,
        actor_name: null,
        actor_email: null,
        action: "identity.client.disconnect",
        target_kind: "client",
        target_id: clientId,
        parent_id: null,
        summary: "Disconnected a client: its access and refresh tokens end",
      },
      sql(
        `WHERE EXISTS (SELECT 1 FROM identity_client_grants
                        WHERE product = ? AND account_id = ? AND client_id = ?)`,
        product,
        session.accountId,
        clientId,
      ),
    ),
    ...disconnectStatements(product, session.accountId, clientId, now),
  ]);
  if ((counts[2] ?? 0) !== 1) return notFound();
  return new Response(null, {
    status: 204,
    headers: appSecurityHeaders(new Headers({ "cache-control": "no-store" })),
  });
}
