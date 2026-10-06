/**
 * Link an existing account (PX-W12; PORTAL.md §4.11, §10.2 G27; S-16 §5.1 "Merge only with proof
 * of both"; THREAT-MODEL "Account takeover through linking").
 *
 *   GET  /api/me/link            the join screen: both accounts, how each was proven, the result;
 *                                and the joins this account can still undo
 *   POST /api/me/link/start      start: needs a sign-in no older than 5 minutes (step-up)
 *   POST /api/me/link/confirm    join the two, `{keep: "other" | "started"}` (default `other`)
 *   POST /api/me/link/cancel     forget the flow
 *   POST /api/me/link/undo       undo a join within 72 hours, `{merge: <id>}` (step-up)
 *
 * ── PROOF OF BOTH, IN ONE BROWSER ───────────────────────────────────────────────────────────
 *
 * The person starts on the account they are signed in to ("started"), which must be fresh. The
 * flow is a server-held record in I-02's single-use store, named by a secret in a host-only cookie
 * (`__Host-pkey_link`, 15 minutes), holding that account's proof: its id, its session row and when
 * that session signed in. The person then signs in to the other account on the login card, by any
 * of its methods, which moves this browser's session to it; the next call here records that
 * session as the second proof. A proof is only ever taken from the session presenting the cookie,
 * so both come from this browser, and re-proving either account (signing in to it again) replaces
 * its proof. Never by email match: nothing here looks at addresses.
 *
 * Joining calls I-05's `mergeAccounts`, which refuses unless BOTH proofs are no older than
 * 5 minutes, and each proof's session must still be live (signing out of either cancels it). The
 * account kept is the other one by default (the existing account the person came to link: its
 * primary email stays, PORTAL.md §4.11), or the started one on request. A join is refused while
 * either account could still undo a join of its own (`merge_pending`), and it is audited,
 * emailed to every verified address of both, and undoable for 72 hours (`accounts/mergeUndo.ts`).
 * The browser's session stays valid either way: an absorbed account's session resolves to the
 * survivor. The flow is claimed before the merge, so two racing confirms merge once; an account's
 * details show on the join screen only while its proof's session is live, and signing out clears
 * the flow's cookie.
 */

import { hashKey, type Db, type Env } from "../../../core/platform.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import {
  LINK_FLOW_COOKIE,
  accountRealmCookie,
  clearAccountRealmCookie,
  readCookie,
} from "../../../core/accountCookies.js";
import {
  artefactRef,
  consumeArtefact,
  deleteArtefact,
  getArtefact,
  putArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import {
  STEP_UP_MAX_AGE_SECONDS,
  isFresh,
  type AccountProof,
} from "../accounts/links.js";
import { mergeAccounts } from "../accounts/merge.js";
import {
  hasUndoableMerge,
  listUndoableMerges,
  undoMerge,
} from "../accounts/mergeUndo.js";
import { getAccountRow, listLinks } from "../accounts/repo.js";
import { avatarUrl } from "../card/avatars.js";
import { cardJson, originOf, readJsonObject } from "../card/http.js";
import { randomSecret } from "./accountSessions.js";

/** How long a link flow waits for the person. */
export const LINK_FLOW_TTL_SECONDS = 15 * 60;
/** Link changes (start, confirm, undo) by one account per minute. */
export const LINK_CHANGES_PER_ACCOUNT_MINUTE = 10;

/** The signed-in caller, as `portal/api.ts` resolved it. */
export interface LinkCaller {
  accountId: string;
  authenticatedAt: number;
  sessionIdHash: string;
}

interface Proof {
  accountId: string;
  authenticatedAt: number;
  sessionIdHash: string;
  /** How that session signed in (`email`, `google`, `passkey`, …). */
  methods: string[];
}

interface LinkFlow {
  v: 1;
  rev: number;
  createdAt: number;
  started: Proof;
  other: Proof | null;
}

type Role = "started" | "other";

async function flowRef(env: Env, secret: string): Promise<ArtefactRef> {
  return artefactRef(
    "link-flow",
    await hashKey(`link-flow:${secret}`, env.KEY_HASH_PEPPER),
  );
}

async function currentFlow(
  env: Env,
  req: Request,
): Promise<{ ref: ArtefactRef; flow: LinkFlow } | null> {
  const secret = readCookie(req.headers.get("cookie"), LINK_FLOW_COOKIE);
  if (!secret) return null;
  const ref = await flowRef(env, secret);
  const raw = await getArtefact(env, ref);
  if (!raw) return null;
  try {
    return { ref, flow: JSON.parse(raw) as LinkFlow };
  } catch {
    return null;
  }
}

const clearFlowCookie = (): string => clearAccountRealmCookie(LINK_FLOW_COOKIE);

function parseMethods(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").slice(0, 4)
      : [];
  } catch {
    return [];
  }
}

