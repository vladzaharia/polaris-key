// @pkey-feature identity.nearby
// The nearby approval routes (I-47.4, WIRE-CONTRACT-V5 §12.11.5), replayed against the six
// `nearby-*` transcripts with the fixture device keys of each step's `keyLabel`: D's `start` and
// `poll` (the transcript's own device) and M's `approve` (a second client with the step's device
// id, token and keys). Every request must reproduce the recording byte for byte, the proofs
// included; the recorded answers must come out as the transcripts' `expect`. The transcripts are
// also played by the generic runner once `identity.nearby` is implemented (parity.json).
//
// Then the rules the transcripts cannot record: M's one retry after `device_keys_required`, the
// bearer D sends when it holds a credential (Q8), the 404s read through a fresh discovery (N11),
// the poll answers a 429 and a 503, and no secret in a print or an error.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  doctor,
  loadTranscripts,
  ReplayServer,
  type Step,
  type Transcript,
} from "../../../conformance/runners/node/transcriptReplay.js";
import {
  fixtureKeys,
  nearbyAction,
  nearbyDiscovery,
  nearbyClientOptions,
  nearbyFacts,
  holdToExpect,
  type FixtureKeys,
  type NearbyReplayParty,
  type RoutesLike,
} from "../../../conformance/runners/node/nearbyActions.js";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import {
  identityDiscovery,
  json,
  seededClient,
  type Handler,
} from "./parityFixtures.js";

class PartyStore extends InMemoryStore {
  constructor(
    private readonly id: string,
    token: string | undefined,
  ) {
    super();
    if (token) void this.setToken(token);
  }
  override async getDeviceId(): Promise<string> {
    return this.id;
  }
}

type Observed = Record<string, unknown>;

/** Replay `t`: D from `initial`, M built per approve step; every step held to its `expect`. */
async function replayNearby(t: Transcript): Promise<void> {
  const server = new ReplayServer(t);
  let index = -1;
  let step: Step | null = null;
  const discoveryPath = `/${t.product}/.well-known/polaris.json`;
  // The replay's server, but a discovery read outside a step's recording is answered here.
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : ((input as Request).url ?? String(input)),
    );
    if (
      url.pathname === discoveryPath &&
      step !== null &&
      !step.exchanges.items.some((x) => x.request.path === discoveryPath)
    )
      return new Response(JSON.stringify(nearbyDiscovery(t, index)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return server.fetch(input, init);
  };

  const dir = mkdtempSync(join(tmpdir(), "pkey-nearby-"));
  const make = (
    deviceId: string,
    token: string | undefined,
    keys: FixtureKeys,
  ) =>
    new PolarisKeyClient(
      nearbyClientOptions(t, {
        store: new PartyStore(deviceId, token),
        fetchImpl,
        dir: join(dir, deviceId),
        keys,
      }) as never,
    );
  const partyOf = async (
    c: PolarisKeyClient,
    keys: FixtureKeys,
    preload = false,
  ) => {
    await c.init();
    if (preload) {
      // M read discovery while the gate was still on; only a fresh read sees it go off.
      const at = index;
      index = 0;
      await c.discover();
      index = at;
    }
    // The acquisition sync after a sign-in is pinned by the sync transcripts, not here.
    (c.identity as unknown as { onAcquired: () => Promise<void> }).onAcquired =
      async () => undefined;
    return {
      routes: (c.identity as unknown as { nearbyRoutes: RoutesLike })
        .nearbyRoutes,
      keys,
    } satisfies NearbyReplayParty;
  };

  const first = t.steps.find((s) => typeof s.args.keyLabel === "string")!;
  const dKeys = fixtureKeys(first.args.keyLabel as string);
  const dClient = make(t.initial.deviceId, t.initial.token, dKeys);
  const dParty = await partyOf(dClient, dKeys);
  const mClients: PolarisKeyClient[] = [];

  for (let i = 0; i < t.steps.length; i += 1) {
    step = server.beginStep(i);
    index = i;
    let observed: Observed;
    if (step.action === "discover") {
      const kind = (await dClient.discover()).kind;
      const services: Record<string, boolean> = {};
      for (const [slug, s] of Object.entries(dClient.capabilities()))
        services[slug] = s.enabled;
      observed = {
        result: kind,
        services,
        ...nearbyFacts(
          (dClient as unknown as { discoveryDoc: unknown }).discoveryDoc,
        ),
      };
    } else {
      observed = await nearbyAction({
        t,
        step,
        d: () => dParty,
        m: async (s) => {
          const keys = fixtureKeys(s.args.approverKeyLabel as string);
          const c = make(
            s.args.approverDeviceId as string,
            s.args.approverToken as string,
            keys,
          );
          mClients.push(c);
          return partyOf(c, keys, true);
        },
        tokenHeld: () => dClient.hasToken,
      });
    }
    server.endStep();
    holdToExpect(t, i, step, observed);
  }
  dClient.close();
  for (const c of mClients) c.close();
}

