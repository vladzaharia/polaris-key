/// <reference types="@cloudflare/workers-types" />
/**
 * U-12.1: "Remove my data from <Product>" as a fenced, fault-isolated, write-ahead removal.
 *
 * Pinned, each its own failure: the ledger record comes first and is create-only (and its refusal
 * changes nothing); the device fence runs before any store; one failing store leaves the others
 * deleted, answers pending and keeps the subject row; a retry converges; a formerly bound device
 * cannot create a key ring; the ledger prefix is not the account ledger's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW } from "../../seed.js";
import { getRing } from "../../../src/core/keyring/store.js";
import { completeProductRemoval } from "../../../src/services/identity/accounts/productRemoval.js";
import { ErasureLedgerError } from "../../../src/services/identity/accounts/erasureLedger.js";
import {
  recordSubjectErasure,
  subjectErasureKey,
  SUBJECT_ERASURE_PREFIX,
} from "../../../src/services/identity/accounts/subjectErasureLedger.js";
import {
  createRingAs,
  D1,
  D2,
  P,
  remove,
  resetState,
  state,
  subjectRow,
  unregisterProbes,
  world,
} from "./fixtures/productRemovalWorld.js";

beforeEach(resetState);
afterEach(unregisterProbes);

describe("the ledger", () => {
  it("is create-only, under its own prefix, and holds no account id", async () => {
    const w = await world();
    expect(await recordSubjectErasure(w.env, P, w.subject, NOW)).toBe(
      "created",
    );
    const first = await w.r2.head(subjectErasureKey(P, w.subject));
    expect(await recordSubjectErasure(w.env, P, w.subject, NOW + 99)).toBe(
      "exists",
    );
    expect((await w.r2.head(subjectErasureKey(P, w.subject)))?.etag).toBe(
      first?.etag,
    );
    expect(w.r2.keys()).toEqual([`${SUBJECT_ERASURE_PREFIX}${P}/${w.subject}`]);
    expect(SUBJECT_ERASURE_PREFIX.startsWith("erasures/")).toBe(false);
    const body = JSON.parse(
      await (
        (await w.r2.get(subjectErasureKey(P, w.subject))) as R2ObjectBody
      ).text(),
    );
    expect(body).toEqual({
      v: 1,
      product: P,
      subject: w.subject,
      erasedAt: NOW,
    });
  });

  it("refuses names that are not a product slug and a pairwise subject", async () => {
    const w = await world();
    await expect(
      recordSubjectErasure(w.env, "../x", w.subject, NOW),
    ).rejects.toBeInstanceOf(ErasureLedgerError);
    await expect(
      recordSubjectErasure(w.env, P, "acct_1234", NOW),
    ).rejects.toBeInstanceOf(ErasureLedgerError);
  });

  it("a refused write removes nothing", async () => {
    const w = await world();
    const ring = await w.db.first(
      "SELECT 1 FROM devices WHERE subject = ?",
      w.subject,
    );
    expect(ring).not.toBeNull();
    w.r2.put = (async () => {
      throw new Error("r2 down");
    }) as typeof w.r2.put;
    await expect(remove(w)).rejects.toBeInstanceOf(ErasureLedgerError);
    expect(state.deletedBy).toEqual([]);
    expect(await subjectRow(w)).not.toBeNull();
    expect(
      (await w.db.all("SELECT 1 FROM devices WHERE subject = ?", w.subject))
        .length,
    ).toBe(2);
    w.env.BLOBS = undefined;
    await expect(remove(w)).rejects.toBeInstanceOf(ErasureLedgerError);
    expect(state.deletedBy).toEqual([]);
  });
});

describe("the cascade", () => {
  it("clears every binding before any store runs", async () => {
    const w = await world();
    state.failing = false;
    const out = await remove(w);
    expect(out).toEqual({ ok: true, detached: [] });
    expect(state.seenBound).toEqual([0]);
    expect(state.deletedBy).toEqual(["a.probe", "z.flaky"]);
    expect(await subjectRow(w)).toBeNull();
  });

  it("a failing store answers pending, keeps the subject, and the others still finish", async () => {
    const w = await world();
    const out = await remove(w);
    expect(out).toEqual({ ok: true, detached: [], pending: true });
    expect(state.deletedBy).toEqual(["a.probe"]);
    expect(await subjectRow(w)).not.toBeNull();
    // Nothing the developer or the person's history reports yet.
    expect(
      await w.db.all(
        "SELECT 1 FROM subject_events WHERE type = 'subject.deleted'",
      ),
    ).toHaveLength(0);
    expect(
      await w.db.all(
        "SELECT 1 FROM portal_audit WHERE action = 'account.product.remove'",
      ),
    ).toHaveLength(0);
    // The fence held even though the removal is not finished.
    expect(
      await w.db.all("SELECT 1 FROM devices WHERE subject = ?", w.subject),
    ).toHaveLength(0);
    expect(w.r2.keys()).toEqual([subjectErasureKey(P, w.subject)]);
  });

  it("a retry converges, once, and a repeat changes nothing", async () => {
    const w = await world();
    expect((await remove(w)).pending).toBe(true);
    state.failing = false;
    const again = await remove(w);
    expect(again).toEqual({ ok: true, detached: [] });
    expect(await subjectRow(w)).toBeNull();
    expect(state.deletedBy).toEqual(["a.probe", "a.probe", "z.flaky"]);
    expect(
      await w.db.all(
        "SELECT 1 FROM subject_events WHERE type = 'subject.deleted'",
      ),
    ).toHaveLength(1);
    // Nothing is left to remove, and the completion step reports so without touching stores.
    expect(await remove(w)).toEqual({ ok: false, detached: [] });
    expect(
      await completeProductRemoval(w.ctx(), { product: P, subject: w.subject }),
    ).toEqual({ removed: false });
    expect(state.deletedBy).toHaveLength(3);
  });

  it("a formerly bound device cannot create a key ring", async () => {
    const w = await world();
    state.failing = false;
    expect(await createRingAs(w, D1)).toBe(201);
    expect(await getRing(w.db, P, w.subject)).not.toBeNull();
    await remove(w);
    expect(await getRing(w.db, P, w.subject)).toBeNull();
    expect(await createRingAs(w, D1)).toBe(403);
    expect(await createRingAs(w, D2)).toBe(403);
    expect(await getRing(w.db, P, w.subject)).toBeNull();
  });
});
