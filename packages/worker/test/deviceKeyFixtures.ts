/// <reference types="@cloudflare/workers-types" />

// Fresh device key pairs for the routes that register or bind them (CC-03.2, I-13.2).

import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { setServices } from "../src/core/products/store.js";
import { serializeServices } from "../src/core/services.js";
import { CONFIG_ONLY } from "./transcripts/world.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";

const b64 = (b: Uint8Array): string => base64UrlEncodeBytes(b);

export async function newKeys(agreeRaw?: Uint8Array): Promise<{
  signKey: string;
  agreeKey: string;
  priv: CryptoKey;
}> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const signKey = b64(
    new Uint8Array(
      (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
    ),
  );
  const raw = agreeRaw ?? crypto.getRandomValues(new Uint8Array(32));
  if (!agreeRaw) raw[31]! &= 0x7f;
  return { signKey, agreeKey: b64(raw), priv: kp.privateKey };
}

export interface World {
  db: Db;
  env: Env;
  product: Product;
}

export async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
  await setServices(
    db,
    "djdl",
    serializeServices({ services: CONFIG_ONLY }),
    "manifest",
    NOW,
  );
  return { db, env, product: (await loadProduct(env, db, "djdl"))! };
}
