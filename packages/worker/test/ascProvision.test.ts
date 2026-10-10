/**
 * A-17c — the product app setup API (`connectors/asc/provision.ts`) through the real admin API,
 * against fakes only (no live Apple call from a test):
 *
 *   - the App Store Server Notifications URL: the four attributes, on the pinned app, at the
 *     request's own origin; Apple's A-17h behaviour (PATCH 200, not persisted) answers the
 *     deep-link fallback after the verification read; verify, replay and "already set";
 *   - the test-notification round trip on the App Store Server API, with the hook's stored TEST;
 *   - internal and external beta groups; testers added with no email stored anywhere;
 *   - the free price and all-territory availability defaults, only while none exists;
 *   - the portal checklist; the progress view; the platform-pin path of the New-app wizard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AscResource } from "../src/core/asc/client.js";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import { setPlatformPin } from "../src/core/platformCredentials.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { APP_STORE_EVENTS } from "../src/services/distribution/commerce/index.js";
import { CONSOLE } from "./releaseRoutesFixture.js";
import {
  APPLE_ID,
  NOW,
  SLUG,
  ascP8,
  ascWorld,
  audits,
  type AscWorld,
} from "./ascWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const ASN_URL = `${CONSOLE}/${SLUG}/distribution/hooks/app-store`;
const BUNDLE = "gg.acme.djdl";

interface Req {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

interface Tester {
  id: string;
  email: string;
  apps: Set<string>;
  groups: Set<string>;
}

/**
 * The provisioning routes in front of P5-02's `AscFake`, plus the App Store Server API's test
 * notification endpoints. Every request to either host is logged.
 */
class SetupFake {
  readonly log: Req[] = [];
  /** A-17h: Apple answers the PATCH 200 with an echo but does not keep it. */
  asnPersists = false;
  /** Once a PATCH lands, every read of the app answers 503 (the verification read fails). */
  failAppReadAfterPatch = false;
  private appReadBroken = false;
  groups: AscResource[] = [];
  testers: Tester[] = [];
  availability: AscResource | null = null;
  schedule: AscResource | null = null;
  territories = ["USA", "GBR", "DEU"];
  /** The App Store Server API answer to "request a test notification". */
  testStatus: 200 | 404 = 200;
  private n = 1;

  constructor(private readonly w: AscWorld) {
    this.groups.push(structuredClone(w.fake.get("betaGroups", "bg-public")));
  }

  writes(): Req[] {
    return this.log.filter((r) => r.method !== "GET");
  }

