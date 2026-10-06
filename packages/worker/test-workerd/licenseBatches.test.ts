/// <reference types="@cloudflare/workers-types" />
// LX-28: a 500-licence batch on REAL D1 (miniflare), the measurement the brief asks for. The Node
// lane runs the same handler on better-sqlite3, whose transaction is not D1's `batch()`: this
// proves the four statements (`INSERT … SELECT … FROM json_each(?)` for the licences and the keys)
// run on D1 at the 500 cap, commit together or not at all, store no plaintext key, and that the
// keys activate and Disable unused keys counts right through the real runtime's WebCrypto and the
// real rate-limit Durable Object.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import djdlCatalog from "../../../products/djdl/catalog.json";
import { D1Db } from "../src/db/d1.js";
import type { Env as WorkerEnv } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { MAX_BATCH_COUNT } from "../src/services/license/batches.js";
import { NOW, seedProduct } from "./seed.js";

const SLUG = "batchbox";
const GROUP = "admins";
const workerEnv = {
  ...(env as unknown as WorkerEnv),
  ADMIN_SESSION_SECRET: "workerd-batch-admin-secret",
  PLATFORM_ADMIN_GROUP: GROUP,
  KEY_HASH_PEPPER: "workerd-batch-pepper",
} as WorkerEnv;
const db = new D1Db(env.DB);

async function admin(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await issueSession(
    workerEnv,
    { sub: "op-w", name: "Op", email: "op@x.io", groups: [GROUP] },
    NOW,
  );
  const full = `/api/products/${SLUG}${path}`;
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    workerEnv,
    db,
    full,
    { now: NOW },
  );
}

async function count(sql: string, ...params: string[]): Promise<number> {
  return (await db.first<{ n: number }>(sql, ...params))!.n;
}

let ip = 0;
async function activate(key: string, device: string): Promise<number> {
  ip++;
  const product = (await loadProduct(workerEnv, db, SLUG))!;
  const res = await handleActivate(
    new Request("https://key.plrs.im/x", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "x-pkey-device": device,
        "cf-connecting-ip": `198.51.100.${ip}`,
      },
    }),
    workerEnv,
    db,
    product,
    NOW,
  );
  return res.status;
}

describe("licence batches on D1 (LX-28)", () => {
  beforeAll(async () => {
    await seedProduct(workerEnv, db, SLUG, djdlCatalog);
    await db.run(
      `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
         channels_json, min_version, max_version, policy_fingerprint, modified_by, modified_at)
       VALUES (?, 'pro', 'Pro', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      SLUG,
      NOW,
    );
  });

  it(`commits a ${MAX_BATCH_COUNT}-licence batch, stores no key, activates its keys and disables the unused ones`, async () => {
    const res = await admin("POST", "/license/batches", {
      label: "Store pool",
      count: MAX_BATCH_COUNT,
      tier: "pro",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      batchId: string;
      licenses: { licenseId: string; key: string }[];
    };
    expect(body.licenses).toHaveLength(MAX_BATCH_COUNT);

    expect(
      await count(
        "SELECT COUNT(*) AS n FROM licenses WHERE product = ? AND batch_id = ?",
        SLUG,
        body.batchId,
      ),
    ).toBe(MAX_BATCH_COUNT);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM keys_index k
           JOIN licenses l ON l.product = k.product AND l.id = k.license_id
          WHERE l.batch_id = ?`,
        body.batchId,
      ),
    ).toBe(MAX_BATCH_COUNT);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM audit WHERE product = ? AND action = 'license.batch.create'",
        SLUG,
      ),
    ).toBe(1);
    // No plaintext key in the tables a batch writes.
    const sample = body.licenses[MAX_BATCH_COUNT - 1]!.key;
    for (const [table, cols] of [
      ["licenses", "id || COALESCE(batch_id, '')"],
      ["keys_index", "key_hash || license_id || COALESCE(label, '')"],
      ["license_batches", "id || label || created_by"],
      ["audit", "COALESCE(summary, '') || COALESCE(target_id, '')"],
    ] as const)
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM ${table} WHERE instr(${cols}, ?) > 0`,
          sample.slice("pkey_batchbox_".length),
        ),
        table,
      ).toBe(0);

    // The first, a middle and the last key activate.
    const used = [0, 250, MAX_BATCH_COUNT - 1];
    for (const i of used)
      expect(await activate(body.licenses[i]!.key, `dev-${i}`)).toBe(200);

    const disable = await admin(
      "POST",
      `/license/batches/${body.batchId}/disable-unused`,
    );
    expect(await disable.json()).toEqual({
      disabled: MAX_BATCH_COUNT - used.length,
    });
    const read = (await (
      await admin("GET", `/license/batches/${body.batchId}`)
    ).json()) as Record<string, unknown>;
    expect(read).toMatchObject({
      count: MAX_BATCH_COUNT,
      used: used.length,
      unused: 0,
      disabled: MAX_BATCH_COUNT - used.length,
    });
    expect(await activate(body.licenses[1]!.key, "dev-thief")).not.toBe(200);
    expect(await activate(body.licenses[0]!.key, "dev-0-again")).toBe(200);
  });

  it("rolls the whole batch back on D1 when one statement fails", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM licenses");
    const beforeBatches = await count(
      "SELECT COUNT(*) AS n FROM license_batches",
    );
    await db.run(
      `CREATE TRIGGER lx28_fail BEFORE INSERT ON keys_index
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    try {
      let status = 0;
      try {
        status = (
          await admin("POST", "/license/batches", {
            label: "doomed",
            count: 20,
            tier: "pro",
          })
        ).status;
      } catch {
        status = 500;
      }
      expect(status).toBe(500);
      expect(await count("SELECT COUNT(*) AS n FROM licenses")).toBe(before);
      expect(await count("SELECT COUNT(*) AS n FROM license_batches")).toBe(
        beforeBatches,
      );
    } finally {
      await db.run("DROP TRIGGER lx28_fail");
    }
  });
});
