// The Node transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/: drive `@polaris-key/node`'s
// `PolarisKeyClient` through every recorded conversation its parity manifest says it can have,
// against a fake server that serves the Worker's recorded answers and asserts every request.
//
// @pkey-feature core.discover core.sync core.cache license.activate license.enroll
// @pkey-feature license.deactivate license.reregister devices.register devices.report
// @pkey-feature config.schema release.changelog release.download
// @pkey-feature identity.devicecode config.mint
// @pkey-feature update.feed release.record update.decide
// @pkey-feature packs.apply.chunk
//
// Which transcripts run is DATA: `applies()` reads `packages/sdk-node/parity.json`, so a
// transcript for a feature Node has not implemented is listed as skipped rather than failing,
// and starts running the moment the manifest claims it.
//
// The SDK clock is Vitest's frozen `Date`, moved to each step's `now`: the recorded documents
// were signed at a fixed instant and expire an hour later, so replaying them against the wall
// clock would test the calendar, not the client.
//
// `updateDecide` (plans/P3-01.md §5, §6) is `client.update.decide({channel, staged?,
// skipVersion?})`, and its `expect` keys are the `UpdateCheck`'s own (`channel`, `decision`,
// `feed`, `record`, `errors`). `initial.update` is the host's configuration: `pinnedReleaseKeys`,
// `outlet`, `platform`, `arch`, the `installed` build (its `version` is `CoreOptions.version`)
// and `methods` become `PolarisKeyClientOptions.update`, and `cache` (the `feeds` and
// `releaseRecords` slices) seeds the store's cache record. A transcript with `initial.update` and
// no `initial.services` runs with Release, Distribution and Update expected (the D-21 gate is
// checked before discovery). Node loads discovery itself when the session has not; a transcript
// that never ran a `discover` step, and records no discovery exchange in the step, has it
// answered here with the Worker's standard templates — the same fallback React's replayer uses —
// so the recording only has to hold the feed and record traffic.
//
// `chunkRange` (P4-32, plans/P4-32.md §5) is client-core's `chunkRangeFetch` over the Node packs
// client's own object fetch (`client.update.packs`'s `fetchObject`, reached through a typed cast:
// TypeScript's `private` is compile-time only), against the blobs template the last discover
// returned. `range` is the fetch's status; `bytes` the body it returned, as a string.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PolarisError,
  PolarisKeyClient,
  type CacheRecordV3,
  type SignInPrompt,
  type Store,
} from "@polaris-key/node";
import { chunkRangeFetch, recordHash } from "@polaris-key/client-core";
import { signJws } from "@polaris-key/jws";
import {
  applies,
  doctor,
  loadManifest,
  loadTranscripts,
  REPO_ROOT,
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

/** `initial.update` (plans/P3-01.md §6): the host's update configuration and starting cache. */
interface InitialUpdate {
  pinnedReleaseKeys: Record<string, string>;
  outlet?: unknown;
  platform: string;
  arch: string;
  installed: {
    version?: string;
    binaryVersion?: string;
    buildNumber?: string | null;
    format?: string | null;
    engine?: string | null;
  };
  methods?: string[];
  cache?: {
    feeds?: Record<string, string>;
    releaseRecords?: Record<string, string>;
  };
}

function initialUpdate(t: Transcript): InitialUpdate | undefined {
  return (t.initial as { update?: InitialUpdate }).update;
}

/** The Worker's standard discovery document, for a transcript that loads none itself. */
function standardDiscovery(t: Transcript): string {
  const base = `${t.baseUrl}/${t.product}`;
  return JSON.stringify({
    product: t.product,
    services: {
      release: {
        enabled: true,
        endpoints: { record: `${base}/release/records/{sha256}` },
      },
      distribution: {
        enabled: true,
        endpoints: {
          builds: `${base}/distribution/builds/{selector}/{buildId}`,
        },
      },
      update: {
        enabled: true,
        endpoints: { feed: `${base}/update/{channel}/feed.jws` },
      },
    },
  });
}

/** The replay's memory between steps: the prompt the last `beginSignIn` returned. */
interface Session {
  prompt: SignInPrompt | null;
}

/** THE mapping from transcript verbs and `expect` keys onto the Node SDK. Kept in one place. */
async function act(
  client: PolarisKeyClient,
  store: TranscriptStore,
  step: Step,
  session: Session,
): Promise<Observed> {
  const out: Observed = {};
  switch (step.action) {
    case "beginSignIn": {
      const name = step.args.deviceName;
      const p = await client.identity.beginSignIn(
        typeof name === "string" ? { deviceName: name } : {},
      );
      session.prompt = p;
      out.prompt = {
        userCode: p.userCode,
        verificationUri: p.verificationUri,
        verificationUriComplete: p.verificationUriComplete,
        expiresIn: p.expiresIn,
        interval: p.interval,
      };
      break;
    }
    case "pollSignIn": {
      const poll = await client.identity.pollSignIn(session.prompt!);
      out.result = poll.status;
      if (poll.status === "slow-down") out.interval = poll.interval;
      break;
    }
    case "waitForSignIn":
      out.result = (
        await client.identity.waitForSignIn(session.prompt!)
      ).status;
      break;
    case "mintToken":
      try {
        const minted = await client.config.mintToken(
          String(step.args.recipeId),
        );
        out.result = "ok";
        out.token = minted.token;
        out.expiresAt = minted.expiresAt;
      } catch (e) {
        if (!(e instanceof PolarisError)) throw e;
        out.result = e.code;
      }
      break;
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
    case "fetchSchema":
      out.catalog = (await client.config.fetchSchema()) as JsonValue;
      break;
    case "changelog":
      try {
        out.entries = (await client.release.changelog()) as never;
        out.result = "ok";
      } catch (e) {
        if (!(e instanceof PolarisError)) throw e;
        out.result = "error";
        out.code = e.code;
      }
      break;
    case "installUrl":
      out.url = client.release.installUrl();
      break;
    case "chunkRange": {
      const packs = client.update.packs as unknown as {
        fetchObject: Parameters<typeof chunkRangeFetch>[0];
      };
      const fetchRange = chunkRangeFetch((req) => packs.fetchObject(req));
      const r = await fetchRange({
        bundle: String(step.args.bundle),
        offset: Number(step.args.offset),
        length: Number(step.args.length),
      });
      out.range = r.status;
      if (r.status === "ok") {
        const parts: Uint8Array[] = [];
        for await (const c of r.chunks) parts.push(c);
        out.bytes = Buffer.concat(parts).toString("latin1");
      }
      break;
    }
    case "updateDecide":
      try {
        const check = await client.update.decide({
          ...(typeof step.args.channel === "string"
            ? { channel: step.args.channel }
            : {}),
          ...(step.args.staged !== undefined
            ? { staged: step.args.staged as never }
            : {}),
          ...(step.args.skipVersion !== undefined
            ? { skipVersion: step.args.skipVersion as string | null }
            : {}),
        });
        Object.assign(out, check as unknown as Observed);
        out.result = "ok";
      } catch (e) {
        if (!(e instanceof PolarisError)) throw e;
        out.result = "error";
        out.code = e.code;
      }
      break;
    case "downloadUrl":
      out.url = client.release.downloadUrl(
        String(step.args.version),
        String(step.args.binary),
        String(step.args.arch),
        {
          checksum: step.args.checksum === true,
          dmg: step.args.dmg === true,
        },
      );
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
  const u = initialUpdate(t);
  if (u?.cache)
    await store.writeCache({
      v: 3,
      ...(u.cache.feeds ? { feeds: { ...u.cache.feeds } } : {}),
      ...(u.cache.releaseRecords
        ? { releaseRecords: { ...u.cache.releaseRecords } }
        : {}),
    });
  let currentStep: Step | null = null;
  // The standard discovery answer, for a transcript that loads discovery nowhere itself.
  let discoverySteps = t.steps.some((s) => s.action === "discover");
  const discoveryPath = `/${t.product}/.well-known/polaris.json`;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const step = currentStep;
    if (
      !discoverySteps &&
      url.pathname === discoveryPath &&
      step &&
      !step.exchanges.items.some((x) => x.request.path === discoveryPath)
    ) {
      discoverySteps = true;
      return new Response(standardDiscovery(t), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return server.fetch(input, init);
  }) as typeof fetch;
  const services =
    t.initial.services ??
    (u ? ["release", "distribution", "update"] : undefined);
  const client = new PolarisKeyClient({
    productSlug: t.product,
    baseUrl: t.baseUrl,
    version: u?.installed.version ?? t.initial.version,
    trust: { pinnedKeys: t.trust },
    store,
    fetchImpl,
    requestTimeoutMs: 0,
    ...(services ? { expectedServices: services as never } : {}),
    ...(u
      ? {
          update: {
            pinnedReleaseKeys: u.pinnedReleaseKeys,
            ...(u.outlet !== undefined ? { outlet: u.outlet as never } : {}),
            platform: u.platform as never,
            arch: u.arch as never,
            ...(u.installed.binaryVersion !== undefined
              ? { binaryVersion: u.installed.binaryVersion }
              : {}),
            buildNumber: u.installed.buildNumber ?? null,
            format: u.installed.format ?? null,
            engine: u.installed.engine ?? null,
            ...(u.methods ? { methods: u.methods as never } : {}),
          },
        }
      : {}),
  });
  client.devices.fingerprint = () => FINGERPRINT;
  await client.init();
  const session: Session = { prompt: null };
  for (let i = 0; i < t.steps.length; i += 1) {
    const step = server.beginStep(i);
    currentStep = step;
    vi.setSystemTime((step.now ?? t.now) * 1000);
    const observed = await act(client, store, step, session);
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

// @pkey-feature packs.apply.chunk
describe("the Node replayer's chunkRange mapping fails on a doctored transcript", () => {
  const base = TRANSCRIPTS.find((t) => t.id === "packs-chunk-range")!;

  it("a recorded Content-Range that is not the requested run", async () => {
    const t = doctor(base, 1, (items) =>
      items.map((x) => ({
        ...x,
        response: {
          ...x.response,
          headers: { ...x.response.headers, "content-range": "bytes 17-40/64" },
        },
      })),
    );
    await expect(replay(t)).rejects.toThrow(/step 1 \(chunkRange\): range/);
  });
});

// @pkey-feature update.feed release.record update.decide
describe("the Node replayer's updateDecide mapping (a synthetic transcript)", () => {
  // P3-03's `update-feed-rollback` and `update-record-by-hash` run above. This transcript has
  // their shape — `initial.update`, `action: "updateDecide"`, `args.channel` and
  // `expect: {channel, feed, record, errors, decision}` — signed with the corpus test keys, and
  // pins the two halves together in one conversation: step 0 asks for `latest` and commits the
  // feed under `stable`; step 1 gets a LOWER `seq` for `stable`, so the floor of the feed step 0
  // committed refuses it (`feed-rollback`) and the record comes from the cache. It also proves
  // the replayer fails when the traffic or an expectation differs.
  const KEYS = Object.fromEntries(
    (
      JSON.parse(
        readFileSync(
          join(REPO_ROOT, "conformance", "corpus", "v2", "cases.json"),
          "utf8",
        ),
      ) as {
        keys: {
          kid: string;
          publicKeyRaw: string;
          privateKeyPkcs8Pem: string;
        }[];
      }
    ).keys.map((k) => [k.kid, k]),
  );
  const PRODUCT_KID = "pkey-test-prod-2026";
  const RELEASE_KID = "djdl-release-test-2026";
  let t: Transcript;

  beforeAll(async () => {
    const recordJws = await signJws(
      {
        schemaVersion: 1,
        aud: "djdl",
        deliverable: "app",
        kind: "app",
        version: "1.5.0",
        seq: 15,
        issuedAt: 1_699_990_000,
        builds: [
          {
            id: "linux-tar",
            platform: "linux",
            arch: "x86_64",
            format: "tar.gz",
            artifacts: [
              {
                name: "a.tgz",
                role: "payload",
                sha256: "a".repeat(64),
                size: 1,
              },
            ],
          },
        ],
      },
      KEYS[RELEASE_KID]!.privateKeyPkcs8Pem,
      RELEASE_KID,
      "pkey-release+jws",
    );
    const hash = await recordHash(recordJws);
    const feed = (seq: number, issuedAt: number) =>
      signJws(
        {
          schemaVersion: 1,
          iss: "key.plrs.im",
          aud: "djdl",
          channel: "stable",
          selector: {},
          seq,
          issuedAt,
          expiresAt: issuedAt + 900,
          app: {
            deliverable: "app",
            versionScheme: "semver",
            targets: [
              {
                platform: "linux",
                release: { sha256: hash, seq: 15, version: "1.5.0" },
                floor: null,
                critical: false,
                outlets: {
                  direct: {
                    kind: "direct",
                    live: { version: "1.5.0", seq: 15 },
                    halted: false,
                  },
                },
              },
            ],
          },
        },
        KEYS[PRODUCT_KID]!.privateKeyPkcs8Pem,
        PRODUCT_KID,
        "pkey-feed+jws",
      );
    const seq8 = await feed(8, 1_700_000_000);
    const seq7 = await feed(7, 1_700_000_050);
    const get = (path: string, body: string) => ({
      request: {
        method: "GET",
        path,
        headers: { "X-PKey-Device": "{deviceId}" },
        requiredHeaders: [],
        body: null,
      },
      response: { status: 200, headers: {}, body },
    });
    const decision = {
      action: "binary",
      method: "download",
      release: { version: "1.5.0", seq: 15, sha256: hash },
      build: "linux-tar",
      mandatory: false,
      critical: false,
      prestage: [],
      discardStaged: false,
    };
    t = {
      transcriptVersion: 1,
      id: "synthetic-update-decide",
      description:
        "updateDecide: latest commits under stable, then a lower seq is refused",
      features: ["update.feed", "release.record", "update.decide"],
      requires: ["core.store"],
      product: "djdl",
      baseUrl: "https://key.plrs.im",
      now: 1_700_000_100,
      trust: { [PRODUCT_KID]: KEYS[PRODUCT_KID]!.publicKeyRaw },
      initial: {
        deviceId: "dev_replay",
        version: "1.4.0",
        update: {
          pinnedReleaseKeys: { [RELEASE_KID]: KEYS[RELEASE_KID]!.publicKeyRaw },
          outlet: "direct",
          platform: "linux",
          arch: "x86_64",
          installed: { version: "1.4.0" },
          cache: { feeds: {}, releaseRecords: {} },
        },
      } as Transcript["initial"],
      steps: [
        {
          action: "updateDecide",
          args: { channel: "latest" },
          exchanges: {
            ordered: true,
            items: [
              get("/djdl/update/latest/feed.jws?platform=linux", seq8),
              get(`/djdl/release/records/${hash}`, recordJws),
            ],
          },
          expect: {
            channel: "stable",
            feed: "network",
            record: "network",
            errors: [],
            decision,
          },
        },
        {
          action: "updateDecide",
          args: { channel: "stable" },
          exchanges: {
            ordered: true,
            items: [get("/djdl/update/stable/feed.jws?platform=linux", seq7)],
          },
          expect: {
            channel: "stable",
            feed: "committed",
            record: "cache",
            errors: [{ code: "feed-rollback", detail: null }],
            decision,
          },
        },
      ],
    };
  });

  it("applies to Node once the three features are implemented", () => {
    expect(applies(t, MANIFEST)).toBe(true);
  });

  it("replays both steps: the feed commits under its claim, and its floor refuses a rollback", async () => {
    await replay(t);
  });

  it("fails when the record request the decision makes is not in the recording", async () => {
    const doctored = doctor(t, 0, (items) => items.slice(0, 1));
    await expect(replay(doctored)).rejects.toThrow(
      /unexpected request: GET \/djdl\/release\/records\//,
    );
  });

  it("fails when a recorded expectation differs", async () => {
    const wrong = structuredClone(t);
    wrong.steps[1]!.expect.errors = [];
    await expect(replay(wrong)).rejects.toThrow(
      /step 1 \(updateDecide\): errors/,
    );
  });
});
