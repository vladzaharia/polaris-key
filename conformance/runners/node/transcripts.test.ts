// The Node transcript replayer (P1b-03, PARITY §4.2) for conformance/transcripts/: drive `@polaris-key/node`'s
// `PolarisKeyClient` through every recorded conversation its parity manifest says it can have,
// against a fake server that serves the Worker's recorded answers and asserts every request.
//
// @pkey-feature core.discover core.sync core.cache license.activate license.enroll
// @pkey-feature license.deactivate license.reregister devices.register devices.report
// @pkey-feature identity.keyentry
// @pkey-feature connect.identity
// @pkey-feature license.manage
// @pkey-feature config.schema release.changelog release.download
// @pkey-feature identity.devicecode identity.devicelabel config.mint
// @pkey-feature identity.toggle identity.redirect.web identity.signin.hints identity.account
// @pkey-feature identity.attach identity.choice identity.keyreturn identity.devicecode.choice
// @pkey-feature update.feed release.record update.decide
// @pkey-feature packs.apply.chunk commerce.receipt
// @pkey-feature license.refusals ui.boot release.fetch release.distribution telemetry.updates
// @pkey-feature core.presentation
// @pkey-feature ui.cli.portal
// @pkey-feature sync.keyring
// @pkey-feature connect.relay connect.links
// @pkey-feature sync.settings
// @pkey-feature sync.files sync.files.delta sync.saves sync.records
// @pkey-feature identity.nearby identity.redirect.native identity.accesstoken
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
//
// SP-00's verbs: `boot` is `client.boot()` (its `outcome` is `bootOutcome`); `releaseFetch` is
// `client.release.fetch({record, buildId}, {to})` over a record holding exactly the build entry
// the step's args name (the transcript pins the target, not the record exchange), into a fresh
// directory, with `partial` seeded as `<to>.part` from the transcript's own whole-payload answer;
// `downloadModel` is `client.distribution.downloadModel()`, `current` its group for
// `initial.platform`. `initial.updateJournal` is written as the update journal's file in the
// client's state directory (`<stateDir>/<product>`) before it starts; `updatesPending` reads
// `client.update.journal`.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ErrorCode,
  PolarisError,
  NativeRedirectSession,
  PolarisKeyClient,
  RedirectRefusedError,
  RelayError,
  createNodeDeviceKeyStore,
  type CacheRecordV3,
  type RedirectSession,
  type DeviceCodeSession,
  type LicenseChoice,
  type Store,
  UnsupportedError,
} from "@polaris-key/node";
import {
  chunkRangeFetch,
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
import { signJws } from "@polaris-key/jws";
import { classifyNativeRedirectUri } from "@polaris-key/client-core";
import type { FileReply } from "@polaris-key/client-core/sync";
import type { VouchRequest } from "@polaris-key/client-core/peer";
// The host's own transport (U-06.2). The package does not export it, so the runner reads the
// built file: the replay must go through the bearer, the `X-PKey-*` headers and the byte caps the
// host uses, not through a copy of them.
import { sendSync } from "../../../packages/sdk-node/dist/cloudSync/transport.js";
import { NodeFileTransport } from "../../../packages/sdk-node/dist/cloudSync/files.js";
// The permit of a matched nearby pick. Neither the package entry nor the routes offer it; the
// replay reads the built module the client under test was built from (one module instance, so its
// permits are the ones the routes check).
import { grantApproval } from "../../../packages/sdk-node/dist/identity/nearby.js";
import {
  fixtureKeys,
  nearbyAction,
  nearbyDiscovery,
  nearbyClientOptions,
  nearbyFacts,
  type NearbyReplayParty,
  type RoutesLike,
} from "./nearbyActions.js";
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

/** Does this transcript replay a redirect sign-in (so discovery must serve the Identity fragment)? */
function usesRedirect(t: Transcript): boolean {
  return t.steps.some(
    (s) => s.action === "browser" || s.action === "redirectComplete",
  );
}

/** Does this transcript push a native redirect request (I-15)? */
function usesNative(t: Transcript): boolean {
  return t.steps.some((s) =>
    s.exchanges.items.some(
      (x) =>
        x.request.method === "POST" &&
        x.request.path === `/${t.product}/identity/request`,
    ),
  );
}

/** The registered schemes the recorded pushes name (`<scheme>:/pkey/callback`). */
function nativeSchemes(t: Transcript): string[] {
  const out = new Set<string>();
  for (const s of t.steps)
    for (const x of s.exchanges.items) {
      const uri = (x.request.body?.json as { redirect_uri?: unknown } | null)
        ?.redirect_uri;
      if (
        typeof uri === "string" &&
        classifyNativeRedirectUri(uri) === "scheme"
      )
        out.add(uri);
    }
  return [...out];
}

/** Does this transcript call the account verbs (so discovery must name their endpoints)? */
function usesAccount(t: Transcript): boolean {
  return t.steps.some(
    (s) =>
      s.action === "subject" || s.action === "signOut" || s.action === "attach",
  );
}

/** Does this transcript start a device-code sign-in that asks `licenseChoice: "app"`? (UK-42.22:
 *  discovery must then carry `deviceChoice`, which is the SDK's gate for sending the member.) */
function asksDeviceChoice(t: Transcript): boolean {
  return t.steps.some(
    (s) => s.action === "beginSignIn" && s.args.licenseChoice === "app",
  );
}

/** The Worker's standard discovery document, for a transcript that loads none itself. */
function standardDiscovery(t: Transcript): string {
  const base = `${t.baseUrl}/${t.product}`;
  const choice = t.steps.some((s) =>
    s.exchanges.items.some(
      (x) =>
        x.request.path.includes("/identity/choice/") ||
        // A native push that asks the app to choose is only sent when the choice routes exist.
        (x.request.body?.json as { license_choice?: unknown } | null)
          ?.license_choice === "app",
    ),
  );
  return JSON.stringify({
    product: t.product,
    services: {
      // A slug discovery omits reads as off, so a transcript that syncs names its services.
      ...(usesAccount(t)
        ? { license: { enabled: true }, config: { enabled: true } }
        : {}),
      ...(usesRedirect(t) || usesAccount(t) || asksDeviceChoice(t)
        ? {
            identity: {
              enabled: true,
              configured: true,
              ...(asksDeviceChoice(t) ? { deviceChoice: true } : {}),
              issuer: redirectIssuer(t),
              account: true,
              ...(usesNative(t)
                ? {
                    nativeRedirect: {
                      loopback: true,
                      schemes: nativeSchemes(t),
                      claimedHttps: [],
                    },
                  }
                : {}),
              endpoints: {
                subject: `${base}/identity/subject`,
                signout: `${base}/identity/signout`,
                attach: `${base}/identity/attach`,
                accountPortal: `${t.baseUrl}/#/p/${t.product}`,
                authorize: `${base}/identity/authorize`,
                token: `${base}/identity/token`,
                ...(usesNative(t)
                  ? {
                      request: `${base}/identity/request`,
                      signinReturn: `${t.baseUrl}/signin/return`,
                    }
                  : {}),
                ...(choice
                  ? {
                      choiceLicenses: `${base}/identity/choice/licenses`,
                      choiceDevices: `${base}/identity/choice/devices`,
                      choiceComplete: `${base}/identity/choice/complete`,
                      choiceCancel: `${base}/identity/choice/cancel`,
                    }
                  : {}),
              },
            },
          }
        : {}),
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

/** Is `url` a Cloud Sync pull of `product`? */
const isSyncGet = (url: URL, product: string): boolean =>
  url.pathname === `/${product}/sync`;

/** The replay's memory between steps: the prompt the last `beginSignIn` returned. */
interface Session {
  prompt: DeviceCodeSession | null;
  transcript: Transcript;
  server: ReplayServer;
  /** The redirect session the last authorize step started (its URL is what the browser opens). */
  redirect: RedirectSession | null;
  /** The native redirect session the last push started, and the URLs its opener was given. */
  native: NativeRedirectSession | null;
  opened: string[];
  /** The label of the fixture keys the client holds (`connectIdentity`). */
  keyLabel?: string;
  /** Nearby approval (`identity.nearby`): D is this replay's client, M is built per approve. */
  nearbyM?: (step: Step) => Promise<NearbyReplayParty>;
  /** The first ring a `keyringCreate` made: the one a later `keyringAdopt` takes the root of. */
  firstRingId?: string;
  /** The next mutation id a `cloudSyncPush` generates (one past the last the Worker answered). */
  syncNextId?: number;
  /** What the replay's fetch saw on the last sync exchange (the transport does not expose it). */
  syncWire?: SyncWire;
}

/** The headers of the last Cloud Sync answer, and the ETag a later pull sends back. */
interface SyncWire {
  etag: string | null;
  retryAfter: string | null;
}

/** The `state`, verifier and redirect URI the Worker scenarios use (their `browser` and
 *  `redirectComplete` args name them when a step differs from these). */
const REDIRECT_DEFAULTS = {
  state: "tidewater-state-0123456789",
  codeVerifier: "transcript-verifier-0123456789-abcdefghijklmnopqrst",
  redirectUri: "https://app.example/auth/callback",
};

function stringArg(step: Step, name: string): string | undefined {
  const v = step.args[name];
  return typeof v === "string" ? v : undefined;
}

/** The `choice` a `choiceComplete` step sends: the step's own `choice` arg, else the one the
 *  recording's request carries (a key is not a transcript arg). A recording with none is the
 *  Worker's 409 `license_choice_required` for a completion that names no choice: an SDK's typed
 *  call cannot be made to omit it, so the replay sends the body as recorded (no `choice`). */
function recordedChoice(step: Step): LicenseChoice {
  const arg = step.args.choice;
  if (arg !== undefined) return arg as unknown as LicenseChoice;
  const body = step.exchanges.items[0]?.request.body?.json as
    | { choice?: unknown }
    | undefined;
  return body?.choice as LicenseChoice;
}

/** A fresh redirect sign-in with the recorded entropy, as the host would start it. */
async function startRedirectFor(
  client: PolarisKeyClient,
  step: Step,
  redirectUri: string,
  licenseChoice: "app" | undefined,
  keyReturn = false,
): Promise<RedirectSession> {
  (client.identity as unknown as { redirectEntropy: unknown }).redirectEntropy =
    {
      state: stringArg(step, "state") ?? REDIRECT_DEFAULTS.state,
      codeVerifier:
        stringArg(step, "codeVerifier") ?? REDIRECT_DEFAULTS.codeVerifier,
    };
  const loginHint = stringArg(step, "loginHint");
  const nameHint = stringArg(step, "nameHint");
  const purpose = stringArg(step, "purpose");
  return client.identity.signIn.start({
    channel: "redirect",
    redirectUri,
    ...(loginHint !== undefined ? { loginHint } : {}),
    ...(nameHint !== undefined ? { nameHint } : {}),
    ...(purpose !== undefined
      ? { purpose: purpose as "signin" | "attach" }
      : {}),
    ...(licenseChoice ? { licenseChoice } : {}),
    ...(keyReturn ? { keyReturn } : {}),
  });
}

/** A stand-in for the loopback listener: the recorded port, no socket (the listener itself is
 *  tested against a real socket in packages/sdk-node/test/identityNativeRedirect.test.ts). */
const fakeListener = (port: number) => async () => ({
  port,
  arm() {},
  close() {},
});

/** The recorded push that named `redirectUri`: the answer a replayed session starts from. */
function recordedPush(
  t: Transcript,
  redirectUri: string,
): { requestUri: string; expiresIn: number } | null {
  for (const step of t.steps)
    for (const x of step.exchanges.items) {
      const body = x.request.body?.json as { redirect_uri?: unknown } | null;
      const answer = x.response.body as {
        request_uri?: unknown;
        expires_in?: unknown;
      };
      if (
        x.request.path === `/${t.product}/identity/request` &&
        body?.redirect_uri === redirectUri &&
        x.response.status === 201 &&
        typeof answer.request_uri === "string" &&
        typeof answer.expires_in === "number"
      )
        return { requestUri: answer.request_uri, expiresIn: answer.expires_in };
    }
  return null;
}

/**
 * A native sign-in as the host would start it, from the push the Worker recorded: the SDK builds
 * and sends the request itself (so its body is checked against the recording) unless `pushed`
 * stands in for a push the replay already made.
 */
async function startNativeFor(
  client: PolarisKeyClient,
  step: Step,
  session: Session,
  rec: Record<string, string>,
  pushed?: { requestUri: string; expiresIn: number },
): Promise<NativeRedirectSession> {
  const redirectUri = rec.redirect_uri!;
  const cls = classifyNativeRedirectUri(redirectUri);
  const internals = client.identity as unknown as {
    redirectEntropy: unknown;
    nativeReplay: unknown;
  };
  internals.redirectEntropy = {
    state: rec.state ?? stringArg(step, "state") ?? REDIRECT_DEFAULTS.state,
    codeVerifier:
      stringArg(step, "codeVerifier") ?? REDIRECT_DEFAULTS.codeVerifier,
  };
  internals.nativeReplay = {
    ...(cls === "loopback"
      ? { listen: fakeListener(Number(new URL(redirectUri).port)) }
      : {}),
    ...(pushed ? { pushed: { kind: "pushed", ...pushed } } : {}),
  };
  const opts: Record<string, unknown> = {
    channel: "redirect",
    openUrl: async (url: string) => {
      session.opened.push(url);
      return true;
    },
    ...(cls === "scheme"
      ? { loopback: false, registeredSchemes: [redirectUri] }
      : {}),
    ...(rec.device_name ? { deviceName: rec.device_name } : {}),
    ...(rec.return_uri ? { returnUri: rec.return_uri } : {}),
    ...(rec.scope ? { scope: rec.scope } : {}),
    ...(rec.login_hint ? { loginHint: rec.login_hint } : {}),
    ...(rec.name_hint ? { nameHint: rec.name_hint } : {}),
    ...(rec.purpose ? { purpose: rec.purpose } : {}),
    ...(rec.license_choice === "app" ? { licenseChoice: "app" } : {}),
    ...(rec.key_return ? { keyReturn: true } : {}),
  };
  return (await client.identity.signIn.start(
    opts as never,
  )) as unknown as NativeRedirectSession;
}

/**
 * One `browser` step: the page the person's browser would load. The authorize request is the
 * one the SDK built (its `authorizeUrl`), unless the step is a refusal (`expect.error` on an
 * authorize exchange: a wrong client, an unregistered redirect URI, plain PKCE, `openid`): an SDK
 * cannot be made to send those, so the browser plays the recorded request. Every other request
 * is the card's own and is played as recorded. The observation is where the browser ended up.
 */
async function browserStep(
  client: PolarisKeyClient,
  step: Step,
  session: Session,
  t: Transcript,
): Promise<Observed> {
  const out: Observed = {};
  const authorizePath = `/${t.product}/identity/authorize`;
  const redirectUri =
    stringArg(step, "redirectUri") ?? REDIRECT_DEFAULTS.redirectUri;
  let last: { status: number; headers: Headers; text: string } | null = null;
  let lastPath = "";
  let lastWasPush = false;
  for (const item of step.exchanges.items) {
    const req = item.request;
    let path = req.path;
    // I-15b: the native push is the SDK's own request, checked against the recording.
    if (
      req.method === "POST" &&
      path === `/${t.product}/identity/request` &&
      step.expect.error === undefined
    ) {
      session.opened = [];
      session.native = await startNativeFor(
        client,
        step,
        session,
        (req.body?.json ?? {}) as Record<string, string>,
      );
      last = {
        status: item.response.status,
        headers: new Headers(item.response.headers),
        text: ReplayServer.bodyText(item),
      };
      lastPath = path;
      lastWasPush = true;
      continue;
    }
    if (req.method === "GET" && path.startsWith(authorizePath)) {
      if (req.path.includes("request_uri=")) {
        // A pushed request: the browser opens what the SDK opened, and a recording that was
        // not pushed in this step is played as recorded.
        if (session.opened.length > 0)
          expect(session.opened[0], "the URL the SDK opened").toBe(
            `${t.baseUrl}${req.path}`,
          );
      } else if (step.expect.error === undefined) {
        const recorded = new URL(path, t.baseUrl);
        const session1 = await startRedirectFor(
          client,
          step,
          redirectUri,
          recorded.searchParams.get("license_choice") === "app"
            ? "app"
            : undefined,
          recorded.searchParams.get("key_return") === "allow",
        );
        session.redirect = session1;
        const built = new URL(session1.authorizeUrl);
        path = built.pathname + built.search;
      }
    }
    const init: RequestInit = { method: req.method, redirect: "manual" };
    if (req.body !== null) {
      const recordedType = req.headers["content-type"] ?? "";
      if (/^application\/x-www-form-urlencoded\b/i.test(recordedType)) {
        // A form the browser or another device sent (a native token request played as recorded):
        // the SDK's headers, the recorded device when it names one.
        init.body = new URLSearchParams(
          req.body.json as Record<string, string>,
        ).toString();
        const device = req.headers["x-pkey-device"];
        const sent = client.core.headers({ "content-type": recordedType });
        if (device !== undefined && !device.startsWith("{")) {
          for (const k of Object.keys(sent))
            if (k.toLowerCase() === "x-pkey-device") delete sent[k];
          sent["x-pkey-device"] = device;
        }
        init.headers = sent;
      } else {
        init.body = JSON.stringify(req.body.json);
        init.headers = { "content-type": "application/json" };
      }
    }
    // A CORS exchange (`cloudsync-cors`) is the browser's own: the recorded headers are played
    // as recorded, and the SDK asserts nothing about them (React's Chromium job does).
    if (req.headers.origin !== undefined) {
      const token = (
        client as unknown as { tokens: { current: string | null } }
      ).tokens.current;
      init.headers =
        req.method === "OPTIONS" || token === null
          ? { ...req.headers }
          : {
              // The request itself carries the SDK's own headers and the device bearer.
              ...client.core.headers({ authorization: `Bearer ${token}` }),
              "content-type": "application/json",
              origin: req.headers.origin,
            };
    }
    const res = await session.server.fetch(`${t.baseUrl}${path}`, init);
    last = {
      status: res.status,
      headers: res.headers,
      text: await res.text(),
    };
    lastPath = path;
    lastWasPush =
      req.method === "POST" && path === `/${t.product}/identity/request`;
  }
  if (last === null) return out;
  // The native push answered on its own (nothing opened yet), or a native token request played
  // from another device: there is no page to land on, only the Worker's answer.
  if (
    lastWasPush ||
    (lastPath === `/${t.product}/identity/token` && last.status !== 200)
  ) {
    const answer = (() => {
      try {
        return JSON.parse(last.text) as { error?: unknown };
      } catch {
        return {};
      }
    })();
    if (lastWasPush) {
      out.navigated = "page";
      if (last.status !== 201 && typeof answer.error === "string")
        out.error = answer.error;
    } else if (typeof answer.error === "string") {
      out.result = answer.error.replace(/_/g, "-");
      out.code = answer.error;
    }
    return out;
  }
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
    const nativeBack = classifyNativeRedirectUri(location.split("?")[0]);
    if (
      (to.origin === appUri.origin && to.pathname === appUri.pathname) ||
      nativeBack === "loopback" ||
      nativeBack === "scheme"
    ) {
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
  void lastPath;
  return out;
}

/** `initial.platform` (downloadModel, releaseFetch): the device's canonical platform. */
function initialPlatform(t: Transcript): string | null {
  const p = (t.initial as { platform?: unknown }).platform;
  return typeof p === "string" ? p : null;
}

/** The payload's first `n` bytes, from the transcript's own whole-payload (200) answer on `path`. */
function payloadPrefix(t: Transcript, path: string, n: number): Buffer {
  for (const step of t.steps)
    for (const x of step.exchanges.items)
      if (
        x.request.method === "GET" &&
        x.request.path === path &&
        x.response.status === 200
      )
        return Buffer.from(ReplayServer.bodyText(x), "utf8").subarray(0, n);
  throw new Error(`${t.id}: no whole-payload answer for ${path} to seed from`);
}

/** Map an activation/enrolment result onto `result` and, for a refusal, `code`. */
function activation(
  out: Observed,
  r: {
    kind: string;
    code?: string;
    manageUrl?: string;
    signInUrl?: string;
    keyEntries?: { used: number; limit: number };
  },
): void {
  // The transcripts spell a `license_owned` refusal as `refused` (the registry code stays the
  // discriminator); the SDK's own kind is `license-owned`.
  out.result = r.kind === "license-owned" ? "refused" : r.kind;
  if (r.kind !== "ok" && typeof r.code === "string") out.code = r.code;
  // PX-W8: the refusal link, exactly as served; null when the result carries none.
  if (r.kind === "device-limit" || r.kind === "key-entry-limit")
    out.manageUrl = r.manageUrl ?? null;
  if (r.kind === "license-owned") out.signInUrl = r.signInUrl ?? null;
  // §12.2: the counts, `null` where the answer carries none (Identity off).
  if (r.kind === "ok" || r.kind === "key-entry-limit")
    out.keyEntries = r.keyEntries ?? null;
}

// ── Cloud Sync settings (U-06.4, `sync.settings`) ─────────────────────────────────────────────

/** The settings the generated mutations name: declared in the replay's catalog, or open. */
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

/**
 * `cloudSyncPull` / `cloudSyncPush` (U-06.4, WIRE-CONTRACT-V4 §13.3, §13.4, V5 §13.10): the request
 * goes out through the host's transport. A pull is `GET /<p>/sync?cursor=N` (the replay's fetch
 * adds `If-None-Match` with the last ETag); a push carries N generated mutations. In the
 * end-to-end transcript the push body is sealed by client-core's `sealPush` and the answer opened
 * by `openPull`, over a fixture root: the recorded `ct`s are fixture bytes, so every row must come
 * back `invalid`, and the settings read are the wire's own names. The labels are the format's.
 */
async function cloudSyncStep(
  client: PolarisKeyClient,
  step: Step,
  session: Session,
  out: Observed,
): Promise<void> {
  const t = session.transcript;
  const e2e = t.id === "cloudsync-e2e-settings";
  const tokens = (
    client as unknown as { tokens: Parameters<typeof sendSync>[1] }
  ).tokens;
  const cursor = Number(step.args.cursor);
  const wire = (session.syncWire ??= { etag: null, retryAfter: null });
  wire.retryAfter = null;
  let mutations: WireMutation[] = [];
  let req: Parameters<typeof sendSync>[2];
  if (step.action === "cloudSyncPull") {
    req = { method: "GET", path: `/${t.product}/sync?cursor=${cursor}` };
  } else {
    mutations = generatedMutations(
      Number(step.args.mutations),
      (session.syncNextId ??= 1),
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
  const res: SyncResponse = await sendSync(client.core, tokens, req);
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
    if (wire.retryAfter !== null) out.retryAfter = Number(wire.retryAfter);
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
  const recordNames = (rows: unknown): string[] =>
    (Array.isArray(rows) ? rows : [])
      .map((r) => (isRec(r) ? r.record : undefined))
      .filter((r): r is Json[] => Array.isArray(r) && r.length === 2)
      .map((r) => `${String(r[0])}/${String(r[1])}`)
      .sort();
  const changed = recordNames(body.changes);
  if (changed.length > 0) out.records = changed;
  const deleted = recordNames(body.tombstones);
  if (deleted.length > 0) out.deletedRecords = deleted;
  if (typeof body.encryption === "string") out.encryption = body.encryption;
  if (typeof body.encryptionSince === "number")
    out.encryptionSince = body.encryptionSince;
  if (isRec(body.aliases)) out.aliases = body.aliases;
  if (step.action === "cloudSyncPush") {
    if (typeof body.lastMutationId === "number") {
      out.lastMutationId = body.lastMutationId;
      session.syncNextId = body.lastMutationId + 1;
    }
    out.results = (Array.isArray(body.results) ? body.results : []).map((r) =>
      isRec(r) ? resultLabel(r) : "?",
    );
  }
}

const hexOf = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

/**
 * `cloudSyncFile` / `cloudSyncChunk` (U-10.12, U-37.6; WIRE-CONTRACT-V5 §13.2, §13.8): one file
 * route call through the host's `NodeFileTransport`, the engine's `FileTransport` port. The
 * transport builds the path from the target and the upload id the recording drew (read from the
 * recorded path), adds the headers and `Content-Digest`, and bounds what it reads; the call's
 * JSON body and PUT bytes are the recording's own, so a step pins what the transport does with
 * them, not how the engine plans them (client-core's unit tests pin that). A refusal is a value.
 */
async function cloudSyncFileStep(
  client: PolarisKeyClient,
  step: Step,
  out: Observed,
): Promise<void> {
  const tokens = (client as unknown as { tokens: { current: string | null } })
    .tokens;
  const transport = new NodeFileTransport({
    ctx: client.core,
    token: () => tokens.current,
  });
  const req = step.exchanges.items[0]!.request;
  const op = String(step.args.op);
  const collection = String(step.args.collection);
  const target = { collection, record: String(step.args.id) };
  const uploadId = /\/upload\/([^/?]+)/.exec(req.path)?.[1] ?? "";
  const json = req.body?.json as never;
  const bytes = req.bodyBase64
    ? new Uint8Array(Buffer.from(req.bodyBase64, "base64"))
    : new Uint8Array(0);
  const version =
    typeof step.args.version === "number" ? step.args.version : undefined;
  // A PUT carries the digest the recording sent. It is the body's own except where a step sends a
  // wrong one on purpose (`upload_mismatch`); the transport only encodes the hex it is given.
  const recorded = /^sha-256=:([A-Za-z0-9+/=]+):$/.exec(
    req.headers["content-digest"] ?? "",
  )?.[1];
  const digest = recorded
    ? Buffer.from(recorded, "base64").toString("hex")
    : hexOf(bytes);
  const opts = {};
  let reply: FileReply<unknown>;
  let ok = (v: unknown): void => {
    void v;
  };
  switch (op) {
    case "begin":
      reply = await transport.begin(target, json, opts);
      ok = (v) => {
        const b = v as { mode: string; partBytes?: number };
        out.mode = b.mode;
        if (b.partBytes !== undefined) out.partBytes = b.partBytes;
      };
      break;
    case "status":
      reply = await transport.status(target, uploadId, opts);
      ok = (v) => {
        const b = v as {
          mode: string;
          size: number;
          received: number[];
          missing?: string[];
        };
        out.mode = b.mode;
        out.size = b.size;
        out.received = b.received;
        if (b.missing !== undefined) out.missing = b.missing;
      };
      break;
    case "put":
    case "putManifest":
      reply = await transport.putSingle(target, uploadId, bytes, digest, opts);
      break;
    case "part":
      reply = await transport.putPart(
        target,
        uploadId,
        Number(step.args.part),
        bytes,
        digest,
        opts,
      );
      break;
    case "putChunk":
      reply = await transport.putChunk(
        target,
        uploadId,
        String(step.args.chunk),
        bytes,
        digest,
        opts,
      );
      break;
    case "abort":
      reply = await transport.abort(target, uploadId, opts);
      break;
    case "plan":
      reply = await transport.planChunks(target, uploadId, json, opts);
      ok = (v) => {
        const b = v as { missing: string[]; present: [string, number][] };
        out.missing = [...b.missing].sort();
        out.present = [...b.present].sort((x, y) => (x[0] < y[0] ? -1 : 1));
      };
      break;
    case "finalize":
      reply = await transport.finalize(target, json, opts);
      ok = (v) => {
        const b = v as {
          version: number;
          size: number;
          sha256: string;
          format: string;
        };
        out.version = b.version;
        out.size = b.size;
        out.sha256 = b.sha256;
        out.format = b.format;
      };
      break;
    case "download":
    case "downloadManifest":
      reply = await transport.getFile(
        target,
        version !== undefined ? { version } : {},
        opts,
      );
      ok = (v) => {
        const b = v as { bytes: Uint8Array };
        out.size = b.bytes.length;
        out.sha256 = hexOf(b.bytes);
      };
      break;
    case "getChunk":
      reply = await transport.getChunk(
        collection,
        String(step.args.chunk),
        opts,
      );
      ok = (v) => {
        const b = v as Uint8Array;
        out.size = b.length;
        out.sha256 = hexOf(b);
      };
      break;
    case "revisions":
      reply = await transport.revisions(target, opts);
      ok = (v) => {
        const r = (v as { revisions: { version: number; format: string }[] })
          .revisions;
        out.versions = r.map((x) => x.version);
        out.formats = r.map((x) => x.format);
      };
      break;
    default:
      throw new Error(`unknown ${step.action} op ${op}`);
  }
  if (reply.ok) {
    out.result = "ok";
    out.status = req.method === "PUT" || op === "abort" ? 204 : 200;
    ok(reply.value);
    return;
  }
  out.result = "refused";
  out.status = reply.status;
  out.code = reply.code;
  if (reply.retryAfterSeconds !== undefined)
    out.retryAfter = reply.retryAfterSeconds;
  const body = (reply.body ?? {}) as {
    missing?: unknown;
    server?: { version?: number };
  };
  if (body.missing !== undefined) out.missing = body.missing as never;
  if (body.server?.version !== undefined)
    out.serverVersion = body.server.version;
}

/**
 * The key ring verbs (U-38.1, `sync.keyring`) over `client.keyring`. The transcripts hold no key
 * material the client could use, so the client makes its own: `create` and `reset` draw a root,
 * `wrap` seals it to a fresh agreement key for the named device, and `adopt` takes the root of the
 * first ring this conversation created. A refusal reads as `result: "refused"` with the status
 * and the code.
 */
async function keyringStep(
  client: PolarisKeyClient,
  step: Step,
  session: Session,
  out: Observed,
): Promise<void> {
  const k = client.keyring;
  try {
    switch (step.action) {
      case "keyringGet": {
        const r = await k.read();
        out.ring = r.ring
          ? {
              ringId: r.ring.ringId,
              epoch: r.ring.epoch,
              rootKid: r.ring.rootKid,
              state: r.ring.state,
              recoverySet: r.ring.recovery.set,
              previous: r.ring.previous?.ringId ?? null,
              adopted: r.ring.adopted.map((a) => a.ringId),
            }
          : null;
        out.wrap = r.wrap
          ? { epoch: r.wrap.epoch, kid: r.wrap.kid, by: r.wrap.by ?? null }
          : null;
        break;
      }
      case "keyringCreate":
      case "keyringReset": {
        const made =
          step.action === "keyringCreate" ? await k.create() : await k.reset();
        if (step.action === "keyringCreate")
          session.firstRingId ??= made.ringId;
        // The ring id is the client's own draw and the recording's is a fixture: both must be a
        // well formed id, and the replay reports the recorded one when ours is.
        out.ringId = /^rg_[A-Za-z0-9_-]{22}$/.test(made.ringId)
          ? ((step.expect.ringId as string | undefined) ?? made.ringId)
          : made.ringId;
        out.epoch = made.epoch;
        break;
      }
      case "keyringWrap": {
        const pair = await globalThis.crypto.subtle.generateKey(
          "X25519",
          true,
          ["deriveBits"],
        );
        const pub = new Uint8Array(
          await globalThis.crypto.subtle.exportKey(
            "raw",
            (pair as CryptoKeyPair).publicKey,
          ),
        );
        await k.wrapTo(String(step.args.deviceId), pub);
        break;
      }
      case "keyringUnwrap":
        await k.removeWrap(String(step.args.deviceId));
        break;
      case "keyringAdopt":
        await k.adopt(session.firstRingId ?? "");
        break;
      case "keyringRecoverySet":
        await k.setRecoveryCode();
        break;
      case "keyringRecoveryGet":
        out.ct = (await k.recoveryBlob()).ct;
        break;
    }
    out.result = "ok";
  } catch (e) {
    if (!(e instanceof PolarisError)) throw e;
    out.result = "refused";
    if (e.status !== undefined) out.status = e.status;
    out.code = e.code;
  }
}

/**
 * The fixture device keys of `label` as a key port (format.ts, connectIdentity): the Ed25519 key is
 * seeded by SHA-256(label), the agreement key's bytes are SHA-256(label + ":agree") with the top bit
 * clear. The agreement key has no private half here, so `dh` answers nothing; identity needs none.
 */
function fixtureKeyPort(label: string): DeviceKeyPort {
  return fixtureKeys(label) as unknown as DeviceKeyPort;
}

/** `client.connect` (CC-06.4, `connect.identity`): the identity and the device list. */
async function connectStep(
  client: PolarisKeyClient,
  step: Step,
  session: Session,
  out: Observed,
): Promise<void> {
  const label = String(step.args.keyLabel);
  if (session.keyLabel !== label) {
    // A different label is a different key pair: the next call registers it.
    client.connect.useDeviceKeys(fixtureKeyPort(label));
    session.keyLabel = label;
  }
  try {
    if (step.action === "connectIdentity") {
      const id = await client.connect.identity({
        refresh: step.args.refresh === true,
      });
      const disc = await client.connect.discoveryKeys();
      out.result = "ok";
      out.epoch = id.epoch;
      out.devices = id.devices.map((d) => d.deviceId);
      out.deviceId = id.deviceId;
      out.discKeys = disc?.previous ? 2 : 1;
    } else {
      out.result = "ok";
      out.devices =
        (await client.connect.listDevices()) as unknown as JsonValue;
    }
  } catch (e) {
    if (e instanceof UnsupportedError) {
      out.result = "unavailable";
      return;
    }
    if (!(e instanceof PolarisError)) throw e;
    out.result = "refused";
    out.code = e.code;
  }
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
      // D-6: the recorded action names map onto the session (`signIn.start`, `wait`).
      const name = step.args.deviceName;
      const hint = (k: string) =>
        typeof step.args[k] === "string" ? { [k]: step.args[k] } : {};
      let p: DeviceCodeSession;
      try {
        p = await client.identity.signIn.start({
          channel: "device-code",
          ...(typeof name === "string" ? { deviceName: name } : {}),
          ...hint("loginHint"),
          ...hint("nameHint"),
          ...(step.args.purpose === "signin" || step.args.purpose === "attach"
            ? { purpose: step.args.purpose }
            : {}),
          ...(step.args.licenseChoice === "app"
            ? { licenseChoice: "app" as const }
            : {}),
        });
      } catch (e) {
        if (!(e instanceof PolarisError)) throw e;
        out.result = e.code;
        out.tokenHeld = store.token !== null;
        break;
      }
      session.prompt = p;
      out.prompt = {
        userCode: p.userCode,
        verificationUri: p.verificationUri,
        verificationUriComplete: p.verificationUriComplete,
        expiresIn: p.expiresIn,
        interval: p.interval,
        deviceName: p.deviceName,
      };
      break;
    }
    case "pollSignIn": {
      try {
        const o = await session.prompt!.wait({ once: true });
        if (o.kind === "pending") {
          out.result = o.slowDown ? "slow-down" : "pending";
          if (o.slowDown) out.interval = o.interval;
        } else out.result = o.kind === "signedIn" ? "ready" : o.kind;
      } catch (e) {
        if (!(e instanceof PolarisError)) throw e;
        if (e.code === "sign-in-denied" || e.code === "sign-in-failed") {
          out.result = "error";
          out.code = e.code;
        } else if (e.code === "server-error" || e.code === "network-error") {
          // I-37d: no answer or a 5xx on the poll is transient; a wait loop keeps polling.
          out.result = "transient";
          out.code = e.code;
        } else throw e;
      }
      break;
    }
    case "waitForSignIn": {
      const done = await session.prompt!.wait();
      out.result = done.kind === "signedIn" ? "ready" : done.kind;
      break;
    }
    case "browser":
      Object.assign(
        out,
        await browserStep(client, step, session, session.transcript),
      );
      break;
    case "redirectComplete": {
      const callbackUrl = String(step.args.callbackUrl);
      const cb = new URL(callbackUrl);
      const base = callbackUrl.split("?")[0]!;
      const nativeClass = classifyNativeRedirectUri(base);
      const recorded =
        nativeClass === "loopback" || nativeClass === "scheme"
          ? recordedPush(session.transcript, base)
          : null;
      // A native redirect back: the session starts from the push already recorded (no second
      // push), then takes the URL the listener or the OS delivered.
      const sess =
        recorded !== null
          ? await startNativeFor(
              client,
              step,
              session,
              { redirect_uri: base },
              recorded,
            )
          : await startRedirectFor(
              client,
              step,
              `${cb.origin}${cb.pathname}`,
              undefined,
              step.args.keyReturn === true,
            );
      try {
        const done =
          sess instanceof NativeRedirectSession
            ? await sess.handleRedirect(callbackUrl)
            : await sess.complete(callbackUrl);
        out.result = done.kind === "signedIn" ? "ok" : done.kind;
        if (done.kind === "signedIn") {
          out.scope = done.scope;
          out.licenseId = done.licenseId;
          out.subject = done.subject;
          out.tokenHeld = store.token !== null;
        }
        if (done.kind === "activated") {
          // A key return: the key's license, no account, no scope.
          out.scope = "";
          out.licenseId = done.licenseId;
          out.subject = done.subject;
          out.keyEntries = done.keyEntries;
          out.tokenHeld = store.token !== null;
        }
      } catch (e) {
        if (!(e instanceof PolarisError)) throw e;
        out.result = e.code.replace(/_/g, "-");
        out.code = e.code;
        if (e instanceof RedirectRefusedError) {
          // The refusal's details (device limit, key entries, owned): LK-SKIP's key return.
          Object.assign(out, e.details);
        }
      }
      break;
    }
    case "choiceLicenses":
    case "choiceDevices":
    case "choiceComplete":
    case "choiceCancel": {
      // The grant routes (I-10a.8): `client.identity.choice.*`, a refusal being a result.
      const grant = String(step.args.grant);
      const choice = client.identity.choice;
      let refused: { code: string } | null = null;
      if (step.action === "choiceLicenses") {
        const r = await choice.licenses(grant);
        if (r.kind === "ok") {
          out.state = r.view.state;
          out.licenses = r.view.choices.map((c) => c.id);
        } else refused = r;
      } else if (step.action === "choiceDevices") {
        const r = await choice.devices(grant, String(step.args.licenseId));
        if (r.kind === "ok") out.devices = r.view.devices.map((d) => d.id);
        else refused = r;
      } else if (step.action === "choiceComplete") {
        const r = await choice.complete(grant, recordedChoice(step));
        if (r.kind === "ok") {
          out.licenseId = r.licenseId;
          out.subject = r.subject;
          if (r.keyEntries) out.keyEntries = r.keyEntries;
        } else refused = r;
      } else {
        const r = await choice.cancel(grant);
        if (r.kind !== "ok") refused = r;
      }
      out.result = refused ? "refused" : "ok";
      if (refused) out.code = refused.code;
      break;
    }
    case "subject":
      out.subject = await client.identity.subject();
      break;
    case "attach": {
      const r = await client.identity.attach({
        confirm: step.args.confirm === true,
      });
      out.result = r.status;
      if (r.status === "confirm") out.license = { ...r.license };
      else if (r.status === "ok") {
        out.attached = r.attached ?? null;
        out.subject = r.subject;
      } else out.code = r.code;
      out.tokenHeld = store.token !== null;
      break;
    }
    case "signOut": {
      const r = await client.identity.signOut();
      out.released = r.released;
      break;
    }
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
      // identity.nearby: whether the discovery just loaded names nearby approval.
      if (session.transcript.features.includes("identity.nearby"))
        Object.assign(
          out,
          nearbyFacts(
            (client as unknown as { discoveryDoc: unknown }).discoveryDoc,
          ),
        );
      // identity.accesstoken (I-21b): whether the identity fragment names the device exchange.
      if (session.transcript.features.includes("identity.accesstoken"))
        out.accessToken =
          (
            client as unknown as {
              discoveryDoc: {
                services?: { identity?: { accessToken?: unknown } };
              } | null;
            }
          ).discoveryDoc?.services?.identity?.accessToken === true;
      // core.presentation (HA-13): the member the client exposes after this discovery.
      out.presentation = client.presentation() as JsonValue;
      // ui.cli.portal (DISC-01): the core.portal member the client holds after this discovery.
      out.portal = client.portal() as JsonValue;
      // connect.links (CC-19): the cached `services.connect.interAccount` the SDK gates links on.
      out.interAccount = client.cloudConnect.links.interAccount();
      // connect.local (CC-29): the cached `services.connect.localPairing` the SDK gates local pairing on.
      out.localPairing = client.cloudConnect.localLinks.localPairing();
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
      activation(
        out,
        await client.license.activateWithKey(String(step.args.key)),
      );
      break;
    case "enroll":
      activation(out, await client.license.enroll());
      break;
    case "register":
      out.result = (await client.devices.register()).kind;
      break;
    case "deactivate":
      await client.license.deactivate();
      break;
    case "relayTicket": {
      // CC-08.3: `client.connect.relayTicket()`. A refusal reads as `result: "refused"` with the
      // status, the Worker's code and, where it answers them, `retryAfter` and `scope`.
      try {
        const g = await client.connect.relayTicket();
        out.result = "ok";
        out.protocol = g.protocol;
        out.url = g.url;
        out.expiresIn = g.expiresAt - Math.floor(Date.now() / 1000);
      } catch (e) {
        out.result = "refused";
        if (e instanceof RelayError) {
          out.status = e.status ?? null;
          out.code = e.code;
          if (e.retryAfterSeconds !== undefined)
            out.retryAfter = e.retryAfterSeconds;
          if (e.scope !== undefined) out.scope = e.scope;
        } else if (e instanceof PolarisError) {
          out.status = e.status ?? null;
          out.code = e.code;
        } else throw e;
      }
      break;
    }
    case "relayTicketContact": {
      // CC-19: `client.connect.relayTicket({room, rid})`, the body sent as given. A refusal reads
      // as `result: "refused"` like `relayTicket`; an answer without the `room` echo is the typed
      // `contact_unsupported`.
      try {
        const g = await client.connect.relayTicket({
          room: String(step.args.room),
          rid: String(step.args.rid),
        });
        out.result = "ok";
        out.room = g.room ?? null;
        out.protocol = g.protocol;
        out.url = g.url;
        out.expiresIn = g.expiresAt - Math.floor(Date.now() / 1000);
      } catch (e) {
        out.result = "refused";
        if (e instanceof RelayError) {
          out.status = e.status ?? null;
          out.code = e.code;
          if (e.retryAfterSeconds !== undefined)
            out.retryAfter = e.retryAfterSeconds;
        } else if (e instanceof PolarisError) {
          out.status = e.status ?? null;
          out.code = e.code;
        } else throw e;
      }
      break;
    }
    case "report":
      out.result = await client.devices.report();
      out.updatesPending = (await client.update.journal.all()).length;
      break;
    case "boot":
      out.bootOutcome = (await client.boot({ autoConfirm: false })).outcome;
      break;
    case "releaseFetch": {
      const a = step.args;
      const build = String(a.build);
      const record = {
        version: String(a.version),
        builds: [
          {
            id: build,
            platform: String(a.platform),
            arch: String(a.arch),
            artifacts: [
              {
                role: "payload",
                sha256: String(a.sha256),
                size: Number(a.size),
              },
            ],
          },
        ],
      };
      const dir = mkdtempSync(join(tmpdir(), "pkey-replay-fetch-"));
      const to = join(dir, "payload.bin");
      if (typeof a.partial === "number") {
        const path = step.exchanges.items[0]!.request.path;
        writeFileSync(
          `${to}.part`,
          payloadPrefix(session.transcript, path, a.partial),
        );
      }
      try {
        const r = await client.release.fetch(
          { record: record as never, buildId: build },
          { to },
        );
        out.result = "ok";
        out.size = r.size;
        out.sha256 = r.sha256;
        expect(readFileSync(to).length, "the verified file").toBe(r.size);
      } catch (e) {
        if (!(e instanceof PolarisError)) throw e;
        // The client's own failures; any other code is the server's refusal.
        const local: string[] = [
          ErrorCode.networkError,
          ErrorCode.payloadMismatch,
          ErrorCode.invalidOptions,
          ErrorCode.serviceUnavailable,
          ErrorCode.notConfigured,
        ];
        out.result = local.includes(e.code) ? "error" : "refused";
        out.code = e.code;
        expect(existsSync(to), "no file is left on a refusal").toBe(false);
      }
      break;
    }
    case "downloadModel": {
      const model = await client.distribution.downloadModel();
      out.result = "ok";
      out.platforms = model.platforms.map((p) => p.platform);
      const platform = initialPlatform(session.transcript);
      out.current = (model.platforms.find((p) => p.platform === platform) ??
        null) as JsonValue;
      break;
    }
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
    case "commerceBinding": {
      const r = await client.commerce.binding();
      if (r.kind === "ok") {
        out.result = "ok";
        out.bindingId = r.bindingId;
        out.products = r.products as JsonValue;
      } else {
        out.result = r.code;
        if (r.reason !== undefined) out.reason = r.reason;
      }
      break;
    }
    case "commerceClaim": {
      const r = await client.commerce.claim(
        String(step.args.store) as never,
        (step.args.payload ?? {}) as Record<string, unknown>,
      );
      if (r.kind === "ok") {
        out.result = "ok";
        out.flag = r.flag;
        out.state = r.state;
        out.granted = r.granted;
      } else {
        out.result = r.code;
        if (r.reason !== undefined) out.reason = r.reason;
      }
      break;
    }
    case "keyringGet":
    case "keyringCreate":
    case "keyringReset":
    case "keyringWrap":
    case "keyringUnwrap":
    case "keyringAdopt":
    case "keyringRecoverySet":
    case "keyringRecoveryGet":
      await keyringStep(client, step, session, out);
      break;
    case "cloudSyncPull":
    case "cloudSyncPush":
      await cloudSyncStep(client, step, session, out);
      break;
    case "cloudSyncFile":
    case "cloudSyncChunk":
      await cloudSyncFileStep(client, step, out);
      break;
    case "connectIdentity":
    case "connectDevices":
      await connectStep(client, step, session, out);
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
    case "accessToken": {
      // identity.accesstoken (I-21b, WIRE-CONTRACT-V5 §12.13.10). The recording asks again inside
      // the 600 second window, so every step bypasses the held token (`refresh`); the reuse rule
      // itself is pinned by the client-core and SDK tests.
      out.accessTokenHeld = false;
      try {
        const got = await client.identity.accessToken({ refresh: true });
        out.result = "ok";
        out.accessTokenHeld = got.accessToken !== "";
        out.tokenType = got.tokenType;
        out.expiresIn = got.expiresIn;
      } catch (e) {
        if (!(e instanceof PolarisError)) throw e;
        if (e.code === "service-unavailable") out.result = "unavailable";
        else {
          out.result = "refused";
          if (e.status !== undefined) out.status = e.status;
          out.code = e.code;
          if (e.retryAfterSeconds !== undefined)
            out.retryAfter = e.retryAfterSeconds;
        }
      }
      break;
    }
    case "nearbyStart":
    case "nearbyPoll":
    case "nearbyApprove": {
      // identity.nearby (I-47.4): the HTTP routes under the nearby sessions, `identity.nearbyRoutes`
      // (typed cast: it is internal). D is this client; M a second one the replay builds.
      const first = session.transcript.steps.find(
        (s) => typeof s.args.keyLabel === "string",
      )!;
      Object.assign(
        out,
        await nearbyAction({
          t: session.transcript,
          step,
          d: () => ({
            routes: (client.identity as unknown as { nearbyRoutes: RoutesLike })
              .nearbyRoutes,
            keys: fixtureKeys(String(first.args.keyLabel)),
          }),
          m: (s) => session.nearbyM!(s),
          tokenHeld: () => store.token !== null,
          grant: (v) => grantApproval(v as unknown as VouchRequest),
        }),
      );
      break;
    }
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
  // The update-health journal and other persisted state live in a throwaway directory, so a
  // replay never reads what an earlier one wrote (or writes into the developer's home).
  const stateDir = mkdtempSync(join(tmpdir(), "pkey-replay-state-"));
  const journal = (t.initial as { updateJournal?: JsonValue[] }).updateJournal;
  if (journal) {
    // The client keeps its state under `<stateDir>/<product>` (src/core/dirs.ts).
    const productState = join(stateDir, t.product);
    mkdirSync(productState, { recursive: true });
    writeFileSync(
      join(productState, "update-events.json"),
      JSON.stringify(journal),
    );
  }
  let currentStep: Step | null = null;
  let stepIndex = -1;
  // identity.nearby (I-47.4): two devices, the fixture keys of the first step's `keyLabel`.
  const nearby = t.features.includes("identity.nearby");
  const syncWire: SyncWire = { etag: null, retryAfter: null };
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
      nearby &&
      url.pathname === discoveryPath &&
      step &&
      !step.exchanges.items.some((x) => x.request.path === discoveryPath)
    )
      return new Response(JSON.stringify(nearbyDiscovery(t, stepIndex)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
    if (isSyncGet(url, t.product)) {
      // A pull sends back the last ETag it saw, as a cache would (the transport has no cache).
      const headers = { ...(init?.headers as Record<string, string>) };
      if (syncWire.etag !== null) headers["if-none-match"] = syncWire.etag;
      const res = await server.fetch(input, { ...init, headers });
      syncWire.etag = res.headers.get("etag") ?? syncWire.etag;
      syncWire.retryAfter = res.headers.get("retry-after");
      return res;
    }
    const res = await server.fetch(input, init);
    if (url.pathname === `/${t.product}/sync/ops`)
      syncWire.retryAfter = res.headers.get("retry-after");
    return res;
  }) as typeof fetch;
  const services =
    t.initial.services ??
    (nearby
      ? ["license", "config", "identity"]
      : u
        ? ["release", "distribution", "update"]
        : usesAccount(t)
          ? ["license", "config", "identity"]
          : usesRedirect(t)
            ? ["identity"]
            : undefined);
  const client = new PolarisKeyClient({
    productSlug: t.product,
    baseUrl: t.baseUrl,
    version: u?.installed.version ?? t.initial.version,
    trust: { pinnedKeys: t.trust },
    store,
    fetchImpl,
    requestTimeoutMs: 0,
    // PX-W13: `initial.deviceName` stands in for the platform's device name; absent = none.
    deviceName: t.initial.deviceName ?? "",
    stateDir,
    // The key ring's device keys: a memory store, since the replay registers none.
    keyring: {
      deviceKeys: nearby
        ? fixtureKeyPort(
            String(
              t.steps.find((s) => typeof s.args.keyLabel === "string")!.args
                .keyLabel,
            ),
          )
        : createNodeDeviceKeyStore({ memory: true }),
    },
    // The presentation cache (HA-13) too, so a replay never writes into the developer's home.
    cacheDir: stateDir,
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
  if (usesRedirect(t) || asksDeviceChoice(t) || nearby)
    // The redirect recordings pin the token exchange alone. The acquisition sync a sign-in
    // raises (trust fetch, documents, report) is pinned by the sync transcripts, so it is not
    // replayed here.
    (
      client.identity as unknown as { onAcquired: () => Promise<void> }
    ).onAcquired = async () => undefined;
  await client.init();
  const session: Session = {
    prompt: null,
    transcript: t,
    server,
    redirect: null,
    native: null,
    opened: [],
    syncWire,
  };
  const approvers: PolarisKeyClient[] = [];
  if (nearby)
    session.nearbyM = async (s) => {
      // M: the signed-in approver of this step, a second device with its own id, token and keys.
      const keys = fixtureKeys(String(s.args.approverKeyLabel));
      const m = new PolarisKeyClient(
        nearbyClientOptions(t, {
          store: new TranscriptStore(
            String(s.args.approverDeviceId),
            String(s.args.approverToken),
          ),
          fetchImpl,
          dir: join(stateDir, "approver"),
          keys,
        }) as never,
      );
      approvers.push(m);
      await m.init();
      // M read discovery while the gate was still on; only a fresh read sees it go off.
      const at = stepIndex;
      stepIndex = 0;
      await m.discover();
      stepIndex = at;
      (
        m.identity as unknown as { onAcquired: () => Promise<void> }
      ).onAcquired = async () => undefined;
      return {
        routes: (m.identity as unknown as { nearbyRoutes: RoutesLike })
          .nearbyRoutes,
        keys,
      };
    };
  for (let i = 0; i < t.steps.length; i += 1) {
    const step = server.beginStep(i);
    currentStep = step;
    stepIndex = i;
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
  for (const m of approvers) m.close();
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

// @pkey-feature sync.files
describe("the Node replayer's file steps fail on a doctored transcript", () => {
  const base = TRANSCRIPTS.find((t) => t.id === "cloudsync-files-single")!;

  it("a dropped required header", async () => {
    const t = doctor(base, 1, (items) =>
      items.map((x) => ({
        ...x,
        request: {
          ...x.request,
          requiredHeaders: [...x.request.requiredHeaders, "x-pkey-doctored"],
        },
      })),
    );
    await expect(replay(t)).rejects.toThrow(
      /required header x-pkey-doctored: missing/,
    );
  });

  it("a different outcome", async () => {
    const t = JSON.parse(JSON.stringify(base)) as Transcript;
    t.steps[3]!.expect.version = 2;
    await expect(replay(t)).rejects.toThrow(
      /step 3 \(cloudSyncFile\): version/,
    );
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
