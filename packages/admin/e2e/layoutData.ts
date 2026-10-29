/**
 * Plain read-model data for the layout lint's fixture server (`layoutFixtures.ts`), lifted from the
 * unit suites that already pin each page's shape (platform, platform settings and stores, compat,
 * deliverables, profiles, licenses) so the browser check draws the same, realistic objects. Data
 * only: nothing here needs a DOM.
 */

import type {
  CompatResponse,
  DelegationsResponse,
  DeliverablesResponse,
  PackFilesResponse,
  PackReleasesResponse,
  PlatformStoreApp,
  PlatformStoreCredential,
} from "../src/api.js";
import { sha } from "../test/releaseFixture.js";
import { workerFields } from "./workerFields.js";

type Setting = Record<string, unknown>;

// ── Platform → Deployment, Activity, Operations (test/platform.test.tsx) ─────────────────────
const SHA = "0123456789abcdef0123456789abcdef01234567";

const IDENTITY = {
  releaseTag: "v0.8.6",
  gitSha: SHA,
  cloudflare: {
    id: "cf-version-1234567890",
    tag: "v0.8.6",
    uploadedAt: "2026-10-03T12:00:00Z",
  },
  protocolVersion: 4,
  discoveryVersion: 2,
  latestMigration: "0054_b_platform_audit.sql",
  environment: "prod",
};

/** `GET /members`: the roster Platform → Members draws. */
function productMembersView() {
  const role = (bindingId: string, over: Record<string, unknown> = {}) => ({
    role: "product_admin",
    areas: null,
    source: "grant",
    bindingId,
    grantedBy: { name: "Ada Lindqvist" },
    grantedAt: 1_789_000_000,
    ...over,
  });
  return {
    product: "djdl",
    truncated: false,
    incomplete: false,
    members: [
      {
        memberId: "mbr_kenji",
        name: "Kenji Mori",
        email: "kenji@example.com",
        you: true,
        roles: [role("b_kenji")],
      },
      {
        memberId: "mbr_lucia",
        name: "Lucía Ortega",
        email: "lucia@example.com",
        you: false,
        roles: [role("b_lucia", { areas: ["ship", "commerce"] })],
      },
      {
        memberId: "mbr_bart",
        name: "Bartholomew Featherstonehaugh-Cholmondeley",
        email:
          "bartholomew.featherstonehaugh-cholmondeley@a-very-long-company-name.example.com",
        you: false,
        roles: [
          role("b_bart", {
            areas: ["license", "config", "ship", "signin"],
            source: "invite",
          }),
        ],
      },
    ],
    invites: [
      {
        bindingId: "b_marco",
        email: "marco@example.com",
        role: "product_admin",
        areas: ["commerce"],
        invitedBy: { name: "Kenji Mori" },
        sentAt: 1_789_980_000,
        expiresAt: 1_790_500_000,
      },
    ],
    platformRoles: [
      {
        memberId: "mbr_ada",
        name: "Ada Lindqvist",
        email: "ada@example.com",
        role: "superadmin",
        scope: "platform",
        areas: null,
        source: "root",
      },
      {
        memberId: "mbr_sam",
        name: "Sam Okoye",
        email: "sam@example.com",
        role: "product_admin",
        scope: "products:*",
        areas: ["ship"],
        source: "grant",
      },
    ],
  };
}

function membersView() {
  const role = (
    role: string,
    scope: string,
    over: Record<string, unknown> = {},
  ) => ({
    role,
    scope,
    areas: null,
    source: "grant",
    bindingId: `b_${role}_${scope.replace(/\W/g, "")}`,
    grantedBy: { name: "Ada Lovelace" },
    grantedAt: 1_789_000_000,
    ...over,
  });
  const root = {
    role: "superadmin",
    scope: "platform",
    areas: null,
    source: "root",
    bindingId: null,
    grantedBy: null,
    grantedAt: null,
  };
  const member = (
    i: number,
    name: string,
    email: string,
    roles: Record<string, unknown>[],
    over: Record<string, unknown> = {},
  ) => ({
    memberId: `mbr_${i}`,
    name,
    email,
    lastSignInAt: 1_789_990_000 - i * 40_000,
    disabled: false,
    you: i === 0,
    roles,
    ...over,
  });
  return {
    rootRule: { group: "polaris-admins" },
    truncated: false,
    incomplete: false,
    members: [
      member(0, "Ada Lindqvist", "ada@example.com", [root]),
      member(1, "Jonas Weber", "jonas@example.com", [root]),
      member(2, "Priya Raman", "priya@example.com", [
        role("platform_admin", "platform"),
        role("product_admin", "product:djdl", { source: "creator" }),
      ]),
      member(3, "Kenji Mori", "kenji@example.com", [
        role("product_admin", "product:acme"),
      ]),
      member(4, "Sam Okoye", "sam@example.com", [
        role("product_admin", "products:*", { areas: ["ship"] }),
        role("product_admin", "product:djdl"),
      ]),
      member(5, "Lucía Ortega", "lucia@example.com", [
        role("product_admin", "product:acme", { areas: ["ship", "commerce"] }),
      ]),
      member(6, "Noor Haddad", "noor@example.com", [
        role("console_access", "platform"),
      ]),
      member(
        7,
        "Bartholomew Featherstonehaugh-Cholmondeley",
        "bartholomew.featherstonehaugh-cholmondeley@a-very-long-company-name.example.com",
        [
          // A 38-character product (a slug the console cannot name) with three areas.
          role(
            "product_admin",
            "product:northwind-broadcast-audio-workstations",
            {
              areas: ["license", "config", "ship"],
            },
          ),
        ],
      ),
      member(
        8,
        "",
        "no-name@example.com",
        [role("console_access", "platform")],
        {
          lastSignInAt: null,
        },
      ),
    ],
    invites: [
      {
        bindingId: "b_inv_1",
        email: "mira@example.com",
        role: "product_admin",
        scope: "product:djdl",
        areas: null,
        invitedBy: { name: "Priya Raman" },
        sentAt: 1_789_900_000,
        expiresAt: 1_790_500_000,
      },
      {
        bindingId: "b_inv_2",
        email: "tom@example.com",
        role: "console_access",
        scope: "platform",
        areas: null,
        invitedBy: { name: "Ada Lindqvist" },
        sentAt: 1_789_800_000,
        expiresAt: 1_790_400_000,
      },
      {
        bindingId: "b_inv_3",
        email: "olu@example.com",
        role: "platform_admin",
        scope: "platform",
        areas: null,
        invitedBy: { name: "Ada Lindqvist" },
        sentAt: 1_789_700_000,
        expiresAt: 1_790_300_000,
      },
    ],
  };
}

function deploy(i: number, smoke = "success") {
  return {
    id: `run-${i}`,
    at: 1_790_000_000 - i * 3600,
    environment: "prod",
    tag: `v0.8.${6 - i}`,
    gitSha: SHA,
    runUrl: `https://github.com/acme/pk/actions/runs/${i}`,
    scripts: ["polaris-key", "polaris-key-deltas"],
    latestMigration: "0054_b_platform_audit.sql",
    cloudflareVersionId: "cf",
    deltasVersionId: "cf2",
    smoke,
  };
}

function deployment(over: Record<string, unknown> = {}) {
  return {
    current: IDENTITY,
    deploys: {
      items: [deploy(0), deploy(1)],
      nextCursor: { beforeAt: 1_789_996_400, beforeId: "run-1" },
    },
    migrations: {
      latest: "0054_b_platform_audit.sql",
      applied: [
        { name: "0053_x.sql", appliedAt: "2026-09-01 10:00:00" },
        { name: "0054_b_platform_audit.sql", appliedAt: "2026-10-01 10:00:00" },
      ],
      upToDate: true,
    },
    indexes: { missing: [] },
    bindings: { DB: true, HOT: true, BLOBS: true, CF_VERSION_METADATA: true },
    ...over,
  };
}

const ACTIVITY = {
  items: [
    {
      id: "pa1",
      at: 1_790_000_000,
      actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
      action: "kek.reseal",
      target: { kind: "kek", id: "kek-2" },
      summary: "Re-sealed 12 value(s) under KEK kek-2 (0 remaining)",
      before: null,
      after: null,
    },
  ],
  nextCursor: null,
};
const GENERATED = 1_790_000_000;

