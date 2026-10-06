/**
 * LX-28: bulk floating keys (notes/S-24 §5.6, §6.1, §6.3, §7.1, §7.3; D10).
 *
 *   - `POST …/license/batches` creates up to 500 floating licences in one labelled batch: the
 *     batch row, the licences, their keys and the audit row commit in ONE D1 batch of a fixed
 *     number of statements, or not at all. 501 is refused, and so is anything that would make the
 *     licences assigned (a name, an email).
 *   - The answer carries every key once, `no-store`; no table holds a plaintext key afterwards.
 *   - Every key activates.
 *   - Batch reads carry `used` (licences that ever had a device bound), `unused` and `disabled`.
 *   - Disable unused keys disables only the active licences no device was ever bound to.
 *   - Licence reads carry `batchId` and the list filters on it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedTier } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { listAudit, type LicenseRow } from "../src/repo.js";
import { isFloatingLicense } from "../src/core/accountSubjects.js";
import { licenseHolder } from "../src/core/licenseHolders.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import {
  disableUnusedAfterAuditStatement,
  MAX_BATCH_COUNT,
  unusedCountIs,
} from "../src/services/license/batches.js";
import { auditStatementFor } from "../src/admin/audit.js";
import type { DbStatement } from "../src/db/types.js";

const SLUG = "tonebox";
const PLATFORM_GROUP = "admins";
const PEPPER = "lx28-test-pepper";

let db: SqliteDb;
let env: Env;
let product: Product;
let call: (method: string, path: string, body?: unknown) => Promise<Response>;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  env.KEY_HASH_PEPPER = PEPPER;
  await seedProduct(db, SLUG);
  await seedTier(db, SLUG, "pro", { deviceLimit: 3, expiryDays: 30 });
  product = (await loadProduct(env, db, SLUG))!;
  const { token, session } = await issueSession(
    env,
    { sub: "op-1", name: "Op", email: "op@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  call = (method, path, body) => {
    const full = `/api/products/${SLUG}${path}`;
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      db,
      full.split("?")[0]!,
      { now: NOW },
    );
  };
});

interface CreateAnswer {
  batchId: string;
  licenses: { licenseId: string; key: string }[];
  batch: Record<string, unknown>;
  expiresAt: number | null;
}

async function createBatch(body: Record<string, unknown>) {
  const res = await call("POST", "/license/batches", body);
  expect(res.status).toBe(201);
  return { res, body: (await res.json()) as CreateAnswer };
}

let ip = 0;
async function activate(key: string, device: string): Promise<Response> {
  ip++;
  return handleActivate(
    new Request("https://key.plrs.im/x", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "x-pkey-device": device,
        // A fresh address per activation, so the per-IP activation bucket (30 a minute) is not
        // what the test measures.
        "cf-connecting-ip": `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`,
      },
    }) as unknown as Request,
    env,
    db,
    product,
    NOW,
  );
}

async function batchLicenses(batchId: string): Promise<LicenseRow[]> {
  return db.all<LicenseRow>(
    "SELECT * FROM licenses WHERE product = ? AND batch_id = ? ORDER BY id",
    SLUG,
    batchId,
  );
}

/** Every text cell of every table, for the "no plaintext key is stored" scan. */
async function everyTextCell(): Promise<string[]> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const out: string[] = [];
  for (const { name } of tables)
    for (const row of await db.all<Record<string, unknown>>(
      `SELECT * FROM "${name}"`,
    ))
      for (const v of Object.values(row))
        if (typeof v === "string") out.push(v);
  return out;
}

