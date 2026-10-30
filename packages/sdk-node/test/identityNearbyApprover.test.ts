// @pkey-feature identity.nearby
// The approver (M) of nearby sign-in (I-47.7): `identity.nearby.onRequest` over CC-15's LAN half
// (a fake `NearbyApproval` whose `finish()` is the engine's own `finishMap`) and the real route
// client against a fake Worker. No silent approval, exactly the verified request's ids and keys,
// deny only after a matched code, the licence-choice loop, and every Worker answer reading as
// the ui-matrix NearbyApproval step it is.

import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { finishMap } from "@polaris-key/client-core/peer";
import type { VouchRequest } from "@polaris-key/client-core/peer";
import type {
  ApproveAnswerInput,
  FinishOutcome,
  NearbyApproval,
} from "../src/connect/nearbyApprover.js";
import { LanError } from "../src/connect/session.js";
import {
  onNearbyRequest,
  type NearbyApproverKeyring,
} from "../src/identity/nearbyApprover.js";
import type {
  NearbyApprovalStep,
  NearbyAsk,
} from "../src/identity/nearbyApprover.js";
import type { NearbyRoutes } from "../src/identity/nearby.js";
import { identityDiscovery, json } from "./parityFixtures.js";
import type { Handler } from "./parityFixtures.js";
import { FRAGMENT, REQ, nearbyClient } from "./identityNearbyFixtures.js";
import { fixtureKeys } from "../../../conformance/runners/node/nearbyActions.js";

const D = fixtureKeys("approver-d");
const VOUCH: VouchRequest = {
  request: REQ,
  deviceId: "TRANSCRIPTDEVICE0000000000000001",
  signKey: D.signKey,
  agreeKey: D.agreeKey,
  label: "Living-room console",
  platform: "linux",
};
const CODES = ["111 111", "482 913", "222 222"] as const;
const RIGHT = "482 913";

/** CC-15's `NearbyApproval`, with the engine's own `finishMap` behind `finish()`. */
class FakeApproval implements NearbyApproval {
  label: string | null = "Living-room console";
  platform = "linux";
  codes = [...CODES];
  picks: string[] = [];
  declined = 0;
  closes = 0;
  finishes: ApproveAnswerInput[] = [];
  sent: { type: number; body: Uint8Array }[] = [];
  sentResults: string[] = [];
  keysRetried = false;
  finishError: Error | null = null;
  async pick(code: string) {
    this.picks.push(code);
    return code === RIGHT ? VOUCH : ("mismatch" as const);
  }
  async decline(): Promise<void> {
    this.declined++;
  }
  async finish(answer: ApproveAnswerInput): Promise<FinishOutcome> {
    this.finishes.push(answer);
    if (this.finishError !== null) throw this.finishError;
    const act = finishMap({ ...answer, keysRetried: this.keysRetried });
    if ("send" in act) {
      this.sentResults.push(act.send);
      return { sent: act.send };
    }
    if ("wait" in act) {
      if (act.wait === "keys") this.keysRetried = true;
      return act;
    }
    this.closes++;
    return { closed: true };
  }
  async sendRecord(type: number, body: Uint8Array): Promise<void> {
    this.sent.push({ type, body });
  }
  async close(): Promise<void> {
    this.closes++;
  }
  onClose(): () => void {
    return () => undefined;
  }
}

interface Approver {
  asks: NearbyAsk[];
  seen: { path: string; body: string | null }[];
  approvals: () => {
    decision: string;
    choice?: unknown;
    [k: string]: unknown;
  }[];
  routes: NearbyRoutes;
  client: Awaited<ReturnType<typeof nearbyClient>>["client"];
  /** The fake LAN's session handler, which a test calls with its own approval. */
  deliver(a: NearbyApproval): void;
}