function step(name: string, over: Record<string, unknown> = {}) {
  return {
    step: name,
    startedAt: (GENERATED - 600) * 1000,
    durationMs: 850,
    outcome: "ok",
    items: 1,
    rowsAffected: 3,
    error: null,
    ...over,
  };
}

function operations(over: Record<string, unknown> = {}) {
  return {
    generatedAt: GENERATED,
    probes: {
      d1: { bound: true, ok: true, latencyMs: 12 },
      kv: { bound: true, ok: true, latencyMs: 20 },
      r2: { bound: true, ok: true, latencyMs: 31 },
      updateHealth: { bound: true },
      email: { bound: false },
    },
    queues: {
      deltas: {
        bound: true,
        ok: true,
        latencyMs: 5,
        backlogCount: 4,
        backlogBytes: 2048,
        oldestMessageAt: GENERATED - 120,
      },
      deadLetter: {
        bound: true,
        ok: true,
        latencyMs: 5,
        backlogCount: 0,
        backlogBytes: 0,
        oldestMessageAt: null,
      },
      consumer: {
        maxBatchSize: 1,
        maxBatchTimeoutSeconds: 5,
        maxRetries: 3,
        maxConcurrency: 1,
      },
    },
    heartbeats: [
      {
        script: "main",
        at: GENERATED - 300,
        versionTag: "v0.8.6",
        cloudflareVersionId: null,
        outcome: "connectorPoll:ok",
        backlogCount: null,
        backlogBytes: null,
        oldestMessageAt: null,
      },
      {
        script: "deltas",
        at: GENERATED - 60,
        versionTag: "v0.8.6",
        cloudflareVersionId: null,
        outcome: "ok",
        backlogCount: 4,
        backlogBytes: 2048,
        oldestMessageAt: GENERATED - 120,
      },
    ],
    jobs: {
      latest: {
        maintenance: {
          runId: "r1",
          job: "maintenance",
          cron: "17 3 * * *",
          startedAt: (GENERATED - 3600) * 1000,
          durationMs: 4200,
          outcome: "ok",
          steps: [step("retention"), step("audit:*")],
        },
        connectorPoll: {
          runId: "r2",
          job: "connectorPoll",
          cron: "*/15 * * * *",
          startedAt: (GENERATED - 600) * 1000,
          durationMs: 900,
          outcome: "ok",
          steps: [step("asc:poll")],
        },
      },
      recent: [
        {
          runId: "r2",
          job: "connectorPoll",
          cron: "*/15 * * * *",
          startedAt: (GENERATED - 600) * 1000,
          durationMs: 900,
          outcome: "ok",
          steps: 1,
        },
        {
          runId: "r1",
          job: "maintenance",
          cron: "17 3 * * *",
          startedAt: (GENERATED - 3600) * 1000,
          durationMs: 4200,
          outcome: "ok",
          steps: 2,
        },
      ],
      failures: [],
    },
    storage: {
      d1: { sizeBytes: 12_400_000 },
      r2: {
        committedBytes: 5_000_000_000,
        objects: 42,
        byKind: [
          { kind: "bundle", gated: false, bytes: 5_000_000_000, objects: 42 },
        ],
      },
    },
    indexes: { missing: [] },
    connectors: {
      items: [
        {
          connector: "asc",
          productsConfigured: 2,
          objectsTracked: 7,
          lastPolledAt: GENERATED - 600,
          lastEventAt: null,
          failedEvents24h: 0,
        },
        {
          connector: "play",
          productsConfigured: 0,
          objectsTracked: 0,
          lastPolledAt: null,
          lastEventAt: null,
          failedEvents24h: 0,
        },
      ],
      lastPollFailure: null,
      commerce: { available: false },
    },
    recentErrors: {
      jobFailures: [],
      lazyDeltaRefusals: [
        { reason: "too_large", count: 3, lastAt: GENERATED - 90 },
      ],
    },
    ...over,
  };
}

// ── Platform → Store connections (test/platformStores.test.tsx) ──────────────────────────
const BASE = "/manage/api/platform/store-connections";

function credential(
  over: Partial<PlatformStoreCredential> & { id: string },
): PlatformStoreCredential {
  const [store, slot] = over.id.split(".") as [
    PlatformStoreCredential["store"],
    string,
  ];
  return {
    store,
    slot,
    kind: "asc-api-key",
    label: over.id,
    configured: false,
    source: null,
    meta: null,
    console: {
      present: false,
      status: null,
      meta: null,
      createdAt: null,
      createdBy: null,
      rotatedAt: null,
      lastUsedAt: null,
      lastOkAt: null,
      lastError: null,
    },
    secret: { name: "PLATFORM_X", present: false, valid: false },
    pinField: "appleId",
    pins: 0,
    ...over,
  };
}

const STORES = [
  {
    store: "app-store",
    label: "App Store",
    configured: true,
    primary: "app-store.api-key",
    credentials: [
      credential({
        id: "app-store.api-key",
        label: "App Store Connect API key (team)",
        configured: true,
        source: "secret",
        meta: { keyId: "ABC123DEFG", issuerId: "69a6de7f-1111" },
        secret: { name: "PLATFORM_ASC_API_KEY", present: true, valid: true },
        pins: 1,
      }),
      credential({
        id: "app-store.in-app-purchase-key",
        label: "In-App Purchase key (team, App Store Server API)",
        kind: "app-store-server-key",
        secret: {
          name: "PLATFORM_APP_STORE_SERVER_KEY",
          present: false,
          valid: false,
        },
        pinField: "bundleId",
      }),
    ],
    settings: [
      {
        key: "teamId",
        label: "Apple Developer Team ID",
        usedBy: "App Attest's default team.",
        value: "48H7CLBV8Y",
        source: "env",
        envName: "PLATFORM_APPLE_TEAM_ID",
        updatedAt: null,
        updatedBy: null,
      },
    ],
    appsListing: true,
    assignments: [
      { product: "acme", pins: { "app-store.api-key": "2222222222" } },
    ],
  },
  {
    store: "google-play",
    label: "Google Play",
    configured: true,
    primary: "google-play.service-account",
    credentials: [
      credential({
        id: "google-play.service-account",
        label: "Google Play service account (developer account)",
        kind: "google-service-account",
        configured: true,
        source: "console",
        meta: { clientEmail: "pk@acme.iam.gserviceaccount.com" },
        console: {
          present: true,
          status: "active",
          meta: { clientEmail: "pk@acme.iam.gserviceaccount.com" },
          createdAt: 1_790_000_000,
          createdBy: "u1",
          rotatedAt: null,
          lastUsedAt: 1_790_000_100,
          lastOkAt: 1_790_000_100,
          lastError: null,
        },
        secret: {
          name: "PLATFORM_GOOGLE_SERVICE_ACCOUNT",
          present: false,
          valid: false,
        },
        pinField: "packageName",
      }),
    ],
    settings: [],
    appsListing: true,
    assignments: [],
  },
  {
    store: "microsoft-store",
    label: "Microsoft Store",
    configured: true,
    primary: "microsoft-store.partner-center",
    credentials: [
      credential({
        id: "microsoft-store.partner-center",
        label: "Partner Center app (seller account)",
        kind: "ms-partner-center",
        configured: true,
        source: "console",
        meta: { tenantId: "t-1", clientId: "c-1", sellerId: "s-1" },
        console: {
          present: true,
          status: "active",
          meta: null,
          createdAt: 1_790_000_000,
          createdBy: "u1",
          rotatedAt: null,
          lastUsedAt: 1_790_000_100,
          lastOkAt: null,
          lastError: "Partner Center token: HTTP 401",
        },
        pinField: "productId",
      }),
    ],
    settings: [],
    appsListing: true,
    assignments: [],
  },
  {
    store: "steam",
    label: "Steam",
    configured: false,
    primary: "steam.publisher-key",
    credentials: [
      credential({
        id: "steam.publisher-key",
        label: "Steamworks Web API publisher key (group)",
        kind: "steam-publisher-key",
        secret: {
          name: "PLATFORM_STEAM_PUBLISHER_KEY",
          present: false,
          valid: false,
        },
        pinField: "appId",
      }),
    ],
    settings: [],
    appsListing: true,
    assignments: [],
  },
];

