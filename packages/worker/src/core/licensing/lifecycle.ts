/**
 * LX-12: the licence and add-on lifecycle (notes/S-19 §7.6, plans/LX-01.md §2.5, as the DX
 * consolidation of 2026-10-07 amended them: no refund grace).
 *
 * Two state machines, each ONE table. Every writer of a licence's `status`/`ended_reason` or a
 * grant's `state` goes through them (`lifecycleWrites.ts` derives its SQL from these tables), and
 * a test walks every cell.
 *
 * ── LICENCES ─────────────────────────────────────────────────────────────────────────────────
 *
 * A licence's `status` stays `active`/`disabled`. A licence that ends records why in
 * `ended_reason`, written in the same statement that disables it: `revoked` (an operator or
 * Polaris Key ended it), `superseded` (another licence replaced it; `superseded_by` names it),
 * `refunded` (a full refund of its sale) or `chargeback`. A disabled licence with no reason is
 * `suspended`: only rows disabled before LX-12 look like that, and nothing moves a licence into it.
 * Expiry stays computed from `expires_at` and is not a lifecycle state (LX-41's `licenseState`).
 *
 * ── GRANTS (ADD-ONS) ─────────────────────────────────────────────────────────────────────────
 *
 * A grant is an add-on a holder has: `active`, `past_due` (a renewal failed and the store is
 * retrying; it still counts until its term ends), `suppressed` (an operator hid it), `revoked`
 * (it no longer holds: a claim lost, a store revocation, an operator's revoke, a retry that gave
 * up) or `refunded` (a full refund or a chargeback of its purchase). The vocabulary is the
 * `trg_grants_state_*` triggers' (migrations/0105_a).
 *
 * ── THE RULES BOTH TABLES FOLLOW ────────────────────────────────────────────────────────────
 *
 * 1. **No refund grace.** A full refund or a chargeback ends the item at once; a partial refund
 *    never reaches this module. `grace_until` is not read (`grantContributes`).
 * 2. **Money ends are the strongest.** A refund or chargeback that arrives after an item already
 *    ended for another reason replaces that reason, so the record always says the money went
 *    back. Among the other ends the first one stays; for grants, `revoked` (the entitlement no
 *    longer holds) replaces `suppressed` (an operator hid one that did).
 * 3. **Only the store undoes a money end.** A refund is undone only by the store's reversal of
 *    that refund, a chargeback only by the reversal of that chargeback. An operator cannot
 *    reinstate a refunded or charged-back item (`refused`): to give the person access anyway they
 *    issue a new licence or add-on, which is its own audited act.
 * 4. **A reversal undoes nothing else.** A store's reversal never reinstates an item an operator
 *    or a supersession ended, so it cannot lift an operator's revocation.
 * 5. **Operators lift every other end.** `reinstate` moves a revoked, superseded or legacy
 *    suspended licence, and a revoked, suppressed or past-due grant, back to `active`.
 *
 * Residual of rule 2 with one reason column: an item ended by an operator and then refunded loses
 * the operator's reason, so a later reversal of that refund reinstates it. Both events on one
 * item, then a reversal, is the case; the audit log keeps every step.
 *
 * The module is PURE and imports nothing, so the Worker and the console share it, as `terms.ts`.
 */

// ── outcomes ─────────────────────────────────────────────────────────────────────────────────

/**
 * What an event does to an item in one state: the state it moves to, `same` (nothing changes and
 * nothing is written, so a replayed event is harmless), or `refused` (the caller answers an error;
 * only an operator's `reinstate` of a money end is refused).
 */
export type LifecycleOutcome<S extends string> = S | "same" | "refused";

// ── licences ─────────────────────────────────────────────────────────────────────────────────

/** `licenses.ended_reason` (triggers `trg_licenses_ended_reason_{ins,upd}`, migrations/0105_m). */
export const LICENSE_ENDED_REASONS = [
  "revoked",
  "superseded",
  "refunded",
  "chargeback",
] as const;
export type LicenseEndedReason = (typeof LICENSE_ENDED_REASONS)[number];

/** A licence's lifecycle state, read from `status` and `ended_reason`. */
export const LICENSE_LIFECYCLE_STATES = [
  "active",
  "suspended",
  ...LICENSE_ENDED_REASONS,
] as const;
export type LicenseLifecycleState = (typeof LICENSE_LIFECYCLE_STATES)[number];