async function approver(
  worker: Record<string, Handler>,
  token: string | null = "pkeyt_m",
  keyring?: NearbyApproverKeyring,
): Promise<Approver> {
  const { client, seen } = await nearbyClient(worker, {
    token,
    keys: "approver-m",
  });
  const routes = (client.identity as unknown as { nearbyRoutes: NearbyRoutes })
    .nearbyRoutes;
  const asks: NearbyAsk[] = [];
  let deliver: (a: NearbyApproval) => void = () => undefined;
  await onNearbyRequest(
    {
      routes,
      ...(keyring ? { keyring } : {}),
      lan: () => ({
        onRequest: async (h) => {
          deliver = h;
          return {
            stop: async () => undefined,
            pause: async () => undefined,
            resume: async () => undefined,
            setPrompt: async () => undefined,
            reopen: async () => undefined,
            status: () => ({
              state: "advertising",
              reason: null,
              prompt: true,
            }),
          };
        },
      }),
    },
    (a) => asks.push(a),
    { prompt: true },
  );
  return {
    asks,
    seen,
    routes,
    client,
    approvals: () =>
      seen
        .filter((s) => s.path.endsWith("/nearby/approve"))
        .map((s) => JSON.parse(s.body!)),
    deliver: (a) => deliver(a),
  };
}

const APPROVE = "POST /djdl/identity/nearby/approve";
const approved: Handler = () =>
  json({ status: "approved", deviceLabel: "Living-room console" });

async function ask(
  w: Approver,
  a = new FakeApproval(),
): Promise<{ ask: NearbyAsk; a: FakeApproval }> {
  const before = w.asks.length;
  w.deliver(a);
  expect(w.asks).toHaveLength(before + 1);
  return { ask: w.asks[before]!, a };
}

const kind = (s: NearbyApprovalStep): string => s.kind;

describe("onRequest: what the person is shown", () => {
  it("gives the handler the device as reported (cleaned), its platform and the three codes", async () => {
    const w = await approver({ [APPROVE]: approved });
    const a = new FakeApproval();
    a.label = "Den\u0007‮ console";
    const { ask: s } = await ask(w, a);
    expect(s.device).not.toMatch(/[\u0000-\u001f‮]/);
    expect(s.platform).toBe("linux");
    expect(s.codes).toEqual([...CODES]);
    w.deliver(Object.assign(new FakeApproval(), { label: null }));
    expect(w.asks[1]!.device).toBeNull();
    // Nothing is sent to the Worker by asking.
    expect(w.approvals()).toEqual([]);
  });

  it("answers account_required through CC-15 when the lan half refuses", async () => {
    const { client } = await nearbyClient({}, { token: "pkeyt_m" });
    const routes = (
      client.identity as unknown as { nearbyRoutes: NearbyRoutes }
    ).nearbyRoutes;
    await expect(
      onNearbyRequest(
        {
          routes,
          lan: () => ({
            onRequest: async () => {
              throw Object.assign(new Error("x"), { code: "account_required" });
            },
          }),
        },
        () => undefined,
        { prompt: true },
      ),
    ).rejects.toMatchObject({ code: "account_required" });
  });
});

describe("onRequest: pick", () => {
  it("a matched code approves with exactly the verified request's ids and keys, then finish()", async () => {
    const w = await approver({ [APPROVE]: approved });
    const { ask: s, a } = await ask(w);
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
    expect(w.approvals()).toHaveLength(1);
    const sent = w.approvals()[0]!;
    expect(sent).toMatchObject({
      request: VOUCH.request,
      deviceId: VOUCH.deviceId,
      signKey: VOUCH.signKey,
      agreeKey: VOUCH.agreeKey,
      decision: "approve",
    });
    expect(Object.keys(sent).sort()).toEqual([
      "agreeKey",
      "decision",
      "deviceId",
      "proof",
      "request",
      "signKey",
    ]);
    expect(a.sentResults).toEqual(["approved"]);
    const bearer = w.seen.find((x) => x.path.endsWith("/nearby/approve"));
    expect(bearer).toBeDefined();
  });

  it("a wrong pick calls no route and says mismatch", async () => {
    const w = await approver({ [APPROVE]: approved });
    const { ask: s, a } = await ask(w);
    expect(await s.pick("111 111")).toEqual({ kind: "mismatch" });
    expect(w.approvals()).toEqual([]);
    expect(a.finishes).toEqual([]);
  });

  it("a request that did not verify is expired, calls no route", async () => {
    const w = await approver({ [APPROVE]: approved });
    const a = new FakeApproval();
    a.pick = async () => "invalid" as never;
    const { ask: s } = await ask(w, a);
    expect(await s.pick(RIGHT)).toEqual({ kind: "expired" });
    expect(w.approvals()).toEqual([]);
  });

  it("one pick per session: asking twice approves once", async () => {
    const w = await approver({ [APPROVE]: approved });
    const { ask: s } = await ask(w);
    const [x, y] = await Promise.all([s.pick(RIGHT), s.pick("111 111")]);
    expect(x).toEqual({ kind: "approved" });
    expect(y).toEqual({ kind: "approved" });
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
    expect(w.approvals()).toHaveLength(1);
  });

  it("none of these match: the session is declined and no route is called", async () => {
    const w = await approver({ [APPROVE]: approved });
    const { ask: s, a } = await ask(w);
    await s.deny();
    expect(a.declined).toBe(1);
    expect(w.approvals()).toEqual([]);
    await expect(s.pick(RIGHT)).rejects.toBeTruthy();
    expect(w.approvals()).toEqual([]);
  });

  it("deny() after a pick does nothing: the server is only told by the choice's cancel", async () => {
    const w = await approver({ [APPROVE]: approved });
    const { ask: s, a } = await ask(w);
    await s.pick(RIGHT);
    await s.deny();
    expect(a.declined).toBe(0);
    expect(w.approvals().map((x) => x.decision)).toEqual(["approve"]);
  });

  it("an approval stands even when the LAN session ended before finish()", async () => {
    const w = await approver({ [APPROVE]: approved });
    const a = new FakeApproval();
    a.finishError = new LanError("closed", "gone");
    const { ask: s } = await ask(w, a);
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
  });
});

