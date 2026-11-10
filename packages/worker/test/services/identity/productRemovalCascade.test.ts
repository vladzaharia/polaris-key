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
import "../../../src/index.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { asR2, R2Mock } from "../../r2Mock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../../seed.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { loadProduct } from "../../../src/core/products.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../../../src/core/accounts/subjectHooks.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { getRing } from "../../../src/core/keyring/store.js";
import {
  completeProductRemoval,
  removeProductData,
} from "../../../src/services/identity/accounts/deletion.js";
import { ErasureLedgerError } from "../../../src/services/identity/accounts/erasureLedger.js";
import {
  recordSubjectErasure,
  subjectErasureKey,
  SUBJECT_ERASURE_PREFIX,
} from "../../../src/services/identity/accounts/subjectErasureLedger.js";
import type { AccountContext } from "../../../src/services/identity/accounts/links.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";

const P = "djdl";
const RING = "rg_AAAAAAAAAAAAAAAAAAAAAA";
const KID = "0123456789abcdef0123456789abcdef";
const D1 = "dev-rm-1";
const D2 = "dev-rm-2";

interface World {
  db: Db;
  env: Env;
  r2: R2Mock;
  key: string;
  tokens: Record<string, string>;
  subject: string;
  accountId: string;
  ctx: () => AccountContext;
}

/** What the probe store saw at its delete: devices still bound to the subject. */
let seenBound: number[] = [];
let failing = true;
let deletedBy: string[] = [];

beforeEach(() => {
  seenBound = [];
  failing = true;
  deletedBy = [];
});
afterEach(() => {
  unregisterSubjectStore("a.probe");
  unregisterSubjectStore("z.flaky");
});

async function addDevice(w: World, id: string, email: string) {
  const product = (await loadProduct(w.env, w.db, P))!;
  const res = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${w.key}`, "x-pkey-device": id }),
    w.env,
    w.db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  w.tokens[id] = ((await res.json()) as { token: string }).token;
  const who = { issuerKey: "email", subject: email, kind: "email" } as const;
  const r = await signIn(w.db, who, NOW, {
    unfenced: true,
    product: { slug: P },
  });
  if (r.status !== "signed_in") throw new Error(`sign-in ${r.status}`);
  w.subject = r.subject!;
  expect(await setDeviceSubject(w.env, w.db, P, id, w.subject)).toBe(true);
  await upsertDeviceKeys(w.db, P, id, await newKeys(), NOW);
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const r2 = new R2Mock();
  const env = makeEnv(new KvMock(), []);
  env.BLOBS = asR2(r2);
  await seedProduct(db, P);
  const on = (enabled: boolean) => ({ enabled });
  await setServices(
    db,
    P,
    serializeServices({
      services: {
        license: on(true),
        config: on(true),
        release: on(false),
        distribution: on(false),
        update: on(false),
        identity: on(true),
        sync: on(true),
        commerce: on(false),
        connect: on(false),
      },
    }),
    "manifest",
    NOW,
  );
  const { key } = await seedLicenseWithKey(db, P);
  const w: World = {
    db,
    env,
    r2,
    key,
    tokens: {},
    subject: "",
    accountId: "",
    ctx: () => ({ db, env, now: NOW, origin: "https://key.plrs.im" }),
  };
  await addDevice(w, D1, "ada@example.com");
  await addDevice(w, D2, "ada@example.com");
  w.accountId = (await db.first<{ account_id: string }>(
    "SELECT account_id FROM account_product_subjects WHERE product = ? AND subject = ?",
    P,
    w.subject,
  ))!.account_id;
  registerSubjectStore("a.probe", {
    merge: async () => {},
    delete: async ({ db: d }, { subject }) => {
      const n = await d.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM devices WHERE subject = ?",
        subject,
      );
      seenBound.push(n!.n);
      deletedBy.push("a.probe");
    },
  });
  registerSubjectStore("z.flaky", {
    merge: async () => {},
    delete: async () => {
      if (failing) throw new Error("store down");
      deletedBy.push("z.flaky");
    },
  });
  return w;
}

const remove = (w: World) =>
  removeProductData(w.ctx(), {
    accountId: w.accountId,
    product: P,
    alsoDetachLicenses: false,
  });
const subjectRow = (w: World) =>
  w.db.first(
    "SELECT 1 FROM account_product_subjects WHERE product = ? AND subject = ?",
    P,
    w.subject,
  );
const createRingAs = async (w: World, device: string) => {
  const res = await dispatchWith(
    new Request(`https://key.plrs.im/${P}/devices/keyring`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.tokens[device]}` },
      body: JSON.stringify({
        ringId: RING,
        rootKid: KID,
        wrap: { kem: 32, enc: "e", ct: "c" },
        recovery: { ct: "rec" },
      }),
    }),
    w.env,
    w.db,
    NOW,
  );
  return res.status;
};

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
    expect(deletedBy).toEqual([]);
    expect(await subjectRow(w)).not.toBeNull();
    expect(
      (await w.db.all("SELECT 1 FROM devices WHERE subject = ?", w.subject))
        .length,
    ).toBe(2);
    w.env.BLOBS = undefined;
    await expect(remove(w)).rejects.toBeInstanceOf(ErasureLedgerError);
    expect(deletedBy).toEqual([]);
  });
});

describe("the cascade", () => {
  it("clears every binding before any store runs", async () => {
    const w = await world();
    failing = false;
    const out = await remove(w);
    expect(out).toEqual({ ok: true, detached: [] });
    expect(seenBound).toEqual([0]);
    expect(deletedBy).toEqual(["a.probe", "z.flaky"]);
    expect(await subjectRow(w)).toBeNull();
  });

  it("a failing store answers pending, keeps the subject, and the others still finish", async () => {
    const w = await world();
    const out = await remove(w);
    expect(out).toEqual({ ok: true, detached: [], pending: true });
    expect(deletedBy).toEqual(["a.probe"]);
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
    failing = false;
    const again = await remove(w);
    expect(again).toEqual({ ok: true, detached: [] });
    expect(await subjectRow(w)).toBeNull();
    expect(deletedBy).toEqual(["a.probe", "a.probe", "z.flaky"]);
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
    expect(deletedBy).toHaveLength(3);
  });

  it("a formerly bound device cannot create a key ring", async () => {
    const w = await world();
    failing = false;
    expect(await createRingAs(w, D1)).toBe(201);
    expect(await getRing(w.db, P, w.subject)).not.toBeNull();
    await remove(w);
    expect(await getRing(w.db, P, w.subject)).toBeNull();
    expect(await createRingAs(w, D1)).toBe(403);
    expect(await createRingAs(w, D2)).toBe(403);
    expect(await getRing(w.db, P, w.subject)).toBeNull();
  });
});
