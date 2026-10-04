/**
 * Fixtures for the Distribution and Update pages (admin chunk 9): one product (`djdl`) with four
 * outlets, three app releases, a pack, rollouts in every state, readiness, connectors, keys,
 * credentials and update health. The unit suites drive the whole console against them through
 * `bootWith`, which records every request with its method and body; `e2e/distribution.e2e.test.ts`
 * and the screenshot script read the same data.
 */

import { vi } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import { App } from "../src/App.js";
import { ALL_ON, ME, productRow, type Enablement } from "./consoleHarness.js";

export const SLUG = "djdl";
export const NOW_S = 1_790_000_000;
const H = 3600;
const D = 24 * H;

const base = `/manage/api/products/${SLUG}`;
export const P = (path: string) => `${base}${path}`;

function rollout(
  outletId: string,
  channel: string,
  releaseId: string,
  state: string,
  bp: number,
  extra: Record<string, unknown> = {},
) {
  return {
    deliverableId: "app",
    outletId,
    channel,
    releaseId,
    rolloutBp: bp,
    state,
    mirrored: false,
    source: "admin",
    startedAt: NOW_S - 2 * D,
    updatedAt: NOW_S - 2 * H,
    updatedBy: "admin:u1",
    ...extra,
  };
}

const live = (releaseId: string, outletId: string, derived = false) => ({
  releaseId,
  buildId: "",
  outletId,
  transport: "pkey-cdn",
  state: "live",
  since: NOW_S - 3 * H,
  source: derived ? "derived" : "ci",
  derived,
  updatedAt: NOW_S - 3 * H,
});

export const MATRIX = {
  deliverableId: "app",
  limit: 20,
  outlets: [
    {
      outletId: "direct",
      kind: "direct",
      transport: "pkey-cdn",
      derives: true,
      supported: true,
    },
    {
      outletId: "app-store",
      kind: "app-store",
      transport: "store",
      derives: false,
      supported: true,
    },
    {
      outletId: "play",
      kind: "play",
      transport: "store",
      derives: false,
      supported: true,
    },
    {
      outletId: "altstore",
      kind: "altstore",
      transport: "pkey-cdn",
      derives: true,
      supported: true,
    },
  ],
  releases: [
    {
      releaseId: "rel_240",
      version: "2.4.0",
      channel: "stable",
      publishedAt: NOW_S - 3 * H,
      yanked: false,
    },
    {
      releaseId: "rel_rc2",
      version: "2.4.0-rc.2",
      channel: "beta",
      publishedAt: NOW_S - 2 * D,
      yanked: false,
    },
    {
      releaseId: "rel_239",
      version: "2.3.9",
      channel: "stable",
      publishedAt: NOW_S - 9 * D,
      yanked: false,
    },
  ],
  cells: [
    {
      releaseId: "rel_240",
      outletId: "direct",
      availability: "live",
      records: [live("rel_240", "direct", true)],
      submission: null,
      rollouts: [
        {
          ...rollout("direct", "stable", "rel_240", "active", 2500),
          controls: ["pause", "halt", "complete"],
        },
      ],
      readiness: {
        state: "ready",
        computed: "ready",
        holds: false,
        holdable: true,
        warning: null,
        blockers: [],
        pendingReason: null,
        override: null,
      },
    },
    {
      releaseId: "rel_240",
      outletId: "app-store",
      availability: "in-review",
      records: [
        { ...live("rel_240", "app-store"), state: "in-review", source: "asc" },
      ],
      submission: {
        releaseId: "rel_240",
        outletId: "app-store",
        state: "in-review",
        submittedAt: NOW_S - 20 * H,
        reviewedAt: null,
        source: "asc",
        updatedAt: NOW_S - 20 * H,
      },
      rollouts: [],
      readiness: {
        state: "ready",
        holds: false,
        holdable: false,
        warning: null,
        blockers: [],
        pendingReason: null,
      },
    },
    {
      releaseId: "rel_240",
      outletId: "play",
      availability: "live",
      records: [{ ...live("rel_240", "play"), source: "play" }],
      submission: null,
      rollouts: [
        {
          ...rollout("play", "stable", "rel_240", "active", 2500, {
            mirrored: true,
            source: "play",
            updatedBy: "play",
          }),
          controls: [],
        },
      ],
      readiness: null,
    },
    {
      releaseId: "rel_240",
      outletId: "altstore",
      availability: "pending",
      records: [{ ...live("rel_240", "altstore", true), state: "pending" }],
      submission: null,
      rollouts: [],
      readiness: {
        state: "blocked",
        computed: "blocked",
        holds: true,
        holdable: true,
        warning: null,
        blockers: [
          {
            pack: "textures",
            packReleaseId: "pr_tex_3",
            version: "3.0.0",
            reason: "not-stored",
            detail: "The textures 3.0.0 payload is not stored yet.",
          },
        ],
        pendingReason: null,
        override: null,
      },
    },
    {
      releaseId: "rel_rc2",
      outletId: "direct",
      availability: "live",
      records: [live("rel_rc2", "direct", true)],
      submission: null,
      rollouts: [
        {
          ...rollout("direct", "beta", "rel_rc2", "paused", 5000),
          controls: ["resume", "halt"],
        },
      ],
      readiness: null,
    },
    ...["direct", "app-store", "play", "altstore"].map((o) => ({
      releaseId: "rel_239",
      outletId: o,
      availability: "live",
      records: [live("rel_239", o, o === "direct" || o === "altstore")],
      submission: null,
      rollouts: [],
      readiness: null,
    })),
  ],
  states: {
    availability: ["live"],
    submission: ["in-review"],
    rollout: ["active"],
  },
};

