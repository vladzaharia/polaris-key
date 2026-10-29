// @vitest-environment node
//
// @pkey-feature core.discover config.schema release.changelog release.download update.feed release.record update.decide
// @pkey-feature packs.apply.chunk identity.choice
// @pkey-feature core.sync core.cache core.store license.activate license.enroll license.deactivate
// @pkey-feature license.reregister devices.register devices.report identity.devicecode config.mint
// @pkey-feature commerce.receipt license.refusals telemetry.updates
// @pkey-feature ui.boot release.fetch release.distribution
// @pkey-feature core.presentation identity.keyentry identity.account identity.attach
// @pkey-feature identity.toggle identity.redirect.web identity.signin.hints
// @pkey-feature sync.keyring identity.exchange identity.link
//
// `cloudSyncPull` / `cloudSyncPush` (U-20.4, sync.settings, WIRE-CONTRACT-V4 section 13.3, 13.4, V5 13.10):
// the request goes through the browser host's own transport (`sendSync`, over `session.ringRequest`:
// the bearer and the X-PKey headers). The end-to-end transcript is sealed by `sealPush` and opened by
// `openPull` over a fixture root, so every recorded `ct` reads `invalid`. The `cloudsync-cors`
// exchanges are the browser's own `browser` steps, played as recorded with the SDK's headers.
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
// `boot` (SP-12, ui.boot) is `runBoot` over the bearer engine's driver (`bearerBootDriver`, the one
// the adapter's `boot()` builds), with discovery through `discoverProduct`. `releaseFetch`
// (release.fetch) is `fetchReleaseBuild` over a record built from the step's args, the
// session's headers and bearer, and the last discovery; `args.partial` seeds the held bytes
// with the payload's first bytes from the transcript's own 200, as the Node replayer seeds its
// `.part` file. `downloadModel` (release.distribution) is `fetchDownloadModel`, with `current`
// the platform group of `initial.platform`.
//
// `commerceBinding` / `commerceClaim` (commerce.receipt, SP-16) are the bearer engine's
// `commerceBinding()` and `commerceClaim(store, payload)` — the calls `browserAdapter({ auth:
// "bearer" })` makes, cross-origin under the product's `web.origins` since the Worker's CORS list
// covers both routes. The DESKTOP runtime replays the same transcript through the bridge (the
// describe block "commerce through the desktop bridge" at the end of this file): `DesktopAdapter`
// over a v4 `PolarisBridge` whose host answers `invoke("commerce", …)` by driving an engine
// against the recording, so the renderer's verbs, their argument shape and the post-claim state
// refresh are checked against the same exchanges.
//
// `keyring*` (sync.keyring, U-38.2) are the browser key ring engine's (`RingEngine`, the code
// `browserAdapter({ auth: "bearer" }).keyring` runs) over the session's `ringRequest`. The
// recordings hold opaque fixture keys and the server never opens them, so the replay pins the
// routes, the request shapes and the refusals: the engine makes real keys, the step supplies the
// ring id the recording names (`newRingId`), and the observation is the ring and wrap the Worker
// reports (`inspect()`), never a key. The device keys are already registered, so none is sent.
//
// `result` is `discoverProduct`'s outcome; React reports a 404 as `{kind:"error",status:404}`,
// which is the vocabulary's `not-found`. `services` is the map the browser adapter installs from
// it (BrowserAdapter.loadCapabilities): the document's map on success, otherwise the
// pre-discovery belief, which with no `expectedServices` is `defaultServices()`.
//
// `initial.updateJournal` (telemetry.updates, SP-14) is not written into the journal by hand: each
// entry is RECORDED through `session.recordUpdateEvent(event, input)` — the call the adapters'
// `recordUpdateEvent` and the update_offered path make — with the clock at the entry's `at`, the
// session's event-id source answering the entry's `eventId`, and the outlet the entry names, so
// the replay holds the recording path to the recorded bytes. `updatesPending` is the length of
// the session's journal.

import {
  linkContextOf,
  runAccept,
  runOffer,
} from "../src/browser/bearer/link.js";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
} from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  chunkRangeFetch,
  createWebDeviceKeyStore,
  memoryDeviceKeyStorage,
  recordHash,
  type DeviceKeyPort,
} from "@polaris-key/client-core";
import {
  blind,
  openPull,
  openValue,
  openValueAnyName,
  sealPush,
  sealValue,
  webCryptoSyncPort,
  type HostCodec,
} from "@polaris-key/client-core/sync";
import type {
  Json,
  SettingRoute,
  SyncResponse,
  WireMutation,
} from "@polaris-key/client-core/cloud-sync";
import { sendSync } from "../src/browser/cloudSync/transport.js";
import { RingEngine } from "../src/browser/ring/engine.js";
import { memoryRootVault } from "../src/browser/ring/rootVault.js";
import {
  type ConnectClient,
  RelayError,
} from "../src/browser/connect/index.js";
import { createConnect } from "../src/browser/connect/create.js";
import { memoryConnectState } from "../src/browser/connect/state.js";
import { browserObjectFetch } from "../src/packs/browserPacks.js";
import { newTestKey, signCompact } from "./fixtures.js";
import {
  discoverProduct,
  exchangeDiscoveryOf,
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
  BrowserPresentationSource,
  memoryPresentationCache,
} from "../src/core/presentation.js";
import {
  buildDownloadUrl,
  buildInstallUrl,
  fetchChangelog,
} from "../src/browser/release.js";
import { PolarisError } from "../src/core/types.js";
import { UnsupportedError } from "../src/core/caps.js";
import { runBoot } from "../src/core/boot.js";
import { bearerBootDriver } from "../src/browser/boot.js";
import { fetchReleaseBuild } from "../src/browser/releaseFetch.js";
import { fetchDownloadModel } from "../src/browser/distribution.js";
import { ErrorCode } from "../src/constants.generated.js";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import { projectState } from "../src/core/adapter.js";
import { accountEndpointsOf } from "../src/core/account.js";
import { choiceEndpointsOf, type LicenseChoice } from "../src/core/choice.js";
import {
  redirectEndpointsOf,
  type RedirectEndpoints,
} from "../src/core/signIn.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import type { CommerceClaimResult } from "../src/core/types.js";
import { makeFakeBridge, okBridgeState } from "./fixtures.js";
import {
  BearerSession,
  type SignInPrompt,
} from "../src/browser/bearer/session.js";
import type { UpdateEventEntry } from "../src/core/updateEvents.js";
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
  type Step,
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

/** The issuer the Worker's discovery names for a redirect transcript: the `iss` its recorded
 *  callbacks carry (the customer host's issuer differs from the API host's), else the product's. */
function redirectIssuer(t: Transcript): string {
  for (const step of t.steps) {
    const cb = step.args.callbackUrl;
    if (typeof cb === "string") {
      const iss = new URL(cb).searchParams.get("iss");
      if (iss) return iss;
    }
  }
  return `${t.baseUrl}/${t.product}/identity`;
}

