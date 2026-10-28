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
import type { DbStatement } from "../../db/types.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import { recipientHash } from "../../core/notify/emailLimits.js";
import {
  accessChangedNotice,
  accessInviteNotice,
  accessInvitesSentNotice,
  consoleInviteLink,
} from "../../core/notify/templates.js";
import { strictEmail } from "../../core/strictEmail.js";
import { normalizeEmail } from "../../platform/email.js";
import { getProduct } from "../../core/products/store.js";
import { usableOrigin } from "../../core/hosts.js";
import {
  bindingUnchangedSql,
  findAccountBinding,
  findInvite,
  getBinding,
  hasAccountBinding,
  listBoundAccountIds,
  newBindingId,
  rowToGrant,
  stmtDeleteBindingIfUnchanged,
  stmtInsertBinding,
  stmtUpdateBindingAreas,
  stmtUpsertInvite,
  INVITE_TTL_SECONDS,
  type BindingRow,
} from "../../core/rbac/bindings.js";
import type { GrantScope, Role } from "../../core/rbac/can.js";
import {
  confirmLevel,
  inviteBootstrapAllowed,
  isWidening,
  mayChange,
  mayGrant,
  mayRevoke,
  validateGrant,
  type GrantSpec,
} from "../../core/rbac/grantRules.js";
import {
  accountAddresses,
  accountsWithVerifiedPrimaryEmail,
  consoleDirectory,
  consoleRootHolders,
  type ConsoleDirectoryEntry,
} from "../../services/identity/public.js";
import { requireStepUp } from "../stepUp.js";
import type { AdminCtx } from "../routes.js";
import {
  ROLE_LABEL,
  invalidRequest as invalid,
  scopeLabel,
  sendOperatorNotice,
  superadminAccountIds,
  unknownFields,
} from "./accessShared.js";
import { requireAccountSession } from "../lib/accountSession.js";
import { NOTICE_CAP, notifySuperadmins } from "../lib/operatorNotices.js";

/** The write budget per member: generous for a person, a wall for a stolen session. */
const WRITE_LIMIT = 30;
const WRITE_WINDOW_SECONDS = 300;
/** The most accounts read to resolve a member id (as `GET /members/<id>`). */
const RESOLVE_LIMIT = 20000;
/** The most addresses one invitation request takes (ST-31.7). */
const MAX_INVITE_ADDRESSES = 20;
/** Invitations one member may send per hour, counted per address (mail abuse). */
const INVITE_LIMIT = 100;
const INVITE_WINDOW_SECONDS = 3600;
/** The most operator mails one invitation request sends besides the invitations themselves. */
const INVITE_NOTICE_CAP = 50;

/** Where a route reaches the same writes from: the platform, or one product's Members tab. */
export interface Via {
  /** The product of a `/products/<slug>/members` route; `null` for `/bindings`. */
  slug: string | null;
}

// ── Shared helpers ──────────────────────────────────────────────────────────────────────────

const forbiddenReason = (reason: string, message: string, extra = {}) =>
  err(403, ErrorCode.Forbidden, message, { reason, ...extra });

interface Writer {
  memberId: string;
  accountId: string;
}

