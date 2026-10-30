// @pkey-feature identity.nearby
// Nearby sign-in end to end in one process (I-47.7; WIRE-CONTRACT-V5 §12.11.5, §15.6.1): a
// signed-in client M and a client D with no credential meet on a fake LAN through the Identity
// API alone. D `signIn.start({channel: "nearby"})`, lists M, the person taps it, the codes match,
// M's person taps the code D shows, M approves, and D's own poll hands it the token. The Worker is
// a stub that holds the rules that matter to the client: every `pkey-proof/1` proof is verified,
// `approve` must carry exactly the keys D started with, M's keys must be registered (409 once), the
// decision is final and the token comes once. Connect is off throughout.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyDeviceProof } from "@polaris-key/client-core";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { PolarisKeyClient } from "../src/client.js";
import type { NearbyApproverHandle } from "../src/connect/index.js";
import type { NearbyAsk } from "../src/identity/nearbyApprover.js";
import type { NearbySignInSession } from "../src/identity/nearbySession.js";
import {
  BASE,
  MemoryMdnsNetwork,
  MultiWorker,
  PRODUCT,
  T0,
  devId,
  makeClient,
  markSignedIn,
  until,
} from "./lanFixtures.js";

const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;
const IDENT = `${BASE}/${PRODUCT}/identity`;
const SUBJECT = "ps_Wnnfb0uwgWH1iDEe7g0Fbg";

interface Start {
  deviceId: string;
  signKey: string;
  agreeKey: string;
  label: string | null;
  state: "open" | "approved" | "denied" | "collected";
  license: string | null;
  token: string | null;
}

/** The Worker's connect routes plus the nearby routes and Identity's discovery fragment. */
class NearbyStub extends MultiWorker {
  nearby = true;
  /** Licences with a free seat: more than one asks M to choose. */
  licenses = ["lic_a"];
  /** The next approve is from another network. */
  notNearby = false;
  starts = new Map<string, Start>();
  approves: Record<string, unknown>[] = [];
  keysPuts = 0;
  signouts = 0;
  /** The key ring routes (§13.11.2), reduced: one ring, a wrap per device. */
  ringRow: { ringId: string; rootKid: string } | null = null;
  wraps = new Map<string, Record<string, unknown>>();
  wrapPuts: string[] = [];

