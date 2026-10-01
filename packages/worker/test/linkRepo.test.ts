import { describe, expect, it } from "vitest";
import { parseServices } from "../src/core/services.js";
import { signJws, verifyJws } from "@polaris-key/jws";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  approveEdgeMintRecipe,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProductSecret,
} from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleEnroll } from "../src/services/license/enroll.js";
import { FINGERPRINT_COMPONENT_LENGTH } from "@polaris-key/protocol";
import {
  getApprovedEdgeMintConfig,
  handleMintToken,
  mintIsPublic,
} from "../src/services/config/mint.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { linkRepo, parseRepoUrl } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { parseManualChannels } from "../src/services/release/channels.js";
import { handleGithubWebhook } from "../src/githubWebhook.js";
import { open } from "../src/keyvault.js";
import {
  getActiveProductKey,
  getActiveSchema,
  getProductSyncState,
  getProduct,
  setAutoIssuePolicy,
  setServices,
} from "../src/repo.js";
import { getReleaseConfig } from "../src/services/release/index.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";

// A throwaway 2048-bit RSA private key (PKCS#8 PEM) so the App-JWT signer actually runs; the
// fetch stub then shortcuts the installation-token exchange. Never a prod key.
const TEST_RSA_PKCS8 = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCsEMREsWAll4vT
9mDM1zr8yF9klknqOJPqLj/1SvQx3IJNKks0LfEhPK+1LqTIrALhx3UM3N8hmmY6
Kk7C8cXsA0b49QtF/KtFPFnK+cSBGtOmZMJ7tJBQhUswWeJ2BPr24sDJZaCS4JH5
QlCi2g7Lchwkzp6d2H23rm9CD8LT6OPcgXnALdM4wfQ3Wa1gklDi0zd29FyKsdtF
3PjhzUVn7xRJQFOQU3vOqizauuYvM2WmV9K3BnkZZyPRgSVIEggBwlyrJLBSVZYI
8C2zmxLs7SeUaoq29rewma3h5mLhwL62VN0WC6B7rM18cifR0sR46VVc3/2gNAZ3
BxnHKG+TAgMBAAECggEAAvfVEuRGZs+a62CcIdxymYqxTpBjHQW103vRwZ714GhP
3RnmKzPBrZOY6lSwJgAFmrRwmfSzaqZ5rfYt3qICCoSx9Dhx5daqc6rLV7uAPsPi
M8QYML8YIDN0bRSX2fZTB/A4aCD3KKF0EysoLe76A1toDeB8jvd9j64UID0aXMJn
7UNX6BrmAj36r/gUZNiIPDQRg0RZV+weDv8Q0BG2yE6wpA2B5jdEJbX4jq7Tr2WU
3xJlG2GBOt1kNcaVKlr2FmF+3xFAdafJW/AYaMBL5EWytiMqP9bu/H3cm/laphKA
+phJ2fGgw094+ZS+fP2Qja7yqI6/6rDg53pGWCVuVQKBgQDhvS/Q8BM2dJIZUy+B
KZpZKuQSKvYvKvuNvjkuUSj8XA6AvfehcQWWJRngB7S1cYJoANsO3KvAyHQ4RUe9
s6AHDGJljnB/kfqMdQKbMtmw7u8MEtLRHCELZ0eVcd/8nHBmCgkCe1sj8OmXBVkN
pqW16lfsLu58g8u/qzPRrRQ+bwKBgQDDIaKwhhl0UD9+9wNBLZZ2lurLUiNnK4ZM
0yHaYselF8WkBRRlpTYJrEEYetlFLxToNlqk4VlWES0ZtJQ5SQJgqzG2cmMApvAJ
hurjuDBPaGcu56K7wUobYFbw9aNM7Nnm+Tpt+DehIJ48rjBMKSBAqLj2QXBSP+ST
QU/BYgbzHQKBgBFz+h1yYlnke2M/3j1jRQ691TJeZfhRn29fFLazCbMxPuHPTjUK
Mv9f0PdUQTGCHC4EWut0PkdCeFHdcWWGXMoOuBDYCXSjibaQWWo8bT5TyuGpFumZ
/igOjSdNzZ6PTdVl0zqA5RQLTVQi0rbOeqNtAe0916yC2B7ykqgUdKs7AoGBAI2L
MYsgywgPSe/cWDUIT5OYZ5qy61FkRhgmMvFKJA3Cj7ApqyEMVYVwuQt72W0Q+PZ0
rw3ZFUeUUAXMcpSXPC1JIVd55AzOC2KtxmcG7aw8TFS+29GcJRh0qrxBQoKDcJDW
CqdInXm4wm+73vbwAiBFA15GG6beB/01LBhX9jiVAoGBAM2aHdDaIHzO71WMB7Qi
6e6lkI53ovO8vzw/hITzvTqbEslxweqRjv0LHwMo1/+zdFtnxyWHUTFQtT4VM7FV
86FY7DjzErSUSOhQfXvKGVvy2oAYxQUqqJgHI2iowSMVNg1O45wW4O3eUsJuMx06
d+RKUGe97dQXkny7eE7qJPbg
-----END PRIVATE KEY-----`;

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  // R9-01: a repo-supplied `oidc.issuer` is now fail-closed at ingest — `linkRepo` refuses a
  // `provider: custom` manifest whose issuer host an operator has not allowlisted, and
  // `resyncRepo` refuses a *change* to one. `PRODUCT_JSON` below declares a custom IdP, so the
  // happy-path fixtures need the operator half of that control. The refusals themselves are
  // PoC'd in test/attack/R9-injection.test.ts.
  env.OIDC_ISSUER_ALLOWLIST = "id.example";
  return env;
}

/** Encode UTF-8 text the way the GitHub Contents API does (base64, JSON envelope). */
function contentsResponse(text: string): Response {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return new Response(JSON.stringify({ content: b64, encoding: "base64" }), {
    status: 200,
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedWebhookRequest(
  payload: unknown,
  secret: string,
  signatureOverride?: string,
): Promise<Request> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body) as BufferSource,
    ),
  );
  return new Request("https://key.plrs.im/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": signatureOverride ?? `sha256=${hex(sig)}`,
      // Real deliveries always carry a GUID; the handler now requires it for replay
      // protection (R6-06), so each call gets a fresh one.
      "x-github-delivery": crypto.randomUUID(),
    },
    body,
  }) as unknown as Request;
}

/**
 * A fetch stub mirroring release.test.ts: it always answers installation discovery + the token
 * exchange, then serves `.pkey/` files from a `files` map (keyed by the path that appears in the
 * Contents API URL). A missing file yields 404 so the linkRepo extension-fallback runs.
 */
function stubFetch(files: Record<string, string>): {
  fetchImpl: FetchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/installation")) {
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    }
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_installation_token" }), {
        status: 200,
      });
    }
    if (url.includes("/contents/")) {
      // fetchRepoFile encodes each path segment with encodeURIComponent; `.pkey/schema.json`
      // has no reserved chars, so the bare path appears verbatim in the URL.
      for (const [path, body] of Object.entries(files)) {
        if (url.includes(`/contents/${path}`)) return contentsResponse(body);
      }
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

// ── Manifest fixtures ────────────────────────────────────────────────────────

const SCHEMA_JSON = JSON.stringify({
  schemaVersion: 1,
  entries: [
    {
      key: "run.concurrency",
      kind: "config",
      category: "run",
      label: "Concurrency",
      description: "",
      schema: { type: "integer", minimum: 1 },
    },
  ],
});

const PRODUCT_JSON = JSON.stringify({
  slug: "acme",
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: "acme-admins",
  oidc: {
    provider: "custom",
    issuer: "https://id.example",
    clientId: "acme-client",
    clientSecretSecret: "OIDC_SECRET__ACME",
    redirectUris: ["https://acme.example/cb"],
    groupRoleMap: { "acme-admins": { role: "admin" } },
  },
  tiers: [
    {
      id: "pro",
      label: "Pro",
      profileId: null,
      policyExpiryDays: 365,
      policyDeviceLimit: 5,
    },
  ],
  provisioning: [],
});

const RELEASE_JSON = JSON.stringify({
  release: {
    ghOwner: "acme-org",
    ghRepo: "acme-app",
    binaryName: "acme",
    channelWorkflow: "channel.yml",
    betaBranch: "main",
    summaryMarker: "pkey:summary",
    sparkleEd25519Pub: "PUBKEY==",
  },
  edgeMint: [
    {
      id: "applemusic",
      alg: "ES256",
      signingKeySecret: "MINT_KEY__ACME",
      claimsTemplate: { iss: "TEAMID" },
      ttlSeconds: 3600,
    },
  ],
});

// YAML variants (same content, YAML syntax) to exercise the per-file YAML path.
const PRODUCT_YAML = `slug: yamlprod
name: YAML Product
compatMin: 1.0.0
compatMax: 9.0.0
defaultMaxOfflineDays: 7
defaultDeviceLimit: 2
adminGroup: yaml-admins
tiers:
  - id: basic
    label: Basic
    profileId: null
    policyExpiryDays: 30
    policyDeviceLimit: 1
