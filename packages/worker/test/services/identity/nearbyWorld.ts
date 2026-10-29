/// <reference types="@cloudflare/workers-types" />

// The world the nearby-approval route tests share: a product with Identity, an account with two
// signed-in devices holding keys (M, M2), a request the new device D started, and a signed proof.

import { expect } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { KvMock } from "../../kvMock.js";
import { makeTestDb } from "../../helpers.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "../../seed.js";
import { loadProduct, type Product } from "../../../src/core/products.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { servicesOn } from "../../transcripts/world.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import {
  createNearby,
  nearbyNetHash,
  nearbyRef,
} from "../../../src/services/identity/passthrough/nearbyStore.js";

export const SLUG = "djdl";
export const M = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
export const M2 = "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";
export const D = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
export const FILL = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
export const IP = "198.51.100.7";
export const HANDLE = "nr_AAAAAAAAAAAAAAAAAAAAAA";

export type Keys = Awaited<ReturnType<typeof newKeys>>;
export interface Sent {
  to: string;
  subject: string;
  text: string;
}
export interface Dev {
  id: string;
  token: string;
  keys: Keys;
}
export interface W {
  db: Db;
  env: Env;
  product: Product;
  accountId: string;
  subject: string;
  m: Dev;
  m2: Dev;
  sent: Sent[];
}

export async function activate(
  w: Pick<W, "db" | "env" | "product">,
  id: string,
  key: string,
): Promise<string> {
  const req = mkReq("POST", {
    "x-pkey-device": id,
    authorization: `Bearer ${key}`,
  });
  const res = await handleActivate(req, w.env, w.db, w.product, NOW);
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  return token;
}

export interface Opts {
  /** Licences the account owns with a free seat. */
  free?: number;
  /** A licence the account owns with its only seat taken. */
  full?: boolean;
  /** The policy grants the account a new licence (`create`). */
  grant?: boolean;
  license?: boolean;
}

export async function world(o: Opts = {}): Promise<W> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  const sent: Sent[] = [];
  env.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
  env.EMAIL = {
    send: async (m: Sent) => {
      sent.push(m);
      return { messageId: "m" };
    },
  } as unknown as Env["EMAIL"];
  await seedProduct(db, SLUG);
  const license = o.license !== false;
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: license
        ? servicesOn("config", "license", "identity")
        : servicesOn("config", "identity"),
    }),
    "manifest",
    NOW,
  );
  if (o.grant) {
    await seedTier(db, SLUG, "free", { deviceLimit: 2 });
    const policy = {
      mode: "oidcDefault",
      tierId: "free",
      rateLimitPerHour: 100,
      enabled: true,
    };
    await db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify(policy),
      SLUG,
    );
  }
  const product = (await loadProduct(env, db, SLUG))!;
  const base = { db, env, product };

  const email = "ada@example.com";
  const person = {
    emailVerified: true,
    email,
    kind: "email",
    subject: email,
    issuerKey: "email",
  } as const;
  const r = await signIn(db, person, NOW, {
    product: { slug: SLUG },
    unfenced: true,
  });
  if (r.status !== "signed_in") throw new Error("sign-in failed");
  const accountId = r.account.id;
  const subject = r.subject!;

  // M signs in on a licence of its own and has registered keys; so does a second approver.
  const { key } = await seedLicenseWithKey(db, SLUG);
  const dev = async (id: string): Promise<Dev> => {
    const keys = await newKeys();
    const token = await activate(base, id, key);
    expect(await setDeviceSubject(env, db, SLUG, id, subject)).toBe(true);
    await upsertDeviceKeys(db, SLUG, id, keys, NOW);
    return { id, token, keys };
  };
  const m = await dev(M);
  const m2 = await dev(M2);

  const own = async (id: string, tier: string | null) => {
    const l = await seedLicenseWithKey(db, SLUG, { id, tierId: tier });
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      accountId,
      SLUG,
      id,
    );
    return l;
  };
  for (let i = 0; i < (o.free ?? 0); i++) await own(`lic_free_${i}`, null);
  if (o.full) {
    await seedTier(db, SLUG, "one", { deviceLimit: 1 });
    const l = await own("lic_full", "one");
    await activate(base, FILL, l.key);
  }
  return { ...base, accountId, subject, m, m2, sent };
}

export function netReq(ip: string): Request {
  return new Request("https://x/", { headers: { "cf-connecting-ip": ip } });
}

export async function startRequest(w: W, o: { proven?: boolean } = {}) {
  const keys = await newKeys();
  const ref = (await nearbyRef(w.env, SLUG, HANDLE))!;
  expect(
    await createNearby(w.env, ref, {
      product: SLUG,
      deviceId: D,
      signKey: keys.signKey,
      agreeKey: keys.agreeKey,
      label: "Kitchen TV",
      meta: { platform: "linux" },
      netHash: await nearbyNetHash(w.env, netReq(IP)),
      startedAt: NOW,
      proven: o.proven ?? false,
    }),
  ).toBe(true);
  return { handle: HANDLE, ref, keys };
}

export async function sign(
  priv: CryptoKey,
  device: string,
  value: string,
  purpose = "nearby-approve",
) {
  const msg = ["pkey-proof/1", purpose, SLUG, device, value, "-"].join("\n");
  return base64UrlEncodeBytes(
    new Uint8Array(
      await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(msg)),
    ),
  );
}

/** A route's answer as the tests read it: status, headers and the JSON body (`{}` when none). */
export async function answerOf(res: Response) {
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, headers: res.headers, body };
}