describe("onRequest: the Worker's answers are the NearbyApproval steps", () => {
  const cases: [string, number, unknown, string, number][] = [
    ["not_nearby", 403, { error: { code: "not_nearby" } }, "not-nearby", 1],
    [
      "device_limit",
      403,
      { error: { code: "device_limit" } },
      "device-limit",
      1,
    ],
    [
      "account_required",
      403,
      { error: { code: "account_required" } },
      "account-required",
      1,
    ],
    ["401", 401, {}, "account-required", 1],
    [
      "rate_limited",
      429,
      { error: { code: "rate_limited" } },
      "rate-limited",
      1,
    ],
    ["404 still named", 404, { error: { code: "not_found" } }, "expired", 1],
    ["400", 400, { error: { code: "bad_request" } }, "expired", 1],
    ["500", 500, {}, "expired", 1],
  ];
  for (const [name, status, body, step, closes] of cases)
    it(`${name} is ${step}`, async () => {
      const w = await approver({ [APPROVE]: () => json(body, status) });
      const { ask: s, a } = await ask(w);
      expect(kind(await s.pick(RIGHT))).toBe(step);
      // A refusal other than the denied pair closes the session; D hears `denied` for the two.
      if (step === "not-nearby" || step === "device-limit")
        expect(a.sentResults).toEqual(["denied"]);
      else if (name === "404 still named")
        expect(a.sentResults).toEqual(["expired"]);
      else expect(a.closes).toBeGreaterThanOrEqual(closes);
    });

  it("a 404 after discovery lost nearby is expired and finish() knows (it stops the advert)", async () => {
    let named = true;
    const w = await approver({
      [APPROVE]: () => json({ error: { code: "not_found" } }, 404),
      "GET /djdl/.well-known/polaris.json": () =>
        identityDiscovery(named ? FRAGMENT : { endpoints: FRAGMENT.endpoints })(
          {} as never,
        ),
    });
    const { ask: s, a } = await ask(w);
    // M read discovery while nearby was served; only the fresh read after the 404 sees it gone.
    await w.client.discover();
    named = false;
    expect(kind(await s.pick(RIGHT))).toBe("expired");
    expect(a.finishes[0]).toMatchObject({ http: 404, discoveryNearby: false });
  });

  it("a 404 while discovery still names nearby sends D `expired`", async () => {
    const w = await approver({
      [APPROVE]: () => json({ error: { code: "not_found" } }, 404),
    });
    const { ask: s, a } = await ask(w);
    expect(kind(await s.pick(RIGHT))).toBe("expired");
    expect(a.sentResults).toEqual(["expired"]);
  });

  it("no answer closes the session and is expired", async () => {
    const w = await approver({
      [APPROVE]: () => {
        throw new TypeError("fetch failed");
      },
    });
    const { ask: s, a } = await ask(w);
    expect(kind(await s.pick(RIGHT))).toBe("expired");
    expect(a.sentResults).toEqual([]);
    expect(a.closes).toBeGreaterThan(0);
  });

  it("a signed-out M gets account-required and the session closes", async () => {
    const w = await approver({ [APPROVE]: approved }, null);
    const { ask: s, a } = await ask(w);
    expect(kind(await s.pick(RIGHT))).toBe("account-required");
    expect(a.closes).toBeGreaterThan(0);
    expect(w.approvals()).toEqual([]);
  });

  it("M's keys are registered and the approve retried once; a second device_keys_required closes", async () => {
    let n = 0;
    let puts = 0;
    const keys = () => json({ error: { code: "device_keys_required" } }, 409);
    const w = await approver({
      [APPROVE]: () => (++n === 1 ? keys() : approved({} as never)),
      "PUT /djdl/devices/keys": () => (puts++, json({ keySeq: 1 })),
    });
    const { ask: s } = await ask(w);
    expect(kind(await s.pick(RIGHT))).toBe("approved");
    expect({ n, puts }).toEqual({ n: 2, puts: 1 });

    n = 0;
    puts = 0;
    const w2 = await approver({
      [APPROVE]: () => (n++, keys()),
      "PUT /djdl/devices/keys": () => (puts++, json({ keySeq: 1 })),
    });
    const { ask: s2, a: a2 } = await ask(w2);
    expect(kind(await s2.pick(RIGHT))).toBe("expired");
    expect({ n, puts }).toEqual({ n: 2, puts: 1 });
    expect(a2.sentResults).toEqual([]);
  });
});