export const ROLLOUTS = {
  rollouts: [
    rollout("direct", "stable", "rel_240", "active", 2500),
    rollout("play", "stable", "rel_240", "active", 2500, {
      mirrored: true,
      source: "play",
      updatedBy: "play",
    }),
    rollout("direct", "beta", "rel_rc2", "paused", 5000),
    rollout("altstore", "stable", "rel_239", "halted", 1000, {
      updatedBy: "system:auto-halt",
      source: "auto-halt",
    }),
  ],
};

export const RELEASES = {
  releases: [
    {
      releaseId: "rel_240",
      version: "2.4.0",
      title: null,
      publishedAt: NOW_S - 3 * H,
      sourceUrl: null,
      status: "published",
      artifacts: [],
      deliverable: "app",
      seq: 12,
      channel: "stable",
      yank: null,
      builds: [],
    },
    {
      releaseId: "rel_rc2",
      version: "2.4.0-rc.2",
      title: null,
      publishedAt: NOW_S - 2 * D,
      sourceUrl: null,
      status: "published",
      artifacts: [],
      deliverable: "app",
      seq: 11,
      channel: "beta",
      yank: null,
      builds: [],
    },
    {
      releaseId: "rel_239",
      version: "2.3.9",
      title: null,
      publishedAt: NOW_S - 9 * D,
      sourceUrl: null,
      status: "published",
      artifacts: [],
      deliverable: "app",
      seq: 10,
      channel: "stable",
      yank: null,
      builds: [],
    },
  ],
  channels: [
    { channel: "stable", releaseId: "rel_240", modifiedAt: null },
    { channel: "beta", releaseId: "rel_rc2", modifiedAt: null },
  ],
  floors: [],
};

export const DELIVERABLES = {
  gateKnown: true,
  deliverables: [
    { id: "app", kind: "app", type: null, declared: true, binding: null },
    {
      id: "textures",
      kind: "pack",
      type: "content",
      declared: true,
      binding: "compatible",
    },
  ],
};

const caps = (binaryUpdates: string, commerce: string, all = true) => ({
  binaryUpdates,
  codeUpdates: all,
  dataUpdates: true,
  channelSwitch: all,
  commerce,
  downloadedScripts: all,
});