/** Does this transcript replay a redirect sign-in? */
function usesRedirect(t: Transcript): boolean {
  return t.steps.some(
    (s) => s.action === "browser" || s.action === "redirectComplete",
  );
}

/** The endpoints the Worker's discovery names for a redirect transcript that loads none. */
function standardRedirect(t: Transcript): RedirectEndpoints {
  const base = `${t.baseUrl}/${t.product}`;
  return {
    authorizeEndpoint: `${base}/identity/authorize`,
    tokenEndpoint: `${base}/identity/token`,
    issuer: redirectIssuer(t),
    choiceAvailable: t.steps.some((s) =>
      s.exchanges.items.some((x) =>
        x.request.path.includes("/identity/choice/"),
      ),
    ),
  };
}

/** The `state`, verifier and redirect URI the Worker scenarios use (their `browser` and
 *  `redirectComplete` args name them when a step differs from these). */
const REDIRECT_DEFAULTS = {
  state: "tidewater-state-0123456789",
  codeVerifier: "transcript-verifier-0123456789-abcdefghijklmnopqrst",
  redirectUri: "https://app.example/auth/callback",
};

/** The `choice` a `choiceComplete` step sends: its own `choice` arg, else the one the recording's
 *  request carries (a key is not a transcript arg). A recording with none is the Worker's 409
 *  `license_choice_required` for a completion naming no choice: the typed call cannot omit it, so
 *  the replay sends the body as recorded. */
function recordedChoice(step: Step): LicenseChoice | undefined {
  const arg = step.args.choice;
  if (arg !== undefined) return arg as unknown as LicenseChoice;
  const body = step.exchanges.items[0]?.request.body?.json as
    | { choice?: unknown }
    | undefined;
  return body?.choice as LicenseChoice | undefined;
}

/** The fixture device keys of `keyLabel` (format.ts, "exchange"; the Node reference client's
 *  `deviceKeys`): an Ed25519 seed of SHA-256(label) imported as PKCS8, and an agreement key that
 *  is SHA-256(label + ":agree") with the top bit of the last byte cleared. The port is durable. */
async function fixtureKeyPort(keyLabel: string): Promise<DeviceKeyPort> {
  const sha = async (text: string): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
  const prefix = Uint8Array.from(
    "302e020100300506032b657004220420"
      .match(/../g)!
      .map((h) => parseInt(h, 16)),
  );
  const seed = await sha(keyLabel);
  const pkcs8 = new Uint8Array(prefix.length + seed.length);
  pkcs8.set(prefix);
  pkcs8.set(seed, prefix.length);
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const signKey = (
    (await crypto.subtle.exportKey("jwk", priv)) as { x: string }
  ).x;
  const agree = await sha(`${keyLabel}:agree`);
  agree[31]! &= 0x7f;
  let bin = "";
  for (const b of agree) bin += String.fromCharCode(b);
  const agreeKey = btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const keys = { signKey, agreeKey, generation: 1 };
  return {
    ensure: async () => keys,
    publicKeys: async () => keys,
    sign: async (m) =>
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", priv, m as BufferSource),
      ),
    // The agreement key is a fixture value with no private half: nothing here agrees on a secret.
    dh: async () => null,
    rotate: async () => keys,
    persistence: () => "durable",
    wipe: async () => undefined,
  };
}

/** What a `choiceComplete` step sends as consent: its own `consent` arg, else the claims the
 *  recording's request carries (a grant's consent is not a transcript arg). */
function recordedConsent(step: Step): { claims: string[] } | undefined {
  const arg = step.args.consent;
  if (arg !== undefined) return arg as unknown as { claims: string[] };
  const body = step.exchanges.items[0]?.request.body?.json as
    | { consent?: { claims: string[] } }
    | undefined;
  return body?.consent;
}

