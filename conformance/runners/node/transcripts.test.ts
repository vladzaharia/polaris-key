// The Node transcript replayer (P1b-03, PARITY §4.2): drive `@polaris-key/node`'s
// `PolarisKeyClient` through every recorded conversation its parity manifest says it can have,
// against a fake server that serves the Worker's recorded answers and asserts every request.
//
// @pkey-feature core.discover core.sync core.cache license.activate license.enroll
// @pkey-feature license.deactivate devices.register devices.report
//
// Which transcripts run is DATA: `applies()` reads `packages/sdk-node/parity.json`, so a
// transcript for a feature Node has not implemented (register-reregister-401, until P1b-06) is
// listed as skipped rather than failing, and starts running the moment the manifest claims it.
//
// The SDK clock is Vitest's frozen `Date`, moved to each step's `now`: the recorded documents
// were signed at a fixed instant and expire an hour later, so replaying them against the wall
// clock would test the calendar, not the client.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PolarisKeyClient,
  type CacheRecordV3,
  type Store,
} from "@polaris-key/node";
import {
  applies,
  doctor,
  loadManifest,
  loadTranscripts,
  ReplayServer,
  type JsonValue,
  type Step,
  type Transcript,
} from "./transcriptReplay.js";

const MANIFEST = loadManifest("packages/sdk-node/parity.json");
const TRANSCRIPTS = loadTranscripts();

/** A fixed hashed fingerprint, so the replay does not depend on what this host can read. */
const FINGERPRINT = {
  components: { machineUuid: "REPLAYmachineUuid00000" },
  hwid: "REPLAYhwid0000000000000000000000",
};

/** The store the replay starts from: the transcript's device id and token, nothing cached. */
class TranscriptStore implements Store {
  token: string | null;
  private cache: CacheRecordV3 | null = null;
  constructor(
    private readonly deviceId: string,
    token: string | undefined,
  ) {
    this.token = token ?? null;
  }
  async getToken() {
    return this.token;
  }
  async setToken(t: string) {
    this.token = t;
  }
  async clearToken() {
    this.token = null;
  }
  async getDeviceId() {
    return this.deviceId;
  }
  async readCache() {
    return this.cache;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = rec;
  }
  async clearCache() {
    this.cache = null;
  }
}

type Observed = Record<string, JsonValue>;

/** THE mapping from transcript verbs and `expect` keys onto the Node SDK. Kept in one place. */
async function act(
  client: PolarisKeyClient,
  store: TranscriptStore,
  step: Step,
): Promise<Observed> {
  const out: Observed = {};
  switch (step.action) {
    case "discover":
      out.result = (await client.discover()).kind;
      break;
    case "sync": {
      const r = await client.sync({ force: step.args.force === true });
      out.applied = r.applied;
      out.unauthorized = r.unauthorized === true;
      out.blocked = r.blocked === true;
      const docs: Record<string, JsonValue> = {};
      for (const [slice, outcome] of Object.entries(r.documents))
        if (outcome && outcome.kind !== "skipped") docs[slice] = outcome.kind;
      out.documents = docs;
      break;
    }
    case "activate":
      out.result = (
        await client.license.activateWithKey(String(step.args.key))
      ).kind;
      break;
    case "enroll":
      out.result = (await client.license.enroll()).kind;
      break;
    case "register":
      out.result = (await client.devices.register()).kind;
      break;
    case "deactivate":
      await client.license.deactivate();
      break;
    case "report":
      out.result = await client.devices.report();
      break;
    default:
      throw new Error(`unknown action ${step.action}`);
  }
  const services: Record<string, JsonValue> = {};
  for (const [slug, s] of Object.entries(client.capabilities()))
    services[slug] = s.enabled;
  out.services = services;
  out.licenseStatus = client.status().status;
  out.tokenHeld = store.token !== null;
  return out;
}

/** Replay `t` step by step; throws on the first step whose traffic or outcome disagrees. */
async function replay(t: Transcript): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"], now: t.now * 1000 });
  const server = new ReplayServer(t);
  const store = new TranscriptStore(t.initial.deviceId, t.initial.token);
  const client = new PolarisKeyClient({
    productSlug: t.product,
    baseUrl: t.baseUrl,
    version: t.initial.version,
    trust: { pinnedKeys: t.trust },
    store,
    fetchImpl: server.fetch as typeof fetch,
    requestTimeoutMs: 0,
    ...(t.initial.services
      ? { expectedServices: t.initial.services as never }
      : {}),
  });
  client.devices.fingerprint = () => FINGERPRINT;
  await client.init();
  for (let i = 0; i < t.steps.length; i += 1) {
    const step = server.beginStep(i);
    vi.setSystemTime((step.now ?? t.now) * 1000);
    const observed = await act(client, store, step);
    server.endStep();
    for (const [key, want] of Object.entries(step.expect))
      expect(
        observed[key],
        `${t.id} step ${i} (${step.action}): ${key}`,
      ).toEqual(want);
  }
  client.close();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HTTP transcripts: @polaris-key/node", () => {
  it("the transcript set is present", () => {
    expect(TRANSCRIPTS.length).toBeGreaterThan(0);
  });

  for (const t of TRANSCRIPTS) {
    const run = applies(t, MANIFEST) ? it : it.skip;
    run(`${t.id} (${t.features.join(", ")})`, async () => {
      await replay(t);
    });
  }
});

describe("the Node replayer fails on a doctored transcript", () => {
  const base = TRANSCRIPTS.find((t) => t.id === "sync-etag-304")!;

  it("an extra request (the recording lacks the report)", async () => {
    const t = doctor(base, 0, (items) =>
      items.filter((x) => !x.request.path.endsWith("/devices/report")),
    );
    await expect(replay(t)).rejects.toThrow(
      /unexpected request: POST \/djdl\/devices\/report/,
    );
  });

  it("an omitted request (the recording expects a second trust fetch)", async () => {
    const t = doctor(base, 0, (items) => [...items, items[0]!]);
    await expect(replay(t)).rejects.toThrow(
      /expected request not sent: GET \/djdl\/\.well-known\/polaris-trust\.jws/,
    );
  });

  it("a dropped required header", async () => {
    const t = doctor(base, 0, (items) =>
      items.map((x) =>
        x.request.path.endsWith("/license/document")
          ? {
              ...x,
              request: {
                ...x.request,
                requiredHeaders: [
                  ...x.request.requiredHeaders,
                  "x-pkey-doctored",
                ],
              },
            }
          : x,
      ),
    );
    await expect(replay(t)).rejects.toThrow(
      /required header x-pkey-doctored: missing/,
    );
  });

  it("a different client outcome", async () => {
    const t = JSON.parse(JSON.stringify(base)) as Transcript;
    t.steps[1]!.expect.documents = { license: "applied", config: "applied" };
    await expect(replay(t)).rejects.toThrow(/step 1 \(sync\): documents/);
  });
});
