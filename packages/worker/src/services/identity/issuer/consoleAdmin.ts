/**
 * The console's side of the issuer's registered clients (I-21.14; V5 §12.13.2; plans/I-20.md §8):
 * `…/identity/clients[/<id>[/secrets[/<sid>]|/disable|/enable]]` under a product.
 *
 *   GET    clients                the page: the issuer switch and URLs, the clients with their usage
 *   POST   clients                register a console client (step-up; the issuer must be on)
 *   GET    clients/:id            one client: its members, secrets (last 4, last use), usage
 *   PATCH  clients/:id            edit a console client's members (a manifest client is edited in `.pkey/`)
 *   DELETE clients/:id            delete with its secrets, grants and families (step-up; typed key)
 *   POST   clients/:id/secrets    mint a secret, shown in this response only (step-up; `web`, 2 live)
 *   DELETE clients/:id/secrets/:s revoke a secret
 *   POST   clients/:id/disable    disable, which revokes every refresh family
 *   POST   clients/:id/enable     enable again (step-up)
 *
 * The route table (`console/routes.ts`) holds the area and the step-ups. A client's members are
 * validated with the manifest's own rules (`validateConsoleClient`) and the display-name check, so a
 * console client can never hold what `.pkey/` would refuse. A secret's plaintext is in the one
 * response that mints it, never in a list or an audit row. Every write is audited in the product's
 * `audit` (`identity.client.*`), in the batch that makes it where it is one.
 */

import { checkDisplayName, validateConsoleClient } from "@polaris-key/manifest";
import {
  ISSUER_REFRESH_IDLE_SECONDS,
  MAX_CLIENT_SECRETS,
  MAX_ISSUER_CLIENTS,
  type IssuerClaim,
  type IssuerScope,
} from "@polaris-key/protocol/identity";
import { ErrorCode } from "../../../core/errors.js";
import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/console/session.js";
import { adminJson, err, readBody } from "../../../core/console/respond.js";
import { audit, auditStatementFor } from "../../../core/audit.js";
import { displayCheckOptions } from "../../../core/accounts/reservedDisplayNames.js";
import {
  addClientSecret,
  createClient,
  deleteClientStatements,
  getClient,
  listClients,
  listClientSecrets,
  revokeClientSecret,
  setClientStatus,
  updateClient,
  type ClientPatch,
  type ClientRecord,
  type NewClient,
} from "./clientsRepo.js";
import { clientUsage } from "./grantsRepo.js";
import { issuerServed } from "./served.js";

type Ctx = ServiceContext & { session: AdminSession };

const THIRTY_DAYS = 30 * 86_400;

/** A client as the console reads it. No secret, ever. */
function view(c: ClientRecord, usage?: { recent: number; total: number }) {
  return {
    id: c.clientId,
    key: c.key,
    name: c.name,
    developerName: c.developerName,
    // D8: a client that names a developer of its own is another party's; the card says "by …".
    partner: c.developerName !== null,
    type: c.type,
    origin: c.origin,
    status: c.status,
    redirectUris: c.redirectUris,
    postLogoutRedirectUris: c.postLogoutRedirectUris,
    scopes: c.scopes,
    claimsRequired: c.claims.required,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    people30d: usage?.recent ?? 0,
    people: usage?.total ?? 0,
  };
}

/** Every field a body may carry, as the manifest's `identity.clients` entry. */
const FIELDS = [
  "key",
  "name",
  "developerName",
  "type",
  "redirectUris",
  "postLogoutRedirectUris",
  "scopes",
  "claimsRequired",
] as const;

const refuse = (
  fields: string[],
  message: string,
  extra: { reasons?: object; messages?: object } = {},
): Response => err(422, ErrorCode.BadRequest, message, { fields, ...extra });

/**
 * The manifest rules, then the display-name check, over a full client. `null` when it passes;
 * otherwise the 422 naming each field with the rule's code.
 */
async function refusal(
  ctx: Ctx,
  candidate: Record<string, unknown>,
): Promise<Response | null> {
  const body = {
    ...candidate,
    claims: { required: candidate.claimsRequired ?? [] },
  };
  delete (body as Record<string, unknown>).claimsRequired;
  const problems = validateConsoleClient(body).map((p) => ({
    ...p,
    field: p.field === "claims" ? "claimsRequired" : p.field,
  }));
  const check = await displayCheckOptions(ctx.env, ctx.db, ctx.product.slug);
  for (const f of ["name", "developerName"] as const) {
    const v = candidate[f];
    if (typeof v !== "string" || problems.some((p) => p.field === f)) continue;
    const verdict = checkDisplayName(v, check);
    if (verdict !== null)
      problems.push({
        field: f,
        code:
          verdict === "reserved"
            ? "reserved_display_name"
            : "invalid_display_text",
        message:
          verdict === "reserved"
            ? "That name uses a reserved platform or store name. Use your own."
            : "Remove control, invisible or direction-changing characters and edge spaces.",
      });
  }
  if (problems.length === 0) return null;
  return refuse(
    [...new Set(problems.map((p) => p.field))],
    problems[0]!.message,
    {
      reasons: Object.fromEntries(problems.map((p) => [p.field, p.code])),
      // One sentence per field, the first the rules gave for it.
      messages: Object.fromEntries(
        [...problems].reverse().map((p) => [p.field, p.message]),
      ),
    },
  );
}