describe("POST …/license/batches", () => {
  it(`creates ${MAX_BATCH_COUNT} floating licences atomically, answers each key once (no-store), stores no key, and every key activates`, async () => {
    const batchSpy = vi.spyOn(db, "batch");
    const { res, body } = await createBatch({
      label: "Steam keys, October",
      count: MAX_BATCH_COUNT,
      tier: "pro",
    });

    // One D1 batch, four statements whatever the count: the batch row, the licences, the keys,
    // the audit row.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const statements = batchSpy.mock.calls[0]![0] as DbStatement[];
    expect(statements).toHaveLength(4);
    for (const s of statements)
      expect(s.params.length).toBeLessThanOrEqual(100); // D1's bound-parameter limit

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.licenses).toHaveLength(MAX_BATCH_COUNT);
    const keys = body.licenses.map((l) => l.key);
    expect(new Set(keys).size).toBe(MAX_BATCH_COUNT);
    expect(new Set(body.licenses.map((l) => l.licenseId)).size).toBe(
      MAX_BATCH_COUNT,
    );
    for (const k of keys) expect(k).toMatch(/^pkey_tonebox_[A-Za-z0-9_-]{22}$/);
    expect(body.batch).toMatchObject({
      id: body.batchId,
      label: "Steam keys, October",
      count: MAX_BATCH_COUNT,
      tier: "pro",
      createdBy: "op-1",
      createdAt: NOW,
      used: 0,
      unused: MAX_BATCH_COUNT,
      disabled: 0,
    });
    // The tier's 30-day policy, as a single create without `expiresAt`.
    expect(body.expiresAt).toBe(NOW + 30 * 86400);

    const rows = await batchLicenses(body.batchId);
    expect(rows).toHaveLength(MAX_BATCH_COUNT);
    for (const r of rows) {
      expect(isFloatingLicense(r)).toBe(true);
      expect(licenseHolder(r)).toEqual({ kind: "floating" });
      expect(r).toMatchObject({
        status: "active",
        origin: "admin",
        name: null,
        email: null,
        sub: null,
        tier_id: "pro",
        expires_at: NOW + 30 * 86400,
        device_limit: null,
        batch_id: body.batchId,
        modified_by: "op-1",
      });
    }
    const keyRows = await db.all<{
      key_hash: string;
      license_id: string;
      status: string;
      label: string;
    }>(
      `SELECT k.key_hash, k.license_id, k.status, k.label FROM keys_index k
         JOIN licenses l ON l.product = k.product AND l.id = k.license_id
        WHERE l.batch_id = ?`,
      body.batchId,
    );
    expect(keyRows).toHaveLength(MAX_BATCH_COUNT);
    expect(new Set(keyRows.map((k) => k.license_id)).size).toBe(
      MAX_BATCH_COUNT,
    );
    for (const k of keyRows) {
      expect(k.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(k).toMatchObject({ status: "active", label: "Initial key" });
    }

    // No table holds a key or its random part: only the peppered hashes are kept.
    const cells = (await everyTextCell()).join("\n");
    for (const k of keys) {
      expect(cells).not.toContain(k);
      expect(cells).not.toContain(k.slice("pkey_tonebox_".length));
    }

    // Audited once, with the label, the count and the tier, and no key.
    const [row] = await listAudit(db, SLUG, { action: "license.batch.create" });
    expect(row).toMatchObject({
      action: "license.batch.create",
      target_kind: "license_batch",
      target_id: body.batchId,
      actor_sub: "op-1",
    });
    expect(row!.summary).toBe(
      `Created batch "Steam keys, October" of ${MAX_BATCH_COUNT} licenses (tier: pro, holder: floating)`,
    );

    // Every key activates, each on its own device.
    for (const [i, l] of body.licenses.entries()) {
      const r = await activate(l.key, `device-${i}`);
      expect(r.status).toBe(200);
      const answer = (await r.json()) as { license: { id: string } };
      expect(answer.license.id).toBe(l.licenseId);
    }
    expect(
      (await (
        await call("GET", `/license/batches/${body.batchId}`)
      ).json()) as Record<string, unknown>,
    ).toMatchObject({ used: MAX_BATCH_COUNT, unused: 0 });
  });

  it(`refuses ${MAX_BATCH_COUNT + 1} keys, and every other bad body, writing nothing`, async () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [{ label: "x", count: MAX_BATCH_COUNT + 1, tier: "pro" }, ["count"]],
      [{ label: "x", count: 0, tier: "pro" }, ["count"]],
      [{ label: "x", count: 2.5, tier: "pro" }, ["count"]],
      [{ label: "x", count: "10", tier: "pro" }, ["count"]],
      [{ label: "x", tier: "pro" }, ["count"]],
      [{ label: "", count: 2, tier: "pro" }, ["label"]],
      [{ label: "   ", count: 2, tier: "pro" }, ["label"]],
      [{ label: "a".repeat(81), count: 2, tier: "pro" }, ["label"]],
      [{ label: "two\nlines", count: 2, tier: "pro" }, ["label"]],
      // One line, in reading order too: the line and paragraph separators and the bidi
      // embedding, override and isolate controls are refused.
      ...["\u2028", "\u2029", "\u202a", "\u202e", "\u2066", "\u2069"].map(
        (ch): [Record<string, unknown>, string[]] => [
          { label: `Steam${ch}keys`, count: 2, tier: "pro" },
          ["label"],
        ],
      ),
      [{ count: 2, tier: "pro" }, ["label"]],
      [{ label: "x", count: 2 }, ["tier"]],
      [{ label: "x", count: 2, tier: "nope" }, ["tier"]],
      [{ label: "x", count: 2, tier: "pro", email: "a@b.io" }, ["email"]],
      [
        { label: "x", count: 2, tier: "pro", name: "Ada", profiles: ["p"] },
        ["name", "profiles"],
      ],
      [{ label: "x", count: 2, tier: "pro", deviceLimit: 0 }, ["deviceLimit"]],
      [{ label: "x", count: 2, tier: "pro", expiresAt: "soon" }, ["expiresAt"]],
      [
        { label: "x", count: 2, tier: "pro", maxOfflineDays: 400 },
        ["maxOfflineDays"],
      ],
      [
        { label: "x", count: 2, tier: "pro", minVersion: "one" },
        ["minVersion"],
      ],
      [
        { label: "x", count: 2, tier: "pro", channels: ["Bad!"] },
        ["channels.0"],
      ],
    ];
    for (const [body, fields] of cases) {
      const res = await call("POST", "/license/batches", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(((await res.json()) as { fields: string[] }).fields).toEqual(
        fields,
      );
    }
    expect(
      await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM license_batches",
      ),
    ).toEqual({ n: 0 });
    expect(
      await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM licenses"),
    ).toEqual({ n: 0 });
    expect(await listAudit(db, SLUG)).toHaveLength(0);
  });

  it("is all or nothing: a failure on the last licence's key leaves no batch, licence, key or audit row", async () => {
    // Fail the keys INSERT part way, after the batch row and every licence were written inside
    // the same batch.
    await db.run(
      `CREATE TRIGGER lx28_fail BEFORE INSERT ON keys_index
       WHEN (SELECT COUNT(*) FROM keys_index) >= 9
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    let status = 0;
    try {
      status = (
        await call("POST", "/license/batches", {
          label: "doomed",
          count: 10,
          tier: "pro",
        })
      ).status;
    } catch {
      status = 500;
    }
    expect(status).toBe(500);
    for (const table of ["license_batches", "licenses", "keys_index", "audit"])
      expect(
        await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`),
        table,
      ).toEqual({ n: 0 });
  });

  it("applies the stated terms to every licence, and labels need not be unique", async () => {
    const terms = {
      label: "Bundle",
      count: 3,
      tier: "pro",
      deviceLimit: 7,
      expiresAt: null,
      maxOfflineDays: 14,
      channels: ["beta"],
      minVersion: "1.0.0",
      maxVersion: "2.0.0",
    };
    const a = (await createBatch(terms)).body;
    const b = (await createBatch({ ...terms, expiresAt: NOW + 5 })).body;
    expect(a.batchId).not.toBe(b.batchId);
    expect(a.expiresAt).toBeNull();
    for (const r of await batchLicenses(a.batchId))
      expect(r).toMatchObject({
        device_limit: 7,
        expires_at: null,
        max_offline_days: 14,
        channels_json: '["beta"]',
        min_version: "1.0.0",
        max_version: "2.0.0",
      });
    for (const r of await batchLicenses(b.batchId))
      expect(r.expires_at).toBe(NOW + 5);
    // Ordinary non-ASCII text is a fine label; only line breaks and reordering controls are not.
    const c = (
      await createBatch({ label: "Clés · octobre 😀", count: 1, tier: "pro" })
    ).body;
    expect(c.batch.label).toBe("Clés · octobre 😀");
  });
});

