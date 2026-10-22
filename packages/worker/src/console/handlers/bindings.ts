/**
 * The grant writes (ST-31.6; ST-28 plan §2.3 G1 to G5, §5.2):
 *
 *   POST   /bindings                         {member, role, scope, areas, confirm?}  a new grant
 *   PATCH  /bindings/<id>                    {areas, confirm?}  edit a product admin's areas
 *   DELETE /bindings/<id>                    take a grant back
 *   POST   /products/<slug>/members          the product twin of POST (D-d)
 *   PATCH|DELETE /products/<slug>/members/<bindingId>
 *
 * The platform rows are area `members` at platform scope (a Platform admin or a Superadmin); the
 * twins are area `members` on the product (a Product admin of it with `members`, or a Superadmin).
 * Session only: no row names a `tokenScope`.
 *
 * What every write checks, in this order, and refuses with a 403 whose `reason` is not `no_access`:
 *
 *   1. The writer is a signed-in account (`aid`) with a member id. A v1 cookie or a token has no
 *      account, so it cannot be told apart from its grantee and writes nothing.
 *   2. A per-member write budget, failing closed (an outage refuses, it does not unmeter grants).
 *   3. The body: only the fields named here, a member id shaped `mbr_…`, and a grant the engine
 *      validates (`validateGrant`: role, scope, areas, no system product).
 *   4. The engine: `mayGrant` for a new grant, `mayChange` for a PATCH (revoke what was, grant
 *      what comes out when it widens), `mayRevoke` for a DELETE. G1, G2, G3 and D-c live there;
 *      the route table cannot tell a Platform admin from a Superadmin, so this is the only gate.
 *   5. The target exists: a product scope names a real product that is not the system product.
 *   6. `confirmLevel`: an L2 target (Superadmin, Platform admin, `products:*`) needs `confirm: "L2"`.
 *   7. The grantee: resolved through the roster by computing each candidate's member id (the id is
 *      one-way), an erased account refused (`erasureVerdict`), a disabled one refused, and the
 *      writer never the grantee (D-g, no self-grants).
 *   8. Step-up (G4): the POST rows carry it in the route table; a PATCH needs it only when
 *      `isWidening`. A DELETE and a narrowing PATCH need none.
 *
 * The change and its audit rows commit in one batch (`rbac.grant` / `rbac.revoke` to
 * `platform_audit`, and to the product's `audit` for a product scope or a product route). An edit
 * and a delete carry a guard on the `areas_json` the caller authorised against, so a concurrent
 * edit makes this one a 409 and writes neither row. The actor is the `mbr_` id; a body, an audit
 * row and a notice name the grantee by member id (and, in the notice, name), never the account id.
 *
 * G5 notices go to the grantee and every Superadmin, after the commit, best effort; the response
 * counts them (`notified`) and says when nobody was reached.
 */

import { ErrorCode } from "../../core/errors.js";
import {
  auditStatementFor,
  platformAuditStatementFor,
} from "../../core/audit.js";
import { erasureVerdict } from "../../core/accounts/erasureFence.js";
import { adminJson, err, readBody } from "../../core/console/respond.js";
import { isMemberId, memberIdFor } from "../../core/console/memberId.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import { deliverEmail } from "../../core/notify/emailDelivery.js";
import { accessChangedNotice } from "../../core/notify/templates.js";
import { getProduct } from "../../core/products/store.js";
import {
  bindingUnchangedSql,
  findAccountBinding,
  getBinding,
  listBoundAccountIds,
  newBindingId,
  rowToGrant,
  stmtDeleteBindingIfUnchanged,
  stmtInsertBinding,
  stmtUpdateBindingAreas,
  type BindingRow,
} from "../../core/rbac/bindings.js";
import type { GrantScope, Role } from "../../core/rbac/can.js";
import {
  confirmLevel,
  isWidening,
  mayChange,
  mayGrant,
  mayRevoke,
  validateGrant,
  type GrantSpec,
} from "../../core/rbac/grantRules.js";
import {
  consoleDirectory,
  consoleRootHolders,
  type ConsoleDirectoryEntry,
} from "../../services/identity/public.js";
import { requireStepUp } from "../stepUp.js";
import type { AdminCtx } from "../routes.js";
import { superadminAccountIds } from "./productMembers.js";