provisioning: []
`;
const SCHEMA_YAML = `schemaVersion: 1
entries:
  - key: run.timeout
    kind: config
    category: run
    label: Timeout
    description: ""
    schema:
      type: integer
      minimum: 0
`;

describe("parseRepoUrl", () => {
  it("parses https, ssh, and bare owner/repo forms", () => {
    expect(parseRepoUrl("https://github.com/acme/repo")).toEqual({
      owner: "acme",
      repo: "repo",
    });
    expect(parseRepoUrl("https://github.com/acme/repo.git")).toEqual({
      owner: "acme",
      repo: "repo",
    });
    expect(parseRepoUrl("git@github.com:acme/repo")).toEqual({
      owner: "acme",
      repo: "repo",
    });
    expect(parseRepoUrl("acme/repo")).toEqual({ owner: "acme", repo: "repo" });
    expect(parseRepoUrl("not a url")).toBeNull();
  });
});

describe("linkRepo (GitHub-forward product creation)", () => {
  it("persists manifest-declared manual channels, and resync updates them", async () => {
    const db = makeTestDb();
    const env = envFor();
    const releaseWith = (channels: Array<{ name: string; regex: string }>) =>
      JSON.stringify({
        release: {
          ghOwner: "acme-org",
          ghRepo: "acme-app",
          binaryName: "acme",
          channelWorkflow: "channel.yml",
          betaBranch: "main",
          summaryMarker: "pkey:summary",
          sparkleEd25519Pub: "PUBKEY==",
          manualChannels: channels,
        },
      });
    const nightly = { name: "nightly", regex: "v.*-nightly\\..*" };
    const { fetchImpl } = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseWith([nightly]),
    });

    const result = await linkRepo(
      env,
      db,
      "https://github.com/acme-org/acme-app",
      NOW,
      fetchImpl,
    );
    expect(result.ok).toBe(true);

    // Ingest → persist → the runtime reader: one shape end to end. `parseManualChannels`
    // is the SAME function the feed resolves channels with, so this round-trip is the
    // proof the manifest key and the resolver agree.
    const rel = await getReleaseConfig(db, "acme");
    expect(parseManualChannels(rel?.manual_channels_json)).toEqual([nightly]);

    // A repo edit moves them on resync (products-as-data: the manifest stays the owner).
    const canary = { name: "canary", regex: "v.*-canary" };
    const { fetchImpl: fetchImpl2 } = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseWith([canary]),
    });
    const resynced = await resyncRepo(env, db, "acme", NOW + 60, fetchImpl2);
    expect(resynced.ok).toBe(true);
    const after = await getReleaseConfig(db, "acme");
    expect(parseManualChannels(after?.manual_channels_json)).toEqual([canary]);
  });

  it("persists web.origins on link, rewrites it on resync, and clears it when dropped (P0-05)", async () => {
    const db = makeTestDb();
    const env = envFor();
    const productWith = (web: unknown) =>
      JSON.stringify({ ...JSON.parse(PRODUCT_JSON), web });
    const linked = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": productWith({
        origins: ["https://play.acme.example", "http://localhost:8060"],
      }),
    });
    expect(
      (await linkRepo(env, db, "acme-org/acme-app", NOW, linked.fetchImpl)).ok,
    ).toBe(true);
    expect((await getProduct(db, "acme"))?.web_origins_json).toBe(
      JSON.stringify(["https://play.acme.example", "http://localhost:8060"]),
    );

    const moved = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": productWith({ origins: ["https://acme.example"] }),
    });
    expect(
      (await resyncRepo(env, db, "acme", NOW + 1, moved.fetchImpl)).ok,
    ).toBe(true);
    expect((await getProduct(db, "acme"))?.web_origins_json).toBe(
      JSON.stringify(["https://acme.example"]),
    );

    // Dropping the block is a real edit, not "leave it as it was": no origin is allowed.
    const dropped = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
    });
    expect(
      (await resyncRepo(env, db, "acme", NOW + 2, dropped.fetchImpl)).ok,
    ).toBe(true);
    expect((await getProduct(db, "acme"))?.web_origins_json).toBeNull();

    // A bad origin is a manifest error: resync refuses and the stored list is untouched.
    const bad = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": productWith({
        origins: ["https://*.acme.example"],
      }),
    });
    expect((await resyncRepo(env, db, "acme", NOW + 3, bad.fetchImpl)).ok).toBe(
      false,
    );
    expect((await getProduct(db, "acme"))?.web_origins_json).toBeNull();
  });

  it("discovers the install + imports a JSON .pkey/ → product + schema + release + sealed key", async () => {
    const db = makeTestDb();
    const env = envFor();
    const { fetchImpl, calls } = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": RELEASE_JSON,
    });

    const result = await linkRepo(
      env,
      db,
      "https://github.com/acme-org/acme-app",
      NOW,
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe("acme");
    // Operator guidance lists the secret NAMES (never values) the manifest still needs.
    expect(result.remainingSecrets).toContain("OIDC_SECRET__ACME");
    expect(result.remainingSecrets).toContain("MINT_KEY__ACME");

    // Installation discovery happened before any contents fetch.
    expect(calls.some((u) => u.includes("/installation"))).toBe(true);

    // product row with release_source='github'.
    const product = await getProduct(db, "acme");
    expect(product?.release_source).toBe("github");
    expect(product?.name).toBe("Acme");
    expect(typeof product?.signing_pub).toBe("string"); // public key persisted

    // active schema.
    const schema = await getActiveSchema(db, "acme");
    expect(schema?.active).toBe(1);
    expect(schema?.catalog_json).toContain("run.concurrency");

    // release_config carries the GitHub coordinates + installation id.
    const rel = await getReleaseConfig(db, "acme");
    expect(rel?.gh_owner).toBe("acme-org");
    expect(rel?.gh_repo).toBe("acme-app");
    expect(rel?.gh_installation_id).toBe(4242);
    expect(rel?.binary_name).toBe("acme");

    // oidc + tiers + edge_mint rows landed.
    const oidc = await db.first<{ provider: string; client_id: string }>(
      "SELECT * FROM oidc_config WHERE product = ?",
      "acme",
    );
    expect(oidc?.provider).toBe("custom");
    expect(oidc?.client_id).toBe("acme-client");
    const tier = await db.first<{ id: string }>(
      "SELECT * FROM tiers WHERE product = ?",
      "acme",
    );
    expect(tier?.id).toBe("pro");
    const mint = await db.first<{ id: string; alg: string }>(
      "SELECT * FROM edge_mint_config WHERE product = ?",
      "acme",
    );
    expect(mint?.id).toBe("applemusic");
    expect(mint?.alg).toBe("ES256");

    // The sealed product_keys row decrypts to a PEM that signs a doc verifying under its pub.
    const keyRow = await getActiveProductKey(db, "acme");
    expect(keyRow).not.toBeNull();
    const pem = await open(env, keyRow!.enc_private_json, {
      product: "acme",
      kind: "signing-key",
      id: keyRow!.kid,
    });
    const jws = await signJws({ hello: "world" }, pem, keyRow!.kid);
    const verified = await verifyJws<{ hello: string }>(jws, {
      [keyRow!.kid]: keyRow!.public_b64url,
    });
    expect(verified).not.toBeNull();
    expect(verified!.payload.hello).toBe("world");
  });

  it("imports a YAML .pkey/ (schema + product YAML, no release)", async () => {
    const db = makeTestDb();
    const env = envFor();
    const { fetchImpl } = stubFetch({
      ".pkey/schema.yaml": SCHEMA_YAML,
      ".pkey/product.yaml": PRODUCT_YAML,
    });

    const result = await linkRepo(env, db, "yaml-org/yaml-app", NOW, fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe("yamlprod");

    const product = await getProduct(db, "yamlprod");
    expect(product?.release_source).toBe("github");
    const schema = await getActiveSchema(db, "yamlprod");
    expect(schema?.catalog_json).toContain("run.timeout");
    // binary_name defaults to the repo name when release omits it.
    const rel = await getReleaseConfig(db, "yamlprod");
    expect(rel?.binary_name).toBe("yaml-app");
    // The sealed signing key is usable.
    const keyRow = await getActiveProductKey(db, "yamlprod");
    expect(keyRow).not.toBeNull();
    const pem = await open(env, keyRow!.enc_private_json, {
      product: "yamlprod",
      kind: "signing-key",
      id: keyRow!.kid,
    });
    const jws = await signJws({ ok: 1 }, pem, keyRow!.kid);
    expect(
      await verifyJws(jws, { [keyRow!.kid]: keyRow!.public_b64url }),
    ).not.toBeNull();
  });

  it("a manifest error writes NO rows", async () => {
    const db = makeTestDb();
    const env = envFor();
    // schema present but product missing → parseManifest fails (product required).
    const { fetchImpl } = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
    });

    const result = await linkRepo(env, db, "broken-org/broken", NOW, fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest");
    expect(result.errors?.some((e) => e.includes("product"))).toBe(true);

    // Nothing was written for any slug.
    const products = await db.all<{ slug: string }>("SELECT * FROM products");
    expect(products.length).toBe(0);
    const keys = await db.all<{ product: string }>(
      "SELECT * FROM product_keys",
    );
    expect(keys.length).toBe(0);
  });

  // FIXED: `linkRepo` and `resyncRepo` inserted `catalog_json` straight from the manifest with
  // no `compileAll()`, while the admin API screens every catalog it accepts. The repo-sync
  // path was therefore the one remaining way to install a catalog the admin API would refuse —
  // unsupported keywords, or a `pattern` the validator will not compile — and it is reachable
  // from a repo webhook. The manifest parser only checks `schema.type`'s SHAPE, so this
  // fragment passes `parseManifest` and is caught only by the new screen.
  it("a catalog the admin API would reject is refused by linkRepo and resyncRepo too", async () => {
    const db = makeTestDb();
    const env = envFor();
    const badSchema = JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          key: "run.name",
          kind: "config",
          category: "run",
          label: "Name",
          description: "",
          schema: { type: "string", pattern: 42 }, // not a string → UnsupportedSchemaError
        },
      ],
    });
    const { fetchImpl } = stubFetch({
      ".pkey/schema.json": badSchema,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": RELEASE_JSON,
    });

    const result = await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid catalog in manifest");
    // Nothing was written — the catalog screen runs before the batch is built.
    expect(
      (await db.all<{ slug: string }>("SELECT * FROM products")).length,
    ).toBe(0);
    expect(
      (await db.all<{ product: string }>("SELECT * FROM product_schema"))
        .length,
    ).toBe(0);

    // Same for the webhook-driven resync: link with a GOOD catalog, then have the repo serve
    // the bad one. The active schema must not be replaced.
    const good = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": RELEASE_JSON,
    });
    expect(
      (await linkRepo(env, db, "acme-org/acme-app", NOW, good.fetchImpl)).ok,
    ).toBe(true);
    const resync = await resyncRepo(env, db, "acme", NOW + 1, fetchImpl);
    expect(resync.ok).toBe(false);
    if (resync.ok) return;
    expect(resync.error).toContain("invalid catalog in manifest");
    expect((await getActiveSchema(db, "acme"))?.catalog_json).toBe(SCHEMA_JSON);
  });

  // ── Service enablement (design spec §2.2) ──────────────────────────────────
  // `services_json` decides which of a product's routes exist at all, so where and when it is
  // written matters as much as what it says: in the SAME atomic batch as the product row (no
  // instant with a product but no enablement set), and never over an operator's live edit.
  describe("service enablement persistence", () => {
    // Legacy module vocabulary + a release block: `licensing` -> license, `releases` ->
    // release + distribution + update, `oidc` -> identity, `config` stays config.
    const MODULES_PRODUCT_JSON = JSON.stringify({
      slug: "acme",
      name: "Acme",
      modules: {
        licensing: { enabled: true },
        config: { enabled: true },
        releases: { enabled: true },
        oidc: { enabled: true },
      },
      oidc: {
        provider: "custom",
        issuer: "https://id.example",
        clientId: "acme-client",
        clientSecretSecret: "OIDC_SECRET__ACME",
        redirectUris: ["https://acme.example/cb"],
      },
    });

    it("writes the manifest's enablement set atomically with the product row", async () => {
      const db = makeTestDb();
      const env = envFor();
      const { fetchImpl } = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": MODULES_PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });

      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl)).ok,
      ).toBe(true);

      const row = await getProduct(db, "acme");
      expect(row?.services_source).toBe("manifest");
      expect(parseServices(row?.services_json ?? null).services).toEqual({
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
        identity: { enabled: true },
      });
    });

    it("defaults an undeclared manifest to license + config", async () => {
      const db = makeTestDb();
      const env = envFor();
      // PRODUCT_JSON declares no `modules:` block at all.
      const { fetchImpl } = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });

      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl)).ok,
      ).toBe(true);

      expect(
        parseServices((await getProduct(db, "acme"))?.services_json ?? null)
          .services,
      ).toEqual({
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
      });
    });

    it("resync re-applies the manifest while the row is manifest-owned", async () => {
      const db = makeTestDb();
      const env = envFor();
      const linkFetch = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });
      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, linkFetch.fetchImpl))
          .ok,
      ).toBe(true);

      // The repo now declares the full module set.
      const { fetchImpl } = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": MODULES_PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });
      const resync = await resyncRepo(env, db, "acme", NOW + 1, fetchImpl);
      expect(resync.ok).toBe(true);
      if (!resync.ok) return;
      expect(resync.updated).toContain("services");

      const services = parseServices(
        (await getProduct(db, "acme"))?.services_json ?? null,
      ).services;
      expect(services.release.enabled).toBe(true);
      expect(services.identity.enabled).toBe(true);
    });

    it("resync leaves an admin-claimed enablement set alone", async () => {
      const db = makeTestDb();
      const env = envFor();
      const linkFetch = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });
      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, linkFetch.fetchImpl))
          .ok,
      ).toBe(true);

      // An operator turns Config off in the admin API, claiming the row.
      await setServices(
        db,
        "acme",
        JSON.stringify({
          license: { enabled: true },
          config: { enabled: false },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
        }),
        "admin",
        NOW + 1,
      );

      // A push then re-applies a manifest that turns everything on. It must not land: the
      // routes an operator deliberately closed cannot be reopened by someone else's commit.
      const { fetchImpl } = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": MODULES_PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });
      const resync = await resyncRepo(env, db, "acme", NOW + 2, fetchImpl);
      expect(resync.ok).toBe(true);

      const row = await getProduct(db, "acme");
      expect(row?.services_source).toBe("admin");
      const services = parseServices(row?.services_json ?? null).services;
      expect(services.config.enabled).toBe(false);
      expect(services.release.enabled).toBe(false);
      expect(services.identity.enabled).toBe(false);
    });
  });

  // ── The `.pkey/` manifest directory (wire v3 §8) ─────────────────────────────────────────
  //
  // ONE directory. Amendment A1 withdrew the `.pkey/` rename and the dual-read that went
  // with it, so the only per-file preference left is the EXTENSION: JSON, then YAML, then YML,
  // resolved independently for each of the three documents.
  describe("manifest directory", () => {
    const REGISTRATION_PRODUCT_JSON = JSON.stringify({
      slug: "acme",
      name: "Acme",
      modules: { license: { enabled: false }, config: { enabled: true } },
      devices: { registration: "open" },
    });

    it("reads the three documents from .pkey/", async () => {
      const db = makeTestDb();
      const env = envFor();
      const { fetchImpl } = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });
      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl)).ok,
      ).toBe(true);
      expect((await getProduct(db, "acme"))?.name).toBe("Acme");
    });

    it("prefers JSON over YAML per document, independently", async () => {
      const db = makeTestDb();
      const env = envFor();
      // `product` is carried in BOTH formats — JSON wins — while `schema` exists only as YAML,
      // so the two documents resolve to different extensions in the same link.
      const { fetchImpl } = stubFetch({
        ".pkey/product.json": PRODUCT_JSON,
        ".pkey/product.yaml": "slug: acme\nname: Yaml Loses\n",
        ".pkey/schema.yaml": "schemaVersion: 1\nentries: []\n",
      });
      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl)).ok,
      ).toBe(true);
      expect((await getProduct(db, "acme"))?.name).toBe("Acme");
      expect((await getActiveSchema(db, "acme"))?.catalog_version).toBe(1);
    });

    it("falls through to YAML when a document has no JSON variant", async () => {
      const db = makeTestDb();
      const env = envFor();
      const { fetchImpl } = stubFetch({
        ".pkey/product.yaml": "slug: acme\nname: Yaml Wins\n",
        ".pkey/schema.json": SCHEMA_JSON,
      });
      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl)).ok,
      ).toBe(true);
      expect((await getProduct(db, "acme"))?.name).toBe("Yaml Wins");
    });

    it("resync re-reads the same paths and picks up the new content", async () => {
      const db = makeTestDb();
      const env = envFor();
      const link = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });
      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, link.fetchImpl)).ok,
      ).toBe(true);

      // The repo then rewrites `product` to declare a registration policy.
      const { fetchImpl } = stubFetch({
        ".pkey/product.json": REGISTRATION_PRODUCT_JSON,
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });
      const resync = await resyncRepo(env, db, "acme", NOW + 1, fetchImpl);
      expect(resync.ok).toBe(true);

      const parsed = parseServices(
        (await getProduct(db, "acme"))?.services_json ?? null,
      );
      expect(parsed.services.license.enabled).toBe(false);
      expect(parsed.registration).toBe("open");
    });

    it("persists a declared registration policy, and drops it when the manifest stops declaring one", async () => {
      const db = makeTestDb();
      const env = envFor();
      const declared = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": REGISTRATION_PRODUCT_JSON,
      });
      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, declared.fetchImpl))
          .ok,
      ).toBe(true);
      expect(
        parseServices((await getProduct(db, "acme"))?.services_json ?? null)
          .registration,
      ).toBe("open");

      // Removing `devices.registration` returns the product to the DERIVED default rather than
      // freezing whatever it last said — which is why the key is absent, not defaulted, in the
      // column.
      const undeclared = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": JSON.stringify({
          slug: "acme",
          name: "Acme",
          modules: { license: { enabled: false }, config: { enabled: true } },
        }),
      });
      expect(
        (await resyncRepo(env, db, "acme", NOW + 1, undeclared.fetchImpl)).ok,
      ).toBe(true);
      expect(
        parseServices((await getProduct(db, "acme"))?.services_json ?? null)
          .registration,
      ).toBeUndefined();
    });

    it("the webhook path filter triggers on .pkey/ and nothing else", async () => {
      const db = makeTestDb();
      const env = envFor();
      env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
      const { fetchImpl } = stubFetch({
        ".pkey/schema.json": SCHEMA_JSON,
        ".pkey/product.json": PRODUCT_JSON,
        ".pkey/release.json": RELEASE_JSON,
      });
      expect(
        (await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl)).ok,
      ).toBe(true);

      const push = async (
        paths: string[],
      ): Promise<{ ok: boolean; ignored?: string }> => {
        const res = await handleGithubWebhook(
          await signedWebhookRequest(
            {
              ref: "refs/heads/main",
              repository: {
                owner: { login: "acme-org" },
                name: "acme-app",
                default_branch: "main",
              },
              installation: { id: 4242 },
              head_commit: { modified: paths },
              commits: [],
            },
            env.GITHUB_WEBHOOK_SECRET!,
          ),
          env,
          db,
          NOW + 10,
          fetchImpl,
        );
        return (await res.json()) as { ok: boolean; ignored?: string };
      };

      // `.pkey/` is the manifest source…
      expect((await push([".pkey/product.yaml"])).ignored).toBeUndefined();
      // …including the bare directory path GitHub reports for a whole-directory rename, which
      // is exactly the delivery that must not be ignored.
      expect((await push([".pkey"])).ignored).toBeUndefined();
      // …and nothing else is — including a sibling whose name merely starts the same way.
      expect((await push(["src/main.ts", "README.md"])).ignored).toBe(
        "no-manifest-changes",
      );
      expect((await push([".pkey-notes/x.md"])).ignored).toBe(
        "no-manifest-changes",
      );
    });
  });

  it("resyncRepo is idempotent for an unchanged catalog", async () => {
    const db = makeTestDb();
    const env = envFor();
    const { fetchImpl } = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": RELEASE_JSON,
    });
    const linked = await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl);
    expect(linked.ok).toBe(true);

    const first = await resyncRepo(env, db, "acme", NOW + 1, fetchImpl);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.updated).not.toContain("schema");

    const second = await resyncRepo(env, db, "acme", NOW + 2, fetchImpl);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.updated).not.toContain("schema");
    const max = await db.first<{ v: number }>(
      "SELECT MAX(catalog_version) AS v FROM product_schema WHERE product = ?",
      "acme",
    );
    expect(max?.v).toBe(1);
  });

  it("GitHub webhook verifies HMAC, reads .pkey from the default branch, and records sync state", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const { fetchImpl, calls } = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": RELEASE_JSON,
    });
    const linked = await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl);
    expect(linked.ok).toBe(true);
    calls.length = 0;

    const payload = {
      ref: "refs/heads/main",
      after: "abc123",
      // Bound to the installation discovered at link time (R6-05).
      installation: { id: 4242 },
      repository: {
        name: "acme-app",
        full_name: "acme-org/acme-app",
        default_branch: "main",
        owner: { login: "acme-org" },
      },
      head_commit: { modified: [".pkey/product.yaml"] },
      commits: [],
    };
    const res = await handleGithubWebhook(
      await signedWebhookRequest(payload, env.GITHUB_WEBHOOK_SECRET),
      env,
      db,
      NOW + 10,
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      products: Array<{ product: string; ok: boolean; updated: string[] }>;
    };
    expect(body.ok).toBe(true);
    expect(body.products).toEqual([
      {
        product: "acme",
        ok: true,
        updated: [
          "product",
          // Service enablement is re-applied on every resync (it is always present on a
          // parsed manifest), subject to the manifest-vs-admin ownership guard.
          "services",
          "release",
          "oidc",
          "profiles",
          "tiers",
          "provisioning",
          "edgeMint",
        ],
      },
    ]);
    // R6-05: the manifest is read from the DB-configured repo's default branch (the
    // Contents API default), NEVER from a payload-supplied `after`/ref.
    const contents = calls.filter((url) => url.includes("/contents/"));
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.every((url) => !url.includes("ref="))).toBe(true);

    const sync = await getProductSyncState(db, "acme");
    expect(sync).toMatchObject({
      source: "webhook",
      status: "ok",
      commit_sha: "abc123",
    });
    expect(JSON.parse(sync!.changed_paths_json!)).toEqual([
      ".pkey/product.yaml",
    ]);
    expect(JSON.parse(sync!.updated_json!)).not.toContain("schema");
    const max = await db.first<{ v: number }>(
      "SELECT MAX(catalog_version) AS v FROM product_schema WHERE product = ?",
      "acme",
    );
    expect(max?.v).toBe(1);
  });

  it("GitHub webhook rejects invalid signatures before JSON parsing", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const res = await handleGithubWebhook(
      await signedWebhookRequest(
        "{not json",
        env.GITHUB_WEBHOOK_SECRET,
        "sha256=" + "0".repeat(64),
      ),
      env,
      db,
      NOW,
      stubFetch({}).fetchImpl,
    );
    expect(res.status).toBe(401);
  });

  it("resyncRepo returns a structured error when GitHub content fetch fails", async () => {
    const db = makeTestDb();
    const env = envFor();
    const { fetchImpl } = stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": RELEASE_JSON,
    });
    const linked = await linkRepo(env, db, "acme-org/acme-app", NOW, fetchImpl);
    expect(linked.ok).toBe(true);

    const failingFetch: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_installation_token" }),
          {
            status: 200,
          },
        );
      }
      if (url.includes("/contents/"))
        return new Response("forbidden", { status: 403 });
      return new Response("not found", { status: 404 });
    };
    const result = await resyncRepo(env, db, "acme", NOW + 1, failingFetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("repo file fetch failed: 403");
    const product = await getProduct(db, "acme");
    expect(product?.name).toBe("Acme");
    const max = await db.first<{ v: number }>(
      "SELECT MAX(catalog_version) AS v FROM product_schema WHERE product = ?",
      "acme",
    );
    expect(max?.v).toBe(1);
  });
});

// ── P0-12: edge-mint recipes arriving by push are inert until an operator approves them ─────
describe("edge-mint approvals across link and resync (P0-12)", () => {
  // A throwaway ES256 (P-256 PKCS#8) key for tests only (the same one edgeMint.test.ts uses).
  const ES_PEM =
    "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgav85fotyJ04AYsKF\nDojZziUJg9TuJamPiszlECztPLuhRANCAATgaZHNpIiLDSEQHY4H4BE5HnA9L8hR\n11WcM/ABvqCnO5CWZyHKWoEnKnKnmQwVibF2w5YwimX7Z1hIqJPHGCTB\n-----END PRIVATE KEY-----";

  const BASE_RECIPE = {
    id: "applemusic",
    alg: "ES256",
    signingKeySecret: "MINT_KEY__ACME",
    kid: "KID1",
    claimsTemplate: { iss: "TEAMID" },
    ttlSeconds: 3600,
    audience: "appstoreconnect-v1",
  };
  const releaseWith = (edgeMint: Array<Record<string, unknown>>) =>
    JSON.stringify({ ...JSON.parse(RELEASE_JSON), edgeMint });
  const filesWith = (
    edgeMint: Array<Record<string, unknown>>,
    productJson: string = PRODUCT_JSON,
  ) =>
    stubFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": productJson,
      ".pkey/release.json": releaseWith(edgeMint),
    }).fetchImpl;

  /** Link `acme` with no recipes, seal an edge-mint signing key, and activate one device. */
  async function linked(): Promise<{
    db: Db;
    env: Env;
    token: string;
    resync: (
      edgeMint: Array<Record<string, unknown>>,
      productJson?: string,
    ) => Promise<void>;
    mint: () => Promise<number>;
  }> {
    const db = makeTestDb();
    const env = envFor();
    const link = await linkRepo(
      env,
      db,
      "https://github.com/acme-org/acme-app",
      NOW,
      filesWith([]),
    );
    expect(link.ok).toBe(true);
    await seedProductSecret(db, "acme", "MINT_KEY__ACME", ES_PEM, "edge-mint");
    await seedProductSecret(db, "acme", "OTHER_KEY", ES_PEM, "edge-mint");
    const product = (await loadProduct(env, db, "acme"))!;
    const { key } = await seedLicenseWithKey(db, "acme");
    const act = await handleActivate(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "d1" }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await act.json()) as { token: string };
    let tick = 0;
    return {
      db,
      env,
      token,
      resync: async (edgeMint, productJson) => {
        const res = await resyncRepo(
          env,
          db,
          "acme",
          NOW + ++tick,
          filesWith(edgeMint, productJson),
        );
        expect(res.ok).toBe(true);
      },
      mint: async () =>
        (
          await handleMintToken(
            mkReq("POST", { authorization: `Bearer ${token}` }),
            env,
            db,
            (await loadProduct(env, db, "acme"))!,
            "applemusic",
            NOW,
          )
        ).status,
    };
  }

  it("a freshly linked product's recipes are pending: link never writes an approval", async () => {
    const db = makeTestDb();
    const env = envFor();
    const link = await linkRepo(
      env,
      db,
      "https://github.com/acme-org/acme-app",
      NOW,
      filesWith([BASE_RECIPE]),
    );
    expect(link.ok).toBe(true);
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM edge_mint_approvals WHERE product = 'acme'",
    );
    expect(n?.n).toBe(0);
    expect(
      await getApprovedEdgeMintConfig(
        db,
        (await loadProduct(env, db, "acme"))!,
        "applemusic",
      ),
    ).toBeNull();
  });

  it("a new recipe arriving by resync returns 404 until approved, then mints", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    expect(await w.mint()).toBe(404);

    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);
  });

  it("an unchanged resync keeps the recipe approved", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    await w.resync([BASE_RECIPE]);
    await w.resync([BASE_RECIPE]);
    expect(await w.mint()).toBe(200);
  });

  const CHANGES: Array<[string, Record<string, unknown>]> = [
    ["claimsTemplate", { claimsTemplate: { iss: "SOMEONE-ELSE" } }],
    ["audience", { audience: "https://attacker.example" }],
    ["alg", { alg: "RS256" }],
    ["kid", { kid: "KID2" }],
    ["ttlSeconds", { ttlSeconds: 86400 }],
    ["signingKeySecret", { signingKeySecret: "OTHER_KEY" }],
  ];
  for (const [field, change] of CHANGES) {
    it(`changing ${field} by resync makes the recipe 404 again`, async () => {
      const w = await linked();
      await w.resync([BASE_RECIPE]);
      await approveEdgeMintRecipe(w.db, "acme", "applemusic");
      expect(await w.mint()).toBe(200);

      await w.resync([{ ...BASE_RECIPE, ...change }]);
      expect(await w.mint()).toBe(404);
      // The approval is kept (it still records what the operator saw) — it just no longer
      // matches. Pushing the approved values back makes it live again without re-approval.
      await w.resync([BASE_RECIPE]);
      expect(await w.mint()).toBe(200);
    });
  }

  // The acknowledgement of open registration is bound to the approval: a push that opens
  // registration without touching the recipe must not widen an approval given under a closed
  // policy into a public mint.
  const OPENINGS: Array<[string, Record<string, unknown>]> = [
    [
      "declares devices.registration: open",
      { devices: { registration: "open" } },
    ],
    [
      "turns License off, so the derived registration is open",
      { modules: { license: { enabled: false }, config: { enabled: true } } },
    ],
  ];
  for (const [how, productChange] of OPENINGS) {
    it(`a push that ${how} makes an approved recipe 404 until re-approved with the acknowledgement`, async () => {
      const w = await linked();
      await w.resync([BASE_RECIPE]);
      // Approved while registration is requires-license: no acknowledgement was asked for.
      await approveEdgeMintRecipe(w.db, "acme", "applemusic");
      expect(await w.mint()).toBe(200);

      const opened = JSON.stringify({
        ...JSON.parse(PRODUCT_JSON),
        ...productChange,
      });
      await w.resync([BASE_RECIPE], opened);
      expect((await loadProduct(w.env, w.db, "acme"))!.registration).toBe(
        "open",
      );
      expect(await w.mint()).toBe(404);
      expect(
        await getApprovedEdgeMintConfig(
          w.db,
          (await loadProduct(w.env, w.db, "acme"))!,
          "applemusic",
        ),
      ).toBeNull();

      // Re-approved WITH the acknowledgement: mints under open registration.
      await approveEdgeMintRecipe(w.db, "acme", "applemusic", {
        acknowledgeOpenRegistration: true,
      });
      expect(await w.mint()).toBe(200);
    });
  }

  // Anonymous auto-issue is the other way a push makes the mint public: `POST /<p>/license/enroll`
  // hands any caller a licence and a device token while the effective registration still reads
  // `requires-license`. The acknowledgement must be required there too.
  it("a push that enables anonymous autoIssue makes a closed approval 404 until re-approved with the acknowledgement", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);

    await w.resync(
      [BASE_RECIPE],
      JSON.stringify({
        ...JSON.parse(PRODUCT_JSON),
        autoIssue: { enabled: true, tierId: "pro", mode: "anonymous" },
      }),
    );
    const product = (await loadProduct(w.env, w.db, "acme"))!;
    expect(product.registration).toBe("requires-license");
    expect(mintIsPublic(product)).toBe(true);
    expect(await w.mint()).toBe(404);

    expect(
      await getApprovedEdgeMintConfig(
        w.db,
        (await loadProduct(w.env, w.db, "acme"))!,
        "applemusic",
      ),
    ).toBeNull();

    await approveEdgeMintRecipe(w.db, "acme", "applemusic", {
      acknowledgeOpenRegistration: true,
    });
    expect(await w.mint()).toBe(200);
  });

  // The per-request check compares an approval with the product AS IT STANDS, so on its own a
  // push that widens issuance and a second push that reverts it would leave the approval applying
  // again — with the credentials handed out in between still working. The ingest therefore
  // DELETES an approval the product has widened; after the revert the recipe is pending.
  const approvalCount = async (db: Db): Promise<number> =>
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM edge_mint_approvals WHERE product = 'acme'",
      )
    )?.n ?? -1;
  const invalidations = async (db: Db) =>
    db.all<{
      action: string;
      target_id: string;
      summary: string;
      actor_sub: string | null;
    }>(
      "SELECT action, target_id, summary, actor_sub FROM audit WHERE product = 'acme' AND action = 'config.mint.invalidate'",
    );

  it("closing registration again does NOT restore an approval given without the acknowledgement", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    await w.resync(
      [BASE_RECIPE],
      JSON.stringify({
        ...JSON.parse(PRODUCT_JSON),
        devices: { registration: "open" },
      }),
    );
    expect(await w.mint()).toBe(404);
    expect(await approvalCount(w.db)).toBe(0);
    const audited = await invalidations(w.db);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      target_id: "applemusic",
      actor_sub: null,
    });
    expect(audited[0]!.summary).toContain("became public");

    await w.resync([BASE_RECIPE]);
    expect(await w.mint()).toBe(404);
    expect(await approvalCount(w.db)).toBe(0);

    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);
  });

  it("widen, enrol a stranger, revert: the stranger's token does not mint until an operator re-approves", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);

    // Push 1: anonymous enrolment on.
    await w.resync(
      [BASE_RECIPE],
      JSON.stringify({
        ...JSON.parse(PRODUCT_JSON),
        autoIssue: { enabled: true, tierId: "pro", mode: "anonymous" },
      }),
    );
    const anon = (await loadProduct(w.env, w.db, "acme"))!;
    const enrolled = await handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": "stranger" },
        {
          fingerprint: {
            components: {
              machineUuid: "u".repeat(FINGERPRINT_COMPONENT_LENGTH),
              boardSerial: "b".repeat(FINGERPRINT_COMPONENT_LENGTH),
              cpuModel: "c".repeat(FINGERPRINT_COMPONENT_LENGTH),
            },
            hwid: "ignored",
          },
        },
      ),
      w.env,
      w.db,
      anon,
      NOW,
    );
    expect(enrolled.status).toBe(200);
    const { token: stranger } = (await enrolled.json()) as { token: string };

    // Push 2: reverted. The product is closed again, and the stranger's licence is still active.
    // (Dropping `autoIssue` from the manifest would leave the stored policy as it was, so the
    // revert turns it off explicitly.)
    await w.resync(
      [BASE_RECIPE],
      JSON.stringify({
        ...JSON.parse(PRODUCT_JSON),
        autoIssue: { enabled: false, tierId: "pro", mode: "anonymous" },
      }),
    );
    const closed = (await loadProduct(w.env, w.db, "acme"))!;
    expect(mintIsPublic(closed)).toBe(false);
    const strangerMint = async () =>
      (
        await handleMintToken(
          mkReq("POST", { authorization: `Bearer ${stranger}` }),
          w.env,
          w.db,
          closed,
          "applemusic",
          NOW,
        )
      ).status;
    expect(await strangerMint()).toBe(404);
    expect(await w.mint()).toBe(404);
    expect(await approvalCount(w.db)).toBe(0);
    expect(await invalidations(w.db)).toHaveLength(1);

    // The residual the operator is told about: a re-approval covers what was issued meanwhile,
    // so the stranger's licence has to be reviewed and disabled by hand.
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await strangerMint()).toBe(200);
  });

  it("a widening a failed ingest left behind is dropped before the next push can revert it", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    // As if a push had written `services_json` and then failed before its sweep ran.
    await w.db.run(
      "UPDATE products SET services_json = ? WHERE slug = 'acme'",
      JSON.stringify({ registration: "open" }),
    );
    await w.resync([BASE_RECIPE]);
    expect(await approvalCount(w.db)).toBe(0);
    expect(await w.mint()).toBe(404);
  });

  it("a push refused half-way still drops the approval its early writes widened", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    const badSchema = JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          key: "run.name",
          kind: "config",
          category: "run",
          label: "Name",
          description: "",
          schema: { type: "string", pattern: 42 },
        },
      ],
    });
    const res = await resyncRepo(
      w.env,
      w.db,
      "acme",
      NOW + 100,
      stubFetch({
        ".pkey/schema.json": badSchema,
        ".pkey/product.json": JSON.stringify({
          ...JSON.parse(PRODUCT_JSON),
          devices: { registration: "open" },
        }),
        ".pkey/release.json": releaseWith([BASE_RECIPE]),
      }).fetchImpl,
    );
    expect(res.ok).toBe(false);
    // `services_json` was written before the catalog was refused.
    expect((await loadProduct(w.env, w.db, "acme"))!.registration).toBe("open");
    expect(await approvalCount(w.db)).toBe(0);
    expect(await invalidations(w.db)).toHaveLength(1);
  });

  // A push can also THROW half-way rather than be refused: the manifest validator does not reject
  // a duplicated `edgeMint[].id`, so the final batch fails on the `edge_mint_config` primary key —
  // after `setAutoIssuePolicy` has already written anonymous enrolment. The sweep runs in a
  // `finally`, so a repo writer cannot skip it this way; otherwise an operator's console revert
  // would make the approval apply again to a stranger enrolled in between.
  it("a push that throws after widening still drops the approval; a console revert does not restore it", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);

    await expect(
      resyncRepo(
        w.env,
        w.db,
        "acme",
        NOW + 100,
        filesWith(
          [BASE_RECIPE, BASE_RECIPE],
          JSON.stringify({
            ...JSON.parse(PRODUCT_JSON),
            autoIssue: { enabled: true, tierId: "pro", mode: "anonymous" },
          }),
        ),
      ),
    ).rejects.toThrow(/UNIQUE/);
    const anon = (await loadProduct(w.env, w.db, "acme"))!;
    expect(mintIsPublic(anon)).toBe(true);
    expect(await approvalCount(w.db)).toBe(0);
    const audited = await invalidations(w.db);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      target_id: "applemusic",
      actor_sub: null,
    });

    const enrolled = await handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": "stranger" },
        {
          fingerprint: {
            components: {
              machineUuid: "u".repeat(FINGERPRINT_COMPONENT_LENGTH),
              boardSerial: "b".repeat(FINGERPRINT_COMPONENT_LENGTH),
              cpuModel: "c".repeat(FINGERPRINT_COMPONENT_LENGTH),
            },
            hwid: "ignored",
          },
        },
      ),
      w.env,
      w.db,
      anon,
      NOW,
    );
    expect(enrolled.status).toBe(200);
    const { token: stranger } = (await enrolled.json()) as { token: string };

    // The operator's obvious fix: turn anonymous enrolment off in the console.
    await setAutoIssuePolicy(
      w.db,
      "acme",
      JSON.stringify({ enabled: false, tierId: "pro", mode: "anonymous" }),
      "admin",
      NOW + 200,
    );
    const strangerMint = async () =>
      (
        await handleMintToken(
          mkReq("POST", { authorization: `Bearer ${stranger}` }),
          w.env,
          w.db,
          (await loadProduct(w.env, w.db, "acme"))!,
          "applemusic",
          NOW,
        )
      ).status;
    expect(mintIsPublic((await loadProduct(w.env, w.db, "acme"))!)).toBe(false);
    expect(await strangerMint()).toBe(404);

    // A clean push afterwards does not bring it back either.
    await w.resync([BASE_RECIPE]);
    expect(await strangerMint()).toBe(404);
    expect(await w.mint()).toBe(404);
    expect(await approvalCount(w.db)).toBe(0);
  });

  // A `finally` covers a throw, not a Worker that is KILLED after the push's un-batched widening
  // writes (`setAutoIssuePolicy`/`setServices` commit before the final batch; a manual-channel
  // regex over a hostile tag, or GitHub cancelling a slow webhook, can end the isolate before the
  // sweep). The guarantee therefore rests on every console write of an approval input sweeping
  // FIRST. These cases stand in for the killed ingest by writing the widening directly, with the
  // source left at `manifest` and no sweep, then drive the real console endpoints.
  async function consoleCall(
    env: Env,
    db: Db,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "admins";
    const { token, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: ["admins"] },
      NOW,
    );
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(mkReq(method, headers, body), env, db, path, {
      now: NOW + 300,
    });
  }

  const KILLED_WIDENINGS: Array<
    [string, string, string, Record<string, unknown> | undefined]
  > = [
    [
      "turning anonymous enrolment off",
      "PATCH",
      "/api/products/acme/license/policy",
      { autoIssue: { enabled: false } },
    ],
    [
      "handing the device policy back to the manifest",
      "POST",
      "/api/products/acme/license/policy/revert",
      undefined,
    ],
  ];
  for (const [label, method, path, body] of KILLED_WIDENINGS) {
    it(`a killed ingest's anonymous enrolment: ${label} in the console drops the approval first`, async () => {
      const w = await linked();
      await w.resync([BASE_RECIPE]);
      await approveEdgeMintRecipe(w.db, "acme", "applemusic");
      expect(await w.mint()).toBe(200);

      // The push's `setAutoIssuePolicy` committed; the isolate died before the batch and the sweep.
      await w.db.run(
        "UPDATE products SET auto_issue_json = ? WHERE slug = 'acme'",
        JSON.stringify({ enabled: true, tierId: "pro", mode: "anonymous" }),
      );
      const anon = (await loadProduct(w.env, w.db, "acme"))!;
      expect(mintIsPublic(anon)).toBe(true);
      expect(await approvalCount(w.db)).toBe(1);
      expect(await w.mint()).toBe(404); // the per-mint check refuses meanwhile

      const enrolled = await handleEnroll(
        mkReq(
          "POST",
          { "x-pkey-device": "stranger" },
          {
            fingerprint: {
              components: {
                machineUuid: "u".repeat(FINGERPRINT_COMPONENT_LENGTH),
                boardSerial: "b".repeat(FINGERPRINT_COMPONENT_LENGTH),
                cpuModel: "c".repeat(FINGERPRINT_COMPONENT_LENGTH),
              },
              hwid: "ignored",
            },
          },
        ),
        w.env,
        w.db,
        anon,
        NOW,
      );
      expect(enrolled.status).toBe(200);
      const { token: stranger } = (await enrolled.json()) as {
        token: string;
      };

      const res = await consoleCall(w.env, w.db, method, path, body);
      expect(res.status).toBe(200);
      expect(await approvalCount(w.db)).toBe(0);
      const audited = await invalidations(w.db);
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({
        target_id: "applemusic",
        actor_sub: null,
      });
      expect(audited[0]!.summary).toContain(
        "found widened before a console edit",
      );

      // Close the mint in the console (the revert above only hands the row back), then check
      // the stranger is refused and stays refused across a clean push.
      if (path.endsWith("/revert"))
        await consoleCall(
          w.env,
          w.db,
          "PATCH",
          "/api/products/acme/license/policy",
          {
            autoIssue: { enabled: false },
          },
        );
      const closed = (await loadProduct(w.env, w.db, "acme"))!;
      expect(mintIsPublic(closed)).toBe(false);
      const strangerMint = async () =>
        (
          await handleMintToken(
            mkReq("POST", { authorization: `Bearer ${stranger}` }),
            w.env,
            w.db,
            (await loadProduct(w.env, w.db, "acme"))!,
            "applemusic",
            NOW,
          )
        ).status;
      expect(await strangerMint()).toBe(404);
      await w.resync([BASE_RECIPE]);
      expect(await strangerMint()).toBe(404);
      expect(await approvalCount(w.db)).toBe(0);
    });
  }

  const KILLED_SERVICES: Array<
    [string, string, string, Record<string, unknown> | undefined]
  > = [
    [
      "closing registration",
      "PATCH",
      "/api/products/acme/services",
      { registration: "requires-license" },
    ],
    [
      "handing services back to the manifest",
      "POST",
      "/api/products/acme/services/revert",
      undefined,
    ],
  ];
  for (const [label, method, path, body] of KILLED_SERVICES) {
    it(`a killed ingest's open registration: ${label} in the console drops the approval first`, async () => {
      const w = await linked();
      await w.resync([BASE_RECIPE]);
      await approveEdgeMintRecipe(w.db, "acme", "applemusic");
      // The push's `setServices` committed; the isolate died before the batch and the sweep.
      await w.db.run(
        "UPDATE products SET services_json = ? WHERE slug = 'acme'",
        JSON.stringify({ registration: "open" }),
      );
      expect(await approvalCount(w.db)).toBe(1);
      const res = await consoleCall(w.env, w.db, method, path, body);
      expect(res.status).toBe(200);
      expect(await approvalCount(w.db)).toBe(0);
      expect(await invalidations(w.db)).toHaveLength(1);
      expect(await w.mint()).toBe(404);
    });
  }

  it("a console edit that widens nothing keeps the approval", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    for (const [method, path, body] of [
      [
        "PATCH",
        "/api/products/acme/license/policy",
        { autoIssue: { enabled: false } },
      ],
      ["POST", "/api/products/acme/license/policy/revert", undefined],
      [
        "PATCH",
        "/api/products/acme/services",
        { registration: "requires-license" },
      ],
      ["POST", "/api/products/acme/services/revert", undefined],
    ] as const) {
      const res = await consoleCall(w.env, w.db, method, path, body);
      expect(res.status).toBe(200);
    }
    expect(await approvalCount(w.db)).toBe(1);
    expect(await invalidations(w.db)).toHaveLength(0);
    expect(await w.mint()).toBe(200);
  });

  it("an unchanged or narrowing resync never drops an approval", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    await w.resync([BASE_RECIPE]);
    // A recipe-field change is not a widening: the approval is kept and applies after a revert.
    await w.resync([{ ...BASE_RECIPE, kid: "KID2" }]);
    await w.resync([BASE_RECIPE]);
    expect(await approvalCount(w.db)).toBe(1);
    expect(await invalidations(w.db)).toHaveLength(0);
    expect(await w.mint()).toBe(200);
  });

  // Sign-in is the other push-controlled route to a device token on a CLOSED product:
  // `activateFromIdentity` licenses any identity whose groups hit `oidc.groupRoleMap`, against the
  // manifest's issuer and client id. The approval binds them, so a push that rewrites any of them
  // (or turns Identity on) makes an approved recipe 404 while registration still reads
  // requires-license. The ingest allowlist (R9-01) gates a NEW issuer host only; a second
  // allowlisted host, a client id, a group map and Identity itself pass it.
  const IDENTITY_PRODUCT = {
    ...JSON.parse(PRODUCT_JSON),
    modules: {
      license: { enabled: true },
      config: { enabled: true },
      identity: { enabled: true },
    },
  } as { oidc: Record<string, unknown> } & Record<string, unknown>;
  const TRUST_PUSHES: Array<[string, Record<string, unknown>]> = [
    [
      "maps a group the pusher is in onto a tier",
      {
        oidc: {
          ...IDENTITY_PRODUCT.oidc,
          groupRoleMap: {
            "acme-admins": { role: "admin" },
            pwned: { role: "user", tier: "pro" },
          },
        },
      },
    ],
    [
      "swaps the client id (a client the pusher registered at the same IdP)",
      { oidc: { ...IDENTITY_PRODUCT.oidc, clientId: "pusher-client" } },
    ],
    [
      "points the issuer at another allowlisted host",
      {
        oidc: {
          ...IDENTITY_PRODUCT.oidc,
          issuer: "https://shared-idp.example",
        },
      },
    ],
  ];
  for (const [how, change] of TRUST_PUSHES) {
    it(`a push that ${how} makes an approved closed recipe 404 until re-approved`, async () => {
      const w = await linked();
      w.env.OIDC_ISSUER_ALLOWLIST = "id.example, shared-idp.example";
      await w.resync([BASE_RECIPE], JSON.stringify(IDENTITY_PRODUCT));
      const before = (await loadProduct(w.env, w.db, "acme"))!;
      expect(before.services.identity.enabled).toBe(true);
      await approveEdgeMintRecipe(w.db, "acme", "applemusic");
      expect(await w.mint()).toBe(200);

      await w.resync(
        [BASE_RECIPE],
        JSON.stringify({ ...IDENTITY_PRODUCT, ...change }),
      );
      const after = (await loadProduct(w.env, w.db, "acme"))!;
      expect(after.registration).toBe("requires-license");
      expect(mintIsPublic(after)).toBe(false);
      expect(await w.mint()).toBe(404);
      expect(
        await getApprovedEdgeMintConfig(w.db, after, "applemusic"),
      ).toBeNull();

      // Re-approved with the new trust in view: the operator's decision, and it mints.
      await approveEdgeMintRecipe(w.db, "acme", "applemusic");
      expect(await w.mint()).toBe(200);
    });
  }

  it("a push that turns Identity on makes an approval given with it off 404", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    expect(
      (await loadProduct(w.env, w.db, "acme"))!.services.identity.enabled,
    ).toBe(false);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);

    await w.resync([BASE_RECIPE], JSON.stringify(IDENTITY_PRODUCT));
    expect(await w.mint()).toBe(404);
  });

  it("an unchanged resync of an Identity product keeps the recipe approved", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE], JSON.stringify(IDENTITY_PRODUCT));
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    await w.resync([BASE_RECIPE], JSON.stringify(IDENTITY_PRODUCT));
    expect(await w.mint()).toBe(200);
  });

  it("a sign-in trust push that is reverted leaves the recipe pending", async () => {
    const w = await linked();
    w.env.OIDC_ISSUER_ALLOWLIST = "id.example, idp.attacker.example";
    await w.resync([BASE_RECIPE], JSON.stringify(IDENTITY_PRODUCT));
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);

    await w.resync(
      [BASE_RECIPE],
      JSON.stringify({
        ...IDENTITY_PRODUCT,
        oidc: {
          ...IDENTITY_PRODUCT.oidc,
          issuer: "https://idp.attacker.example",
          groupRoleMap: {
            "acme-admins": { role: "admin" },
            pwned: { role: "user", tier: "pro" },
          },
        },
      }),
    );
    expect(await approvalCount(w.db)).toBe(0);
    await w.resync([BASE_RECIPE], JSON.stringify(IDENTITY_PRODUCT));
    expect(await w.mint()).toBe(404);
    const audited = await invalidations(w.db);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.summary).toContain("identity provider");
  });

  // The mint checks a device's licence only while License is on. With Identity on, a push that
  // turns License off keeps the mint closed (requires-identity) — but a device whose licence an
  // operator disabled would mint again. The approval records License, and the ingest drops it.
  it("a push that turns License off does not bring back a disabled licence", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE], JSON.stringify(IDENTITY_PRODUCT));
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);
    await w.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = 'acme'",
    );
    expect(await w.mint()).toBe(401);

    await w.resync(
      [BASE_RECIPE],
      JSON.stringify({
        ...IDENTITY_PRODUCT,
        modules: {
          license: { enabled: false },
          config: { enabled: true },
          identity: { enabled: true },
        },
      }),
    );
    const off = (await loadProduct(w.env, w.db, "acme"))!;
    expect(off.registration).toBe("requires-identity");
    expect(mintIsPublic(off)).toBe(false);
    expect(await w.mint()).toBe(404);
    expect(await approvalCount(w.db)).toBe(0);
    expect((await invalidations(w.db))[0]!.summary).toContain(
      "License was turned off",
    );
  });

  it("dropping a recipe from the manifest deletes its approval, so re-adding it is pending", async () => {
    const w = await linked();
    await w.resync([BASE_RECIPE]);
    await approveEdgeMintRecipe(w.db, "acme", "applemusic");
    expect(await w.mint()).toBe(200);

    await w.resync([]);
    const n = await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM edge_mint_approvals WHERE product = 'acme'",
    );
    expect(n?.n).toBe(0);

    await w.resync([BASE_RECIPE]);
    expect(await w.mint()).toBe(404);
  });
});
