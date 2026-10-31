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
import { defaultTimer } from "../../src/connect/channel.js";
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

/** A timer that records what is scheduled; with `only`, other delays run for real. */
function capturedTimers(only?: number) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const timer = (fn: () => void, ms: number): (() => void) => {
    if (only !== undefined && ms !== only) return defaultTimer(fn, ms);
    const t = { fn, ms, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  };
  return { timers, timer };
}

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
    const { timers, timer } = capturedTimers();
    const m = await approver("Ana's laptop");
    const r = await request({ timer });
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

// ── CC-15 red round: N1, N8 and N10 ─────────────────────────────────────────────────────────────

/** A new approver appears after the answer: it is not dialled, listed or choosable. */
async function expectNoMoreDials(r: NearbyRequest): Promise<void> {
  const mal = await approver("Mal");
  await new Promise((res) => setTimeout(res, 150));
  expect(r.approvers).toEqual([]);
  expect(mal.approvals).toHaveLength(0);
  await expect(r.choose("ap_ffffffffffff")).rejects.toMatchObject({
    reason: "closed",
  });
}

describe("N1: one answer per request", () => {
  it("after approved, a later approver is not dialled, listed or choosable", async () => {
    const { r, a } = await vouched();
    await a.close();
    await until(() => r.approvers.length === 0);
    await expectNoMoreDials(r);
  });

  it("after confirmAccount, a later approver is not dialled or choosable either", async () => {
    const { r, a } = await vouched();
    await r.confirmAccount();
    await a.close();
    await expectNoMoreDials(r);
  });
});

describe("N8: an idle unchosen session is replaced after 20 s", () => {
  it("closes it peer_bye and dials the approver again", async () => {
    const { timers, timer } = capturedTimers(20_000);
    await approver("Ana's laptop");
    const r = await request({ timer });
    await until(() => r.approvers.length === 1);
    const first = r.approvers[0]!.id;
    const idle = timers.filter((t) => t.live);
    expect(idle).toHaveLength(1);
    idle[0]!.fn();
    await until(
      () => r.approvers.length === 1 && r.approvers[0]!.id !== first,
      3000,
    );
    await expect(r.choose(first)).rejects.toMatchObject({
      reason: "unknown_peer",
    });
  });

  it("starts no idle clock on a session the person chose", async () => {
    const { timers, timer } = capturedTimers(20_000);
    const m = await approver("Ana's laptop");
    const r = await request({ timer });
    await until(() => r.approvers.length === 1);
    await r.choose(r.approvers[0]!.id);
    await until(() => m.approvals.length === 1);
    expect(timers.filter((t) => t.live)).toHaveLength(0);
  });
});

describe("N10: the request is checked when it starts", () => {
  it.each([
    ["a handle that is not nr_ and 22 characters", { request: "nr_short" }],
    ["a request that is not a string", { request: 7 as unknown as string }],
    ["a label that is not a string", { label: 7 as unknown as string }],
    ["a label of 300 characters", { label: "x".repeat(300) }],
    ["an expiresIn of 0", { expiresIn: 0 }],
    ["a negative expiresIn", { expiresIn: -5 }],
    ["an expiresIn that is not a number", { expiresIn: Number.NaN }],
  ])("refuses %s", async (_name, o) => {
    await expect(request(o)).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  it("clamps expiresIn to 300 s", async () => {
    const seen: number[] = [];
    const r = await request({
      expiresIn: 9_999,
      timer: (fn, ms) => {
        seen.push(ms);
        return defaultTimer(fn, ms);
      },
    });
    expect(seen).toContain(300_000);
    expect(seen).not.toContain(9_999_000);
    void r;
  });

  it("a throwing host callback cannot skip the cleanup", async () => {
    const m = await approver("Ana's laptop");
    const r = await request();
    await until(() => r.approvers.length === 1);
    const lists: number[] = [];
    r.onApprovers(() => {
      throw new Error("host bug");
    });
    r.onApprovers((l) => lists.push(l.length));
    r.onClose(() => {
      throw new Error("host bug");
    });
    const closed: string[] = [];
    await r.choose(r.approvers[0]!.id);
    await until(() => m.approvals.length === 1);
    m.approvals[0]!.onClose((c) => closed.push(c.code));
    expect(lists.length).toBeGreaterThan(0);
    await expect(r.close()).resolves.toBeUndefined();
    await until(() => closed.length === 1);
    expect(r.closed).toBe(true);
  });
});
