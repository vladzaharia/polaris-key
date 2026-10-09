/**
 * P2-02 — trusted publishing, Core half (`core/publisher.ts`).
 *
 *   1. GitHub OIDC verification: a locally generated RSA key signs fake GitHub tokens; the JWKS
 *      is served by an injected fetcher. One test per registered-claim failure, the unknown-kid
 *      refetch (and its once-a-minute brake), and the issuer that cannot be configured.
 *   2. The publisher policy: one test per claim check, each refusing.
 *   3. The exchange: single-use per `jti` (replay fails in D1), the 30-minute token, the audit.
 *   4. `pkeyci_` tokens: lookup, expiry, revocation, a deleted product, static issue.
 *   5. Upload tickets and the R2 temporary credentials they carry: what the minted credential can
 *      and cannot reach, judged by R2's documented authorisation rules.
 */

import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JWK,
  type KeyLike,
} from "jose";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  checkPublisherPolicy,
  claimPublisherPolicy,
  claimUploadTicket,
  exchangeOidcToken,
  findUploadTicket,
  getPublisherPolicy,
  GITHUB_OIDC_ISSUER,
  JWKS_MAX_STALE_SECONDS,
  bindScopesToRef,
  issueStaticCiToken,
  issueUploadTicket,
  listCiTokens,
  lookupCiToken,
  mintUploadCredentials,
  parseTicketObjects,
  pruneCiCredentials,
  publishAudience,
  r2Parent,
  releaseUploadTicket,
  revokeCiToken,
  stmtDeleteManifestPublisher,
  stmtUpsertManifestPublisher,
  ticketPrefix,
  UPLOAD_CREDENTIAL_ACTIONS,
  verifyGithubOidcToken,
  type GithubOidcClaims,
  type JwksFetcher,
  type PublisherPolicy,
} from "../src/core/publisher.js";
import { requireCiScope } from "../src/core/ciScope.js";
import { deleteProduct } from "../src/admin/repo.js";

const SLUG = "diceroll";
const ORIGIN = "https://key.example.test";
const AUD = publishAudience(ORIGIN, SLUG);
const REPO_ID = 123456789;
const OWNER_ID = 4242;

let key: { privateKey: KeyLike; publicKey: KeyLike };
let jwk: JWK;
let otherKey: { privateKey: KeyLike; publicKey: KeyLike };

beforeAll(async () => {
  key = await generateKeyPair("RS256");
  jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "gh-1",
    alg: "RS256",
    use: "sig",
  };
  otherKey = await generateKeyPair("RS256");
});

/** A GitHub Actions OIDC token's claims, as a protected release run would carry them. */
function goodClaims(over: Partial<GithubOidcClaims> = {}): GithubOidcClaims {
  return {
    sub: "repo:vladzaharia/diceroll:environment:release",
    repository: "vladzaharia/diceroll",
    repository_id: String(REPO_ID),
    repository_owner: "vladzaharia",
    repository_owner_id: String(OWNER_ID),
    job_workflow_ref:
      "vladzaharia/diceroll/.github/workflows/release.yml@refs/tags/v1.2.3",
    ref: "refs/tags/v1.2.3",
    ref_protected: "true",
    environment: "release",
    runner_environment: "github-hosted",
    event_name: "push",
    run_id: "987",
    ...over,
  };
}