/** The caller's proof: its account, its session row and how that session signed in. */
async function callerProof(db: Db, caller: LinkCaller): Promise<Proof> {
  const row = await db.first<{ amr_json: string | null }>(
    "SELECT amr_json FROM account_sessions WHERE id_hash = ?",
    caller.sessionIdHash,
  );
  return {
    accountId: caller.accountId,
    authenticatedAt: caller.authenticatedAt,
    sessionIdHash: caller.sessionIdHash,
    methods: parseMethods(row?.amr_json),
  };
}

/** Whether the proof's session is still live and still the account's. */
async function proofLive(db: Db, proof: Proof, now: number): Promise<boolean> {
  const row = await db.first<{
    account_id: string;
    revoked_at: number | null;
    expires_at: number;
  }>(
    "SELECT account_id, revoked_at, expires_at FROM account_sessions WHERE id_hash = ?",
    proof.sessionIdHash,
  );
  return (
    row !== null &&
    row.account_id === proof.accountId &&
    row.revoked_at === null &&
    row.expires_at > now
  );
}

const asProof = (p: Proof): AccountProof => ({
  accountId: p.accountId,
  authenticatedAt: p.authenticatedAt,
});

/**
 * Record the caller's session in the flow: a second account becomes (or replaces) `other`; the
 * started account signing in again refreshes its own proof. Never anything but the caller's.
 */
async function absorbCallerProof(
  env: Env,
  db: Db,
  ref: ArtefactRef,
  flow: LinkFlow,
  caller: LinkCaller,
): Promise<LinkFlow | null> {
  const proof = await callerProof(db, caller);
  const role: Role =
    proof.accountId === flow.started.accountId ? "started" : "other";
  const current = flow[role];
  if (
    current &&
    current.accountId === proof.accountId &&
    current.sessionIdHash === proof.sessionIdHash &&
    current.authenticatedAt >= proof.authenticatedAt
  ) {
    return flow;
  }
  const out = await updateArtefact(env, ref, {
    expect: { rev: flow.rev },
    set: { [role]: proof, rev: flow.rev + 1 },
  });
  return out.ok ? { ...flow, [role]: proof, rev: flow.rev + 1 } : null;
}

async function changesAllowed(
  env: Env,
  caller: LinkCaller,
  now: number,
): Promise<boolean> {
  return rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalLinkChange",
      id: caller.accountId,
      limit: LINK_CHANGES_PER_ACCOUNT_MINUTE,
      windowSec: 60,
    },
    now,
  );
}

function stepUpRequired(stale: Role[] = []): Response {
  return cardJson(
    {
      error: "step_up_required",
      message:
        stale.length > 0
          ? "Sign in again to confirm it's you, then join."
          : "Confirm it's you: sign in again, then try again.",
      maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
      ...(stale.length > 0 ? { stale } : {}),
    },
    401,
  );
}

function expired(): Response {
  return cardJson(
    {
      error: "signin_expired",
      message: "Linking took too long. Start again.",
    },
    400,
    [clearFlowCookie()],
  );
}

/** `/api/me/link…`; `rest` is the path after `link`. Session and CSRF already checked. */
export async function handleAccountLink(
  req: Request,
  env: Env,
  db: Db,
  caller: LinkCaller,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length === 0) {
    if (req.method !== "GET")
      return cardJson({ error: "method_not_allowed" }, 405);
    return linkView(req, env, db, caller, now);
  }
  if (rest.length !== 1) return cardJson({ error: "not_found" }, 404);
  if (req.method !== "POST")
    return cardJson({ error: "method_not_allowed" }, 405);
  switch (rest[0]) {
    case "start":
      return linkStart(env, db, caller, now);
    case "confirm":
      return linkConfirm(req, env, db, caller, now);
    case "cancel": {
      const found = await currentFlow(env, req);
      if (found) await deleteArtefact(env, found.ref).catch(() => undefined);
      return cardJson({ status: "cancelled" }, 200, [clearFlowCookie()]);
    }
    case "undo":
      return linkUndo(req, env, db, caller, now);
    default:
      return cardJson({ error: "not_found" }, 404);
  }
}

