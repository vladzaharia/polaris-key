/**
 * Connections, the operator's write side (I-31; plans/I-27.md §2.3): what the console's
 * Platform → Connections page and its add wizard call. Identity is the only writer of
 * `identity_connections` and `identity_connection_domains`; the console reaches this module
 * through `services/identity/public.ts`.
 *
 * Rules every write here keeps:
 *
 *   - **https issuers only** (`isSafeIssuerUrl`: no credentials, port, query, fragment, or a
 *     reserved or private address literal). Discovery runs through the one gated fetch
 *     (`core/oidc/client.ts`: https, the issuer's host (and a `jwks_uri` host) only, no redirect,
 *     capped, timed out), so a hostile issuer URL cannot reach an internal address.
 *   - **Secrets are sealed and never read back.** The client secret goes under PLATFORM_KEK with
 *     `connectionSecretContext(id)`; every view says only whether one is set.
 *   - **No operator audience yet.** `operators` and `both` are refused until ST-32's Superadmin
 *     gate lands (plans/I-27.md §2.3); a row seeded with either keeps it while the console
 *     changes nothing else about the audience.
 *   - **Every change is one batch with its `platform_audit` row**, so a change cannot land
 *     unrecorded. The audit text never carries a secret or anything derived from one.
 */

import type { Db, DbStatement } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { seal } from "../../../platform/keyvault.js";
import { randomToken } from "../../../platform/random.js";
import { randomId } from "../../../platform/crypto.js";
import { isSafeIssuerUrl } from "@polaris-key/manifest";
import {
  actorColumns,
  platformAuditStatement,
  type AuditActor,
} from "../../../core/audit.js";
import {
  connectionHosts,
  discover,
  OidcNetworkError,
  OidcVerifyError,
  oidcUrlProblem,
  type OidcFetch,
} from "../../../core/oidc/client.js";
import {
  CLAIM_MAP_MAX_CLAIMS,
  CLAIM_NAME_RE,
  CONNECTION_ID_RE,
  connectionSecretContext,
  listConnections,
  resolveConnection,
  type ClaimMap,
  type Connection,
  type ConnectionStatus,
} from "../../../core/oidc/connections.js";
import { portalIdentityIssuerKey } from "../portal/repo.js";
import {
  addConnectionDomain,
  challengeName,
  challengeValue,
  removeConnectionDomain,
  setDomainEnforce,
  verifyConnectionDomain,
  type ConnectionDomainRow,
  type VerifyDomainResult,
} from "./domains.js";

export const PLATFORM_SCOPE = "platform";
/** The most platform connections an instance holds. */
export const CONNECTIONS_MAX = 20;
export const LABEL_MAX = 60;
const CLIENT_ID_RE = /^[\x21-\x7e]{1,200}$/;
const SECRET_MAX = 4096;

// ── the view ─────────────────────────────────────────────────────────────────────────────────

export interface DomainView {
  domain: string;
  verified: boolean;
  verifiedAt: number | null;
  checkedAt: number | null;
  enforce: boolean;
  /** The TXT record to publish: its name and exact value. Not a secret. */
  record: { name: string; value: string };
}

export interface ConnectionView {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  jwksUri: string | null;
  audience: Connection["audience"];
  claimMap: ClaimMap;
  status: ConnectionStatus;
  source: Connection["source"];
  /** Whether a secret is sealed. The value is never returned. */
  hasSecret: boolean;
  domains: DomainView[];
  /** People signed in through it (links), for the delete guard and the row. */
  links: number;
  lastSuccessAt: number | null;
  lastError: string | null;
}

interface StatusRow {
  id: string;
  last_success_at: number | null;
  last_error_json: string | null;
}

async function domainRows(db: Db): Promise<ConnectionDomainRow[]> {
  return db.all<ConnectionDomainRow>(
    `SELECT connection_id, scope, domain, token, verified_at, checked_at, enforce
       FROM identity_connection_domains WHERE scope = ? ORDER BY domain`,
    PLATFORM_SCOPE,
  );
}

