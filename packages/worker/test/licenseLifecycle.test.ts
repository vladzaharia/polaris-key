/**
 * LX-12: the licence and add-on lifecycle (`core/licensing/lifecycle.ts`, `lifecycleWrites.ts`).
 *
 *   1. The two tables, cell by cell. Both are written out here a second time, by hand, and every
 *      cell of the module's tables must equal it, so neither can change without the other. The
 *      header's rules are then checked over the whole of each table.
 *   2. The SQL is the table. Every cell runs through the guarded UPDATE against SQLite: a cell
 *      that moves writes exactly the target, and every other cell leaves the row byte for byte as
 *      it was (the negative control). The bulk form and the state predicate agree with the table
 *      the same way, and so does `transitionLicense` under a concurrent write.
 *   3. `grantContributes` and its SQL agree over every state, expiry and grace; a refunded,
 *      revoked or suppressed grant counts for nothing even with a `grace_until` in the future.
 *   4. A refunded grant stops counting at once: its key leaves the signed licence document in
 *      the second the refund is written, while a billing retry keeps it.
 *   5. `ended_reason` is set on every disable: the console's Disable (and cleared by Enable), a
 *      product's deletion. An operator's Enable of a refunded or charged-back licence is refused.
 *      (The batch's Disable unused keys is in `licenseBatches.test.ts`, the merge's supersede in
 *      `enroll.test.ts`.)
 *   6. No wire change: a disabled licence's document answer is the same whatever its reason.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { deleteProduct } from "../src/admin/repo.js";
import { listAudit } from "../src/repo.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { oidcGrantStatements } from "../src/core/grants.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import {
  GRANT_EVENTS,
  GRANT_STATES,
  GRANT_TRANSITIONS,
  grantContributes,
  grantEventMoves,
  LICENSE_ENDED_REASONS,
  LICENSE_EVENTS,
  LICENSE_LIFECYCLE_STATES,
  LICENSE_TRANSITIONS,
  licenseEndedReason,
  licenseEventMoves,
  licenseLifecycleState,
  type GrantEvent,
  type GrantState,
  type LicenseEvent,
  type LicenseLifecycleState,
} from "../src/core/licensing/lifecycle.js";
import {
  grantContributesSql,
  grantTransitionStatement,
  licenseStateSql,
  licenseTransitionSetSql,
  licenseTransitionStatement,
  transitionGrant,
  transitionLicense,
} from "../src/core/licensing/lifecycleWrites.js";

const SLUG = "djdl";

// ── 1. the tables ────────────────────────────────────────────────────────────────────────────

/** Parse a hand-written table: a header row of events, then one row per state. */
function parseTable(text: string): Map<string, Map<string, string>> {
  const lines = text
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/));
  const [head, ...rows] = lines;
  const out = new Map<string, Map<string, string>>();
  for (const [state, ...cells] of rows) {
    expect(cells).toHaveLength(head!.length);
    out.set(state!, new Map(head!.map((e, i) => [e, cells[i]!])));
  }
  return out;
}

const LICENSE_EXPECTED = parseTable(`
             revoke   supersede   refund    chargeback  reinstate  refund_reversed  chargeback_reversed
  active     revoked  superseded  refunded  chargeback  same       same             same
  suspended  same     same        refunded  chargeback  active     same             same
  revoked    same     same        refunded  chargeback  active     same             same
  superseded same     same        refunded  chargeback  active     same             same
  refunded   same     same        same      same        refused    active           same
  chargeback same     same        same      same        refused    same             active
`);

const GRANT_EXPECTED = parseTable(`
             payment_failed  payment_recovered  suppress    revoke   refund    chargeback  reinstate  refund_reversed  chargeback_reversed
  active     past_due        same               suppressed  revoked  refunded  refunded    same       same             same
  past_due   same            active             suppressed  revoked  refunded  refunded    active     same             same
  suppressed same            same               same        revoked  refunded  refunded    active     same             same
  revoked    same            same               same        same     refunded  refunded    active     same             same
  refunded   same            same               same        same     same      same        refused    active           active
`);