/** `POST /api/me/link/start`. */
async function linkStart(
  env: Env,
  db: Db,
  caller: LinkCaller,
  now: number,
): Promise<Response> {
  if (!(await changesAllowed(env, caller, now)))
    return cardJson({ error: "rate_limited" }, 429);
  if (!isFresh(caller, now)) return stepUpRequired();
  const secret = randomSecret(32);
  const flow: LinkFlow = {
    v: 1,
    rev: 0,
    createdAt: now,
    started: await callerProof(db, caller),
    other: null,
  };
  await putArtefact(
    env,
    await flowRef(env, secret),
    JSON.stringify(flow),
    LINK_FLOW_TTL_SECONDS,
  );
  return cardJson(
    {
      status: "started",
      expiresAt: now + LINK_FLOW_TTL_SECONDS,
      // Sign in to the other account on the login card, then come back to the join screen.
      next: "/signin?return_to=%2F%23%2Faccount%2Flink",
    },
    200,
    [accountRealmCookie(LINK_FLOW_COOKIE, secret, LINK_FLOW_TTL_SECONDS)],
  );
}

/** One account as the join screen shows it. The person proved it, so its details are theirs. */
async function accountCard(
  db: Db,
  role: Role,
  proof: Proof,
  caller: LinkCaller,
  now: number,
): Promise<Record<string, unknown> | null> {
  const account = await getAccountRow(db, proof.accountId);
  if (!account || account.status !== "active") return null;
  const links = await listLinks(db, account.id);
  const products = await db.first<{ n: number }>(
    "SELECT COUNT(DISTINCT product) AS n FROM licenses WHERE account_id = ?",
    account.id,
  );
  return {
    role,
    current: proof.accountId === caller.accountId,
    name: account.display_name,
    email: account.primary_email,
    avatarUrl: avatarUrl(account.avatar_key ?? null),
    methods: links.map((l) => l.kind),
    products: products?.n ?? 0,
    proven: {
      by: proof.methods[0] ?? null,
      at: proof.authenticatedAt,
      fresh: isFresh(asProof(proof), now),
    },
  };
}

/** `GET /api/me/link`. */
async function linkView(
  req: Request,
  env: Env,
  db: Db,
  caller: LinkCaller,
  now: number,
): Promise<Response> {
  const undoable = await listUndoableMerges(db, caller.accountId, now);
  const found = await currentFlow(env, req);
  if (!found) return cardJson({ flow: null, undoable });
  const flow = await absorbCallerProof(env, db, found.ref, found.flow, caller);
  if (!flow) return expired();
  // An account's details show only while its proof's session is live: once the started account
  // signed out, the flow is over (and a stranger reaching this browser later sees nothing).
  if (!(await proofLive(db, flow.started, now))) {
    await deleteArtefact(env, found.ref).catch(() => undefined);
    return cardJson({ flow: null, undoable }, 200, [clearFlowCookie()]);
  }
  const started = await accountCard(db, "started", flow.started, caller, now);
  const other =
    flow.other && (await proofLive(db, flow.other, now))
      ? await accountCard(db, "other", flow.other, caller, now)
      : null;
  let reason:
    | "sign_in_other"
    | "step_up_required"
    | "merge_pending"
    | "unavailable"
    | null = null;
  if (!started) reason = "unavailable";
  else if (!flow.other) reason = "sign_in_other";
  else if (!other) reason = "unavailable";
  else if (
    !isFresh(asProof(flow.started), now) ||
    !isFresh(asProof(flow.other), now)
  )
    reason = "step_up_required";
  else if (
    (await hasUndoableMerge(db, flow.started.accountId, now)) ||
    (await hasUndoableMerge(db, flow.other.accountId, now))
  )
    // Refused while either account can still undo a join of its own, whichever is kept.
    reason = "merge_pending";
  const products = flow.other
    ? await db.first<{ n: number }>(
        `SELECT COUNT(DISTINCT product) AS n FROM licenses WHERE account_id IN (?, ?)`,
        flow.started.accountId,
        flow.other.accountId,
      )
    : null;
  return cardJson({
    flow: {
      expiresAt: flow.createdAt + LINK_FLOW_TTL_SECONDS,
      started,
      other,
      canJoin: reason === null,
      reason,
      keep: "other",
      result: other
        ? {
            products: products?.n ?? 0,
            primaryEmail:
              (other.email as string | null) ??
              (started?.email as string | null) ??
              null,
          }
        : null,
    },
    undoable,
  });
}