function domainView(r: ConnectionDomainRow): DomainView {
  return {
    domain: r.domain,
    verified: r.verified_at !== null,
    verifiedAt: r.verified_at,
    checkedAt: r.checked_at,
    enforce: r.enforce === 1,
    record: { name: challengeName(r.domain), value: challengeValue(r.token) },
  };
}

/** A stored `last_error_json` as one short line, or null. */
function lastErrorText(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { message?: unknown };
    return typeof v.message === "string" ? v.message.slice(0, 200) : "Failed";
  } catch {
    return "Failed";
  }
}

async function viewOf(
  db: Db,
  c: Connection,
  domains: ConnectionDomainRow[],
  status: StatusRow | undefined,
): Promise<ConnectionView> {
  const n = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM account_links WHERE issuer_key = ? AND tenant_scope = ''",
    portalIdentityIssuerKey(c.issuer),
  );
  return {
    id: c.id,
    label: c.label,
    issuer: c.issuer,
    clientId: c.clientId,
    jwksUri: c.jwksUri,
    audience: c.audience,
    claimMap: c.claimMap,
    status: c.status,
    source: c.source,
    hasSecret: c.hasSealedSecret,
    domains: domains.filter((d) => d.connection_id === c.id).map(domainView),
    links: n?.n ?? 0,
    lastSuccessAt: status?.last_success_at ?? null,
    lastError: lastErrorText(status?.last_error_json ?? null),
  };
}

/** Every platform connection, with its domains. No secret in any field. */
export async function listConnectionViews(db: Db): Promise<ConnectionView[]> {
  const [conns, domains, statuses] = await Promise.all([
    listConnections(db, PLATFORM_SCOPE),
    domainRows(db),
    db.all<StatusRow>(
      "SELECT id, last_success_at, last_error_json FROM identity_connections WHERE scope = ?",
      PLATFORM_SCOPE,
    ),
  ]);
  return Promise.all(
    conns.map((c) =>
      viewOf(
        db,
        c,
        domains,
        statuses.find((s) => s.id === c.id),
      ),
    ),
  );
}

export async function connectionView(
  db: Db,
  id: string,
): Promise<ConnectionView | null> {
  const c = await resolveConnection(db, id);
  if (!c || c.scope !== PLATFORM_SCOPE) return null;
  const [domains, status] = await Promise.all([
    domainRows(db),
    db.first<StatusRow>(
      "SELECT id, last_success_at, last_error_json FROM identity_connections WHERE id = ?",
      id,
    ),
  ]);
  return viewOf(db, c, domains, status ?? undefined);
}

// ── validation ───────────────────────────────────────────────────────────────────────────────

export type Refusal = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 502;
  code: string;
  message: string;
  fields?: string[];
};

const refuse = (
  status: Refusal["status"],
  code: string,
  message: string,
  fields?: string[],
): Refusal => ({
  ok: false,
  status,
  code,
  message,
  ...(fields ? { fields } : {}),
});

export interface ConnectionInput {
  label?: unknown;
  issuer?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  jwksUri?: unknown;
  audience?: unknown;
  claimMap?: unknown;
  status?: unknown;
}

interface Clean {
  label?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string | null;
  jwksUri?: string | null;
  claimMap?: ClaimMap;
  status?: ConnectionStatus;
}

/** Why `issuer` is not a usable issuer, in the operator's words, or null. */
export function issuerProblem(issuer: string): string | null {
  if (!issuer.startsWith("https://"))
    return "The issuer must start with https://.";
  if (!isSafeIssuerUrl(issuer)) {
    return "The issuer must be a public https address without credentials, a query or a fragment.";
  }
  // The one gated fetch refuses a port; say so here rather than as an unreachable provider.
  if (new URL(issuer).port !== "") {
    return "The issuer must not name a port.";
  }
  return null;
}