  private json(status: number, body: unknown): Response {
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "X-Rate-Limit": "user-hour-lim:3600;user-hour-rem:3000;",
      },
    });
  }

  fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const isAsc = url.hostname === "api.appstoreconnect.apple.com";
    const isStoreKit = /^api\.storekit(-sandbox)?\.apple\.com$/.test(
      url.hostname,
    );
    if (isAsc || isStoreKit)
      this.log.push({
        method,
        host: url.hostname,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
      });
    if (isStoreKit) return this.storeKit(method, url);
    if (isAsc) {
      const own = this.route(method, url, body);
      if (own) return own;
    }
    return this.w.fetchImpl(input, init);
  };

  private storeKit(method: string, url: URL): Response {
    if (method === "POST" && url.pathname === "/inApps/v1/notifications/test")
      return this.testStatus === 404
        ? this.json(404, { errorCode: 4040010, errorMessage: "not found" })
        : this.json(200, { testNotificationToken: "tok-1_1760000000000" });
    if (
      method === "GET" &&
      url.pathname === "/inApps/v1/notifications/test/tok-1_1760000000000"
    )
      return this.json(200, {
        signedPayload: "x.y.z",
        sendAttempts: [
          { attemptDate: NOW * 1000, sendAttemptResult: "SUCCESS" },
        ],
      });
    return this.json(404, { errorCode: 4040008 });
  }

  private route(method: string, url: URL, body: unknown): Response | null {
    const p = url.pathname;
    const q = url.searchParams;
    const data = (body as { data?: Record<string, unknown> } | undefined)?.data;
    const app = this.w.fake.get("apps", APPLE_ID);
    if (p === `/v1/apps/${APPLE_ID}` && method === "PATCH") {
      const attrs = data?.attributes as Record<string, unknown>;
      if (this.asnPersists) this.w.fake.set("apps", APPLE_ID, attrs);
      if (this.failAppReadAfterPatch) this.appReadBroken = true;
      return this.json(200, {
        data: { ...app, attributes: { ...app.attributes, ...attrs } },
      });
    }
    if (p === `/v1/apps/${APPLE_ID}` && method === "GET" && this.appReadBroken)
      return this.json(503, {
        errors: [{ status: "503", code: "SERVICE_UNAVAILABLE" }],
      });
    if (p === `/v1/apps/${APPLE_ID}/betaGroups` && method === "GET")
      return this.json(200, { data: this.groups, links: {} });
    if (p === "/v1/betaGroups" && method === "POST") {
      const g: AscResource = {
        type: "betaGroups",
        id: `bg-new-${this.n++}`,
        attributes: { ...(data?.attributes as Record<string, unknown>) },
        relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
      };
      this.groups.push(g);
      this.w.fake.put(g);
      return this.json(201, { data: g });
    }
    if (p === "/v1/betaTesters" && method === "GET") {
      const email = q.get("filter[email]");
      const group = q.get("filter[betaGroups]");
      const appId = q.get("filter[apps]");
      const hits = this.testers.filter(
        (t) =>
          t.email === email &&
          (!group || t.groups.has(group)) &&
          (!appId || t.apps.has(appId)),
      );
      return this.json(200, {
        data: hits.map((t) => this.tester(t)),
        links: {},
      });
    }
    if (p === "/v1/betaTesters" && method === "POST") {
      const attrs = data?.attributes as { email: string };
      if (attrs.email.endsWith("@blocked.example"))
        return this.json(409, {
          errors: [{ status: "409", code: "ENTITY_ERROR.ATTRIBUTE.INVALID" }],
        });
      const rels = data?.relationships as {
        betaGroups: { data: { id: string }[] };
      };
      const t: Tester = {
        id: `bt-${this.n++}`,
        email: attrs.email,
        apps: new Set([APPLE_ID]),
        groups: new Set(rels.betaGroups.data.map((g) => g.id)),
      };
      this.testers.push(t);
      return this.json(201, { data: this.tester(t) });
    }
    const link = /^\/v1\/betaGroups\/([^/]+)\/relationships\/betaTesters$/.exec(
      p,
    );
    if (link && method === "POST") {
      for (const ident of (body as { data: { id: string }[] }).data)
        this.testers.find((t) => t.id === ident.id)?.groups.add(link[1]!);
      return this.json(204, null);
    }
    const one = /^\/v1\/betaTesters\/([^/]+)$/.exec(p);
    if (one && method === "GET") {
      const t = this.testers.find((x) => x.id === one[1]);
      return t
        ? this.json(200, { data: this.tester(t) })
        : this.json(404, null);
    }
    if (p === `/v1/apps/${APPLE_ID}/appAvailabilityV2` && method === "GET")
      return this.availability
        ? this.json(200, { data: this.availability })
        : this.json(404, { errors: [{ status: "404", code: "NOT_FOUND" }] });
    if (p === "/v1/territories" && method === "GET")
      return this.json(200, {
        data: this.territories.map((id) => ({
          type: "territories",
          id,
          attributes: { currency: "USD" },
        })),
        links: {},
      });
    if (p === "/v2/appAvailabilities" && method === "POST") {
      this.availability = {
        type: "appAvailabilities",
        id: APPLE_ID,
        attributes: { availableInNewTerritories: true },
      };
      return this.json(201, { data: this.availability });
    }
    if (p === `/v1/apps/${APPLE_ID}/appPriceSchedule` && method === "GET")
      return this.schedule
        ? this.json(200, { data: this.schedule })
        : this.json(404, { errors: [{ status: "404", code: "NOT_FOUND" }] });
    if (p === `/v1/apps/${APPLE_ID}/appPricePoints` && method === "GET")
      return this.json(200, {
        data: [
          {
            type: "appPricePoints",
            id: "pp-099",
            attributes: { customerPrice: "0.99" },
          },
          {
            type: "appPricePoints",
            id: "pp-free",
            attributes: { customerPrice: "0.0" },
          },
        ],
        links: {},
      });
    if (p === "/v1/appPriceSchedules" && method === "POST") {
      this.schedule = {
        type: "appPriceSchedules",
        id: APPLE_ID,
        relationships: {
          baseTerritory: { data: { type: "territories", id: "USA" } },
          manualPrices: { data: [{ type: "appPrices", id: "ap-1" }] },
        },
      };
      return this.json(201, { data: this.schedule });
    }
    return null;
  }

  private tester(t: Tester): AscResource {
    return {
      type: "betaTesters",
      id: t.id,
      attributes: {
        email: t.email,
        firstName: "Secret",
        lastName: "Person",
        inviteType: "EMAIL",
        state: "INVITED",
      },
    };
  }
}

