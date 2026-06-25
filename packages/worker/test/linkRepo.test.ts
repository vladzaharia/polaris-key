import { describe, expect, it } from "vitest";
import { signJws, verifyJws } from "@polaris-key/jws";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/release/githubApp.js";
import { linkRepo, parseRepoUrl } from "../src/release/linkRepo.js";
import { open } from "../src/keyvault.js";
import {
  getActiveProductKey,
  getActiveSchema,
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
  return env;
}

/** Encode UTF-8 text the way the GitHub Contents API does (base64, JSON envelope). */
function contentsResponse(text: string): Response {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return new Response(JSON.stringify({ content: b64, encoding: "base64" }), { status: 200 });
}

/**
 * A fetch stub mirroring release.test.ts: it always answers installation discovery + the token
 * exchange, then serves `.pkey/` files from a `files` map (keyed by the path that appears in the
 * Contents API URL). A missing file yields 404 so the linkRepo extension-fallback runs.
 */
function stubFetch(files: Record<string, string>): { fetchImpl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/installation")) {
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    }
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_installation_token" }), { status: 200 });
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
    { key: "run.concurrency", kind: "config", category: "run", label: "Concurrency", description: "", schema: { type: "integer", minimum: 1 } },
  ],
});

const PRODUCT_JSON = JSON.stringify({
  slug: "acme",
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  defaultMaxOfflineDays: 14,
  defaultMachineLimit: 3,
  adminGroup: "acme-admins",
  oidc: {
    issuer: "https://id.example",
    clientId: "acme-client",
    clientSecretSecret: "OIDC_SECRET__ACME",
    redirectUris: ["https://acme.example/cb"],
    groupRoleMap: { "acme-admins": { role: "admin" } },
  },
  tiers: [{ id: "pro", label: "Pro", profileId: null, policyExpiryDays: 365, policyMachineLimit: 5 }],
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
    { id: "applemusic", alg: "ES256", signingKeySecret: "MINT_KEY__ACME", claimsTemplate: { iss: "TEAMID" }, ttlSeconds: 3600 },
  ],
});

// YAML variants (same content, YAML syntax) to exercise the per-file YAML path.
const PRODUCT_YAML = `slug: yamlprod
name: YAML Product
compatMin: 1.0.0
compatMax: 9.0.0
defaultMaxOfflineDays: 7
defaultMachineLimit: 2
adminGroup: yaml-admins
tiers:
  - id: basic
    label: Basic
    profileId: null
    policyExpiryDays: 30
    policyMachineLimit: 1
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
    expect(parseRepoUrl("https://github.com/acme/repo")).toEqual({ owner: "acme", repo: "repo" });
    expect(parseRepoUrl("https://github.com/acme/repo.git")).toEqual({ owner: "acme", repo: "repo" });
    expect(parseRepoUrl("git@github.com:acme/repo")).toEqual({ owner: "acme", repo: "repo" });
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

    const result = await linkRepo(env, db, "https://github.com/acme-org/acme-app", NOW, fetchImpl);
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
    const oidc = await db.first<{ client_id: string }>("SELECT * FROM oidc_config WHERE product = ?", "acme");
    expect(oidc?.client_id).toBe("acme-client");
    const tier = await db.first<{ id: string }>("SELECT * FROM tiers WHERE product = ?", "acme");
    expect(tier?.id).toBe("pro");
    const mint = await db.first<{ id: string; alg: string }>("SELECT * FROM edge_mint_config WHERE product = ?", "acme");
    expect(mint?.id).toBe("applemusic");
    expect(mint?.alg).toBe("ES256");

    // The sealed product_keys row decrypts to a PEM that signs a doc verifying under its pub.
    const keyRow = await getActiveProductKey(db, "acme");
    expect(keyRow).not.toBeNull();
    const pem = await open(env, keyRow!.enc_private_json);
    const jws = await signJws({ hello: "world" }, pem, keyRow!.kid);
    const verified = await verifyJws<{ hello: string }>(jws, { [keyRow!.kid]: keyRow!.public_b64url });
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
    const pem = await open(env, keyRow!.enc_private_json);
    const jws = await signJws({ ok: 1 }, pem, keyRow!.kid);
    expect(await verifyJws(jws, { [keyRow!.kid]: keyRow!.public_b64url })).not.toBeNull();
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
    const keys = await db.all<{ product: string }>("SELECT * FROM product_keys");
    expect(keys.length).toBe(0);
  });
});