const ASC_APPS = {
  store: "app-store",
  source: "secret",
  fetchedAt: 1_790_000_000,
  cached: false,
  truncated: false,
  apps: [
    {
      appId: "1234567890",
      name: "Godot Demo",
      pins: { "app-store.in-app-purchase-key": "com.acme.demo" },
      identifiers: { bundleId: "com.acme.demo", sku: "DEMO" },
      status: {
        appStore: {
          versions: [
            {
              platform: "IOS",
              versionString: "1.2.0",
              state: "WAITING_FOR_REVIEW",
            },
          ],
          phasedRelease: null,
        },
        testflight: { versions: [{ id: "p1" }] },
      },
      assignedProduct: null,
      assignedVia: null,
    },
    {
      appId: "2222222222",
      name: "Acme Game",
      pins: {},
      identifiers: { bundleId: "com.acme.game", sku: null },
      status: { appStore: { versions: [], phasedRelease: null } },
      assignedProduct: "acme",
      assignedVia: "platform",
    },
    {
      appId: "3333333333",
      name: "DJ Tool",
      pins: {},
      identifiers: { bundleId: "com.djdl.tool", sku: null },
      status: { appStore: { versions: [], phasedRelease: null } },
      assignedProduct: "djdl",
      assignedVia: "own-credential",
    },
  ],
};

const PLAY_APPS = (tracks: boolean) => ({
  store: "google-play",
  source: "console",
  fetchedAt: 1_790_000_000,
  cached: true,
  truncated: false,
  apps: [
    {
      appId: "com.acme.game",
      name: "Acme Game",
      pins: {},
      identifiers: { packageName: "com.acme.game" },
      status: tracks
        ? {
            tracks: [
              {
                track: "production",
                releases: [
                  {
                    name: "42",
                    status: "inProgress",
                    userFraction: 0.2,
                    versionCodes: ["42"],
                  },
                ],
              },
            ],
            tracksError: null,
          }
        : { tracks: null, tracksError: null },
      assignedProduct: null,
      assignedVia: null,
    },
  ],
});

const ASSIGN_RESULT = {
  ok: true,
  store: "app-store",
  appId: "1234567890",
  product: "djdl",
  pins: [
    { credential: "app-store.api-key", pin: "1234567890", changed: true },
    {
      credential: "app-store.in-app-purchase-key",
      pin: "com.acme.demo",
      changed: true,
    },
  ],
  released: [],
  ownCredentialsRepinned: ["oc_asc_1"],
  ownCredentialsSkipped: [{ id: "oc_steam_9", reason: "account_unverified" }],
};

// ── Platform → Settings (test/platformSettings.test.tsx) ─────────────────────────────────
function lazyDeltas(over: Setting = {}): Setting {
  return {
    key: "LAZY_DELTAS",
    area: "background-jobs",
    label: "Lazy deltas",
    description:
      "Lets products opted in to lazy hot-pair deltas count demand and generate deltas.",
    kind: "switch",
    scripts: ["main", "deltas"],
    precedence: "ceiling",
    default: "off",
    deployValue: "runtime",
    value: "off",
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { on: "L1", off: "L0" },
    ...over,
  };
}

/** PX-W13c: the extra reserved display terms, a list row in Sign-in. */
function reservedTerms(over: Setting = {}): Setting {
  return {
    key: "identity.reservedDisplayTerms",
    area: "identity",
    label: "Extra reserved display terms",
    description:
      "Platform or store names, beyond the built-in list, that a product or developer name may not use.",
    kind: "list",
    max: 64,
    maxLength: 64,
    scripts: ["main"],
    precedence: "runtime",
    default: [],
    deployValue: null,
    value: ["Zephyr", "Acme Store"],
    source: "runtime",
    forcedOff: false,
    stored: {
      value: ["Zephyr", "Acme Store"],
      valid: true,
      updatedAt: 1_790_000_000,
      updatedBy: "ops@x.io",
    },
    version: 1,
    confirm: { change: "L1" },
    ...over,
  };
}

/** ST-16: the product defaults the Worker lists under Platform → Settings. */
function keyEntryCeiling(over: Setting = {}): Setting {
  return {
    key: "identity.keyEntry.limit",
    area: "product-defaults",
    label: "Key-entry limit ceiling",
    description:
      "The most key entries any product may allow per license that is in no account. A product may set a lower limit, never a higher one.",
    kind: "integer",
    unit: "count",
    min: 1,
    max: 100,
    scripts: ["main"],
    precedence: "runtime",
    default: 100,
    deployValue: null,
    value: 20,
    source: "runtime",
    forcedOff: false,
    stored: {
      value: 20,
      valid: true,
      updatedAt: 1_790_000_000,
      updatedBy: "ops@x.io",
    },
    version: 2,
    link: "bound",
    fleet: {
      kind: "bound",
      total: 14,
      count: 2,
      products: [
        {
          product: "djdl",
          name: "DJDL",
          set: 50,
          effective: 20,
          inherited: false,
        },
        {
          product: "northwind",
          name: "Northwind",
          set: 10,
          effective: 20,
          inherited: true,
        },
      ],
    },
    confirm: { raise: "L2", lower: "L2" },
    ...over,
  };
}

function mediaQuota(over: Setting = {}): Setting {
  return {
    key: "assets.quota.mediaBytes",
    area: "product-defaults",
    label: "Default media quota",
    description:
      "How many bytes of hosted images a product may hold when it sets no quota of its own.",
    kind: "integer",
    unit: "bytes",
    min: 0,
    max: 1_099_511_627_776,
    scripts: ["main"],
    precedence: "runtime",
    default: 536_870_912,
    deployValue: null,
    value: 536_870_912,
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    link: "default",
    fleet: {
      kind: "default",
      total: 14,
      inheriting: 12,
      own: [{ product: "djdl", name: "DJDL", value: 8_589_934_592 }],
    },
    confirm: { raise: "L2", lower: "L2" },
    ...over,
  };
}

function maxBytes(over: Setting = {}): Setting {
  return {
    key: "LAZY_DELTA_MAX_BYTES",
    area: "background-jobs",
    label: "Lazy delta size cap",
    description: "The largest payload the delta consumer will encode.",
    kind: "integer",
    unit: "bytes",
    min: 1_048_576,
    max: 33_554_432,
    scripts: ["main", "deltas"],
    precedence: "runtime",
    default: 33_554_432,
    deployValue: "33554432",
    value: 33_554_432,
    source: "deploy",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { raise: "L1", lower: "L0" },
    ...over,
  };
}

function gcMode(over: Setting = {}): Setting {
  return {
    key: "BLOB_GC_MODE",
    area: "background-jobs",
    label: "Blob collector",
    description: "Runs the nightly collector.",
    kind: "switch",
    scripts: ["main"],
    precedence: "ceiling",
    default: "on",
    deployValue: null,
    value: "on",
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { on: "L1", off: "L0" },
    ...over,
  };
}

/** Cloud Sync's two platform controls (U-05.21: Setup draws the default and the pause beside them). */
function cloudSyncDefault(over: Setting = {}): Setting {
  return {
    key: "cloudSync.quota.defaultBytes",
    area: "cloudSync",
    label: "Default Cloud Sync quota",
    description: "What a person may store when their tier sets nothing.",
    kind: "integer",
    unit: "bytes",
    min: 1_048_576,
    max: 1_073_741_824,
    scripts: ["main"],
    precedence: "runtime",
    default: 268_435_456,
    deployValue: null,
    value: 268_435_456,
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { raise: "L2", lower: "L2" },
    link: "default",
    ...over,
  };
}

function cloudSyncPause(over: Setting = {}): Setting {
  return {
    key: "cloudSync.writesPaused",
    area: "cloudSync",
    label: "Pause Cloud Sync writes",
    description: "Stops new settings and saves in every product.",
    kind: "switch",
    scripts: ["main"],
    precedence: "runtime",
    default: "off",
    deployValue: null,
    value: "off",
    source: "default",
    forcedOff: false,
    stored: null,
    version: 0,
    confirm: { on: "L2", off: "L1" },
    ...over,
  };
}

/** The platform settings with Cloud Sync's writes paused: the Resume dialog opened from Home. */
export function pausedPlatformSettings(): Record<string, unknown> {
  const v = view();
  return {
    ...v,
    settings: v.settings.map((x) =>
      x.key === "cloudSync.writesPaused"
        ? cloudSyncPause({
            value: "on",
            version: 4,
            stored: {
              value: "on",
              valid: true,
              updatedAt: Math.floor(Date.now() / 1000) - 2 * 3600,
              updatedBy: "m-ana",
            },
          })
        : x,
    ),
  };
}