const NEARBY = loadTranscripts().filter((t) => t.id.startsWith("nearby-"));

describe("nearby routes: the transcripts", () => {
  it("covers the six scenarios", () => {
    expect(NEARBY.map((t) => t.id).sort()).toEqual([
      "nearby-choose",
      "nearby-denied",
      "nearby-disabled",
      "nearby-errors",
      "nearby-gate-off",
      "nearby-happy",
    ]);
  });

  for (const t of NEARBY)
    it(`${t.id}: every request is the recorded one and every answer is read as recorded`, async () => {
      await replayNearby(t);
    });

  const happy = NEARBY.find((t) => t.id === "nearby-happy")!;
  for (const [what, step] of [
    ["D's start", 1],
    ["M's approve", 4],
    ["D's poll", 5],
  ] as const)
    it(`fails when ${what} proof is not the recorded one`, async () => {
      const doctored = doctor(happy, step, (items) => {
        const copy = structuredClone(items);
        const body = copy[0]!.request.body!.json as Record<string, string>;
        body.proof = body.proof!.replace(
          /.$/,
          body.proof!.endsWith("A") ? "B" : "A",
        );
        return copy;
      });
      await expect(replayNearby(doctored)).rejects.toThrow(
        /does not match the recording/,
      );
    });
});

// ── The rules the transcripts cannot record ────────────────────────────────────────────────

const BASE = "https://k.test/djdl/identity";
const REQ = "nr_pA71hdu4pwET01lPlZ_Pow";
const D_ID = "TRANSCRIPTDEVICE0000000000000001";
const FULL = {
  nearby: true,
  endpoints: {
    nearbyStart: `${BASE}/nearby/start`,
    nearbyApprove: `${BASE}/nearby/approve`,
    nearbyPoll: `${BASE}/nearby/poll`,
  },
};
const discovery = identityDiscovery;

async function routes(over: Record<string, Handler>, token: string | null) {
  const keys = fixtureKeys("unit-d");
  const { client, seen } = await seededClient({
    token,
    extra: {
      expectedServices: ["license", "config", "identity"] as never,
      // No platform default name: a start sends a `deviceName` only when the test gives one.
      deviceName: "",
      keyring: { deviceKeys: keys as never },
    },
    routes: {
      "GET /djdl/.well-known/polaris.json": discovery(FULL),
      ...over,
    },
  });
  (
    client.identity as unknown as { onAcquired: () => Promise<void> }
  ).onAcquired = async () => undefined;
  return {
    client,
    seen,
    keys,
    r: (
      client.identity as unknown as {
        nearbyRoutes: {
          start(o?: object): Promise<{
            request: string;
            signKey: string;
            expiresIn: number;
            interval: number;
          }>;
          poll(s: object): Promise<{ kind: string; interval?: number }>;
          approve(a: object): Promise<{
            kind: string;
            status?: number;
            code?: string;
            finish: {
              http: number | null;
              body: string | null;
              discoveryNearby: boolean;
            };
          }>;
        };
      }
    ).nearbyRoutes,
  };
}

const startOk: Handler = () =>
  json({ request: REQ, expiresIn: 300, interval: 3 }, 201);

