// @vitest-environment node
//
// @pkey-feature core.discover config.schema release.changelog release.download update.feed release.record update.decide
// @pkey-feature packs.apply.chunk
// @pkey-feature core.sync core.cache core.store license.activate license.enroll license.deactivate
// @pkey-feature license.reregister devices.register devices.report identity.devicecode config.mint
// @pkey-feature commerce.receipt license.refusals
//
// BEARER MODE (SDK-PARITY-PASS §3.17, SP-R02). The transcripts that authenticate with a `pkeyt_`
// device token run through the browser's bearer engine, `BearerSession`
// (src/browser/bearer/session.ts) — the code `browserAdapter({ auth: "bearer" })` drives —
// over a store holding the transcript's device id and token. `licenseStatus` is the gate the
// adapter projects from the session's state (the same `projectState` both adapters run) and
// `tokenHeld` whether the session holds a token. A browser has no fingerprint; like the Node
// replayer, this one hands the session a fixed hashed one, because the recordings were made by a
// host that had one.
//
// The React transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/, over the shared TypeScript replay engine
// in `conformance/runners/node/transcriptReplay.ts`.
//
// Which transcripts apply is DATA, read from `packages/sdk-react/parity.json` with the same rule
// every SDK uses: every feature the transcript proves is `implemented`, and nothing it
// presupposes is `na`. Every transcript that authenticates with a `pkeyt_` device token
// requires `core.store`, which React declares `na` on both its runtimes: the browser adapter is
// a cookie session (browserAdapter.ts), and the desktop renderer reaches the Worker through the
// host's Node SDK, which the Node replayer covers. What is left is what the browser transport
// performs itself, over the same standalone functions the browser adapter calls: discovery
// (`discoverProduct`), the catalog fetch (`fetchCatalog`) and the Release client
// (`fetchChangelog`, `buildInstallUrl`, `buildDownloadUrl`).
//
// `updateDecide` (plans/P3-01.md §5, §6) runs the browser transport's own decision path,
// `decideBrowserUpdate`, with `initial.update` as the page's configuration: the pinned release
// keys, the host outlet, the platform and arch, the installed build, the methods and the starting
// cache slices, which carry from step to step as the page persists them. The feed verifies
// against the transcript's `trust` (the page's pinned product keys). The endpoints come from the
// last discovery the transcript ran, else the Worker's standard templates. P3-03's two update
// transcripts require `core.store`, which React declares `na`, so they do not apply here; the
// mapping is exercised by the synthetic transcript at the end of this file, and is ready for an
// update transcript that does not presuppose a device-token store.
//
// `chunkRange` (P4-32, plans/P4-32.md §5) is client-core's `chunkRangeFetch` over the browser
// pack transport's own object fetch (`browserObjectFetch`, the closure `createBrowserPacks` hands
// the engine), against the blobs template of the last discovery the transcript ran. The browser
// sends no `X-PKey-*` headers there, which is why the recording asserts none.
//
// `result` is `discoverProduct`'s outcome; React reports a 404 as `{kind:"error",status:404}`,
// which is the vocabulary's `not-found`. `services` is the map the browser adapter installs from
// it (BrowserAdapter.loadCapabilities): the document's map on success, otherwise the
// pre-discovery belief, which with no `expectServices` is `defaultServices()`.

import { beforeAll, describe, expect, it } from "vitest";
import { chunkRangeFetch, recordHash } from "@polaris-key/client-core";
import { browserObjectFetch } from "../src/packs/browserPacks.js";
import { newTestKey, signCompact } from "./fixtures.js";
import {
  discoverProduct,
  type DiscoveryDocument,
} from "../src/browser/discovery.js";
import {
  decideBrowserUpdate,
  type UpdateSlices,
} from "../src/browser/update.js";
import { resolveUpdateOutlet } from "@polaris-key/client-core";
import type {
  BinaryMethod,
  InstalledBuild,
  StagedUpdate,
} from "@polaris-key/protocol/update";
import { fetchCatalog } from "../src/browser/catalog.js";
import {
  buildDownloadUrl,
  buildInstallUrl,
  fetchChangelog,
} from "../src/browser/release.js";
import { PolarisError } from "../src/core/types.js";
import { projectState } from "../src/core/adapter.js";
import {
  BearerSession,
  type SignInPrompt,
} from "../src/browser/bearer/session.js";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import {
  copyServices,
  defaultServices,
  servicesFromList,
  type ServicesMap,
} from "../src/core/services.js";
import {
  applies,
  doctor,
  loadManifest,
  loadTranscripts,
  ReplayServer,
  type JsonValue,
  type Transcript,
} from "../../../conformance/runners/node/transcriptReplay.js";