/** The write budget per member: generous for a person, a wall for a stolen session. */
const WRITE_LIMIT = 30;
const WRITE_WINDOW_SECONDS = 300;
/** The most accounts read to resolve a member id (as `GET /members/<id>`). */
const RESOLVE_LIMIT = 20000;
/** The most addresses one change mails. */
const NOTICE_CAP = 25;

const ROLE_LABEL: Record<Role, string> = {
  superadmin: "Superadmin",
  platform_admin: "Platform admin",
  product_admin: "Product admin",
  console_access: "Console access",
};

/** Where a route reaches the same writes from: the platform, or one product's Members tab. */
export interface Via {
  /** The product of a `/products/<slug>/members` route; `null` for `/bindings`. */
  slug: string | null;
}

// ── Shared helpers ──────────────────────────────────────────────────────────────────────────

const forbiddenReason = (reason: string, message: string, extra = {}) =>
  err(403, ErrorCode.Forbidden, message, { reason, ...extra });

const invalid = (fields: string[], reason?: string) =>
  err(422, ErrorCode.BadRequest, "invalid request", {
    fields,
    ...(reason ? { reason } : {}),
  });

/** Only these body fields are read; anything else is refused, not ignored. */
function unknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(body).filter((k) => !allowed.includes(k));
}

interface Writer {
  memberId: string;
  accountId: string;
}

/** A write needs a signed-in account and its member id (1 above). */
function writerOf(c: AdminCtx): Writer | Response {
  const accountId = c.session.aid;
  const memberId = c.session.principal?.memberId;
  if (!accountId || !memberId || !isMemberId(memberId))
    return forbiddenReason(
      "account_session_required",
      "Sign in again to change who has access.",
    );
  return { memberId, accountId };
}

async function budget(c: AdminCtx, w: Writer): Promise<Response | null> {
  const ok = await rateLimitOk(
    c.env,
    "_admin",
    {
      bucket: "adminGrantWrite",
      id: w.memberId,
      limit: WRITE_LIMIT,
      windowSec: WRITE_WINDOW_SECONDS,
    },
    c.now,
  );
  return ok
    ? null
    : err(429, "rate_limited", "too many access changes; try again later");
}

/** The grant a stored row holds, in the engine's shape; `null` when the row cannot be read. */
function specOfRow(row: BindingRow): GrantSpec | null {
  const g = rowToGrant(row);
  return g ? { role: g.role, scope: g.scope, areas: g.areas } : null;
}

/** What a response and an audit row say about a binding (no account id). */
function view(
  row: Pick<BindingRow, "id" | "granted_at" | "source">,
  memberId: string,
  s: GrantSpec,
) {
  return {
    bindingId: row.id,
    memberId,
    role: s.role,
    scope: s.scope,
    areas: s.areas ? [...s.areas] : null,
    source: row.source,
    grantedAt: row.granted_at,
  };
}

function scopeLabel(scope: GrantScope, productName: string | null): string {
  if (scope === "platform") return "the platform";
  if (scope === "products:*") return "all products";
  return productName ?? scope.slice("product:".length);
}

/**
 * The grantee behind a member id, found the way `GET /members/<id>` finds a member: compute the
 * id of each account that holds a binding or the root rule, and compare. A person who holds
 * neither is not a candidate, so this cannot be used to look anyone else up.
 */
