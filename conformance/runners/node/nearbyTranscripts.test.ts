// The nearby approval transcripts (I-40.9, WIRE-CONTRACT-V5 §12.11.5) replayed by a reference
// client: the conformance runner's own, built from node:crypto and `fetch`, with no code from
// the Worker or from `@polaris-key/node`.
//
// @pkey-feature identity.nearby
//
// Node has no nearby approval to give or ask for, so its parity row for `identity.nearby` is
// not implemented and `transcripts.test.ts` skips these files by the `applies()` rule. This
// runner plays BOTH devices: D (the transcript's own device) calls start and poll, M (a
// signed-in device nearby) calls approve. It derives the fixture keys of every label (format.ts,
// "exchange"), signs each `pkey-proof/1` proof itself (line 6 `-`: no token is bound) and sends
// the bodies the contract fixes, against `ReplayServer`, which holds every request to the
// recording byte for byte, the proofs included. Every `nearby-*` transcript runs here.

import { describe, expect, it } from "vitest";
import {
  doctor,
  loadTranscripts,
  ReplayServer,
  type JsonValue,
  type Step,
  type Transcript,
} from "./transcriptReplay.js";
import {
  deviceHeaders,
  deviceKeys,
  errorCode,
  postJson,
  replay,
  type Observed,
} from "./exchangeReference.js";

interface Nearby {
  /** The last discovery (none yet: offered) named `nearby` and its three endpoints (§12.11.5). */
  offered: boolean;
  /** A start was answered 404: the Worker rolled the gate back after discovery. */
  gateOff: boolean;
  /** The handle the last start answered. */
  request: string | null;
}
const state = new WeakMap<ReplayServer, Nearby>();
const of = (s: ReplayServer): Nearby => {
  let n = state.get(s);
  if (!n) state.set(s, (n = { offered: true, gateOff: false, request: null }));
  return n;
};

const UNAVAILABLE: Observed = { result: "unavailable" };

function refused(status: number, body: Record<string, unknown>): Observed {
  return { result: "refused", status, code: errorCode(body) };
}