function cleanClaimMap(raw: unknown): ClaimMap | Refusal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse(
      422,
      "invalid_claim_map",
      "Claim mapping must be an object.",
      ["claimMap"],
    );
  }
  const o = raw as Record<string, unknown>;
  const out: ClaimMap = {};
  const name = (v: unknown, field: string): string | Refusal | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || !CLAIM_NAME_RE.test(v)) {
      return refuse(
        422,
        "invalid_claim_name",
        "A claim name uses letters, digits and _ : . - / only, up to 64.",
        [`claimMap.${field}`],
      );
    }
    return v;
  };
  for (const k of ["groups", "name", "picture", "birthdate"] as const) {
    const r = name(o[k], k);
    if (typeof r === "object") return r;
    if (r) out[k] = r;
  }
  if (o.claims !== undefined && o.claims !== null) {
    if (!Array.isArray(o.claims) || o.claims.length > CLAIM_MAP_MAX_CLAIMS) {
      return refuse(
        422,
        "invalid_claim_map",
        `List at most ${CLAIM_MAP_MAX_CLAIMS} claims.`,
        ["claimMap.claims"],
      );
    }
    const claims: string[] = [];
    for (const c of o.claims) {
      const r = name(c, "claims");
      if (typeof r === "object") return r;
      if (r && !claims.includes(r)) claims.push(r);
    }
    if (claims.length > 0) out.claims = claims;
  }
  return out;
}

function clean(input: ConnectionInput, creating: boolean): Clean | Refusal {
  const out: Clean = {};
  if (input.label !== undefined || creating) {
    const label = typeof input.label === "string" ? input.label.trim() : "";
    // eslint-disable-next-line no-control-regex
    if (
      !label ||
      label.length > LABEL_MAX ||
      /[\u0000-\u001f\u007f]/.test(label)
    ) {
      return refuse(
        422,
        "invalid_label",
        `Name it in 1 to ${LABEL_MAX} characters. People see it on the sign-in button.`,
        ["label"],
      );
    }
    out.label = label;
  }
  if (input.issuer !== undefined || creating) {
    const issuer = typeof input.issuer === "string" ? input.issuer.trim() : "";
    const problem = issuerProblem(issuer);
    if (problem) return refuse(422, "invalid_issuer", problem, ["issuer"]);
    out.issuer = issuer;
  }
  if (input.clientId !== undefined || creating) {
    const id = typeof input.clientId === "string" ? input.clientId.trim() : "";
    if (!CLIENT_ID_RE.test(id)) {
      return refuse(
        422,
        "invalid_client_id",
        "Enter the client ID, without spaces.",
        ["clientId"],
      );
    }
    out.clientId = id;
  }
  if (input.clientSecret !== undefined && input.clientSecret !== null) {
    const s = input.clientSecret;
    if (typeof s !== "string" || s.length > SECRET_MAX) {
      return refuse(422, "invalid_client_secret", "Enter the client secret.", [
        "clientSecret",
      ]);
    }
    // An empty string on an update means "leave it"; the page never sends one for a clear.
    if (s.trim()) out.clientSecret = s.trim();
  }
  if (input.jwksUri !== undefined) {
    if (input.jwksUri === null || input.jwksUri === "") out.jwksUri = null;
    else if (typeof input.jwksUri === "string") {
      const host = out.issuer ?? undefined;
      void host;
      if (
        !input.jwksUri.startsWith("https://") ||
        !isSafeIssuerUrl(new URL(input.jwksUri).origin)
      ) {
        return refuse(
          422,
          "invalid_jwks_uri",
          "The key set address must be a public https address.",
          ["jwksUri"],
        );
      }
      out.jwksUri = input.jwksUri.trim();
    } else {
      return refuse(
        422,
        "invalid_jwks_uri",
        "The key set address must be a public https address.",
        ["jwksUri"],
      );
    }
  }
  if (input.claimMap !== undefined) {
    const m = cleanClaimMap(input.claimMap);
    if ("ok" in m) return m;
    out.claimMap = m;
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "disabled") {
      return refuse(422, "invalid_status", "Status is active or disabled.", [
        "status",
      ]);
    }
    out.status = input.status;
  }
  return out;
}

