// @pkey-feature connect.lan
// Nearby approval, end to end in one process (CC-15.N4; WIRE-CONTRACT-V5 §15.6.1): a signed-in
// client M and a client D with no sign-in meet on a fake LAN through `client.cloudConnect.nearby`.
// D lists M, the person taps it, the codes match, D's `VOUCH_REQ` is verified, M "calls approve"
// on a fake that holds the key-binding rule (the Worker half is I-40 and I-47's), `approved`
// reaches D and the wrap is delivered once D's person confirms the account. Also: the gating by
// Identity discovery with Connect off, a wrong pick, and sign-out stopping the advert.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PolarisKeyClient } from "../../src/client.js";
import type {
  NearbyApproval,
  NearbyApproverHandle,
  NearbyRequest,
} from "../../src/connect/index.js";
import {
  BASE,
  MemoryMdnsNetwork,
  MultiWorker,
  PRODUCT,
  T0,
  devId,
  makeClient,
  until,
} from "../lanFixtures.js";
import { FakeNearbyWorker, REQUEST } from "./nearbyFixtures.js";

const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;

/** The Worker fake with Identity's discovery fragment, and `nearby` on or off. */
class NearbyWorld extends MultiWorker {
  nearby = true;
  constructor() {
    super();
    const base = this.fetch;
    this.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith("/.well-known/polaris.json")) {
        const identity = {
          enabled: true,
          configured: true,
          nearby: this.nearby ? true : undefined,
          endpoints: {
            session: `${BASE}/${PRODUCT}/identity/session`,
            nearbyStart: `${BASE}/${PRODUCT}/identity/nearby/start`,
            nearbyApprove: `${BASE}/${PRODUCT}/identity/nearby/approve`,
            nearbyPoll: `${BASE}/${PRODUCT}/identity/nearby/poll`,
          },
        };
        return new Response(
          JSON.stringify({
            product: PRODUCT,
            services: {
              identity,
              connect: { enabled: false },
            },
          }),
          { status: 200 },
        );
      }
      return base(input, init);
    }) as typeof fetch;
  }
}

let dirs: string[] = [];
let handles: NearbyApproverHandle[] = [];
let requests: NearbyRequest[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
});
afterEach(async () => {
  await Promise.all(requests.splice(0).map((r) => r.close()));
  await Promise.all(handles.splice(0).map((h) => h.stop()));
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Mark a client signed in, as a finished sign-in leaves it (identity.json beside the token). */
function signIn(c: PolarisKeyClient): void {
  const state = (c as unknown as { core: { dirs: { state: string } } }).core
    .dirs.state;
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "identity.json"),
    JSON.stringify({ email: "ana@example.test", signedInAt: T0 }),
  );
}

async function world() {
  const w = new NearbyWorld();
  const m = await makeClient(w, "1", dirs);
  const d = await makeClient(w, "2", dirs);
  signIn(m);
  return {
    w,
    m,
    d,
    net: new MemoryMdnsNetwork(),
    fake: new FakeNearbyWorker(),
  };
}

async function approve(
  m: PolarisKeyClient,
  net: MemoryMdnsNetwork,
  approvals: NearbyApproval[],
  o: { prompt?: boolean } = {},
): Promise<NearbyApproverHandle> {
  const h = await m.cloudConnect.nearby.onRequest((a) => approvals.push(a), {
    prompt: o.prompt ?? true,
    label: "Ana's laptop",
    mdns: net.adapter(),
    ...LOOP,
  });
  handles.push(h);
  return h;
}

async function ask(
  d: PolarisKeyClient,
  net: MemoryMdnsNetwork,
  fake: FakeNearbyWorker,
): Promise<NearbyRequest> {
  // D's `nearby/start` registers its keys and device id under the handle.
  const { port, deviceId } = await d.connect.nearbySigner();
  await fake.register(REQUEST, port, deviceId);
  const r = await d.cloudConnect.nearby.request({
    request: REQUEST,
    label: "New phone",
    mdns: net.adapter(),
    allowLoopback: true,
  });
  requests.push(r);
  return r;
}

const showing = (a: NearbyApproval, code: string): string =>
  a.codes.find((c) => c.replace(" ", "") === code.replace(" ", ""))!;