describe("batch reads, used counts and Disable unused keys", () => {
  it("counts a licence as used once a device was ever bound, and disables only the others", async () => {
    // A licence created on its own, outside any batch.
    const single = (await (
      await call("POST", "/license/licenses", { tier: "pro" })
    ).json()) as { licenseId: string; key: string };
    const { body } = await createBatch({
      label: "Leaked CSV",
      count: 5,
      tier: "pro",
    });
    const [bound, deauthorized, moved, unused, alreadyOff] = body.licenses;

    // 1. Bound now.
    expect((await activate(bound!.key, "dev-bound")).status).toBe(200);
    // 2. Bound, then deauthorized: the device row stays, so it was used.
    expect((await activate(deauthorized!.key, "dev-deauth")).status).toBe(200);
    await db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      SLUG,
      "dev-deauth",
    );
    // 3. Bound, then the device moved to another licence: its key was used, so it still counts.
    expect((await activate(moved!.key, "dev-moved")).status).toBe(200);
    await db.run(
      "UPDATE devices SET license_id = ? WHERE product = ? AND device_id = ?",
      single.licenseId,
      SLUG,
      "dev-moved",
    );
    // 5. Disabled by hand earlier; never used.
    expect(
      (await call("POST", `/license/licenses/${alreadyOff!.licenseId}/disable`))
        .status,
    ).toBe(200);

    const read = async () =>
      (await (
        await call("GET", `/license/batches/${body.batchId}`)
      ).json()) as Record<string, unknown>;
    expect(await read()).toMatchObject({
      count: 5,
      used: 3,
      unused: 1,
      disabled: 1,
    });

    const res = await call(
      "POST",
      `/license/batches/${body.batchId}/disable-unused`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabled: 1 });

    const status = new Map(
      (await batchLicenses(body.batchId)).map((r) => [r.id, r.status]),
    );
    expect(status.get(bound!.licenseId)).toBe("active");
    expect(status.get(deauthorized!.licenseId)).toBe("active");
    expect(status.get(moved!.licenseId)).toBe("active");
    expect(status.get(unused!.licenseId)).toBe("disabled");
    expect(status.get(alreadyOff!.licenseId)).toBe("disabled");
    // The licence outside the batch is untouched.
    expect(
      (
        await db.first<{ status: string }>(
          "SELECT status FROM licenses WHERE product = ? AND id = ?",
          SLUG,
          single.licenseId,
        )
      )?.status,
    ).toBe("active");

    // The disabled key no longer activates; a used one still does.
    expect((await activate(unused!.key, "dev-thief")).status).not.toBe(200);
    expect((await activate(bound!.key, "dev-bound-2")).status).toBe(200);

    expect(await read()).toMatchObject({ used: 3, unused: 0, disabled: 2 });
    const [row] = await listAudit(db, SLUG, {
      action: "license.batch.disable_unused",
    });
    expect(row).toMatchObject({
      target_kind: "license_batch",
      target_id: body.batchId,
      summary: 'Disabled 1 unused license of batch "Leaked CSV"',
    });

    // Again: nothing left to disable.
    expect(
      await (
        await call("POST", `/license/batches/${body.batchId}/disable-unused`)
      ).json(),
    ).toEqual({ disabled: 0 });
  });

  it("commits Disable unused keys with its audit row, or neither", async () => {
    const { body } = await createBatch({
      label: "Pool",
      count: 3,
      tier: "pro",
    });
    const active = async () =>
      (await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM licenses WHERE batch_id = ? AND status = 'active'",
        body.batchId,
      ))!.n;
    const audited = async () =>
      (await listAudit(db, SLUG, { action: "license.batch.disable_unused" }))
        .length;

    // The audit row fails: nothing is disabled.
    await db.run(
      `CREATE TRIGGER lx28_audit_fail BEFORE INSERT ON audit
       WHEN NEW.action = 'license.batch.disable_unused'
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    let status = 0;
    try {
      status = (
        await call("POST", `/license/batches/${body.batchId}/disable-unused`)
      ).status;
    } catch {
      status = 500;
    }
    expect(status).toBe(500);
    expect(await active()).toBe(3);
    expect(await audited()).toBe(0);
    await db.run("DROP TRIGGER lx28_audit_fail");

    // A stale count (a device bound since it was read): neither statement writes.
    const { session } = await issueSession(
      env,
      { sub: "op-1", name: "Op", email: "op@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    const changes = await db.batchChanges([
      auditStatementFor(
        SLUG,
        session,
        NOW,
        "license.batch.disable_unused",
        { kind: "license_batch", id: body.batchId },
        "stale",
        unusedCountIs(SLUG, body.batchId, 2),
      ),
      disableUnusedAfterAuditStatement(SLUG, body.batchId, "op-1", NOW),
    ]);
    expect(changes).toEqual([0, 0]);
    expect(await active()).toBe(3);
    expect(await audited()).toBe(0);

    // The real route: both commit, and the row records the count the UPDATE disabled.
    expect(
      await (
        await call("POST", `/license/batches/${body.batchId}/disable-unused`)
      ).json(),
    ).toEqual({ disabled: 3 });
    expect(await active()).toBe(0);
    const [row] = await listAudit(db, SLUG, {
      action: "license.batch.disable_unused",
    });
    expect(row?.summary).toBe('Disabled 3 unused licenses of batch "Pool"');
  });

  it("lists batches newest first, 404s an unknown one, and filters licences by batch", async () => {
    const first = (await createBatch({ label: "One", count: 2, tier: "pro" }))
      .body;
    // A later second, so the order is by time and not by id.
    const later = await call("POST", "/license/batches", {
      label: "Two",
      count: 1,
      tier: "pro",
    });
    expect(later.status).toBe(201);
    const second = (await later.json()) as CreateAnswer;
    await db.run(
      "UPDATE license_batches SET created_at = ? WHERE id = ?",
      NOW + 60,
      second.batchId,
    );
    const single = (await (
      await call("POST", "/license/licenses", { tier: "pro" })
    ).json()) as { licenseId: string; license: { batchId: unknown } };
    expect(single.license.batchId).toBeNull();

    const list = (await (await call("GET", "/license/batches")).json()) as {
      batches: Record<string, unknown>[];
    };
    expect(list.batches.map((b) => b.id)).toEqual([
      second.batchId,
      first.batchId,
    ]);
    expect(list.batches[1]).toMatchObject({
      label: "One",
      count: 2,
      used: 0,
      unused: 2,
      disabled: 0,
    });

    expect((await call("GET", "/license/batches/batch_nope")).status).toBe(404);
    expect(
      (await call("POST", "/license/batches/batch_nope/disable-unused")).status,
    ).toBe(404);
    expect(
      (await call("GET", `/license/batches/${first.batchId}/disable-unused`))
        .status,
    ).toBe(405);
    expect(
      (await call("POST", `/license/batches/${first.batchId}/elsewhere`))
        .status,
    ).toBe(404);

    const filtered = (await (
      await call("GET", `/license/licenses?batch=${first.batchId}`)
    ).json()) as { licenses: { id: string; batchId: unknown }[] };
    expect(filtered.licenses.map((l) => l.id).sort()).toEqual(
      first.licenses.map((l) => l.licenseId).sort(),
    );
    for (const l of filtered.licenses) expect(l.batchId).toBe(first.batchId);
    const all = (await (await call("GET", "/license/licenses")).json()) as {
      licenses: { id: string; batchId: unknown }[];
    };
    expect(all.licenses).toHaveLength(4);
    expect(all.licenses.find((l) => l.id === single.licenseId)?.batchId).toBe(
      null,
    );
    // Single licence reads carry it too.
    const one = (await (
      await call("GET", `/license/licenses/${first.licenses[0]!.licenseId}`)
    ).json()) as { batchId: unknown; holder: unknown };
    expect(one).toMatchObject({
      batchId: first.batchId,
      holder: { kind: "floating" },
    });
  });

  it("is admin-only and CSRF-guarded", async () => {
    const path = `/api/products/${SLUG}/license/batches`;
    const send = (headers: Record<string, string>) =>
      handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ label: "x", count: 1, tier: "pro" }),
        }) as unknown as Request,
        env,
        db,
        path,
        { now: NOW },
      );

    // No session at all.
    expect([401, 403]).toContain((await send({})).status);

    // A platform admin's session without the CSRF header.
    const admin = await issueSession(
      env,
      { sub: "op-1", name: "Op", email: "op@x.io", groups: [PLATFORM_GROUP] },
      NOW,
    );
    const noCsrf = await send({ cookie: `${ADMIN_COOKIE}=${admin.token}` });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { message?: string }).message).toBe(
      "csrf",
    );

    // A signed-in operator outside the platform-admin group, with a valid CSRF token.
    const outsider = await issueSession(
      env,
      { sub: "u2", name: "Eve", email: "eve@x.io", groups: ["someone-else"] },
      NOW,
    );
    expect(
      (
        await send({
          cookie: `${ADMIN_COOKIE}=${outsider.token}`,
          [CSRF_HEADER]: outsider.session.csrf,
        })
      ).status,
    ).toBe(403);

    expect(
      await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM license_batches",
      ),
    ).toEqual({ n: 0 });
  });
});