const AUDIENCE_WAITS =
  "Operator sign-in through a connection needs the Superadmin gate, which is not built yet.";

function audienceRefusal(audience: unknown, current?: string): Refusal | null {
  if (audience === undefined || audience === "customers") return null;
  if (audience === current) return null;
  if (audience === "operators" || audience === "both") {
    return refuse(403, "audience_not_available", AUDIENCE_WAITS, ["audience"]);
  }
  return refuse(422, "invalid_audience", "Audience is customers.", [
    "audience",
  ]);
}

// ── discovery ────────────────────────────────────────────────────────────────────────────────

export interface DiscoveryPreview {
  issuer: string;
  authorizationHost: string;
  tokenHost: string;
  jwksHost: string;
  /** The redirect URI to register at the provider. */
  redirectUri: string;
  supportsCode: true;
  issParameter: boolean;
}

/** Why a discovery failed, in words the page shows; never a provider body or a URL. */
function discoveryFailure(e: unknown): Refusal {
  if (e instanceof OidcVerifyError) {
    return refuse(
      422,
      "discovery_invalid",
      "The provider's discovery document is not usable. " +
        e.message.slice(0, 160),
      ["issuer"],
    );
  }
  if (e instanceof OidcNetworkError) {
    return refuse(
      502,
      "discovery_unreachable",
      "The provider did not answer discovery. Check the issuer address.",
      ["issuer"],
    );
  }
  return refuse(
    502,
    "discovery_unreachable",
    "The provider did not answer discovery.",
    ["issuer"],
  );
}