let jtiCounter = 0;
async function ghToken(
  opts: {
    claims?: Partial<GithubOidcClaims>;
    aud?: string;
    iss?: string;
    iat?: number;
    exp?: number;
    kid?: string;
    signer?: KeyLike;
    jti?: string;
    alg?: string;
  } = {},
): Promise<string> {
  const iat = opts.iat ?? NOW - 10;
  return new SignJWT({ ...goodClaims(opts.claims) })
    .setProtectedHeader({
      alg: opts.alg ?? "RS256",
      typ: "JWT",
      kid: opts.kid ?? "gh-1",
    })
    .setIssuer(opts.iss ?? GITHUB_OIDC_ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(opts.exp ?? iat + 300)
    .setJti(opts.jti ?? `jti-${++jtiCounter}`)
    .sign(opts.signer ?? key.privateKey);
}

function fetcher(keys: () => JWK[]): JwksFetcher & { calls: number } {
  const f = (async () => {
    f.calls += 1;
    return { keys: keys() };
  }) as JwksFetcher & { calls: number };
  f.calls = 0;
  return f;
}

function policy(over: Partial<PublisherPolicy> = {}): PublisherPolicy {
  return {
    product: SLUG,
    provider: "github",
    repositoryId: REPO_ID,
    repositoryOwnerId: OWNER_ID,
    repository: "vladzaharia/diceroll",
    workflow: ".github/workflows/release.yml",
    environment: "release",
    scopes: ["distribution:report", "release:promote", "release:publish"],
    source: "manifest",
    createdAt: NOW,
    modifiedAt: NOW,
    modifiedBy: "manifest",
    ...over,
  };
}

let db: Db;
let env: Env;

async function seedPolicy(): Promise<void> {
  const s = stmtUpsertManifestPublisher({
    product: SLUG,
    repositoryId: REPO_ID,
    repositoryOwnerId: OWNER_ID,
    repository: "vladzaharia/diceroll",
    workflow: ".github/workflows/release.yml",
    environment: "release",
    now: NOW,
  });
  await db.run(s.sql, ...s.params);
}

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.KEY_HASH_PEPPER = "test-pepper";
  await seedProduct(db, SLUG);
  await seedProduct(db, "other");
});

// ── 1. Verification ──────────────────────────────────────────────────────────

describe("GitHub OIDC verification", () => {
  const verify = (
    token: string,
    f: JwksFetcher = fetcher(() => [jwk]),
    now = NOW,
  ) => verifyGithubOidcToken(env, token, { audience: AUD, now, fetchJwks: f });

  it("accepts a token GitHub's key signed for this product's audience", async () => {
    const res = await verify(await ghToken());
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.claims.repository_id).toBe(String(REPO_ID));
  });

  it("refuses the wrong audience (another product's, or the bare origin)", async () => {
    for (const aud of [publishAudience(ORIGIN, "other"), ORIGIN, "sigstore"]) {
      expect(await verify(await ghToken({ aud }))).toMatchObject({
        ok: false,
        reason: "invalid_oidc_token",
      });
    }
  });

  it("refuses any issuer but GitHub's — there is no setting that changes this", async () => {
    expect(
      await verify(
        await ghToken({ iss: "https://token.actions.evil.example" }),
      ),
    ).toMatchObject({ ok: false, message: "claim check failed: iss" });
  });

  it("refuses an expired token, allowing 60 s of skew", async () => {
    const token = await ghToken({ iat: NOW - 600, exp: NOW - 30 });
    expect(await verify(token)).toMatchObject({ ok: true }); // inside the skew
    const stale = await ghToken({ iat: NOW - 600, exp: NOW - 61 });
    expect(await verify(stale)).toMatchObject({
      ok: false,
      message: "token expired",
    });
  });

  it("refuses a token not yet valid beyond the skew", async () => {
    const future = await ghToken({ iat: NOW + 120, exp: NOW + 600 });
    expect(await verify(future)).toMatchObject({ ok: false });
  });

  it("refuses a token signed by a key that is not GitHub's, under GitHub's kid", async () => {
    expect(
      await verify(await ghToken({ signer: otherKey.privateKey })),
    ).toMatchObject({ ok: false, message: "signature verification failed" });
  });

  it("refuses any alg but RS256", async () => {
    const hs = await new SignJWT({ ...goodClaims() })
      .setProtectedHeader({ alg: "HS256", kid: "gh-1" })
      .setIssuer(GITHUB_OIDC_ISSUER)
      .setAudience(AUD)
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 300)
      .setJti("hs")
      .sign(new TextEncoder().encode("x".repeat(32)));
    expect(await verify(hs)).toMatchObject({
      ok: false,
      message: "alg must be RS256",
    });
    const none = `${btoa(JSON.stringify({ alg: "none", kid: "gh-1" }))}.${btoa(JSON.stringify(goodClaims()))}.`;
    expect(await verify(none)).toMatchObject({ ok: false });
  });

  it("caches the JWKS in KV and does not refetch for a known kid", async () => {
    const f = fetcher(() => [jwk]);
    expect(await verify(await ghToken(), f)).toMatchObject({ ok: true });
    expect(await verify(await ghToken(), f)).toMatchObject({ ok: true });
    expect(f.calls).toBe(1);
    // An hour later the cache is stale and is refreshed once.
    expect(
      await verify(await ghToken({ iat: NOW + 3600 }), f, NOW + 3601),
    ).toMatchObject({ ok: true });
    expect(f.calls).toBe(2);
  });

  it("does not honour a cached key set older than the stale cap when GitHub is down", async () => {
    const up = fetcher(() => [jwk]);
    expect(await verify(await ghToken(), up)).toMatchObject({ ok: true });
    const down: JwksFetcher = async () => {
      throw new Error("outage");
    };
    const later = NOW + JWKS_MAX_STALE_SECONDS - 100;
    expect(
      await verify(await ghToken({ iat: later - 10 }), down, later),
    ).toMatchObject({ ok: true });
    const tooLate = NOW + JWKS_MAX_STALE_SECONDS + 100;
    expect(
      await verify(await ghToken({ iat: tooLate - 10 }), down, tooLate),
    ).toMatchObject({ ok: false, reason: "invalid_oidc_token" });
  });

  it("refetches on an unknown kid (key rotation), at most once a minute", async () => {
    let keys = [jwk];
    const f = fetcher(() => keys);
    expect(await verify(await ghToken(), f)).toMatchObject({ ok: true });
    // GitHub rotates in gh-2; a token signed with it names a kid the cache does not have.
    const rotated = {
      ...(await exportJWK(otherKey.publicKey)),
      kid: "gh-2",
      alg: "RS256",
    };
    keys = [jwk, rotated];
    const t2 = await ghToken({ kid: "gh-2", signer: otherKey.privateKey });
    // Inside the minute: no refetch, refused.
    expect(await verify(t2, f, NOW + 30)).toMatchObject({
      ok: false,
      message: "unknown signing key",
    });
    expect(f.calls).toBe(1);
    // After the minute: one refetch, accepted.
    expect(await verify(t2, f, NOW + 61)).toMatchObject({ ok: true });
    expect(f.calls).toBe(2);
    // A flood of made-up kids right after costs no further fetches.
    for (let i = 0; i < 5; i++)
      await verify(await ghToken({ kid: `bogus-${i}` }), f, NOW + 62);
    expect(f.calls).toBe(2);
  });

  it("a JWKS fetch failure is a refusal, not a throw", async () => {
    const failing: JwksFetcher = async () => {
      throw new Error("down");
    };
    expect(await verify(await ghToken(), failing as never)).toMatchObject({
      ok: false,
      message: "unknown signing key",
    });
  });
});