const MANIFEST = loadManifest("packages/sdk-react/parity.json");
const TRANSCRIPTS = loadTranscripts();

/** `initial.update` (plans/P3-01.md §6): the client's update configuration and cache. */
interface InitialUpdate {
  pinnedReleaseKeys: Record<string, string>;
  outlet?: unknown;
  platform: string;
  arch: string;
  installed: Partial<InstalledBuild> & { version: string };
  methods?: BinaryMethod[];
  cache?: UpdateSlices;
}

/** The Worker's standard templates, for a transcript that runs no discovery first. */
function standardDiscovery(t: Transcript): DiscoveryDocument {
  const base = `${t.baseUrl}/${t.product}`;
  return {
    product: t.product,
    services: {
      update: {
        enabled: true,
        endpoints: { feed: `${base}/update/{channel}/feed.jws` },
      },
      release: {
        enabled: true,
        endpoints: { record: `${base}/release/records/{sha256}` },
      },
    },
  } as unknown as DiscoveryDocument;
}

/** A fixed hashed fingerprint, as the Node replayer's. */
const FINGERPRINT = {
  components: { machineUuid: "REPLAYmachineUuid00000" },
  hwid: "REPLAYhwid0000000000000000000000",
};

/** The store the replay starts from: the transcript's device id and token, nothing cached. */
class TranscriptStore implements Store {
  private cache: CacheRecordV3 | null = null;
  token: string | null;
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

async function replay(t: Transcript): Promise<void> {
  const server = new ReplayServer(t);
  let discovered: DiscoveryDocument | null = null;
  const initialUpdate = (t.initial as { update?: InitialUpdate }).update;
  let slices: UpdateSlices = structuredClone(initialUpdate?.cache ?? {});
  let belief: ServicesMap = t.initial.services
    ? servicesFromList(t.initial.services as never)
    : defaultServices();
  const base = {
    baseUrl: t.baseUrl,
    product: t.product,
    fetchImpl: server.fetch as typeof fetch,
  };
  let clock = t.now;
  const store = new TranscriptStore(t.initial.deviceId, t.initial.token);
  const session = new BearerSession({
    baseUrl: t.baseUrl,
    product: t.product,
    version: t.initial.version,
    fetchImpl: base.fetchImpl,
    now: () => clock,
    pinned: t.trust,
    store,
    enabled: (slug) => belief[slug].enabled,
    fingerprint: () => FINGERPRINT,
  });
  await session.init();
  let prompt: SignInPrompt | null = null;
  for (let i = 0; i < t.steps.length; i += 1) {
    const step = server.beginStep(i);
    clock = step.now ?? t.now;
    const observed: Record<string, JsonValue> = {};
    switch (step.action) {
      case "register":
        observed.result = (await session.register()).kind;
        break;
      case "sync": {
        const r = await session.sync({ force: step.args.force === true });
        observed.applied = r.applied;
        observed.unauthorized = r.unauthorized === true;
        observed.blocked = r.blocked === true;
        const docs: Record<string, JsonValue> = {};
        for (const [slice, o] of Object.entries(r.documents))
          if (o && o.kind !== "skipped") docs[slice] = o.kind;
        observed.documents = docs;
        break;
      }
      case "activate":
      case "enroll": {
        const r =
          step.action === "activate"
            ? await session.activate(String(step.args.key))
            : await session.enroll();
        // The adapter syncs after an acquisition, as Node's facade does.
        if (r.kind === "ok") await session.sync();
        // license.refusals: the §3.1 kind in the shared activationResult vocabulary
        // (`deviceLimit` → `device-limit`), and the server's code it was classified from.
        observed.result = r.kind.replace(
          /[A-Z]/g,
          (c) => `-${c.toLowerCase()}`,
        );
        observed.code = r.code;
        break;
      }
      case "deactivate":
        await session.deactivate();
        break;
      case "report":
        observed.result = await session.report();
        break;
      case "beginSignIn": {
        const name = step.args.deviceName;
        prompt = await session.beginSignIn(
          typeof name === "string" ? { deviceName: name } : {},
        );
        observed.prompt = {
          userCode: prompt.userCode,
          verificationUri: prompt.verificationUri,
          verificationUriComplete: prompt.verificationUriComplete,
          expiresIn: prompt.expiresIn,
          interval: prompt.interval,
        };
        break;
      }
      case "pollSignIn": {
        const poll = await session.pollSignIn(prompt!);
        observed.result = poll.status;
        if (poll.status === "slow-down") observed.interval = poll.interval;
        break;
      }
      case "waitForSignIn":
        observed.result = (
          await session.waitForSignIn(prompt!, { sleep: async () => undefined })
        ).status;
        break;
      case "mintToken":
        try {
          const minted = await session.mint(String(step.args.recipeId));
          observed.result = "ok";
          observed.token = minted.token;
          observed.expiresAt = minted.expiresAt;
        } catch (e) {
          if (!(e instanceof PolarisError)) throw e;
          observed.result = e.wireCode ?? e.code;
        }
        break;
      case "commerceBinding": {
        const b = await session.commerceBinding();
        observed.result = "ok";
        observed.bindingId = b.bindingId;
        observed.products = b.products as unknown as JsonValue;
        break;
      }
      case "commerceClaim": {
        const r = await session.commerceClaim(
          String(step.args.store) as "steam",
          step.args.payload as never,
        );
        if (r.kind === "ok") {
          observed.result = "ok";
          observed.flag = r.flag;
          observed.state = r.state;
          observed.granted = r.granted;
        } else {
          observed.result = r.code;
          if ("reason" in r && r.reason) observed.reason = r.reason;
        }
        break;
      }
      case "discover": {
        const r = await discoverProduct(base);
        if (r.kind === "ok") {
          belief = copyServices(r.services);
          discovered = r.document;
        }
        observed.result =
          r.kind === "error" && r.status === 404 ? "not-found" : r.kind;
        break;
      }
      case "fetchSchema":
        observed.catalog = (await fetchCatalog(base)) as JsonValue;
        break;
      case "changelog":
        try {
          // Bearer mode presents the device token, so an `entitled` changelog answers.
          const bearer = session.bearer;
          observed.entries = (await fetchChangelog({
            ...base,
            ...(bearer
              ? { headers: { authorization: `Bearer ${bearer}` } }
              : {}),
          })) as never;
          observed.result = "ok";
        } catch (e) {
          if (!(e instanceof PolarisError)) throw e;
          // React's `code` is its UI vocabulary; the code the other SDKs report is `wireCode`.
          observed.result = "error";
          observed.code = e.wireCode ?? e.code;
        }
        break;
      case "installUrl":
        observed.url = buildInstallUrl(t.baseUrl, t.product);
        break;
      case "downloadUrl":
        observed.url = buildDownloadUrl(
          t.baseUrl,
          t.product,
          String(step.args.version),
          String(step.args.binary),
          String(step.args.arch),
          {
            checksum: step.args.checksum === true,
            dmg: step.args.dmg === true,
          },
        );
        break;
      case "updateDecide": {
        const u = initialUpdate;
        if (!u) throw new Error(`${t.id}: updateDecide needs initial.update`);
        const outlet = resolveUpdateOutlet({ host: u.outlet });
        if (!outlet)
          throw new Error(`${t.id}: initial.update.outlet is invalid`);
        try {
          const r = await decideBrowserUpdate({
            ...base,
            headers: {},
            discovery: discovered ?? standardDiscovery(t),
            trust: t.trust,
            releaseKeys: u.pinnedReleaseKeys,
            now: step.now ?? t.now,
            installId: t.initial.deviceId,
            installed: {
              buildNumber: null,
              format: null,
              engine: null,
              ...u.installed,
              platform: u.platform,
              arch: u.arch,
            },
            outlet,
            methods: u.methods ?? ["download"],
            cache: slices,
            ...(typeof step.args.channel === "string"
              ? { channel: step.args.channel }
              : {}),
            ...(step.args.staged !== undefined
              ? { staged: step.args.staged as unknown as StagedUpdate | null }
              : {}),
            ...(step.args.skipVersion !== undefined
              ? { skipVersion: step.args.skipVersion as string | null }
              : {}),
          });
          slices = r.cache;
          Object.assign(
            observed,
            r.check as unknown as Record<string, JsonValue>,
          );
          observed.result = "ok";
        } catch (e) {
          if (!(e instanceof PolarisError)) throw e;
          observed.result = "error";
          observed.code = e.wireCode ?? e.code;
        }
        break;
      }
      case "chunkRange": {
        const doc = discovered as {
          services?: Record<
            string,
            { enabled?: boolean; endpoints?: Record<string, string> }
          >;
        } | null;
        const dist = doc?.services?.distribution;
        const fetchRange = chunkRangeFetch(
          browserObjectFetch({
            blobs: () =>
              dist?.enabled === true ? (dist.endpoints?.blobs ?? null) : null,
            baseUrl: t.baseUrl,
            fetchImpl: base.fetchImpl,
          }),
        );
        const r = await fetchRange({
          bundle: String(step.args.bundle),
          offset: Number(step.args.offset),
          length: Number(step.args.length),
        });
        observed.range = r.status;
        if (r.status === "ok") {
          let text = "";
          for await (const c of r.chunks)
            text += new TextDecoder("latin1").decode(c);
          observed.bytes = text;
        }
        break;
      }
      default:
        throw new Error(
          `the React replayer has no mapping for "${step.action}"`,
        );
    }
    server.endStep();
    observed.services = Object.fromEntries(
      Object.entries(belief).map(([slug, s]) => [slug, s.enabled]),
    );
    const st = session.syncState();
    observed.licenseStatus = projectState(
      "browser",
      { license: st.doc, config: st.config ?? {} },
      {
        activation: st.activation,
        now: clock,
        highWaterMark: st.highWaterMark ?? 0,
        lastSyncUnauthorized: st.lastSyncUnauthorized,
        blocked: st.blocked ?? null,
        lastVerifiedAt: st.lastVerifiedAt ?? null,
      },
      { capabilities: belief },
    ).status;
    observed.tokenHeld = session.hasToken;
    for (const [key, want] of Object.entries(step.expect))
      expect(observed[key], `${t.id} step ${i}: ${key}`).toEqual(want);
  }
}

describe("HTTP transcripts: @polaris-key/react", () => {
  it("replays every transcript but the planned features': the cookie-free bearer engine closed the device-token ones", () => {
    const ids = TRANSCRIPTS.filter((t) => applies(t, MANIFEST)).map(
      (t) => t.id,
    );
    // Planned here, so their transcripts do not apply: commerce.receipt (LX-20; the Worker's CORS
    // list does not cover distribution/commerce yet), ui.boot (no boot() in React), release.fetch
    // and release.distribution (no licensed fetch or download model), and telemetry.updates (the
    // bearer engine drains a journal, but nothing in the adapter records update events yet).
    const plannedHere = [
      "commerce.receipt",
      "ui.boot",
      "release.fetch",
      "release.distribution",
      "telemetry.updates",
    ];
    const expected = TRANSCRIPTS.filter(
      (t) => !t.features.some((f) => plannedHere.includes(f)),
    ).map((t) => t.id);
    expect(ids.sort()).toEqual(expected.sort());
  });

  for (const t of TRANSCRIPTS) {
    const run = applies(t, MANIFEST) ? it : it.skip;
    run(`${t.id} (${t.features.join(", ")})`, async () => {
      await replay(t);
    });
  }
});

// @pkey-feature packs.apply.chunk
describe("the React replayer's chunkRange mapping fails on a doctored transcript", () => {
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
    await expect(replay(t)).rejects.toThrow(/step 1: range/);
  });
});