describe("the lifecycle tables, cell by cell", () => {
  it("the licence table is exactly the hand-written one, every state × every event", () => {
    expect([...LICENSE_EXPECTED.keys()].sort()).toEqual(
      [...LICENSE_LIFECYCLE_STATES].sort(),
    );
    for (const state of LICENSE_LIFECYCLE_STATES) {
      expect([...LICENSE_EXPECTED.get(state)!.keys()].sort()).toEqual(
        [...LICENSE_EVENTS].sort(),
      );
      expect(Object.keys(LICENSE_TRANSITIONS[state]).sort()).toEqual(
        [...LICENSE_EVENTS].sort(),
      );
      for (const event of LICENSE_EVENTS)
        expect([state, event, LICENSE_TRANSITIONS[state][event]]).toEqual([
          state,
          event,
          LICENSE_EXPECTED.get(state)!.get(event),
        ]);
    }
  });

  it("the grant table is exactly the hand-written one, every state × every event", () => {
    expect([...GRANT_EXPECTED.keys()].sort()).toEqual([...GRANT_STATES].sort());
    for (const state of GRANT_STATES) {
      expect([...GRANT_EXPECTED.get(state)!.keys()].sort()).toEqual(
        [...GRANT_EVENTS].sort(),
      );
      expect(Object.keys(GRANT_TRANSITIONS[state]).sort()).toEqual(
        [...GRANT_EVENTS].sort(),
      );
      for (const event of GRANT_EVENTS)
        expect([state, event, GRANT_TRANSITIONS[state][event]]).toEqual([
          state,
          event,
          GRANT_EXPECTED.get(state)!.get(event),
        ]);
    }
  });

  it("every event has one target, and nothing moves a licence into `suspended`", () => {
    for (const event of LICENSE_EVENTS) {
      const m = licenseEventMoves(event);
      expect(m.target).not.toBe("suspended");
      expect(m.from.length).toBeGreaterThan(0);
    }
    for (const event of GRANT_EVENTS)
      expect(grantEventMoves(event).from.length).toBeGreaterThan(0);
  });

  it("a money end is left only by its own reversal; an operator cannot reinstate it", () => {
    const own: Record<string, string> = {
      refunded: "refund_reversed",
      chargeback: "chargeback_reversed",
    };
    for (const money of ["refunded", "chargeback"] as const)
      for (const event of LICENSE_EVENTS) {
        const out = LICENSE_TRANSITIONS[money][event];
        if (event === own[money]) expect(out).toBe("active");
        else if (event === "reinstate") expect(out).toBe("refused");
        else expect(out).toBe("same");
      }
    for (const event of GRANT_EVENTS) {
      const out = GRANT_TRANSITIONS.refunded[event];
      if (event === "refund_reversed" || event === "chargeback_reversed")
        expect(out).toBe("active");
      else if (event === "reinstate") expect(out).toBe("refused");
      else expect(out).toBe("same");
    }
  });

  it("a store's reversal never reinstates anything a money event did not end", () => {
    for (const event of ["refund_reversed", "chargeback_reversed"] as const) {
      for (const state of LICENSE_LIFECYCLE_STATES)
        if (state !== "refunded" && state !== "chargeback")
          expect(LICENSE_TRANSITIONS[state][event]).toBe("same");
      for (const state of GRANT_STATES)
        if (state !== "refunded")
          expect(GRANT_TRANSITIONS[state][event]).toBe("same");
    }
  });

  it("a full refund or a chargeback ends every item that has not ended for money, with no grace", () => {
    const later = NOW + 30 * 86_400;
    for (const event of ["refund", "chargeback"] as const) {
      for (const state of LICENSE_LIFECYCLE_STATES) {
        const out = LICENSE_TRANSITIONS[state][event];
        if (state === "refunded" || state === "chargeback")
          expect(out).toBe("same");
        else expect(out).toBe(event === "refund" ? "refunded" : "chargeback");
      }
      for (const state of GRANT_STATES) {
        const out = GRANT_TRANSITIONS[state][event];
        const after = out === "same" ? state : (out as GrantState);
        expect(after).toBe("refunded");
        // It stops counting in the same second, whatever grace column a row carries.
        expect(grantContributes({ state: after, expires_at: null }, NOW)).toBe(
          false,
        );
        expect(grantContributes({ state: after, expires_at: later }, NOW)).toBe(
          false,
        );
      }
    }
  });

  it("reads a licence's state from status first, then its reason", () => {
    expect(
      licenseLifecycleState({ status: "active", ended_reason: null }),
    ).toBe("active");
    // A stale reason on an active row (a Worker older than LX-12 re-enabled it) reads active.
    expect(
      licenseLifecycleState({ status: "active", ended_reason: "refunded" }),
    ).toBe("active");
    expect(
      licenseLifecycleState({ status: "disabled", ended_reason: null }),
    ).toBe("suspended");
    expect(licenseLifecycleState({ status: "disabled" })).toBe("suspended");
    for (const r of LICENSE_ENDED_REASONS) {
      expect(
        licenseLifecycleState({ status: "disabled", ended_reason: r }),
      ).toBe(r);
      expect(licenseEndedReason({ status: "disabled", ended_reason: r })).toBe(
        r,
      );
      expect(licenseEndedReason({ status: "active", ended_reason: r })).toBe(
        null,
      );
    }
    expect(licenseEndedReason({ status: "disabled", ended_reason: null })).toBe(
      null,
    );
  });
});