  constructor() {
    super();
    const base = this.fetch;
    this.fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.slice(PRODUCT.length + 2);
      const headers = new Headers(init?.headers);
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, string>)
          : {};
      const j = (b: unknown, s = 200) =>
        new Response(JSON.stringify(b), { status: s });
      if (path === ".well-known/polaris.json")
        return j({
          product: PRODUCT,
          services: {
            identity: {
              enabled: true,
              configured: true,
              ...(this.nearby ? { nearby: true } : {}),
              endpoints: {
                nearbyStart: `${IDENT}/nearby/start`,
                nearbyApprove: `${IDENT}/nearby/approve`,
                nearbyPoll: `${IDENT}/nearby/poll`,
                signout: `${IDENT}/signout`,
              },
            },
            connect: { enabled: false },
          },
        });
      if (path === "identity/signout") {
        this.signouts++;
        return j({ released: false });
      }
      if (path === "devices/keys" && init?.method === "PUT") this.keysPuts++;
      const deviceId = headers.get("x-pkey-device") ?? "";
      if (path.startsWith("devices/keyring"))
        return this.#keyring(path, init?.method ?? "GET", headers, body, j);
      if (path === "identity/nearby/start")
        return this.#start(deviceId, body, j);
      if (path === "identity/nearby/poll") return this.#poll(deviceId, body, j);
      if (path === "identity/nearby/approve")
        return this.#approve(headers, body, j);
      return base(input, init);
    }) as typeof fetch;
  }

  #keyring(
    path: string,
    method: string,
    h: Headers,
    b: Record<string, unknown>,
    j: (b: unknown, s?: number) => Response,
  ): Response {
    const me = this.tokens.get(
      (h.get("authorization") ?? "").replace("Bearer ", ""),
    );
    if (me === undefined) return j({ error: { code: "unauthorized" } }, 401);
    if (method === "GET" && path === "devices/keyring")
      return j({
        ring: this.ringRow && {
          ...this.ringRow,
          epoch: 1,
          state: "active",
          createdAt: 1,
          recovery: { set: false },
          adopted: [],
        },
        wrap: this.wraps.get(me) ?? null,
      });
    if (method === "POST" && path === "devices/keyring") {
      if (this.ringRow) return j({ error: { code: "keyring_conflict" } }, 409);
      this.ringRow = { ringId: String(b.ringId), rootKid: String(b.rootKid) };
      this.wraps.set(me, {
        epoch: 1,
        kid: b.rootKid,
        by: me,
        ...(b.wrap as object),
      });
      return j({ ringId: b.ringId, epoch: 1 }, 201);
    }
    const w = /^devices\/keyring\/wraps\/(.+)$/.exec(path);
    if (w && method === "PUT") {
      const target = decodeURIComponent(w[1]!);
      if (!this.wraps.has(me)) return j({ error: { code: "forbidden" } }, 403);
      if (this.wraps.has(target))
        return j({ error: { code: "keyring_conflict" } }, 409);
      this.wraps.set(target, { ...b, by: me });
      this.wrapPuts.push(target);
      return new Response(null, { status: 204 });
    }
    return j({}, 404);
  }

  async #proof(
    purpose: string,
    deviceId: string,
    value: string,
    signKey: string,
    sig: string,
  ): Promise<boolean> {
    return verifyDeviceProof({
      purpose: purpose as never,
      product: PRODUCT,
      deviceId,
      value,
      tokenHash: "-",
      signKey,
      sig,
    });
  }

  async #start(
    deviceId: string,
    b: Record<string, string>,
    j: (b: unknown, s?: number) => Response,
  ): Promise<Response> {
    if (
      !(await this.#proof(
        "nearby-start",
        deviceId,
        `${b.signKey}.${b.agreeKey}`,
        b.signKey!,
        b.proof!,
      ))
    )
      return j({ error: { code: "invalid_grant" } }, 400);
    const request = `nr_${base64UrlEncodeBytes(randomBytes(16)).slice(0, 22)}`;
    this.starts.set(request, {
      deviceId,
      signKey: b.signKey!,
      agreeKey: b.agreeKey!,
      label: b.deviceName ?? null,
      state: "open",
      license: null,
      token: null,
    });
    return j({ request, expiresIn: 300, interval: 3 }, 201);
  }

  async #poll(
    deviceId: string,
    b: Record<string, string>,
    j: (b: unknown, s?: number) => Response,
  ): Promise<Response> {
    const s = this.starts.get(b.request!);
    if (s === undefined || s.deviceId !== deviceId)
      return j({ status: "timeout" });
    if (
      !(await this.#proof(
        "nearby-poll",
        deviceId,
        b.request!,
        s.signKey,
        b.proof!,
      ))
    )
      return j({ error: { code: "invalid_grant" } }, 400);
    if (s.state === "denied")
      return j({ status: "error", reason: "access_denied" });
    if (s.state === "open") return j({ status: "pending" });
    if (s.state === "collected") return j({ status: "timeout" });
    s.state = "collected";
    this.members.set(deviceId, { signKey: s.signKey, agreeKey: s.agreeKey });
    this.tokens.set(s.token!, deviceId);
    return j({
      access_token: s.token,
      token_type: "Bearer",
      scope: "email",
      schemaVersion: 1,
      device: { id: deviceId },
      license: { id: s.license, name: "Ana", email: "ana@example.com" },
      subject: SUBJECT,
    });
  }

  async #approve(
    h: Headers,
    b: Record<string, unknown>,
    j: (b: unknown, s?: number) => Response,
  ): Promise<Response> {
    const m = this.tokens.get(
      (h.get("authorization") ?? "").replace("Bearer ", ""),
    );
    if (m === undefined) return j({ error: { code: "account_required" } }, 403);
    const keys = this.members.get(m);
    if (keys === undefined)
      return j({ error: { code: "device_keys_required" } }, 409);
    if (
      !(await this.#proof(
        "nearby-approve",
        m,
        String(b.request),
        keys.signKey,
        String(b.proof),
      ))
    )
      return j({ error: { code: "invalid_grant" } }, 400);
    const { proof: _p, ...logged } = b;
    this.approves.push(logged);
    const s = this.starts.get(String(b.request));
    if (
      s === undefined ||
      s.state !== "open" ||
      s.deviceId !== b.deviceId ||
      s.signKey !== b.signKey ||
      s.agreeKey !== b.agreeKey
    )
      return j({ error: { code: "not_found" } }, 404);
    if (this.notNearby) return j({ error: { code: "not_nearby" } }, 403);
    if (b.decision === "deny") {
      s.state = "denied";
      return new Response(null, { status: 204 });
    }
    const choice = b.choice as { kind: string; licenseId?: string } | undefined;
    if (choice === undefined && this.licenses.length > 1)
      return j({
        status: "choose",
        choices: {
          state: "choose",
          choices: this.licenses.map((id) => ({ id })),
        },
      });
    s.license = choice?.licenseId ?? this.licenses[0]!;
    s.token = `pkeyt_${base64UrlEncodeBytes(randomBytes(32))}`;
    s.state = "approved";
    return j({ status: "approved", deviceLabel: s.label });
  }
}

