// @pkey-feature connect.lan
// The approver half of nearby approval (CC-15.N2; WIRE-CONTRACT-V5 §15.6.1): the advert and its
// renewal, the sessions that hold at HELLO, three codes and one prompt at a time, the right pick
// delivering a verified `VOUCH_REQ`, the wrong pick, the failure budget, `finish` and its guard,
// and the accept limits. D is a bare mode-v engine over a real loopback socket.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advertEpoch, productTag } from "@polaris-key/client-core/peer";
import {
  NearbyApprover,
  type ApproverSource,
  type NearbyApproval,
  type NearbyApproverHandle,
  type NearbyApproverOptions,
} from "../../src/connect/nearbyApprover.js";
import { MemoryMdnsNetwork, T0, until } from "../lanFixtures.js";
import {
  SLUG,
  D_ID,
  REQUEST,
  RawD,
  approverAdverts,
} from "./nearbyFixtures.js";

let net: MemoryMdnsNetwork;
let handles: NearbyApproverHandle[] = [];
let ds: RawD[] = [];
let approvals: NearbyApproval[] = [];
let notices: unknown[] = [];
let stops: string[] = [];
let timers: { fn: () => void; ms: number; live: boolean }[] = [];
let signedIn = true;
let served = true;

const src: ApproverSource = {
  slug: SLUG,
  now: () => T0,
  signedIn: async () => signedIn,
  nearbyServed: async () => served,
};
const timer = (fn: () => void, ms: number): (() => void) => {
  const t = { fn, ms, live: true };
  timers.push(t);
  return () => {
    t.live = false;
  };
};
const fire = (ms: number): void => {
  for (const t of timers.filter((x) => x.live && x.ms === ms)) {
    t.live = false;
    t.fn();
  }
};

async function start(
  o: Partial<NearbyApproverOptions> = {},
): Promise<NearbyApproverHandle> {
  const h = await NearbyApprover.start(src, (a) => approvals.push(a), {
    prompt: true,
    label: "Ana's laptop",
    mdns: net.adapter(),
    host: "127.0.0.1",
    allowLoopback: true,
    timer,
    onNotice: (n) => notices.push(n),
    onStopped: (w) => stops.push(w),
    ...o,
  });
  handles.push(h);
  return h;
}

/** A D that dialled and chose this approver; resolves once the codes are on M's screen. */
async function chosen(
  o: { port?: number; auto?: boolean; wait?: boolean } = {},
): Promise<RawD> {
  const d = await RawD.dial(net, { auto: o.auto ?? false, port: o.port });
  ds.push(d);
  await d.waitFor(() => d.hello !== null);
  await d.startSas();
  if (o.wait !== false) await d.waitFor(() => d.code !== null);
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
  net = new MemoryMdnsNetwork();
  signedIn = served = true;
  approvals = [];
  notices = [];
  stops = [];
  timers = [];
});
afterEach(async () => {
  await Promise.all(ds.splice(0).map((d) => d.close().catch(() => undefined)));
  await Promise.all(handles.splice(0).map((h) => h.stop()));
  vi.useRealTimers();
});