// ── 2. the SQL is the table ──────────────────────────────────────────────────────────────────

/** The stored columns of a licence in `state`. */
function columnsOf(state: LicenseLifecycleState): {
  status: string;
  reason: string | null;
} {
  if (state === "active") return { status: "active", reason: null };
  if (state === "suspended") return { status: "disabled", reason: null };
  return { status: "disabled", reason: state };
}

/** Every seeded licence carries a `superseded_by` pointer, so the cells show which events keep it
 *  (an active licence's is an attached free licence's, LX-10) and which one clears it. */
const PREV = "lic_prev";

async function seedLicenseIn(
  db: SqliteDb,
  id: string,
  state: LicenseLifecycleState,
): Promise<void> {
  const c = columnsOf(state);
  await db.run(
    `INSERT INTO licenses (product, id, status, ended_reason, superseded_by, activated_at,
       modified_by, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, 'seed', ?)`,
    SLUG,
    id,
    c.status,
    c.reason,
    PREV,
    NOW,
    NOW,
  );
}

/** Where `superseded_by` stands after `event` moved a licence out of `from`: set by supersede,
 *  cleared only by reinstating a superseded licence, kept by everything else. */
function supersededByAfter(
  from: LicenseLifecycleState,
  event: LicenseEvent,
): string | null {
  if (event === "supersede") return "lic_survivor";
  if (from === "superseded" && event === "reinstate") return null;
  return PREV;
}

async function licenseRow(db: SqliteDb, id: string) {
  return db.first<Record<string, unknown>>(
    "SELECT * FROM licenses WHERE product = ? AND id = ?",
    SLUG,
    id,
  );
}