/** What can happen to a licence. */
export const LICENSE_EVENTS = [
  /** An operator or Polaris Key ends it: the console's Disable, a batch's Disable unused keys, the
   *  product's deletion. */
  "revoke",
  /** Another licence replaced it (an anonymous licence merged into the signer's own). */
  "supersede",
  /** A full refund of the sale that made it. */
  "refund",
  /** A chargeback of that sale. */
  "chargeback",
  /** An operator re-enables it: the console's Enable. */
  "reinstate",
  /** The store reversed the refund. */
  "refund_reversed",
  /** The chargeback was reversed (a dispute won). */
  "chargeback_reversed",
] as const;
export type LicenseEvent = (typeof LICENSE_EVENTS)[number];

type LicenseRow_ = Readonly<
  Record<LicenseEvent, LifecycleOutcome<LicenseLifecycleState>>
>;

/** An ended licence that only an operator or a money event can move (rules 2, 4 and 5). */
const OPERATOR_ENDED: LicenseRow_ = {
  revoke: "same",
  supersede: "same",
  refund: "refunded",
  chargeback: "chargeback",
  reinstate: "active",
  refund_reversed: "same",
  chargeback_reversed: "same",
};

/** Every licence state × every event. A test asserts each cell. */
export const LICENSE_TRANSITIONS: Readonly<
  Record<LicenseLifecycleState, LicenseRow_>
> = {
  active: {
    revoke: "revoked",
    supersede: "superseded",
    refund: "refunded",
    chargeback: "chargeback",
    reinstate: "same",
    refund_reversed: "same",
    chargeback_reversed: "same",
  },
  suspended: OPERATOR_ENDED,
  revoked: OPERATOR_ENDED,
  superseded: OPERATOR_ENDED,
  refunded: {
    revoke: "same",
    supersede: "same",
    refund: "same",
    chargeback: "same",
    reinstate: "refused",
    refund_reversed: "active",
    chargeback_reversed: "same",
  },
  chargeback: {
    revoke: "same",
    supersede: "same",
    refund: "same",
    chargeback: "same",
    reinstate: "refused",
    refund_reversed: "same",
    chargeback_reversed: "active",
  },
};

function isEndedReason(v: unknown): v is LicenseEndedReason {
  return (
    typeof v === "string" &&
    (LICENSE_ENDED_REASONS as readonly string[]).includes(v)
  );
}

/** The columns the licence state is read from. */
export interface LicenseLifecycleColumns {
  status: string;
  ended_reason?: string | null;
}

/**
 * A licence's lifecycle state. `status` decides first, as every gate reads it: an active row is
 * `active` whatever its reason column holds (a stale reason left by a Worker older than LX-12).
 * A disabled row is its reason, or `suspended` when it has none.
 */
export function licenseLifecycleState(
  row: LicenseLifecycleColumns,
): LicenseLifecycleState {
  if (row.status === "active") return "active";
  return isEndedReason(row.ended_reason) ? row.ended_reason : "suspended";
}

/** Why a licence ended, or `null` while it is active or when the row recorded none. */
export function licenseEndedReason(
  row: LicenseLifecycleColumns,
): LicenseEndedReason | null {
  const s = licenseLifecycleState(row);
  return s === "active" || s === "suspended" ? null : s;
}

export function licenseTransition(
  from: LicenseLifecycleState,
  event: LicenseEvent,
): LifecycleOutcome<LicenseLifecycleState> {
  return LICENSE_TRANSITIONS[from][event];
}

/** The `status` a licence in `state` has. */
export function licenseStatusOf(state: LicenseLifecycleState): "active" | "disabled" {
  return state === "active" ? "active" : "disabled";
}

/** The `ended_reason` a licence in `state` stores. */
export function licenseEndedReasonOf(
  state: LicenseLifecycleState,
): LicenseEndedReason | null {
  return state === "active" || state === "suspended" ? null : state;
}

// ── grants (add-ons) ─────────────────────────────────────────────────────────────────────────

/** `grants.state` (triggers `trg_grants_state_{ins,upd}`, migrations/0105_a). */
export const GRANT_STATES = [
  "active",
  "past_due",
  "suppressed",
  "revoked",
  "refunded",
] as const;
export type GrantState = (typeof GRANT_STATES)[number];

/** What can happen to a grant. */
export const GRANT_EVENTS = [
  /** A renewal failed and the store is retrying (LX-23, LX-41). */
  "payment_failed",
  /** The retried renewal went through. */
  "payment_recovered",
  /** An operator hides it (audited; S-19 §7.3.2). */
  "suppress",
  /** It no longer holds, or an operator revokes it. */
  "revoke",
  /** A full refund of its purchase. */
  "refund",
  /** A chargeback of its purchase. A grant records both as `refunded`. */
  "chargeback",
  /** An operator restores it. */
  "reinstate",
  /** The store reversed the refund. */
  "refund_reversed",
  /** The chargeback was reversed. */
  "chargeback_reversed",
] as const;
export type GrantEvent = (typeof GRANT_EVENTS)[number];