// ── 2. The policy ────────────────────────────────────────────────────────────

describe("publisher policy checks (each one refuses)", () => {
  it("accepts the run the policy describes", () => {
    expect(checkPublisherPolicy(policy(), goodClaims())).toEqual({ ok: true });
    // release and workflow_dispatch are allowed too; env names compare case-insensitively.
    for (const event_name of ["release", "workflow_dispatch"])
      expect(
        checkPublisherPolicy(policy(), goodClaims({ event_name })),
      ).toEqual({ ok: true });
    expect(
      checkPublisherPolicy(policy(), goodClaims({ environment: "Release" })),
    ).toEqual({ ok: true });
  });

  const cases: Array<[string, Partial<GithubOidcClaims>, string]> = [
    [
      "wrong repository_id (a recycled name)",
      { repository_id: "1" },
      "repository_id",
    ],
    [
      "non-numeric repository_id",
      { repository_id: `${REPO_ID}x` },
      "repository_id",
    ],
    [
      "wrong repository_owner_id",
      { repository_owner_id: "99" },
      "repository_owner_id",
    ],
    [
      "another workflow file",
      {
        job_workflow_ref:
          "vladzaharia/diceroll/.github/workflows/ci.yml@refs/tags/v1.2.3",
      },
      "job_workflow_ref",
    ],
    [
      "a reusable workflow in another repository",
      {
        job_workflow_ref:
          "evil/shared/.github/workflows/release.yml@refs/tags/v1.2.3",
      },
      "job_workflow_ref",
    ],
    [
      "the workflow taken from another ref",
      {
        job_workflow_ref:
          "vladzaharia/diceroll/.github/workflows/release.yml@refs/heads/feature",
      },
      "job_workflow_ref",
    ],
    [
      "no job_workflow_ref",
      { job_workflow_ref: undefined },
      "job_workflow_ref",
    ],
    ["another environment", { environment: "staging" }, "environment"],
    ["no environment", { environment: undefined }, "environment"],
    ["an unprotected ref", { ref_protected: "false" }, "ref_protected"],
    [
      "a self-hosted runner",
      { runner_environment: "self-hosted" },
      "runner_environment",
    ],
    ["a pull_request event", { event_name: "pull_request" }, "event_name"],
    [
      "a pull_request_target event",
      { event_name: "pull_request_target" },
      "event_name",
    ],
  ];
  for (const [name, over, claim] of cases) {
    it(`refuses ${name}`, () => {
      expect(checkPublisherPolicy(policy(), goodClaims(over))).toMatchObject({
        ok: false,
        claim,
      });
    });
  }
});