interface World extends AscWorld {
  setup: SetupFake;
}

async function world(
  opts: Parameters<typeof ascWorld>[0] = {},
): Promise<World> {
  const w = await ascWorld(opts);
  return { ...w, setup: new SetupFake(w) };
}

let keyN = 0;
const freshKey = () =>
  `11111111-2222-4333-8444-${String(++keyN).padStart(12, "0")}`;

/** The admin API as a platform admin, with an Idempotency-Key unless `key: null`. */
async function call(
  w: World,
  path: string,
  body: Record<string, unknown> = {},
  key: string | null = freshKey(),
  method = "POST",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution/connectors/asc${path}`;
  const saved = globalThis.fetch;
  globalThis.fetch = w.setup.fetchImpl as typeof fetch;
  try {
    const res = await handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
          ...(key !== null ? { "Idempotency-Key": key } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
      w.env,
      w.db,
      full,
      { now: NOW },
    );
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  } finally {
    globalThis.fetch = saved;
  }
}

async function setupAudits(w: World) {
  return (await audits(w.db)).filter((a) =>
    a.action.startsWith("distribution.asc."),
  );
}

async function ledger(w: World) {
  return w.db.all<Record<string, unknown>>(
    "SELECT * FROM store_operations WHERE product = ? ORDER BY created_at, op_id",
    SLUG,
  );
}

// ── The notifications URL ────────────────────────────────────────────────────────────────────

describe("setup/notifications-url", () => {
  it("needs an Idempotency-Key, and sends nothing without one", async () => {
    const w = await world();
    const r = await call(w, "/setup/notifications-url", {}, null);
    expect(r.status).toBe(428);
    expect(r.json.reason).toBe("idempotency_key_required");
    expect(w.setup.log).toEqual([]);
  });

  it("A-17h: PATCHes the four attributes on the pinned app, re-reads, and answers the portal fallback when Apple did not keep them", async () => {
    const w = await world();
    const key = freshKey();
    // A request naming another app is ignored: the app is the setup's.
    const r = await call(
      w,
      "/setup/notifications-url",
      { appleId: "9999999999" },
      key,
    );
    expect(r.status).toBe(200);
    expect(w.setup.writes()).toEqual([
      {
        method: "PATCH",
        host: "api.appstoreconnect.apple.com",
        path: `/v1/apps/${APPLE_ID}`,
        query: {},
        body: {
          data: {
            type: "apps",
            id: APPLE_ID,
            attributes: {
              subscriptionStatusUrl: ASN_URL,
              subscriptionStatusUrlVersion: "V2",
              subscriptionStatusUrlForSandbox: ASN_URL,
              subscriptionStatusUrlVersionForSandbox: "V2",
            },
          },
        },
      },
    ]);
    // The verification read comes after the write.
    expect(w.setup.log.at(-1)).toMatchObject({
      method: "GET",
      path: `/v1/apps/${APPLE_ID}`,
    });
    expect(r.json).toMatchObject({
      outcome: "written",
      appleId: APPLE_ID,
      url: ASN_URL,
      version: "V2",
      persisted: false,
      fallback: {
        deepLink: `https://appstoreconnect.apple.com/apps/${APPLE_ID}/distribution/info`,
        url: ASN_URL,
        version: "V2",
      },
    });
    const rows = await setupAudits(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "distribution.asc.app.notifications_url",
      actor_sub: "u1",
      target_id: APPLE_ID,
    });
    const [row] = await ledger(w);
    expect(row).toMatchObject({ op: "app.notifications_url", state: "done" });
    // The ledger's after is Apple's re-read (null), not the request's intent.
    expect(
      JSON.parse(row!.after_json as string).attributes.subscriptionStatusUrl,
    ).toBeUndefined();

    // A retry under the same key replays: nothing reaches Apple.
    w.setup.log.length = 0;
    const again = await call(w, "/setup/notifications-url", {}, key);
    expect(again.json).toMatchObject({ outcome: "replayed", persisted: false });
    expect(w.setup.log).toEqual([]);
  });

  it("never takes Apple's PATCH echo as proof: a failed verification read, then a replay, still answers not persisted", async () => {
    const w = await world();
    w.setup.failAppReadAfterPatch = true;
    const key = "asn-reread-fails-1";
    const r = await call(w, "/setup/notifications-url", {}, key);
    expect(r.status).toBe(200);
    expect(w.setup.writes()).toHaveLength(1);
    const fallback = {
      deepLink: `https://appstoreconnect.apple.com/apps/${APPLE_ID}/distribution/info`,
      url: ASN_URL,
      version: "V2",
    };
    expect(r.json).toMatchObject({
      outcome: "written",
      persisted: false,
      fallback,
    });
    const [row] = await ledger(w);
    expect(row).toMatchObject({ op: "app.notifications_url", state: "done" });
    // The ledger's after is the pre-read, never the echo of the unsaved URL.
    expect(row!.after_json as string).not.toContain(ASN_URL);
    expect(row!.result_ids_json as string).toContain(APPLE_ID);
    expect(await setupAudits(w)).toHaveLength(1);

    // The console retries after a dropped response: the replay must not claim success.
    w.setup.log.length = 0;
    const again = await call(w, "/setup/notifications-url", {}, key);
    expect(again.json).toMatchObject({
      outcome: "replayed",
      persisted: false,
      fallback,
    });
    expect(w.setup.log).toEqual([]);
  });

  it("answers persisted when Apple keeps the URL, and sends nothing when it is already set", async () => {
    const w = await world();
    w.setup.asnPersists = true;
    const r = await call(w, "/setup/notifications-url");
    expect(r.json).toMatchObject({
      outcome: "written",
      persisted: true,
      fallback: null,
    });
    w.setup.log.length = 0;
    const again = await call(w, "/setup/notifications-url");
    expect(again.json).toMatchObject({ outcome: "existing", persisted: true });
    expect(w.setup.writes()).toEqual([]);
    expect(await setupAudits(w)).toHaveLength(1);
  });

  it("verify: reads the four attributes after the operator pasted them in the portal", async () => {
    const w = await world();
    const before = await call(w, "/setup/notifications-url/verify", {}, null);
    expect(before.json).toMatchObject({
      persisted: false,
      production: { url: null, matches: false },
      sandbox: { url: null, matches: false },
    });
    w.fake.set("apps", APPLE_ID, {
      subscriptionStatusUrl: ASN_URL,
      subscriptionStatusUrlVersion: "V2",
      subscriptionStatusUrlForSandbox: ASN_URL,
      subscriptionStatusUrlVersionForSandbox: "V2",
    });
    const after = await call(w, "/setup/notifications-url/verify", {}, null);
    expect(after.json).toMatchObject({
      persisted: true,
      production: { url: ASN_URL, version: "V2", matches: true },
      fallback: null,
    });
    expect(w.setup.writes()).toEqual([]);
  });

  it("refuses an unpinned key before any request", async () => {
    const w = await world({ pin: null });
    const r = await call(w, "/setup/notifications-url");
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("credential_pin_missing");
    expect(w.setup.log).toEqual([]);
  });
});

