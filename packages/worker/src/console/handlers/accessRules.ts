/**
 * The SSO access rules' two helpers (ST-32.5; ST-28 plan §2.4, §5.1):
 *
 *   POST /access/rules/preview   {rule}  who a draft rule would give access to, and what
 *   GET  /access/offers                   the open `admin_group` conversion offers
 *   POST /access/offers                   {action: "dismiss_all"}  dismiss every open offer
 *   POST /access/offers/<slug>            {action: "accept" | "dismiss", …}
 *
 * Platform scope, area `members` (`./routes.ts`); session only.
 *
 * The preview answers from the one matcher sign-in uses: it hands the draft to `ruleMatchesFor`
 * (`core/rbac/ruleGrants.ts`) for each account whose stored facts it could read. It is not a
 * second matcher, so what it shows is what the next sign-in grants. It names a member only the way
 * the roster does (member id, display name, address) and only a member: a person who holds no
 * role is never read or named, and the count of such matches goes to a Superadmin alone.
 *
 * Accept is a rule write, `writeConsoleAccess`: a Superadmin, a step-up, the typed `console.access`
 * confirmation and a reason, with the rule built here from the product's stored group (the
 * caller picks the connection and the areas, never the group or the id). It appends to the
 * stored rules. Dismiss and bulk dismiss need a Superadmin and no step-up. Every outcome is an
 * `rbac.admin_group_offer` row (`core/rbac/adminGroupOffers.ts`).
 */

import { ErrorCode } from "../../core/errors.js";
import {
  adminJson,
  err,
  readBody,
  settingRefused,
} from "../../core/console/respond.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import { PRODUCT_AREAS } from "../../core/rbac/areas.js";
import {
  openOffers,
  offerOutcomeStatements,
  type Offer,
} from "../../core/rbac/adminGroupOffers.js";
import { listBoundAccountIds } from "../../core/rbac/bindings.js";
import { isSuperadmin } from "../../core/rbac/can.js";
import {
  parseAccessRules,
  type AccessRule,
} from "../../core/rbac/claimMatcher.js";
import {
  candidateAccountsFor,
  ruleMatchesFor,
} from "../../core/rbac/ruleGrants.js";
import { accessRulesNotice } from "../../core/notify/templates.js";
import { accessRulesRefusal } from "../../core/settings/consoleAccessCheck.js";
import { writeConsoleAccess } from "../../core/settings/consoleAccess.js";
import { resolvePlatformSetting } from "../../core/settings/resolve.js";
import { SETTINGS } from "../../mount.js";
import {
  consoleDirectoryRead,
  consoleRootHolders,
} from "../../services/identity/public.js";
import { requireStepUp } from "../stepUp.js";
import { invalidRequest as invalid, unknownFields } from "./accessShared.js";
import type { AdminCtx } from "../routes.js";
import { NOTICE_CAP, notifySuperadmins } from "../lib/operatorNotices.js";

const KEY = "console.access";
/** Accounts one preview evaluates; past it the answer says `truncated`. */
const PREVIEW_SCAN = 300;
/** Members one preview names. */
const PREVIEW_MEMBERS = 100;
/** Preview and offer writes per member per window. */
const BUDGET = 60;
const BUDGET_WINDOW_SECONDS = 300;
/** The placeholder id of a draft: the preview never stores it. */
const DRAFT_ID = "r_000000";
/** Statements per batch when every open offer is dismissed. */
const BATCH = 40;

const superadminOnly = () =>
  err(
    403,
    ErrorCode.Forbidden,
    "only a Superadmin can change sign-in rules or their offers",
    { reason: "superadmin_only" },
  );

async function overBudget(c: AdminCtx, kind: string): Promise<Response | null> {
  const bucket = {
    bucket: "adminGrantWrite",
    id: `${kind}:${c.session.principal?.memberId ?? c.session.sub}`,
    limit: BUDGET,
    windowSec: BUDGET_WINDOW_SECONDS,
  };
  if (await rateLimitOk(c.env, "_admin", bucket, c.now)) return null;
  return err(429, "rate_limited", "too many requests; try again later");
}

// ── POST /access/rules/preview ───────────────────────────────────────────────────────────────