/** Run discovery for an issuer through the gate. Answers what the page previews, or a refusal. */
export async function previewDiscovery(
  input: { issuer?: unknown; jwksUri?: unknown },
  origin: string,
  opts: { fetch?: OidcFetch } = {},
): Promise<{ ok: true; preview: DiscoveryPreview } | Refusal> {
  const issuer = typeof input.issuer === "string" ? input.issuer.trim() : "";
  const problem = issuerProblem(issuer);
  if (problem) return refuse(422, "invalid_issuer", problem, ["issuer"]);
  const jwksUri =
    typeof input.jwksUri === "string" && input.jwksUri ? input.jwksUri : null;
  if (jwksUri && oidcUrlProblem(jwksUri, connectionHosts(issuer, jwksUri))) {
    return refuse(
      422,
      "invalid_jwks_uri",
      "The key set address must be a public https address.",
      ["jwksUri"],
    );
  }
  try {
    const d = await discover(
      {
        label: "connection-preview",
        issuer,
        clientId: "preview",
        clientSecret: null,
        allowedHosts: connectionHosts(issuer, jwksUri),
        jwksUri,
      },
      { fetch: opts.fetch },
    );
    const host = (u: string): string => new URL(u).host;
    return {
      ok: true,
      preview: {
        issuer,
        authorizationHost: host(d.authorizationEndpoint),
        tokenHost: host(d.tokenEndpoint),
        jwksHost: host(d.jwksUri),
        redirectUri: `${origin}/callback`,
        supportsCode: true,
        issParameter: d.issParameterSupported,
      },
    };
  } catch (e) {
    return discoveryFailure(e);
  }
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────

function auditRow(
  actor: AuditActor,
  now: number,
  action: string,
  id: string,
  summary: string,
  before?: unknown,
  after?: unknown,
): DbStatement {
  return platformAuditStatement({
    id: randomId("paud"),
    at: now,
    ...actorColumns(actor),
    action,
    target_kind: "identity_connection",
    target_id: id,
    summary,
    before_json: before === undefined ? null : JSON.stringify(before),
    after_json: after === undefined ? null : JSON.stringify(after),
  });
}

/** The fields an audit row keeps of a connection: no secret, only whether one is set. */
function auditShape(c: {
  label: string;
  issuer: string;
  clientId: string;
  jwksUri: string | null;
  audience: string;
  claimMap: ClaimMap;
  status: string;
  hasSecret: boolean;
}): Record<string, unknown> {
  return {
    label: c.label,
    issuer: c.issuer,
    clientId: c.clientId,
    jwksUri: c.jwksUri,
    audience: c.audience,
    claimMap: c.claimMap,
    status: c.status,
    hasSecret: c.hasSecret,
  };
}

const isUnique = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

export async function createConnection(
  env: Env,
  db: Db,
  input: ConnectionInput,
  actor: AuditActor,
  now: number,
  opts: { fetch?: OidcFetch } = {},
): Promise<{ ok: true; connection: ConnectionView } | Refusal> {
  const aud = audienceRefusal(input.audience);
  if (aud) return aud;
  const c = clean(input, true);
  if ("ok" in c) return c;
  const count = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identity_connections WHERE scope = ?",
    PLATFORM_SCOPE,
  );
  if ((count?.n ?? 0) >= CONNECTIONS_MAX) {
    return refuse(
      409,
      "too_many",
      `An instance holds at most ${CONNECTIONS_MAX} connections.`,
    );
  }
  // Discovery first: a row is only ever written for an issuer that answered.
  const found = await previewDiscovery(
    { issuer: c.issuer, jwksUri: c.jwksUri },
    "https://example.invalid",
    opts,
  );
  if (!found.ok) return found;
  const id = `conn_${randomToken(12)}`;
  let sealed: string | null = null;
  if (c.clientSecret) {
    try {
      sealed = await seal(env, c.clientSecret, connectionSecretContext(id));
    } catch {
      return refuse(
        409,
        "no_kek",
        "Secrets cannot be sealed: the platform key is not set up.",
        ["clientSecret"],
      );
    }
  }
  const claimMap = c.claimMap ?? {};
  try {
    await db.batch([
      {
        sql: `INSERT INTO identity_connections
                (id, scope, label, issuer, client_id, client_secret_sealed, client_secret_ref,
                 jwks_uri, audience, claim_map_json, exchange, status, source, created_at,
                 modified_at)
              VALUES (?, 'platform', ?, ?, ?, ?, NULL, ?, 'customers', ?, 0, ?, 'console', ?, ?)`,
        params: [
          id,
          c.label!,
          c.issuer!,
          c.clientId!,
          sealed,
          c.jwksUri ?? null,
          JSON.stringify(claimMap),
          c.status ?? "active",
          now,
          now,
        ],
      },
      auditRow(
        actor,
        now,
        "identity.connection.create",
        id,
        `Added the connection ${c.label}`,
        undefined,
        auditShape({
          label: c.label!,
          issuer: c.issuer!,
          clientId: c.clientId!,
          jwksUri: c.jwksUri ?? null,
          audience: "customers",
          claimMap,
          status: c.status ?? "active",
          hasSecret: sealed !== null,
        }),
      ),
    ]);
  } catch (e) {
    if (isUnique(e)) {
      return refuse(
        409,
        "exists",
        "This issuer and client ID are already connected.",
        ["clientId"],
      );
    }
    throw e;
  }
  const view = await connectionView(db, id);
  return { ok: true, connection: view! };
}