async function seedGrantIn(
  db: SqliteDb,
  id: string,
  state: GrantState,
  opts: { source?: string; orderRef?: string | null; licenseId?: string } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO grants (product, id, license_id, source, order_ref, state, granted_at,
       created_by, modified_at, modified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?, 'seed')`,
    SLUG,
    id,
    opts.licenseId ?? "lic_holder",
    opts.source ?? "comp",
    opts.orderRef ?? null,
    state,
    NOW,
    NOW,
  );
}

async function grantRow(db: SqliteDb, id: string) {
  return db.first<Record<string, unknown>>(
    "SELECT * FROM grants WHERE product = ? AND id = ?",
    SLUG,
    id,
  );
}

describe("the writers apply exactly the table", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, SLUG);
    await seedLicenseIn(db, "lic_holder", "active");
    await seedLicenseIn(db, "lic_survivor", "active");
  });

  it("every licence cell through its guarded UPDATE: the target, or the row untouched", async () => {
    let n = 0;
    for (const state of LICENSE_LIFECYCLE_STATES)
      for (const event of LICENSE_EVENTS) {
        const id = `lic_${n++}`;
        await seedLicenseIn(db, id, state);
        const before = await licenseRow(db, id);
        const stmt = licenseTransitionStatement({
          product: SLUG,
          licenseId: id,
          event,
          actor: "op-1",
          now: NOW + 1,
          supersededBy: "lic_survivor",
        });
        const changed = await db.runChanges(stmt.sql, ...stmt.params);
        const after = await licenseRow(db, id);
        const out = LICENSE_TRANSITIONS[state][event];
        const cell = `${state} × ${event}`;
        if (out === "same" || out === "refused") {
          expect([cell, changed]).toEqual([cell, 0]);
          expect([cell, after]).toEqual([cell, before]);
        } else {
          expect([cell, changed]).toEqual([cell, 1]);
          expect([cell, licenseLifecycleState(after as never)]).toEqual([
            cell,
            out,
          ]);
          // Only the lifecycle columns and the stamp move; every other column is as it was.
          expect([cell, after]).toEqual([
            cell,
            {
              ...before,
              status: columnsOf(out).status,
              ended_reason: columnsOf(out).reason,
              modified_by: "op-1",
              modified_at: NOW + 1,
              superseded_by: supersededByAfter(state, event),
            },
          ]);
        }
      }
  });

  it("the bulk form moves every row the table moves and leaves every other row as it was", async () => {
    for (const event of LICENSE_EVENTS) {
      if (event === "supersede") {
        expect(() => licenseTransitionSetSql(event)).toThrow();
        continue;
      }
      const fresh = makeTestDb();
      await seedProduct(fresh, SLUG);
      for (const state of LICENSE_LIFECYCLE_STATES)
        await seedLicenseIn(fresh, `lic_${state}`, state);
      await fresh.run(
        `UPDATE licenses SET ${licenseTransitionSetSql(event)} WHERE product = ?`,
        SLUG,
      );
      for (const state of LICENSE_LIFECYCLE_STATES) {
        const out = LICENSE_TRANSITIONS[state][event];
        const expected = out === "same" || out === "refused" ? state : out;
        const row = await licenseRow(fresh, `lic_${state}`);
        expect([event, state, licenseLifecycleState(row as never)]).toEqual([
          event,
          state,
          expected,
        ]);
        expect([event, state, row?.superseded_by]).toEqual([
          event,
          state,
          out === "same" || out === "refused"
            ? PREV
            : supersededByAfter(state, event),
        ]);
      }
    }
  });

  it("the state predicate reads a row exactly as licenseLifecycleState does", async () => {
    const rows: [string, string, string | null][] = [
      ["r_active", "active", null],
      ["r_stale", "active", "refunded"],
      ["r_suspended", "disabled", null],
      ...LICENSE_ENDED_REASONS.map(
        (r) => [`r_${r}`, "disabled", r] as [string, string, string],
      ),
    ];
    for (const [id, status, reason] of rows)
      await db.run(
        `INSERT INTO licenses (product, id, status, ended_reason, activated_at, modified_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        SLUG,
        id,
        status,
        reason,
        NOW,
        NOW,
      );
    for (const [id, status, reason] of rows)
      for (const state of LICENSE_LIFECYCLE_STATES) {
        const hit = await db.first(
          `SELECT 1 AS hit FROM licenses WHERE product = ? AND id = ? AND ${licenseStateSql(state)}`,
          SLUG,
          id,
        );
        expect([id, state, hit !== null]).toEqual([
          id,
          state,
          licenseLifecycleState({ status, ended_reason: reason }) === state,
        ]);
      }
  });

  it("transitionLicense reports the table's answer, and a write that lost a race writes nothing", async () => {
    await seedLicenseIn(db, "lic_r", "active");
    expect(
      await transitionLicense(db, {
        product: SLUG,
        licenseId: "lic_r",
        event: "refund",
        actor: "system:commerce",
        now: NOW + 1,
      }),
    ).toEqual({
      from: "active",
      outcome: "refunded",
      changed: true,
      to: "refunded",
    });
    // Replayed: nothing changes.
    expect(
      await transitionLicense(db, {
        product: SLUG,
        licenseId: "lic_r",
        event: "refund",
        actor: "system:commerce",
        now: NOW + 2,
      }),
    ).toEqual({
      from: "refunded",
      outcome: "same",
      changed: false,
      to: "refunded",
    });
    expect(
      await transitionLicense(db, {
        product: SLUG,
        licenseId: "lic_r",
        event: "reinstate",
        actor: "op-1",
        now: NOW + 3,
      }),
    ).toEqual({
      from: "refunded",
      outcome: "refused",
      changed: false,
      to: "refunded",
    });
    expect(await licenseRow(db, "lic_r")).toMatchObject({
      status: "disabled",
      ended_reason: "refunded",
      modified_at: NOW + 1,
    });
    expect(
      await transitionLicense(db, {
        product: SLUG,
        licenseId: "lic_missing",
        event: "revoke",
        actor: "op-1",
        now: NOW,
      }),
    ).toBeNull();

    // A refund lands between an operator's read and their Enable: the guarded UPDATE finds the
    // row outside reinstate's sources and changes nothing.
    await seedLicenseIn(db, "lic_race", "revoked");
    const racing = {
      first: db.first.bind(db),
      runChanges: async (sql: string, ...p: unknown[]) => {
        const r = licenseTransitionStatement({
          product: SLUG,
          licenseId: "lic_race",
          event: "refund",
          actor: "system:commerce",
          now: NOW + 4,
        });
        await db.runChanges(r.sql, ...r.params);
        return db.runChanges(sql, ...(p as never[]));
      },
    } as unknown as SqliteDb;
    expect(
      await transitionLicense(racing, {
        product: SLUG,
        licenseId: "lic_race",
        event: "reinstate",
        actor: "op-1",
        now: NOW + 5,
      }),
    ).toEqual({
      from: "revoked",
      outcome: "active",
      changed: false,
      to: "refunded",
    });
    expect(await licenseRow(db, "lic_race")).toMatchObject({
      status: "disabled",
      ended_reason: "refunded",
    });
  });

  it("every grant cell through its guarded UPDATE: the target, or the row untouched", async () => {
    let n = 0;
    for (const state of GRANT_STATES)
      for (const event of GRANT_EVENTS) {
        const id = `grt_${n++}`;
        await seedGrantIn(db, id, state);
        const before = await grantRow(db, id);
        const stmt = grantTransitionStatement({
          product: SLUG,
          target: { grantId: id },
          event,
          actor: "op-1",
          now: NOW + 1,
        });
        const changed = await db.runChanges(stmt.sql, ...stmt.params);
        const after = await grantRow(db, id);
        const out = GRANT_TRANSITIONS[state][event];
        const cell = `${state} × ${event}`;
        if (out === "same" || out === "refused") {
          expect([cell, changed]).toEqual([cell, 0]);
          expect([cell, after]).toEqual([cell, before]);
        } else {
          expect([cell, changed]).toEqual([cell, 1]);
          expect([cell, after]).toEqual([
            cell,
            {
              ...before,
              state: out,
              modified_at: NOW + 1,
              modified_by: "op-1",
            },
          ]);
        }
      }
  });

  it("transitionGrant answers as the table, and an order's event reaches every grant of that order only", async () => {
    await seedGrantIn(db, "grt_a", "active", { orderRef: "ord_1" });
    await seedGrantIn(db, "grt_b", "past_due", { orderRef: "ord_1" });
    await seedGrantIn(db, "grt_c", "active", { orderRef: "ord_2" });
    const stmt = grantTransitionStatement({
      product: SLUG,
      target: { orderRef: "ord_1" },
      event: "chargeback",
      actor: "commerce",
      now: NOW + 1,
    });
    expect(await db.runChanges(stmt.sql, ...stmt.params)).toBe(2);
    expect((await grantRow(db, "grt_a"))?.state).toBe("refunded");
    expect((await grantRow(db, "grt_b"))?.state).toBe("refunded");
    expect((await grantRow(db, "grt_c"))?.state).toBe("active");
    expect(
      await transitionGrant(db, {
        product: SLUG,
        grantId: "grt_a",
        event: "reinstate",
        actor: "op-1",
        now: NOW + 2,
      }),
    ).toEqual({
      from: "refunded",
      outcome: "refused",
      changed: false,
      to: "refunded",
    });
    expect(
      await transitionGrant(db, {
        product: SLUG,
        grantId: "grt_a",
        event: "chargeback_reversed",
        actor: "commerce",
        now: NOW + 3,
      }),
    ).toEqual({
      from: "refunded",
      outcome: "active",
      changed: true,
      to: "active",
    });
  });

  it("leaves a store-sourced grant to the store-grant projection: no event writes it", async () => {
    for (const store of ["app-store", "play", "steam"]) {
      await seedGrantIn(db, `grt_${store}`, "active", {
        source: store,
        orderRef: "ord_s",
      });
      const before = await grantRow(db, `grt_${store}`);
      for (const event of GRANT_EVENTS) {
        const stmt = grantTransitionStatement({
          product: SLUG,
          target: { grantId: `grt_${store}` },
          event,
          actor: "op-1",
          now: NOW + 1,
        });
        expect(await db.runChanges(stmt.sql, ...stmt.params)).toBe(0);
      }
      const byOrder = grantTransitionStatement({
        product: SLUG,
        target: { orderRef: "ord_s" },
        event: "refund",
        actor: "op-1",
        now: NOW + 1,
      });
      expect(await db.runChanges(byOrder.sql, ...byOrder.params)).toBe(0);
      expect(await grantRow(db, `grt_${store}`)).toEqual(before);
      expect(
        await transitionGrant(db, {
          product: SLUG,
          grantId: `grt_${store}`,
          event: "refund",
          actor: "op-1",
          now: NOW + 1,
        }),
      ).toBeNull();
    }
    // Control: the same event on a non-store grant does write.
    await seedGrantIn(db, "grt_comp", "active", { source: "comp" });
    expect(
      (
        await transitionGrant(db, {
          product: SLUG,
          grantId: "grt_comp",
          event: "refund",
          actor: "op-1",
          now: NOW + 1,
        })
      )?.changed,
    ).toBe(true);
  });
});