async function resolveMember(
  c: AdminCtx,
  memberId: string,
): Promise<{ accountId: string; entry: ConsoleDirectoryEntry } | Response> {
  const gone = () =>
    err(404, ErrorCode.NotFound, "no such member", {
      reason: "no_such_member",
    });
  const bound = await listBoundAccountIds(c.db, RESOLVE_LIMIT);
  const roots = await consoleRootHolders(c.env, c.db, c.now);
  let accountId: string | null = null;
  for (const id of new Set([...bound.slice(0, RESOLVE_LIMIT), ...roots])) {
    if ((await memberIdFor(c.env, id)) === memberId) {
      accountId = id;
      break;
    }
  }
  if (!accountId) return gone();
  // The erasure ledger outranks D1: a restore can bring an erased account back with its member id.
  const verdict = await erasureVerdict(c.env, c.now, accountId);
  if (verdict === "erased") return gone();
  if (verdict !== "clear")
    return err(503, "unavailable", "try again in a moment", {
      reason: "erasure_ledger_unavailable",
    });
  const entry = (await consoleDirectory(c.env, c.db, [accountId], c.now)).get(
    accountId,
  );
  if (!entry) return gone();
  if (entry.disabled)
    return err(409, ErrorCode.BadRequest, "that account is disabled", {
      reason: "member_disabled",
    });
  return { accountId, entry };
}

/** D-g: the writer is never the grantee of a grant or of a widening. */
function isSelf(w: Writer, accountId: string, memberId?: string): boolean {
  return accountId === w.accountId || memberId === w.memberId;
}

const selfGrant = () =>
  forbiddenReason("self_grant", "You can't grant yourself access.");

/** The L2 confirm of an L2 target (6 above). */
function confirmRefusal(
  body: Record<string, unknown>,
  target: GrantSpec,
): Response | null {
  if (confirmLevel(target) === "L1") return null;
  if (body.confirm === "L2") return null;
  return err(
    422,
    ErrorCode.BadRequest,
    "this change needs an L2 confirmation",
    {
      reason: "confirm_required",
      confirm: "L2",
      fields: ["confirm"],
    },
  );
}

interface Audited {
  action: "rbac.grant" | "rbac.revoke";
  bindingId: string;
  memberId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  /** Write the rows only while this holds (a guarded edit or delete). */
  when?: { sql: string; params: (string | null)[] };
}

/** The audit rows for a change: the platform trail always, and the product's when one is named. */
function auditRows(c: AdminCtx, productSlug: string | null, a: Audited) {
  const target = { kind: "console_role_binding", id: a.bindingId };
  const change = {
    ...(a.before === undefined ? {} : { before: a.before }),
    ...(a.after === undefined ? {} : { after: a.after }),
  };
  const rows = [
    platformAuditStatementFor(
      c.session,
      c.now,
      a.action,
      target,
      a.summary,
      change,
      a.when,
    ),
  ];
  if (productSlug)
    rows.push(
      auditStatementFor(
        productSlug,
        c.session,
        c.now,
        a.action,
        target,
        a.summary,
        a.when,
      ),
    );
  return rows;
}

/** The product whose trail also gets the row: the route's, or the grant's own product scope. */
function auditProduct(via: Via, scope: GrantScope): string | null {
  if (via.slug) return via.slug;
  return scope.startsWith("product:") ? scope.slice("product:".length) : null;
}

export interface Notified {
  sent: number;
  of: number;
  /** True when no one was told: email is off, or every address was suppressed or failed. */
  nobodyNotified: boolean;
}

/**
 * G5: tell the grantee and every Superadmin. Best effort, after the commit: a failed or
 * suppressed address never undoes the change. Counts only, never an address.
 */
