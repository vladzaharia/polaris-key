// @pkey-feature connect.lan
// The requester half of nearby approval (CC-15.N3; WIRE-CONTRACT-V5 §15.6.1): browse for `m=v`
// adverts of this product, dial at most four at random with the code held, list them by their
// `HELLO`, start the code on the one the person tapped and close the rest `peer_bye`, send
// `VOUCH_REQ` after the code, read `VOUCH_RESULT`, hold Sync records until the account is
// confirmed, and end at `expiresIn`. The approvers are real `NearbyApprover`s on the fake LAN.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NearbyApprover,
  type ApproverSource,
  type NearbyApproval,
  type NearbyApproverHandle,
} from "../../src/connect/nearbyApprover.js";
import {
  NearbyRequester,
  type NearbyRequest,
  type RequesterSource,
} from "../../src/connect/nearbyRequester.js";
import { MemoryMdnsNetwork, T0, until } from "../lanFixtures.js";
import {
  D_ID,
  FakeNearbyWorker,
  REQUEST,
  SLUG,
  memoryKeys,
} from "./nearbyFixtures.js";

let net: MemoryMdnsNetwork;
let approvers: { h: NearbyApproverHandle; approvals: NearbyApproval[] }[] = [];
let requests: NearbyRequest[] = [];
const keys = memoryKeys();

const dSrc = (): RequesterSource => ({
  slug: SLUG,
  now: () => T0,
  signer: async () => ({ port: keys, deviceId: D_ID }),
});

async function approver(
  label: string,
  slug = SLUG,
): Promise<{ h: NearbyApproverHandle; approvals: NearbyApproval[] }> {
  const approvals: NearbyApproval[] = [];
  const src: ApproverSource = {
    slug,
    now: () => T0,
    signedIn: async () => true,
    nearbyServed: async () => true,
  };
  const h = await NearbyApprover.start(src, (a) => approvals.push(a), {
    prompt: true,
    label,
    mdns: net.adapter(),
    host: "127.0.0.1",
    allowLoopback: true,
  });
  const a = { h, approvals };
  approvers.push(a);
  return a;
}

async function request(
  o: Partial<Parameters<typeof NearbyRequester.start>[1]> = {},
): Promise<NearbyRequest> {
  const r = await NearbyRequester.start(dSrc(), {
    request: REQUEST,
    label: "New phone",
    mdns: net.adapter(),
    allowLoopback: true,
    ...o,
  });
  requests.push(r);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
  net = new MemoryMdnsNetwork();
});
afterEach(async () => {
  await Promise.all(requests.splice(0).map((r) => r.close()));
  await Promise.all(approvers.splice(0).map((a) => a.h.stop()));
  vi.useRealTimers();
});

const realCode = (a: NearbyApproval, code: string): string =>
  a.codes.find((c) => c.replace(" ", "") === code.replace(" ", ""))!;

describe("browsing and the list", () => {
  it("lists approvers by their HELLO and prompts none of them", async () => {
    await approver("Ana's laptop");
    await approver("Ben's tablet");
    const r = await request();
    await until(() => r.approvers.length === 2);
    expect(r.approvers.map((a) => a.label).sort()).toEqual([
      "Ana's laptop",
      "Ben's tablet",
    ]);
    for (const a of r.approvers) expect(a.platform).toBe(process.platform);
    await new Promise((res) => setTimeout(res, 80));
    // The person has not chosen: nobody shows a code.
    expect(approvers.every((a) => a.approvals.length === 0)).toBe(true);
  });

  it("dials at most four approvers at once", async () => {
    for (let i = 0; i < 6; i++) await approver(`device ${i}`);
    const r = await request();
    await until(() => r.approvers.length === 4);
    await new Promise((res) => setTimeout(res, 120));
    expect(r.approvers).toHaveLength(4);
  });

  it("ignores an advert of another product", async () => {
    await approver("Other app", "otherapp");
    const mine = await approver("Mine");
    const r = await request();
    await until(() => r.approvers.length >= 1);
    await new Promise((res) => setTimeout(res, 80));
    expect(r.approvers.map((a) => a.label)).toEqual(["Mine"]);
    void mine;
  });

  it("drops an approver whose session ends from the list", async () => {
    const a = await approver("Ana's laptop");
    await approver("Ben's tablet");
    const r = await request();
    await until(() => r.approvers.length === 2);
    await a.h.pause();
    await until(() => r.approvers.length === 1);
    expect(r.approvers[0]!.label).toBe("Ben's tablet");
  });

  it("an unknown id is refused", async () => {
    await approver("Ana");
    const r = await request();
    await until(() => r.approvers.length === 1);
    await expect(r.choose("ap_ffffffffffff")).rejects.toMatchObject({
      reason: "unknown_peer",
    });
  });
});

