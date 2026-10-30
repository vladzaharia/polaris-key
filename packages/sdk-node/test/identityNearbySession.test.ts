// @pkey-feature identity.nearby
// The D session of nearby sign-in (I-47.6): `identity.signIn.start({channel: "nearby"})` over a
// fake Worker (the real route client) and a fake LAN request (the CC-15 handle's shape). The poll
// is the authority; `VOUCH_RESULT` is display only; the first terminal answer is kept; records
// reach the session only after the account is confirmed; no secret reaches a print or an error.

import { format, inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type {
  NearbyApproverInfo,
  NearbyCloseCode,
  NearbyRecord,
  NearbyRequest,
  NearbyRequestOptions,
} from "../src/connect/nearbyRequester.js";
import type { NearbyRoutes } from "../src/identity/nearby.js";
import {
  startNearbySignIn,
  type NearbySessionDeps,
  type NearbySignInOptions,
  type NearbySignInSession,
} from "../src/identity/nearbySession.js";
import type { CoreContext } from "../src/core/context.js";
import { identityDiscovery, json, seededClient } from "./parityFixtures.js";
import type { Handler } from "./parityFixtures.js";
import { fixtureKeys } from "../../../conformance/runners/node/nearbyActions.js";
import type { VouchStatus } from "@polaris-key/client-core/peer";

const REQ = "nr_pA71hdu4pwET01lPlZ_Pow";
const TOKEN = "pkeyt_nearbysecretnearbysecretnearbysecret000";
const SUBJECT = "ps_Wnnfb0uwgWH1iDEe7g0Fbg";
const BASE = "https://k.test/djdl/identity";
const FRAGMENT = {
  nearby: true,
  endpoints: {
    nearbyStart: `${BASE}/nearby/start`,
    nearbyApprove: `${BASE}/nearby/approve`,
    nearbyPoll: `${BASE}/nearby/poll`,
    signout: `${BASE}/signout`,
  },
};

/** The CC-15 `NearbyRequest`, scriptable. */
class FakeRequest implements NearbyRequest {
  approvers: readonly NearbyApproverInfo[] = [];
  result: VouchStatus | null = null;
  closed = false;
  closes = 0;
  confirmed = 0;
  declined = 0;
  chosen: string[] = [];
  held: NearbyRecord[] = [];
  readonly #approvers = new Set<(l: readonly NearbyApproverInfo[]) => void>();
  readonly #result = new Set<(s: VouchStatus) => void>();
  readonly #record = new Set<(r: NearbyRecord) => void>();
  onApprovers(fn: (l: readonly NearbyApproverInfo[]) => void) {
    this.#approvers.add(fn);
    return () => void this.#approvers.delete(fn);
  }
  onResult(fn: (s: VouchStatus) => void) {
    this.#result.add(fn);
    return () => void this.#result.delete(fn);
  }
  onRecord(fn: (r: NearbyRecord) => void) {
    this.#record.add(fn);
    return () => void this.#record.delete(fn);
  }
  onClose(_fn: (c: NearbyCloseCode) => void) {
    return () => undefined;
  }
  list(l: NearbyApproverInfo[]): void {
    this.approvers = l;
    for (const f of this.#approvers) f(l);
  }
  vouch(s: VouchStatus): void {
    this.result = s;
    for (const f of this.#result) f(s);
  }
  async choose(id: string): Promise<{ code: string }> {
    this.chosen.push(id);
    return { code: "482 913" };
  }
  async confirmAccount(): Promise<void> {
    this.confirmed++;
    for (const r of this.held.splice(0)) for (const f of this.#record) f(r);
  }
  async declineAccount(): Promise<void> {
    this.declined++;
    this.held = [];
  }
  async close(): Promise<void> {
    this.closes++;
    this.closed = true;
  }
}

const noPause = async (): Promise<void> => undefined;

/** A client with the nearby Worker routes and a fixture key store; `routes` adds or overrides. */
async function nearbyClient(routes: Record<string, Handler> = {}) {
  const r = await seededClient({
    token: null,
    extra: {
      expectedServices: ["license", "config", "identity"] as never,
      deviceName: "",
      keyring: { deviceKeys: fixtureKeys("session-d") as never },
    },
    routes: {
      "GET /djdl/.well-known/polaris.json": identityDiscovery(FRAGMENT),
      "POST /djdl/identity/nearby/start": () =>
        json({ request: REQ, expiresIn: 300, interval: 3 }, 201),
      ...routes,
    },
  });
  // The acquisition sync after a sign-in is pinned by the sync transcripts, not here.
  (
    r.client.identity as unknown as { onAcquired: () => Promise<void> }
  ).onAcquired = async () => undefined;
  return r;
}

type Client = Awaited<ReturnType<typeof nearbyClient>>["client"];

/** Start a session on `client` over the fake LAN request `req`. */
function sessionOn(
  client: Client,
  req: FakeRequest,
  over: Partial<NearbySessionDeps> = {},
  opts: Partial<NearbySignInOptions> = {},
): Promise<NearbySignInSession> {
  const id = client.identity as unknown as {
    ctx: CoreContext;
    nearbyRoutes: NearbyRoutes;
  };
  return startNearbySignIn(
    {
      ctx: id.ctx,
      routes: id.nearbyRoutes,
      lan: () => ({ request: async () => req }),
      signOut: async () => undefined,
      pause: noPause,
      ...over,
    },
    { channel: "nearby", ...opts },
  );
}

interface World {
  session: NearbySignInSession;
  req: FakeRequest;
  seen: { path: string; body: string | null }[]; // live
  order: string[];
  signOut: ReturnType<typeof vi.fn>;
  client: Awaited<ReturnType<typeof seededClient>>["client"];
  polls: () => number;
}

async function world(
  poll: Handler | Handler[],
  o: {
    deviceName?: string;
    discovery?: Record<string, unknown>;
    extra?: Record<string, Handler>;
  } = {},
): Promise<World> {
  const order: string[] = [];
  const answers = Array.isArray(poll) ? [...poll] : [poll];
  let last = answers[answers.length - 1]!;
  let n = 0;
  const { client, seen } = await nearbyClient({
    "GET /djdl/.well-known/polaris.json": identityDiscovery(
      o.discovery ?? FRAGMENT,
    ),
    "POST /djdl/identity/nearby/start": () => {
      order.push("start");
      return json({ request: REQ, expiresIn: 300, interval: 3 }, 201);
    },
    "POST /djdl/identity/nearby/poll": (r) => {
      n += 1;
      const h = answers.shift() ?? last;
      last = h;
      return h(r);
    },
    ...o.extra,
  });
  const req = new FakeRequest();
  const signOut = vi.fn(async () => undefined);
  const session = await sessionOn(
    client,
    req,
    {
      signOut,
      lan: () => ({
        request: async (opts: NearbyRequestOptions) => {
          order.push(
            `request:${opts.request}:${opts.label ?? "-"}:${opts.expiresIn}`,
          );
          return req;
        },
      }),
    },
    o.deviceName !== undefined ? { deviceName: o.deviceName } : {},
  );
  return { session, req, seen, order, signOut, client, polls: () => n };
}

const pending: Handler = () => json({ status: "pending" });
const ready: Handler = () =>
  json({
    access_token: TOKEN,
    token_type: "Bearer",
    scope: "email",
    schemaVersion: 1,
    device: { id: "d" },
    license: { id: "lic_1", name: "Ada Lovelace", email: "ada@example.com" },
    subject: SUBJECT,
  });

describe("nearby sign-in session: start", () => {
  it("starts the request, then the LAN request with its handle, label and life", async () => {
    const w = await world(pending, { deviceName: "Den" });
    expect(w.order).toEqual(["start", `request:${REQ}:Den:300`]);
    expect(w.session.channel).toBe("nearby");
    expect(w.session.expiresIn).toBe(300);
    expect(w.session.interval).toBe(3);
    expect(w.session.deviceName).toBe("Den");
  });

  it("answers the typed N/A, with no LAN request, when discovery names no nearby", async () => {
    await expect(
      world(pending, { discovery: { endpoints: FRAGMENT.endpoints } }),
    ).rejects.toMatchObject({ code: "service-unavailable" });
  });

  it("the signed-in client's signIn.start routes the nearby channel here", async () => {
    const { client } = await nearbyClient();
    const req = new FakeRequest();
    const spy = vi
      .spyOn(client.cloudConnect.nearby, "request")
      .mockResolvedValue(req);
    const s = await client.identity.signIn.start({ channel: "nearby" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ request: REQ, expiresIn: 300 }),
    );
    expect(s.channel).toBe("nearby");
    s.cancel();
    expect(await s.wait()).toEqual({ kind: "cancelled" });
  });
});

describe("nearby sign-in session: the approvers and the code", () => {
  it("lists approvers with their labels cleaned, and chooses by id", async () => {
    const w = await world(pending);
    const seen: (readonly { id: string; label: string | null }[])[] = [];
    w.session.onApprovers((l) => seen.push(l));
    w.req.list([
      { id: "ap_1", label: "Ana\u0007‮'s phone", platform: "ios" },
      { id: "ap_2", label: null, platform: "android" },
    ]);
    expect(w.session.approvers).toHaveLength(2);
    expect(w.session.approvers[0]!.label).not.toMatch(/[\u0000-\u001f‮]/);
    expect(w.session.approvers[1]).toEqual({
      id: "ap_2",
      label: null,
      platform: "android",
    });
    expect(seen).toHaveLength(1);
    expect(w.session.code).toBeNull();
    expect(await w.session.choose("ap_1")).toEqual({ code: "482 913" });
    expect(w.session.code).toBe("482 913");
    expect(w.req.chosen).toEqual(["ap_1"]);
  });

  it("VOUCH_RESULT is display only: approved on the LAN does not sign anyone in", async () => {
    const w = await world([pending, pending, ready]);
    const results: string[] = [];
    w.session.onResult((s) => results.push(s));
    w.req.vouch("approved");
    expect(w.session.result).toBe("approved");
    expect(results).toEqual(["approved"]);
    expect(await w.session.wait({ once: true })).toMatchObject({
      kind: "pending",
    });
    expect(w.client.hasToken).toBe(false);
    expect(await w.client.identity.autoSignIn()).toMatchObject({
      kind: "needsSignIn",
    });
  });
});

describe("nearby sign-in session: the poll decides", () => {
  it("polls until the token, stores it as a sign-in, and keeps the answer", async () => {
    const w = await world([pending, pending, ready]);
    const o = await w.session.wait();
    expect(o).toMatchObject({
      kind: "signedIn",
      subject: SUBJECT,
      activation: { licenseId: "lic_1" },
      identity: { name: "Ada Lovelace", email: "ada@example.com" },
    });
    expect(w.polls()).toBe(3);
    expect(w.client.hasToken).toBe(true);
    expect(await w.client.identity.autoSignIn()).toMatchObject({
      kind: "signedIn",
      subject: SUBJECT,
    });
    // The token comes once: a second wait is the same answer, with no poll.
    expect(await w.session.wait()).toBe(o);
    expect(await w.session.wait({ once: true })).toBe(o);
    expect(w.polls()).toBe(3);
    // The LAN half stays up for the Sync record, until the account is settled.
    expect(w.req.closes).toBe(0);
  });

  it("every poll is signed by the start key and carries the handle", async () => {
    const w = await world([pending, ready]);
    await w.session.wait();
    const bodies = w.seen
      .filter((s) => s.path.endsWith("/nearby/poll"))
      .map((s) => JSON.parse(s.body!));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.request).toBe(REQ);
      expect(typeof b.proof).toBe("string");
    }
  });

  it("a 429 slows the interval; once answers pending with the new interval", async () => {
    const w = await world([
      () => json({ status: "slow_down", interval: 9 }, 429),
      pending,
    ]);
    expect(await w.session.wait({ once: true })).toEqual({
      kind: "pending",
      interval: 9,
      slowDown: true,
    });
    expect(w.session.interval).toBe(9);
    expect(await w.session.wait({ once: true })).toEqual({
      kind: "pending",
      interval: 9,
    });
  });

  it("rides out a transient failure and keeps polling", async () => {
    const w = await world([
      () => json({ error: "unavailable" }, 503, { "retry-after": "1" }),
      ready,
    ]);
    expect(await w.session.wait()).toMatchObject({ kind: "signedIn" });
    expect(w.polls()).toBe(2);
  });

  it("a timeout is expired and closes the LAN half", async () => {
    const w = await world(() => json({ status: "timeout" }));
    expect(await w.session.wait()).toEqual({ kind: "expired" });
    expect(w.req.closed).toBe(true);
    expect(await w.session.wait()).toEqual({ kind: "expired" });
  });

  it("M's refusal throws sign-in-denied, once and for good", async () => {
    const w = await world(() =>
      json({ status: "error", reason: "access_denied" }),
    );
    await expect(w.session.wait()).rejects.toMatchObject({
      code: "sign-in-denied",
    });
    await expect(w.session.wait()).rejects.toMatchObject({
      code: "sign-in-denied",
    });
    expect(w.polls()).toBe(1);
    expect(w.req.closed).toBe(true);
  });

  it("routes that went away end the wait with the typed N/A", async () => {
    let named = true;
    const w = await world(() => json({ error: { code: "not_found" } }, 404), {
      extra: {
        "GET /djdl/.well-known/polaris.json": () =>
          identityDiscovery(
            named ? FRAGMENT : { endpoints: FRAGMENT.endpoints },
          )({} as never),
      },
    });
    named = false;
    await expect(w.session.wait({ once: true })).rejects.toMatchObject({
      code: "service-unavailable",
    });
    expect(w.req.closed).toBe(true);
  });

  it("cancel() stops the wait, closes the LAN half and forbids choosing", async () => {
    const w = await world(pending);
    const waiting = w.session.wait();
    w.session.cancel();
    expect(await waiting).toEqual({ kind: "cancelled" });
    expect(w.req.closed).toBe(true);
    await expect(w.session.choose("ap_1")).rejects.toBeTruthy();
  });

  it("an abort signal on start cancels the session", async () => {
    const ac = new AbortController();
    const { client } = await nearbyClient();
    const req = new FakeRequest();
    const s = await sessionOn(client, req, {}, { signal: ac.signal });
    ac.abort();
    expect(await s.wait()).toEqual({ kind: "cancelled" });
    expect(req.closed).toBe(true);
  });
});

describe("nearby sign-in session: the account is confirmed first (rule 12)", () => {
  const WRAP = new Uint8Array([1, 2, 3, 4]);

  it("holds records until confirmAccount(), keeps the wrap, ignores other Sync records", async () => {
    const w = await world(ready);
    await w.session.wait();
    w.req.held = [
      { type: 0x0031, body: new Uint8Array([9]) },
      { type: 0x0030, body: WRAP },
    ];
    expect(w.session.takeWrap()).toBeNull();
    await w.session.confirmAccount();
    expect(w.req.confirmed).toBe(1);
    expect(w.session.takeWrap()).toEqual(WRAP);
    expect(w.session.takeWrap()).toBeNull();
    // Again: nothing more is asked of the LAN.
    await w.session.confirmAccount();
    expect(w.req.confirmed).toBe(1);
  });

  it("confirming before the device is signed in is refused", async () => {
    const w = await world(pending);
    await expect(w.session.confirmAccount()).rejects.toMatchObject({
      code: "sign-in-failed",
    });
    expect(w.req.confirmed).toBe(0);
  });

  it("declining drops the wrap, closes the LAN half and signs out", async () => {
    const w = await world(ready);
    await w.session.wait();
    w.req.held = [{ type: 0x0030, body: WRAP }];
    await w.session.declineAccount();
    expect(w.req.declined).toBe(1);
    expect(w.req.closed).toBe(true);
    expect(w.signOut).toHaveBeenCalledTimes(1);
    expect(w.session.takeWrap()).toBeNull();
  });

  it("declining before a sign-in signs nothing out", async () => {
    const w = await world(pending);
    await w.session.declineAccount();
    expect(w.signOut).not.toHaveBeenCalled();
  });
});

describe("nearby sign-in session: no secret is printed", () => {
  it("the session, the outcome and the errors leave out the handle, the code, the proofs and the token", async () => {
    const w = await world([pending, ready]);
    await w.session.choose("ap_1");
    await w.session.wait();
    const proof = JSON.parse(
      w.seen.find((s) => s.path.endsWith("/nearby/poll"))!.body!,
    ).proof as string;
    for (const out of [
      format(w.session),
      format("%o", w.session),
      inspect(w.session, { depth: 9 }),
      JSON.stringify(w.session),
    ]) {
      expect(out).not.toContain(REQ);
      expect(out).not.toContain("482 913");
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(proof);
    }
    const d = await world(() =>
      json({ status: "error", reason: "access_denied" }),
    );
    const err = (await d.session.wait().catch((e) => e)) as Error;
    for (const text of [err.message, inspect(err, { depth: 9 })]) {
      expect(text).not.toContain(REQ);
      expect(text).not.toContain(TOKEN);
    }
  });
});