function grace(over: Setting = {}): Setting {
  return {
    key: "BLOB_GC_GRACE_DAYS",
    area: "background-jobs",
    label: "Blob collector grace period",
    description: "How long an object stays unreferenced.",
    kind: "integer",
    unit: "days",
    min: 1,
    max: 365,
    scripts: ["main"],
    precedence: "runtime",
    default: 30,
    deployValue: null,
    value: 21,
    source: "runtime",
    forcedOff: false,
    stored: {
      value: 21,
      valid: true,
      updatedAt: 1_790_000_000,
      updatedBy: "ops@x.io",
    },
    version: 3,
    confirm: { raise: "L0", lower: "L1" },
    ...over,
  };
}

function view(over: Record<string, unknown> = {}) {
  return {
    settings: [
      lazyDeltas(),
      keyEntryCeiling(),
      mediaQuota(),
      maxBytes(),
      gcMode(),
      grace(),
      cloudSyncDefault(),
      cloudSyncPause(),
      reservedTerms(),
    ],
    storeAvailable: true,
    propagationSeconds: 30,
    deployTime: [
      { name: "PKEY_ENVIRONMENT", area: "deployment", value: "prod" },
      { name: "PLATFORM_ADMIN_GROUP", area: "identity", value: "pk-admins" },
      { name: "ADMIN_OIDC_ISSUER", area: "identity", value: null },
      { name: "ADMIN_OIDC_CLIENT_ID", area: "identity", value: null },
      {
        name: "PLATFORM_OIDC_ISSUER",
        area: "identity",
        value: "https://login.example.com",
      },
      {
        name: "PLATFORM_OIDC_CLIENT_ID",
        area: "identity",
        value: "console-client",
      },
      {
        name: "OIDC_ISSUER_ALLOWLIST",
        area: "identity",
        value: ["auth.acme.dev", "id.example.org"],
      },
      {
        name: "BLOB_ORIGIN",
        area: "delivery",
        value: "https://dl.example.com",
      },
      {
        name: "CONSOLE_ORIGIN",
        area: "delivery",
        value: "https://pk.example.com",
      },
      { name: "BLOBS_BUCKET_NAME", area: "delivery", value: "pk-blobs" },
      { name: "R2_ACCOUNT_ID", area: "delivery", value: null },
      { name: "GITHUB_APP_ID", area: "delivery", value: "12345" },
      { name: "PORTAL_EMAIL_FROM", area: "email", value: null },
      { name: "PLATFORM_KEK_ACTIVE", area: "keyring", value: "kek-2" },
      { name: "PLATFORM_KEK_ID", area: "keyring", value: null },
    ],
    secrets: [
      { name: "PLATFORM_KEK", set: false },
      { name: "PLATFORM_KEK_KEYS", set: true },
      { name: "KEY_HASH_PEPPER", set: true },
      { name: "ADMIN_SESSION_SECRET", set: true },
      { name: "PORTAL_SESSION_SECRET", set: false },
      { name: "R2_PARENT_ACCESS_KEY_ID", set: false },
    ],
    constants: [
      {
        name: "ADMIN_SESSION_TTL_SECONDS",
        area: "sessions",
        value: 28_800,
        unit: "seconds",
      },
      {
        name: "AUDIT_RETENTION_SECONDS",
        area: "retention",
        value: 15_552_000,
        unit: "seconds",
      },
      {
        name: "LAZY_DELTA_MAX_BYTES_CEILING",
        area: "lazy-deltas",
        value: 33_554_432,
        unit: "bytes",
      },
    ],
    warnings: [
      {
        code: "console_oidc_shared",
        message:
          "The console signs in through the shared platform identity-provider client, the one customers use.",
        names: ["ADMIN_OIDC_ISSUER", "ADMIN_OIDC_CLIENT_ID"],
      },
      {
        code: "portal_session_secret_unset",
        message:
          "PORTAL_SESSION_SECRET is not set, so customer portal sessions cannot be signed.",
        names: ["PORTAL_SESSION_SECRET"],
      },
    ],
    ...over,
  };
}

const KEK = {
  ok: true,
  active: "kek-2",
  kids: ["kek-1", "kek-2"],
  counts: {
    keys: { "kek-2": 3, "kek-1": 1 },
    secrets: { "kek-2": 5 },
    managed: {},
  },
  remaining: 1,
  unopenable: 0,
  countsComplete: true,
  countsTruncated: [],
};

const HISTORY = {
  items: [
    {
      id: "pa2",
      at: 1_790_000_100,
      actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
      action: "platform.setting.set",
      target: { kind: "setting", id: "BLOB_GC_GRACE_DAYS" },
      summary: "Set BLOB_GC_GRACE_DAYS to 21",
      before: { stored: null, version: 0, effective: 30, source: "default" },
      after: { stored: 21, version: 1, effective: 21, source: "runtime" },
    },
    {
      id: "pa1",
      at: 1_790_000_000,
      actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
      action: "kek.reseal",
      target: { kind: "kek", id: "kek-2" },
      summary: "Re-sealed 12 value(s) under KEK kek-2 (0 remaining)",
      before: null,
      after: null,
    },
  ],
  nextCursor: null,
};

// ── Release → Compatibility (test/compatibility.test.tsx) ────────────────────────────────
const FOES = "diceroll.foes";
const SKINS = "diceroll.skins";

const COMPAT: CompatResponse = {
  channels: ["stable", "beta"],
  liveLevels: { stable: [3, 4] },
  levels: [3, 4],
  limit: 10,
  offset: 0,
  capped: false,
  older: { appReleases: 3, packReleases: 0 },
  packs: [
    { id: FOES, binding: "compatible", required: true, delivery: "essential" },
    { id: SKINS, binding: "pinned", required: false, delivery: "on-demand" },
  ],
  appReleases: [
    {
      releaseId: "app@1.5.0",
      version: "1.5.0",
      seq: 15,
      channel: "stable",
      contentApi: 4,
      live: true,
      liveOn: ["stable"],
      yanked: null,
      platforms: ["android", "ios"],
      engines: [""],
      pins: [{ pack: SKINS, releaseId: "skins@1.0.0" }],
      holds: [],
      unsatisfied: [
        {
          pack: FOES,
          reason: "content-floor",
          detail:
            "no release of diceroll.foes on stable is at or above the floor 2.1.0",
          channel: "stable",
          platform: "android",
          engine: "",
          variant: "",
        },
      ],
    },
    {
      releaseId: "app@1.4.0",
      version: "1.4.0",
      seq: 14,
      channel: "stable",
      contentApi: 3,
      live: true,
      liveOn: ["stable"],
      yanked: null,
      platforms: ["ios"],
      engines: [""],
      pins: [],
      holds: [{ pack: FOES, releaseId: "foes@1.0.0" }],
      unsatisfied: [],
    },
  ],
  packReleases: [
    {
      pack: FOES,
      releaseId: "foes@2.0.0",
      version: "2.0.0",
      seq: 3,
      sha256: sha(200),
      channel: "stable",
      requires: { contentApi: [">=4"], engines: [] },
      yanked: null,
      revoked: null,
      current: true,
    },
    {
      pack: FOES,
      releaseId: "foes@1.0.1",
      version: "1.0.1",
      seq: 2,
      sha256: sha(101),
      channel: "stable",
      requires: { contentApi: [">=3 <4"], engines: [] },
      yanked: { reason: "revoked", at: 1_720_000_000, by: "ci:k1" },
      revoked: {
        kind: "record",
        recordSha256: sha(900),
        reason: "Exploit in spawn tables",
        issuedAt: 1_720_000_000,
        replacement: null,
      },
      current: false,
    },
    {
      pack: FOES,
      releaseId: "foes@1.0.0",
      version: "1.0.0",
      seq: 1,
      sha256: sha(100),
      channel: "stable",
      requires: { contentApi: [">=3 <4"], engines: [] },
      yanked: null,
      revoked: null,
      current: true,
    },
    {
      pack: SKINS,
      releaseId: "skins@1.0.0",
      version: "1.0.0",
      seq: 1,
      sha256: sha(300),
      channel: "stable",
      requires: { contentApi: [], engines: [] },
      yanked: null,
      revoked: null,
      current: false,
    },
  ],
  cells: [
    cell(
      "app@1.5.0",
      "foes@2.0.0",
      "compatible",
      true,
      "contentApi >=4 holds level 4",
    ),
    cell(
      "app@1.5.0",
      "foes@1.0.1",
      "revoked",
      false,
      "revoked (Exploit)",
      true,
    ),
    cell(
      "app@1.5.0",
      "foes@1.0.0",
      "incompatible",
      false,
      "contentApi >=3 <4 excludes level 4",
    ),
    cell(
      "app@1.5.0",
      "skins@1.0.0",
      "pinned",
      false,
      "the app release pins it",
    ),
    cell(
      "app@1.4.0",
      "foes@2.0.0",
      "incompatible",
      false,
      "contentApi >=4 excludes level 3",
    ),
    cell(
      "app@1.4.0",
      "foes@1.0.1",
      "revoked",
      false,
      "revoked (Exploit)",
      true,
    ),
    cell("app@1.4.0", "foes@1.0.0", "held", true, "the app release holds it"),
    cell("app@1.4.0", "skins@1.0.0", "incompatible", false, "pinned binding"),
  ],
  hidden: { appReleases: 3, packReleases: 0 },
  resolvedAt: 1_720_000_000,
};