// ── 3. The exchange ──────────────────────────────────────────────────────────

describe("exchangeOidcToken", () => {
  const exchange = (oidcToken: string, product = SLUG) =>
    exchangeOidcToken(env, db, {
      product,
      oidcToken,
      audience: publishAudience(ORIGIN, product),
      now: NOW,
      fetchJwks: fetcher(() => [jwk]),
    });

  it("mints a 30-minute pkeyci_ token with the policy's scopes, stored only as a hash", async () => {
    await seedPolicy();
    const res = await exchange(await ghToken());
    expect(res).toMatchObject({
      ok: true,
      expiresAt: NOW + 1800,
      scopes: ["distribution:report", "release:promote", "release:publish"],
    });
    if (!res.ok) return;
    expect(res.token).toMatch(/^pkeyci_[A-Za-z0-9_-]{43}$/);
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM ci_tokens",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(res.token);
    expect(rows[0]).toMatchObject({ kind: "oidc", product: SLUG });
    const principal = await lookupCiToken(env, db, res.token, NOW + 60);
    expect(principal).toMatchObject({
      product: SLUG,
      subject: "github:repo:vladzaharia/diceroll:environment:release#run:987",
    });
    expect(await lookupCiToken(env, db, res.token, NOW + 1800)).toBeNull();
    const audit = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ?",
      SLUG,
    );
    expect(audit.map((a) => a.action)).toContain("ci.token.exchange");
  });

  it("a branch run's token cannot promote or yank; a tag run's can", async () => {
    await seedPolicy();
    const branch = await exchange(
      await ghToken({
        claims: {
          ref: "refs/heads/main",
          job_workflow_ref:
            "vladzaharia/diceroll/.github/workflows/release.yml@refs/heads/main",
        },
      }),
    );
    expect(branch).toMatchObject({
      ok: true,
      scopes: ["distribution:report", "release:publish"],
    });
    const tag = await exchange(await ghToken());
    expect(tag).toMatchObject({ ok: true });
    if (tag.ok) expect(tag.scopes).toContain("release:promote");
  });

  it("mints for branches and tags only, and the platform's own product for main or a semver tag", async () => {
    expect(bindScopesToRef("diceroll", "refs/pull/1/merge", ["x"]).ok).toBe(
      false,
    );
    for (const ref of [
      "refs/heads/feature",
      "refs/tags/vanything",
      "refs/heads/main2",
    ])
      expect(bindScopesToRef(SYSTEM_PRODUCT_SLUG, ref, ["x"]).ok).toBe(false);
    for (const ref of ["refs/heads/main", "refs/tags/v1.2.3-rc.1"])
      expect(bindScopesToRef(SYSTEM_PRODUCT_SLUG, ref, ["x"]).ok).toBe(true);
  });

  it("is single-use: a replayed jti fails in D1, however the requests race", async () => {
    await seedPolicy();
    const token = await ghToken({ jti: "replayed" });
    const [a, b] = await Promise.all([exchange(token), exchange(token)]);
    const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.reason)).sort();
    expect(outcomes).toEqual(["oidc_token_replayed", "ok"]);
    expect(await exchange(token)).toMatchObject({
      ok: false,
      status: 401,
      reason: "oidc_token_replayed",
    });
    expect(await db.all("SELECT * FROM ci_tokens")).toHaveLength(1);
  });

  it("refuses a product with no publisher policy", async () => {
    expect(await exchange(await ghToken())).toMatchObject({
      ok: false,
      status: 403,
      reason: "publisher_not_configured",
    });
  });

  it("refuses a policy mismatch with the claim, and writes no token", async () => {
    await seedPolicy();
    expect(
      await exchange(await ghToken({ claims: { environment: "dev" } })),
    ).toMatchObject({
      ok: false,
      status: 403,
      reason: "policy_mismatch",
      claim: "environment",
    });
    expect(await db.all("SELECT * FROM ci_tokens")).toHaveLength(0);
  });

  it("a token for this product's audience cannot be exchanged at another product", async () => {
    await seedPolicy();
    const token = await ghToken(); // aud = diceroll's
    expect(await exchange(token, "other")).toMatchObject({
      ok: false,
      status: 401,
      reason: "invalid_oidc_token",
    });
  });
});

