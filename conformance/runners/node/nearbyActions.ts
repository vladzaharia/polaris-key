// The SDK-side half of the `nearby-*` transcript replay (I-47.4, WIRE-CONTRACT-V5 §12.11.5): the
// steps `nearbyStart`, `nearbyPoll` and `nearbyApprove` run against `identity.nearbyRoutes` of
// a `@polaris-key/node` client, with the fixture device keys of each step's `keyLabel`.
//
// Two devices speak in one transcript. D is the transcript's own device (`initial.deviceId`, no
// token). M is the signed-in approver the step names (`approverDeviceId`, `approverToken`); the
// caller builds its client on demand. This module imports nothing from the SDK, so the runner
// (`transcripts.test.ts`, once `identity.nearby` is implemented) and the package's own test
// (`packages/sdk-node/test/identityNearby.test.ts`) share it without a second copy.
//
// The vocabulary of `expect` is `nearbyTranscripts.test.ts`'s (the reference client): `ok`,
// `pending`, `slow-down`, `ready`, `timeout`, `error`, `approved`, `choose`, `denied`, `refused`
// (with the status and the code) and `unavailable`.

import { expect } from "vitest";
import { b64u, deviceKeys } from "./exchangeReference.js";
import type { JsonValue, Step, Transcript } from "./transcriptReplay.js";

/** A device key port holding the fixture keys of one label (format.ts, "exchange"). */
export interface FixtureKeys {
  signKey: string;
  agreeKey: string;
  ensure(): Promise<{ signKey: string; agreeKey: string; generation: number }>;
  publicKeys(): Promise<{
    signKey: string;
    agreeKey: string;
    generation: number;
  } | null>;
  sign(message: Uint8Array): Promise<Uint8Array>;
  dh(peer: Uint8Array): Promise<Uint8Array | null>;
  rotate(): Promise<{ signKey: string; agreeKey: string; generation: number }>;
  wipe(): Promise<void>;
  persistence(): "durable";
}

export function fixtureKeys(label: string): FixtureKeys {
  const k = deviceKeys(label);
  const keys = { signKey: k.signKey, agreeKey: k.agreeKey, generation: 1 };
  return {
    signKey: k.signKey,
    agreeKey: k.agreeKey,
    ensure: async () => keys,
    publicKeys: async () => keys,
    sign: async (m) => new Uint8Array(k.sign(m)),
    dh: async () => null,
    rotate: async () => keys,
    wipe: async () => undefined,
    persistence: () => "durable",
  };
}

/** What a replay needs of a `NearbyRoutes`, structurally. */
export interface RoutesLike {
  signProof: ((port: never, f: ProofFields) => Promise<string>) | undefined;
  start(o: { deviceName?: string }): Promise<StartedLike>;
  poll(s: StartedLike): Promise<Record<string, unknown> & { kind: string }>;
  approve(
    v: object,
    d: { decision: unknown; choice?: unknown },
  ): Promise<Record<string, unknown> & { kind: string }>;
}
export interface ProofFields {
  purpose: string;
  deviceId: string;
  value: string;
}
export interface StartedLike {
  request: string;
  expiresIn: number;
  interval: number;
  signKey: string;
}

export interface NearbyReplayParty {
  routes: RoutesLike;
  /** The port the party's client holds (the fixture keys). */
  keys: FixtureKeys;
}

export interface NearbyStepContext {
  t: Transcript;
  step: Step;
  /** D, the transcript's own device, with the keys of the first step's `keyLabel`. */
  d(): NearbyReplayParty;
  /** M for this step (its device id, token and keys), built on demand. */
  m(step: Step): Promise<NearbyReplayParty>;
  /** Whether D holds a token now. */
  tokenHeld(): boolean;
  /**
   * The permit for a vouch built from the recording, which may carry other keys than D's to prove
   * the Worker refuses them. The replay imports `grantApproval` by source path: the package entry
   * and the routes do not offer it, so no host can approve without a matched pick.
   */
  grant(v: Record<string, unknown>): object;
}

type Observed = Record<string, JsonValue>;

interface PolarisErrorLike {
  code?: string;
  status?: number;
  name?: string;
}

/** A thrown refusal as the transcripts' `expect` reads it. */
function refusal(e: unknown): Observed {
  const err = e as PolarisErrorLike;
  if (err?.code === "service-unavailable") return { result: "unavailable" };
  if (typeof err?.code !== "string" || typeof err.status !== "number") throw e;
  return { result: "refused", status: err.status, code: err.code };
}

/**
 * The proof signer for a step that doctors its proof: `proofKeyLabel` signs with another key,
 * `proofValue` signs over another value. Undefined for an ordinary step (the SDK signs through
 * the key port, which refuses a proof that would not verify).
 */
export function doctoredSigner(
  t: Transcript,
  step: Step,
): ((port: never, f: ProofFields) => Promise<string>) | undefined {
  const a = step.args;
  if (a.proofKeyLabel === undefined && a.proofValue === undefined)
    return undefined;
  const other =
    typeof a.proofKeyLabel === "string" ? fixtureKeys(a.proofKeyLabel) : null;
  return async (port, f) => {
    const keys = other ?? (port as unknown as FixtureKeys);
    const value = typeof a.proofValue === "string" ? a.proofValue : f.value;
    const message = [
      "pkey-proof/1",
      f.purpose,
      t.product,
      f.deviceId,
      value,
      "-",
    ].join("\n");
    return b64u(await keys.sign(new TextEncoder().encode(message)));
  };
}