export async function handleRulePreview(c: AdminCtx): Promise<Response> {
  const body = await readBody(c.req);
  const extra = unknownFields(body, ["rule"]);
  if (extra.length > 0) return invalid(extra);
  const raw = body.rule;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return invalid(["rule"]);
  // The id is the server's: a draft has none, and the placeholder is never shown or stored.
  const { id: _ignored, ...draft } = raw as Record<string, unknown>;
  void _ignored;
  const parsed = parseAccessRules(
    { rules: [draft] },
    { mintId: () => DRAFT_ID },
  );
  if (!parsed.ok) return invalid(["rule"], "invalid_rules", parsed.reason);
  const rule: AccessRule = parsed.doc.rules[0]!;
  // The same checks the write makes, so a draft the write would refuse is not previewed.
  const refusal = await accessRulesRefusal(c.env, c.db, parsed.doc);
  if (refusal) return invalid(["rule"], refusal.reason, refusal.message);
  const limited = await overBudget(c, "preview");
  if (limited) return limited;

  const { accountIds, truncated } = await candidateAccountsFor(
    c.db,
    rule.when.connection,
    PREVIEW_SCAN,
  );
  const members = await rosterAccountIds(c);
  const matched: Array<{ accountId: string; grant: AccessRule["grant"] }> = [];
  let others = 0;
  for (const accountId of accountIds) {
    // A malformed link row skips that account, as sign-in's `ruleGrantsFor` does.
    const hit = (
      await ruleMatchesFor(c.env, c.db, accountId, [rule], c.now).catch(
        () => [],
      )
    )[0];
    if (!hit) continue;
    if (members.has(accountId))
      matched.push({
        accountId,
        grant: {
          role: hit.grant.role as AccessRule["grant"]["role"],
          scope: hit.grant.scope as AccessRule["grant"]["scope"],
          ...(hit.grant.areas
            ? { areas: [...hit.grant.areas] as AccessRule["grant"]["areas"] }
            : {}),
        },
      });
    else others += 1;
  }
  const { entries, incomplete } = await consoleDirectoryRead(
    c.env,
    c.db,
    matched.slice(0, PREVIEW_MEMBERS).map((m) => m.accountId),
    c.now,
  );
  const named = matched.slice(0, PREVIEW_MEMBERS).flatMap((m) => {
    const e = entries.get(m.accountId);
    return e
      ? [
          {
            memberId: e.memberId,
            name: e.name,
            email: e.email,
            grant: {
              role: m.grant.role,
              scope: m.grant.scope,
              areas: m.grant.areas ? [...m.grant.areas] : null,
            },
          },
        ]
      : [];
  });
  return adminJson({
    members: named,
    matchedMembers: matched.length,
    // Links of people who hold no role yet: a count, to a Superadmin only (never a name).
    otherLinks: isSuperadmin(c.session.principal) ? others : null,
    // The size of the connection's link set is a Superadmin's, like `otherLinks`.
    scanned: isSuperadmin(c.session.principal) ? accountIds.length : null,
    truncated: isSuperadmin(c.session.principal)
      ? truncated || matched.length > PREVIEW_MEMBERS
      : null,
    incomplete,
  });
}

/** The accounts the roster names: those with a binding and the root rule's holders. */
async function rosterAccountIds(c: AdminCtx): Promise<Set<string>> {
  const out = new Set(await listBoundAccountIds(c.db, 20000));
  for (const id of await consoleRootHolders(c.env, c.db, c.now)) out.add(id);
  return out;
}

// ── GET /access/offers ───────────────────────────────────────────────────────────────────────

const offerView = (o: Offer) => ({
  product: o.product,
  name: o.name,
  group: o.group,
});

export async function handleOffersList(c: AdminCtx): Promise<Response> {
  const offers = await openOffers(c.db);
  return adminJson({ offers: offers.map(offerView) });
}

// ── POST /access/offers[/<slug>] ─────────────────────────────────────────────────────────────

async function dismiss(c: AdminCtx, offers: Offer[]): Promise<void> {
  const statements = offers.flatMap((o) =>
    offerOutcomeStatements(c.session, c.now, o.product, "dismissed", {
      group: o.group,
    }),
  );
  for (let i = 0; i < statements.length; i += BATCH)
    await c.db.batch(statements.slice(i, i + BATCH));
}

/** `POST /access/offers`: only `{action: "dismiss_all"}`. */
export async function handleOffersBulk(c: AdminCtx): Promise<Response> {
  if (!isSuperadmin(c.session.principal)) return superadminOnly();
  const body = await readBody(c.req);
  const extra = unknownFields(body, ["action"]);
  if (extra.length > 0) return invalid(extra);
  if (body.action !== "dismiss_all") return invalid(["action"]);
  const limited = await overBudget(c, "offer");
  if (limited) return limited;
  const offers = await openOffers(c.db);
  await dismiss(c, offers);
  return adminJson({
    ok: true,
    dismissed: offers.map((o) => o.product),
  });
}