export const OUTLETS = {
  capabilityKeys: [
    "binaryUpdates",
    "codeUpdates",
    "dataUpdates",
    "channelSwitch",
    "commerce",
    "downloadedScripts",
  ],
  outlets: [
    {
      outletId: "direct",
      kind: "direct",
      identity: { platforms: ["macos", "windows"] },
      listing: null,
      capabilities: caps("self", "own"),
      defaultCapabilities: caps("self", "own"),
      capabilitiesSource: "manifest",
      capabilityOverride: null,
      transports: [],
      removedAt: null,
      createdAt: NOW_S - 30 * D,
      modifiedAt: NOW_S - 3 * D,
    },
    {
      outletId: "app-store",
      kind: "app-store",
      identity: { appleId: "1234567890", bundleId: "gg.acme.djdl" },
      listing: null,
      capabilities: caps("store", "store-iap", false),
      defaultCapabilities: caps("store", "store-iap", false),
      capabilitiesSource: "manifest",
      capabilityOverride: null,
      transports: [
        { deliverableId: "textures", transport: "apple-ba", supported: false },
      ],
      removedAt: null,
      createdAt: NOW_S - 30 * D,
      modifiedAt: NOW_S - 3 * D,
    },
    {
      outletId: "play",
      kind: "play",
      identity: { packageName: "gg.acme.djdl" },
      listing: null,
      capabilities: caps("store", "none", false),
      defaultCapabilities: caps("store", "store-iap", false),
      capabilitiesSource: "admin",
      capabilityOverride: { commerce: "none" },
      transports: [],
      removedAt: null,
      createdAt: NOW_S - 30 * D,
      modifiedAt: NOW_S - 1 * D,
    },
    {
      outletId: "altstore",
      kind: "altstore",
      identity: {},
      listing: null,
      capabilities: caps("self", "none"),
      defaultCapabilities: caps("self", "none"),
      capabilitiesSource: "manifest",
      capabilityOverride: null,
      transports: [],
      removedAt: null,
      createdAt: NOW_S - 30 * D,
      modifiedAt: NOW_S - 3 * D,
    },
  ],
};

export const KEYS = {
  purposes: [
    "android-app-signing",
    "android-upload",
    "fdroid-repo",
    "sparkle-ed25519",
  ],
  keys: [
    {
      purpose: "android-app-signing",
      sha256: "a".repeat(64),
      outletId: "play",
      notes: "Play App Signing",
      registered: true,
      registeredAt: NOW_S - 9 * D,
      observed: null,
      flagged: false,
    },
  ],
  observations: [
    {
      purpose: "android-upload",
      sha256: "b".repeat(64),
      outletId: null,
      observed: { at: NOW_S - D, by: "ci:repo" },
      firstSeenAt: NOW_S - D,
    },
  ],
};

export const CONNECTORS = {
  connectors: [
    {
      kind: "asc",
      label: "App Store Connect",
      outletKinds: ["app-store", "testflight"],
      configured: true,
      inert: null,
      setup: {
        appleId: "1234567890",
        bundleId: "gg.acme.djdl",
        appStoreOutlet: "app-store",
        testflightOutlet: null,
        apiKeyCredential: "asc-team-key",
        webhookSecretCredential: null,
      },
      controls: [
        "phased-release/pause",
        "phased-release/resume",
        "phased-release/complete",
        "release",
        "testflight/public-link",
        "webhook",
      ],
    },
    {
      kind: "play",
      label: "Google Play",
      outletKinds: ["play", "play-testing"],
      configured: true,
      inert: null,
      setup: {
        packageName: "gg.acme.djdl",
        outlets: [
          { outletId: "play", kind: "play", tracks: { stable: "production" } },
        ],
        credential: "play",
      },
      settings: {
        priority: { default: 0 },
        vitals: {
          enabled: false,
          metric: "user-perceived",
          windowHours: 24,
          minDistinctUsers: 1000,
          crashRateThreshold: 0.02,
          anrRateThreshold: 0.01,
        },
      },
      controls: [
        "rollout/fraction",
        "rollout/halt",
        "rollout/resume",
        "rollout/complete",
        "priority",
        "settings",
      ],
      notes: [
        "Halting a completed release rolls the track back to the previously completed release; rollout/halt asks for confirmRollback.",
      ],
    },
    {
      kind: "ms-store",
      label: "Microsoft Store",
      outletKinds: ["ms-store"],
      configured: false,
      inert: {
        reason: "no_outlet",
        message:
          "declare an ms-store outlet with a productId in .pkey/distribution",
      },
      setup: null,
      controls: [],
    },
  ],
};