describe("onRequest: the licence choice", () => {
  const CHOICES = {
    state: "choose",
    choices: [
      { id: "lic_a", tierName: "djdl", seats: { used: 0, limit: 5 } },
      { id: "lic_b", tierName: "djdl", seats: { used: 0, limit: 5 } },
    ],
  };

  function chooser(over: { final?: Handler } = {}) {
    const bodies: Record<string, unknown>[] = [];
    const handler: Handler = (r) => {
      const b = JSON.parse(r.body!) as Record<string, unknown>;
      bodies.push(b);
      if (b.decision === "deny") return new Response(null, { status: 204 });
      if (b.choice === undefined)
        return json({ status: "choose", choices: CHOICES });
      return (over.final ?? approved)(r);
    };
    return { handler, bodies };
  }

  /** A session whose pick lands on the choice step. */
  async function atChoice(over: { final?: Handler } = {}) {
    const c = chooser(over);
    const w = await approver({ [APPROVE]: c.handler });
    const { ask: s, a } = await ask(w);
    const step = await s.pick(RIGHT);
    if (step.kind !== "choose") throw new Error(step.kind);
    return { c, a, step };
  }

  it("shows the choice, then approves with the licence the person chose", async () => {
    const { c, a, step } = await atChoice();
    expect(step.choices).toEqual(CHOICES);
    // Nothing was sent to D yet.
    expect(a.sentResults).toEqual([]);
    expect(await step.choose({ kind: "license", licenseId: "lic_b" })).toEqual({
      kind: "approved",
    });
    expect(c.bodies.map((b) => [b.decision, b.choice])).toEqual([
      ["approve", undefined],
      ["approve", { kind: "license", licenseId: "lic_b" }],
    ]);
    // Same request and keys on every call.
    for (const b of c.bodies)
      expect(b).toMatchObject({
        request: VOUCH.request,
        deviceId: VOUCH.deviceId,
        signKey: VOUCH.signKey,
        agreeKey: VOUCH.agreeKey,
      });
    expect(a.sentResults).toEqual(["approved"]);
  });

  it("a new licence is `{kind: create}`", async () => {
    const { c, step } = await atChoice();
    await step.choose({ kind: "create" });
    expect(c.bodies[1]!.choice).toEqual({ kind: "create" });
  });

  it("cancel() denies on the Worker, which is allowed because the right code was tapped", async () => {
    const { c, a, step } = await atChoice();
    expect(await step.cancel()).toEqual({ kind: "denied" });
    expect(c.bodies.map((b) => b.decision)).toEqual(["approve", "deny"]);
    expect(a.sentResults).toEqual(["denied"]);
  });

  it("a choice is answered once", async () => {
    const { c, step } = await atChoice();
    await step.choose({ kind: "create" });
    await expect(step.cancel()).rejects.toMatchObject({
      code: "invalid-options",
    });
    await expect(step.choose({ kind: "create" })).rejects.toBeTruthy();
    expect(c.bodies).toHaveLength(2);
  });

  it("a lost mint (409) asks the Worker for the licences again, at most three times", async () => {
    let n = 0;
    const w = await approver({
      [APPROVE]: () => {
        n++;
        return json({ error: { code: "license_choice_required" } }, 409);
      },
    });
    const { ask: s, a } = await ask(w);
    expect(kind(await s.pick(RIGHT))).toBe("expired");
    expect(n).toBe(3);
    expect(a.sentResults).toEqual([]);
    expect(a.closes).toBeGreaterThan(0);
  });

  it("a choice that comes back as a refusal is that step (device limit after choosing)", async () => {
    const { step } = await atChoice({
      final: () => json({ error: { code: "device_limit" } }, 403),
    });
    expect(
      kind(await step.choose({ kind: "license", licenseId: "lic_a" })),
    ).toBe("device-limit");
  });
});