/** Observed result of a `nearbyStart`, `nearbyPoll` or `nearbyApprove` step. */
export async function nearbyAction(c: NearbyStepContext): Promise<Observed> {
  const { t, step } = c;
  const a = step.args;
  try {
    if (step.action === "nearbyStart") {
      const d = c.d();
      d.routes.signProof = doctoredSigner(t, step);
      const s = await d.routes.start(
        typeof a.deviceName === "string" ? { deviceName: a.deviceName } : {},
      );
      return { result: "ok", expiresIn: s.expiresIn, interval: s.interval };
    }
    if (step.action === "nearbyPoll") {
      const d = c.d();
      d.routes.signProof = doctoredSigner(t, step);
      const p = await d.routes.poll({
        request: String(a.request ?? ""),
        expiresIn: 300,
        interval: 3,
        signKey: d.keys.signKey,
      });
      switch (p.kind) {
        case "slow-down":
          return { result: "slow-down", interval: p.interval as number };
        case "denied":
          return { result: "error", reason: "access_denied" };
        case "ready":
          return {
            result: "ready",
            tokenHeld: c.tokenHeld(),
            scope: p.scope as string,
          };
        default:
          return { result: p.kind };
      }
    }
    // nearbyApprove: M's decision, with D's keys as D started with (or the step's other agree key).
    const d = c.d();
    const m = await c.m(step);
    m.routes.signProof = doctoredSigner(t, step);
    const agreeKey =
      typeof a.agreeKeyLabel === "string"
        ? fixtureKeys(a.agreeKeyLabel).agreeKey
        : d.keys.agreeKey;
    // The replay vouches for what the recording sent (it may carry other keys than D's).
    const vouch = c.grant({
      request: a.request,
      deviceId: t.initial.deviceId,
      signKey: d.keys.signKey,
      agreeKey,
      label: null,
      platform: "linux",
    });
    const r = await m.routes.approve(vouch, {
      decision: a.decision,
      ...(a.choice !== undefined ? { choice: a.choice } : {}),
    });
    switch (r.kind) {
      case "approved":
        return { result: "approved", deviceLabel: r.deviceLabel as string };
      case "choose":
        return { result: "choose", choices: r.choices as JsonValue };
      case "refused":
        return {
          result: "refused",
          status: r.status as number,
          code: r.code as string,
        };
      default:
        return { result: r.kind };
    }
  } catch (e) {
    return refusal(e);
  }
}

/** The discovery document a `GET .well-known/polaris.json` outside a step's recording is answered
 *  with: the transcript's own `discover` step before the Worker's gate went off, its last after,
 *  else the standard one that names nearby (the transcripts that never run a `discover` step). */
export function nearbyDiscovery(t: Transcript, stepIndex: number): JsonValue {
  const path = `/${t.product}/.well-known/polaris.json`;
  const docs = t.steps
    .filter((s) => s.action === "discover")
    .map(
      (s) =>
        s.exchanges.items.find((x) => x.request.path === path)?.response
          .body as JsonValue,
    )
    .filter((d) => d !== undefined);
  // `nearby-gate-off`: "the gate then goes off" after the first step.
  if (docs.length > 1 && stepIndex >= 1) return docs[docs.length - 1]!;
  if (docs.length > 0) return docs[0]!;
  const base = `${t.baseUrl}/${t.product}/identity`;
  return {
    product: t.product,
    services: {
      license: { enabled: true },
      config: { enabled: true },
      identity: {
        enabled: true,
        configured: true,
        nearby: true,
        endpoints: {
          nearbyStart: `${base}/nearby/start`,
          nearbyApprove: `${base}/nearby/approve`,
          nearbyPoll: `${base}/nearby/poll`,
        },
      },
    },
  };
}

/** What a `discover` step of a nearby transcript expects beside `result` and `services`: whether
 *  the identity fragment of the client's discovery names `nearby` and its three endpoints. */
export function nearbyFacts(doc: unknown): Observed {
  const identity = (
    doc as { services?: { identity?: Record<string, unknown> } } | null
  )?.services?.identity;
  const ep = (identity?.endpoints ?? {}) as Record<string, unknown>;
  return {
    nearby: identity?.nearby === true ? true : null,
    nearbyEndpoints: ["nearbyStart", "nearbyApprove", "nearbyPoll"].every(
      (k) => typeof ep[k] === "string" && ep[k] !== "",
    ),
  };
}

/** Hold what a step observed to its recorded `expect`. */
export function holdToExpect(
  t: Transcript,
  index: number,
  step: Step,
  observed: Record<string, unknown>,
): void {
  for (const [key, want] of Object.entries(step.expect))
    expect(
      observed[key],
      `${t.id} step ${index} (${step.action}): ${key}`,
    ).toEqual(want);
}

/** The `PolarisKeyClient` options of one party of a nearby replay: its store (the device id and
 *  token), the shared replay `fetch`, its own state directory and its fixture keys. */
export function nearbyClientOptions(
  t: Transcript,
  o: { store: unknown; fetchImpl: unknown; dir: string; keys: FixtureKeys },
): Record<string, unknown> {
  return {
    productSlug: t.product,
    baseUrl: t.baseUrl,
    version: t.initial.version,
    trust: { pinnedKeys: t.trust },
    trustRefresh: false,
    store: o.store,
    fetchImpl: o.fetchImpl,
    requestTimeoutMs: 0,
    deviceName: "",
    stateDir: o.dir,
    cacheDir: o.dir,
    dataDir: o.dir,
    configDir: o.dir,
    expectedServices: ["license", "config", "identity"],
    keyring: { deviceKeys: o.keys },
  };
}