// ── Release → Deliverables, a pack record, Content keys (test/packViews.test.tsx) ─────────
const CORE = "diceroll.core3d";
const MUSIC = "diceroll.music";
const CORE_14 = sha(140);
const LIST: DeliverablesResponse = {
  gateKnown: true,
  deliverables: [
    {
      id: "app",
      kind: "app",
      type: null,
      declared: true,
      binding: null,
      required: null,
      baseline: null,
      delivery: null,
      variantKeys: [],
      assertedEntitlement: null,
      gate: null,
      latest: {
        releaseId: "app@1.5.0",
        version: "1.5.0",
        seq: 15,
        publishedAt: 1_720_000_000,
        yanked: false,
        entitlement: null,
      },
      releaseCount: 3,
      pinnedByAppReleases: null,
    },
    {
      id: CORE,
      kind: "pack",
      type: "godot.pck",
      declared: true,
      binding: "pinned",
      required: true,
      baseline: "embedded",
      delivery: "essential",
      variantKeys: ["texture=etc2", "texture=s3tc"],
      assertedEntitlement: null,
      gate: "vip",
      latest: {
        releaseId: `${CORE}@1.4.0`,
        version: "1.4.0",
        seq: 12,
        publishedAt: 1_719_000_000,
        yanked: true,
        entitlement: null,
      },
      releaseCount: 2,
      pinnedByAppReleases: 2,
    },
    {
      id: MUSIC,
      kind: "pack",
      type: "files.tree",
      declared: true,
      binding: "pinned",
      required: false,
      baseline: "none",
      delivery: "on-demand",
      variantKeys: [""],
      assertedEntitlement: null,
      gate: null,
      latest: null,
      releaseCount: 0,
      pinnedByAppReleases: 0,
    },
  ],
};

const RELEASES: PackReleasesResponse = {
  deliverable: CORE,
  releases: [
    {
      releaseId: `${CORE}@1.4.0`,
      version: "1.4.0",
      seq: 12,
      channel: "stable",
      publishedAt: 1_719_000_000,
      yank: { reason: "broken mounts", at: 1_719_500_000, by: "admin:u1" },
      recordSha256: CORE_14,
      formatVersion: 1,
      entitlement: null,
      signer: {
        kind: "delegated",
        delegation: sha(900),
        scope: "diceroll",
        seq: 2,
      },
      variants: [
        {
          variantKey: "texture=s3tc",
          variant: { texture: "s3tc" },
          engine: "godot-4.7",
          payload: { size: 3 * 1024 * 1024, sha256: sha(1) },
          fullBytes: 2 * 1024 * 1024,
          indexBytes: 900,
          deltas: [
            {
              scope: "payload",
              method: "zstd-patch-from",
              from: sha(2),
              fromVersion: "1.0.0",
              bytes: 40 * 1024,
              memBytes: 6 * 1024 * 1024,
            },
          ],
        },
      ],
      pinnedBy: [
        {
          appReleaseId: "app@1.5.0",
          appVersion: "1.5.0",
          appYank: null,
          required: true,
          delivery: "essential",
          recordSha256: CORE_14,
        },
        {
          appReleaseId: "app@1.4.1",
          appVersion: "1.4.1",
          appYank: { reason: "crash", at: 1_719_600_000, by: "admin:u1" },
          required: true,
          delivery: "essential",
          recordSha256: CORE_14,
        },
      ],
    },
    {
      releaseId: `${CORE}@1.0.0`,
      version: "1.0.0",
      seq: 1,
      channel: "stable",
      publishedAt: 1_710_000_000,
      yank: null,
      recordSha256: sha(100),
      formatVersion: 1,
      entitlement: null,
      signer: { kind: "release", kid: "diceroll-release-2026" },
      variants: [],
      pinnedBy: [],
    },
  ],
};

const FILES: PackFilesResponse = {
  deliverable: CORE,
  releaseId: `${CORE}@1.4.0`,
  variant: "texture=s3tc",
  total: 3,
  files: [
    {
      path: "assets/core/a.bin",
      size: 100,
      sha256: sha(7),
      offset: 10,
      blob: { sha256: sha(7), bytes: 100, codec: "none" },
    },
    {
      path: "assets/core/b.bin",
      size: 50,
      sha256: sha(8),
      offset: 120,
      blob: { sha256: sha(8), bytes: 50, codec: "none" },
    },
    {
      path: "readme.txt",
      size: 5,
      sha256: sha(9),
      offset: 170,
      blob: { sha256: sha(9), bytes: 5, codec: "none" },
    },
  ],
};
const KEYS: DelegationsResponse = {
  delegations: [
    {
      sha256: sha(900),
      scope: "diceroll.events",
      types: ["files.tree", "godot.pck"],
      effectiveTypes: ["files.tree"],
      seq: 2,
      issuedAt: 1_719_000_000,
      expiresAt: 4_102_444_800,
      status: "active",
      origin: "submit",
      signedBy: "diceroll-release-2026",
      keyFingerprint: "ab".repeat(32),
      releaseCount: 3,
      revocation: null,
    },
    {
      sha256: sha(901),
      scope: "diceroll.l10n",
      types: ["l10n.table"],
      effectiveTypes: ["l10n.table"],
      seq: 1,
      issuedAt: 1_700_000_000,
      expiresAt: 1_710_000_000,
      status: "revoked",
      origin: "submit",
      signedBy: "diceroll-release-2026",
      keyFingerprint: "cd".repeat(32),
      releaseCount: 0,
      revocation: {
        sha256: sha(902),
        kid: "diceroll-release-2026",
        reason: "key leaked",
        issuedAt: 1_705_000_000,
      },
    },
  ],
};

// ── License, tiers, profiles, catalog: fuller than the unit suites (tens of rows, long names) ─

const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const PEOPLE = [
  "Ada Lovelace",
  "Grace Hopper",
  "Katherine Johnson",
  "Margaret Hamilton",
  "Hedy Lamarr",
  "Radia Perlman",
  "Frances Allen",
  "Barbara Liskov",
  "Annie Easley",
  "Joan Clarke",
  "Mary Jackson",
  "Dorothy Vaughan",
];
const TIER_IDS = ["pro", "edu", "studio-enterprise-annual", null];

/** 240 licenses: past DataTable's 200-row line, so the virtualized path is linted too. */
export const LICENSES = Array.from({ length: 240 }, (_, i) => ({
  id: `lic_${i + 1}`,
  name:
    i === 2
      ? "Northwind Broadcast Studios — Site licence for the Glasgow, Leeds and Bristol facilities"
      : `${PEOPLE[i % PEOPLE.length]}${i >= PEOPLE.length ? ` ${Math.floor(i / PEOPLE.length) + 1}` : ""}`,
  email:
    i === 5
      ? "procurement.and.licensing.department@northwind-broadcast-studios.example.co.uk"
      : `${PEOPLE[i % PEOPLE.length]!.split(" ")[0]!.toLowerCase()}${i}@example.com`,
  status: i % 9 === 4 ? "disabled" : "active",
  activatedAt: NOW_S - (200 - i * 3) * DAY,
  expiresAt:
    i % 7 === 0 ? null : i % 5 === 1 ? NOW_S + 4 * DAY : NOW_S + (90 + i) * DAY,
  keyCount: 1 + (i % 3),
  activeKeyCount: 1 + (i % 2),
  // lic_1 lists four live devices in its detail; the count agrees.
  deviceCount: i === 0 ? 4 : i % 6,
  profile: null,
  profiles: i % 4 === 0 ? ["base", "studio"] : [],
  tier: TIER_IDS[i % TIER_IDS.length],
  channels: i % 3 === 0 ? ["stable", "beta"] : ["stable"],
  minVersion: null,
  maxVersion: null,
  identityProvider: i % 4 === 1 ? "oidc" : "manual",
  modifiedBy: "u1",
  modifiedAt: NOW_S - i * 3600,
  // LX-30: every holder state; every tenth licence is a floating key of one of two batches.
  ...(i % 10 === 9
    ? {
        name: "",
        email: "",
        holder: { kind: "floating" },
        ownerSubject: null,
        batchId: i % 20 === 9 ? "batch_oct" : "batch_long",
        keyEntries: { used: i % 4, limit: 10 },
      }
    : i % 3 === 2
      ? {
          holder: { kind: "assigned", inAccount: false },
          ownerSubject: null,
          batchId: null,
          keyEntries: { used: 0, limit: 10 },
        }
      : {
          holder: { kind: "assigned", inAccount: true },
          ownerSubject: "ps_Xq3v9TbN2kLm8PwRz1YcAa",
          batchId: null,
          keyEntries: null,
        }),
})).map(workerFields);