describe("the React replayer fails on a doctored transcript", () => {
  const base = TRANSCRIPTS.find((t) => t.id === "discovery-capabilities")!;

  it("an extra request (the recording has no discovery exchange)", async () => {
    const t = doctor(base, 0, () => []);
    await expect(replay(t)).rejects.toThrow(
      /unexpected request: GET \/djdl\/\.well-known\/polaris\.json/,
    );
  });

  it("an omitted request (the recording expects a second discovery fetch)", async () => {
    const t = doctor(base, 0, (items) => [...items, items[0]!]);
    await expect(replay(t)).rejects.toThrow(
      /expected request not sent: GET \/djdl\/\.well-known\/polaris\.json/,
    );
  });

  it("a dropped required header", async () => {
    const t = doctor(base, 0, (items) =>
      items.map((x) => ({
        ...x,
        request: { ...x.request, requiredHeaders: ["x-pkey-doctored"] },
      })),
    );
    await expect(replay(t)).rejects.toThrow(
      /required header x-pkey-doctored: missing/,
    );
  });
});

// @pkey-feature update.feed release.record update.decide
describe("the React replayer's updateDecide mapping (a synthetic transcript)", () => {
  // P3-03's update transcripts require `core.store` (React: `na`), so none applies here. This
  // transcript has the same shape — `initial.update`, `action: "updateDecide"`, `args.channel`
  // and `expect: {channel, feed, record, errors, decision}` — signed with throwaway keys.
  let t: Transcript;

  beforeAll(async () => {
    const product = await newTestKey("djdl-test");
    const releaseKey = await newTestKey("djdl-release-test");
    const recordJws = await signCompact(
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
            id: "web",
            platform: "web",
            arch: "wasm32",
            format: "zip",
            artifacts: [
              {
                name: "w.zip",
                role: "payload",
                sha256: "a".repeat(64),
                size: 1,
              },
            ],
          },
        ],
      },
      releaseKey,
      "pkey-release+jws",
    );
    const hash = await recordHash(recordJws);
    const feedJws = await signCompact(
      {
        schemaVersion: 1,
        iss: "key.plrs.im",
        aud: "djdl",
        channel: "stable",
        selector: {},
        seq: 7,
        issuedAt: 1_700_000_000,
        expiresAt: 1_700_000_900,
        app: {
          deliverable: "app",
          versionScheme: "semver",
          targets: [
            {
              platform: "web",
              release: { sha256: hash, seq: 15, version: "1.5.0" },
              floor: null,
              critical: false,
              outlets: {
                web: {
                  kind: "web",
                  live: { version: "1.5.0", seq: 15 },
                  halted: false,
                },
              },
            },
          ],
        },
      },
      product,
      "pkey-feed+jws",
    );
    const get = (path: string, body: string) => ({
      request: {
        method: "GET",
        path,
        headers: {},
        requiredHeaders: [],
        body: null,
      },
      response: { status: 200, headers: {}, body },
    });
    const decision = {
      action: "platform",
      release: { version: "1.5.0", seq: 15 },
      mandatory: false,
      critical: false,
      discardStaged: false,
    };
    t = {
      transcriptVersion: 1,
      id: "synthetic-update-decide",
      description:
        "updateDecide over a feed and its pinned record, then the cached record",
      features: ["update.feed", "release.record", "update.decide"],
      requires: [],
      product: "djdl",
      baseUrl: "https://key.plrs.im",
      now: 1_700_000_100,
      trust: { [product.kid]: product.raw },
      initial: {
        deviceId: "dev_1",
        version: "1.4.0",
        update: {
          pinnedReleaseKeys: { [releaseKey.kid]: releaseKey.raw },
          outlet: "web",
          platform: "web",
          arch: "wasm32",
          installed: { version: "1.4.0" },
          cache: { feeds: {}, releaseRecords: {} },
        },
      } as Transcript["initial"],
      steps: [
        {
          action: "updateDecide",
          args: { channel: "latest" },
          exchanges: {
            ordered: false,
            items: [
              get("/djdl/update/latest/feed.jws?platform=web", feedJws),
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
            ordered: false,
            items: [get("/djdl/update/stable/feed.jws?platform=web", feedJws)],
          },
          expect: {
            channel: "stable",
            feed: "network",
            record: "cache",
            errors: [],
          },
        },
      ],
    };
  });

  it("replays both steps: the record is fetched once, then read from the carried cache", async () => {
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
    wrong.steps[0]!.expect.channel = "latest";
    await expect(replay(wrong)).rejects.toThrow(/channel/);
  });
});