export async function updateConnection(
  env: Env,
  db: Db,
  id: string,
  input: ConnectionInput,
  actor: AuditActor,
  now: number,
  opts: { fetch?: OidcFetch } = {},
): Promise<{ ok: true; connection: ConnectionView } | Refusal> {
  if (!CONNECTION_ID_RE.test(id))
    return refuse(404, "not_found", "No such connection.");
  const before = await resolveConnection(db, id);
  if (!before || before.scope !== PLATFORM_SCOPE) {
    return refuse(404, "not_found", "No such connection.");
  }
  const aud = audienceRefusal(input.audience, before.audience);
  if (aud) return aud;
  const c = clean(input, false);
  if ("ok" in c) return c;
  // An env-seeded row keeps its issuer and client: they are the provider the links are keyed to.
  const moves =
    (c.issuer && c.issuer !== before.issuer) ||
    (c.clientId && c.clientId !== before.clientId);
  if (moves && before.source === "env") {
    return refuse(
      409,
      "seeded",
      "The seeded connection keeps its issuer and client ID.",
      ["issuer"],
    );
  }
  if (c.issuer && c.issuer !== before.issuer) {
    const found = await previewDiscovery(
      { issuer: c.issuer, jwksUri: c.jwksUri ?? before.jwksUri },
      "https://example.invalid",
      opts,
    );
    if (!found.ok) return found;
  }
  let sealed: string | undefined;
  if (c.clientSecret) {
    try {
      sealed = await seal(env, c.clientSecret, connectionSecretContext(id));
    } catch {
      return refuse(
        409,
        "no_kek",
        "Secrets cannot be sealed: the platform key is not set up.",
        ["clientSecret"],
      );
    }
  }
  const next = {
    label: c.label ?? before.label,
    issuer: c.issuer ?? before.issuer,
    clientId: c.clientId ?? before.clientId,
    jwksUri: c.jwksUri === undefined ? before.jwksUri : c.jwksUri,
    audience: before.audience as string,
    claimMap: c.claimMap ?? before.claimMap,
    status: c.status ?? before.status,
    hasSecret: sealed !== undefined || before.hasSealedSecret,
  };
  const was = auditShape({ ...before, hasSecret: before.hasSealedSecret });
  const set = [
    "label = ?",
    "issuer = ?",
    "client_id = ?",
    "jwks_uri = ?",
    "claim_map_json = ?",
    "status = ?",
    "modified_at = ?",
  ];
  const params: (string | number | null)[] = [
    next.label,
    next.issuer,
    next.clientId,
    next.jwksUri,
    JSON.stringify(next.claimMap),
    next.status,
    now,
  ];
  if (sealed !== undefined) {
    set.push("client_secret_sealed = ?");
    params.push(sealed);
  }
  const rotated = sealed !== undefined;
  const changed =
    JSON.stringify(was) !== JSON.stringify(auditShape(next)) || rotated;
  if (!changed) {
    return { ok: true, connection: (await connectionView(db, id))! };
  }
  const action =
    next.status !== before.status
      ? next.status === "disabled"
        ? "identity.connection.disable"
        : "identity.connection.enable"
      : rotated && JSON.stringify(was) === JSON.stringify(auditShape(next))
        ? "identity.connection.rotate_secret"
        : "identity.connection.update";
  try {
    await db.batch([
      {
        sql: `UPDATE identity_connections SET ${set.join(", ")} WHERE id = ? AND scope = 'platform'`,
        params: [...params, id],
      },
      auditRow(
        actor,
        now,
        action,
        id,
        action === "identity.connection.rotate_secret"
          ? `Replaced the client secret of ${next.label}`
          : `Changed the connection ${next.label}`,
        was,
        auditShape(next),
      ),
    ]);
  } catch (e) {
    if (isUnique(e)) {
      return refuse(
        409,
        "exists",
        "This issuer and client ID are already connected.",
        ["clientId"],
      );
    }
    throw e;
  }
  return { ok: true, connection: (await connectionView(db, id))! };
}

export async function deleteConnection(
  db: Db,
  id: string,
  actor: AuditActor,
  now: number,
): Promise<{ ok: true } | Refusal> {
  const view = CONNECTION_ID_RE.test(id) ? await connectionView(db, id) : null;
  if (!view) return refuse(404, "not_found", "No such connection.");
  if (view.source === "env") {
    return refuse(
      409,
      "seeded",
      "The seeded connection cannot be deleted. Disable it instead.",
    );
  }
  if (view.links > 0) {
    return refuse(
      409,
      "has_links",
      `${view.links} ${view.links === 1 ? "person signs" : "people sign"} in through it. Disable it instead.`,
    );
  }
  await db.batch([
    {
      sql: "DELETE FROM identity_connection_domains WHERE connection_id = ?",
      params: [id],
    },
    {
      sql: "DELETE FROM identity_connections WHERE id = ? AND scope = 'platform'",
      params: [id],
    },
    auditRow(
      actor,
      now,
      "identity.connection.delete",
      id,
      `Deleted the connection ${view.label}`,
      auditShape({ ...view }),
    ),
  ]);
  return { ok: true };
}