// ── The test notification ────────────────────────────────────────────────────────────────────

async function withServerKey(w: World, pin = BUNDLE): Promise<void> {
  const r = await putOutletCredential(w.env, w.db, {
    product: SLUG,
    credentialId: "iap",
    kind: "app-store-server-key",
    outletId: null,
    value: {
      keyId: "IAPKEY1234",
      issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
      p8: ascP8(),
    },
    pin,
    expiresAt: null,
    actor: "admin-1",
    now: NOW,
  });
  if (!r.ok) throw new Error(r.message);
}

describe("setup/notifications-test", () => {
  it("requests a sandbox test with the key pinned to Apple's bundle id, audits it, and reports delivery and the stored TEST", async () => {
    const w = await world();
    await withServerKey(w);
    const r = await call(
      w,
      "/setup/notifications-test",
      { environment: "sandbox" },
      null,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      environment: "sandbox",
      testNotificationToken: "tok-1_1760000000000",
    });
    const sent = w.setup.log.filter(
      (x) => x.host !== "api.appstoreconnect.apple.com",
    );
    expect(sent).toEqual([
      expect.objectContaining({
        method: "POST",
        host: "api.storekit-sandbox.apple.com",
        path: "/inApps/v1/notifications/test",
      }),
    ]);
    expect((await setupAudits(w)).map((a) => a.action)).toEqual([
      "distribution.asc.notifications.test",
    ]);

    // Apple delivers TEST to the hook, which stores it (P6-01); the status shows both sides.
    await w.db.run(
      `INSERT INTO dist_connector_events
         (product, connector, event_id, event_type, instance_type, instance_id, outcome,
          payload_json, received_at)
       VALUES (?, ?, 'n-1', 'TEST', NULL, NULL, 'stored', '{}', ?)`,
      SLUG,
      APP_STORE_EVENTS,
      NOW,
    );
    const status = await call(
      w,
      "/setup/notifications-test/status",
      {
        environment: "sandbox",
        testNotificationToken: "tok-1_1760000000000",
        since: NOW - 60,
      },
      null,
    );
    expect(status.json).toMatchObject({
      found: true,
      delivered: true,
      attempts: [{ at: NOW, result: "SUCCESS" }],
      received: { at: NOW, outcome: "stored" },
    });
  });

  it("a 404 means no URL is configured for that environment", async () => {
    const w = await world();
    await withServerKey(w);
    w.setup.testStatus = 404;
    const r = await call(
      w,
      "/setup/notifications-test",
      { environment: "production" },
      null,
    );
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("notification_url_missing");
    expect(JSON.stringify(r.json)).toContain("App Information");
    expect(await setupAudits(w)).toEqual([]);
  });

  it("refuses without an In-App Purchase key pinned to the app's bundle id", async () => {
    const w = await world();
    await withServerKey(w, "gg.acme.other");
    const r = await call(
      w,
      "/setup/notifications-test",
      { environment: "sandbox" },
      null,
    );
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("no_server_key");
    expect(w.setup.log.some((x) => x.host.startsWith("api.storekit"))).toBe(
      false,
    );
  });

  it("validates the environment", async () => {
    const w = await world();
    const r = await call(
      w,
      "/setup/notifications-test",
      { environment: "prod" },
      null,
    );
    expect(r.status).toBe(422);
    expect(w.setup.log).toEqual([]);
  });
});

