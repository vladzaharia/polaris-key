/// <reference types="@cloudflare/workers-types" />
/**
 * The world the per-product removal tests share (U-12.1, U-12.2): a product with Identity and
 * Cloud Sync on, one account signed in on two devices, and two probe subject stores: `a.probe`
 * (first in name order; records how many devices are still bound when it deletes) and `z.flaky`
 * (last; throws while `state.failing`).
 */
import { expect } from "vitest";
import "../../../../src/index.js";
import { makeTestDb } from "../../../helpers.js";
import { KvMock } from "../../../kvMock.js";
import { asR2, R2Mock } from "../../../r2Mock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../../../seed.js";
import { newKeys } from "../../../deviceKeyFixtures.js";
import { dispatchWith } from "../../../../src/dispatch.js";
import { loadProduct } from "../../../../src/core/products.js";
import { setServices } from "../../../../src/core/products/store.js";
import { serializeServices } from "../../../../src/core/services.js";
import { setDeviceSubject } from "../../../../src/core/accounts/accountSubjects.js";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../../../../src/core/accounts/subjectHooks.js";
import { signIn } from "../../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../../src/services/license/activation.js";
import { upsertDeviceKeys } from "../../../../src/core/devices/keys.js";
import { callCloudSync } from "../../../../src/services/sync/do/client.js";
import { formatHlc } from "../../../../src/services/sync/engine/hlc.js";
import { removeProductData } from "../../../../src/services/identity/accounts/productRemoval.js";
import type { AccountContext } from "../../../../src/services/identity/accounts/links.js";
import type { Db } from "../../../../src/db/types.js";
import type { Env } from "../../../../src/platform/env.js";

const T0 = 1_760_000_000_000;
export const P = "djdl";
export const RING = "rg_AAAAAAAAAAAAAAAAAAAAAA";
export const KID = "0123456789abcdef0123456789abcdef";
export const D1 = "dev-rm-1";
export const D2 = "dev-rm-2";

export interface World {
  db: Db;
  env: Env;
  r2: R2Mock;
  key: string;
  tokens: Record<string, string>;
  subject: string;
  accountId: string;
  ctx: (now?: number) => AccountContext;
}

/** What the probe stores saw. Reset by {@link resetState}. */
export const state = {
  /** Devices still bound to the subject at each `a.probe` delete. */
  seenBound: [] as number[],
  failing: true,
  deletedBy: [] as string[],
};

export function resetState(): void {
  state.seenBound = [];
  state.failing = true;
  state.deletedBy = [];
}

export function unregisterProbes(): void {
  unregisterSubjectStore("a.probe");
  unregisterSubjectStore("z.flaky");
}

export async function addDevice(w: World, id: string, email: string) {
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

export async function world(): Promise<World> {
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
    ctx: (now = NOW) => ({ db, env, now, origin: "https://key.plrs.im" }),
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
      state.seenBound.push(n!.n);
      state.deletedBy.push("a.probe");
    },
  });
  registerSubjectStore("z.flaky", {
    merge: async () => {},
    delete: async () => {
      if (state.failing) throw new Error("store down");
      state.deletedBy.push("z.flaky");
    },
  });
  return w;
}

export const remove = (w: World) =>
  removeProductData(w.ctx(), {
    accountId: w.accountId,
    product: P,
    alsoDetachLicenses: false,
  });
export const subjectRow = (w: World) =>
  w.db.first(
    "SELECT 1 FROM account_product_subjects WHERE product = ? AND subject = ?",
    P,
    w.subject,
  );
export const createRingAs = async (w: World, device: string) => {
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

/** A Cloud Sync object with one setting, so there is something for an erasure to remove. */
export async function populate(w: World, subject: string) {
  await callCloudSync<"push">(
    w.env,
    { product: P, subject },
    {
      op: "push",
      deviceId: "d1",
      family: "desktop",
      limits: { quotaBytes: 1_000_000_000 },
      request: {
        clientId: "c_000000000000000client1",
        cursor: 0,
        mutations: [
          {
            mutationId: 1,
            target: { setting: "theme", scope: "user" },
            op: "set",
            editedHlc: formatHlc(T0, 0),
            value: "dark",
          },
        ],
      },
      classified: [{ verdict: "accept", scope: "user", policy: "lastWrite" }],
      serverNow: T0 + 3_600_000,
    },
  );
}