function newClientOf(slug: string, b: Record<string, unknown>): NewClient {
  return {
    product: slug,
    key: b.key as string,
    origin: "console",
    name: (b.name as string).trim(),
    developerName:
      typeof b.developerName === "string" && b.developerName.trim() !== ""
        ? b.developerName.trim()
        : null,
    type: b.type as NewClient["type"],
    redirectUris: b.redirectUris as string[],
    postLogoutRedirectUris:
      (b.postLogoutRedirectUris as string[] | undefined) ?? [],
    scopes: b.scopes as IssuerScope[],
    claimsRequired: (b.claimsRequired as IssuerClaim[] | undefined) ?? [],
    iconUrl: null,
  };
}

async function page(ctx: Ctx): Promise<Response> {
  const { db, product, req, now } = ctx;
  const origin = new URL(req.url).origin;
  const issuer = `${origin}/${product.slug}/identity`;
  const [clients, usage, enabled] = await Promise.all([
    listClients(db, product.slug),
    clientUsage(db, product.slug, now - THIRTY_DAYS),
    issuerServed(db, product.slug),
  ]);
  return adminJson({
    issuer: {
      enabled,
      url: issuer,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      jwksUrl: `${issuer}/jwks`,
    },
    limit: MAX_ISSUER_CLIENTS,
    clients: clients.map((c) => view(c, usage.get(c.clientId))),
  });
}

async function create(ctx: Ctx): Promise<Response> {
  const { db, product, session, now } = ctx;
  if (!(await issuerServed(db, product.slug)))
    return err(
      409,
      ErrorCode.BadRequest,
      "Turn on Sign in with this product before registering a client.",
      { reason: "issuer_off" },
    );
  const body = await readBody(ctx.req);
  const candidate: Record<string, unknown> = {};
  for (const f of FIELDS) if (body[f] !== undefined) candidate[f] = body[f];
  const refused = await refusal(ctx, candidate);
  if (refused) return refused;
  const r = await createClient(db, newClientOf(product.slug, candidate), now);
  if (!r.ok)
    return r.reason === "key_exists"
      ? err(
          409,
          ErrorCode.BadRequest,
          "A client with that key already exists.",
          {
            reason: "key_exists",
            fields: ["key"],
          },
        )
      : err(
          409,
          ErrorCode.BadRequest,
          `A product has at most ${MAX_ISSUER_CLIENTS} clients.`,
          { reason: "client_limit" },
        );
  await audit(
    db,
    product.slug,
    session,
    now,
    "identity.client.created",
    { kind: "client", id: r.client.clientId },
    `Registered client ${r.client.name} (${r.client.type})`,
  );
  return adminJson({ ok: true, client: view(r.client) }, 201);
}

async function record(ctx: Ctx, client: ClientRecord): Promise<Response> {
  const { db, product, now } = ctx;
  const [secrets, usage] = await Promise.all([
    listClientSecrets(db, product.slug, client.clientId),
    clientUsage(db, product.slug, now - THIRTY_DAYS),
  ]);
  return adminJson({
    client: view(client, usage.get(client.clientId)),
    lastUsedAt: usage.get(client.clientId)?.lastUsedAt ?? null,
    refreshIdleDays: ISSUER_REFRESH_IDLE_SECONDS / 86_400,
    // The secret itself is never listed: its prefix and last four characters only.
    secrets: secrets
      .filter((s) => s.revokedAt === null)
      .map((s) => ({
        id: s.id,
        hint: `pkeycs_…${s.last4}`,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
      })),
    secretLimit: MAX_CLIENT_SECRETS,
  });
}

async function edit(ctx: Ctx, client: ClientRecord): Promise<Response> {
  const { db, product, session, now } = ctx;
  if (client.origin === "manifest")
    return err(
      409,
      ErrorCode.ManagedByAdmin,
      "This client comes from .pkey/product. Edit it there.",
      { reason: "manifest_owned" },
    );
  const body = await readBody(ctx.req);
  if ("key" in body && body.key !== client.key)
    return refuse(["key"], "A client's key cannot change.");
  // The merged client is what must be valid, so one changed member cannot break another.
  const merged: Record<string, unknown> = {
    key: client.key,
    name: client.name,
    ...(client.developerName !== null
      ? { developerName: client.developerName }
      : {}),
    type: client.type,
    redirectUris: client.redirectUris,
    postLogoutRedirectUris: client.postLogoutRedirectUris,
    scopes: client.scopes,
    claimsRequired: client.claims.required,
  };
  const patch: ClientPatch = {};
  for (const f of FIELDS) {
    if (f === "key" || body[f] === undefined) continue;
    merged[f] = body[f];
  }
  if (body.developerName === null || body.developerName === "")
    delete merged.developerName;
  const refused = await refusal(ctx, merged);
  if (refused) return refused;
  const next = newClientOf(product.slug, merged);
  if (next.name !== client.name) patch.name = next.name;
  if (next.developerName !== client.developerName)
    patch.developerName = next.developerName;
  if (next.type !== client.type) patch.type = next.type;
  patch.redirectUris = next.redirectUris;
  patch.postLogoutRedirectUris = next.postLogoutRedirectUris;
  patch.scopes = next.scopes;
  patch.claimsRequired = next.claimsRequired;
  await updateClient(db, product.slug, client.clientId, patch, now);
  await audit(
    db,
    product.slug,
    session,
    now,
    "identity.client.updated",
    { kind: "client", id: client.clientId },
    `Changed client ${next.name}`,
  );
  const fresh = await getClient(db, product.slug, client.clientId);
  return adminJson({ ok: true, client: view(fresh ?? client) });
}