// ── TestFlight ───────────────────────────────────────────────────────────────────────────────

describe("setup/beta-group", () => {
  it("creates an internal group with access to all builds, on the pinned app", async () => {
    const w = await world();
    const r = await call(w, "/setup/beta-group", {
      name: "Team",
      kind: "internal",
    });
    expect(r.status).toBe(200);
    expect(w.setup.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/v1/betaGroups",
        body: {
          data: {
            type: "betaGroups",
            attributes: {
              name: "Team",
              isInternalGroup: true,
              hasAccessToAllBuilds: true,
            },
            relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
          },
        },
      }),
    ]);
    expect(r.json).toMatchObject({
      outcome: "written",
      kind: "internal",
      betaGroupId: "bg-new-1",
    });
    expect((await setupAudits(w)).map((a) => a.action)).toEqual([
      "distribution.asc.testflight.group.create",
    ]);
  });

  it("creates an external group; an existing name of the same kind is found, not duplicated", async () => {
    const w = await world();
    const ext = await call(w, "/setup/beta-group", {
      name: "Beta",
      kind: "external",
    });
    expect(ext.json).toMatchObject({ outcome: "written", kind: "external" });
    expect(
      (w.setup.writes()[0]!.body as { data: { attributes: unknown } }).data
        .attributes,
    ).toEqual({
      name: "Beta",
      isInternalGroup: false,
    });
    w.setup.log.length = 0;
    const again = await call(w, "/setup/beta-group", {
      name: "Public testers",
      kind: "external",
    });
    expect(again.json).toMatchObject({
      outcome: "existing",
      betaGroupId: "bg-public",
    });
    expect(w.setup.writes()).toEqual([]);
  });

  it("refuses a name another kind of group already has", async () => {
    const w = await world();
    const r = await call(w, "/setup/beta-group", {
      name: "Public testers",
      kind: "internal",
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("beta_group_name_taken");
    expect(w.setup.writes()).toEqual([]);
  });

  it("validates the body before anything else", async () => {
    const w = await world();
    const r = await call(w, "/setup/beta-group", {
      name: "a@b",
      kind: "secret",
    });
    expect(r.status).toBe(422);
    expect(r.json.fields).toEqual(["name", "kind"]);
    expect(w.setup.log).toEqual([]);
  });
});

