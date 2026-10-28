/** Shared by the Connect identity and ring-listener tests: a person with devices A and B. */
import { expect } from "vitest";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../../seed.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { serializeServices } from "../../../src/core/services.js";
import { setServices } from "../../../src/core/products/store.js";
import { loadProduct } from "../../../src/core/products.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";

export const SLUG = "djdl";
export const BASE = "https://key.plrs.im";
export const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
export const C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
export const OTHER = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

export interface World {
  db: Db;
  env: Env;
  subject: string;
  tokens: Record<string, string>;
  key: string;
}

const SERVICE_SLUGS = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
  "commerce",
  "connect",
] as const;

/** Exactly these services on, every other off. */
export async function enable(db: Db, on: readonly string[]): Promise<void> {
  const services = Object.fromEntries(
    SERVICE_SLUGS.map((k) => [k, { enabled: on.includes(k) }]),
  );
  await setServices(
    db,
    SLUG,
    serializeServices({ services } as never),
    "manifest",
    NOW,
  );
}

export async function activate(
  w: Pick<World, "db" | "env">,
  key: string,
  deviceId: string,
): Promise<string> {
  const product = (await loadProduct(w.env, w.db, SLUG))!;
  const headers = { authorization: `Bearer ${key}`, "x-pkey-device": deviceId };
  const res = await handleActivate(
    mkReq("POST", headers),
    w.env,
    w.db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

export async function bindTo(
  w: Pick<World, "db" | "env">,
  deviceId: string,
  email: string,
): Promise<string> {
  const who = { issuerKey: "email", subject: email, kind: "email" } as const;
  const opts = { unfenced: true as const, product: { slug: SLUG } };
  const r = await signIn(w.db, who, NOW, opts);
  if (r.status !== "signed_in") throw new Error(r.status);
  const bound = await setDeviceSubject(w.env, w.db, SLUG, deviceId, r.subject!);
  expect(bound).toBe(true);
  return r.subject!;
}

/** Devices A and B of one person, both with keys. C and OTHER are added by tests. */
export async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  await seedProduct(db, SLUG);
  await enable(db, ["license", "identity", "connect"]);
  const { key } = await seedLicenseWithKey(db, SLUG);
  const w = { db, env, key, tokens: {} as Record<string, string> };
  for (const d of [A, B]) w.tokens[d] = await activate(w, key, d);
  const subject = await bindTo(w, A, "ada@example.com");
  await bindTo(w, B, "ada@example.com");
  for (const d of [A, B])
    await upsertDeviceKeys(db, SLUG, d, await newKeys(), NOW);
  return { ...w, subject };
}