// ── 3. grantContributes and its SQL ──────────────────────────────────────────────────────────

describe("grantContributes", () => {
  it("counts active and past-due grants inside their term, and nothing else, as the SQL does", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    await seedLicenseIn(db, "lic_holder", "active");
    const expiries = [null, NOW - 1, NOW, NOW + 1];
    const graces = [null, NOW + 3_600];
    let n = 0;
    for (const state of GRANT_STATES)
      for (const expires of expiries)
        for (const grace of graces) {
          const id = `grt_${n++}`;
          await seedGrantIn(db, id, state);
          await db.run(
            "UPDATE grants SET expires_at = ?, grace_until = ? WHERE product = ? AND id = ?",
            expires,
            grace,
            SLUG,
            id,
          );
          const ts = grantContributes({ state, expires_at: expires }, NOW);
          const q = grantContributesSql("g", NOW);
          const sql =
            (await db.first(
              `SELECT 1 AS hit FROM grants g WHERE g.product = ? AND g.id = ? AND ${q.sql}`,
              SLUG,
              id,
              ...q.params,
            )) !== null;
          expect([state, expires, grace, sql]).toEqual([
            state,
            expires,
            grace,
            ts,
          ]);
          const live =
            (state === "active" || state === "past_due") &&
            (expires === null || NOW <= expires);
          expect([state, expires, grace, ts]).toEqual([
            state,
            expires,
            grace,
            live,
          ]);
        }
  });
});