describe("onRequest: nothing secret is printed", () => {
  it("the ask and the steps leave out the handle, the proof and the keys", async () => {
    const w = await approver({ [APPROVE]: approved });
    const { ask: s } = await ask(w);
    const step = await s.pick(RIGHT);
    const proof = w.approvals()[0]!.proof as string;
    for (const out of [
      format(s),
      format("%o", s),
      inspect(s, { depth: 9 }),
      JSON.stringify(s),
      JSON.stringify(step),
    ]) {
      expect(out).not.toContain(REQ);
      expect(out).not.toContain(proof);
    }
  });
});

describe("onRequest: the key ring wrap (I-47.10)", () => {
  const BODY = {
    ringId: "rg_" + "r".repeat(22),
    epoch: 1,
    kid: "ab".repeat(32),
    kem: 32,
    enc: "e",
    ct: "c",
  };

  function ring(
    o: { unlocked?: boolean; fail?: boolean; failPut?: boolean } = {},
  ) {
    const calls: [string, string][] = [];
    /** The order the three steps ran in; the approval's `sendRecord` joins it through `trace`. */
    const order: string[] = [];
    const keyring: NearbyApproverKeyring = {
      unlocked: o.unlocked ?? true,
      sealWrapTo: async (id, key) => {
        calls.push([id, key]);
        order.push("seal");
        if (o.fail) throw new Error("locked");
        return BODY;
      },
      putWrap: async () => {
        order.push("put");
        if (o.failPut) throw new Error("keyring_conflict");
      },
    };
    const trace = (a: FakeApproval): FakeApproval => {
      const send = a.sendRecord.bind(a);
      a.sendRecord = async (t, b) => {
        order.push("send");
        await send(t, b);
      };
      return a;
    };
    return { keyring, calls, order, trace };
  }

  const sentWraps = (a: FakeApproval) =>
    a.sent.map((r) => [r.type, JSON.parse(new TextDecoder().decode(r.body))]);

  it("after approved, wraps to the verified request's device and key, and sends the same wrap once", async () => {
    const { keyring, calls } = ring();
    const w = await approver({ [APPROVE]: approved }, "pkeyt_m", keyring);
    const { ask: s, a } = await ask(w);
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
    expect(calls).toEqual([[VOUCH.deviceId, VOUCH.agreeKey]]);
    expect(sentWraps(a)).toEqual([[0x0030, BODY]]);
    // VOUCH_RESULT went first: the wrap follows the approval.
    expect(a.sentResults).toEqual(["approved"]);
    // Asking again never wraps again.
    await s.pick(RIGHT);
    expect(calls).toHaveLength(1);
  });

  it("sends no wrap when the root is not held here", async () => {
    const { keyring, calls } = ring({ unlocked: false });
    const w = await approver({ [APPROVE]: approved }, "pkeyt_m", keyring);
    const { ask: s, a } = await ask(w);
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
    expect(calls).toEqual([]);
    expect(a.sent).toEqual([]);
  });

  it("sends no wrap without a key ring", async () => {
    const w = await approver({ [APPROVE]: approved });
    const { ask: s, a } = await ask(w);
    await s.pick(RIGHT);
    expect(a.sent).toEqual([]);
  });

  it("wraps to nobody unless the Worker approved: a wrong pick, a refusal, a denial, a lost mint", async () => {
    for (const handler of [
      () => json({ error: { code: "not_nearby" } }, 403),
      () => json({ error: { code: "device_limit" } }, 403),
      () => json({ error: { code: "not_found" } }, 404),
      () => new Response(null, { status: 204 }),
      () => json({ error: { code: "license_choice_required" } }, 409),
    ] as Handler[]) {
      const { keyring, calls } = ring();
      const w = await approver({ [APPROVE]: handler }, "pkeyt_m", keyring);
      const { ask: s, a } = await ask(w);
      await s.pick(RIGHT);
      expect(calls).toEqual([]);
      expect(a.sent).toEqual([]);
    }
    const { keyring, calls } = ring();
    const w = await approver({ [APPROVE]: approved }, "pkeyt_m", keyring);
    const { ask: s } = await ask(w);
    expect(await s.pick("111 111")).toEqual({ kind: "mismatch" });
    expect(calls).toEqual([]);
  });

  it("a licence choice wraps once, after the final approve", async () => {
    const { keyring, calls } = ring();
    let first = true;
    const w = await approver(
      {
        [APPROVE]: (r) => {
          const b = JSON.parse(r.body!);
          if (first && b.choice === undefined) {
            first = false;
            return json({ status: "choose", choices: { state: "choose" } });
          }
          return approved({} as never);
        },
      },
      "pkeyt_m",
      keyring,
    );
    const { ask: s, a } = await ask(w);
    const step = await s.pick(RIGHT);
    if (step.kind !== "choose") throw new Error(step.kind);
    expect(calls).toEqual([]);
    await step.choose({ kind: "create" });
    expect(calls).toHaveLength(1);
    expect(a.sent).toHaveLength(1);
  });

  it("follows V5 13.11.3: seal, send on the channel, then PUT the same wrap", async () => {
    const { keyring, order, trace } = ring();
    const w = await approver({ [APPROVE]: approved }, "pkeyt_m", keyring);
    const { ask: s } = await ask(w, trace(new FakeApproval()));
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
    expect(order).toEqual(["seal", "send", "put"]);
  });

  it("a refused PUT does not take the channel copy with it", async () => {
    const { keyring, order, trace } = ring({ failPut: true });
    const w = await approver({ [APPROVE]: approved }, "pkeyt_m", keyring);
    const a = trace(new FakeApproval());
    const { ask: s } = await ask(w, a);
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
    expect(order).toEqual(["seal", "send", "put"]);
    expect(sentWraps(a)).toEqual([[0x0030, BODY]]);
  });

  it("a failed wrap, or a failed send, leaves the approval standing", async () => {
    const failing = ring({ fail: true });
    const w = await approver(
      { [APPROVE]: approved },
      "pkeyt_m",
      failing.keyring,
    );
    const { ask: s, a } = await ask(w);
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
    expect(a.sent).toEqual([]);

    const ok = ring();
    const w2 = await approver({ [APPROVE]: approved }, "pkeyt_m", ok.keyring);
    const b = new FakeApproval();
    b.sendRecord = async () => {
      throw new LanError("closed", "gone");
    };
    const { ask: s2 } = await ask(w2, b);
    expect(await s2.pick(RIGHT)).toEqual({ kind: "approved" });
  });

  it("a channel that ended still gets the server copy of the wrap", async () => {
    const { keyring, calls, order } = ring();
    const w = await approver({ [APPROVE]: approved }, "pkeyt_m", keyring);
    const a = new FakeApproval();
    a.finishError = new LanError("closed", "gone");
    a.sendRecord = async () => {
      throw new LanError("closed", "gone");
    };
    const { ask: s } = await ask(w, a);
    expect(await s.pick(RIGHT)).toEqual({ kind: "approved" });
    expect(calls).toHaveLength(1);
    expect(order).toEqual(["seal", "put"]);
  });
});