async function notify(
  c: AdminCtx,
  granteeAccountId: string,
  grantee: ConsoleDirectoryEntry,
  change: "granted" | "changed" | "revoked",
  spec: GrantSpec,
): Promise<Notified> {
  try {
    const supers = await superadminAccountIds(c.env, c.db, c.now);
    const ids = [...new Set([granteeAccountId, ...supers.map((s) => s.id)])];
    const dir = await consoleDirectory(c.env, c.db, ids, c.now);
    const seen = new Set<string>();
    const to: string[] = [];
    for (const id of ids) {
      const e = dir.get(id);
      const addr = e?.email.trim();
      if (!e || e.disabled || !addr) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      to.push(addr);
    }
    const recipients = to.slice(0, NOTICE_CAP);
    const productName =
      spec.scope.startsWith("product:") && c.product?.slug
        ? (c.product.name ?? null)
        : spec.scope.startsWith("product:")
          ? ((await getProduct(c.db, spec.scope.slice("product:".length)))
              ?.name ?? null)
          : null;
    const message = accessChangedNotice({
      change,
      member: grantee.name || grantee.email,
      actor: c.session.name || c.session.email,
      roleLabel: ROLE_LABEL[spec.role],
      scopeLabel: scopeLabel(spec.scope, productName),
      areas: spec.areas,
      origin: c.env.CONSOLE_ORIGIN,
    });
    const results = await Promise.all(
      recipients.map(async (addr) => {
        try {
          const r = await deliverEmail(
            c.env,
            c.db,
            {
              sender: { kind: "platform", audience: "operator" },
              to: addr,
              ...message,
            },
            c.now,
          );
          return r.ok;
        } catch {
          return false;
        }
      }),
    );
    const sent = results.filter(Boolean).length;
    return { sent, of: recipients.length, nobodyNotified: sent === 0 };
  } catch {
    return { sent: 0, of: 0, nobodyNotified: true };
  }
}

// ── POST: a new grant ───────────────────────────────────────────────────────────────────────

export interface GrantInput {
  member: unknown;
  role: unknown;
  scope: unknown;
  areas: unknown;
}

/** The new-grant write, once a route has fixed the role and scope it takes from the body. */
export async function createBinding(
  c: AdminCtx,
  via: Via,
  body: Record<string, unknown>,
  input: GrantInput,
): Promise<Response> {
  const w = writerOf(c);
  if (w instanceof Response) return w;
  const limited = await budget(c, w);
  if (limited) return limited;

  if (typeof input.member !== "string" || !isMemberId(input.member))
    return invalid(["member"]);
  const checked = validateGrant({
    role: input.role,
    scope: input.scope,
    areas: input.areas,
  });
  if (!checked.ok) {
    const field = checked.reason.startsWith("areas")
      ? "areas"
      : checked.reason.startsWith("role")
        ? "role"
        : checked.reason === "scope" || checked.reason === "system_product"
          ? "scope"
          : "role";
    return invalid([field], checked.reason);
  }
  const spec = checked.grant;

  // G1, G2, G3.
  if (!mayGrant(c.session.principal, spec))
    return forbiddenReason("grant_refused", "You can't give this access.");

  // The target exists (no bindings for future slugs) and is not the system product.
  const slug = auditProduct({ slug: null }, spec.scope);
  if (slug !== null) {
    const product = await getProduct(c.db, slug);
    if (!product)
      return err(404, ErrorCode.NotFound, "no such product", {
        reason: "no_such_product",
      });
    if (product.system === 1) return invalid(["scope"], "system_product");
  }
  if (via.slug !== null) {
    const product = c.product;
    if (!product || product.slug !== via.slug || product.system === 1)
      return invalid(["scope"], "system_product");
  }

  const refused = confirmRefusal(body, spec);
  if (refused) return refused;

  const who = await resolveMember(c, input.member);
  if (who instanceof Response) return who;
  if (isSelf(w, who.accountId, who.entry.memberId)) return selfGrant();

  const existing = await findAccountBinding(
    c.db,
    who.accountId,
    spec.role,
    spec.scope,
  );
  if (existing) return exists(existing.id);

  const id = newBindingId();
  const row = { id, granted_at: c.now, source: "grant" };
  const shown = view(row, who.entry.memberId, spec);
  try {
    await c.db.batch([
      stmtInsertBinding({
        id,
        accountId: who.accountId,
        emailNorm: null,
        role: spec.role,
        scope: spec.scope,
        areas: spec.areas,
        source: "grant",
        grantedBy: w.memberId,
        grantedAt: c.now,
      }),
      ...auditRows(c, auditProduct(via, spec.scope), {
        action: "rbac.grant",
        bindingId: id,
        memberId: who.entry.memberId,
        summary: `Granted ${ROLE_LABEL[spec.role]} on ${spec.scope}${
          spec.areas ? ` (${spec.areas.join(", ")})` : ""
        } to ${who.entry.memberId}`,
        after: shown,
      }),
    ]);
  } catch (e) {
    // A concurrent identical grant hit the unique index: answer it as the duplicate it is.
    const raced = await findAccountBinding(
      c.db,
      who.accountId,
      spec.role,
      spec.scope,
    );
    if (raced) return exists(raced.id);
    throw e;
  }
  const notified = await notify(c, who.accountId, who.entry, "granted", spec);
  return adminJson(
    { ok: true, binding: shown, confirm: confirmLevel(spec), notified },
    201,
  );
}