function stringArg(step: Step, name: string): string | undefined {
  const v = step.args[name];
  return typeof v === "string" ? v : undefined;
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

/** The payload's first `n` bytes, from the transcript's own whole-payload (200) answer on
 *  `path` (the Node replayer's `payloadPrefix`). */
function payloadPrefix(t: Transcript, path: string, n: number): Uint8Array {
  for (const step of t.steps)
    for (const x of step.exchanges.items)
      if (
        x.request.method === "GET" &&
        x.request.path === path &&
        x.response.status === 200
      )
        return new TextEncoder()
          .encode(ReplayServer.bodyText(x))
          .subarray(0, n);
  throw new Error(`${t.id}: no whole-payload answer for ${path} to seed from`);
}

/** A commerce claim's outcome in the transcript's vocabulary: `ok` with the granted flag, or
 *  the refusal's own wire code and reason. Shared by the bearer and the bridge replays. */
function claimObserved(r: CommerceClaimResult): Record<string, JsonValue> {
  if (r.kind === "ok")
    return { result: "ok", flag: r.flag, state: r.state, granted: r.granted };
  const o: Record<string, JsonValue> = { result: r.code };
  if ("reason" in r && r.reason) o.reason = r.reason;
  return o;
}

/**
 * One `browser` step: the page the person's browser would load. The authorize request is the
 * one the SDK built (`startRedirect`'s `authorizeUrl`), unless the step is a refusal
 * (`expect.error` on an authorize exchange: a wrong client, an unregistered redirect URI, plain
 * PKCE, `openid`): an SDK cannot be made to send those, so the browser plays the recorded
 * request. Every other request is the card's own and is played as recorded. The observation is
 * where the browser ended up.
 */
// ── Cloud Sync settings (U-20.4, `sync.settings`) ─────────────────────────────────────────────

const SYNC_DECLARED = ["ui.theme", "audio.volume"];
const SYNC_E2E_NAMES = ["ui.theme", "my.open.key", "game.best"];
const SYNC_E2E_ROUTES: SettingRoute[] = [
  { key: "ui.theme", route: "synced", scope: "user", policy: "lastWrite" },
  { key: "game.best", route: "synced", scope: "user", policy: "max" },
];
const SYNC_CLIENT_ID = "c_AAAAAAAAAAAAAAAAAAAAAA";
const SYNC_HLC = "018bcfe56418:0000";

/** A fixture root: the replay's ring is not a real one, so every recorded `ct` is `invalid`. */
const FIXTURE_ROOT = Uint8Array.from({ length: 32 }, (_, i) => 3 * i + 7);
const SYNC_PORT = webCryptoSyncPort;
const fixtureCodec: HostCodec = {
  locked: false,
  seal: (c, n, v) => sealValue(SYNC_PORT, FIXTURE_ROOT, c, n, v),
  open: (c, n, e, a) => openValue(SYNC_PORT, FIXTURE_ROOT, c, n, e, a),
  openAny: (c, e) => openValueAnyName(SYNC_PORT, FIXTURE_ROOT, c, e),
  blind: (k, ctx, n) => blind(SYNC_PORT, FIXTURE_ROOT, k, ctx, n),
};

/** The replay's memory between sync steps: the last ETag, Retry-After and next mutation id. */
interface SyncMemory {
  etag: string | null;
  retryAfter: string | null;
  nextId: number;
}

/** `count` generated set mutations, ids from `first`, cycling through `names`. */
function generatedMutations(
  count: number,
  first: number,
  names: readonly string[],
): WireMutation[] {
  return Array.from({ length: count }, (_, i) => ({
    mutationId: first + i,
    target: { setting: names[i % names.length]!, scope: "user" as const },
    op: "set" as const,
    value: `generated-${first + i}`,
    editedHlc: SYNC_HLC,
  }));
}

const isRec = (v: unknown): v is Record<string, Json> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** One label per mutation result, in the transcript format's words. */
function resultLabel(r: Record<string, Json>): string {
  switch (r.status) {
    case "ok":
      if (typeof r.renamedTo === "string") return `ok:renamedTo:${r.renamedTo}`;
      return r.dropped === true ? "ok:dropped" : "ok";
    case "rejected":
      return typeof r.scope === "string"
        ? `rejected:${String(r.code)}:${r.scope}`
        : `rejected:${String(r.code)}`;
    default:
      return String(r.status);
  }
}

async function cloudSyncStep(
  session: BearerSession,
  step: Step,
  t: Transcript,
  mem: SyncMemory,
  out: Record<string, JsonValue>,
): Promise<void> {
  const e2e = t.id === "cloudsync-e2e-settings";
  const cursor = Number(step.args.cursor);
  mem.retryAfter = null;
  let mutations: WireMutation[] = [];
  let req: Parameters<typeof sendSync>[2];
  if (step.action === "cloudSyncPull") {
    req = { method: "GET", path: `/${t.product}/sync?cursor=${cursor}` };
  } else {
    mutations = generatedMutations(
      Number(step.args.mutations),
      mem.nextId,
      e2e ? SYNC_E2E_NAMES : SYNC_DECLARED,
    );
    const body: Json = {
      clientId: SYNC_CLIENT_ID,
      cursor,
      ...(step.args.atomic === true ? { atomic: true } : {}),
      mutations: mutations as unknown as Json,
    };
    req = {
      method: "POST",
      path: `/${t.product}/sync/ops`,
      body: e2e ? await sealPush(body, fixtureCodec, SYNC_E2E_ROUTES) : body,
    };
  }
  const res: SyncResponse = await sendSync(
    t.product,
    (path, init) => session.ringRequest(path, init),
    req,
  );
  if ("error" in res) {
    out.result = res.error;
    return;
  }
  if (res.status === 304) {
    out.result = "not-modified";
    return;
  }
  if (res.status < 200 || res.status >= 300) {
    out.result = "refused";
    out.status = res.status;
    const err = isRec(res.body) ? res.body.error : undefined;
    if (isRec(err) && typeof err.code === "string") out.code = err.code;
    if (mem.retryAfter !== null) out.retryAfter = Number(mem.retryAfter);
    return;
  }
  let body: Json | undefined = res.body;
  if (e2e && body !== undefined) {
    const opened = await openPull(body, fixtureCodec, { mutations });
    body = opened.body;
    for (const row of [
      ...(opened.opened.changes ?? []),
      ...Object.values(opened.opened.conflicts ?? {}),
    ])
      expect(row, `${t.id}: a fixture ct opens`).toEqual({ invalid: true });
  }
  out.result = "ok";
  if (!isRec(body)) return;
  if (typeof body.cursor === "number") out.cursor = body.cursor;
  if (typeof body.more === "boolean") out.more = body.more;
  out.empty = body.empty === true;
  out.settings = (Array.isArray(body.changes) ? body.changes : [])
    .map((c) => (isRec(c) ? c.setting : undefined))
    .filter((n): n is string => typeof n === "string")
    .sort();
  if (isRec(body.quota)) {
    if (typeof body.quota.bytes === "number") out.quotaBytes = body.quota.bytes;
    if (typeof body.quota.files === "boolean") out.files = body.quota.files;
  }
  if (typeof body.encryption === "string") out.encryption = body.encryption;
  if (typeof body.encryptionSince === "number")
    out.encryptionSince = body.encryptionSince;
  if (isRec(body.aliases)) out.aliases = body.aliases as JsonValue;
  if (step.action === "cloudSyncPush") {
    if (typeof body.lastMutationId === "number") {
      out.lastMutationId = body.lastMutationId;
      mem.nextId = body.lastMutationId + 1;
    }
    out.results = (Array.isArray(body.results) ? body.results : []).map((r) =>
      isRec(r) ? resultLabel(r) : "?",
    );
  }
}

async function browserStep(
  session: BearerSession,
  server: ReplayServer,
  step: Step,
  t: Transcript,
  setEntropy: (e: { state: string; codeVerifier: string }) => void,
): Promise<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = {};
  const authorizePath = `/${t.product}/identity/authorize`;
  const redirectUri =
    stringArg(step, "redirectUri") ?? REDIRECT_DEFAULTS.redirectUri;
  let last: { status: number; headers: Headers; text: string } | null = null;
  for (const item of step.exchanges.items) {
    const req = item.request;
    let path = req.path;
    if (
      req.method === "GET" &&
      path.startsWith(authorizePath) &&
      step.expect.error === undefined
    ) {
      setEntropy({
        state: stringArg(step, "state") ?? REDIRECT_DEFAULTS.state,
        codeVerifier:
          stringArg(step, "codeVerifier") ?? REDIRECT_DEFAULTS.codeVerifier,
      });
      const recorded = new URL(path, t.baseUrl);
      const loginHint = stringArg(step, "loginHint");
      const nameHint = stringArg(step, "nameHint");
      const purpose = stringArg(step, "purpose");
      const pending = await session.startRedirect({
        redirectUri,
        ...(loginHint !== undefined ? { loginHint } : {}),
        ...(nameHint !== undefined ? { nameHint } : {}),
        ...(purpose !== undefined
          ? { purpose: purpose as "signin" | "attach" }
          : {}),
        ...(recorded.searchParams.get("license_choice") === "app"
          ? { licenseChoice: "app" as const }
          : {}),
      });
      const built = new URL(pending.authorizeUrl);
      path = built.pathname + built.search;
    }
    const init: RequestInit = { method: req.method, redirect: "manual" };
    if (req.body !== null) {
      init.body = JSON.stringify(req.body.json);
      init.headers = { "content-type": "application/json" };
    }
    // A CORS exchange (`cloudsync-cors`) is the browser's own: the preflight is played as
    // recorded, and the request carries the SDK's own headers and the device bearer under the
    // recorded origin. The SDK asserts nothing about the CORS headers (Chromium's job does).
    if (req.headers.origin !== undefined) {
      init.headers =
        req.method === "OPTIONS"
          ? { ...req.headers }
          : {
              ...session.headers({
                authorization: `Bearer ${String(t.initial.token)}`,
              }),
              "content-type": "application/json",
              origin: req.headers.origin,
            };
    }
    const res = await server.fetch(`${t.baseUrl}${path}`, init);
    last = {
      status: res.status,
      headers: res.headers,
      text: await res.text(),
    };
  }
  if (last === null) return out;
  const appUri = new URL(redirectUri);
  const location =
    last.headers.get("location") ??
    (() => {
      try {
        const j = JSON.parse(last.text) as { redirect?: unknown };
        return typeof j.redirect === "string" ? j.redirect : null;
      } catch {
        return null;
      }
    })();
  if (location !== null) {
    const to = new URL(location, t.baseUrl);
    if (to.origin === appUri.origin && to.pathname === appUri.pathname) {
      out.navigated = "app";
      const error = to.searchParams.get("error");
      if (error) out.error = error;
    } else if (to.searchParams.has("bind")) out.navigated = "bind";
    else out.navigated = "card";
    return out;
  }
  if (last.status === 404) {
    out.navigated = "refused";
    return out;
  }
  if ((last.headers.get("content-type") ?? "").startsWith("text/html")) {
    out.navigated = "page";
    // The refusal page names no code in its body; the Worker's mapping is by status.
    out.error =
      last.status === 401 ? "invalid_client" : "redirect_uri_mismatch";
    return out;
  }
  // The card reading its request (hints) or answering a refused Continue: still on the card.
  out.navigated = "card";
  try {
    const view = JSON.parse(last.text) as Record<string, unknown>;
    if ("request" in view) {
      out.loginHint = (view.loginHint ?? null) as JsonValue;
      out.nameHint = (view.nameHint ?? null) as JsonValue;
      out.purpose = (view.purpose ?? null) as JsonValue;
    }
  } catch {
    // not JSON: nothing more to read
  }
  return out;
}