describe("setup/beta-testers", () => {
  const NEW = "new.person@example.com";
  const KNOWN = "known.person@example.com";

  it("invites a new tester, links one the app already has, skips a member — and stores no email anywhere", async () => {
    const w = await world();
    w.setup.testers.push(
      {
        id: "bt-known",
        email: KNOWN,
        apps: new Set([APPLE_ID]),
        groups: new Set(),
      },
      {
        id: "bt-member",
        email: "member@example.com",
        apps: new Set([APPLE_ID]),
        groups: new Set(["bg-public"]),
      },
    );
    const key = freshKey();
    const r = await call(
      w,
      "/setup/beta-testers",
      {
        betaGroupId: "bg-public",
        emails: [NEW, KNOWN.toUpperCase(), "member@example.com", NEW],
      },
      key,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      requested: 3,
      added: 2,
      alreadyMembers: 1,
      failed: 0,
    });
    expect(JSON.stringify(r.json)).not.toContain("@");
    const writes = w.setup.writes();
    expect(writes.map((x) => `${x.method} ${x.path}`)).toEqual([
      "POST /v1/betaTesters",
      "POST /v1/betaGroups/bg-public/relationships/betaTesters",
    ]);
    expect(writes[0]!.body).toEqual({
      data: {
        type: "betaTesters",
        attributes: { email: NEW },
        relationships: {
          betaGroups: { data: [{ type: "betaGroups", id: "bg-public" }] },
        },
      },
    });
    expect(writes[1]!.body).toEqual({
      data: [{ type: "betaTesters", id: "bt-known" }],
    });

    // Nothing personal reached a row: not the ledger, not the audit trail.
    const rows = await ledger(w);
    expect(rows).toHaveLength(3);
    const stored = JSON.stringify(rows) + JSON.stringify(await audits(w.db));
    for (const s of ["@", "example.com", "new.person", "Secret", "Person"])
      expect(stored).not.toContain(s);
    expect(
      rows.every((x) => /^bg-public:[0-9a-f]{32}$/.test(String(x.natural_key))),
    ).toBe(true);
    expect((await setupAudits(w)).map((a) => a.summary)).toEqual([
      expect.stringMatching(
        /^Added a TestFlight tester to the group "Public testers"/,
      ),
      expect.stringMatching(
        /^Added a TestFlight tester to the group "Public testers"/,
      ),
    ]);

    // The same intent again replays every step.
    w.setup.log.length = 0;
    const again = await call(
      w,
      "/setup/beta-testers",
      { betaGroupId: "bg-public", emails: [NEW, KNOWN, "member@example.com"] },
      key,
    );
    expect(again.json).toMatchObject({ added: 0, alreadyMembers: 3 });
    expect(
      w.setup.log.filter(
        (x) => x.method !== "GET" || x.path !== "/v1/betaGroups/bg-public",
      ),
    ).toEqual([]);
  });

  it("records Apple's refusal of one address and carries on", async () => {
    const w = await world();
    const r = await call(w, "/setup/beta-testers", {
      betaGroupId: "bg-public",
      emails: ["x@blocked.example", NEW],
    });
    expect(r.json).toMatchObject({ added: 1, failed: 1 });
    expect((r.json.results as unknown[])[0]).toMatchObject({
      outcome: "failed",
      appleStatus: 409,
      appleCode: "ENTITY_ERROR.ATTRIBUTE.INVALID",
    });
  });

  it("refuses a beta group of another app before any write", async () => {
    const w = await world();
    const r = await call(w, "/setup/beta-testers", {
      betaGroupId: "bg-other-app",
      emails: [NEW],
    });
    expect(r.status).toBe(404);
    expect(r.json.reason).toBe("unknown_beta_group");
    expect(w.setup.writes()).toEqual([]);
  });

  it("validates the addresses", async () => {
    const w = await world();
    for (const emails of [
      [],
      ["not-an-email"],
      Array.from({ length: 26 }, (_, i) => `t${i}@ex.io`),
    ]) {
      const r = await call(w, "/setup/beta-testers", {
        betaGroupId: "bg-public",
        emails,
      });
      expect(r.status).toBe(422);
    }
    expect(w.setup.log).toEqual([]);
  });
});