function exists(bindingId: string): Response {
  return err(409, ErrorCode.BadRequest, "that access is already granted", {
    reason: "exists",
    bindingId,
  });
}

/** `POST /bindings`. */
export async function handleBindingCreate(c: AdminCtx): Promise<Response> {
  const body = await readBody(c.req);
  const extra = unknownFields(body, [
    "member",
    "role",
    "scope",
    "areas",
    "confirm",
  ]);
  if (extra.length) return invalid(extra, "unknown_field");
  // Roles that carry no areas take them as absent; a Product admin must say so explicitly.
  const areas =
    body.areas === undefined && body.role !== "product_admin"
      ? null
      : body.areas;
  return createBinding(c, { slug: null }, body, {
    member: body.member,
    role: body.role,
    scope: body.scope,
    areas,
  });
}

// ── PATCH and DELETE ────────────────────────────────────────────────────────────────────────

/**
 * The binding a route names, or the 404 that says nothing: an invite row (31.7), an unknown id,
 * and, on a product route, a binding of any other scope (another product's, a platform one).
 */
async function boundTo(
  c: AdminCtx,
  via: Via,
  id: string,
): Promise<(BindingRow & { account_id: string }) | Response> {
  const row = await getBinding(c.db, id);
  if (
    !row ||
    row.account_id === null ||
    (via.slug !== null && row.scope !== `product:${via.slug}`)
  )
    return err(404, ErrorCode.NotFound);
  return row as BindingRow & { account_id: string };
}

/** The grantee's directory entry, for the member id and the notice. */
async function granteeOf(
  c: AdminCtx,
  accountId: string,
): Promise<ConsoleDirectoryEntry | null> {
  return (
    (await consoleDirectory(c.env, c.db, [accountId], c.now)).get(accountId) ??
    null
  );
}

/** A batch result that says the guarded statement changed nothing: someone else got there first. */
async function applyGuarded(
  c: AdminCtx,
  statements: Parameters<AdminCtx["db"]["batch"]>[0],
): Promise<boolean> {
  if (!c.db.batchChanges) {
    await c.db.batch(statements);
    return true;
  }
  const counts = await c.db.batchChanges(statements);
  return (counts[counts.length - 1] ?? 0) > 0;
}

const changed = () =>
  err(409, ErrorCode.BadRequest, "this access changed; reload and try again", {
    reason: "changed",
  });