// ── domains ──────────────────────────────────────────────────────────────────────────────────

export type DomainAction =
  | { op: "add"; domain: unknown }
  | { op: "verify"; domain: string }
  | { op: "remove"; domain: string }
  | { op: "enforce"; domain: string; enforce: boolean };

const DOMAIN_AUDIT: Record<DomainAction["op"], string> = {
  add: "identity.connection.domain_add",
  verify: "identity.connection.domain_verify",
  remove: "identity.connection.domain_remove",
  enforce: "identity.connection.domain_enforce",
};

async function recordDomain(
  db: Db,
  actor: AuditActor,
  now: number,
  action: DomainAction["op"],
  id: string,
  domain: string,
  summary: string,
): Promise<void> {
  const stmt = auditRow(
    actor,
    now,
    DOMAIN_AUDIT[action],
    id,
    summary,
    undefined,
    { domain },
  );
  await db.run(stmt.sql, ...stmt.params);
}

export async function changeDomain(
  db: Db,
  id: string,
  action: DomainAction,
  actor: AuditActor,
  now: number,
  opts: { fetch?: OidcFetch } = {},
): Promise<
  | {
      ok: true;
      connection: ConnectionView;
      verify?: VerifyDomainResult["status"];
    }
  | Refusal
> {
  const conn = CONNECTION_ID_RE.test(id)
    ? await resolveConnection(db, id)
    : null;
  if (!conn || conn.scope !== PLATFORM_SCOPE)
    return refuse(404, "not_found", "No such connection.");
  let verify: VerifyDomainResult["status"] | undefined;
  if (action.op === "add") {
    const r = await addConnectionDomain(
      db,
      { connectionId: id, domain: action.domain as string },
      now,
    );
    if (!r.ok) {
      return refuse(
        r.reason === "invalid_domain" ? 422 : 404,
        r.reason,
        r.reason === "invalid_domain"
          ? "Enter a domain such as example.com. Subdomains need their own entry."
          : "No such connection.",
        ["domain"],
      );
    }
    await recordDomain(
      db,
      actor,
      now,
      "add",
      id,
      r.domain,
      `Claimed ${r.domain} for ${conn.label}`,
    );
  } else if (action.op === "verify") {
    const r = await verifyConnectionDomain(db, id, action.domain, now, opts);
    if (r.status === "unknown_domain")
      return refuse(404, "not_found", "No such domain.");
    verify = r.status;
    if (r.status === "verified") {
      await recordDomain(
        db,
        actor,
        now,
        "verify",
        id,
        action.domain,
        `Verified ${action.domain} for ${conn.label}`,
      );
    }
  } else if (action.op === "remove") {
    if (!(await removeConnectionDomain(db, id, action.domain))) {
      return refuse(404, "not_found", "No such domain.");
    }
    await recordDomain(
      db,
      actor,
      now,
      "remove",
      id,
      action.domain,
      `Released ${action.domain} from ${conn.label}`,
    );
  } else {
    if (!(await setDomainEnforce(db, id, action.domain, action.enforce))) {
      return refuse(404, "not_found", "No such domain.");
    }
    await recordDomain(
      db,
      actor,
      now,
      "enforce",
      id,
      action.domain,
      `${action.enforce ? "Required" : "Stopped requiring"} ${conn.label} for ${action.domain}`,
    );
  }
  return {
    ok: true,
    connection: (await connectionView(db, id))!,
    ...(verify ? { verify } : {}),
  };
}
