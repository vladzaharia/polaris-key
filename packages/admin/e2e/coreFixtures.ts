/**
 * A scripted admin API for the Core pages (Overview, Services, Devices, Keys & secrets,
 * Activity, Settings): enough data that every section has something to draw. Used by
 * `core.e2e.test.ts`.
 */

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const services = Object.fromEntries(
  ["license", "config", "release", "distribution", "update", "identity"].map(
    (s) => [s, { enabled: true }],
  ),
);

const PUB = "MCowBQYDK2VwAyEAq3Jd9QpX2a7mUf0bWzYbXl4tQ8nV1cR6sE5yH2kP9uA";

const product = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "djdl-2026-a1",
  releaseSource: "github",
  signing: { kid: "djdl-2026-a1", alg: "Ed25519", publicKey: PUB },
  jwksUrl: "/djdl/.well-known/jwks.json",
  compatMin: "2.0.0",
  compatMax: "3.0.0",
  defaultMaxOfflineDays: 30,
  defaultDeviceLimit: 5,
  adminGroup: "djdl-admins",
  createdAt: NOW - 200 * DAY,
  modifiedAt: NOW - DAY,
  services,
  registration: null,
  effectiveRegistration: "requires-license",
  servicesSource: "manifest",
  setup: {
    status: "needs-attention",
    healthy: false,
    missing: ["OIDC_CLIENT_SECRET"],
    warnings: [],
    requiredSecrets: ["OIDC_CLIENT_SECRET", "EDGE_MINT__DJDL__STUDIO"],
    missingSecrets: ["OIDC_CLIENT_SECRET"],
    secrets: [
      {
        name: "EDGE_MINT__DJDL__STUDIO",
        configured: true,
        sources: ["Edge mint studio"],
      },
      {
        name: "OIDC_CLIENT_SECRET",
        configured: false,
        sources: ["OIDC client secret"],
      },
    ],
    modules: [
      {
        id: "signing",
        label: "Signing key",
        status: "configured",
        configured: true,
        missing: [],
      },
      {
        id: "release",
        label: "Release",
        status: "configured",
        configured: true,
        missing: [],
      },
      {
        id: "edgeMint",
        label: "Edge mint",
        status: "needs-approval",
        configured: false,
        missing: ["recipe studio awaits approval"],
        pendingApproval: ["studio"],
      },
    ],
    sync: {
      source: "manual",
      status: "ok",
      lastSyncedAt: NOW - 2 * 3600,
      message: null,
    },
    nextActions: [],
  },
  onboarding: {
    baseUrl: "/djdl",
    configUrl: "/djdl/config/document",
    activateUrl: "/djdl/license/activate",
  },
};

/** Pairwise subjects: `ps_` and 22 base64url characters. */
const USER_SUBJECTS = ["A", "B", "C", "D", "E"].map(
  (c) => `ps_${c.repeat(11)}${c.toLowerCase().repeat(11)}`,
);

const devices = Array.from({ length: 6 }, (_, i) => ({
  deviceId: `dev_${String(i + 1).padStart(28, "0")}`,
  label: ["Studio Mac", "Ada's laptop", "Booth PC", "", "Stage iPad", ""][i],
  status: i === 3 ? "deauthorized" : "authorized",
  firstSeen: NOW - (40 - i) * DAY,
  lastSeen: NOW - i * 3600,
  platform: ["macos", "macos", "windows", "linux", "ios", "windows"][i],
  arch: ["arm64", "arm64", "x64", "x64", "arm64", "x64"][i],
  appVersion: "2.4.0",
  sdkName: "node",
  sdkVersion: "1.8.0",
  licenseId: i < 4 ? `lic_${i + 1}` : null,
  seatNo: i < 4 ? 1 : null,
  trustLevel: i === 4 ? "attested" : "basic",
  attestedAt: i === 4 ? NOW - DAY : null,
  lastVerdict:
    i === 4 ? { kind: "app-attest", outcome: "attested", at: NOW - DAY } : null,
}));