describe("the choice", () => {
  it("starts the code on the chosen approver only; the others close peer_bye", async () => {
    const ana = await approver("Ana's laptop");
    const ben = await approver("Ben's tablet");
    const r = await request();
    await until(() => r.approvers.length === 2);
    const pick = r.approvers.find((a) => a.label === "Ben's tablet")!;
    const { code } = await r.choose(pick.id);
    expect(code).toMatch(/^\d{3} \d{3}$/);
    await until(() => ben.approvals.length === 1);
    expect(realCode(ben.approvals[0]!, code)).toBeDefined();
    await new Promise((res) => setTimeout(res, 80));
    // Ana never prompted, and her session is gone.
    expect(ana.approvals).toHaveLength(0);
    expect(r.approvers).toEqual([]);
    expect(() => r.choose(pick.id)).rejects.toBeDefined();
  });

  it("runs the whole vouch: the code matches, VOUCH_REQ is verified, approved reaches D", async () => {
    const { r, req } = await vouched();
    expect(req).toMatchObject({
      request: REQUEST,
      deviceId: D_ID,
      label: "New phone",
    });
    await until(() => r.result === "approved");
  });

  it("a wrong pick ends the chosen session; the request goes on and the person may choose again", async () => {
    const m = await approver("Ana's laptop");
    const r = await request();
    await until(() => r.approvers.length === 1);
    const closes: string[] = [];
    r.onClose((c) => closes.push(c));
    const { code } = await r.choose(r.approvers[0]!.id);
    await until(() => m.approvals.length === 1);
    const decoy = m.approvals[0]!.codes.find(
      (c) => c.replace(" ", "") !== code.replace(" ", ""),
    )!;
    expect(await m.approvals[0]!.pick(decoy)).toBe("mismatch");
    await until(() => closes.length === 1);
    expect(closes).toEqual(["peer_bye"]);
    expect(r.result).toBeNull();
    expect(r.closed).toBe(false);
  });
});

/** The whole vouch up to `approved`: the person taps, the codes match, M approves. */
async function vouched() {
  const worker = new FakeNearbyWorker();
  await worker.register(REQUEST, keys, D_ID);
  worker.mHasKeys = true;
  const m = await approver("Ana's laptop");
  const r = await request();
  await until(() => r.approvers.length === 1);
  const { code } = await r.choose(r.approvers[0]!.id);
  await until(() => m.approvals.length === 1);
  const a = m.approvals[0]!;
  const req = await a.pick(realCode(a, code));
  if (typeof req === "string") throw new Error("not a request");
  await a.finish({ ...worker.approve(req), discoveryNearby: true });
  await until(() => r.result === "approved");
  return { r, a, req };
}

describe("the account gate", () => {
  async function approved() {
    const { r, a } = await vouched();
    const got: number[] = [];
    r.onRecord((x) => got.push(x.type));
    return { r, a, got };
  }

  it("holds a wrap until the person confirmed the account, then hands it over", async () => {
    const { r, a, got } = await approved();
    await a.sendRecord(0x0030, new Uint8Array([9]));
    await new Promise((res) => setTimeout(res, 80));
    expect(got).toEqual([]);
    await r.confirmAccount();
    expect(got).toEqual([0x0030]);
    await a.sendRecord(0x0031, new Uint8Array([9]));
    await until(() => got.length === 2);
  });

  it("a decline drops the held records and closes the session", async () => {
    const { r, a, got } = await approved();
    const closes: string[] = [];
    r.onClose((c) => closes.push(c));
    await a.sendRecord(0x0030, new Uint8Array([9]));
    await r.declineAccount();
    await until(() => closes.length === 1);
    expect(got).toEqual([]);
  });
});

describe("the end", () => {
  it("expires at expiresIn: the sessions close peer_bye and onClose says expired", async () => {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const m = await approver("Ana's laptop");
    const r = await request({
      timer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
    });
    await until(() => r.approvers.length === 1);
    const closes: string[] = [];
    r.onClose((c) => closes.push(c));
    timers.find((t) => t.ms === 300_000 && t.live)!.fn();
    await until(() => r.closed);
    expect(closes).toEqual(["expired"]);
    expect(m.approvals).toHaveLength(0);
  });

  it("an abort signal closes the request", async () => {
    await approver("Ana");
    const ac = new AbortController();
    const r = await request({ signal: ac.signal });
    await until(() => r.approvers.length === 1);
    ac.abort();
    await until(() => r.closed);
  });
});