describe("nearby routes: the rules", () => {
  it("D's start sends a bearer only when the device holds a credential (Q8)", async () => {
    const none = await routes(
      { "POST /djdl/identity/nearby/start": startOk },
      null,
    );
    await none.r.start();
    const sent = none.seen.find((s) => s.path.endsWith("/nearby/start"))!;
    expect(sent.headers.get("authorization")).toBeNull();
    const body = JSON.parse(sent.body!);
    expect(Object.keys(body).sort()).toEqual(["agreeKey", "proof", "signKey"]);
    expect(body.signKey).toBe(none.keys.signKey);

    const held = await routes(
      { "POST /djdl/identity/nearby/start": startOk },
      "pkeyt_held",
    );
    await held.r.start({ deviceName: "Den" });
    const s2 = held.seen.find((s) => s.path.endsWith("/nearby/start"))!;
    expect(s2.headers.get("authorization")).toBe("Bearer pkeyt_held");
    expect(JSON.parse(s2.body!).deviceName).toBe("Den");
  });

  it("start answers the typed N/A, sending nothing, when discovery does not name nearby", async () => {
    const w = await routes(
      {
        "POST /djdl/identity/nearby/start": startOk,
        "GET /djdl/.well-known/polaris.json": discovery({
          endpoints: FULL.endpoints,
        }),
      },
      null,
    );
    await expect(w.r.start()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    expect(w.seen.some((s) => s.path.endsWith("/nearby/start"))).toBe(false);
  });

  it("start refuses a malformed answer", async () => {
    const w = await routes(
      {
        "POST /djdl/identity/nearby/start": () =>
          json({ request: "nr_short", expiresIn: 300, interval: 3 }, 201),
      },
      null,
    );
    await expect(w.r.start()).rejects.toMatchObject({ code: "bad_response" });
  });

  it("the handle prints as nothing, and no error names a secret", async () => {
    const w = await routes(
      {
        "POST /djdl/identity/nearby/start": startOk,
        "POST /djdl/identity/nearby/poll": () =>
          json({ error: { code: "invalid_grant" } }, 400),
      },
      null,
    );
    const started = await w.r.start();
    expect(started.request).toBe(REQ);
    for (const out of [
      format(started),
      format("%o", started),
      inspect(started, { depth: 9 }),
      JSON.stringify(started),
    ])
      expect(out).not.toContain(REQ);
    const err = (await w.r.poll(started).catch((e) => e)) as Error & {
      code: string;
      status: number;
    };
    expect(err.code).toBe("invalid_grant");
    expect(err.status).toBe(400);
    const sentProof = JSON.parse(
      w.seen.find((s) => s.path.endsWith("/nearby/poll"))!.body!,
    ).proof as string;
    for (const text of [err.message, inspect(err, { depth: 9 })]) {
      expect(text).not.toContain(REQ);
      expect(text).not.toContain(sentProof);
    }
  });

  it("poll is signed by the key start sent, or not sent", async () => {
    const w = await routes(
      {
        "POST /djdl/identity/nearby/start": startOk,
        "POST /djdl/identity/nearby/poll": () => json({ status: "pending" }),
      },
      null,
    );
    const started = await w.r.start();
    expect((await w.r.poll(started)).kind).toBe("pending");
    await expect(
      w.r.poll({ ...started, signKey: fixtureKeys("other").signKey }),
    ).rejects.toMatchObject({ code: "sign-in-failed" });
    expect(w.seen.filter((s) => s.path.endsWith("/nearby/poll"))).toHaveLength(
      1,
    );
  });

  it("poll reads a 429 as slow-down and a 503 as a transient server error with Retry-After", async () => {
    let n = 0;
    const w = await routes(
      {
        "POST /djdl/identity/nearby/start": startOk,
        "POST /djdl/identity/nearby/poll": () =>
          ++n === 1
            ? json({ status: "slow_down", interval: 6 }, 429)
            : json({ error: "unavailable" }, 503, { "retry-after": "7" }),
      },
      null,
    );
    const started = await w.r.start();
    expect(await w.r.poll(started)).toEqual({ kind: "slow-down", interval: 6 });
    await expect(w.r.poll(started)).rejects.toMatchObject({
      code: "server-error",
      retryAfterSeconds: 7,
    });
  });

  it("poll reads a 404 through a fresh discovery (N11)", async () => {
    let named = true;
    const w = await routes(
      {
        "POST /djdl/identity/nearby/start": startOk,
        "POST /djdl/identity/nearby/poll": () =>
          json({ error: { code: "not_found" } }, 404),
        "GET /djdl/.well-known/polaris.json": () =>
          discovery(named ? FULL : { endpoints: FULL.endpoints })({} as never),
      },
      null,
    );
    const started = await w.r.start();
    await expect(w.r.poll(started)).rejects.toMatchObject({
      code: "not_found",
    });
    named = false;
    expect(await w.r.poll(started)).toEqual({ kind: "unavailable" });
  });

  it("approve registers M's keys on a 409 and retries ONCE; a second 409 is final", async () => {
    let calls = 0;
    let puts = 0;
    const answer =
      (twice: boolean): Handler =>
      () => {
        calls += 1;
        return calls === 1 || twice
          ? json({ error: { code: "device_keys_required" } }, 409)
          : json({ status: "approved", deviceLabel: "Den" });
      };
    const mk = async (twice: boolean) => {
      calls = 0;
      puts = 0;
      return routes(
        {
          "POST /djdl/identity/nearby/approve": answer(twice),
          "PUT /djdl/devices/keys": () => (puts++, json({ keySeq: 1 })),
        },
        "pkeyt_m",
      );
    };
    const input = {
      request: REQ,
      deviceId: D_ID,
      signKey: fixtureKeys("d").signKey,
      agreeKey: fixtureKeys("d").agreeKey,
      decision: "approve",
    };
    const once = await mk(false);
    expect(await once.r.approve(input)).toMatchObject({
      kind: "approved",
      deviceLabel: "Den",
    });
    expect({ calls, puts }).toEqual({ calls: 2, puts: 1 });

    const twice = await mk(true);
    const r = await twice.r.approve(input);
    expect(r).toMatchObject({ kind: "refused", status: 409 });
    // One retry and no more; finish() must close, not ask for another round.
    expect({ calls, puts }).toEqual({ calls: 2, puts: 1 });
    expect(JSON.parse(r.finish.body!).code).not.toBe("device_keys_required");
  });

  it("approve gives finish() a flat body, and reads a 404 through a fresh discovery (N11)", async () => {
    let named = true;
    let status = 403;
    let body: unknown = { error: { code: "not_nearby" } };
    const w = await routes(
      {
        "POST /djdl/identity/nearby/approve": () => json(body, status),
        "GET /djdl/.well-known/polaris.json": () =>
          discovery(named ? FULL : { endpoints: FULL.endpoints })({} as never),
      },
      "pkeyt_m",
    );
    const input = {
      request: REQ,
      deviceId: D_ID,
      signKey: fixtureKeys("d").signKey,
      agreeKey: fixtureKeys("d").agreeKey,
      decision: "approve",
    };
    const a = await w.r.approve(input);
    expect(a).toMatchObject({
      kind: "refused",
      status: 403,
      code: "not_nearby",
      finish: {
        http: 403,
        body: '{"code":"not_nearby"}',
        discoveryNearby: true,
      },
    });
    status = 404;
    body = { error: { code: "not_found" } };
    expect(await w.r.approve(input)).toMatchObject({
      kind: "refused",
      status: 404,
      finish: { http: 404, discoveryNearby: true },
    });
    named = false;
    expect(await w.r.approve(input)).toMatchObject({
      kind: "unavailable",
      finish: { http: 404, discoveryNearby: false },
    });
  });

  it("approve needs M to be signed in, and sends the ids and keys it was given", async () => {
    const out = await routes({}, null);
    await expect(
      out.r.approve({
        request: REQ,
        deviceId: D_ID,
        signKey: "a",
        agreeKey: "b",
        decision: "deny",
      }),
    ).rejects.toMatchObject({ code: "account_required" });

    const w = await routes(
      {
        "POST /djdl/identity/nearby/approve": () =>
          new Response(null, { status: 204 }),
      },
      "pkeyt_m",
    );
    const keys = {
      signKey: fixtureKeys("x").signKey,
      agreeKey: fixtureKeys("x").agreeKey,
    };
    expect(
      await w.r.approve({
        request: REQ,
        deviceId: D_ID,
        ...keys,
        decision: "deny",
      }),
    ).toMatchObject({ kind: "denied", finish: { http: 204 } });
    const sent = JSON.parse(
      w.seen.find((s) => s.path.endsWith("/nearby/approve"))!.body!,
    );
    expect(sent).toMatchObject({
      request: REQ,
      deviceId: D_ID,
      ...keys,
      decision: "deny",
    });
    expect(sent.choice).toBeUndefined();
  });
});