type GrantRow_ = Readonly<Record<GrantEvent, LifecycleOutcome<GrantState>>>;

/** Every grant state × every event. A test asserts each cell. */
export const GRANT_TRANSITIONS: Readonly<Record<GrantState, GrantRow_>> = {
  active: {
    payment_failed: "past_due",
    payment_recovered: "same",
    suppress: "suppressed",
    revoke: "revoked",
    refund: "refunded",
    chargeback: "refunded",
    reinstate: "same",
    refund_reversed: "same",
    chargeback_reversed: "same",
  },
  past_due: {
    payment_failed: "same",
    payment_recovered: "active",
    suppress: "suppressed",
    revoke: "revoked",
    refund: "refunded",
    chargeback: "refunded",
    reinstate: "active",
    refund_reversed: "same",
    chargeback_reversed: "same",
  },
  suppressed: {
    payment_failed: "same",
    payment_recovered: "same",
    suppress: "same",
    revoke: "revoked",
    refund: "refunded",
    chargeback: "refunded",
    reinstate: "active",
    refund_reversed: "same",
    chargeback_reversed: "same",
  },
  revoked: {
    payment_failed: "same",
    payment_recovered: "same",
    suppress: "same",
    revoke: "same",
    refund: "refunded",
    chargeback: "refunded",
    reinstate: "active",
    refund_reversed: "same",
    chargeback_reversed: "same",
  },
  refunded: {
    payment_failed: "same",
    payment_recovered: "same",
    suppress: "same",
    revoke: "same",
    refund: "same",
    chargeback: "same",
    reinstate: "refused",
    refund_reversed: "active",
    chargeback_reversed: "active",
  },
};

export function isGrantState(v: unknown): v is GrantState {
  return (
    typeof v === "string" && (GRANT_STATES as readonly string[]).includes(v)
  );
}

export function grantTransition(
  from: GrantState,
  event: GrantEvent,
): LifecycleOutcome<GrantState> {
  return GRANT_TRANSITIONS[from][event];
}

/** The states in which a grant counts toward its holder's entitlements. */
export const GRANT_CONTRIBUTING_STATES: readonly GrantState[] = [
  "active",
  "past_due",
];

/** The columns a grant's contribution is read from. */
export interface GrantLifecycleColumns {
  state: string;
  expires_at: number | null;
}

/**
 * Whether a grant counts toward its holder's entitlements at `now`: it is `active` or `past_due`
 * (a billing retry keeps access until the term ends), and its term has not run out. A grant's
 * term ends as a licence's does (`licenseUsable`): it still counts at `expires_at` and stops the
 * second after. Every other state counts for nothing from the moment it is written: there is no
 * refund grace, so `grace_until` is never read.
 */
export function grantContributes(
  g: GrantLifecycleColumns,
  now: number,
): boolean {
  if (!(GRANT_CONTRIBUTING_STATES as readonly string[]).includes(g.state))
    return false;
  return g.expires_at === null || now <= g.expires_at;
}

// ── the table, read per event ────────────────────────────────────────────────────────────────

/**
 * The one state an event moves an item to, and the states it moves it from. Every event of both
 * tables has exactly one target (a test asserts it), which is what lets one guarded UPDATE apply
 * an event: `SET <target> WHERE <state> IN <from>`.
 */
export interface EventMoves<S extends string> {
  target: S;
  from: readonly S[];
  refusedFrom: readonly S[];
}

function movesOf<S extends string, E extends string>(
  table: Readonly<Record<S, Readonly<Record<E, LifecycleOutcome<S>>>>>,
  event: E,
): EventMoves<S> {
  let target: S | null = null;
  const from: S[] = [];
  const refusedFrom: S[] = [];
  for (const state of Object.keys(table) as S[]) {
    const out = table[state][event];
    if (out === "refused") refusedFrom.push(state);
    else if (out !== "same") {
      if (target !== null && target !== out)
        throw new Error(`lifecycle: ${event} has two targets`);
      // Neither state vocabulary holds "same" or "refused", so `out` is a state here.
      target = out as S;
      from.push(state);
    }
  }
  if (target === null) throw new Error(`lifecycle: ${event} moves nothing`);
  return { target, from, refusedFrom };
}

export function licenseEventMoves(
  event: LicenseEvent,
): EventMoves<LicenseLifecycleState> {
  return movesOf(LICENSE_TRANSITIONS, event);
}

export function grantEventMoves(event: GrantEvent): EventMoves<GrantState> {
  return movesOf(GRANT_TRANSITIONS, event);
}