const counts = (
  o: number,
  dl: number,
  ap: number,
  cf: number,
  rv: number,
  pf = 0,
  br = 0,
) => ({
  update_offered: o,
  update_downloaded: dl,
  update_applied: ap,
  update_confirmed: cf,
  update_reverted: rv,
  pack_failed: pf,
  boot_rolled_back: br,
});

export const HEALTH = {
  windowHours: 24,
  counting: true,
  events: ["update_offered"],
  rollouts: [
    {
      rollout: ROLLOUTS.rollouts[0],
      devices: counts(1200, 1100, 1050, 1000, 12, 3, 1),
      events: counts(1300, 1150, 1080, 1010, 12, 3, 1),
      truncated: false,
      verdict: { revertRate: 0.0114, bootRollbackRate: 0.001, trips: [] },
    },
  ],
  unknown: [],
  autoHalt: {
    settings: {
      enabled: true,
      windowHours: 24,
      minSample: 200,
      maxRevertRate: 0.05,
      maxBootRollbackRate: 0.02,
      updatedAt: NOW_S - 5 * D,
      updatedBy: "u1",
    },
    defaults: {
      enabled: false,
      windowHours: 24,
      minSample: 100,
      maxRevertRate: 0.05,
      maxBootRollbackRate: 0.02,
    },
    maxWindowHours: 72,
    lastReading: {
      type: "reading",
      id: "last",
      outletId: null,
      releaseId: null,
      state: null,
      ref: {},
      detail: { at: NOW_S - 600 },
      terminal: false,
      updatedAt: NOW_S - 600,
    },
    trips: [
      {
        type: "trip",
        id: "t1",
        outletId: "altstore",
        releaseId: "rel_239",
        state: "halted",
        ref: { channel: "stable" },
        detail: { reason: "revert rate 7.10% (71 of 1000 devices) > 5.00%" },
        terminal: true,
        updatedAt: NOW_S - 2 * H,
      },
    ],
    alerts: [],
  },
  sentry: {
    configured: true,
    candidates: [
      {
        type: "halt-candidate",
        id: "cand_1",
        outletId: "direct",
        releaseId: "rel_240",
        state: "open",
        ref: { channel: "stable" },
        detail: { rule: "Crash spike", alerts: 3, lastAlertAt: NOW_S - H },
        terminal: false,
        updatedAt: NOW_S - H,
      },
      {
        type: "halt-candidate",
        id: "cand_0",
        outletId: "direct",
        releaseId: "rel_239",
        state: "dismissed",
        ref: { channel: "stable" },
        detail: { rule: "Error rate", alerts: 1 },
        terminal: true,
        updatedAt: NOW_S - 4 * D,
      },
    ],
  },
};

export const ACCESS = {
  modes: ["public", "authenticated", "licensed", "entitled"],
  app: { deliverableId: "app", mode: "licensed", source: "manifest" },
  deliverables: [
    {
      deliverableId: "app",
      mode: "licensed",
      entitlement: null,
      source: "manifest",
      modifiedAt: NOW_S - 30 * D,
    },
  ],
};

export const CREDENTIALS = {
  ok: true,
  kinds: ["asc-api-key", "google-service-account", "sentry-integration"],
  pins: {
    "asc-api-key": {
      field: "appleId",
      label: "App Store Connect app id (Apple ID)",
    },
    "google-service-account": {
      field: "packageName",
      label: "Google Play package name",
    },
  },
  credentials: [
    {
      id: "asc-team-key",
      kind: "asc-api-key",
      outletId: "app-store",
      meta: {
        keyId: "ABC123DEFG",
        issuerId: "issuer-1",
        appleId: "1234567890",
      },
      status: "active",
      createdAt: NOW_S - 30 * D,
      createdBy: "u1",
      rotatedAt: null,
      expiresAt: null,
      lastUsedAt: NOW_S - H,
      lastOkAt: NOW_S - H,
      lastError: null,
    },
    {
      id: "play",
      kind: "google-service-account",
      outletId: null,
      meta: { clientEmail: "pkey@acme.iam.gserviceaccount.com" },
      status: "active",
      createdAt: NOW_S - 20 * D,
      createdBy: "u1",
      rotatedAt: null,
      expiresAt: null,
      lastUsedAt: NOW_S - 2 * H,
      lastOkAt: null,
      lastError:
        "403 from Google Play: the service account has no access to gg.acme.djdl",
    },
  ],
};