/** A write needs a signed-in account and its member id (1 above). */
function writerOf(c: AdminCtx): Writer | Response {
  const acct = requireAccountSession(c.session);
  if (acct instanceof Response) return acct;
  const accountId = acct.accountId;
  const memberId = c.session.principal?.memberId;
  if (!memberId || !isMemberId(memberId))
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
  action: "rbac.grant" | "rbac.revoke" | "rbac.invite";
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
  /** Mails this call may still send (shared across a batch); the caller's own cap otherwise. */
  mails: { left: number } = { left: NOTICE_CAP },
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
    const recipients = to.slice(
      0,
      Math.max(0, Math.min(NOTICE_CAP, mails.left)),
    );
    mails.left -= recipients.length;
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
      recipients.map((addr) =>
        sendOperatorNotice(
          c.env,
          c.db,
          addr,
          message,
          c.now,
          confirmLevel(spec) === "L2",
        ),
      ),
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

  // Exactly one of `member` (an existing member) and `emails` (invitations, ST-31.7).
  const inviting = body.emails !== undefined;
  if ((input.member !== undefined) === inviting)
    return invalid(
      inviting ? ["member", "emails"] : ["member"],
      "member_or_emails",
    );
  let emails: string[] = [];
  if (inviting) {
    const e = body.emails;
    if (
      !Array.isArray(e) ||
      e.length === 0 ||
      !e.every((x) => typeof x === "string")
    )
      return invalid(["emails"]);
    if (e.length > MAX_INVITE_ADDRESSES)
      return invalid(["emails"], "too_many_emails");
    emails = e as string[];
  } else if (typeof input.member !== "string" || !isMemberId(input.member))
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

  if (inviting) return createInvites(c, via, w, spec, emails);

  const who = await resolveMember(c, input.member as string);
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

// ── POST with emails: invitations (ST-31.7) ─────────────────────────────────────────────────

type InviteStatus = "invited" | "updated" | "merged" | "invalid" | "exists";

interface InviteResult {
  email: string;
  status: InviteStatus;
  bindingId?: string;
  expiresAt?: number;
  /** An invite for a role that signs in through the operator IdP (SM-7): created, not yet usable. */
  needsOperatorSignIn?: boolean;
  /** True when the invitation mail went out. */
  emailed?: boolean;
  /** The sign-in link, only when the mail did not go out. No secret: it is a hint, not a token. */
  link?: string;
}

/** The origin the console is served from: the configured one, else the one this request used. */
function consoleOrigin(c: AdminCtx): string {
  return (
    usableOrigin(c.env.CONSOLE_ORIGIN?.trim() ?? "") ??
    new URL(c.req.url).origin
  );
}

/** The opaque stand-in for an invited address in the audit trail. */
async function inviteeRef(c: AdminCtx, email: string): Promise<string> {
  return `invitee:${(await recipientHash(c.env, email)).slice(0, 12)}`;
}

/**
 * One request, one result per address. Authorization (writer, budget, shape, `mayGrant`, target,
 * L2 confirm) ran in `createBinding` for the one grant every address shares, so each invitation
 * is held to what a member grant is. Then, per address, in this order:
 *
 *   - an address the request repeats is `merged`; one that is not an address is `invalid`;
 *   - D-g: the writer's own address (session or any verified one) refuses the whole request;
 *   - D-e: the address of an existing console member (a verified match on an active account that
 *     holds a binding or the root rule, erasure ledger clear) becomes an account binding
 *     (`updated`, or `exists` when it already holds that grant); any other address is `invited`.
 *     An address that matches two members is invited, not guessed at.
 *
 * Everything is one batch with its audit rows (`rbac.invite` names the invitee by an opaque
 * reference, `rbac.grant` by member id). Mail goes out after the commit.
 */
async function createInvites(
  c: AdminCtx,
  via: Via,
  w: Writer,
  spec: GrantSpec,
  rawEmails: readonly string[],
): Promise<Response> {
  const results: InviteResult[] = [];
  const todo: { index: number; email: string }[] = [];
  const seen = new Set<string>();
  for (const raw of rawEmails) {
    const email = strictEmail(raw);
    if (!email) {
      results.push({ email: raw.trim().slice(0, 254), status: "invalid" });
    } else if (seen.has(email)) {
      results.push({ email, status: "merged" });
    } else {
      seen.add(email);
      results.push({ email, status: "invited" });
      todo.push({ index: results.length - 1, email });
    }
  }

  // D-g, for an address as for a member id: your own is a grant to yourself. Every address on
  // the writer's account counts, verified or not; this is partial (an address linked later is
  // caught when the invite converts, ST-31.8).
  if (todo.length > 0) {
    const mine = new Set(
      (await accountAddresses(c.db, w.accountId)).map(normalizeEmail),
    );
    if (c.session.email) mine.add(normalizeEmail(c.session.email));
    if (todo.some((t) => mine.has(t.email))) return selfGrant();
  }

  // D-e: who among the addresses is already a member?
  const memberOf = new Map<string, string>(); // address -> account id
  if (todo.length > 0) {
    let roots: Set<string> | null = null;
    for (const t of todo) {
      const found: string[] = [];
      for (const candId of await accountsWithVerifiedPrimaryEmail(
        c.db,
        t.email,
      )) {
        const cand = { accountId: candId };
        const verdict = await erasureVerdict(c.env, c.now, cand.accountId);
        if (verdict === "unavailable")
          return err(503, "unavailable", "try again in a moment", {
            reason: "erasure_ledger_unavailable",
          });
        if (verdict !== "clear") continue;
        roots ??= new Set(await consoleRootHolders(c.env, c.db, c.now));
        if (
          roots.has(cand.accountId) ||
          (await hasAccountBinding(c.db, cand.accountId))
        )
          found.push(cand.accountId);
      }
      if (found.includes(w.accountId)) return selfGrant();
      if (found.length === 1) memberOf.set(t.email, found[0]!);
    }
  }

  // The mail budget, per member, counted per distinct valid address, members included, so the
  // 429 does not depend on whether an address is a member. All or nothing.
  for (let i = 0; i < todo.length; i++) {
    const ok = await rateLimitOk(
      c.env,
      "_admin",
      {
        bucket: "adminInviteAddress",
        id: w.memberId,
        limit: INVITE_LIMIT,
        windowSec: INVITE_WINDOW_SECONDS,
      },
      c.now,
    );
    if (!ok)
      return err(429, "rate_limited", "too many invitations; try again later", {
        reason: "invite_budget",
      });
  }

  const statements: DbStatement[] = [];
  const product = auditProduct(via, spec.scope);
  const granted: { accountId: string; email: string }[] = [];
  const invited: { index: number; email: string; id: string }[] = [];
  const needsOperator = !inviteBootstrapAllowed(spec);
  const expiresAt = c.now + INVITE_TTL_SECONDS;
  for (const t of todo) {
    const accountId = memberOf.get(t.email);
    const r = results[t.index]!;
    if (accountId) {
      const existing = await findAccountBinding(
        c.db,
        accountId,
        spec.role,
        spec.scope,
      );
      if (existing) {
        r.status = "exists";
        r.bindingId = existing.id;
        continue;
      }
      const id = newBindingId();
      const memberId = await memberIdFor(c.env, accountId);
      r.status = "updated";
      r.bindingId = id;
      granted.push({ accountId, email: t.email });
      statements.push(
        stmtInsertBinding({
          id,
          accountId,
          emailNorm: null,
          role: spec.role,
          scope: spec.scope,
          areas: spec.areas,
          source: "grant",
          grantedBy: w.memberId,
          grantedAt: c.now,
        }),
        ...auditRows(c, product, {
          action: "rbac.grant",
          bindingId: id,
          memberId,
          summary: `Granted ${ROLE_LABEL[spec.role]} on ${spec.scope}${
            spec.areas ? ` (${spec.areas.join(", ")})` : ""
          } to ${memberId}`,
          after: view(
            { id, granted_at: c.now, source: "grant" },
            memberId,
            spec,
          ),
        }),
      );
      continue;
    }
    const existing = await findInvite(c.db, t.email, spec.role, spec.scope);
    // D-c: a live invite this writer could not cancel is not theirs to re-scope or re-own. An
    // expired one grants nothing and is not listed, so it may be replaced.
    if (
      existing &&
      (existing.expires_at ?? 0) > c.now &&
      !mayRevoke(c.session.principal, specOfRow(existing))
    ) {
      r.status = "exists";
      r.bindingId = existing.id;
      continue;
    }
    const id = existing?.id ?? newBindingId();
    r.bindingId = id;
    r.expiresAt = expiresAt;
    if (needsOperator) r.needsOperatorSignIn = true;
    invited.push({ index: t.index, email: t.email, id });
    const who = await inviteeRef(c, t.email);
    statements.push(
      stmtUpsertInvite({
        id,
        emailNorm: t.email,
        role: spec.role,
        scope: spec.scope,
        areas: spec.areas,
        grantedBy: w.memberId,
        grantedAt: c.now,
      }),
      ...auditRows(c, product, {
        action: "rbac.invite",
        bindingId: id,
        memberId: who,
        summary: `${existing ? "Renewed an invitation" : "Invited"} ${who} as ${ROLE_LABEL[spec.role]} on ${spec.scope}${
          spec.areas ? ` (${spec.areas.join(", ")})` : ""
        }`,
        after: {
          bindingId: id,
          role: spec.role,
          scope: spec.scope,
          areas: spec.areas ? [...spec.areas] : null,
          source: "invite",
          expiresAt,
        },
        ...(existing
          ? {
              before: {
                bindingId: id,
                role: existing.role,
                scope: existing.scope,
                areas: rowToGrant(existing)?.areas
                  ? [...rowToGrant(existing)!.areas!]
                  : null,
                source: "invite",
                expiresAt: existing.expires_at,
              },
            }
          : {}),
      }),
    );
  }
  if (statements.length > 0) await c.db.batch(statements);

  // After the commit, best effort.
  let sent = 0;
  let of = 0;
  const productName = await productNameOf(c, spec);
  const inviter = c.session.name || c.session.email;
  for (const inv of invited) {
    const link = consoleInviteLink(consoleOrigin(c), inv.email);
    of += 1;
    const ok = await sendOperatorNotice(
      c.env,
      c.db,
      inv.email,
      accessInviteNotice({
        inviter,
        roleLabel: ROLE_LABEL[spec.role],
        scopeLabel: scopeLabel(spec.scope, productName),
        areas: spec.areas,
        link,
        origin: c.env.CONSOLE_ORIGIN,
      }),
      c.now,
    );
    const r = results[inv.index]!;
    r.emailed = ok;
    if (ok) sent += 1;
    else r.link = link;
  }
  const mails = { left: INVITE_NOTICE_CAP };
  for (const g of granted) {
    const entry = await granteeOf(c, g.accountId);
    if (!entry) continue;
    const n = await notify(c, g.accountId, entry, "granted", spec, mails);
    sent += n.sent;
    of += n.of;
  }
  if (invited.length > 0) {
    const n = await notifySuperadmins(
      c.env,
      c.db,
      c.now,
      accessInvitesSentNotice({
        actor: c.session.name || c.session.email,
        count: invited.length,
        roleLabel: ROLE_LABEL[spec.role],
        scopeLabel: scopeLabel(spec.scope, productName),
        areas: spec.areas,
        origin: c.env.CONSOLE_ORIGIN,
      }),
      mails,
      confirmLevel(spec) === "L2",
    );
    sent += n.sent;
    of += n.of;
  }

  const count = (s: InviteStatus) =>
    results.filter((r) => r.status === s).length;
  const wrote = invited.length + granted.length > 0;
  return adminJson(
    {
      ok: true,
      results,
      counts: {
        invited: count("invited"),
        updated: count("updated"),
        exists: count("exists"),
        merged: count("merged"),
        invalid: count("invalid"),
      },
      confirm: confirmLevel(spec),
      emailOff: !c.env.EMAIL,
      notified: { sent, of, nobodyNotified: sent === 0 },
    },
    wrote ? 201 : 200,
  );
}

/** The product's name for a notice, or `null` for a platform scope. */
async function productNameOf(
  c: AdminCtx,
  spec: GrantSpec,
): Promise<string | null> {
  if (!spec.scope.startsWith("product:")) return null;
  const slug = spec.scope.slice("product:".length);
  if (c.product?.slug === slug) return c.product.name ?? null;
  return (await getProduct(c.db, slug))?.name ?? null;
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
    "emails",
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
 * The binding a route names, or the 404 that says nothing: an unknown id, and, on a product
 * route, a binding of any other scope (another product's, a platform one). An invite row (no
 * account) is returned only to a caller that says it handles one (`DELETE`, ST-31.7); an edit
 * answers 404 for it.
 */
async function boundTo(
  c: AdminCtx,
  via: Via,
  id: string,
  allowInvite = false,
): Promise<BindingRow | Response> {
  const row = await getBinding(c.db, id);
  if (
    !row ||
    (row.account_id === null && !allowInvite) ||
    (via.slug !== null && row.scope !== `product:${via.slug}`)
  )
    return err(404, ErrorCode.NotFound);
  return row;
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
  // Fail closed: without per-statement change counts a lost race cannot be told from a win, so
  // the guarded write is refused rather than applied blind.
  if (!c.db.batchChanges)
    throw new Error("a guarded write needs a Db that reports batch changes");
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
  if (row.account_id === null) return err(404, ErrorCode.NotFound);
  const accountId = row.account_id;
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
    const entry = await granteeOf(c, accountId);
    return adminJson({
      ok: true,
      unchanged: true,
      binding: view(row, entry?.memberId ?? "", before),
    });
  }

  const widening = isWidening(before, after);
  if (widening) {
    // D-g: widening your own access is a grant to yourself.
    if (isSelf(w, accountId)) return selfGrant();
    const refused = confirmRefusal(body, after);
    if (refused) return refused;
    const stepUp = requireStepUp(c.session, c.now);
    if (stepUp) return stepUp;
  }

  const entry = await granteeOf(c, accountId);
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
  const notified = await notify(c, accountId, entry, "changed", after);
  return adminJson({ ok: true, binding: shown, widened: widening, notified });
}

/** `DELETE /bindings/<id>` and its product twin. No step-up: taking access back only narrows (G4). */
export async function revokeBinding(c: AdminCtx, via: Via): Promise<Response> {
  const w = writerOf(c);
  if (w instanceof Response) return w;
  const limited = await budget(c, w);
  if (limited) return limited;

  const row = await boundTo(
    c,
    via,
    c.params.id ?? c.params.bindingId ?? "",
    true,
  );
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

  const guard = bindingUnchangedSql(row.id, row.areas_json);

  // ST-31.7: an invitation is taken back like a grant (D-c), with no one to tell: it never had
  // an account, and the Superadmins were told when it was sent. Named by its opaque reference.
  if (row.account_id === null) {
    const who = await inviteeRef(c, row.email_norm ?? "");
    const gone = await applyGuarded(c, [
      ...auditRows(c, auditProduct(via, spec.scope), {
        action: "rbac.revoke",
        bindingId: row.id,
        memberId: who,
        summary: `Cancelled the invitation of ${who} as ${ROLE_LABEL[spec.role]} on ${spec.scope}`,
        before: {
          bindingId: row.id,
          role: spec.role,
          scope: spec.scope,
          areas: spec.areas ? [...spec.areas] : null,
          source: row.source,
          expiresAt: row.expires_at,
        },
        when: guard,
      }),
      stmtDeleteBindingIfUnchanged(row.id, row.areas_json),
    ]);
    if (!gone) return changed();
    return adminJson({ ok: true, bindingId: row.id, invite: true });
  }

  const entry = await granteeOf(c, row.account_id);
  const memberId =
    entry?.memberId ?? (await memberIdFor(c.env, row.account_id));
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