async function remove(ctx: Ctx, client: ClientRecord): Promise<Response> {
  const { db, product, session, now } = ctx;
  if (client.origin === "manifest")
    return err(
      409,
      ErrorCode.ManagedByAdmin,
      "This client comes from .pkey/product. Remove it there, or disable it here.",
      { reason: "manifest_owned" },
    );
  const body = await readBody(ctx.req);
  if (body.confirmKey !== client.key)
    return refuse(["confirmKey"], "Type the client's key to delete it.");
  await db.batch([
    ...deleteClientStatements(product.slug, client.clientId),
    auditStatementFor(
      product.slug,
      session,
      now,
      "identity.client.deleted",
      { kind: "client", id: client.clientId },
      `Deleted client ${client.name}`,
    ),
  ]);
  return adminJson({ ok: true });
}

async function secrets(
  ctx: Ctx,
  client: ClientRecord,
  rest: string[],
): Promise<Response> {
  const { db, env, product, session, now, req } = ctx;
  if (rest.length === 0 && req.method === "POST") {
    const minted = await addClientSecret(
      env,
      db,
      product.slug,
      client.clientId,
      now,
    );
    if (!minted)
      return err(
        409,
        ErrorCode.BadRequest,
        client.type !== "web"
          ? "Only a web client holds a secret."
          : client.status !== "active"
            ? "Enable the client before minting a secret."
            : `A client holds at most ${MAX_CLIENT_SECRETS} secrets. Revoke one first.`,
        { reason: "secret_unavailable" },
      );
    await audit(
      db,
      product.slug,
      session,
      now,
      "identity.client.secret.created",
      { kind: "client", id: client.clientId },
      `Minted a secret ending ${minted.last4} for ${client.name}`,
    );
    return adminJson(
      {
        ok: true,
        secret: {
          id: minted.id,
          value: minted.secret,
          hint: `pkeycs_…${minted.last4}`,
        },
      },
      201,
    );
  }
  if (rest.length === 1 && req.method === "DELETE") {
    const done = await revokeClientSecret(
      db,
      product.slug,
      client.clientId,
      rest[0]!,
      now,
    );
    if (!done) return err(404, ErrorCode.NotFound);
    await audit(
      db,
      product.slug,
      session,
      now,
      "identity.client.secret.revoked",
      { kind: "client", id: client.clientId },
      `Revoked a secret of ${client.name}`,
    );
    return adminJson({ ok: true });
  }
  return err(404, ErrorCode.NotFound);
}

async function setStatus(
  ctx: Ctx,
  client: ClientRecord,
  status: "active" | "disabled",
): Promise<Response> {
  const { db, product, session, now } = ctx;
  await setClientStatus(db, product.slug, client.clientId, status, now);
  await audit(
    db,
    product.slug,
    session,
    now,
    status === "disabled"
      ? "identity.client.disabled"
      : "identity.client.enabled",
    { kind: "client", id: client.clientId },
    status === "disabled"
      ? `Disabled client ${client.name}; its refresh tokens are revoked`
      : `Enabled client ${client.name}`,
  );
  const fresh = await getClient(db, product.slug, client.clientId);
  return adminJson({ ok: true, client: view(fresh ?? client) });
}

/** `rest` is what follows `clients`. `null` is the registry's 404. */
export async function handleClientsAdmin(
  ctx: Ctx,
  rest: string[],
): Promise<Response | null> {
  const { req, product, db } = ctx;
  // Like every product-scoped identity surface: absent while Identity is off.
  if (product.services.identity?.enabled !== true) return null;
  const method = req.method;
  if (rest.length === 0) {
    if (method === "GET") return page(ctx);
    if (method === "POST") return create(ctx);
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const client = await getClient(db, product.slug, rest[0]!);
  if (!client) return err(404, ErrorCode.NotFound);
  const tail = rest.slice(1);
  if (tail.length === 0) {
    if (method === "GET") return record(ctx, client);
    if (method === "PATCH") return edit(ctx, client);
    if (method === "DELETE") return remove(ctx, client);
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  if (tail[0] === "secrets") return secrets(ctx, client, tail.slice(1));
  if (tail.length === 1 && method === "POST") {
    if (tail[0] === "disable") return setStatus(ctx, client, "disabled");
    if (tail[0] === "enable") return setStatus(ctx, client, "active");
  }
  return err(404, ErrorCode.NotFound);
}