let dirs: string[] = [];
let handles: NearbyApproverHandle[] = [];
let clients: PolarisKeyClient[] = [];
let sessions: NearbySignInSession[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
});

/** Everything a test opened, closed: sessions, advert handles, clients, state directories. */
async function tidy(): Promise<void> {
  sessions.splice(0).forEach((s) => s.cancel());
  await Promise.all(handles.splice(0).map((h) => h.stop()));
  clients.splice(0).forEach((c) => c.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
}
afterEach(async () => {
  await tidy();
  vi.useRealTimers();
});

/** A device with no credential: no sign-in, no token. */
async function makeD(w: NearbyStub, n: string): Promise<PolarisKeyClient> {
  const c = await makeClient(w, n, dirs, { noToken: true });
  // The acquisition sync after a sign-in is pinned by the sync transcripts, not here.
  (c.identity as unknown as { onAcquired: () => Promise<void> }).onAcquired =
    async () => undefined;
  clients.push(c);
  return c;
}

/** M: signed in (a token and the identity a finished sign-in leaves). */
async function makeM(w: NearbyStub): Promise<PolarisKeyClient> {
  const m = await makeClient(w, "1", dirs);
  markSignedIn(m);
  clients.push(m);
  return m;
}

async function world() {
  const w = new NearbyStub();
  const net = new MemoryMdnsNetwork();
  const m = await makeM(w);
  const d = await makeD(w, "2");
  // D browses this fake LAN (the test seam the CC-15 tests use for the LAN half).
  const orig = d.cloudConnect.nearby.request.bind(d.cloudConnect.nearby);
  vi.spyOn(d.cloudConnect.nearby, "request").mockImplementation((o) =>
    orig({ ...o, mdns: net.adapter(), allowLoopback: true }),
  );
  const asks: NearbyAsk[] = [];
  const h = await m.identity.nearby.onRequest((a) => asks.push(a), {
    prompt: true,
    label: "Ana's laptop",
    mdns: net.adapter(),
    ...LOOP,
  });
  handles.push(h);
  return { w, net, m, d, h, asks };
}

/** D starts, lists M and the person taps it; returns the session and the code D shows. */
async function dTaps(d: PolarisKeyClient) {
  const s = await d.identity.signIn.start({
    channel: "nearby",
    deviceName: "New phone",
  });
  sessions.push(s);
  await until(() => s.approvers.length === 1);
  expect(s.approvers[0]).toMatchObject({ label: "Ana's laptop" });
  const { code } = await s.choose(s.approvers[0]!.id);
  return { s, code };
}

const showing = (a: NearbyAsk, code: string): string =>
  a.codes.find((c) => c.replace(" ", "") === code.replace(" ", ""))!;

/** Two licences have a free seat, so M's tap lands on the choice step. */
async function atChoice() {
  const { w, d, asks } = await world();
  w.licenses = ["lic_a", "lic_b"];
  const { s, code } = await dTaps(d);
  await until(() => asks.length === 1);
  const step = await asks[0]!.pick(showing(asks[0]!, code));
  if (step.kind !== "choose") throw new Error(step.kind);
  return { w, d, s, step };
}

/** D taps M, M taps the matching code: returns D's session and what M's tap came to. */
async function tapped(x: { d: PolarisKeyClient; asks: NearbyAsk[] }) {
  const { s, code } = await dTaps(x.d);
  await until(() => x.asks.length === 1);
  const step = await x.asks[0]!.pick(showing(x.asks[0]!, code));
  return { s, step };
}

describe("nearby sign-in, D and M through the Identity API", () => {
  it("lists, taps, matches, approves, and D's own poll signs it in", async () => {
    const { w, m, d, asks } = await world();
    expect(await d.identity.autoSignIn()).toMatchObject({
      kind: "needsSignIn",
      reason: "no_credential",
    });
    const { s, code } = await dTaps(d);
    await until(() => asks.length === 1);
    const ask = asks[0]!;
    expect(ask.device).toBe("New phone");
    expect(ask.codes.map((c) => c.replace(" ", ""))).toContain(
      code.replace(" ", ""),
    );

    // Nothing signs D in before M approves: the poll is pending.
    expect(await s.wait({ once: true })).toMatchObject({ kind: "pending" });
    expect(d.hasToken).toBe(false);

    // M has no keys registered yet: the first approve is 409, M registers them, retries once.
    expect(await ask.pick(showing(ask, code))).toEqual({ kind: "approved" });
    expect(w.keysPuts).toBe(1);
    expect(w.approves).toHaveLength(1);
    expect(w.approves[0]).toMatchObject({
      deviceId: devId("2"),
      decision: "approve",
    });
    const start = [...w.starts.values()][0]!;
    expect(w.approves[0]).toMatchObject({
      signKey: start.signKey,
      agreeKey: start.agreeKey,
    });
    await until(() => s.result === "approved");

    // D's own poll hands over the token once.
    const done = await s.wait({ once: true });
    expect(done).toMatchObject({
      kind: "signedIn",
      subject: SUBJECT,
      identity: { email: "ana@example.com" },
    });
    expect(d.hasToken).toBe(true);
    expect(await d.identity.autoSignIn()).toMatchObject({
      kind: "signedIn",
      via: "stored",
    });
    expect(await s.wait({ once: true })).toBe(done);
    await s.confirmAccount();
    expect(await m.identity.current()).not.toBeNull();
  });

  it("a wrong tap calls no route and signs nobody in", async () => {
    const { w, d, asks } = await world();
    const { s, code } = await dTaps(d);
    await until(() => asks.length === 1);
    const decoy = asks[0]!.codes.find(
      (c) => c.replace(" ", "") !== code.replace(" ", ""),
    )!;
    expect(await asks[0]!.pick(decoy)).toEqual({ kind: "mismatch" });
    expect(w.approves).toEqual([]);
    expect(await s.wait({ once: true })).toMatchObject({ kind: "pending" });
    expect(d.hasToken).toBe(false);
  });

  it("none of these match closes the session, calls no route", async () => {
    const { w, d, asks } = await world();
    const { s } = await dTaps(d);
    await until(() => asks.length === 1);
    await asks[0]!.deny();
    expect(w.approves).toEqual([]);
    expect(await s.wait({ once: true })).toMatchObject({ kind: "pending" });
  });

  it("a licence choice on M: cancel denies, and D's wait throws sign-in-denied", async () => {
    const { w, d, s, step } = await atChoice();
    expect(await s.wait({ once: true })).toMatchObject({ kind: "pending" });
    expect(await step.cancel()).toEqual({ kind: "denied" });
    expect(w.approves.map((a) => a.decision)).toEqual(["approve", "deny"]);
    await expect(s.wait({ once: true })).rejects.toMatchObject({
      code: "sign-in-denied",
    });
    expect(d.hasToken).toBe(false);
  });

  it("a licence choice on M: choosing signs D in with that licence", async () => {
    const { w, d, s, step } = await atChoice();
    expect(await step.choose({ kind: "license", licenseId: "lic_b" })).toEqual({
      kind: "approved",
    });
    expect(await s.wait({ once: true })).toMatchObject({
      kind: "signedIn",
      activation: { licenseId: "lic_b" },
    });
  });

  it("from another network M says not-nearby and D hears denied, and stays pending", async () => {
    const { w, d, asks } = await world();
    w.notNearby = true;
    const { s, code } = await dTaps(d);
    await until(() => asks.length === 1);
    expect(await asks[0]!.pick(showing(asks[0]!, code))).toEqual({
      kind: "not-nearby",
    });
    await until(() => s.result === "denied");
    expect(await s.wait({ once: true })).toMatchObject({ kind: "pending" });
    expect(d.hasToken).toBe(false);
  });

  it("declining the account signs D out again", async () => {
    const x = await world();
    const { w, d } = x;
    const { s } = await tapped(x);
    await s.wait({ once: true });
    expect(d.hasToken).toBe(true);
    await s.declineAccount();
    expect(w.signouts).toBe(1);
    expect(await d.identity.autoSignIn()).toMatchObject({
      kind: "needsSignIn",
      reason: "signed_out",
    });
  });
});

describe("nearby sign-in: the key ring wrap (KEYRING_WRAP)", () => {
  /** M holds the ring's root and a sealed value; D has nothing. */
  async function withRing() {
    const x = await world();
    await x.m.keyring.create({ recovery: false });
    const sealed = await x.m.keyring.codec.seal("notes", "n1", { x: 1 });
    return { ...x, sealed };
  }

  it("M wraps the root to the new device once; D opens it only after confirming the account", async () => {
    const x = await withRing();
    const { w, m, d, sealed } = x;
    const { s, step } = await tapped(x);
    expect(step).toEqual({ kind: "approved" });
    // M stored the wrap for D (the fallback) and sent the same one over the channel.
    expect(w.wrapPuts).toEqual([devId("2")]);
    expect(m.keyring.unlocked).toBe(true);

    // D's poll signs it in; the root is not D's until the person confirms the account.
    expect(await s.wait({ once: true })).toMatchObject({ kind: "signedIn" });
    expect(d.keyring.unlocked).toBe(false);
    expect(s.wrap).toBe("none");
    await s.confirmAccount();
    await until(() => s.wrap === "applied");
    expect(d.keyring.unlocked).toBe(true);
    expect(await d.keyring.codec.open("notes", "n1", sealed)).toMatchObject({
      ok: true,
      value: { x: 1 },
    });
    expect(await d.keyring.pin()).toMatchObject({ ringId: w.ringRow!.ringId });
    // Exactly one wrap, to D's id.
    expect(w.wrapPuts).toHaveLength(1);
  });

  it("declining the account keeps the root off the device", async () => {
    const x = await withRing();
    const { s } = await tapped(x);
    await s.wait({ once: true });
    await s.declineAccount();
    const { d } = x;
    expect(d.keyring.unlocked).toBe(false);
    expect(s.wrap).toBe("none");
    expect(await d.keyring.pin()).toBeNull();
  });

  it("an M that holds no root sends no wrap, and D is signed in all the same", async () => {
    const x = await world();
    const { w, d } = x;
    const { s, step } = await tapped(x);
    expect(step).toEqual({ kind: "approved" });
    expect(w.wrapPuts).toEqual([]);
    expect(await s.wait({ once: true })).toMatchObject({ kind: "signedIn" });
    await s.confirmAccount();
    expect(s.wrap).toBe("none");
    expect(d.keyring.unlocked).toBe(false);
  });

  it("a wrap the Worker refuses does not undo the approval", async () => {
    const x = await withRing();
    const { w, d } = x;
    w.wraps.set(devId("2"), { epoch: 1, kid: "x", kem: 32, enc: "x", ct: "x" });
    const { s, step } = await tapped(x);
    expect(step).toEqual({ kind: "approved" });
    expect(await s.wait({ once: true })).toMatchObject({ kind: "signedIn" });
    await s.confirmAccount();
    expect(d.keyring.unlocked).toBe(false);
  });
});

describe("nearby sign-in: the lifecycle", () => {
  const adverts = (net: MemoryMdnsNetwork) =>
    [...net.adverts.values()].filter((a) => a.txt.includes("m=v"));

  it("M's sign-out stops the advert and closes D's session", async () => {
    const { w, net, m, d, asks } = await world();
    expect(adverts(net)).toHaveLength(1);
    const { s } = await dTaps(d);
    await until(() => asks.length === 1);
    await m.identity.signOut();
    expect(w.signouts).toBe(1);
    expect(adverts(net)).toHaveLength(0);
    expect(await s.wait({ once: true })).toMatchObject({ kind: "pending" });
  });

  it("stop() leaves nothing advertised", async () => {
    const { net, h } = await world();
    await h.stop();
    expect(adverts(net)).toHaveLength(0);
  });

  it("answers the typed N/A on both sides when discovery does not name nearby", async () => {
    const w = new NearbyStub();
    w.nearby = false;
    const m = await makeM(w);
    const d = await makeD(w, "2");
    await expect(
      m.identity.nearby.onRequest(() => undefined, { prompt: true }),
    ).rejects.toMatchObject({ code: "service-unavailable" });
    await expect(
      d.identity.signIn.start({ channel: "nearby" }),
    ).rejects.toMatchObject({ code: "service-unavailable" });
    expect(await d.identity.nearby.available({ role: "requester" })).toBe(
      false,
    );
    expect(w.starts.size).toBe(0);
  });

  it("M must be signed in", async () => {
    const w = new NearbyStub();
    const d = await makeD(w, "2");
    await expect(
      d.identity.nearby.onRequest(() => undefined, { prompt: true }),
    ).rejects.toMatchObject({ code: "account_required" });
  });
});
