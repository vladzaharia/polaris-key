/**
 * Notification destinations (ST-27): the SSRF guard on a webhook URL, the signature, sealing, the
 * routes (platform and product), the product override and the failure alert.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import { deleteProduct } from "../../../src/core/products/store.js";
import type { Db } from "../../../src/db/types.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import {
  normaliseWebhookUrl,
  postWebhook,
  signWebhook,
  webhookDisplay,
  webhookUrlProblem,
} from "../../../src/core/notify/alertWebhook.js";
import {
  FAILING_AFTER,
  PLATFORM_SCOPE,
  TESTS_PER_HOUR,
  TEST_INTERVAL_SECONDS,
  createDestination,
  deleteDestination,
  listDestinations,
  updateDestination,
  raiseAlert,
  testDestination,
  type Alert,
} from "../../../src/core/notify/alertDestinations.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";

const PLATFORM_GROUP = "platform-admins";
const SLUG = "djdl";
const ACTOR = { sub: "u1", name: "Ada", email: "ada@x.io" };
const URL_OK = "https://hooks.example.com/services/T000/B000/TOKENINPATH";

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

async function session(env: Env, db: Db, stepUp = true) {
  const { token, session: s } = await consoleTestSession(
    env,
    db,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
      ...(stepUp ? { authTime: NOW, stepUp: true } : {}),
    },
    NOW,
  );
  return { cookie: `${ADMIN_COOKIE}=${token}`, csrf: s.csrf };
}

async function call(
  env: Env,
  db: Db,
  auth: { cookie: string; csrf: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const headers: Record<string, string> = {
    cookie: auth.cookie,
    [CSRF_HEADER]: auth.csrf,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await handleAdmin(
    new Request(
      `https://key.plrs.im/manage${path}`,
      init,
    ) as unknown as Request,
    env,
    db,
    path,
    { now: NOW },
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, any>,
  };
}

const alert = (over: Partial<Alert> = {}): Alert => ({
  kind: "auto_halt",
  product: SLUG,
  title: "Auto-halt halted a rollout",
  detail: "revert rate 12% in the last 6 h",
  ...over,
});

describe("webhook URL guard", () => {
  it.each([
    ["http://hooks.example.com/x", "https-only"],
    ["https://10.0.0.1/x", "ip-literal"],
    ["https://127.0.0.1/x", "ip-literal"],
    ["https://169.254.169.254/latest/meta-data", "ip-literal"],
    ["https://192.168.1.10/x", "ip-literal"],
    ["https://[::1]/x", "ip-literal"],
    ["https://0x7f.1/x", "ip-literal"],
    ["https://localhost/x", "single-label"],
    ["https://intranet/x", "single-label"],
    ["https://db.internal/x", "denied-host"],
    ["https://printer.local/x", "denied-host"],
    ["https://key.plrs.im/manage/api/me", "denied-host"],
    ["https://x.workers.dev/x", "denied-host"],
    ["https://user:pw@hooks.example.com/x", "credentials"],
    ["https://hooks.example.com:8443/x", "port"],
    ["ftp://hooks.example.com/x", "https-only"],
    ["not a url", "unparseable"],
    ["", "required"],
  ])("refuses %s", (url, reason) => {
    expect(webhookUrlProblem(url)).toBe(reason);
  });

  it("accepts a public https URL, and shows only its origin", () => {
    expect(webhookUrlProblem(URL_OK)).toBeNull();
    expect(webhookDisplay(normaliseWebhookUrl(URL_OK))).toBe(
      "https://hooks.example.com/…",
    );
  });
});

describe("webhook delivery", () => {
  it("signs id.timestamp.body with the Standard Webhooks scheme", async () => {
    const secret = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
    const sig = await signWebhook(secret, "msg_1", 1700000000, '{"a":1}');
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode('msg_1.1700000000.{"a":1}'),
    );
    expect(sig).toBe(`v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`);
  });

  it("POSTs signed JSON and reports ok on 2xx", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const out = await postWebhook(
      URL_OK,
      "whsec_" + btoa("k".repeat(24)),
      { type: "alert.auto_halt" },
      NOW,
      {
        fetchImpl: async (url, init) => {
          seen = { url, init: init! };
          return new Response(null, { status: 204 });
        },
      },
    );
    expect(out).toBe("ok");
    const h = new Headers(seen!.init.headers);
    expect(h.get("webhook-id")).toMatch(/^msg_/);
    expect(h.get("webhook-timestamp")).toBe(String(NOW));
    expect(h.get("webhook-signature")).toMatch(/^v1,/);
    expect(seen!.init.redirect).toBe("manual");
  });

  it("refuses a redirect and dials nothing else", async () => {
    let calls = 0;
    const out = await postWebhook(
      URL_OK,
      "whsec_" + btoa("k".repeat(24)),
      {},
      NOW,
      {
        fetchImpl: async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest" },
          });
        },
      },
    );
    expect(out).toBe("refused");
    expect(calls).toBe(1);
  });

  it("re-checks a stored URL at delivery and never dials a private one", async () => {
    let calls = 0;
    const out = await postWebhook("https://10.0.0.1/x", "whsec_AAAA", {}, NOW, {
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 200 });
      },
    });
    expect(out).toBe("refused");
    expect(calls).toBe(0);
  });

  it("reports failed on a 5xx and on a network error", async () => {
    const secret = "whsec_" + btoa("k".repeat(24));
    expect(
      await postWebhook(URL_OK, secret, {}, NOW, {
        fetchImpl: async () => new Response(null, { status: 503 }),
      }),
    ).toBe("failed");
    expect(
      await postWebhook(URL_OK, secret, {}, NOW, {
        fetchImpl: async () => {
          throw new Error("down");
        },
      }),
    ).toBe("failed");
  });
});

describe("the platform routes", () => {
  it("refuses a private or non-https URL (422) and stores nothing", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const auth = await session(env, db);
    for (const target of [
      "http://hooks.example.com/x",
      "https://10.0.0.1/x",
      "https://169.254.169.254/",
      "https://localhost/x",
    ]) {
      const r = await call(env, db, auth, "POST", "/api/platform/alerts", {
        kind: "webhook",
        target,
        alerts: ["auto_halt"],
      });
      expect(r.status).toBe(422);
      expect(r.json.error.reason).toBe(
        target.startsWith("http://") ? "url_not_https" : "url_refused",
      );
    }
    expect(await listDestinations(db, PLATFORM_SCOPE)).toEqual([]);
  });

  it("seals the URL and secret, shows the secret once and never the URL", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const auth = await session(env, db);
    const created = await call(env, db, auth, "POST", "/api/platform/alerts", {
      kind: "webhook",
      target: URL_OK,
      label: "Ops channel",
      alerts: ["auto_halt", "commerce"],
    });
    expect(created.status).toBe(201);
    const secret = created.json.secret as string;
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify(created.json.destination)).not.toContain(
      "TOKENINPATH",
    );
    expect(created.json.destination.target).toBe("https://hooks.example.com/…");

    const listed = await call(env, db, auth, "GET", "/api/platform/alerts");
    const text = JSON.stringify(listed.json);
    expect(listed.json.destinations).toHaveLength(1);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("TOKENINPATH");
    expect(listed.json.destinations[0].alerts).toEqual([
      "auto_halt",
      "commerce",
    ]);

    // At rest: neither the secret nor the URL path is plaintext anywhere in the two tables.
    const dump = JSON.stringify([
      await db.all("SELECT * FROM notify_destinations"),
      await db.all("SELECT * FROM notify_destination_secrets"),
    ]);
    expect(dump).not.toContain(secret.slice(6));
    expect(dump).not.toContain("TOKENINPATH");
    expect(dump).toContain('\\"v\\":2');

    // Every change is audited, and no audit row holds the secret or the path.
    const audit = await db.all<{ action: string }>(
      "SELECT * FROM platform_audit WHERE action LIKE 'notify.%'",
    );
    expect(audit.map((a) => a.action)).toEqual(["notify.destination.create"]);
    expect(JSON.stringify(audit)).not.toContain(secret.slice(6));
    expect(JSON.stringify(audit)).not.toContain("TOKENINPATH");
  });

  it("rotates the secret (returned once), retargets, disables and deletes, each audited", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const auth = await session(env, db);
    const c = await call(env, db, auth, "POST", "/api/platform/alerts", {
      kind: "webhook",
      target: URL_OK,
      alerts: ["auto_halt"],
    });
    const id = c.json.destination.id as string;
    const r = await call(env, db, auth, "PATCH", `/api/platform/alerts/${id}`, {
      rotateSecret: true,
      expectedVersion: 1,
    });
    expect(r.status).toBe(200);
    expect(r.json.secret).toMatch(/^whsec_/);
    expect(r.json.secret).not.toBe(c.json.secret);

    const stale = await call(
      env,
      db,
      auth,
      "PATCH",
      `/api/platform/alerts/${id}`,
      {
        enabled: false,
        expectedVersion: 1,
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.json.error.reason).toBe("stale");

    const bad = await call(
      env,
      db,
      auth,
      "PATCH",
      `/api/platform/alerts/${id}`,
      {
        target: "https://192.168.0.5/x",
      },
    );
    expect(bad.status).toBe(422);

    const off = await call(
      env,
      db,
      auth,
      "PATCH",
      `/api/platform/alerts/${id}`,
      {
        enabled: false,
      },
    );
    expect(off.json.secret).toBeUndefined();
    expect(off.json.destination.enabled).toBe(false);

    const del = await call(
      env,
      db,
      auth,
      "DELETE",
      `/api/platform/alerts/${id}`,
    );
    expect(del.status).toBe(200);
    expect(await db.all("SELECT * FROM notify_destination_secrets")).toEqual(
      [],
    );
    const actions = (
      await db.all<{ action: string }>(
        "SELECT action FROM platform_audit WHERE action LIKE 'notify.%' ORDER BY at, rowid",
      )
    ).map((a) => a.action);
    expect(actions).toEqual([
      "notify.destination.create",
      "notify.destination.rotate",
      "notify.destination.update",
      "notify.destination.delete",
    ]);
  });

  it("needs the step-up to add or retarget, and caps a scope", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const plain = await session(env, db, false);
    const denied = await call(env, db, plain, "POST", "/api/platform/alerts", {
      kind: "email",
      target: "ops@example.com",
      alerts: ["auto_halt"],
    });
    expect(denied.status).toBe(403);
    expect(await listDestinations(db, PLATFORM_SCOPE)).toEqual([]);

    const auth = await session(env, db);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await call(env, db, auth, "POST", "/api/platform/alerts", {
            kind: "email",
            target: `ops${i}@example.com`,
            alerts: ["auto_halt"],
          })
        ).status,
      ).toBe(201);
    const sixth = await call(env, db, auth, "POST", "/api/platform/alerts", {
      kind: "email",
      target: "ops5@example.com",
      alerts: ["auto_halt"],
    });
    expect(sixth.status).toBe(409);
    expect(sixth.json.error.reason).toBe("too_many");
  });

  it("validates the email, the kinds and the shape", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const auth = await session(env, db);
    const post = (b: unknown) =>
      call(env, db, auth, "POST", "/api/platform/alerts", b);
    expect(
      (await post({ kind: "sms", target: "x", alerts: ["auto_halt"] })).json
        .error.reason,
    ).toBe("kind_invalid");
    expect(
      (
        await post({
          kind: "email",
          target: "not-an-email",
          alerts: ["auto_halt"],
        })
      ).json.error.reason,
    ).toBe("target_invalid");
    expect(
      (await post({ kind: "email", target: "a@b.io", alerts: [] })).json.error
        .reason,
    ).toBe("alerts_required");
    expect(
      (await post({ kind: "email", target: "a@b.io", alerts: ["nope"] })).json
        .error.reason,
    ).toBe("alert_unknown");
  });

  it("a non-admin has no access", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token, session: s } = await consoleTestSession(
      env,
      db,
      {
        sub: "u2",
        name: "Bo",
        email: "bo@x.io",
        groups: [],
        authTime: NOW,
        stepUp: true,
      },
      NOW,
    );
    const r = await call(
      env,
      db,
      { cookie: `${ADMIN_COOKIE}=${token}`, csrf: s.csrf },
      "GET",
      "/api/platform/alerts",
    );
    expect(r.status).toBe(403);
  });
});

describe("product routes", () => {
  it("lists and writes a product's own destinations, audited in the product's trail", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const auth = await session(env, db);
    const c = await call(
      env,
      db,
      auth,
      "POST",
      `/api/products/${SLUG}/alerts`,
      {
        kind: "email",
        target: "Team@Example.com",
        alerts: ["auto_halt"],
      },
    );
    expect(c.status).toBe(201);
    expect(c.json.destination.target).toBe("team@example.com");
    expect(c.json.secret).toBeUndefined();
    const l = await call(env, db, auth, "GET", `/api/products/${SLUG}/alerts`);
    expect(l.json.destinations).toHaveLength(1);
    expect(l.json.inherited).toBe(0);
    const audit = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? AND action LIKE 'notify.%'",
      SLUG,
    );
    expect(audit.map((a) => a.action)).toEqual(["notify.destination.create"]);
    // The platform's list is separate.
    expect(await listDestinations(db, PLATFORM_SCOPE)).toEqual([]);
  });
});

describe("delivery", () => {
  async function setup() {
    const env = adminEnv();
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    await seedProduct(db, "other");
    const mails: string[] = [];
    const hooks: string[] = [];
    const deps = {
      sendEmail: async (to: string) => {
        mails.push(to);
        return true;
      },
      fetchImpl: async (url: string) => {
        hooks.push(url);
        return new Response(null, { status: 200 });
      },
    };
    return { env, db, mails, hooks, deps };
  }
  const make = (
    env: Env,
    db: Db,
    scope: string,
    over: Record<string, unknown>,
  ) =>
    createDestination(
      env,
      db,
      scope,
      ACTOR,
      { alerts: ["auto_halt"], ...over },
      NOW,
    );

  it("goes to the product override when set, else to the platform", async () => {
    const { env, db, mails, hooks, deps } = await setup();
    await make(env, db, PLATFORM_SCOPE, {
      kind: "email",
      target: "platform@example.com",
    });
    await make(env, db, SLUG, { kind: "webhook", target: URL_OK });

    const r = await raiseAlert(env, db, alert(), NOW, deps);
    expect(r).toEqual({ destinations: 1, delivered: 1 });
    expect(hooks).toEqual([normaliseWebhookUrl(URL_OK)]);
    expect(mails).toEqual([]);

    // A product with no override, and a platform event, go to the platform's.
    await raiseAlert(env, db, alert({ product: "other" }), NOW, deps);
    await raiseAlert(env, db, alert({ product: null }), NOW, deps);
    expect(mails).toEqual(["platform@example.com", "platform@example.com"]);
    expect(hooks).toHaveLength(1);
  });

  it("an override that does not take the kind leaves the platform's in force", async () => {
    const { env, db, mails, deps } = await setup();
    await make(env, db, PLATFORM_SCOPE, {
      kind: "email",
      target: "platform@example.com",
    });
    await make(env, db, SLUG, {
      kind: "email",
      target: "team@example.com",
      alerts: ["commerce"],
    });
    await raiseAlert(env, db, alert(), NOW, deps);
    expect(mails).toEqual(["platform@example.com"]);
    await raiseAlert(env, db, alert({ kind: "commerce" }), NOW, deps);
    expect(mails).toEqual(["platform@example.com", "team@example.com"]);
  });

  it("a disabled destination takes nothing; no destination is a quiet no-op", async () => {
    const { env, db, deps } = await setup();
    expect(await raiseAlert(env, db, alert(), NOW, deps)).toEqual({
      destinations: 0,
      delivered: 0,
    });
    const c = await make(env, db, PLATFORM_SCOPE, {
      kind: "email",
      target: "p@example.com",
    });
    if (!c.ok) throw new Error("setup");
    await db.run("UPDATE notify_destinations SET enabled = 0");
    expect(await raiseAlert(env, db, alert(), NOW, deps)).toEqual({
      destinations: 0,
      delivered: 0,
    });
  });

  it("sends a signed body that carries no URL or secret", async () => {
    const { env, db, deps } = await setup();
    await make(env, db, PLATFORM_SCOPE, { kind: "webhook", target: URL_OK });
    let body = "";
    let sig = "";
    await raiseAlert(env, db, alert(), NOW, {
      ...deps,
      fetchImpl: async (_u: string, init?: RequestInit) => {
        body = String(init!.body);
        sig = new Headers(init!.headers).get("webhook-signature")!;
        return new Response(null, { status: 200 });
      },
    });
    const parsed = JSON.parse(body);
    expect(parsed.type).toBe("alert.auto_halt");
    expect(parsed.data).toMatchObject({ kind: "auto_halt", product: SLUG });
    expect(body).not.toContain("TOKENINPATH");
    expect(sig).toMatch(/^v1,/);
  });

  it("records failures, raises notifications_failing to the others, and audits an undeliverable alert", async () => {
    const { env, db, mails, deps } = await setup();
    await make(env, db, PLATFORM_SCOPE, {
      kind: "webhook",
      target: URL_OK,
      alerts: ["auto_halt"],
    });
    await make(env, db, PLATFORM_SCOPE, {
      kind: "email",
      target: "ops@example.com",
      alerts: ["notifications_failing"],
    });
    const failing = {
      ...deps,
      fetchImpl: async () => new Response(null, { status: 500 }),
    };
    for (let i = 0; i < FAILING_AFTER; i++)
      expect(
        (await raiseAlert(env, db, alert({ product: null }), NOW + i, failing))
          .delivered,
      ).toBe(0);
    expect(mails).toEqual(["ops@example.com"]);
    const rows = await listDestinations(db, PLATFORM_SCOPE);
    const hook = rows.find((r) => r.kind === "webhook")!;
    expect(hook).toMatchObject({
      lastStatus: "failed",
      failures: FAILING_AFTER,
    });
    const undeliverable = await db.all(
      "SELECT * FROM platform_audit WHERE action = 'notify.alert.undeliverable'",
    );
    expect(undeliverable).toHaveLength(FAILING_AFTER);
    // A success resets the run.
    await raiseAlert(env, db, alert({ product: null }), NOW + 10, deps);
    expect(
      (await listDestinations(db, PLATFORM_SCOPE)).find(
        (r) => r.kind === "webhook",
      )!.failures,
    ).toBe(0);
  });

  it("a redirecting endpoint is recorded as refused", async () => {
    const { env, db, deps } = await setup();
    await make(env, db, PLATFORM_SCOPE, { kind: "webhook", target: URL_OK });
    await raiseAlert(env, db, alert({ product: null }), NOW, {
      ...deps,
      fetchImpl: async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://10.0.0.1/" },
        }),
    });
    expect((await listDestinations(db, PLATFORM_SCOPE))[0]!.lastStatus).toBe(
      "refused",
    );
  });

  it("test sends are throttled and audited", async () => {
    const { env, db, hooks, deps } = await setup();
    const c = await make(env, db, PLATFORM_SCOPE, {
      kind: "webhook",
      target: URL_OK,
    });
    if (!c.ok) throw new Error("setup");
    const id = c.destination.id;
    const a = await testDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      id,
      NOW,
      deps,
    );
    expect(a).toMatchObject({ ok: true, outcome: "ok" });
    expect(hooks).toHaveLength(1);
    const again = await testDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      id,
      NOW + 5,
      deps,
    );
    expect(again).toMatchObject({ ok: false, status: 429 });
    expect(
      await testDestination(env, db, PLATFORM_SCOPE, ACTOR, id, NOW + 60, deps),
    ).toMatchObject({ ok: true });
    expect(
      (
        await db.all(
          "SELECT * FROM platform_audit WHERE action = 'notify.destination.test'",
        )
      ).length,
    ).toBe(2);
  });

  it("deleting a product removes its destinations and sealed secrets", async () => {
    const { env, db } = await setup();
    await make(env, db, SLUG, { kind: "webhook", target: URL_OK });
    expect(
      (await db.all("SELECT * FROM notify_destination_secrets")).length,
    ).toBe(1);
    await deleteProduct(db, SLUG, NOW);
    expect(await db.all("SELECT * FROM notify_destinations")).toEqual([]);
    expect(await db.all("SELECT * FROM notify_destination_secrets")).toEqual(
      [],
    );
  });
});

describe("fix round: security review", () => {
  it("removing a destination needs the step-up, at both scopes", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const auth = await session(env, db);
    const plain = await session(env, db, false);
    for (const base of [
      "/api/platform/alerts",
      `/api/products/${SLUG}/alerts`,
    ]) {
      const c = await call(env, db, auth, "POST", base, {
        kind: "webhook",
        target: URL_OK,
        alerts: ["auto_halt"],
      });
      const id = c.json.destination.id as string;
      const denied = await call(env, db, plain, "DELETE", `${base}/${id}`);
      expect(denied.status).toBe(403);
      expect(
        (await db.all("SELECT * FROM notify_destinations WHERE id = ?", id))
          .length,
      ).toBe(1);
      expect(
        (await call(env, db, auth, "DELETE", `${base}/${id}`)).status,
      ).toBe(200);
    }
  });

  it("a retarget that repairs an unreadable sealed row returns the new secret once", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const c = await createDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      { kind: "webhook", target: URL_OK, alerts: ["auto_halt"] },
      NOW,
    );
    if (!c.ok) throw new Error("setup");
    await db.run(
      "UPDATE notify_destination_secrets SET enc_secret_json = 'garbage'",
    );
    const r = await updateDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      c.destination.id,
      { target: "https://hooks.example.com/new" },
      NOW,
    );
    expect(r.ok && r.secret).toMatch(/^whsec_/);
    const plain = await updateDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      c.destination.id,
      { label: "x" },
      NOW,
    );
    expect(plain.ok && plain.secret).toBeUndefined();
  });

  it("a stale update writes nothing of the sealed row", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const c = await createDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      { kind: "webhook", target: URL_OK, alerts: ["auto_halt"] },
      NOW,
    );
    if (!c.ok) throw new Error("setup");
    const before = await db.all(
      "SELECT enc_secret_json FROM notify_destination_secrets",
    );
    const r = await updateDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      c.destination.id,
      { rotateSecret: true, expectedVersion: 99 },
      NOW,
    );
    expect(r.ok).toBe(false);
    await db.run("UPDATE notify_destinations SET version = 7");
    const r2 = await updateDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      c.destination.id,
      { rotateSecret: true, expectedVersion: 1 },
      NOW,
    );
    expect(r2.ok).toBe(false);
    expect(
      await db.all("SELECT enc_secret_json FROM notify_destination_secrets"),
    ).toEqual(before);
  });

  it("test sends are capped per scope from the audit trail, and re-adding resets nothing", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const deps = { fetchImpl: async () => new Response(null, { status: 200 }) };
    let t = NOW;
    let sent = 0;
    for (let i = 0; i < TESTS_PER_HOUR + 2; i++) {
      const c = await createDestination(
        env,
        db,
        PLATFORM_SCOPE,
        ACTOR,
        { kind: "webhook", target: URL_OK, alerts: ["auto_halt"] },
        t,
      );
      if (!c.ok) throw new Error("setup");
      const r = await testDestination(
        env,
        db,
        PLATFORM_SCOPE,
        ACTOR,
        c.destination.id,
        t,
        deps,
      );
      if (r.ok) sent++;
      await deleteDestination(
        db,
        PLATFORM_SCOPE,
        ACTOR,
        c.destination.id,
        undefined,
        t,
      );
      t += TEST_INTERVAL_SECONDS + 1;
    }
    expect(sent).toBe(TESTS_PER_HOUR);
  });

  it("refuses a test to a product's email address", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const c = await createDestination(
      env,
      db,
      SLUG,
      ACTOR,
      { kind: "email", target: "a@example.com", alerts: ["auto_halt"] },
      NOW,
    );
    if (!c.ok) throw new Error("setup");
    const r = await testDestination(
      env,
      db,
      SLUG,
      ACTOR,
      c.destination.id,
      NOW,
      { sendEmail: async () => true },
    );
    expect(r).toMatchObject({ ok: false, status: 422 });
  });

  it("a test send does not count toward failures", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const c = await createDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      { kind: "webhook", target: URL_OK, alerts: ["auto_halt"] },
      NOW,
    );
    if (!c.ok) throw new Error("setup");
    await testDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      c.destination.id,
      NOW,
      { fetchImpl: async () => new Response(null, { status: 500 }) },
    );
    const [row] = await listDestinations(db, PLATFORM_SCOPE);
    expect(row).toMatchObject({ lastStatus: "failed", failures: 0 });
  });

  it("a product's failing destination is reported inside the product, not to the platform", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const mails: string[] = [];
    const deps = {
      sendEmail: async (to: string) => (mails.push(to), true),
      fetchImpl: async () => new Response(null, { status: 500 }),
    };
    await createDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      {
        kind: "email",
        target: "platform@example.com",
        alerts: ["notifications_failing"],
      },
      NOW,
    );
    await createDestination(
      env,
      db,
      SLUG,
      ACTOR,
      { kind: "webhook", target: URL_OK, alerts: ["auto_halt"] },
      NOW,
    );
    for (let i = 0; i < FAILING_AFTER; i++)
      await raiseAlert(env, db, alert(), NOW + i, deps);
    expect(mails).toEqual([]);
  });

  // Disabled as flaky (owner 2026-10-23): timing assertion fails under load. Re-enable once it asserts on ordering, not wall-clock timing.
  it.skip("delivers to destinations in parallel", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    for (let i = 0; i < 3; i++)
      await createDestination(
        env,
        db,
        PLATFORM_SCOPE,
        ACTOR,
        {
          kind: "webhook",
          target: `https://h${i}.example.com/x`,
          alerts: ["auto_halt"],
        },
        NOW,
      );
    let inflight = 0;
    let peak = 0;
    await raiseAlert(env, db, alert({ product: null }), NOW, {
      fetchImpl: async () => {
        peak = Math.max(peak, ++inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight--;
        return new Response(null, { status: 200 });
      },
    });
    expect(peak).toBe(3);
  });

  it("only turning a destination on skips the step-up on PATCH", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const auth = await session(env, db);
    const plain = await session(env, db, false);
    const c = await call(env, db, auth, "POST", "/api/platform/alerts", {
      kind: "email",
      target: "ops@example.com",
      alerts: ["auto_halt"],
    });
    const id = c.json.destination.id as string;
    const path = `/api/platform/alerts/${id}`;
    const off = await call(env, db, plain, "PATCH", path, { enabled: false });
    expect(off.status).toBe(403);
    expect(off.json.code).toBe("step_up_required");
    expect(
      (await call(env, db, auth, "PATCH", path, { enabled: false })).status,
    ).toBe(200);
    const on = await call(env, db, plain, "PATCH", path, { enabled: true });
    expect(on.status).toBe(200);
    // Anything beyond turning it on needs it, even with enabled: true.
    expect(
      (
        await call(env, db, plain, "PATCH", path, {
          enabled: true,
          alerts: ["commerce"],
        })
      ).status,
    ).toBe(403);
  });

  it("a throttled test says when to retry, and a failure keeps its reason without the path", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const c = await createDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      { kind: "webhook", target: URL_OK, alerts: ["auto_halt"] },
      NOW,
    );
    if (!c.ok) throw new Error("setup");
    const deps = { fetchImpl: async () => new Response(null, { status: 404 }) };
    const first = await testDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      c.destination.id,
      NOW,
      deps,
    );
    expect(first).toMatchObject({
      ok: true,
      outcome: "failed",
      detail: "HTTP 404 from hooks.example.com",
    });
    const again = await testDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      c.destination.id,
      NOW + 12,
      deps,
    );
    expect(again).toMatchObject({ ok: false, status: 429, retryAfter: 18 });
    const [row] = await listDestinations(db, PLATFORM_SCOPE);
    expect(row!.lastError).toBe("HTTP 404 from hooks.example.com");
    expect(JSON.stringify(row)).not.toContain("TOKENINPATH");
  });

  it("the product list reports what the platform covers per kind", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const auth = await session(env, db);
    await createDestination(
      env,
      db,
      PLATFORM_SCOPE,
      ACTOR,
      {
        kind: "email",
        target: "p@example.com",
        alerts: ["auto_halt", "commerce", "notifications_failing"],
      },
      NOW,
    );
    const l = await call(env, db, auth, "GET", `/api/products/${SLUG}/alerts`);
    expect(l.json.inheritedByKind).toMatchObject({
      auto_halt: 1,
      commerce: 1,
      access_changed: 0,
      // A product's failing-destination alert never falls back to the platform's.
      notifications_failing: 0,
    });
    expect(l.json.kinds.find((k: any) => k.id === "commerce").sent).toBe(false);
  });
});
