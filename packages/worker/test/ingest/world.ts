/**
 * P0-26's golden harness, the fixtures half: a stubbed GitHub that serves a `.pkey/` the test can
 * change between calls, and the manifests the scenarios use. Everything here is read-only
 * support; the scenarios live in `golden.test.ts`.
 */
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv } from "../seed.js";
import { TEST_RSA_PKCS8 } from "../releaseFixtures.js";
import { withDefaultHead } from "../githubHead.js";
import { RELEASE_KID, RELEASE_PUB } from "../releaseKeysFixture.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import type { FetchImpl } from "../../src/services/release/githubApp.js";

export const SLUG = "acme";
export const URL_ = "https://github.com/acme-org/acme-app";

export function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.OIDC_ISSUER_ALLOWLIST = "id.example, other.example";
  return env;
}

/** Files by path; `undefined` removes one. Mutable, so a scenario can push a change. */
export interface Remote {
  files: Record<string, string | undefined>;
  /** `false`: the repository id lookup fails (the trusted publisher then refuses). */
  identity: boolean;
  fetch: FetchImpl;
}

export function remote(files: Record<string, string>): Remote {
  const r: Remote = {
    files: { ...files },
    identity: true,
    fetch: withDefaultHead(async (input) => {
      const url = String(input);
      if (/\/repos\/[^/]+\/[^/]+$/.test(url))
        return r.identity
          ? new Response(
              JSON.stringify({
                id: 9001,
                full_name: "acme-org/acme-app",
                owner: { id: 77 },
              }),
              { status: 200 },
            )
          : new Response("boom", { status: 502 });
      if (url.includes("/installation"))
        return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
      if (url.includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "ghs_token" }), {
          status: 200,
        });
      if (url.includes("/contents/")) {
        for (const [path, body] of Object.entries(r.files)) {
          if (body !== undefined && url.includes(`/contents/${path}`))
            return new Response(
              JSON.stringify({
                content: Buffer.from(body, "utf8").toString("base64"),
                encoding: "base64",
              }),
              { status: 200 },
            );
        }
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/releases")) return new Response("[]", { status: 200 });
      return new Response("not found", { status: 404 });
    }),
  };
  return r;
}

// ── Documents ────────────────────────────────────────────────────────────────────────────

export const ENTRIES: Record<string, unknown>[] = [
  {
    key: "run.name",
    kind: "config",
    category: "general",
    label: "Name",
    description: "",
    schema: { type: "string" },
  },
  {
    key: "api.key",
    kind: "secret",
    category: "api",
    label: "API key",
    description: "",
    schema: { type: "string", minLength: 8 },
  },
];

export const schemaJson = (entries: Record<string, unknown>[] = ENTRIES) =>
  JSON.stringify({ schemaVersion: 1, entries });

export interface Spec {
  product?: Record<string, unknown>;
  release?: Record<string, unknown>;
  edgeMint?: unknown[];
  entries?: Record<string, unknown>[];
  distribution?: string | null;
}

const PRODUCT = {
  slug: SLUG,
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  tiers: [{ id: "pro", label: "Pro", profileId: null, policyExpiryDays: 365 }],
  provisioning: [],
};

const RELEASE = {
  ghOwner: "acme-org",
  ghRepo: "acme-app",
  binaryName: "acme",
  betaBranch: "main",
  summaryMarker: "pkey:summary",
};

/** The minimal documents: product, schema and release. */
export function minimal(over: Spec = {}): Record<string, string> {
  const files: Record<string, string> = {
    ".pkey/schema.json": schemaJson(over.entries),
    ".pkey/product.json": JSON.stringify({ ...PRODUCT, ...over.product }),
    ".pkey/release.json": JSON.stringify({
      release: { ...RELEASE, ...over.release },
      ...(over.edgeMint ? { edgeMint: over.edgeMint } : {}),
    }),
  };
  if (over.distribution) files[".pkey/distribution.yaml"] = over.distribution;
  return files;
}

export const DISTRIBUTION = `outlets:
  direct:
    platforms: [macos, windows]
  web: {}
transports:
  default: pkey-cdn
`;

/** Every section: custom OIDC, edge mint, provisioning, tiers, profiles, keys, publisher, outlets. */
export function full(over: Spec = {}): Record<string, string> {
  return minimal({
    ...over,
    product: {
      modules: {
        license: { enabled: true },
        config: { enabled: true },
        identity: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
      },
      oidc: {
        provider: "custom",
        issuer: "https://id.example",
        clientId: "acme-client",
        clientSecretSecret: "OIDC_SECRET__ACME",
        redirectUris: ["https://acme.example/cb"],
        groupRoleMap: { "acme-admins": { role: "admin" } },
      },
      profiles: [
        {
          id: "standard",
          name: "Standard",
          payload: {
            config: {
              "run.name": { state: "default", value: "acme", updatedAt: 0 },
            },
            secrets: {
              "api.key": {
                state: "default",
                value: "s3cret-value",
                updatedAt: 0,
              },
            },
          },
        },
      ],
      tiers: [
        {
          id: "pro",
          label: "Pro",
          profileId: "standard",
          policyExpiryDays: 365,
          policyDeviceLimit: 5,
        },
        { id: "free", label: "Free", profileId: null },
      ],
      provisioning: [
        { claim: "plan", entitlementKey: "pro", entitlementValue: true },
      ],
      ...over.product,
    },
    release: {
      sparkleEd25519Pub: "SPARKLEKEY1",
      channelWorkflow: "channel.yml",
      releaseKeys: [{ kid: RELEASE_KID, publicKey: RELEASE_PUB }],
      publishing: {
        trustedPublisher: { workflow: ".github/workflows/release.yml" },
      },
      ...over.release,
    },
    edgeMint: over.edgeMint ?? [
      {
        id: "applemusic",
        kid: "mint-1",
        audience: "music",
        alg: "ES256",
        signingKeySecret: "MINT_KEY__ACME",
        claimsTemplate: { iss: "TEAMID" },
        ttlSeconds: 3600,
      },
    ],
    distribution:
      over.distribution === undefined ? DISTRIBUTION : over.distribution,
  });
}

export interface Linked {
  db: Db;
  env: Env;
  remote: Remote;
}

export function fresh(files: Record<string, string>): Linked {
  return { db: makeTestDb(), env: envFor(), remote: remote(files) };
}