describe("the approver advert", () => {
  it("advertises a random p1- instance with v=1, m=v and the product tag", async () => {
    await start();
    const [a] = approverAdverts(net);
    expect(a!.instance).toMatch(/^p1-[a-z2-7]{16}$/);
    expect(a!.txt).toEqual([
      "v=1",
      "m=v",
      `h=${await productTag(SLUG, advertEpoch(T0))}`,
    ]);
  });

  it("renews with a new instance and port; the old listener accepts nothing more", async () => {
    await start();
    const first = approverAdverts(net)[0]!;
    fire(300_000);
    await until(() => approverAdverts(net)[0]?.instance !== first.instance);
    const second = approverAdverts(net)[0]!;
    expect(approverAdverts(net)).toHaveLength(1);
    expect(second.port).not.toBe(first.port);
    // The old port is closed.
    await expect(RawD.dial(net, { port: first.port })).rejects.toBeDefined();
  });

  it("keeps a session that is past the transport across a renewal", async () => {
    await start();
    const d = await chosen();
    fire(300_000);
    await until(
      () =>
        approverAdverts(net).length === 1 &&
        approverAdverts(net)[0]!.port !== undefined,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(d.closed).toBeNull();
    expect(approvals).toHaveLength(1);
  });

  it("stops at a renewal when the device signed out or discovery lost nearby", async () => {
    await start();
    signedIn = false;
    fire(300_000);
    await until(() => stops.length === 1);
    expect(stops).toEqual(["signed-out"]);
    expect(approverAdverts(net)).toHaveLength(0);

    signedIn = true;
    const h2 = await start();
    served = false;
    fire(300_000);
    await until(() => stops.length === 2);
    expect(stops[1]).toBe("discovery");
    expect(h2.status().state).toBe("stopped");
  });

  it("pause() takes the advert down and closes live sessions; resume() starts a new one", async () => {
    const h = await start();
    const before = approverAdverts(net)[0]!;
    const d = await chosen();
    await h.pause();
    expect(approverAdverts(net)).toHaveLength(0);
    await d.waitFor(() => d.closed !== null);
    expect(d.closed!.code).toBe("peer_bye");
    await h.resume();
    expect(approverAdverts(net)[0]!.instance).not.toBe(before.instance);
  });
});

describe("holding and the prompt", () => {
  it("shows nothing until D's person chose: a session held at HELLO raises no prompt", async () => {
    await start();
    const d = await RawD.dial(net, { auto: false });
    ds.push(d);
    await d.waitFor(() => d.hello !== null);
    await new Promise((r) => setTimeout(r, 80));
    expect(approvals).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it("shows three distinct codes, D's among them, with the HELLO label and platform", async () => {
    await start();
    const d = await chosen();
    await until(() => approvals.length === 1);
    const a = approvals[0]!;
    expect(a.label).toBeNull();
    expect(a.platform).toBe(process.platform);
    expect(new Set(a.codes).size).toBe(3);
    const real = String(d.code).padStart(6, "0");
    expect(a.codes.map((c) => c.replace(" ", ""))).toContain(real);
    for (const c of a.codes) expect(c).toMatch(/^\d{3} \d{3}$/);
  });

  it("with the prompt closed a session raises a notice and takes no pick", async () => {
    const h = await start({ prompt: false });
    const d = await chosen();
    await until(() => notices.length === 1);
    expect(approvals).toHaveLength(0);
    // Opening the screen shows the waiting session.
    await h.setPrompt(true);
    await until(() => approvals.length === 1);
    expect(d.closed).toBeNull();
  });

  it("shows one prompt at a time; the next shows when the first ends", async () => {
    await start({ maxPendingPerAddress: 4 });
    const d1 = await chosen();
    await until(() => approvals.length === 1);
    const d2 = await chosen();
    // The second is at the code stage too, but waits with no code shown.
    await new Promise((r) => setTimeout(r, 60));
    expect(approvals).toHaveLength(1);
    expect(d2.closed).toBeNull();
    await approvals[0]!.decline();
    await d1.waitFor(() => d1.closed !== null);
    await until(() => approvals.length === 2);
    expect(d2.closed).toBeNull();
  });
});

describe("the pick", () => {
  it("the right code delivers a verified VOUCH_REQ with exactly D's keys", async () => {
    await start();
    const d = await chosen({ auto: false });
    await until(() => approvals.length === 1);
    const a = approvals[0]!;
    await d.showAndRequest();
    const real = a.codes.find(
      (c) => c.replace(" ", "") === String(d.code).padStart(6, "0"),
    )!;
    const r = await a.pick(real);
    const k = await d.keys.ensure();
    expect(r).toMatchObject({
      request: REQUEST,
      deviceId: D_ID,
      signKey: k.signKey,
      agreeKey: k.agreeKey,
      label: null,
    });
  });

  it("a wrong pick closes peer_bye, delivers no request and refuses finish", async () => {
    await start();
    const d = await chosen();
    await until(() => approvals.length === 1);
    await d.showAndRequest();
    const a = approvals[0]!;
    const decoy = a.codes.find(
      (c) => c.replace(" ", "") !== String(d.code).padStart(6, "0"),
    )!;
    expect(await a.pick(decoy)).toBe("mismatch");
    await d.waitFor(() => d.closed !== null);
    expect(d.closed!.code).toBe("peer_bye");
    await expect(
      a.finish({
        http: 200,
        body: '{"status":"approved"}',
        discoveryNearby: true,
      }),
    ).rejects.toMatchObject({ reason: "closed" });
    expect(d.result()).toBeNull();
  });

  it("finish before a pick is refused", async () => {
    await start();
    await chosen();
    await until(() => approvals.length === 1);
    await expect(
      approvals[0]!.finish({
        http: 200,
        body: '{"status":"approved"}',
        discoveryNearby: true,
      }),
    ).rejects.toMatchObject({ reason: "not_picked" });
  });

  it("a request that does not verify closes peer_bad_frame and answers invalid", async () => {
    await start();
    const d = await chosen();
    await until(() => approvals.length === 1);
    await d.showAndRequest((b) => {
      const o = JSON.parse(new TextDecoder().decode(b)) as Record<
        string,
        unknown
      >;
      o.request = "nr_AAAAAAAAAAAAAAAAAAAAAA";
      return new TextEncoder().encode(JSON.stringify(o));
    });
    const a = approvals[0]!;
    const real = a.codes.find(
      (c) => c.replace(" ", "") === String(d.code).padStart(6, "0"),
    )!;
    expect(await a.pick(real)).toBe("invalid");
    await d.waitFor(() => d.closed !== null);
    expect(d.closed!.code).toBe("peer_bad_frame");
  });

  it("decline closes peer_bye with no request delivered", async () => {
    await start();
    const d = await chosen();
    await until(() => approvals.length === 1);
    await d.showAndRequest();
    await approvals[0]!.decline();
    await d.waitFor(() => d.closed !== null);
    expect(d.closed!.code).toBe("peer_bye");
  });
});

describe("the failure budget", () => {
  it("stops the advert at the second prompted failure and starts again on reopen", async () => {
    const h = await start({ mono: () => 100 });
    const d1 = await chosen();
    await until(() => approvals.length === 1);
    await approvals[0]!.decline();
    await d1.waitFor(() => d1.closed !== null);
    expect(stops).toEqual([]);
    const d2 = await chosen();
    await until(() => approvals.length === 2);
    await approvals[1]!.decline();
    await d2.waitFor(() => d2.closed !== null);
    await until(() => stops.length === 1);
    expect(stops).toEqual(["budget"]);
    expect(approverAdverts(net)).toHaveLength(0);
    await h.reopen();
    expect(approverAdverts(net)).toHaveLength(1);
    expect(h.status().state).toBe("advertising");
  });

  it("counts a 120 s timeout of a shown prompt, not the host's close", async () => {
    await start({ mono: () => 100 });
    const d1 = await chosen();
    await until(() => approvals.length === 1);
    await approvals[0]!.close();
    await d1.waitFor(() => d1.closed !== null);
    const d2 = await chosen();
    await until(() => approvals.length === 2);
    // The engine's deadline (120 s) runs out on a shown prompt: the first counted failure.
    fire(120_000);
    await d2.waitFor(() => d2.closed !== null);
    expect(stops).toEqual([]);
  });
});

describe("finish", () => {
  async function picked(): Promise<{ d: RawD; a: NearbyApproval }> {
    const d = await chosen();
    await until(() => approvals.length === 1);
    await d.showAndRequest();
    const a = approvals.at(-1)!;
    const real = a.codes.find(
      (c) => c.replace(" ", "") === String(d.code).padStart(6, "0"),
    )!;
    expect(await a.pick(real)).toMatchObject({ request: REQUEST });
    return { d, a };
  }

  it("approved reaches D, then a Sync record is carried", async () => {
    await start();
    const { d, a } = await picked();
    expect(
      await a.finish({
        http: 200,
        body: '{"status":"approved"}',
        discoveryNearby: true,
      }),
    ).toEqual({ sent: "approved" });
    await d.waitFor(() => d.result() !== null);
    expect(d.result()).toBe("approved");
    await a.sendRecord(0x0030, new Uint8Array([1, 2, 3]));
    await d.waitFor(() => d.records.some((r) => r.type === 0x0030));
    await expect(a.sendRecord(0x0100, new Uint8Array(1))).rejects.toMatchObject(
      {
        reason: "bad_type",
      },
    );
    // The result is sent once.
    await expect(
      a.finish({ http: 204, body: null, discoveryNearby: true }),
    ).rejects.toBeDefined();
  });

  it.each([
    [204, null, "denied"],
    [403, '{"code":"not_nearby"}', "denied"],
    [403, '{"code":"device_limit"}', "denied"],
    [404, null, "expired"],
  ])(
    "answer %s %s sends %s and closes peer_bye",
    async (http, body, status) => {
      await start();
      const { d, a } = await picked();
      expect(await a.finish({ http, body, discoveryNearby: true })).toEqual({
        sent: status,
      });
      await d.waitFor(() => d.closed !== null);
      expect(d.result()).toBe(status);
      expect(d.closed!.code).toBe("peer_bye");
    },
  );

  it("a 404 after discovery lost nearby sends nothing, closes and stops the advert", async () => {
    await start();
    const { d, a } = await picked();
    expect(
      await a.finish({ http: 404, body: null, discoveryNearby: false }),
    ).toEqual({
      closed: true,
    });
    await d.waitFor(() => d.closed !== null);
    expect(d.result()).toBeNull();
    await until(() => stops.includes("discovery"));
  });

  it("device_keys_required waits once for the keys; a second one closes", async () => {
    await start();
    const { d, a } = await picked();
    const need = {
      http: 409,
      body: '{"code":"device_keys_required"}',
      discoveryNearby: true,
    };
    expect(await a.finish(need)).toEqual({ wait: "keys" });
    expect(await a.finish(need)).toEqual({ closed: true });
    await d.waitFor(() => d.closed !== null);
    expect(d.result()).toBeNull();
  });

  it("choose waits for the licence choice, as many times as it is asked", async () => {
    await start();
    const { a } = await picked();
    const choose = {
      http: 200,
      body: '{"status":"choose"}',
      discoveryNearby: true,
    };
    expect(await a.finish(choose)).toEqual({ wait: "choice" });
    expect(await a.finish(choose)).toEqual({ wait: "choice" });
  });

  it("closes the session 300 s after the pick", async () => {
    await start();
    const { d } = await picked();
    fire(300_000);
    await d.waitFor(() => d.closed !== null);
    expect(d.closed!.code).toBe("peer_bye");
  });
});

describe("the accept limits", () => {
  it("refuses a second waiting connection from one source address", async () => {
    await start();
    const d1 = await RawD.dial(net, { auto: false });
    ds.push(d1);
    await d1.waitFor(() => d1.hello !== null);
    const d2 = await RawD.dial(net, { auto: false });
    ds.push(d2);
    await d2.waitFor(() => d2.closed !== null);
    expect(d2.hello).toBeNull();
    expect(d1.closed).toBeNull();
  });
});