async function runNearby(
  server: ReplayServer,
  t: Transcript,
  step: Step,
): Promise<Observed> {
  const n = of(server);
  const base = `${t.baseUrl}/${t.product}`;
  const a = step.args;
  if (step.action === "discover") {
    const res = await server.fetch(`${base}/.well-known/polaris.json`);
    const doc = (await res.json()) as {
      services: Record<
        string,
        {
          enabled?: boolean;
          nearby?: JsonValue;
          endpoints?: Record<string, string>;
        }
      >;
    };
    const identity = doc.services.identity ?? {};
    const ep = identity.endpoints ?? {};
    const endpoints = ["nearbyStart", "nearbyApprove", "nearbyPoll"].every(
      (k) => typeof ep[k] === "string",
    );
    n.offered = identity.nearby !== undefined && endpoints;
    n.gateOff = false;
    n.request = null;
    return {
      result: "ok",
      services: Object.fromEntries(
        Object.entries(doc.services).map(([k, v]) => [k, v.enabled === true]),
      ),
      nearby: identity.nearby ?? null,
      nearbyEndpoints: endpoints,
    } as Observed;
  }
  // Discovery without the member: the client sends nothing (§12.11.5).
  if (!n.offered) return UNAVAILABLE;

  const d = deviceKeys(a.keyLabel as string);
  const sign = (
    label: string | undefined,
    purpose: string,
    deviceId: string,
    value: string,
  ): string =>
    deviceKeys(label ?? (a.keyLabel as string)).proof({
      purpose,
      product: t.product,
      deviceId,
      value,
      token: null,
    });

  if (step.action === "nearbyStart") {
    const r = await postJson(
      server,
      `${base}/identity/nearby/start`,
      deviceHeaders(t),
      {
        signKey: d.signKey,
        agreeKey: d.agreeKey,
        ...(a.deviceName !== undefined ? { deviceName: a.deviceName } : {}),
        proof: sign(
          a.proofKeyLabel as string | undefined,
          "nearby-start",
          t.initial.deviceId,
          `${d.signKey}.${d.agreeKey}`,
        ),
      },
    );
    if (r.status === 404) {
      n.gateOff = true;
      return UNAVAILABLE;
    }
    if (r.status !== 201) return refused(r.status, r.body);
    n.request = r.body.request as string;
    return {
      result: "ok",
      expiresIn: r.body.expiresIn as number,
      interval: r.body.interval as number,
    };
  }

  const handle = (a.request as string | undefined) ?? n.request ?? "";

  if (step.action === "nearbyApprove") {
    const m = a.approverDeviceId as string;
    const agree =
      a.agreeKeyLabel !== undefined
        ? deviceKeys(a.agreeKeyLabel as string).agreeKey
        : d.agreeKey;
    const r = await postJson(
      server,
      `${base}/identity/nearby/approve`,
      {
        ...deviceHeaders(t),
        "x-pkey-device": m,
        authorization: `Bearer ${a.approverToken as string}`,
      },
      {
        request: handle,
        signKey: d.signKey,
        agreeKey: agree,
        decision: a.decision,
        ...(a.choice !== undefined ? { choice: a.choice } : {}),
        proof: sign(
          (a.proofKeyLabel as string | undefined) ??
            (a.approverKeyLabel as string),
          "nearby-approve",
          m,
          (a.proofValue as string | undefined) ?? handle,
        ),
      },
    );
    if (r.status === 404 && n.gateOff) return UNAVAILABLE;
    if (r.status === 204) return { result: "denied" };
    if (r.status === 200 && r.body.status === "approved")
      return {
        result: "approved",
        deviceLabel: (r.body.deviceLabel as string | null) ?? null,
      };
    if (r.status === 200 && r.body.status === "choose")
      return { result: "choose", choices: r.body.choices as JsonValue };
    return refused(r.status, r.body);
  }

  expect(step.action).toBe("nearbyPoll");
  const r = await postJson(
    server,
    `${base}/identity/nearby/poll`,
    deviceHeaders(t),
    {
      request: handle,
      proof: sign(
        a.proofKeyLabel as string | undefined,
        "nearby-poll",
        t.initial.deviceId,
        handle,
      ),
    },
  );
  if (r.status === 404 && n.gateOff) return UNAVAILABLE;
  if (typeof r.body.access_token === "string")
    return {
      result: "ready",
      tokenHeld: true,
      scope: (r.body.scope as string) ?? null,
    };
  if (r.status === 429 && r.body.status === "slow_down")
    return { result: "slow-down", interval: r.body.interval as number };
  if (r.status === 200 && r.body.status === "pending")
    return { result: "pending" };
  if (r.status === 200 && r.body.status === "timeout")
    return { result: "timeout" };
  if (r.status === 200 && r.body.status === "error")
    return { result: "error", reason: r.body.reason as string };
  return refused(r.status, r.body);
}

const NEARBY = loadTranscripts().filter((t) => t.id.startsWith("nearby-"));

describe("identity.nearby transcripts, reference client (both devices)", () => {
  it("covers the nearby scenarios", () => {
    expect(NEARBY.map((t) => t.id).sort()).toEqual([
      "nearby-choose",
      "nearby-denied",
      "nearby-disabled",
      "nearby-errors",
      "nearby-gate-off",
      "nearby-happy",
    ]);
    for (const t of NEARBY) expect(t.features).toContain("identity.nearby");
  });

  for (const t of NEARBY)
    it(`${t.id}: both devices reproduce every request`, async () => {
      await replay(t, runNearby);
    });

  const happy = NEARBY.find((t) => t.id === "nearby-happy")!;

  for (const [who, step] of [
    ["D's start", 1],
    ["M's approve", 4],
    ["D's poll", 5],
  ] as const)
    it(`fails when ${who} proof is not the recorded one`, async () => {
      const doctored = doctor(happy, step, (items) => {
        const copy = structuredClone(items);
        const body = copy[0]!.request.body!.json as Record<string, string>;
        const last = body.proof!.endsWith("A") ? "B" : "A";
        body.proof = body.proof!.replace(/.$/, last);
        return copy;
      });
      await expect(replay(doctored, runNearby)).rejects.toThrow(
        /does not match the recording/,
      );
    });

  it("fails when M's bearer is not the recorded token", async () => {
    const doctored = doctor(happy, 4, (items) => {
      const copy = structuredClone(items);
      copy[0]!.request.headers.authorization = "Bearer pkeyt_other";
      return copy;
    });
    await expect(replay(doctored, runNearby)).rejects.toThrow(
      /does not match the recording/,
    );
  });
});