// ── 4 and 6. the signed document ─────────────────────────────────────────────────────────────

describe("the licence document", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  let licenseId: string;
  let token: string;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    product = (await loadProduct(env, db, SLUG))!;
    const seeded = await seedLicenseWithKey(db, SLUG);
    licenseId = seeded.licenseId;
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${seeded.key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    token = ((await res.json()) as { token: string }).token;
    // The licence's `oidc` grant: the one grant a document reads before LX-09.
    await db.batch(
      oidcGrantStatements({
        product: SLUG,
        licenseId,
        entries: {
          polarisVpn: { state: "default", value: true, updatedAt: NOW },
        },
        declared: ["polarisVpn"],
        now: NOW,
        writer: "oidc",
        guard: null,
      }),
    );
  });

  async function document(at: number) {
    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.2.3",
      }),
      env,
      db,
      product,
      at,
    );
    return { status: res.status, body: await res.text() };
  }

  /** The signed document's entitlements (the answer is the compact JWS itself). */
  function entitlementsOf(jws: string): Record<string, unknown> {
    const payload = JSON.parse(
      Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"),
    ) as { entitlements: Record<string, unknown> };
    return payload.entitlements;
  }

  async function grantEvent(event: GrantEvent, at: number) {
    return transitionGrant(db, {
      product: SLUG,
      grantId: `grt_oidc_${licenseId}`,
      event,
      actor: "commerce",
      now: at,
    });
  }

  it("a refunded grant stops counting at once: its key leaves the document the second the refund is written", async () => {
    const before = await document(NOW + 10);
    expect(before.status).toBe(200);
    expect(entitlementsOf(before.body)).toHaveProperty("polarisVpn");

    // A stale grace column changes nothing: there is no refund grace.
    await db.run(
      "UPDATE grants SET grace_until = ? WHERE product = ? AND id = ?",
      NOW + 7 * 86_400,
      SLUG,
      `grt_oidc_${licenseId}`,
    );
    expect((await grantEvent("refund", NOW + 20))?.changed).toBe(true);
    const after = await document(NOW + 20);
    expect(after.status).toBe(200);
    expect(entitlementsOf(after.body)).not.toHaveProperty("polarisVpn");

    // Only the store's reversal brings it back.
    expect((await grantEvent("reinstate", NOW + 30))?.outcome).toBe("refused");
    expect(entitlementsOf((await document(NOW + 30)).body)).not.toHaveProperty(
      "polarisVpn",
    );
    expect((await grantEvent("refund_reversed", NOW + 40))?.changed).toBe(true);
    expect(entitlementsOf((await document(NOW + 40)).body)).toHaveProperty(
      "polarisVpn",
    );
  });

  it("a chargeback, a revocation and a suppression drop the key the same way; a billing retry keeps it", async () => {
    // Negative control first: past due still counts.
    expect((await grantEvent("payment_failed", NOW + 10))?.to).toBe("past_due");
    expect(entitlementsOf((await document(NOW + 10)).body)).toHaveProperty(
      "polarisVpn",
    );
    for (const [event, to] of [
      ["suppress", "suppressed"],
      ["revoke", "revoked"],
      ["chargeback", "refunded"],
    ] as const) {
      expect((await grantEvent(event, NOW + 20))?.to).toBe(to);
      expect(
        entitlementsOf((await document(NOW + 20)).body),
      ).not.toHaveProperty("polarisVpn");
    }
  });

  it("a grant's term ends as a licence's does: it counts at expires_at and not the second after", async () => {
    await db.run(
      "UPDATE grants SET expires_at = ? WHERE product = ? AND id = ?",
      NOW + 100,
      SLUG,
      `grt_oidc_${licenseId}`,
    );
    expect(entitlementsOf((await document(NOW + 100)).body)).toHaveProperty(
      "polarisVpn",
    );
    expect(entitlementsOf((await document(NOW + 101)).body)).not.toHaveProperty(
      "polarisVpn",
    );
  });

  it("no wire change: an ended licence's answer is the same bytes whatever its reason", async () => {
    await db.run(
      "UPDATE licenses SET status = 'disabled', ended_reason = NULL WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    const legacy = await document(NOW + 10);
    expect(legacy.status).toBe(401);
    for (const reason of LICENSE_ENDED_REASONS) {
      await db.run(
        "UPDATE licenses SET ended_reason = ? WHERE product = ? AND id = ?",
        reason,
        SLUG,
        licenseId,
      );
      expect(await document(NOW + 10)).toEqual(legacy);
    }
  });
});