async function replay(t: Transcript): Promise<void> {
  const server = new ReplayServer(t);
  let discovered: DiscoveryDocument | null = null;
  const initialUpdate = (t.initial as { update?: InitialUpdate }).update;
  let slices: UpdateSlices = structuredClone(initialUpdate?.cache ?? {});
  let belief: ServicesMap = t.initial.services
    ? servicesFromList(t.initial.services as never)
    : t.steps.some((s) => s.action === "attach") && usesRedirect(t)
      ? servicesFromList(["license", "config", "identity"] as never)
      : usesRedirect(t)
        ? servicesFromList(["identity"] as never)
        : defaultServices();
  // identity.redirect.web: the entropy of the recorded conversation, set by the step.
  let entropy: { state?: string; codeVerifier?: string } = {};
  // identity.exchange: a step that supplies a recorded `nonce` uses it (test-only: the nonce
  // request is answered here and never reaches the recording), and the token route's
  // `issued_token_type` is read off the Worker's answer, which the typed outcome does not carry.
  let suppliedNonce: string | null = null;
  const syncMem: SyncMemory = { etag: null, retryAfter: null, nextId: 1 };
  let issuedTokenType: string | undefined;
  const tapped = (async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (suppliedNonce !== null && url.endsWith("/identity/nonce"))
      return new Response(JSON.stringify({ nonce: suppliedNonce }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    // Cloud Sync: a pull sends back the last ETag it saw, as a cache would (the transport has none).
    const u = new URL(url);
    if (u.pathname === `/${t.product}/sync`) {
      const headers = { ...(init?.headers as Record<string, string>) };
      if (syncMem.etag !== null) headers["if-none-match"] = syncMem.etag;
      const r = await server.fetch(input, { ...init, headers });
      syncMem.etag = r.headers.get("etag") ?? syncMem.etag;
      syncMem.retryAfter = r.headers.get("retry-after");
      return r;
    }
    const res = await server.fetch(input, init);
    if (u.pathname === `/${t.product}/sync/ops`)
      syncMem.retryAfter = res.headers.get("retry-after");
    if (url.endsWith("/identity/token") && res.status === 200) {
      const body = (await res.clone().json()) as {
        issued_token_type?: string;
      };
      issuedTokenType = body.issued_token_type;
    }
    return res;
  }) as typeof fetch;
  const base = {
    baseUrl: t.baseUrl,
    product: t.product,
    fetchImpl: tapped,
  };
  let clock = t.now;
  const store = new TranscriptStore(t.initial.deviceId, t.initial.token);
  const journal =
    (t.initial as { updateJournal?: UpdateEventEntry[] }).updateJournal ?? [];
  let nextEventId: string | null = null;
  let outletId: string | null = null;
  const makeSession = () =>
    new BearerSession({
      baseUrl: t.baseUrl,
      product: t.product,
      version: t.initial.version,
      fetchImpl: base.fetchImpl,
      now: () => clock,
      pinned: t.trust,
      store,
      // identity.exchange, identity.link: these recordings end at the sign-in, so the sync a
      // sign-in starts (licence and config documents, the device report) has no recorded
      // exchange to meet.
      enabled: (slug) =>
        belief[slug].enabled &&
        !(
          (t.features.includes("identity.exchange") ||
            t.features.includes("identity.link")) &&
          (slug === "license" || slug === "config")
        ),
      fingerprint: () => FINGERPRINT,
      // PX-W13: `initial.deviceName` stands in for the label a host names; absent = none.
      deviceName: t.initial.deviceName ?? "",
      outlet: () => (outletId === null ? null : { id: outletId }),
      eventId: () => nextEventId ?? "unexpected-event-id",
      redirectEndpoints: () =>
        redirectEndpointsOf(discovered as Record<string, unknown> | null) ??
        standardRedirect(t),
      redirectEntropy: () => entropy,
      // identity.choice: the last discovery's `choice*` endpoints, else the Worker's standard ones.
      choiceEndpoints: () =>
        choiceEndpointsOf(discovered as Record<string, unknown> | null) ?? {
          choiceLicenses: `${t.baseUrl}/${t.product}/identity/choice/licenses`,
          choiceDevices: `${t.baseUrl}/${t.product}/identity/choice/devices`,
          choiceComplete: `${t.baseUrl}/${t.product}/identity/choice/complete`,
          choiceCancel: `${t.baseUrl}/${t.product}/identity/choice/cancel`,
        },
      // identity.exchange: the last discovery's nonce and token endpoints, else the Worker's
      // standard ones (no discovery was loaded). A discovery without the member offers none.
      exchangeEndpoints: () =>
        discovered === null
          ? {
              kinds: ["google", "apple"],
              nonceEndpoint: `${t.baseUrl}/${t.product}/identity/nonce`,
              tokenEndpoint: `${t.baseUrl}/${t.product}/identity/token`,
              linkEndpoint: `${t.baseUrl}/${t.product}/identity/link`,
            }
          : exchangeDiscoveryOf(discovered as Record<string, unknown>),
      // The account endpoints: the last discovery's, else the Worker's standard ones.
      identityEndpoints: () =>
        accountEndpointsOf(discovered as Record<string, unknown> | null) ?? {
          subject: `${t.baseUrl}/${t.product}/identity/subject`,
          signout: `${t.baseUrl}/${t.product}/identity/signout`,
          attach: `${t.baseUrl}/${t.product}/identity/attach`,
        },
    });
  // The sign-in's acquisition sync (trust, documents, report) is pinned by the sync transcripts,
  // so a transcript that signs in (redirect steps) over a product with License on skips it.
  const quiet = (s: BearerSession): BearerSession => {
    if (usesRedirect(t))
      (
        s as unknown as { syncAfterSignIn: () => Promise<void> }
      ).syncAfterSignIn = async () => undefined;
    return s;
  };
  let session = quiet(makeSession());
  await session.init();
  // sync.keyring: the engine over this session. The ring id of the next create or reset is the
  // one the step's expectation names, because the recording fixes the Worker's answer.
  let nextRingId = "";
  const ring = new RingEngine({
    product: t.product,
    deviceId: () => session.deviceId,
    transport: {
      request: (path, init) => session.ringRequest(path, init),
    },
    keys: createWebDeviceKeyStore({ storage: memoryDeviceKeyStorage() }),
    vault: memoryRootVault(),
    newRingId: () => nextRingId,
  });
  // connect.identity (CC-09.1): the engine over this session, with the fixture device keys the
  // step's `keyLabel` names (a different label is a key rotation: the next call registers them).
  const connectState = memoryConnectState();
  let connectKeys: DeviceKeyPort = connectKeyPort("unused");
  let connectLabel: string | null = null;
  const connect: ConnectClient = createConnect({
    product: t.product,
    baseUrl: t.baseUrl,
    device: async () => ({
      deviceId: session.deviceId,
      hasToken: session.hasToken,
    }),
    request: (path, init) => session.ringRequest(path, init),
    registerKeys: (port, opts) => session.registerKeys(port, opts),
    trust: () => session.effectiveTrust(),
    now: () => clock,
    discovery: async () => discovered,
    keys: () => connectKeys,
    allowEphemeralKeys: false,
    stores: { durable: () => connectState, memory: connectState },
  });
  for (const e of journal) {
    clock = e.at;
    nextEventId = e.eventId;
    outletId = e.outlet;
    const recorded = session.recordUpdateEvent(e.event, {
      release: e.release,
      fromRelease: e.fromRelease ?? null,
      deliverable: e.deliverable,
      channel: e.channel,
      packSetId: e.packSetId ?? null,
      code: e.code ?? null,
    });
    expect(recorded, `${t.id}: journal entry ${e.eventId}`).toEqual(e);
  }
  clock = t.now;
  /** The gate the adapter projects from the session's state (`projectState`). */
  const status = () => {
    const st = session.syncState();
    return projectState(
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
  };
  // core.presentation (HA-13): the browser adapter's source, fed each discovery as the adapter
  // feeds it (`loadCapabilities`), with a page-lived cache.
  const presentation = new BrowserPresentationSource({
    product: t.product,
    fetchImpl: () => fetch,
    cache: memoryPresentationCache(),
  });
  const discover = async () => {
    const r = await discoverProduct(base);
    if (r.kind === "ok") {
      belief = copyServices(r.services);
      discovered = r.document;
      await presentation.accept(r.document);
    }
    return r;
  };
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
        // identity.keyentry: `license_owned` is a `refused` in the shared vocabulary (its kind,
        // `licenseOwned`, carries the sign-in link); the entries are null with Identity off.
        observed.result =
          r.kind === "licenseOwned"
            ? "refused"
            : r.kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        observed.code = r.code;
        // PX-W8: the refusal link, validated, or null when the Worker sent none.
        if (r.kind === "deviceLimit" || r.kind === "keyEntryLimit")
          observed.manageUrl = r.manageUrl ?? null;
        if (r.kind === "ok" || r.kind === "keyEntryLimit")
          observed.keyEntries = r.keyEntries ? { ...r.keyEntries } : null;
        break;
      }
      case "choiceLicenses":
      case "choiceDevices":
      case "choiceComplete":
      case "choiceCancel": {
        // The grant routes (I-10a.11), a refusal being a result.
        const grant = String(step.args.grant);
        let refused: { code: string } | null = null;
        if (step.action === "choiceLicenses") {
          const r = await session.choiceLicenses(grant);
          if (r.kind === "ok") {
            observed.state = r.view.state;
            observed.licenses = r.view.choices.map((c) => c.id);
          } else refused = r;
        } else if (step.action === "choiceDevices") {
          const r = await session.choiceDevices(
            grant,
            String(step.args.licenseId),
          );
          if (r.kind === "ok")
            observed.devices = r.view.devices.map((d) => d.id);
          else refused = r;
        } else if (step.action === "choiceComplete") {
          const consent = recordedConsent(step);
          const r = await session.choiceComplete(
            grant,
            recordedChoice(step),
            consent ? { consent } : {},
          );
          if (r.kind === "ok") {
            observed.licenseId = r.licenseId;
            observed.subject = r.subject;
            observed.scope = r.scope;
            if (r.keyEntries) observed.keyEntries = r.keyEntries;
          } else refused = r;
        } else {
          const r = await session.choiceCancel(grant);
          if (r.kind !== "ok") refused = r;
        }
        observed.result = refused ? "refused" : "ok";
        if (refused) observed.code = refused.code;
        break;
      }
      case "subject":
        observed.subject = await session.subject();
        break;
      case "signOut":
        observed.released = (await session.signOut()).released;
        break;
      case "attach": {
        const r = await session.attach(step.args.confirm === true);
        observed.result = r.kind === "refused" ? "refused" : r.kind;
        if (r.kind === "confirm") observed.license = r.license;
        if (r.kind === "ok") {
          observed.attached = r.attached;
          observed.subject = r.subject;
        }
        if (r.kind === "refused") observed.code = r.code;
        break;
      }
      case "deactivate":
        await session.deactivate();
        break;
      case "report":
        observed.result = await session.report();
        observed.updatesPending = session.pendingUpdateEvents().length;
        break;
      case "beginSignIn": {
        const name = step.args.deviceName;
        try {
          prompt = await session.beginSignIn(
            typeof name === "string" ? { deviceName: name } : {},
          );
        } catch (e) {
          // identity.toggle: Identity off is the typed `service-unavailable`, before or after
          // the Worker's 404.
          if (!(e instanceof PolarisError)) throw e;
          observed.result = e.code;
          break;
        }
        observed.prompt = {
          userCode: prompt.userCode,
          verificationUri: prompt.verificationUri,
          verificationUriComplete: prompt.verificationUriComplete,
          expiresIn: prompt.expiresIn,
          interval: prompt.interval,
          deviceName: prompt.deviceName,
        };
        break;
      }
      case "browser":
        Object.assign(
          observed,
          await browserStep(session, server, step, t, (e) => (entropy = e)),
        );
        break;
      case "redirectComplete": {
        const callbackUrl = String(step.args.callbackUrl);
        const cb = new URL(callbackUrl);
        entropy = {
          state: stringArg(step, "state") ?? REDIRECT_DEFAULTS.state,
          codeVerifier:
            stringArg(step, "codeVerifier") ?? REDIRECT_DEFAULTS.codeVerifier,
        };
        const pending = await session.startRedirect({
          redirectUri: `${cb.origin}${cb.pathname}`,
        });
        try {
          const done = await session.redeemRedirect(pending, callbackUrl);
          observed.result = done.kind === "signedIn" ? "ok" : done.kind;
          if (done.kind === "signedIn") {
            observed.scope = done.scope ?? null;
            observed.licenseId = done.activation.licenseId;
            observed.subject = done.subject;
          }
        } catch (e) {
          if (!(e instanceof PolarisError)) throw e;
          observed.result = e.code.replace(/_/g, "-");
          observed.code = e.code;
        }
        break;
      }
      case "pollSignIn": {
        try {
          const poll = await session.pollSignIn(prompt!);
          observed.result = poll.status;
          if (poll.status === "slow-down") observed.interval = poll.interval;
          if (poll.status === "error" && poll.code) observed.code = poll.code;
        } catch (e) {
          // I-37d: no answer or a 5xx on the poll is transient; the wait loop keeps polling.
          if (
            !(e instanceof PolarisError) ||
            (e.code !== "server-error" && e.code !== "network-error")
          )
            throw e;
          observed.result = "transient";
          observed.code = e.code;
        }
        break;
      }
      case "waitForSignIn": {
        const done = await session.waitForSignIn(prompt!, {
          sleep: async () => undefined,
        });
        observed.result = done.status;
        if (done.status === "error" && done.code) observed.code = done.code;
        break;
      }
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
        Object.assign(observed, claimObserved(r as CommerceClaimResult));
        break;
      }
      case "keyringGet":
      case "keyringCreate":
      case "keyringReset":
      case "keyringAdopt":
      case "keyringWrap":
      case "keyringUnwrap":
      case "keyringRecoverySet":
      case "keyringRecoveryGet": {
        const want = step.expect.ringId;
        if (typeof want === "string") nextRingId = want;
        // keyring-wrap's `args.deviceId` names the TARGET device, but the replay server binds every
        // string arg as a placeholder, so it would also replace `{deviceId}` (this device's id in
        // the `x-pkey-device` header). The request is this device's: bind it back.
        server.bindings.deviceId = t.initial.deviceId;
        try {
          if (step.action === "keyringGet") {
            const d = await ring.inspect();
            observed.ring = d.ring as JsonValue;
            observed.wrap = d.wrap as JsonValue;
          } else if (
            step.action === "keyringCreate" ||
            step.action === "keyringReset"
          ) {
            const r =
              step.action === "keyringCreate"
                ? await ring.create()
                : await ring.reset();
            observed.ringId = r.ringId;
            observed.epoch = r.epoch;
          } else if (step.action === "keyringAdopt") {
            await ring.adoptPrevious();
          } else if (step.action === "keyringWrap") {
            // The other device's agreement key: a fresh X25519 public key, as a nearby exchange gives.
            const pub = await webCryptoSyncPort.x25519.publicKey(
              webCryptoSyncPort.random(32),
            );
            await ring.wrapTo(String(step.args.deviceId), pub);
          } else if (step.action === "keyringUnwrap") {
            await ring.removeWrap(String(step.args.deviceId));
          } else if (step.action === "keyringRecoverySet") {
            await ring.setRecoveryCode();
          } else {
            observed.ct = (await ring.getRecoveryBlob()).ct;
          }
          observed.result = "ok";
        } catch (e) {
          if (!(e instanceof PolarisError) || e.status === undefined) throw e;
          observed.result = "refused";
          observed.status = e.status;
          observed.code = e.wireCode ?? e.code;
        }
        break;
      }
      case "cloudSyncPull":
      case "cloudSyncPush":
        await cloudSyncStep(session, step, t, syncMem, observed);
        break;
      case "relayTicket": {
        // connect.relay (CC-09.2): the ticket route. A refusal reads as `result: "refused"` with
        // the status, the Worker's code and, where it answers them, `retryAfter` and `scope`.
        try {
          const g = await connect.relayTicket();
          observed.result = "ok";
          observed.protocol = g.protocol;
          observed.url = g.url;
          observed.expiresIn = g.expiresAt - clock;
        } catch (e) {
          if (e instanceof RelayError) {
            observed.result = "refused";
            observed.status = e.status ?? null;
            observed.code = e.code;
            if (e.retryAfterSeconds !== undefined)
              observed.retryAfter = e.retryAfterSeconds;
            if (e.scope !== undefined) observed.scope = e.scope;
          } else if (e instanceof PolarisError) {
            observed.result = "refused";
            observed.status = e.status ?? null;
            observed.code = e.wireCode ?? e.code;
          } else throw e;
        }
        break;
      }
      case "connectIdentity":
      case "connectDevices": {
        const label = String(step.args.keyLabel);
        if (connectLabel !== label) {
          connectKeys = connectKeyPort(label);
          connectLabel = label;
        }
        // The `keys` proof carries the clock at the step.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(clock * 1000);
        try {
          if (step.action === "connectIdentity") {
            const idn = await connect.identity({
              refresh: step.args.refresh === true,
            });
            const disc = await connect.discoveryKeys();
            observed.result = "ok";
            observed.epoch = idn.epoch;
            observed.devices = idn.devices.map((d) => d.deviceId);
            observed.deviceId = idn.deviceId;
            observed.discKeys = disc?.previous ? 2 : 1;
          } else {
            observed.result = "ok";
            observed.devices = (await connect.listDevices()) as never;
          }
        } catch (e) {
          if (e instanceof UnsupportedError) observed.result = "unavailable";
          else if (e instanceof PolarisError) {
            observed.result = "refused";
            observed.code = e.wireCode ?? e.code;
          } else throw e;
        } finally {
          vi.useRealTimers();
        }
        break;
      }
      case "boot": {
        const driver = bearerBootDriver({
          session,
          discover: async () => {
            if (!discovered) await discover();
          },
          registrationPolicy: () => {
            const core = discovered?.core as
              | { registration?: unknown }
              | undefined;
            return typeof core?.registration === "string"
              ? core.registration
              : null;
          },
          licenseEnabled: () => belief.license.enabled,
          status,
        });
        observed.bootOutcome = (await runBoot(driver)).outcome;
        break;
      }
      case "releaseFetch": {
        const a = step.args;
        const build = String(a.build);
        const sha256 = String(a.sha256);
        const record = {
          version: String(a.version),
          builds: [
            {
              id: build,
              platform: String(a.platform),
              arch: String(a.arch),
              artifacts: [{ role: "payload", sha256, size: Number(a.size) }],
            },
          ],
        } as unknown as ReleaseRecordDoc;
        const parts = new Map<string, Uint8Array>();
        if (typeof a.partial === "number")
          parts.set(
            sha256,
            payloadPrefix(t, step.exchanges.items[0]!.request.path, a.partial),
          );
        try {
          const r = await fetchReleaseBuild({
            baseUrl: t.baseUrl,
            product: t.product,
            fetchImpl: base.fetchImpl,
            discovery: discovered,
            headers: session.headers(),
            bearer: session.bearer,
            record,
            buildId: build,
            parts,
          });
          observed.result = "ok";
          observed.size = r.size;
          observed.sha256 = r.sha256;
          expect(r.blob.size, "the verified payload").toBe(r.size);
        } catch (e) {
          if (!(e instanceof PolarisError)) throw e;
          // The client's own failures; `release-refused` is the server's refusal, its code the
          // body's (`wireCode`), the code the other SDKs report.
          observed.result =
            e.code === ErrorCode.releaseRefused ? "refused" : "error";
          observed.code = e.wireCode ?? e.code;
        }
        break;
      }
      case "downloadModel": {
        const model = await fetchDownloadModel(base);
        observed.result = "ok";
        observed.platforms = model.platforms.map((p) => p.platform);
        const platform = (t.initial as { platform?: unknown }).platform;
        observed.current = (model.platforms.find(
          (p) => p.platform === platform,
        ) ?? null) as unknown as JsonValue;
        break;
      }
      case "discover": {
        const r = await discover();
        observed.result =
          r.kind === "error" && r.status === 404 ? "not-found" : r.kind;
        observed.presentation = presentation.current() as JsonValue;
        // identity.exchange: what the identity fragment offers (V5 §12.11.6).
        {
          const ex = exchangeDiscoveryOf(
            discovered as Record<string, unknown> | null,
          );
          observed.exchange = ex
            ? ({
                kinds: [...ex.kinds],
                ...(ex.google ? { google: { ...ex.google } } : {}),
              } as JsonValue)
            : null;
          observed.nonceEndpoint = ex !== null;
        }
        break;
      }
      case "exchange": {
        // identity.exchange: a fixture key port, and a provider that returns the recorded
        // `subjectToken` (the Worker's nonce is not signed into it; the recording fixes both).
        const port = await fixtureKeyPort(String(step.args.keyLabel));
        // Each recorded attempt is its own client: one that signed in earlier holds no token now.
        if (session.hasToken) {
          store.token = null;
          session = quiet(makeSession());
          await session.init();
        }
        suppliedNonce = stringArg(step, "nonce") ?? null;
        issuedTokenType = undefined;
        try {
          const r = await session.exchange(port, {
            kind: step.args.kind as "google" | "apple",
            subjectToken: async () => String(step.args.subjectToken),
          });
          switch (r.kind) {
            case "signedIn":
              observed.result = "ok";
              observed.scope = r.scope;
              observed.licenseId = r.activation.licenseId;
              if (issuedTokenType !== undefined)
                observed.issuedTokenType = issuedTokenType;
              break;
            case "pendingConsent":
              observed.result = "confirm";
              observed.firstTime = r.consent.firstTime;
              observed.changed = r.consent.changed;
              observed.as = r.consent.as as unknown as JsonValue;
              break;
            case "pendingSignIn":
              observed.result = "choose";
              break;
            case "needsSignIn":
              observed.result = "interstitial-required";
              observed.reason = r.reason;
              observed.url = r.url;
              if (r.linkHandle !== undefined)
                observed.linkHandle = r.linkHandle;
              if (r.expiresIn !== undefined) observed.expiresIn = r.expiresIn;
              break;
            case "unavailable":
              observed.result = "unavailable";
              break;
          }
        } catch (e) {
          // A refusal is a typed error: the wire code is what the other SDKs report.
          if (!(e instanceof PolarisError)) throw e;
          observed.result = "refused";
          observed.code = e.wireCode ?? e.code;
        } finally {
          suppliedNonce = null;
        }
        break;
      }
      case "linkOffer": {
        // identity.link: GET link with the device token the redirect sign-in stored.
        const r = await runOffer(await linkContextOf(session));
        observed.result = r.kind === "ok" ? "ok" : "unavailable";
        if (r.kind === "ok") observed.offer = r.offer as unknown as JsonValue;
        break;
      }
      case "link": {
        // identity.link: POST link by the handle, proof signed by the fixture device key.
        const port = await fixtureKeyPort(String(step.args.keyLabel));
        const proofValue = stringArg(step, "proofValue");
        const r = await runAccept(await linkContextOf(session), port, {
          linkHandle: String(step.args.linkHandle),
          ...(proofValue !== null && proofValue !== undefined
            ? { proofValue }
            : {}),
        });
        if (r.kind === "linked") {
          observed.result = "ok";
          observed.linked = r.linked as unknown as JsonValue;
        } else if (r.kind === "refused") {
          observed.result = "refused";
          observed.status = r.status;
          observed.code = r.code;
        } else observed.result = "unavailable";
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
    observed.licenseStatus = status();
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
    // Planned here, so its transcript does not apply: commerce.receipt is SP-16's,
    // telemetry.updates SP-14's. identity.keyentry, identity.account and identity.attach run here
    // (I-10a.9: the keyentry-* and identity-* transcripts, over the bearer engine), and so do
    // identity.toggle (PX-W17's identity-disabled), identity.redirect.web and
    // identity.signin.hints (I-08's redirect-web-* and identity-request-hints transcripts; the
    // browser's `authorize` and Continue are `browser` steps the replayer plays as recorded,
    // I-10a.10). identity.choice (I-10a.11) is I-08b's redirect-web-choose*, choice-* transcripts (the
    // choice.* primitives). sync.settings is U-05's cloudsync-*
    // transcripts (the cloudSyncPull and cloudSyncPush steps), replayed here (U-20.4).
    // identity.exchange (I-46.5) is I-13.7's exchange-* transcripts, replayed through
    // `session.exchange` over a fixture key port. sync.keyring is
    // U-36.4's keyring-* transcripts are replayed here through the ring engine (U-38.2).
    // connect.relay is CC-07.3's connect-relay-* transcripts, replayed here (CC-09.2).
    // identity.link is I-43.3's link-* transcripts (I-46.13), replayed through `session.linkOffer`
    // and `session.linkAccept`; the Node runner also replays them with a reference client.
    // connect.identity is CC-06.4's connect-identity* transcripts, replayed here (CC-09.1).
    const plannedHere: string[] = [];
    // Not applicable here: ui.cli.portal is the terminal kits' product page link (LK-18's
    // discovery-portal transcript); React's widget kit shows only server or integrator links.
    const naHere = ["ui.cli.portal"];
    const expected = TRANSCRIPTS.filter(
      (t) =>
        !t.features.some((f) => plannedHere.includes(f) || naHere.includes(f)),
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

// @pkey-feature release.fetch
describe("the React replayer's releaseFetch mapping fails on a doctored transcript", () => {
  const base = TRANSCRIPTS.find((t) => t.id === "release-fetch-gated")!;

  it("a resumed body that is not the payload's tail is a mismatch, not ok", async () => {
    const t = doctor(base, 2, (items) =>
      items.map((x) => ({
        ...x,
        response: {
          ...x.response,
          body: "X".repeat(String(x.response.body).length),
        },
      })),
    );
    await expect(replay(t)).rejects.toThrow(/step 2: result/);
  });

  it("a whole payload sent without the device bearer is refused by the recording", async () => {
    const t = doctor(base, 1, (items) =>
      items.map((x) => ({
        ...x,
        request: {
          ...x.request,
          requiredHeaders: [...x.request.requiredHeaders, "x-pkey-doctored"],
        },
      })),
    );
    await expect(replay(t)).rejects.toThrow(/required header x-pkey-doctored/);
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

// ── commerce.receipt through the desktop bridge (SP-16) ───────────────────────────────────

/** The transcripts the bridge replay runs: every applicable one made only of commerce steps. */
const COMMERCE_ACTIONS = new Set(["commerceBinding", "commerceClaim"]);
const BRIDGE_TRANSCRIPTS = TRANSCRIPTS.filter(
  (t) =>
    t.features.includes("commerce.receipt") &&
    t.steps.every((s) => COMMERCE_ACTIONS.has(s.action)),
);

/**
 * Replay a commerce transcript through `DesktopAdapter`. The bridge is a v4 host: its
 * `invoke("commerce", "binding" | "claim")` is the host SDK's `client.commerce` over the
 * recording — here the bearer engine against the `ReplayServer`, holding the transcript's device
 * token as a host's store would (the Node host's own `client.commerce` replays this transcript in
 * the Node runner). What is under test is the renderer half: the verbs it sends, the argument
 * shape the host receives, the result it hands back, and the fresh host state it reads after an
 * `ok` claim.
 */
async function replayThroughBridge(t: Transcript): Promise<void> {
  const server = new ReplayServer(t);
  const belief = t.initial.services
    ? servicesFromList(t.initial.services as never)
    : defaultServices();
  const host = new BearerSession({
    baseUrl: t.baseUrl,
    product: t.product,
    version: t.initial.version,
    fetchImpl: server.fetch as typeof fetch,
    now: () => t.now,
    pinned: t.trust,
    store: new TranscriptStore(t.initial.deviceId, t.initial.token),
    enabled: (slug) => belief[slug].enabled,
    fingerprint: () => FINGERPRINT,
  });
  const invoked: string[] = [];
  let stateReads = 0;
  const base = makeFakeBridge(
    okBridgeState({
      capabilities: servicesFromList([...(t.initial.services ?? [])] as never),
    }),
  );
  const bridge: PolarisBridge = {
    ...base,
    version: 4,
    async getSyncState() {
      stateReads += 1;
      return base.getSyncState();
    },
    async invoke(service: string, method: string, args?: unknown) {
      invoked.push(`${service}.${method}`);
      if (service === "commerce" && method === "binding")
        return host.commerceBinding();
      if (service === "commerce" && method === "claim") {
        const a = args as { store: "steam"; payload: never };
        return host.commerceClaim(a.store, a.payload);
      }
      throw new Error(`the test host does not answer ${service}.${method}`);
    },
  };
  const adapter = new DesktopAdapter({ bridge, now: () => t.now });
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
  expect(adapter.supports("commerce.receipt")).toMatchObject({
    supported: true,
  });
  for (let i = 0; i < t.steps.length; i += 1) {
    const step = server.beginStep(i);
    const observed: Record<string, JsonValue> = {};
    const readsBefore = stateReads;
    if (step.action === "commerceBinding") {
      const b = await adapter.commerceBinding();
      observed.result = "ok";
      observed.bindingId = b.bindingId;
      observed.products = b.products as unknown as JsonValue;
    } else {
      const r = await adapter.commerceClaim(
        String(step.args.store) as "steam",
        step.args.payload as never,
      );
      Object.assign(observed, claimObserved(r));
      // On `ok` the renderer re-reads the host's state (the flag arrives with it); a refusal
      // changes nothing, so nothing is re-read.
      expect(stateReads - readsBefore, `${t.id} step ${i}: state reads`).toBe(
        r.kind === "ok" ? 1 : 0,
      );
    }
    server.endStep();
    for (const [key, want] of Object.entries(step.expect))
      if (key in observed)
        expect(observed[key], `${t.id} step ${i}: ${key}`).toEqual(want);
      else
        throw new Error(
          `${t.id} step ${i}: the bridge replay does not observe ${key}`,
        );
  }
  expect(invoked).toEqual(
    t.steps.map((s) =>
      s.action === "commerceBinding" ? "commerce.binding" : "commerce.claim",
    ),
  );
  adapter.dispose();
}

// @pkey-feature commerce.receipt
describe("commerce through the desktop bridge (React desktop-bridge runtime)", () => {
  it("covers the commerce transcript", () => {
    expect(BRIDGE_TRANSCRIPTS.map((t) => t.id)).toContain("commerce-claim");
  });

  for (const t of BRIDGE_TRANSCRIPTS) {
    const run = applies(t, MANIFEST) ? it : it.skip;
    run(`${t.id} through a v4 bridge`, async () => {
      await replayThroughBridge(t);
    });
  }

  it("fails when the claim the host forwards is not the recorded one", async () => {
    const base = TRANSCRIPTS.find((t) => t.id === "commerce-claim")!;
    const t = doctor(base, 1, (items) =>
      items.map((x) => ({
        ...x,
        request: {
          ...x.request,
          body: {
            json: { store: "steam", ticket: "00", dlcAppId: "1234560" },
            match: "exact",
          },
        },
      })),
    );
    await expect(replayThroughBridge(t)).rejects.toThrow(/step 1/);
  });
});

// @pkey-feature commerce.receipt
describe("the React replayer's commerce mapping fails on a doctored transcript", () => {
  const base = TRANSCRIPTS.find((t) => t.id === "commerce-claim")!;

  it("a refusal recorded where the transcript expects a grant", async () => {
    const refusal = base.steps[2]!.exchanges.items[0]!.response;
    const t = doctor(base, 1, (items) =>
      items.map((x) => ({ ...x, response: refusal })),
    );
    await expect(replay(t)).rejects.toThrow(/step 1: result/);
  });
});

/**
 * The fixture device keys of `label` as a key port (format.ts, connectIdentity): the Ed25519 key is
 * seeded by SHA-256(label), the agreement key's bytes are SHA-256(label + ":agree") with the top bit
 * clear, so the recorded `PUT /<p>/devices/keys` bytes are the ones this sends. The agreement key
 * has no private half here, so `dh` answers nothing; identity needs none.
 */
function connectKeyPort(label: string): DeviceKeyPort {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const signKey = (
    createPublicKey(priv).export({ format: "jwk" }) as { x: string }
  ).x;
  const agree = createHash("sha256").update(`${label}:agree`).digest();
  agree[31]! &= 0x7f;
  const keys = {
    signKey,
    agreeKey: agree.toString("base64url"),
    generation: 1,
  };
  return {
    ensure: async () => keys,
    publicKeys: async () => keys,
    sign: async (m) => new Uint8Array(edSign(null, Buffer.from(m), priv)),
    dh: async () => null,
    rotate: async () => keys,
    persistence: () => "durable",
    wipe: async () => undefined,
  };
}