// ── 4. Tokens ────────────────────────────────────────────────────────────────

async function staticToken(
  scopes: string[] = ["release:publish"],
  product = SLUG,
  expiresAt = NOW + 86400,
) {
  return issueStaticCiToken(env, db, {
    product,
    scopes,
    expiresAt,
    label: "buildkite",
    createdBy: "u1",
    now: NOW,
  });
}

describe("pkeyci_ tokens", () => {
  it("a static token resolves to its product, subject and scopes until it expires", async () => {
    const t = await staticToken();
    expect(await lookupCiToken(env, db, t.token, NOW)).toMatchObject({
      product: SLUG,
      subject: `static:${t.tokenId}`,
      scopes: ["release:publish"],
      kind: "static",
    });
    expect(await lookupCiToken(env, db, t.token, NOW + 86400)).toBeNull();
  });

  it("a revoked token is refused, and listing never shows a hash or a token", async () => {
    const t = await staticToken();
    expect(await revokeCiToken(db, SLUG, t.tokenId, NOW + 1)).toBe(true);
    expect(await lookupCiToken(env, db, t.token, NOW + 2)).toBeNull();
    expect(await revokeCiToken(db, SLUG, t.tokenId, NOW + 3)).toBe(false);
    const list = await listCiTokens(db, SLUG);
    expect(list).toEqual([
      expect.objectContaining({ tokenId: t.tokenId, revokedAt: NOW + 1 }),
    ]);
    expect(JSON.stringify(list)).not.toMatch(/token_hash|pkeyci_/);
  });

  it("another product's revocation call cannot revoke this product's token", async () => {
    const t = await staticToken();
    expect(await revokeCiToken(db, "other", t.tokenId, NOW)).toBe(false);
    expect(await lookupCiToken(env, db, t.token, NOW)).not.toBeNull();
  });

  it("deleting the product revokes every token", async () => {
    const t = await staticToken();
    await deleteProduct(db, SLUG, NOW + 5);
    expect(await lookupCiToken(env, db, t.token, NOW + 6)).toBeNull();
  });

  it("malformed and unknown tokens are null without a query hit", async () => {
    expect(await lookupCiToken(env, db, "pkeyci_short", NOW)).toBeNull();
    expect(
      await lookupCiToken(env, db, `pkeyci_${"a".repeat(43)}`, NOW),
    ).toBeNull();
    expect(
      await lookupCiToken(env, db, `pkeyt_${"a".repeat(43)}`, NOW),
    ).toBeNull();
  });

  it("requireCiScope: 401 for another product's token, 403 for a missing scope", async () => {
    const t = await staticToken(["release:promote"]);
    const req = (token: string) =>
      new Request(`${ORIGIN}/x`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const wrongProduct = await requireCiScope(
      req(t.token),
      env,
      db,
      "other",
      "release:promote",
      NOW,
    );
    expect(wrongProduct).toBeInstanceOf(Response);
    expect((wrongProduct as Response).status).toBe(401);
    const noScope = await requireCiScope(
      req(t.token),
      env,
      db,
      SLUG,
      "release:publish",
      NOW,
    );
    expect((noScope as Response).status).toBe(403);
    expect(await (noScope as Response).json()).toMatchObject({
      reason: "missing_scope",
      scope: "release:publish",
    });
    const ok = await requireCiScope(
      req(t.token),
      env,
      db,
      SLUG,
      "release:promote",
      NOW,
    );
    expect(ok).toMatchObject({ product: SLUG });
  });

  it("the nightly prune drops tokens and tickets a day past expiry", async () => {
    const t = await staticToken(["release:publish"], SLUG, NOW + 10);
    const rec = (await lookupCiToken(env, db, t.token, NOW))!;
    await issueUploadTicket(env, db, {
      product: SLUG,
      holder: rec,
      objects: [{ sha256: "a".repeat(64), size: 1, gated: false }],
      now: NOW,
    });
    expect(await pruneCiCredentials(db, SLUG, NOW + 100)).toBe(0);
    expect(await pruneCiCredentials(db, SLUG, NOW + 86400 + 11)).toBe(2);
  });
});

// ── 5. Tickets and credentials ───────────────────────────────────────────────

const HEX = "ab".repeat(32);

describe("upload tickets", () => {
  it("parses objects strictly", () => {
    expect(parseTicketObjects([{ sha256: HEX, size: 3 }])).toEqual([
      { sha256: HEX, size: 3, gated: false },
    ]);
    for (const bad of [
      [],
      "x",
      [{ sha256: HEX.toUpperCase(), size: 1 }],
      [{ sha256: HEX, size: -1 }],
      [{ sha256: HEX, size: 1.5 }],
      [{ sha256: HEX, size: 6 * 1024 ** 3 }],
      [{ sha256: HEX, size: 1, gated: "yes" }],
      [
        { sha256: HEX, size: 1 },
        { sha256: HEX, size: 2 },
      ],
      Array.from({ length: 257 }, (_, i) => ({
        sha256: i.toString(16).padStart(64, "0"),
        size: 1,
      })),
    ])
      expect(parseTicketObjects(bad)).toHaveProperty("error");
  });

  async function holder(product = SLUG, expiresAt = NOW + 1800) {
    const t = await staticToken(["release:publish"], product, expiresAt);
    return { t, rec: (await lookupCiToken(env, db, t.token, NOW))! };
  }

  it("expires with its token, and within an hour", async () => {
    const short = await holder(SLUG, NOW + 600);
    const a = await issueUploadTicket(env, db, {
      product: SLUG,
      holder: short.rec,
      objects: [{ sha256: HEX, size: 1, gated: false }],
      now: NOW,
    });
    expect(a.expiresAt).toBe(NOW + 600);
    const long = await holder(SLUG, NOW + 86400);
    const b = await issueUploadTicket(env, db, {
      product: SLUG,
      holder: long.rec,
      objects: [{ sha256: HEX, size: 1, gated: false }],
      now: NOW,
    });
    expect(b.expiresAt).toBe(NOW + 3600);
    expect(b.ticketId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b.ticket).not.toContain(b.ticketId);
  });

  it("is found only by its own product and token; claimed once; given back on failure", async () => {
    const h = await holder();
    const issued = await issueUploadTicket(env, db, {
      product: SLUG,
      holder: h.rec,
      objects: [{ sha256: HEX, size: 1, gated: false }],
      now: NOW,
    });
    const find = (product: string, tokenHash: string, now = NOW) =>
      findUploadTicket(env, db, {
        ticket: issued.ticket,
        product,
        holder: { tokenHash },
        now,
      });
    const found = await find(SLUG, h.rec.tokenHash);
    expect(found).toMatchObject({ ok: true });
    // Another product's token, or another token of this product: indistinguishable from unknown.
    const other = await holder("other");
    expect(await find("other", other.rec.tokenHash)).toMatchObject({
      ok: false,
      reason: "invalid_ticket",
    });
    const sibling = await holder();
    expect(await find(SLUG, sibling.rec.tokenHash)).toMatchObject({
      ok: false,
      reason: "invalid_ticket",
    });
    expect(await find(SLUG, h.rec.tokenHash, NOW + 1800)).toMatchObject({
      ok: false,
      reason: "ticket_expired",
    });

    if (!found.ok) return;
    const hash = found.ticket.ticketHash;
    const claims = await Promise.all([
      claimUploadTicket(db, hash, NOW),
      claimUploadTicket(db, hash, NOW),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await find(SLUG, h.rec.tokenHash)).toMatchObject({
      ok: false,
      status: 409,
      reason: "ticket_redeemed",
    });
    await releaseUploadTicket(db, hash, NOW);
    expect(await find(SLUG, h.rec.tokenHash)).toMatchObject({ ok: true });
  });

  it("revoking the token ends its unredeemed tickets", async () => {
    const h = await holder();
    const issued = await issueUploadTicket(env, db, {
      product: SLUG,
      holder: h.rec,
      objects: [{ sha256: HEX, size: 1, gated: false }],
      now: NOW,
    });
    await revokeCiToken(db, SLUG, h.t.tokenId, NOW + 1);
    expect(
      await findUploadTicket(env, db, {
        ticket: issued.ticket,
        product: SLUG,
        holder: h.rec,
        now: NOW + 2,
      }),
    ).toMatchObject({ ok: false, reason: "ticket_expired" });
  });
});

/**
 * R2's documented authorisation of a temporary credential (developers.cloudflare.com, "R2
 * temporary credentials"): the request's action must be in `actions` (when present), and the key
 * must start with a `prefixPaths` entry or equal an `objectPaths` entry. A copy reads its SOURCE,
 * so a `CopyObject`/`UploadPartCopy` needs that action AND the source key in scope. One rule is
 * measured, not documented: real R2 refuses a token naming BOTH `scope` and `actions` (400
 * `InvalidArgument` / `X-Amz-Security-Token` on every request; probed against the prod bucket,
 * 2026-10-04), so the model refuses it too.
 */
function r2Allows(
  claims: Record<string, unknown>,
  bucket: string,
  action: string,
  key: string,
  copySource?: string,
): boolean {
  if (claims.bucket !== bucket) return false;
  if (claims.scope !== undefined && claims.actions !== undefined) return false;
  const actions = claims.actions as string[] | undefined;
  if (actions && !actions.includes(action)) return false;
  const paths = claims.paths as {
    prefixPaths: string[];
    objectPaths: string[];
  };
  const inScope = (k: string) =>
    paths.prefixPaths.some((p) => k.startsWith(p)) ||
    paths.objectPaths.includes(k);
  if (!inScope(key)) return false;
  if (copySource !== undefined && !inScope(copySource)) return false;
  return true;
}

describe("R2 temporary credentials", () => {
  const PARENT = {
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "parentkeyid",
    secretAccessKey: "parent-secret-access-key",
    bucket: "polaris-key-blobs-test",
  };
  const prefix = ticketPrefix(SLUG, "TICKET_123");

  it("r2Parent needs all four values (else the uploads route is not-found)", () => {
    expect(r2Parent(env)).toBeNull();
    env.R2_ACCOUNT_ID = PARENT.accountId;
    env.R2_PARENT_ACCESS_KEY_ID = PARENT.accessKeyId;
    env.R2_PARENT_SECRET_ACCESS_KEY = PARENT.secretAccessKey;
    expect(r2Parent(env)).toBeNull();
    env.BLOBS_BUCKET_NAME = PARENT.bucket;
    expect(r2Parent(env)).toEqual(PARENT);
  });

  it("are Cloudflare's local-signing shape, signed with the parent secret", async () => {
    const c = await mintUploadCredentials(PARENT, prefix, NOW, NOW + 900);
    expect(c.endpoint).toBe(
      `https://${PARENT.accountId}.r2.cloudflarestorage.com`,
    );
    expect(c.accessKeyId).toBe(PARENT.accessKeyId);
    expect(c.expiresAt).toBe(NOW + 900);
    const jwt = atob(c.sessionToken).replace(/^jwt\//, "");
    expect(atob(c.sessionToken).startsWith("jwt/")).toBe(true);
    expect(c.secretAccessKey).toBe(
      createHash("sha256").update(jwt).digest("hex"),
    );
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "HS256", typ: "JWT" });
    const { payload } = await jwtVerify(
      jwt,
      new TextEncoder().encode(PARENT.secretAccessKey),
      { currentDate: new Date(NOW * 1000) },
    );
    expect(payload).toMatchObject({
      bucket: PARENT.bucket,
      sub: PARENT.accountId,
      iss: PARENT.accessKeyId,
      aud: `${PARENT.accountId}.r2.cloudflarestorage.com`,
      iat: NOW,
      exp: NOW + 900,
    });
    // `actions` without `scope`: R2 refuses a session token that names both (400
    // InvalidArgument X-Amz-Security-Token, the v0.8.17 publish failure).
    expect(payload.actions).toEqual([...UPLOAD_CREDENTIAL_ACTIONS]);
    expect(payload).not.toHaveProperty("scope");
    // The secret never appears in what CI receives.
    expect(JSON.stringify(c)).not.toContain(PARENT.secretAccessKey);
  });

  it("can write only the ticket's own prefix — and cannot read or copy from anywhere", async () => {
    const c = await mintUploadCredentials(PARENT, prefix, NOW, NOW + 900);
    const claims = decodeJwt(atob(c.sessionToken).replace(/^jwt\//, ""));
    expect(claims.actions).toEqual([...UPLOAD_CREDENTIAL_ACTIONS]);
    expect(claims.actions).toEqual(["PutObject", "HeadObject"]);
    expect(claims.paths).toEqual({ prefixPaths: [prefix], objectPaths: [] });

    const B = PARENT.bucket;
    const own = `${prefix}${HEX}`;
    expect(r2Allows(claims, B, "PutObject", own)).toBe(true);
    expect(r2Allows(claims, B, "HeadObject", own)).toBe(true);

    const elsewhere = [
      `blobs/sha256/${HEX}`,
      `gated/blobs/sha256/${HEX}`,
      `bundles/sha256/${HEX}`,
      `staging/${SLUG}/OTHER_TICKET/${HEX}`,
      `staging/other/TICKET_123/${HEX}`,
      `staging/${SLUG}/TICKET_1234/${HEX}`, // a sibling ticket id that shares a prefix
    ];
    for (const k of elsewhere) {
      expect(r2Allows(claims, B, "PutObject", k), k).toBe(false);
      expect(r2Allows(claims, B, "HeadObject", k), k).toBe(false);
    }
    // No read of any object, not even its own; no listing; no delete.
    for (const action of [
      "GetObject",
      "ListObjectsV2",
      "ListObjectsV1",
      "DeleteObject",
      "DeleteObjects",
    ])
      expect(r2Allows(claims, B, action, own), action).toBe(false);
    // No copy INTO the prefix from a locked or other-product key — the attack that would carry
    // another product's stored checksum across (THREAT-MODEL §3) — and no copy at all.
    for (const src of [
      `gated/blobs/sha256/${HEX}`,
      `staging/other/T/${HEX}`,
      own,
    ]) {
      expect(r2Allows(claims, B, "CopyObject", own, src), src).toBe(false);
      expect(r2Allows(claims, B, "UploadPartCopy", own, src), src).toBe(false);
    }
    // No multipart (its stored checksum is not the object's SHA-256).
    for (const action of [
      "CreateMultipartUpload",
      "UploadPart",
      "CompleteMultipartUpload",
    ])
      expect(r2Allows(claims, B, action, own), action).toBe(false);
    // Another bucket.
    expect(r2Allows(claims, "polaris-key-blobs-prod", "PutObject", own)).toBe(
      false,
    );
  });

  it("refuses to scope a credential to anything but a staging prefix", async () => {
    for (const p of [
      "blobs/",
      "gated/",
      "",
      "staging/",
      `staging/${SLUG}/`,
      `staging/${SLUG}/t/x/`,
    ])
      await expect(
        mintUploadCredentials(PARENT, p, NOW, NOW + 60),
      ).rejects.toThrow();
  });
});

// ── The policy row: manifest ownership and operator claims ───────────────────

describe("ci_publishers ownership", () => {
  it("a manifest upsert never overwrites an operator's claim; delete spares it too", async () => {
    await seedPolicy();
    const claimed = await claimPublisherPolicy(
      db,
      SLUG,
      { environment: "prod", scopes: ["release:publish", "release:yank"] },
      "u1",
      NOW + 1,
    );
    expect(claimed).toMatchObject({ source: "admin", environment: "prod" });
    const s = stmtUpsertManifestPublisher({
      product: SLUG,
      repositoryId: 1,
      repositoryOwnerId: 2,
      repository: "evil/repo",
      workflow: ".github/workflows/x.yml",
      environment: "release",
      now: NOW + 2,
    });
    await db.run(s.sql, ...s.params);
    const d = stmtDeleteManifestPublisher(SLUG);
    await db.run(d.sql, ...d.params);
    expect(await getPublisherPolicy(db, SLUG)).toMatchObject({
      source: "admin",
      repositoryId: REPO_ID,
      environment: "prod",
      scopes: ["release:publish", "release:yank"],
    });
  });

  it("a manifest upsert keeps the scopes an operator never set to the default", async () => {
    await seedPolicy();
    expect((await getPublisherPolicy(db, SLUG))!.scopes).toEqual([
      "distribution:report",
      "release:promote",
      "release:publish",
    ]);
  });

  it("claiming with no policy needs the repository fields", async () => {
    expect(
      await claimPublisherPolicy(
        db,
        SLUG,
        { workflow: ".github/workflows/r.yml" },
        "u1",
        NOW,
      ),
    ).toHaveProperty("error");
  });
});