/** `POST /access/offers/<slug>`: accept or dismiss one offer. */
export async function handleOfferDecide(c: AdminCtx): Promise<Response> {
  if (!isSuperadmin(c.session.principal)) return superadminOnly();
  const body = await readBody(c.req);
  const action = body.action;
  if (action !== "accept" && action !== "dismiss") return invalid(["action"]);
  const extra = unknownFields(
    body,
    action === "dismiss"
      ? ["action"]
      : [
          "action",
          "group",
          "connection",
          "areas",
          "label",
          "reason",
          "confirm",
        ],
  );
  if (extra.length > 0) return invalid(extra);
  const slug = c.params.slug ?? "";
  const offer = (await openOffers(c.db)).find((o) => o.product === slug);
  if (!offer)
    return err(404, ErrorCode.NotFound, "no open offer for that product", {
      reason: "no_such_offer",
    });
  const limited = await overBudget(c, "offer");
  if (limited) return limited;
  if (action === "dismiss") {
    await dismiss(c, [offer]);
    return adminJson({ ok: true, product: slug, outcome: "dismissed" });
  }
  return accept(c, offer, body);
}

async function accept(
  c: AdminCtx,
  offer: Offer,
  body: Record<string, unknown>,
): Promise<Response> {
  // Checked first so the refusal names the step-up, not a write the registry would also refuse.
  const stepUp = requireStepUp(c.session, c.now);
  if (stepUp) return stepUp;
  // The group the Superadmin saw. A product can change its own group meanwhile (S1).
  if (typeof body.group !== "string") return invalid(["group"]);
  if (body.group !== offer.group)
    return err(
      409,
      ErrorCode.BadRequest,
      "the product's admin group changed; review the offer again",
      { reason: "offer_changed" },
    );
  const connection = body.connection;
  if (typeof connection !== "string" || connection === "")
    return invalid(["connection"]);
  // By default every product area but `members`: granting Members is asked for by name (N3).
  const areas =
    body.areas === undefined
      ? PRODUCT_AREAS.filter((a) => a !== "members")
      : body.areas;
  const ctx = { env: c.env, db: c.db, registry: SETTINGS };
  const stored = await resolvePlatformSetting(ctx, KEY, { fresh: true });
  const doc = stored.value as { rules?: unknown[] } | null | undefined;
  const existing = Array.isArray(doc?.rules) ? doc.rules : [];
  const label =
    typeof body.label === "string" && body.label !== ""
      ? body.label
      : `Admin group of ${offer.product}`;
  const rule = {
    label: [...label].slice(0, 80).join(""),
    when: { connection, group: offer.group },
    grant: {
      role: "product_admin",
      scope: `product:${offer.product}`,
      areas,
    },
  };
  // A retry after a failed outcome write must not append the same rule twice (N1).
  const same = (r: unknown) =>
    JSON.stringify([
      (r as { when?: unknown }).when,
      (r as { grant?: unknown }).grant,
    ]) === JSON.stringify([rule.when, rule.grant]);
  const twin = existing.find(same) as { id?: unknown } | undefined;
  let rules: Array<{ id?: unknown }> | undefined;
  let ruleId: string | undefined;
  if (twin) {
    ruleId = typeof twin.id === "string" ? twin.id : undefined;
    rules = existing as Array<{ id?: unknown }>;
  } else {
    const res = await writeConsoleAccess(
      ctx,
      c.session,
      {
        value: { rules: [...existing, rule] },
        expectedVersion: stored.version,
        reason: body.reason,
        ...(typeof body.confirm === "string" ? { confirm: body.confirm } : {}),
      },
      c.now,
    );
    if (!res.ok) return settingRefused(res, ["connection", "areas"]);
    const after = await resolvePlatformSetting(ctx, KEY, { fresh: true });
    rules = (after.value as { rules?: Array<{ id?: unknown }> } | null)?.rules;
    const last = rules?.[rules.length - 1];
    ruleId = typeof last?.id === "string" ? last.id : undefined;
  }
  await c.db.batch(
    offerOutcomeStatements(c.session, c.now, offer.product, "accepted", {
      group: offer.group,
      ...(ruleId ? { ruleId } : {}),
    }),
  );
  // A twin rule changed nothing, so nobody is told.
  const notified = twin
    ? { sent: 0, of: 0 }
    : await notifySuperadmins(
        c.env,
        c.db,
        c.now,
        accessRulesNotice({
          actor: c.session.name || c.session.email,
          change: "added",
          ruleCount: rules?.length ?? existing.length + 1,
          origin: c.env.CONSOLE_ORIGIN,
        }),
        { left: NOTICE_CAP },
        true,
      );
  return adminJson({
    ok: true,
    product: offer.product,
    outcome: "accepted",
    ...(ruleId ? { ruleId } : {}),
    notified,
  });
}
