/**
 * I-49.5: `POST|DELETE /<p>/identity/restore` (WIRE-CONTRACT-V5 §12.11.8). Enrol mints once and
 * shows the secret once; "current" is this device's own live key under 90 days; POST is gated and
 * reads nothing while the gate or the setting is off; DELETE is never gated; the discovery
 * document names the route only while Identity, the setting and the gate all allow it; the two
 * enrol buckets fail closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import { RESTORE_CURRENT_SECONDS } from "../../../src/services/identity/restore/store.js";
import { NOW } from "../../seed.js";
import {
  A,
  B,
  BASE,
  C,
  SLUG,
  activate,
  enable,
  world,
  type World,
} from "../connect/connectFixture.js";

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(() => vi.restoreAllMocks());

const gate = (v: string | undefined) => {
  (w.env as unknown as Record<string, unknown>).LAUNCH_IDENTITY_RESTORE = v;
};

function call(
  method: "POST" | "DELETE",
  device: string | null,
  opts: { body?: unknown; now?: number; token?: string | null } = {},
): Promise<Response> {
  const token = opts.token === undefined ? w.tokens[device ?? ""] : opts.token;
  return dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/restore`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(device ? { "x-pkey-device": device } : {}),
        ...(opts.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    w.env,
    w.db,
    opts.now ?? NOW,
  );
}

const rows = async (where = "1 = 1") =>
  w.db.all<Record<string, unknown>>(
    `SELECT * FROM identity_restore_keys WHERE ${where}`,
  );

async function enrol(device = A, now = NOW) {
  const res = await call("POST", device, { now });
  expect(res.status).toBe(201);
  return (await res.json()) as { restoreId: string; secret: string };
}

beforeEach(() => gate("on"));

describe("POST enrol", () => {
  it("mints a key for the device's own subject, once, with no-store, and keeps only a hash", async () => {
    const res = await call("POST", A);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["restoreId", "secret"]);
    expect(body.restoreId).toMatch(/^rk_[A-Za-z0-9_-]{22}$/);
    expect(body.secret).toMatch(/^rs_[A-Za-z0-9_-]{43}$/);
    const [row] = await rows();
    expect(row).toMatchObject({
      id: body.restoreId,
      product: SLUG,
      device_id: A,
      subject: w.subject,
    });
    expect(JSON.stringify(row)).not.toContain(body.secret);
  });

  it("answers current for the device's own live key and moves checked_at", async () => {
    const { restoreId } = await enrol(A, NOW);
    const res = await call("POST", A, {
      body: { restoreId },
      now: NOW + 3600,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "current" });
    expect((await rows())[0]!.checked_at).toBe(NOW + 3600);
    expect((await rows())[0]!.id).toBe(restoreId);
  });

  it("mints again for another device's key of the same person: a shared backup item never keeps a signed-out device's key alive", async () => {
    const b = await enrol(B);
    const res = await call("POST", A, { body: { restoreId: b.restoreId } });
    expect(res.status).toBe(201);
    const a = (await res.json()) as { restoreId: string };
    expect(a.restoreId).not.toBe(b.restoreId);
    // B's row is untouched; A has its own.
    const ids = (await rows()).map((r) => `${r.device_id}:${r.id}`).sort();
    expect(ids).toEqual([`${A}:${a.restoreId}`, `${B}:${b.restoreId}`].sort());
  });

  it("mints again past 90 days, and for an unknown id", async () => {
    const first = await enrol(A, NOW);
    const late = await call("POST", A, {
      body: { restoreId: first.restoreId },
      now: NOW + RESTORE_CURRENT_SECONDS + 1,
    });
    expect(late.status).toBe(201);
    const unknown = await call("POST", A, {
      body: { restoreId: `rk_${"A".repeat(22)}` },
    });
    expect(unknown.status).toBe(201);
    expect(await rows()).toHaveLength(1);
  });

  it("refuses a malformed body or id with 400 bad_request and mints nothing", async () => {
    for (const body of [
      { restoreId: "nope" },
      { restoreId: 5 },
      { restoreId: `rk_${"A".repeat(22)}`, extra: 1 },
      [],
      "x",
    ]) {
      const res = await call("POST", A, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("bad_request");
    }
    expect(await rows()).toHaveLength(0);
  });

  it("needs the device's own bearer: no or wrong credential is 401, no device header 400", async () => {
    expect((await call("POST", A, { token: null })).status).toBe(401);
    expect((await call("POST", A, { token: w.tokens[B]! })).status).toBe(401);
    expect((await call("POST", null, { token: w.tokens[A]! })).status).toBe(
      400,
    );
    expect(await rows()).toHaveLength(0);
  });

  it("answers 403 account_required for a device with no sign-in binding", async () => {
    w.tokens[C] = await activate(w, w.key, C);
    const res = await call("POST", C);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "account_required",
    );
    expect(await rows()).toHaveLength(0);
  });
});

describe("the gate", () => {
  it("POST is 404 not_found with the launch gate off, unset or runtime, and mints and bumps nothing", async () => {
    const own = await enrol(A);
    for (const v of ["off", undefined, "runtime"]) {
      gate(v);
      const res = await call("POST", A, { body: { restoreId: own.restoreId } });
      expect(res.status, String(v)).toBe(404);
      const fresh = await call("POST", B);
      expect(fresh.status, String(v)).toBe(404);
    }
    const left = await rows();
    expect(left).toHaveLength(1);
    expect(left[0]!.checked_at).toBe(NOW);
  });

  it("POST is 404 with the product setting off", async () => {
    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.restore', 'false', 'manifest', ?, 'test')`,
      SLUG,
      NOW,
    );
    expect((await call("POST", A)).status).toBe(404);
    expect(await rows()).toHaveLength(0);
  });

  it("POST is 404 with Identity off, like any identity route", async () => {
    await enable(w.db, ["license"]);
    expect((await call("POST", A)).status).toBe(404);
  });

  it("DELETE answers 204 and deletes the key whatever the gate or the setting say", async () => {
    for (const v of ["off", undefined, "runtime", "on"]) {
      gate("on");
      await enrol(A);
      expect(await rows()).toHaveLength(1);
      gate(v);
      const res = await call("DELETE", A);
      expect(res.status, String(v)).toBe(204);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
      expect(await rows(), String(v)).toHaveLength(0);
    }
    gate("on");
    await enrol(A);
    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.restore', 'false', 'manifest', ?, 'test')`,
      SLUG,
      NOW,
    );
    expect((await call("DELETE", A)).status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });
});

describe("DELETE", () => {
  it("is idempotent, touches only this device's key, and still needs the device bearer", async () => {
    const b = await enrol(B);
    expect((await call("DELETE", A)).status).toBe(204);
    expect((await call("DELETE", A)).status).toBe(204);
    expect((await rows()).map((r) => r.id)).toEqual([b.restoreId]);
    expect((await call("DELETE", A, { token: null })).status).toBe(401);
    expect((await call("DELETE", B, { token: w.tokens[A]! })).status).toBe(401);
    expect(await rows()).toHaveLength(1);
  });

  it("another method is 405", async () => {
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/restore`, {
        method: "GET",
        headers: { authorization: `Bearer ${w.tokens[A]}`, "x-pkey-device": A },
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(405);
  });
});

describe("rate limits", () => {
  it("enrolment is 10 a day per device, then 429 rate_limited, and the day bucket fails closed", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await call("POST", A);
      expect(r.status, `call ${i}`).toBe(201);
    }
    const over = await call("POST", A);
    expect(over.status).toBe(429);
    // Another device has its own budget.
    expect((await call("POST", B)).status).toBe(201);
  });

  it("enrolment is 20 a minute per client network, counted before the bearer is read", async () => {
    // Requests with no credential still spend the network's budget: it guards the lookups.
    for (let i = 0; i < 20; i++)
      expect((await call("POST", A, { token: null })).status, `call ${i}`).toBe(
        401,
      );
    const over = await call("POST", A, { token: null });
    expect(over.status).toBe(429);
    expect(
      ((await over.json()) as { error: { code: string } }).error.code,
    ).toBe("rate_limited");
  });
});

describe("discovery", () => {
  const discovery = async () => {
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/.well-known/polaris.json`),
      w.env,
      w.db,
      NOW,
    );
    return (
      (await res.json()) as {
        services: { identity: Record<string, unknown> };
      }
    ).services.identity as {
      restore?: true;
      endpoints: Record<string, string>;
    };
  };

  it("names restore and its endpoint while Identity, the setting and the gate all allow it", async () => {
    const id = await discovery();
    expect(id.restore).toBe(true);
    expect(id.endpoints.restore).toBe(`${BASE}/${SLUG}/identity/restore`);
  });

  it("omits both with the gate off or the setting off", async () => {
    gate("off");
    let id = await discovery();
    expect(id.restore).toBeUndefined();
    expect(id.endpoints.restore).toBeUndefined();
    gate("on");
    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.restore', 'false', 'manifest', ?, 'test')`,
      SLUG,
      NOW,
    );
    id = await discovery();
    expect(id.restore).toBeUndefined();
    expect(id.endpoints.restore).toBeUndefined();
  });
});