const activity = [
  [
    "a1",
    600,
    "u1",
    "Ada Lovelace",
    "schema.publish",
    "product",
    "djdl",
    "Published catalog version 8",
  ],
  [
    "a2",
    1800,
    "u2",
    "Grace Hopper",
    "license.disable",
    "license",
    "lic_2",
    "Chargeback; customer notified",
  ],
  [
    "a3",
    3 * 3600,
    "",
    "",
    "device.fingerprint.drift",
    "device",
    devices[1]!.deviceId,
    "2 of 9 components changed",
  ],
  [
    "a4",
    DAY + 600,
    "u1",
    "Ada Lovelace",
    "key.prepare",
    "key",
    "djdl-2026-b2",
    "Prepared signing key djdl-2026-b2",
  ],
  [
    "a5",
    DAY + 4000,
    "u1",
    "Ada Lovelace",
    "secret.set",
    "secret",
    "EDGE_MINT__DJDL__STUDIO",
    "Set secret EDGE_MINT__DJDL__STUDIO",
  ],
  [
    "a6",
    2 * DAY,
    "u2",
    "Grace Hopper",
    "product.services.update",
    "product",
    "djdl",
    "Enabled services",
  ],
].map(([id, ago, sub, name, action, kind, target, summary]) => ({
  id,
  at: NOW - (ago as number),
  actor: {
    sub,
    name,
    email: sub
      ? `${String(name).split(" ")[0]!.toLowerCase()}@example.com`
      : "",
  },
  action,
  target: { kind, id: target },
  summary,
}));