export const FEED = {
  metadataAccess: "public",
  accessSource: "admin",
  compatMin: "1.0.0",
  compatMax: "2.99.0",
  compatSource: "manifest",
  minimumSystemVersion: "13.0",
  requireSparkleSignature: true,
  configured: true,
};

export const CATALOG = {
  schemaVersion: 3,
  entries: [
    {
      key: "pro-content",
      kind: "flag",
      category: "General",
      label: "Pro content",
      description: "",
      schema: { type: "boolean" },
    },
  ],
};

/** Every read the chunk 9 pages make, keyed by path. */
export const DISTRIBUTION_ROUTES: Record<string, unknown> = {
  [P("/distribution/matrix")]: MATRIX,
  [P("/distribution/rollouts")]: ROLLOUTS,
  [P("/distribution/outlets")]: OUTLETS,
  [P("/distribution/keys")]: KEYS,
  [P("/distribution/connectors")]: CONNECTORS,
  [P("/distribution/update-health")]: HEALTH,
  [P("/distribution/access")]: ACCESS,
  [P("/outlet-credentials")]: CREDENTIALS,
  [P("/update/settings")]: FEED,
  [P("/release/releases")]: RELEASES,
  [P("/release/deliverables")]: DELIVERABLES,
  [P("/config/catalog")]: CATALOG,
  [P("/services")]: {
    services: ALL_ON,
    registration: null,
    effectiveRegistration: "requires-license",
    source: "manifest",
  },
};

export interface Call {
  path: string;
  query: string;
  method: string;
  body: unknown;
}

/** A route answer: a body, a `Response`, or a function of the call. */
export type Answer = unknown | Response | ((call: Call) => unknown | Response);

/**
 * Mount the whole console at `hash` against the fixtures. `routes` keys are a path (any method)
 * or `"METHOD path"`; exact paths win, then the longest prefix. Every call is recorded.
 */
export function bootWith(
  hash: string,
  routes: Record<string, Answer> = {},
  opts: { services?: Enablement } = {},
): { calls: Call[] } {
  const calls: Call[] = [];
  window.location.hash = hash;
  const services = opts.services ?? ALL_ON;
  const table: Record<string, Answer> = {
    "/manage/api/me": ME,
    "/manage/api/products": {
      products: ME.products.map((p) => productRow(p.slug, p.name, services)),
    },
    "/manage/api/products/djdl": {
      product: productRow("djdl", "DJDL", services),
    },
    "/manage/api/products/acme": {
      product: productRow("acme", "Acme", services),
    },
    ...DISTRIBUTION_ROUTES,
    ...routes,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
        "http://localhost",
      );
      const method = init?.method ?? "GET";
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const call: Call = {
        path: url.pathname,
        query: url.search,
        method,
        body: raw ? JSON.parse(raw) : undefined,
      };
      calls.push(call);
      const keyed = (k: string) => (k in table ? k : null);
      const prefix = (m: string | null) =>
        Object.keys(table)
          .filter((k) => {
            const [km, kp] = k.includes(" ") ? k.split(" ") : [null, k];
            return (km === null || km === m) && call.path.startsWith(kp!);
          })
          .sort((a, b) => b.length - a.length)[0] ?? null;
      const key =
        keyed(`${method} ${call.path}`) ??
        (method === "GET" ? keyed(call.path) : null) ??
        prefix(method);
      let answer: Answer = key ? table[key] : {};
      if (method !== "GET" && key && !key.includes(" ")) answer = { ok: true };
      if (typeof answer === "function")
        answer = (answer as (c: Call) => unknown)(call);
      if (answer instanceof Response) return answer.clone();
      return new Response(JSON.stringify(answer ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(React.createElement(App));
  return { calls };
}

/** A JSON error response, in the admin API's shape. */
export function apiError(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  message?: string,
): Response {
  return new Response(
    JSON.stringify({
      error: { code, ...(message ? { message } : {}), ...extra },
      code,
      ...extra,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** The writes a run made (everything but GET). */
export function writes(calls: Call[]): Call[] {
  return calls.filter((c) => c.method !== "GET");
}