// ── 5. ended_reason on every disable ─────────────────────────────────────────────────────────

describe("ended_reason is written with every disable", () => {
  const PLATFORM_GROUP = "admins";
  let db: SqliteDb;
  let env: Env;
  let call: (method: string, path: string) => Promise<Response>;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), [SLUG]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
    await seedProduct(db, SLUG);
    const { token, session } = await issueSession(
      env,
      { sub: "op-1", name: "Op", email: "op@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    call = (method, path) => {
      const full = `/api/products/${SLUG}${path}`;
      return handleAdmin(
        new Request(`https://key.plrs.im/manage${full}`, {
          method,
          headers: {
            cookie: `${ADMIN_COOKIE}=${token}`,
            [CSRF_HEADER]: session.csrf,
          },
        }) as unknown as Request,
        env,
        db,
        full,
        { now: NOW },
      );
    };
  });

  const auditsOf = async (action: string) =>
    (await listAudit(db, SLUG, { action })).length;

  it("the console's Disable revokes (reason `revoked`) and Enable clears it; each change is audited once", async () => {
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    const off = await call("POST", `/license/licenses/${licenseId}/disable`);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({
      ok: true,
      id: licenseId,
      status: "disabled",
      endedReason: "revoked",
    });
    expect(await licenseRow(db, licenseId)).toMatchObject({
      status: "disabled",
      ended_reason: "revoked",
      modified_by: "op-1",
    });
    const read = (await (
      await call("GET", `/license/licenses/${licenseId}`)
    ).json()) as Record<string, unknown>;
    expect(read).toMatchObject({
      status: "disabled",
      endedReason: "revoked",
      supersededBy: null,
    });

    // Disabled again: no change, no second audit row.
    expect(
      (await call("POST", `/license/licenses/${licenseId}/disable`)).status,
    ).toBe(200);
    expect(await auditsOf("license.disable")).toBe(1);

    const on = await call("POST", `/license/licenses/${licenseId}/enable`);
    expect(await on.json()).toEqual({
      ok: true,
      id: licenseId,
      status: "active",
      endedReason: null,
    });
    expect(await licenseRow(db, licenseId)).toMatchObject({
      status: "active",
      ended_reason: null,
    });
    expect(await auditsOf("license.enable")).toBe(1);
  });

  it("refuses an operator's Enable of a refunded or charged-back licence and changes nothing", async () => {
    for (const reason of ["refunded", "chargeback"] as const) {
      const { licenseId } = await seedLicenseWithKey(db, SLUG, {
        id: `lic_${reason}`,
      });
      await transitionLicense(db, {
        product: SLUG,
        licenseId,
        event: reason === "refunded" ? "refund" : "chargeback",
        actor: "system:commerce",
        now: NOW,
      });
      const before = await licenseRow(db, licenseId);
      const res = await call("POST", `/license/licenses/${licenseId}/enable`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ endedReason: reason });
      expect(await licenseRow(db, licenseId)).toEqual(before);
      // Disable on it keeps the money reason.
      expect(
        await (
          await call("POST", `/license/licenses/${licenseId}/disable`)
        ).json(),
      ).toMatchObject({ status: "disabled", endedReason: reason });
    }
    expect(await auditsOf("license.enable")).toBe(0);
    expect(await auditsOf("license.disable")).toBe(0);
  });

  it("a licence disabled before LX-12 reads with no reason and Enable restores it", async () => {
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      SLUG,
      licenseId,
    );
    const read = (await (
      await call("GET", `/license/licenses/${licenseId}`)
    ).json()) as Record<string, unknown>;
    expect(read).toMatchObject({ status: "disabled", endedReason: null });
    expect(
      await (
        await call("POST", `/license/licenses/${licenseId}/enable`)
      ).json(),
    ).toMatchObject({ status: "active", endedReason: null });
  });

  it("Enable of a superseded licence clears supersededBy; a revoked licence keeps its pointer", async () => {
    await seedLicenseWithKey(db, SLUG, { id: "lic_survivor" });
    const { licenseId: merged } = await seedLicenseWithKey(db, SLUG, {
      id: "lic_merged",
    });
    await transitionLicense(db, {
      product: SLUG,
      licenseId: merged,
      event: "supersede",
      supersededBy: "lic_survivor",
      actor: "oidc",
      now: NOW,
    });
    expect(
      await (await call("GET", `/license/licenses/${merged}`)).json(),
    ).toMatchObject({
      status: "disabled",
      endedReason: "superseded",
      supersededBy: "lic_survivor",
    });
    expect(
      await (await call("POST", `/license/licenses/${merged}/enable`)).json(),
    ).toMatchObject({ status: "active", endedReason: null });
    expect(
      await (await call("GET", `/license/licenses/${merged}`)).json(),
    ).toMatchObject({ status: "active", supersededBy: null });
    expect((await licenseRow(db, merged))?.superseded_by).toBeNull();

    // Negative control: an active licence's pointer (an attached free licence) survives a
    // Disable and an Enable, because it never ended as superseded.
    const { licenseId: attached } = await seedLicenseWithKey(db, SLUG, {
      id: "lic_attached",
    });
    await db.run(
      "UPDATE licenses SET superseded_by = 'lic_survivor' WHERE product = ? AND id = ?",
      SLUG,
      attached,
    );
    await call("POST", `/license/licenses/${attached}/disable`);
    await call("POST", `/license/licenses/${attached}/enable`);
    expect(await licenseRow(db, attached)).toMatchObject({
      status: "active",
      ended_reason: null,
      superseded_by: "lic_survivor",
    });
  });

  it("deleting the product revokes every active licence and keeps an ended one's reason", async () => {
    await seedLicenseWithKey(db, SLUG, { id: "lic_live" });
    await seedLicenseWithKey(db, SLUG, { id: "lic_refunded" });
    await seedLicenseWithKey(db, SLUG, { id: "lic_legacy" });
    await transitionLicense(db, {
      product: SLUG,
      licenseId: "lic_refunded",
      event: "refund",
      actor: "system:commerce",
      now: NOW,
    });
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = 'lic_legacy'",
      SLUG,
    );
    await deleteProduct(db, SLUG, NOW + 1);
    const rows = await db.all<{
      id: string;
      status: string;
      ended_reason: string | null;
    }>(
      "SELECT id, status, ended_reason FROM licenses WHERE product = ? ORDER BY id",
      SLUG,
    );
    expect(rows).toEqual([
      { id: "lic_legacy", status: "disabled", ended_reason: null },
      { id: "lic_live", status: "disabled", ended_reason: "revoked" },
      { id: "lic_refunded", status: "disabled", ended_reason: "refunded" },
    ]);
  });

  it("every licence event other than supersede is reachable through transitionLicense", async () => {
    // A sanity walk: from active, each event lands where the table says (supersede needs its
    // survivor, which the merge supplies).
    for (const event of LICENSE_EVENTS as readonly LicenseEvent[]) {
      const id = `lic_walk_${event}`;
      await seedLicenseWithKey(db, SLUG, { id });
      const r = await transitionLicense(db, {
        product: SLUG,
        licenseId: id,
        event,
        actor: "op-1",
        now: NOW,
        ...(event === "supersede" ? { supersededBy: "lic_other" } : {}),
      });
      const out = LICENSE_TRANSITIONS.active[event];
      expect(r?.to).toBe(out === "same" ? "active" : out);
    }
  });
});
