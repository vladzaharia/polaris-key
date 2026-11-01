// @pkey-feature identity.nearby
// Nearby sign-in end to end in one process (I-47.7; WIRE-CONTRACT-V5 §12.11.5, §15.6.1): a
// signed-in client M and a client D with no credential meet on a fake LAN through the Identity
// API alone. D `signIn.start({channel: "nearby"})`, lists M, the person taps it, the codes match,
// M's person taps the code D shows, M approves, and D's own poll hands it the token. The Worker is
// a stub that holds the rules that matter to the client: every `pkey-proof/1` proof is verified,
// `approve` must carry exactly the keys D started with, M's keys must be registered (409 once), the
// decision is final and the token comes once. Connect is off throughout.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import type { NearbyApproverHandle } from "../src/connect/index.js";
import type { NearbyAsk } from "../src/identity/nearbyApprover.js";
import type { NearbySignInSession } from "../src/identity/nearbySession.js";
import {
  MemoryMdnsNetwork,
  T0,
  devId,
  makeClient,
  markSignedIn,
  until,
} from "./lanFixtures.js";

const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;
import { NearbyStub, SUBJECT } from "./nearbyStub.js";

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
  const c = await makeClient(w, n, dirs, { noToken: true, licensed: true });
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
    // Held unconfirmed: automatic sign-in does not count it until the person confirms.
    expect(await d.identity.autoSignIn()).toMatchObject({
      kind: "needsSignIn",
    });
    expect(await s.wait({ once: true })).toBe(done);
    await s.confirmAccount();
    expect(await d.identity.autoSignIn()).toMatchObject({
      kind: "signedIn",
      via: "stored",
    });
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

  it("a wrap the Worker refuses does not undo the approval, nor take the channel copy with it (V5 13.11.3: seal, send, then PUT)", async () => {
    const x = await withRing();
    const { w, d } = x;
    w.wraps.set(devId("2"), { epoch: 1, kid: "x", kem: 32, enc: "x", ct: "x" });
    const { s, step } = await tapped(x);
    expect(step).toEqual({ kind: "approved" });
    expect(await s.wait({ once: true })).toMatchObject({ kind: "signedIn" });
    await s.confirmAccount();
    // The PUT conflicted (a wrap already stands for D), but the wrap went over the channel first.
    expect(d.keyring.unlocked).toBe(true);
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