describe("nearby approval, two clients over the fake LAN", () => {
  it("runs a full vouch with Connect off: list, tap, codes, pick, approve, result, wrap", async () => {
    const { m, d, net, fake } = await world();
    fake.mHasKeys = false;
    const approvals: NearbyApproval[] = [];
    await approve(m, net, approvals);
    const r = await ask(d, net, fake);
    await until(() => r.approvers.length === 1);
    expect(r.approvers[0]).toMatchObject({ label: "Ana's laptop" });

    const { code } = await r.choose(r.approvers[0]!.id);
    await until(() => approvals.length === 1);
    const a = approvals[0]!;
    expect(a.codes.map((c) => c.replace(" ", ""))).toContain(
      code.replace(" ", ""),
    );

    const req = await a.pick(showing(a, code));
    if (typeof req === "string") throw new Error(`pick: ${req}`);
    expect(req.deviceId).toBe(devId("2"));

    // The first approve answers device_keys_required: M registers its keys, then asks once more.
    let ans = fake.approve(req);
    expect(ans.http).toBe(409);
    expect(await a.finish({ ...ans, discoveryNearby: true })).toEqual({
      wait: "keys",
    });
    fake.mHasKeys = true;
    ans = fake.approve(req);
    expect(fake.calls.every((c) => c.deviceId === devId("2"))).toBe(true);
    expect(await a.finish({ ...ans, discoveryNearby: true })).toEqual({
      sent: "approved",
    });
    await until(() => r.result === "approved");

    // The wrap is delivered only after D's person confirms the signed-in account.
    const got: number[] = [];
    r.onRecord((x) => got.push(x.type));
    await a.sendRecord(0x0030, new Uint8Array([7]));
    await new Promise((res) => setTimeout(res, 60));
    expect(got).toEqual([]);
    await r.confirmAccount();
    expect(got).toEqual([0x0030]);
    expect(fake.approved).toEqual([devId("2")]);
  });

  it("a wrong pick calls no route and delivers nothing", async () => {
    const { m, d, net, fake } = await world();
    const approvals: NearbyApproval[] = [];
    await approve(m, net, approvals);
    const r = await ask(d, net, fake);
    await until(() => r.approvers.length === 1);
    const { code } = await r.choose(r.approvers[0]!.id);
    await until(() => approvals.length === 1);
    const decoy = approvals[0]!.codes.find(
      (c) => c.replace(" ", "") !== code.replace(" ", ""),
    )!;
    expect(await approvals[0]!.pick(decoy)).toBe("mismatch");
    await until(() => r.approvers.length === 0 && r.result === null);
    expect(fake.calls).toEqual([]);
    expect(r.result).toBeNull();
  });

  it("sign-out stops the advert and the sessions", async () => {
    const { m, d, net, fake } = await world();
    const approvals: NearbyApproval[] = [];
    await approve(m, net, approvals);
    expect([...net.adverts.values()].some((a) => a.txt.includes("m=v"))).toBe(
      true,
    );
    const r = await ask(d, net, fake);
    await until(() => r.approvers.length === 1);
    const closes: string[] = [];
    r.onClose((c) => closes.push(c));
    const { code: _code } = await r.choose(r.approvers[0]!.id);
    await until(() => approvals.length === 1);
    await m.cloudConnect.stopForSignOut();
    expect([...net.adverts.values()].some((a) => a.txt.includes("m=v"))).toBe(
      false,
    );
    await until(() => closes.length === 1);
    expect(closes).toEqual(["peer_bye"]);
  });
});

describe("gating", () => {
  it("answers the typed N/A when discovery does not name nearby", async () => {
    const { w, m, d, net, fake } = await world();
    w.nearby = false;
    await expect(
      m.cloudConnect.nearby.onRequest(() => undefined, {
        prompt: true,
        mdns: net.adapter(),
        ...LOOP,
      }),
    ).rejects.toMatchObject({ code: "service-unavailable" });
    await expect(ask(d, net, fake)).rejects.toMatchObject({
      code: "service-unavailable",
      feature: "identity.nearby",
    });
  });

  it("refuses to approve while signed out", async () => {
    const { d, net } = await world();
    await expect(
      d.cloudConnect.nearby.onRequest(() => undefined, {
        prompt: true,
        mdns: net.adapter(),
        ...LOOP,
      }),
    ).rejects.toMatchObject({ code: "account_required" });
  });
});