/** `PATCH /bindings/<id>` and its product twin: a Product admin's areas. */
export async function editBinding(c: AdminCtx, via: Via): Promise<Response> {
  const w = writerOf(c);
  if (w instanceof Response) return w;
  const limited = await budget(c, w);
  if (limited) return limited;

  const body = await readBody(c.req);
  // Only the areas change. A different grantee, role or scope is a new grant (POST), so a body
  // that names one is refused rather than ignored.
  const extra = unknownFields(body, ["areas", "confirm"]);
  if (extra.length) return invalid(extra, "unknown_field");
  if (!("areas" in body)) return invalid(["areas"], "areas_missing");

  const row = await boundTo(c, via, c.params.id ?? c.params.bindingId ?? "");
  if (row instanceof Response) return row;
  const before = specOfRow(row);
  if (!before)
    return err(409, ErrorCode.BadRequest, "this binding cannot be edited", {
      reason: "unreadable",
    });
  const checked = validateGrant({
    role: before.role,
    scope: before.scope,
    areas: body.areas,
  });
  if (!checked.ok) return invalid(["areas"], checked.reason);
  const after = checked.grant;

  if (!mayChange(c.session.principal, before, after))
    return forbiddenReason("grant_refused", "You can't change this access.");

  const nextJson = after.areas === null ? null : JSON.stringify(after.areas);
  if (nextJson === row.areas_json) {
    const entry = await granteeOf(c, row.account_id);
    return adminJson({
      ok: true,
      unchanged: true,
      binding: view(row, entry?.memberId ?? "", before),
    });
  }

  const widening = isWidening(before, after);
  if (widening) {
    // D-g: widening your own access is a grant to yourself.
    if (isSelf(w, row.account_id)) return selfGrant();
    const refused = confirmRefusal(body, after);
    if (refused) return refused;
    const stepUp = requireStepUp(c.session, c.now);
    if (stepUp) return stepUp;
  }

  const entry = await granteeOf(c, row.account_id);
  if (!entry) return err(404, ErrorCode.NotFound);
  const shown = view(row, entry.memberId, after);
  const guard = bindingUnchangedSql(row.id, row.areas_json);
  const ok = await applyGuarded(c, [
    ...auditRows(c, auditProduct(via, after.scope), {
      action: widening ? "rbac.grant" : "rbac.revoke",
      bindingId: row.id,
      memberId: entry.memberId,
      summary: `${widening ? "Widened" : "Narrowed"} ${ROLE_LABEL[after.role]} on ${after.scope} for ${entry.memberId}`,
      before: view(row, entry.memberId, before),
      after: shown,
      when: guard,
    }),
    stmtUpdateBindingAreas(row.id, after.areas, row.areas_json),
  ]);
  if (!ok) return changed();
  const notified = await notify(c, row.account_id, entry, "changed", after);
  return adminJson({ ok: true, binding: shown, widened: widening, notified });
}

/** `DELETE /bindings/<id>` and its product twin. No step-up: taking access back only narrows (G4). */
export async function revokeBinding(c: AdminCtx, via: Via): Promise<Response> {
  const w = writerOf(c);
  if (w instanceof Response) return w;
  const limited = await budget(c, w);
  if (limited) return limited;

  const row = await boundTo(c, via, c.params.id ?? c.params.bindingId ?? "");
  if (row instanceof Response) return row;
  // A row the reader cannot understand grants nothing; only a Superadmin may clear it away, so the
  // engine is asked about no binding at all (`mayRevoke` fails closed on one that does not validate).
  const readable = specOfRow(row);
  if (!mayRevoke(c.session.principal, readable))
    return forbiddenReason("grant_refused", "You can't take this access back.");
  const spec = readable ?? {
    role: row.role as Role,
    scope: row.scope as GrantScope,
    areas: null,
  };

  const entry = await granteeOf(c, row.account_id);
  const memberId =
    entry?.memberId ?? (await memberIdFor(c.env, row.account_id));
  const guard = bindingUnchangedSql(row.id, row.areas_json);
  const ok = await applyGuarded(c, [
    ...auditRows(c, auditProduct(via, spec.scope), {
      action: "rbac.revoke",
      bindingId: row.id,
      memberId,
      summary: `Revoked ${ROLE_LABEL[spec.role]} on ${spec.scope} from ${memberId}`,
      before: view(row, memberId, spec),
      when: guard,
    }),
    stmtDeleteBindingIfUnchanged(row.id, row.areas_json),
  ]);
  if (!ok) return changed();
  const notified = entry
    ? await notify(c, row.account_id, entry, "revoked", spec)
    : { sent: 0, of: 0, nobodyNotified: true };
  return adminJson({ ok: true, bindingId: row.id, notified });
}

export const handleBindingEdit = (c: AdminCtx) =>
  editBinding(c, { slug: null });
export const handleBindingRevoke = (c: AdminCtx) =>
  revokeBinding(c, { slug: null });