export const CORE_ROUTES: Record<string, unknown> = {
  "/manage/api/me": {
    sub: "u1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    csrf: "c",
    platformAdmin: true,
    environment: "staging",
    sessionExpiresAt: NOW + 3600,
    products: [
      { slug: "djdl", name: "DJDL", schemaVersion: 2 },
      { slug: "acme", name: "Acme", schemaVersion: 1 },
    ],
  },
  "/manage/api/products": {
    products: [product, { ...product, slug: "acme", name: "Acme" }],
  },
  "/manage/api/products/djdl": { product },
  "/manage/api/products/djdl/services": {
    services,
    registration: null,
    effectiveRegistration: "requires-license",
    source: "manifest",
  },
  "/manage/api/products/djdl/license/licenses": {
    licenses: Array.from({ length: 5 }, (_, i) => ({
      id: `lic_${i + 1}`,
      name: ["Studio Pro", "Club", "Ada", "Booth", "Festival"][i],
      email: "x@example.com",
      status: i === 1 ? "disabled" : "active",
      activatedAt: NOW - 90 * DAY,
      expiresAt: i === 2 ? NOW + 5 * DAY : null,
      keyCount: 1,
      activeKeyCount: 1,
      deviceCount: 1,
      profile: null,
      tier: null,
      channels: ["stable"],
      minVersion: null,
      maxVersion: null,
      identityProvider: "manual",
    })),
  },
  "/manage/api/products/djdl/devices/summary": {
    total: devices.length,
    byStatus: [
      { value: "authorized", count: 5 },
      { value: "deauthorized", count: 1 },
    ],
    licensed: { licensed: 3, licenseFree: 2 },
    byPlatform: [
      { value: "macos", count: 2 },
      { value: "windows", count: 2 },
      { value: "linux", count: 1 },
      { value: "ios", count: 1 },
    ],
    byArch: [],
    bySdkName: [],
    byAppVersion: [],
  },
  "/manage/api/products/djdl/devices": { devices, nextCursor: null },
  // I-12: Core → Users, keyed by pairwise subject.
  "/manage/api/products/djdl/users": {
    identityOn: true,
    users: Array.from({ length: 4 }, (_, i) => ({
      subject: USER_SUBJECTS[i]!,
      createdAt: NOW - (40 - i) * DAY,
      contactEmail: i === 3 ? null : `buyer${i + 1}@example.com`,
      contactSource: i === 3 ? null : i === 2 ? "consented" : "license",
      licenses: i === 3 ? 0 : 1,
      devices: i + 1,
      signedInDevices: i,
      lastSignInAt: i === 0 ? null : NOW - i * DAY,
      mergedFrom: i === 1 ? 1 : 0,
    })),
    nextCursor: null,
  },
  [`/manage/api/products/djdl/users/${USER_SUBJECTS[0]}`]: {
    user: {
      subject: USER_SUBJECTS[0],
      createdAt: NOW - 40 * DAY,
      identityOn: true,
      contact: { email: "buyer1@example.com", source: "license" },
      name: null,
      mergedFrom: [{ subject: USER_SUBJECTS[4], mergedAt: NOW - 3 * DAY }],
      licenses: [
        {
          id: "lic_1",
          name: "Studio Pro",
          email: "buyer1@example.com",
          tierId: null,
          status: "active",
          activatedAt: NOW - 30 * DAY,
          expiresAt: null,
        },
      ],
      devices: [
        {
          deviceId: devices[0]!.deviceId,
          label: "Booth Mac",
          status: "authorized",
          platform: "macos",
          appVersion: "2.4.0",
          licenseId: "lic_1",
          lastSeen: NOW - 3600,
          signedIn: true,
        },
      ],
      data: {
        bytes: 2048,
        stores: [{ name: "config-overrides", bytes: 2048 }],
      },
      signIns: [
        { at: NOW - DAY, method: "steam" },
        { at: NOW - 5 * DAY, method: "email" },
      ],
      events: [],
      relinks: [
        {
          id: "rlk_1",
          licenseId: "lic_1",
          direction: "in",
          otherSubject: USER_SUBJECTS[3],
          reason: "Lost access to the old account (ticket 42)",
          actorName: "Ada",
          createdAt: NOW - 3600,
          undoUntil: NOW + 70 * 3600,
          undoneAt: null,
          undoable: true,
        },
      ],
      audit: [
        {
          id: "a1",
          at: NOW - 3600,
          action: "user.license.relink",
          actorName: "Ada",
          targetKind: "license",
          targetId: "lic_1",
          summary: null,
        },
      ],
    },
  },
  [`/manage/api/products/djdl/devices/${devices[0]!.deviceId}`]: {
    ...devices[0],
    fingerprint: {
      status: "verified",
      hwid: "b3f1c2a49e8d7f6a5b4c3d2e1f0a9b8c",
      components: {
        cpu: "Apple M2 Pro",
        board: "Mac14,10",
        disk: "APPLE SSD AP1024Z",
      },
      componentCount: 3,
      firstSeen: NOW - 40 * DAY,
      lastSeen: NOW,
    },
    facts: {
      os: { name: "macOS", version: "15.1", build: "24B83", kernel: "24.1.0" },
      hardware: {
        cpuModel: "Apple M2 Pro",
        cpuCores: 12,
        ramMb: 32768,
        machineModel: "Mac14,10",
      },
      runtime: { name: "node", version: "22.11.0" },
      locale: "en-GB",
      timezone: "Europe/London",
      probes: {
        rekordbox: { present: true, version: "7.0.4" },
        serato: { present: false },
      },
      updatedAt: NOW,
    },
  },
  "/manage/api/products/djdl/keys": {
    now: NOW,
    keys: [
      {
        kid: "djdl-2026-a1",
        status: "active",
        alg: "Ed25519",
        publicKey: PUB,
        createdAt: NOW - 200 * DAY,
        activateAfter: null,
        activatedAt: NOW - 200 * DAY,
        retiredAt: null,
        revokedAt: null,
      },
      {
        kid: "djdl-2026-b2",
        status: "staged",
        alg: "Ed25519",
        publicKey:
          "MCowBQYDK2VwAyEA7nW2sKq4LmZp9xV0bC3dE6fG8hJ1kN5oR2tU4wY6zA8",
        createdAt: NOW - 60,
        activateAfter: NOW + 240,
        activatedAt: null,
        retiredAt: null,
        revokedAt: null,
      },
      {
        kid: "djdl-2025-z9",
        status: "retired",
        alg: "Ed25519",
        publicKey: "MCowBQYDK2VwAyEAp0Lk8Jh7Gf6Ds5Aq4Wr3Et2Yu1Io9Pz8Xc7Vb6Nm5Q",
        createdAt: NOW - 400 * DAY,
        activateAfter: null,
        activatedAt: null,
        retiredAt: NOW - 200 * DAY,
        revokedAt: null,
      },
    ],
  },
  "/manage/api/products/djdl/secrets": {
    secrets: [
      {
        name: "EDGE_MINT__DJDL__STUDIO",
        configured: true,
        usage: "edge-mint",
        createdAt: NOW - 30 * DAY,
        updatedAt: NOW - 30 * DAY,
        requiredBy: ["Edge mint studio"],
      },
      {
        name: "OIDC_CLIENT_SECRET",
        configured: false,
        usage: null,
        createdAt: null,
        updatedAt: null,
        requiredBy: ["OIDC client secret"],
      },
    ],
  },
  "/manage/api/products/djdl/ci-publisher": {
    ok: true,
    policy: {
      product: "djdl",
      provider: "github",
      repositoryId: 1,
      repositoryOwnerId: 2,
      repository: "vladzaharia/djdl",
      workflow: ".github/workflows/release.yml",
      environment: "production",
      scopes: ["distribution:report", "release:promote", "release:publish"],
      source: "manifest",
      createdAt: NOW - 100 * DAY,
      modifiedAt: NOW - 100 * DAY,
      modifiedBy: null,
    },
  },
  "/manage/api/products/djdl/ci-tokens": {
    ok: true,
    tokens: [
      {
        tokenId: "cit_buildkite",
        kind: "static",
        scopes: ["release:publish"],
        subject: "static:cit_buildkite",
        label: "Buildkite",
        issuedAt: NOW - 10 * DAY,
        expiresAt: NOW + 50 * DAY,
        revokedAt: null,
        createdBy: "u1",
      },
    ],
  },
  "/manage/api/products/djdl/blob-gc": {
    enabled: true,
    graceSeconds: 7 * DAY,
    lockAgeSeconds: 3600,
    skipped: null,
    complete: true,
    liveReleases: 4,
    drops: { packObject: 12, packUpload: 3, truncated: false, listed: [] },
    restores: { count: 0, listed: [] },
    earliestDeletion: NOW + 5 * DAY,
  },
  "/manage/api/products/djdl/activity": { items: activity, nextCursor: null },
  // Enrollment's fingerprint policy (and the probes that ride on it), so the page renders whole.
  "/manage/api/products/djdl/license/policy": {
    policy: {
      enabled: true,
      defaultMode: "normal",
      probes: [
        {
          id: "rekordbox",
          label: "rekordbox",
          macos: "/Applications/rekordbox 7/rekordbox.app",
        },
      ],
    },
    source: "manifest",
  },
  "/manage/api/products/djdl/config/catalog": {
    schemaVersion: 8,
    entries: Array.from({ length: 42 }, (_, i) => ({
      key: `k${i}`,
      kind: "config",
    })),
  },
  "/manage/api/products/djdl/config/profiles": {
    profiles: Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
    })),
  },
  "/manage/api/products/djdl/release/releases": {
    releases: [
      {
        releaseId: "rel_240",
        version: "2.4.0",
        title: null,
        publishedAt: NOW - 3 * DAY,
        sourceUrl: null,
        status: "published",
        artifacts: [],
        deliverable: "app",
        seq: 3,
        channel: "stable",
        yank: null,
        builds: [],
      },
    ],
    channels: [
      { channel: "stable", releaseId: "rel_240", modifiedAt: NOW - 3 * DAY },
    ],
    floors: [],
  },
  "/manage/api/products/djdl/release/health": {
    health: { status: "healthy", healthy: true, missing: [], checks: [] },
  },
  "/manage/api/products/djdl/distribution/rollouts": {
    rollouts: [
      {
        deliverableId: "app",
        outletId: "appstore",
        channel: "stable",
        releaseId: "rel_240",
        rolloutBp: 2500,
        state: "active",
        mirrored: false,
        source: "admin",
        startedAt: NOW - DAY,
        updatedAt: NOW - DAY,
        updatedBy: "u1",
      },
    ],
  },
  "/manage/api/products/djdl/update/settings": {
    metadataAccess: "licensed",
    accessSource: "manifest",
    compatMin: "2.0.0",
    compatMax: "3.0.0",
    compatSource: "manifest",
    minimumSystemVersion: null,
    requireSparkleSignature: true,
    configured: true,
  },
  "/manage/api/products/djdl/identity/portal": {
    settings: {
      portalEnabled: true,
      oidcEnabled: true,
      magicEnabled: true,
      licenseKeyClaimEnabled: true,
      releasesEnabled: true,
      autoLinkEnabled: null,
    },
  },
  "/manage/api/products/djdl/config/mint": {
    registration: "requires-license",
    anonymousEnroll: false,
    oidcDefault: false,
    publicMint: false,
    licenseEnabled: true,
    identity: null,
    recipes: [
      {
        id: "studio",
        alg: "ES256",
        signingKeySecret: "EDGE_MINT__DJDL__STUDIO",
        kid: "KID1",
        claimsTemplateJson: '{"iss":"TEAM"}',
        claimsTemplate: { iss: "TEAM" },
        ttlSeconds: 3600,
        audience: null,
        status: "pending",
        secretUsage: "edge-mint",
        approval: null,
        changedFields: [],
      },
    ],
  },
  "/manage/api/products/djdl/outlet-credentials": {
    ok: true,
    kinds: ["asc-api-key", "google-service-account"],
    credentials: [],
  },
};

export const DEVICE_ID = devices[0]!.deviceId;
export const USER_SUBJECT = USER_SUBJECTS[0]!;
