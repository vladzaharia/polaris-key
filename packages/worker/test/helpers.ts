import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDb } from "../src/db/sqlite.js";
import { hashKey } from "../src/crypto.js";
import type { Env } from "../src/env.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "migrations");

// Every migration, in filename order — so 0001_init and all later migrations reach the test DB.
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

/** A fresh in-memory database with every migration applied (in filename order). */
export function makeTestDb(): SqliteDb {
  const sqlite = new Database(":memory:");
  // better-sqlite3's multi-statement DDL runner (bound to dodge a false-positive lint).
  const runScript = sqlite.exec.bind(sqlite);
  for (const sql of MIGRATIONS) runScript(sql);
  return new SqliteDb(sqlite);
}

// ── KV key names for in-flight sign-in credentials ───────────────────────────
//
// B7-03 / A3-B1 hashed every one of these under `KEY_HASH_PEPPER`, so a test that plants a flow
// record can no longer name the key by pasting the credential into it. Stated once here rather
// than inlined at ~40 call sites: the point of the fix is that the mapping lives in exactly one
// place, and a test suite that re-derives it forty times is forty chances to assert the old
// shape by accident.

export const productFlowKey = async (
  env: Env,
  product: string,
  state: string,
): Promise<string> =>
  `p:${product}:flow:${await hashKey(state, env.KEY_HASH_PEPPER)}`;

export const productDeviceFlowKey = async (
  env: Env,
  product: string,
  deviceCode: string,
): Promise<string> =>
  `p:${product}:device-flow:${await hashKey(deviceCode, env.KEY_HASH_PEPPER)}`;

export const portalFlowKey = async (env: Env, state: string): Promise<string> =>
  `portal:oidc-flow:${await hashKey(state, env.KEY_HASH_PEPPER)}`;

export const portalMagicKey = async (
  env: Env,
  token: string,
): Promise<string> =>
  `portal:magic:${await hashKey(token, env.KEY_HASH_PEPPER)}`;

export const adminFlowKey = async (env: Env, state: string): Promise<string> =>
  `admin:flow:${await hashKey(state, env.KEY_HASH_PEPPER)}`;

/**
 * The `Cookie` header a browser would send back after a start handler's 302 (A3-06).
 *
 * Every callback now demands the `__Host-pkey_flow` value the matching start handler set, so a
 * test that drives a full sign-in has to carry it the way a browser would.
 */
export function flowCookie(startRes: Response): string {
  const set = startRes.headers.get("set-cookie") ?? "";
  const match = set.match(/__Host-pkey_flow=([^;]*)/);
  if (!match)
    throw new Error("no __Host-pkey_flow cookie on the start response");
  return `__Host-pkey_flow=${match[1]}`;
}