/** `POST /api/me/link/confirm {keep?}`. */
async function linkConfirm(
  req: Request,
  env: Env,
  db: Db,
  caller: LinkCaller,
  now: number,
): Promise<Response> {
  if (!(await changesAllowed(env, caller, now)))
    return cardJson({ error: "rate_limited" }, 429);
  const body = await readJsonObject(req);
  const keep = body?.keep ?? "other";
  if (keep !== "other" && keep !== "started") {
    return cardJson(
      { error: "bad_request", message: "keep must be other or started" },
      400,
    );
  }
  const found = await currentFlow(env, req);
  if (!found) return expired();
  const flow = await absorbCallerProof(env, db, found.ref, found.flow, caller);
  if (!flow) return expired();
  if (!flow.other) {
    return cardJson(
      {
        error: "bad_request",
        reason: "sign_in_other",
        message: "Sign in to your other account first.",
      },
      400,
    );
  }
  // Both proofs: fresh (checked by the merge) and their sessions still live.
  const stale: Role[] = [];
  for (const role of ["started", "other"] as const) {
    const p = flow[role]!;
    if (!(await proofLive(db, p, now)) || !isFresh(asProof(p), now))
      stale.push(role);
  }
  if (stale.length > 0) return stepUpRequired(stale);
  const survivor = keep === "other" ? flow.other : flow.started;
  const absorbed = keep === "other" ? flow.started : flow.other;
  // One completion only: of two racing confirms, one gets the flow and merges.
  if (!(await consumeArtefact(env, found.ref))) return expired();
  const merged = await mergeAccounts(
    { db, env, now, origin: originOf(req) },
    { survivor: asProof(survivor), absorbed: asProof(absorbed) },
  );
  if (!merged.ok) {
    // The flow was used up by this attempt: its cookie goes with every refusal.
    const gone = [clearFlowCookie()];
    switch (merged.reason) {
      case "step_up_required":
        return cardJson(
          {
            error: "step_up_required",
            message: "Sign in to both accounts again, then join.",
            maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
            stale: ["started", "other"],
          },
          401,
          gone,
        );
      case "same_account":
        return cardJson(
          {
            error: "bad_request",
            reason: "same_account",
            message:
              "That's the account you started from. Sign in to your other account.",
          },
          400,
          gone,
        );
      case "merge_pending":
        return cardJson(
          {
            error: "forbidden",
            reason: "merge_pending",
            message:
              "One of these accounts was joined with another in the last 72 hours. Try again once that join can no longer be undone.",
          },
          403,
          gone,
        );
      default:
        return cardJson(
          {
            error: "forbidden",
            reason: "unavailable",
            message: "These accounts can't be joined.",
          },
          403,
          gone,
        );
    }
  }
  return cardJson(
    {
      status: "joined",
      kept: keep,
      merge: { id: merged.mergeId, undoUntil: merged.undoUntil },
    },
    200,
    [clearFlowCookie()],
  );
}

/** `POST /api/me/link/undo {merge}`. */
async function linkUndo(
  req: Request,
  env: Env,
  db: Db,
  caller: LinkCaller,
  now: number,
): Promise<Response> {
  if (!(await changesAllowed(env, caller, now)))
    return cardJson({ error: "rate_limited" }, 429);
  const body = await readJsonObject(req);
  const mergeId = typeof body?.merge === "string" ? body.merge : "";
  if (!/^amrg_[A-Za-z0-9_-]{8,64}$/.test(mergeId)) {
    return cardJson({ error: "not_found" }, 404);
  }
  const result = await undoMerge(
    { db, env, now, origin: originOf(req) },
    { accountId: caller.accountId, authenticatedAt: caller.authenticatedAt },
    mergeId,
  );
  if (result.ok) return cardJson({ status: "separated" });
  if (result.error === "step_up_required") return stepUpRequired();
  if (result.error === "last_link") {
    return cardJson(
      {
        error: "last_link",
        message:
          "Separating now would leave an account with no way to sign in. Connect another sign-in method to this account first.",
      },
      409,
    );
  }
  return cardJson(
    {
      error: "not_found",
      message: "This join can no longer be undone.",
    },
    404,
  );
}