// ── Availability and price ───────────────────────────────────────────────────────────────────

describe("setup/availability and setup/price", () => {
  it("availability: every territory and new ones, only while the app has none", async () => {
    const w = await world();
    const r = await call(w, "/setup/availability");
    expect(r.json).toMatchObject({
      outcome: "written",
      territories: 3,
      availableInNewTerritories: true,
    });
    const [post] = w.setup.writes();
    expect(post).toMatchObject({
      method: "POST",
      path: "/v2/appAvailabilities",
    });
    const body = post!.body as {
      data: { relationships: { territoryAvailabilities: { data: unknown[] } } };
      included: unknown[];
    };
    expect(body.data.relationships.territoryAvailabilities.data).toHaveLength(
      3,
    );
    expect(body.included[0]).toEqual({
      type: "territoryAvailabilities",
      id: "${ta-USA}",
      attributes: { available: true },
      relationships: {
        territory: { data: { type: "territories", id: "USA" } },
      },
    });
    w.setup.log.length = 0;
    const again = await call(w, "/setup/availability");
    expect(again.json).toMatchObject({ outcome: "existing" });
    expect(w.setup.writes()).toEqual([]);
  });

  it("price: the free price point as a first schedule; an existing price is left alone", async () => {
    const w = await world();
    const r = await call(w, "/setup/price");
    expect(r.json).toMatchObject({
      outcome: "written",
      free: true,
      baseTerritory: "USA",
    });
    const [post] = w.setup.writes();
    expect(post).toMatchObject({
      method: "POST",
      path: "/v1/appPriceSchedules",
      body: {
        data: {
          relationships: {
            app: { data: { type: "apps", id: APPLE_ID } },
            baseTerritory: { data: { type: "territories", id: "USA" } },
          },
        },
        included: [
          {
            type: "appPrices",
            relationships: {
              appPricePoint: {
                data: { type: "appPricePoints", id: "pp-free" },
              },
            },
          },
        ],
      },
    });
    w.setup.log.length = 0;
    const again = await call(w, "/setup/price");
    expect(again.json).toMatchObject({ outcome: "existing", free: false });
    expect(w.setup.writes()).toEqual([]);
    expect((await setupAudits(w)).map((a) => a.action)).toEqual([
      "distribution.asc.app.price",
    ]);
  });
});