/** LX-30: two batches, one with a label at the 80-character limit. */
export const BATCHES = [
  {
    id: "batch_oct",
    label: "Steam keys, October",
    count: 50,
    tier: "pro",
    createdBy: "u1",
    createdAt: NOW_S - 5 * DAY,
    used: 12,
    unused: 37,
    disabled: 1,
  },
  {
    id: "batch_long",
    label:
      "Humble Bundle — Northwind audio tools, spring promotion keys for EU resellers",
    count: 500,
    tier: "studio-enterprise-annual",
    createdBy: "ops@northwind-broadcast-studios.example.co.uk",
    createdAt: NOW_S - 40 * DAY,
    used: 498,
    unused: 0,
    disabled: 2,
  },
];

export const TIERS = [
  {
    id: "pro",
    label: "Pro",
    profile: "base",
    policyExpiryDays: 365,
    policyDeviceLimit: 5,
    channels: ["stable"],
    minVersion: "1.0.0",
    maxVersion: null,
  },
  {
    id: "edu",
    label: "Education",
    profile: null,
    policyExpiryDays: 180,
    policyDeviceLimit: 1,
    channels: [],
    minVersion: null,
    maxVersion: null,
  },
  {
    id: "studio-enterprise-annual",
    label: "Studio Enterprise (annual, multi-site, priority support)",
    profile: "studio",
    policyExpiryDays: 365,
    policyDeviceLimit: 250,
    channels: ["stable", "beta"],
    minVersion: "2.0.0",
    maxVersion: "3.0.0",
  },
  {
    id: "trial",
    label: "Trial",
    profile: null,
    policyExpiryDays: 14,
    policyDeviceLimit: 1,
    channels: [],
    minVersion: null,
    maxVersion: null,
  },
];

export const CATALOG = {
  schemaVersion: 8,
  entries: [
    {
      key: "network.timeout",
      kind: "config",
      category: "Network",
      label: "Timeout",
      description: "Request timeout in seconds.",
      schema: { type: "integer", minimum: 1, maximum: 120 },
      default: 30,
    },
    {
      key: "network.endpoint",
      kind: "config",
      category: "Network",
      label: "API endpoint",
      description: "Base URL the app talks to.",
      schema: { type: "string", format: "uri" },
      default: "https://api.djdl.example.com/v2",
    },
    {
      key: "ui.theme",
      kind: "config",
      category: "Appearance",
      label: "Theme",
      description: "UI theme",
      schema: { type: "string", enum: ["dark", "light", "system"] },
      default: "system",
    },
    {
      key: "audio.analysis.waveform.resolution.samples_per_pixel",
      kind: "config",
      category: "Audio",
      label:
        "Waveform resolution (samples per pixel at the default zoom level)",
      description:
        "How many audio samples one pixel of the overview waveform summarises. Lower is sharper and slower.",
      schema: { type: "integer", minimum: 32, maximum: 4096 },
      default: 256,
    },
    {
      key: "api.token",
      kind: "secret",
      category: "Secrets",
      label: "API token",
      description: "Upstream API token.",
      schema: { type: "string" },
    },
    {
      key: "applemusic.token",
      kind: "secret",
      delivery: "edgeMint",
      category: "Secrets",
      label: "Apple Music token",
      description: "Signed on request.",
      schema: { type: "string" },
    },
    {
      key: "license.hd",
      kind: "flag",
      category: "Content",
      label: "HD exports",
      description: "Unlocks HD exports.",
      schema: { type: "boolean" },
    },
    {
      key: "flag.pro",
      kind: "flag",
      category: "Entitlements",
      label: "Pro features",
      description: "Unlocks pro features.",
      schema: { type: "boolean" },
    },
    ...Array.from({ length: 18 }, (_, i) => ({
      key: `feature.f${i + 1}`,
      kind: i % 3 === 0 ? "flag" : "config",
      category: ["General", "Library", "Sync"][i % 3],
      label: `Feature ${i + 1}`,
      description: "",
      schema:
        i % 3 === 0
          ? { type: "boolean" }
          : i % 3 === 1
            ? { type: "string" }
            : { type: "integer" },
      default: i % 3 === 0 ? undefined : i % 3 === 1 ? "standard" : i * 10,
    })),
  ],
};

