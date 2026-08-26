import { describe, expect, it } from "vitest";
import { signJws, verifyJws } from "@polaris-key/jws";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/release/githubApp.js";
import { linkRepo, parseRepoUrl } from "../src/release/linkRepo.js";
import { resyncRepo } from "../src/release/resync.js";
import { handleGithubWebhook } from "../src/githubWebhook.js";
import { open } from "../src/keyvault.js";
import {
  getActiveProductKey,
  getActiveSchema,
  getProductSyncState,
  getProduct,
} from "../src/repo.js";
import { getReleaseConfig } from "../src/release/index.js";

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