// ── Checklist, progress, the platform pin ────────────────────────────────────────────────────

describe("setup/checklist and the provisioning view", () => {
  it("ticks and unticks portal steps (audited), and the connector status shows them with the ledger", async () => {
    const w = await world();
    const bad = await call(
      w,
      "/setup/checklist",
      { item: "users", done: true },
      null,
    );
    expect(bad.status).toBe(422);
    const tick = await call(
      w,
      "/setup/checklist",
      { item: "app_privacy", done: true },
      null,
    );
    expect(tick.status).toBe(200);
    const list = tick.json.checklist as Array<Record<string, unknown>>;
    expect(list.find((c) => c.item === "app_privacy")).toMatchObject({
      done: true,
      doneAt: NOW,
      doneBy: "u1",
      link: `https://appstoreconnect.apple.com/apps/${APPLE_ID}/distribution/privacy`,
    });
    await call(w, "/setup/availability");
    const status = await call(w, "", {}, null, "GET");
    const prov = status.json.provisioning as {
      checklist: Array<{ item: string; done: boolean }>;
      operations: Array<{ op: string; state: string }>;
    };
    expect(prov.checklist.filter((c) => c.done).map((c) => c.item)).toEqual([
      "app_privacy",
    ]);
    expect(prov.operations).toEqual([
      expect.objectContaining({ op: "app.availability", state: "done" }),
    ]);
    expect(status.json.controls).toEqual(
      expect.arrayContaining(["setup/notifications-url", "setup/checklist"]),
    );
    await call(
      w,
      "/setup/checklist",
      { item: "app_privacy", done: false },
      null,
    );
    expect((await setupAudits(w)).map((a) => a.action)).toEqual([
      "distribution.asc.checklist.tick",
      "distribution.asc.app.availability",
      "distribution.asc.checklist.untick",
    ]);
  });

  it("the New-app wizard's path: no Apple outlet yet, the platform team key's pin names the app", async () => {
    const w = await world({ outlets: false, apiKey: false });
    (w.env as Record<string, unknown>).PLATFORM_ASC_API_KEY = JSON.stringify({
      keyId: "TEAMKEY123",
      issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
      p8: ascP8(),
    });
    const none = await call(w, "/setup/beta-group", {
      name: "Team",
      kind: "internal",
    });
    expect(none.status).toBe(409);
    expect(none.json.reason).toBe("credential_pin_missing");
    expect(w.setup.log).toEqual([]);
    await setPlatformPin(w.db, {
      id: "app-store.api-key",
      product: SLUG,
      pin: APPLE_ID,
      actor: "x",
      now: NOW,
    });
    const r = await call(w, "/setup/beta-group", {
      name: "Team",
      kind: "internal",
    });
    expect(r.status).toBe(200);
    expect(w.setup.writes()[0]!.body).toMatchObject({
      data: { relationships: { app: { data: { id: APPLE_ID } } } },
    });
  });

  it("without any App Store Connect setup every control is refused and nothing is sent", async () => {
    const w = await world({ outlets: false, apiKey: false });
    const r = await call(w, "/setup/notifications-url");
    expect(r.status).toBe(404);
    expect(r.json.reason).toBe("not_configured");
    expect(w.setup.log).toEqual([]);
  });
});