export const PROFILES = [
  {
    id: "base",
    name: "Base",
    description: "Baseline config for Pro licenses.",
    modifiedBy: "ada@example.com",
    modifiedAt: NOW_S - 3 * DAY,
    usedBy: { tiers: 1, licenses: 9 },
  },
  {
    id: "studio",
    name: "Studio — broadcast facilities with the extended audio-analysis pipeline",
    description: "",
    modifiedBy: "grace@example.com",
    modifiedAt: NOW_S - 30 * DAY,
    usedBy: { tiers: 1, licenses: 9 },
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`,
    name: `Profile ${i + 1}`,
    usedBy: { tiers: 0, licenses: i },
  })),
];

export const PROFILE = {
  id: "base",
  name: "Base",
  description: "Baseline config for Pro licenses.",
  modifiedBy: "ada@example.com",
  modifiedAt: NOW_S - 3 * DAY,
  payload: {
    config: {
      "network.timeout": { value: 45, state: "enforced", updatedAt: NOW_S },
      "ui.theme": { value: "dark", state: "default", updatedAt: NOW_S },
    },
    secrets: {
      "api.token": { state: "enforced", configured: true, updatedAt: NOW_S },
    },
    entitlements: {
      "flag.pro": { value: true, state: "enforced", updatedAt: NOW_S },
    },
  },
  usedBy: {
    tiers: [{ id: "pro", label: "Pro" }],
    licenses: LICENSES.slice(0, 9).map((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
    })),
  },
};

export const LICENSE_DETAIL = {
  ...LICENSES[0],
  // Waiting for its holder: the Config tab's notice below is the no-account callout, so the
  // holder has no account either (a licence in an account would not show it).
  holder: { kind: "assigned", inAccount: false },
  ownerSubject: null,
  keyEntries: { used: 0, limit: 10 },
  maxOfflineDays: 14,
  profiles: ["base", "studio"],
  overrides: {
    config: {
      "network.timeout": { state: "default", value: 30, updatedAt: NOW_S },
    },
    secrets: {
      "api.token": { state: "enforced", configured: true, updatedAt: NOW_S },
    },
    entitlements: {
      "flag.pro": { state: "hidden", value: true, updatedAt: NOW_S },
    },
  },
  // U-27: the Config tab's widest callout (no account, with the sign-up link to offer), over the
  // full editor.
  configOverrides: {
    owned: false,
    ownerSubject: null,
    signUpUrl: "https://keys.example.com/activate?product=djdl",
  },
  keys: Array.from({ length: 4 }, (_, i) => ({
    hash: `${"abcdef0123456789".repeat(2)}${i}`,
    status: i === 3 ? "revoked" : "active",
    label: ["laptop", "studio rack", "", "old"][i],
    createdAt: NOW_S - (10 + i * 20) * DAY,
    createdBy: i % 2 ? "ops@example.com" : "u1",
  })),
  devices: Array.from({ length: 5 }, (_, i) => ({
    deviceId: `dev_${String(i + 1).padStart(28, "0")}`,
    label: ["Studio Mac", "Booth PC", "", "Stage iPad", "Old laptop"][i],
    status: i === 4 ? "deauthorized" : "authorized",
    firstSeen: NOW_S - (40 - i) * DAY,
    lastSeen: NOW_S - i * 3600,
    platform: ["macos", "windows", "linux", "ios", "windows"][i],
    fingerprint:
      i === 4
        ? null
        : {
            status: "verified",
            hwid: "BgNwYHns5OhG",
            components: {},
            componentCount: 2,
            firstSeen: NOW_S - 20 * DAY,
            lastSeen: NOW_S,
          },
  })),
};

/** CX-LREC's holder variants: lic_3 is a Waiting license (invited, no account yet), lic_10 a
 *  Floating one ("anyone with the key", in key batch batch_oct). Same shape as lic_1. */
export const LICENSE_DETAIL_WAITING = {
  ...LICENSE_DETAIL,
  ...LICENSES[2],
};
export const LICENSE_DETAIL_FLOATING = {
  ...LICENSE_DETAIL,
  ...LICENSES[9],
};

// ── The route table this file contributes ────────────────────────────────────────────────────

const PROD = "/manage/api/products/djdl";

// PS-06: the Polaris Key storefront: its hub tile, its panel and the 28-day card.
const firstParty = (op: string) => ({
  mode: "first-party",
  plane: "worker",
  handler: `polaris-key.${op}`,
});

// B-217: a connected store with a long label and long details, so the Add to storefronts flow
// (prerequisites, assets, run) has rows to wrap at 200 % zoom.
const PLAY_STEP = (id: string, phase: string, label: string) => ({
  id,
  ops: [id],
  phase,
  label,
  mode: "api",
  typed: false,
  state: "todo",
  stateAt: null,
  writes: [
    "PATCH listings/en-US with a long path that must wrap in a narrow column",
  ],
  link: null,
  ci: null,
  pr: null,
  run: {
    method: "POST",
    path: `${PROD}/distribution/storefronts/google-play/steps/${id}`,
    body: {},
    fields: [],
    confirm: "plain",
    verb: "Send the listing text and every locale to the store",
    consequences: ["Every locale's text is replaced."],
  },
  assert: null,
  next: null,
  handoff: null,
  copy: [],
  detail: "Replaces the text of every locale on the store's listing page.",
  blockedBy: null,
});
const PLAY_STORE = {
  id: "google-play",
  label: "Google Play Console",
  listingStore: "play",
  connection: {
    state: "connected",
    credential: "google-play.service-account",
    credentialLabel: "Google Play service account",
    source: "console",
    lastError: null,
  },
  app: { id: "gg.djdl.app", name: "DJDL" },
  // A-28.4: one identifier from the manifest, one filled from the assignment.
  identifiers: {
    packageName: { value: "gg.djdl.app", source: "assigned" },
    developerId: { value: "4976543210987654321", source: "manifest" },
  },
  outlets: ["android"],
  readOnly: null,
  capabilities: [
    {
      op: "writeListingText",
      label: "Listing text",
      support: { mode: "api", plane: "worker", rules: [] },
    },
  ],
  prerequisites: [
    {
      id: "connection",
      label: "Team connection",
      state: "met",
      detail: "Stored.",
      page: "platform-stores",
    },
    {
      id: "permissions",
      label: "Write permissions on the listing and the release tracks",
      state: "unknown",
      detail: "Confirmed by the first write to the store, not before it.",
      page: null,
    },
  ],
  steps: [
    PLAY_STEP("writeListingText", "listing", "Send the listing text"),
    PLAY_STEP("submit", "submit", "Send for review"),
  ],
  pushListing: null,
  confirmationLabel: "Google Play Console",
};

const POLARIS_KEY_ROUTES: Record<string, unknown> = {
  // A-27.11: the listing editor's model (Settings -> Presentation -> Listing); an override on Play.
  [`${PROD}/distribution/listing`]: {
    listing: {
      app: { defaultLocale: "en-US", name: "DJDL", developerName: "DJDL Ltd" },
      source: "admin",
      provenance: {},
      modifiedAt: 1,
      modifiedBy: "u1",
    },
    locales: [
      {
        locale: "en-US",
        name: "DJDL",
        subtitle: "Mix anywhere, live or on air",
        description: "Two-deck DJ mixer.",
        source: "admin",
        provenance: {},
        modifiedAt: 1,
        modifiedBy: "u1",
      },
    ],
    overrides: [
      {
        store: "play",
        locale: "en-US",
        field: "subtitle",
        value: "Two-deck DJ mixer",
      },
    ],
    limits: { name: 30, subtitle: 30 },
    stores: [{ store: "play", label: "Google Play Console" }],
    overrideStores: ["play"],
    modelFields: ["name", "subtitle", "description"],
  },
  // The Listing step of the Add to storefronts flow: the fit report, one store with a warning.
  [`${PROD}/distribution/listing/fit`]: {
    exists: true,
    release: null,
    stores: [
      {
        store: "play",
        label: "Google Play Console",
        status: "amber",
        issues: [
          {
            store: "play",
            field: "description",
            from: "locales.en-US.description",
            locale: "en-US",
            issue: "over_limit",
            severity: "warn",
            limit: 4000,
            actual: 4120,
            unit: "characters",
          },
        ],
        cells: [
          {
            field: "description",
            from: "locales.en-US.description",
            locale: "en-US",
            plane: "api",
            status: "amber",
            present: true,
          },
        ],
      },
    ],
  },
  [`${PROD}/distribution/storefronts/slots`]: {
    slots: [
      {
        slot: "key-art",
        locale: null,
        group: "masters",
        kind: "human",
        state: "missing",
        spec: "16:9, at least 3840×2160, no logo or text, with a long note that wraps",
        textAllowed: "none",
        asset: null,
      },
    ],
  },
  [`${PROD}/distribution/storefronts`]: {
    listing: { name: "DJDL", defaultLocale: "en-US", locales: ["en-US"] },
    stores: [
      PLAY_STORE,
      {
        id: "polaris-key",
        label: "Polaris Locker",
        builtIn: true,
        listingStore: "polaris-key",
        connection: {
          state: "keyless",
          credential: null,
          credentialLabel: null,
          source: null,
          lastError: null,
        },
        app: null,
        outlets: [],
        readOnly: null,
        capabilities: [
          ["identifiers", "Identifiers"],
          ["readListing", "Listing import"],
          ["writeListingText", "Listing text"],
          ["writeListingAssets", "Listing images"],
          ["category", "Category"],
          ["submit", "Submit for review"],
        ]
          .map(([op, label]) => ({ op, label, support: firstParty(op!) }))
          .concat([
            {
              op: "pricing",
              label: "Price and availability",
              support: {
                mode: "unsupported",
                reason: "Listed products are obtained without payment",
              } as never,
            },
          ]),
        prerequisites: [],
        steps: [],
        pushListing: null,
        confirmationLabel: "Polaris Locker",
      },
    ],
  },
  [`${PROD}/storefronts/polaris-key`]: {
    enabled: true,
    portalEnabled: true,
    listing: {
      listed: "listed",
      audience: "eligible",
      offerPaths: null,
      groupLabels: { "aperture-beta": "Aperture Seven" },
    },
    available: ["group", "auto_issue", "open"],
    active: ["group", "auto_issue", "open"],
    everyone: false,
    identityEligible: true,
    directDownload: false,
    licenseEnabled: true,
    groups: [
      { group: "aperture-beta", tier: "beta", label: "Aperture Seven" },
      {
        group: "aperture-crew-with-a-long-group-name",
        tier: null,
        label: null,
      },
    ],
    autoIssue: { tier: "free", tierLabel: "Free", expiryDays: 14 },
    readiness: [
      {
        id: "portal",
        state: "pass",
        reason: "Polaris Locker is on for this product",
      },
      {
        id: "listing",
        state: "fail",
        reason:
          "The listing needs a name and a short description that fit Polaris Locker's limits",
      },
      {
        id: "obtain-path",
        state: "pass",
        reason: "People can add it through 3 obtain paths",
      },
      {
        id: "get-it",
        state: "warn",
        reason:
          "Get it opens the developer's website: there is no download or store link",
      },
      {
        id: "licence-tier",
        state: "pass",
        reason: "Every tier a path issues exists and has a device limit",
      },
    ],
  },
  [`${PROD}/storefronts/polaris-key/analytics`]: {
    from: "2026-09-09",
    to: "2026-10-06",
    days: 28,
    totals: { impressions: 12_480, adds: 1_204, activations: 812 },
    byKind: [
      { kind: "group", impressions: 4_100, adds: 520, activations: 401 },
      { kind: "auto_issue", impressions: 7_900, adds: 684, activations: 411 },
      { kind: "link", impressions: 480, adds: 0, activations: 0 },
    ],
    daily: Array.from({ length: 28 }, (_, i) => ({
      day: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
      impressions: 300 + ((i * 37) % 200),
      adds: 30 + ((i * 7) % 20),
      activations: 20 + ((i * 5) % 15),
    })),
    impressionsCounted: true,
  },
};

export const DATA_ROUTES: Record<string, unknown> = {
  ...POLARIS_KEY_ROUTES,
  // CM-29: Commerce's overview read.
  [`${PROD}/commerce`]: {
    licenseEnabled: true,
    // A-28: derived (App Store), typed and differing (Google Play), no app (Steam).
    identity: {
      "app-store": {
        value: "com.djdl.app",
        source: "assigned",
        assigned: "com.djdl.app",
        mismatch: false,
        ambiguous: false,
      },
      play: {
        value: "gg.djdl.typo.with.a.long.package.name",
        source: "typed",
        assigned: "gg.djdl.app",
        mismatch: true,
        ambiguous: false,
      },
      steam: {
        value: null,
        source: null,
        assigned: null,
        mismatch: false,
        ambiguous: false,
      },
    },
    setup: {
      "app-store": { configured: true, credential: "cred_asc", reason: null },
      play: { configured: true, credential: "cred_play", reason: null },
      steam: { configured: false, credential: null, reason: "no_app_assigned" },
    },
    products: [
      {
        store: "app-store",
        productId: "com.djdl.app.pro",
        deliverable: "app",
        flag: "pro",
      },
    ],
    purchases: [
      {
        store: "app-store",
        purchase: "a1b2c3d4e5f60718",
        storeProductId: "com.djdl.app.pro",
        licenseId: "lic_1",
        state: "active",
        environment: "Production",
        firstSeen: GENERATED - 90000,
        lastVerified: GENERATED - 3600,
      },
      {
        store: "app-store",
        purchase: "b1b2c3d4e5f60719",
        storeProductId:
          "com.djdl.app.pro.with.a.very.long.identifier.for.wrapping",
        licenseId: "lic_2",
        state: "revoked",
        environment: "Sandbox",
        firstSeen: GENERATED - 900000,
        lastVerified: GENERATED - 90000,
      },
    ],
    events: [],
  },
  "/manage/api/platform/version": IDENTITY,
  "/manage/api/platform/deployment": deployment({
    deploys: {
      items: Array.from({ length: 14 }, (_, i) =>
        deploy(i, i === 3 ? "failure" : "success"),
      ),
      nextCursor: null,
    },
  }),
  "/manage/api/platform/activity": {
    items: [
      ...HISTORY.items,
      ...Array.from({ length: 16 }, (_, i) => ({
        ...ACTIVITY.items[0],
        id: `pax${i}`,
        at: 1_789_990_000 - i * 3600,
        // ST-51: Platform → Activity reads the union; every third event is a product's.
        ...(i % 3 === 1
          ? {
              product: "djdl",
              action: "release.demote",
              summary: "Demoted 1.8.0 from stable",
            }
          : {}),
      })),
    ],
    nextCursor: null,
  },
  // ST-31.11: Platform → Members. Nine people (a root holder, both admin kinds, a narrowed
  // Product admin, a long name and address) and three invites, one of them for a platform role.
  "/manage/api/members": membersView(),
  // ST-34.12b: what signing Sam Okoye out would stop; one label long enough to wrap.
  "/manage/api/members/mbr_4/sign-out": {
    memberId: "mbr_4",
    tokens: [
      {
        label: "deploy laptop",
        lastUsedAt: 1_789_990_000,
        expiresAt: 1_792_000_000,
      },
      {
        label:
          "release pipeline for the long-named customer integration, staging",
        lastUsedAt: null,
        expiresAt: 1_792_000_000,
      },
    ],
  },
  // ST-31.14: Product → Settings → Members (DJDL): Kenji (you), Lucía (two areas), a long name
  // with a long address and four areas, an invite, and two roles that reach DJDL from above.
  [`${PROD}/members`]: productMembersView(),
  "/manage/api/platform/operations": operations(),
  "/manage/api/platform/settings": view(),
  "/manage/api/platform/settings/identity.keyEntry.limit/reach": {
    kind: "bound",
    direction: "lower",
    total: 14,
    reaches: 4,
    from: 20,
    to: 10,
    products: [
      { product: "djdl", name: "DJDL", from: 20, to: 10, inherited: false },
      {
        product: "northwind",
        name: "Northwind Broadcast Audio Workstation",
        from: 10,
        to: 5,
        inherited: true,
      },
    ],
  },
  "/manage/api/products/kek": KEK,
  [BASE]: { ok: true, stores: STORES },
  [`${BASE}/app-store/apps`]: ASC_APPS,
  [`${BASE}/google-play/apps`]: PLAY_APPS(false),
  [`${BASE}/microsoft-store/apps`]: {
    store: "microsoft-store",
    source: "console",
    fetchedAt: 1_790_000_000,
    cached: false,
    truncated: false,
    apps: [],
  },
  [`${PROD}/release/compat`]: COMPAT,
  [`${PROD}/release/delegations`]: KEYS,
  // The delivery gate form (a pack's Delivery tab): without its modes the Select has no option
  // for the app's mode, the form opens dirty and its save bar stretches the page.
  [`${PROD}/settings/distribution.access`]: {
    // No rows: the app reads `entitled`, failing closed, and no pack has a gate yet.
    setting: {
      key: "distribution.access",
      source: "manifest",
      version: 0,
      value: {},
    },
  },
  [`${PROD}/release/deliverables`]: LIST,
  [`${PROD}/release/deliverables/${CORE}/releases`]: RELEASES,
  [`${PROD}/release/deliverables/${CORE}/releases/${encodeURIComponent(`${CORE}@1.4.0`)}/files`]:
    FILES,
  [`${PROD}/license/licenses`]: {
    licenses: LICENSES,
    // LX-27c.4: the wizard's Delivery step offers an invitation.
    holders: { invitations: true, invitationsOff: null },
  },
  [`${PROD}/license/licenses/lic_1`]: LICENSE_DETAIL,
  [`${PROD}/license/licenses/lic_3`]: LICENSE_DETAIL_WAITING,
  [`${PROD}/license/licenses/lic_10`]: LICENSE_DETAIL_FLOATING,
  // LX-27c.5: a waiting licence the console invited: Resend invitation, the Invitation card.
  [`${PROD}/license/licenses/lic_wait`]: {
    ...LICENSE_DETAIL,
    id: "lic_wait",
    name: "Sam Reyes",
    email: "sam.reyes@example.com",
    holder: {
      kind: "assigned",
      inAccount: false,
      email: "sam.reyes@example.com",
    },
    ownerSubject: null,
    invitedAt: NOW_S - 2 * DAY,
  },
  [`${PROD}/users/licenses/lic_wait/relinks`]: { relinks: [] },
  [`${PROD}/license/tiers`]: { tiers: TIERS },
  [`${PROD}/license/batches`]: { batches: BATCHES, nextCursor: null },
  [`${PROD}/license/batches/batch_oct`]: BATCHES[0],
  [`${PROD}/license/batches/batch_long`]: BATCHES[1],
  [`${PROD}/users/licenses/lic_1/relinks`]: { relinks: [] },
  [`${PROD}/users/licenses/lic_3/relinks`]: { relinks: [] },
  [`${PROD}/users/licenses/lic_10/relinks`]: { relinks: [] },
  [`${PROD}/config/catalog`]: CATALOG,
  [`${PROD}/config/profiles`]: { profiles: PROFILES },
  [`${PROD}/config/profiles/base`]: PROFILE,
  [`${PROD}/config/profiles/studio`]: {
    ...PROFILE,
    id: "studio",
    name: PROFILES[1]!.name,
    description: "",
  },
};

export { CORE as PACK_ID, MUSIC as PACK_ID_EMPTY };
function cell(
  appReleaseId: string,
  packReleaseId: string,
  state: CompatResponse["cells"][number]["state"],
  current: boolean,
  reason: string,
  yanked = false,
): CompatResponse["cells"][number] {
  return { appReleaseId, packReleaseId, state, current, yanked, reason };
}
