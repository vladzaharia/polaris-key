/**
 * R10 — Denial of service / resource exhaustion / availability.
 *
 * Every test here is an ATTACK proof, not a regression test. They are expected to FAIL
 * once the corresponding finding in docs/security/findings/R10-dos.md is fixed; each
 * assertion documents the vulnerable behaviour it pins.
 *
 * NOTE ON WORKERD: vitest runs in Node, where the dynamic Function constructor works.
 * workerd forbids dynamic code generation outside the startup window (compat flag
 * `allow_eval_during_startup`, default 2025-06-01 — startup ONLY). Tests that model the
 * production runtime install a `globalThis.Function` proxy that throws the same
 * `EvalError: Code generation from strings disallowed for this context` workerd throws.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  DJDL_CATALOG,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../seed.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import type { Env } from "../../src/env.js";
import type { Db } from "../../src/db/types.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import { Catalog } from "@polaris-key/catalog";
import { handleActivate } from "../../src/services/license/activation.js";
// Wire v3 split the fused `GET /<p>/config` into two signed documents. The catalog-validation
// lane below belongs to the CONFIG document (it is the one that prunes `config`/`secrets`
// against the catalog); the cost/metadata lanes use the LICENSE document, which does the same
// auth + merge + sign work and additionally runs the build gate.
import { handleConfigDocument } from "../../src/services/config/document.js";
import { handleLicenseDocument } from "../../src/services/license/document.js";
import { handleCatalog as handleAdminCatalog } from "../../src/services/config/admin/catalog.js";
import { handleReleaseSurface as handleRelease } from "../releaseSurface.js";
import { matchRoute } from "../../src/router.js";
import {
  clientIp,
  rateLimitOk,
  rateLimitShardName,
  RL_SHARDS,
} from "../../src/core/rateLimit.js";
import { RateLimitDO } from "../../src/rateLimitDo.js";
import { makeRlNamespace } from "../rlMock.js";
import { handleGithubWebhook } from "../../src/githubWebhook.js";
import {
  handleAuthDeviceStart,
  handleAuthStart,
} from "../../src/services/identity/oidc.js";
import {
  resolveChannel,
  type ChannelSelector,
} from "../../src/services/release/channels.js";
import {
  fetchTextAsset,
  MAX_TEXT_ASSET_BYTES,
  type Release,
  type ReleaseAsset,
} from "../../src/services/release/github.js";
import type { FetchImpl } from "../../src/services/release/githubApp.js";
import type { AdminSession } from "../../src/admin/session.js";
import { getDevice, upsertDevice } from "../../src/repo.js";
import { hashKey } from "../../src/crypto.js";
import { getTokenRecord, TOKEN_RECORD_TTL_SECONDS } from "../../src/kv.js";
import {
  MAX_DEVICE_METADATA_CHARS,
  validateDeviceToken,
} from "../../src/core/devices.js";
import { handleMagicStart } from "../../src/services/identity/portal/auth.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../../src/fingerprint.js";
import { DEFAULT_SERVICES } from "../../src/core/services.js";

// ── workerd codegen emulation ────────────────────────────────────────────────

const EVAL_MSG = "Code generation from strings disallowed for this context";

/** Run `fn` with the dynamic Function constructor disabled, as workerd does at request time. */
async function withoutCodegen<T>(fn: () => Promise<T> | T): Promise<T> {
  const real = globalThis.Function;
  globalThis.Function = new Proxy(real, {
    construct() {
      throw new EvalError(EVAL_MSG);
    },
    apply() {
      throw new EvalError(EVAL_MSG);
    },
  }) as FunctionConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Function = real;
  }
}

/** Count dynamic Function-constructor invocations performed by `fn`. */
async function countCodegen<T>(
  fn: () => Promise<T> | T,
): Promise<{ result: T; codegen: number }> {
  const real = globalThis.Function;
  let codegen = 0;
  globalThis.Function = new Proxy(real, {
    construct(target, args: unknown[]) {
      codegen++;
      return Reflect.construct(target, args as never[]);
    },
  }) as FunctionConstructor;
  try {
    return { result: await fn(), codegen };
  } finally {
    globalThis.Function = real;
  }
}

// ── shared fixtures ──────────────────────────────────────────────────────────

async function seedRealCatalogProduct(): Promise<{
  db: SqliteDb;
  kv: KvMock;
  env: Env;
  product: Product;
}> {
  const db = makeTestDb();
  const kv = new KvMock();
  const env = makeEnv(kv, ["djdl"]);
  await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
  const product = (await loadProduct(env, db, "djdl")) as Product;
  return { db, kv, env, product };
}

async function activate(
  env: Env,
  db: Db,
  product: Product,
  key: string,
  device: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": device,
      ...extraHeaders,
    }),
    env,
    db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

// ═════════════════════════════════════════════════════════════════════════════
// R10-01 — Ajv codegen on the config-document hot path ⇒ guaranteed 500 on workerd
// ═════════════════════════════════════════════════════════════════════════════

// FIXED (R10-01): `@polaris-key/catalog` interprets schema fragments instead of compiling
// them, so nothing on this path constructs a function from a string. These five assertions
// are the originals INVERTED — each now pins the fixed behaviour it used to disprove. The
// `withoutCodegen` harness is retained deliberately: it is what makes these Node tests
// meaningful about workerd. See the workerd re-verification in R10-dos.md §Remediation.
describe("R10-01 catalog validation no longer generates code at request time", () => {
  it("GET /<product>/config/document performs ZERO dynamic codegen", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const { result, codegen } = await countCodegen(() =>
      handleConfigDocument(
        mkReq("GET", { authorization: `Bearer ${token}` }),
        env,
        db,
        product,
        NOW,
      ),
    );
    expect(result.status).toBe(200);
    // Was >= 16 (one Ajv compile per djdl config entry carrying a default).
    expect(codegen).toBe(0);
  });

  it("a second identical request also compiles nothing", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    const call = () =>
      handleConfigDocument(
        mkReq("GET", { authorization: `Bearer ${token}` }),
        env,
        db,
        product,
        NOW,
      );

    const first = await countCodegen(call);
    const second = await countCodegen(call);
    expect(first.codegen).toBe(0);
    expect(second.codegen).toBe(0);
  });

  it("with codegen disabled (as workerd does) GET /config/document still returns a signed 200", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const res = await withoutCodegen(() =>
      handleConfigDocument(
        mkReq("GET", { authorization: `Bearer ${token}` }),
        env,
        db,
        product,
        NOW,
      ),
    );
    expect(res.status).toBe(200);
    // A compact JWS, not the `catalog_unavailable` error body.
    const body = await res.text();
    expect(body.split(".")).toHaveLength(3);
  });

  it("with codegen disabled, the defence-in-depth prune still runs (it does not fail open)", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    // A license override that violates the djdl catalog (run.concurrency is 1..8) plus one
    // that satisfies it, so we can tell "pruned" apart from "everything dropped".
    const { key } = await seedLicenseWithKey(db, "djdl", {
      config: {
        "run.concurrency": { state: "enforced", value: 9999, updatedAt: NOW },
        "ui.theme": { state: "enforced", value: "light", updatedAt: NOW },
      },
    });
    const token = await activate(env, db, product, key, "dev-1");

    const res = await withoutCodegen(() =>
      handleConfigDocument(
        mkReq("GET", { authorization: `Bearer ${token}` }),
        env,
        db,
        product,
        NOW,
      ),
    );
    expect(res.status).toBe(200);
    const claims = JSON.parse(
      Buffer.from(
        (await res.text()).split(".")[1] as string,
        "base64url",
      ).toString(),
    ) as { config: Record<string, { value: unknown }> };
    // The out-of-range override never reaches the signed doc…
    expect(claims.config["run.concurrency"]?.value).not.toBe(9999);
    // …while a schema-valid override on the same request does.
    expect(claims.config["ui.theme"]?.value).toBe("light");
  });

  it("with codegen disabled, publishing a catalog via the admin API succeeds", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    const session = {
      sub: "s",
      name: "a",
      email: "a@b.c",
      groups: [],
      csrf: "x",
    } as unknown as AdminSession;
    const body = JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          key: "a.b",
          kind: "config",
          category: "c",
          label: "l",
          schema: { type: "string" },
        },
      ],
    });
    const req = new Request("https://k/x", {
      method: "PUT",
      body,
    }) as unknown as Request;

    // §R1 moved catalog publishing under Config (`config/catalog`), so the handler now takes the
    // service context the descriptor is dispatched with. This lane measures the COMPILER, not the
    // dispatcher, so it is called directly with the two fields it reads.
    const res = await withoutCodegen(() =>
      handleAdminCatalog({
        req,
        env: {} as Env,
        db,
        product: { slug: "djdl" } as Product,
        rest: ["catalog"],
        now: NOW,
        session,
      }),
    );
    expect(res.status).toBe(200); // was 422
  });

  it("a trivial {type:'string'} fragment validates with no codegen at all", async () => {
    const catalog = new Catalog({
      schemaVersion: 1,
      entries: [
        {
          key: "k",
          kind: "config",
          category: "c",
          label: "l",
          schema: { type: "string" },
        },
      ],
    } as never);
    const res = await withoutCodegen(() =>
      catalog.validateKeyValue("k", "hello"),
    );
    expect(res.ok).toBe(true);
    const bad = await withoutCodegen(() => catalog.validateKeyValue("k", 42));
    expect(bad.ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-01 / R10-09 knock-on — fixing the codegen bug makes server-side `pattern`
// reachable for the first time, so the ReDoS cap ships with it, not after it.
// ═════════════════════════════════════════════════════════════════════════════

describe("R10-01 knock-on: catalog `pattern` cannot be turned into a CPU bomb", () => {
  const evilCatalog = (pattern: string) =>
    ({
      schemaVersion: 1,
      entries: [
        {
          key: "evil",
          kind: "config",
          category: "c",
          label: "l",
          description: "",
          schema: { type: "string", pattern },
        },
      ],
    }) as never;

  // The exact pattern R10-09 measured at 57 s against a 34-character input, and only
  // 8 characters long — proving `channels.ts`'s 80-char MAX_REGEX_SOURCE is not a guard.
  // The catalog is not rejected (the pattern is legitimate JSON Schema); it is defused,
  // because the matcher backing `pattern` cannot backtrack.
  it("`(x+x+)+y` is accepted but costs no more than a linear scan", () => {
    const catalog = new Catalog(evilCatalog("(x+x+)+y"));
    expect(() => catalog.compileAll()).not.toThrow();

    const t0 = Date.now();
    const res = catalog.validateKeyValue("evil", "x".repeat(34));
    const ms = Date.now() - t0;
    expect(res.ok).toBe(false); // no `y`, so genuinely no match
    expect(ms).toBeLessThan(250); // was ~57_000ms with a backtracking engine
  }, 20_000);

  it("its cost grows linearly, not exponentially, with the input length", () => {
    const catalog = new Catalog(evilCatalog("(x+x+)+y"));
    const time = (n: number): number => {
      const t0 = Date.now();
      catalog.validateKeyValue("evil", "x".repeat(n));
      return Date.now() - t0;
    };
    // Under Ajv each extra character doubled the runtime. 28 -> 40 is 4096x there.
    expect(time(28)).toBeLessThan(250);
    expect(time(40)).toBeLessThan(250);
    expect(time(4000)).toBeLessThan(250);
  }, 20_000);

  it("constructs that cannot be matched linearly are refused at publish time", () => {
    // Backreferences and lookaround force backtracking, so they are rejected outright
    // rather than handed to an engine that would.
    for (const pattern of ["(a+)\\1", "(?=(a+)+b)a", "(?<=aa)b"]) {
      expect(() => new Catalog(evilCatalog(pattern)).compileAll()).toThrow(
        /not supported|unsupported/i,
      );
      // …and a stored catalog carrying one fails values closed, never open.
      expect(
        new Catalog(evilCatalog(pattern)).validateKeyValue("evil", "aab").ok,
      ).toBe(false);
    }
  });

  it("a benign pattern stays linear as the input grows (no exponential blowup)", () => {
    const catalog = new Catalog(evilCatalog("^(a|a)*b$"));
    const time = (n: number): number => {
      const t0 = Date.now();
      catalog.validateKeyValue("evil", "a".repeat(n));
      return Date.now() - t0;
    };
    // `(a|a)*` is the classic ambiguous-alternation bomb; +12 characters must not
    // multiply the cost by 4096.
    expect(time(30)).toBeLessThan(250);
    expect(time(42)).toBeLessThan(250);
  }, 20_000);

  it("the matched input is capped, so an unbounded value cannot be walked forever", () => {
    const catalog = new Catalog(evilCatalog("^[a-z]*$"));
    const t0 = Date.now();
    const res = catalog.validateKeyValue("evil", "a".repeat(200_000));
    expect(res.ok).toBe(false); // over MAX_PATTERN_INPUT ⇒ fail closed
    expect(Date.now() - t0).toBeLessThan(250);
  }, 20_000);

  it("the real djdl semver patterns still validate correctly", () => {
    const catalog = new Catalog(DJDL_CATALOG as never);
    expect(catalog.validateKeyValue("app.minVersion", "1.2.3").ok).toBe(true);
    expect(catalog.validateKeyValue("app.minVersion", "1.2.3-rc.1+b5").ok).toBe(
      true,
    );
    expect(catalog.validateKeyValue("app.minVersion", "not-a-version").ok).toBe(
      false,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-02 — unnormalized arch alias ⇒ unhandled TypeError ⇒ 500
// ═════════════════════════════════════════════════════════════════════════════

function asset(name: string, id = name.length): ReleaseAsset {
  return {
    id,
    name,
    size: 1024,
    content_type: "application/octet-stream",
    browser_download_url: `https://example/${name}`,
  };
}

function releaseWith(assets: ReleaseAsset[]): Release {
  return {
    tag_name: "v1.2.3",
    name: "1.2.3",
    body: null,
    published_at: "2026-01-02T03:04:05Z",
    html_url: "https://github.com/acme/djdl/releases/tag/v1.2.3",
    prerelease: false,
    draft: false,
    assets,
  };
}

// A throwaway 2048-bit RSA private key (PKCS#8 PEM) for tests only.
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

function releaseEnv(kv: KvMock): Env {
  const env = makeEnv(kv, ["djdl"]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

function makeReleaseProduct(): Product {
  return {
    slug: "djdl",
    name: "djdl",
    signingKid: "kid",
    // B5-12: the unseal is lazy — a fixture Product supplies the accessor, not a field.
    signingKey: async () => "pem",
    signingPub: null,
    // §1.1 — the anchor is a separate key from the document signer; a fixture that omits it
    // would exercise a Product shape `loadProduct` can no longer produce.
    trustAnchorKid: "anchor-kid",
    trustAnchorKey: async () => "pem",
    trustAnchorPub: null,
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
  };
}

async function seedReleaseCfg(db: Db): Promise<void> {
  await seedProduct(db, "djdl");
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub,
        summary_marker, artifact_policy_json, metadata_access, artifacts_access)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "djdl",
    "acme",
    "djdl",
    42,
    null,
    "main",
    null,
    "djdl",
    null,
    "PUBKEY==",
    "pkey:summary",
    null,
    "public",
    "public",
  );
}

function stubReleaseFetch(rel: Release): FetchImpl {
  return async (input) => {
    const url = String(input);
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_x" }), { status: 200 });
    if (url.includes("/releases"))
      return new Response(JSON.stringify(rel), { status: 200 });
    return new Response("nope", { status: 404 });
  };
}

describe("R10-02 arch alias is never normalized ⇒ unhandled TypeError", () => {
  it("the router hands `aarch64`/`amd64` through verbatim to the release service", () => {
    // P2.T1 removed `/cli` and `/dmg` and moved arch parsing off the router entirely: the
    // canonical `/release/dl/…` route hands the whole leaf to `services/release/routes.ts`,
    // which is where `normalizeArch` runs. The finding's premise — an un-normalised alias
    // reaching a handler — is therefore what these paths still deliver, and the two tests
    // below still prove the handler survives it.
    expect(matchRoute("/djdl/release/dl/1.2.3/app-aarch64.dmg")).toMatchObject({
      slug: "release",
      rest: ["dl", "1.2.3", "app-aarch64.dmg"],
    });
    expect(matchRoute("/djdl/release/dl/1.2.3/djdl-amd64")).toMatchObject({
      slug: "release",
      rest: ["dl", "1.2.3", "djdl-amd64"],
    });
  });

  // FIXED (R6-08 / R10-02): `normalizeArch` canonicalises the alias in `handleBinary`
  // before it can key `ARCH_TOKENS[…]` as `undefined`, so the alias resolves to the real
  // asset instead of raising an unhandled TypeError.
  it("GET /<p>/dmg/<v>/<name>-aarch64.dmg throws out of handleRelease (⇒ 500)", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const rel = releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]);

    const res = await handleRelease(
      mkReq("GET", {}),
      env,
      db,
      makeReleaseProduct(),
      "dmg",
      { version: "1.2.3", arch: "aarch64" as never },
      stubReleaseFetch(rel),
    );
    expect(res.status).toBe(200);
  });

  it("GET /<p>/cli/<v>/<bin>-amd64 throws out of handleRelease (⇒ 500)", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const rel = releaseWith([asset("djdl-x86_64", 9)]);

    const res = await handleRelease(
      mkReq("GET", {}),
      env,
      db,
      makeReleaseProduct(),
      "cli",
      { version: "1.2.3", arch: "amd64" as never },
      stubReleaseFetch(rel),
    );
    expect(res.status).toBe(200);
  });

  it("the canonical alias still works, proving this is a normalization gap only", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const rel = releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]);
    const res = await handleRelease(
      mkReq("GET", {}),
      env,
      db,
      makeReleaseProduct(),
      "dmg",
      { version: "1.2.3", arch: "arm64" },
      stubReleaseFetch(rel),
    );
    expect(res.status).not.toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-03 — the rate limiter has no fail mode
// ═════════════════════════════════════════════════════════════════════════════

/** An RL namespace whose DO stub fails, modelling a DO outage / overload / code reset. */
function brokenRl(mode: "reject" | "nonJson"): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: () => ({
      fetch: async () => {
        if (mode === "reject")
          throw new Error("Durable Object reset because its code was updated");
        return new Response("Internal Server Error", { status: 500 });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

describe("R10-03 rateLimitOk fail mode", () => {
  it("FIXED: a DO error no longer escapes — a credential bucket fails CLOSED", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.RL = brokenRl("reject");
    // FIXED (R10-03). This used to reject, i.e. throw straight out of handleActivate as a
    // 500. It now resolves `false` for `activate`, which is a credential-minting bucket: the
    // documented policy is that losing the limiter must not silently turn a key-guessing
    // oracle unlimited.
    await expect(
      rateLimitOk(
        env,
        "djdl",
        { bucket: "activate", id: "1.2.3.4", limit: 30, windowSec: 60 },
        NOW,
      ),
    ).resolves.toBe(false);
  });

  it("FIXED: a non-JSON DO response is handled too (the res.json() destructure)", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.RL = brokenRl("nonJson");
    await expect(
      rateLimitOk(
        env,
        "djdl",
        { bucket: "activate", id: "1.2.3.4", limit: 30, windowSec: 60 },
        NOW,
      ),
    ).resolves.toBe(false);
  });

  it("FIXED: a read-only / authenticated bucket fails OPEN, so a limiter outage is not an outage", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.RL = brokenRl("reject");
    // The policy is per-surface, not global: an operator holding a valid admin session must
    // not be locked out of the console because a counter DO is unhappy.
    await expect(
      rateLimitOk(
        env,
        "_admin",
        { bucket: "adminApi", id: "u1", limit: 600, windowSec: 60 },
        NOW,
      ),
    ).resolves.toBe(true);
  });

  it("FIXED: an unregistered bucket fails CLOSED (safe default for a new credential route)", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.RL = brokenRl("reject");
    await expect(
      rateLimitOk(
        env,
        "djdl",
        { bucket: "some-new-endpoint", id: "1.2.3.4", limit: 5, windowSec: 60 },
        NOW,
      ),
    ).resolves.toBe(false);
  });

  it("FIXED: POST /<p>/activate degrades to a clean 429 instead of throwing a 500 when the DO is down", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl")) as Product;
    const { key } = await seedLicenseWithKey(db, "djdl");
    env.RL = brokenRl("reject");

    // FIXED (R10-03). Every deploy resets in-flight Durable Objects; that used to surface as
    // an unhandled exception on the licensing hot path. A 429 is the status a client knows to
    // back off and retry on.
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(429);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-04 — RateLimitDO storage grows without bound (no TTL, no alarm, no GC)
// ═════════════════════════════════════════════════════════════════════════════

/** Storage mock with the surface the alarm sweep needs: list + array delete + alarms. */
class CountingStorage {
  readonly m = new Map<string, unknown>();
  putCount = 0;
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.m.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.putCount++;
    this.m.set(key, value);
  }
  /** Lexicographic, like the real thing — which is the whole point of `startAfter`: without
   *  a defined order a resume cursor means nothing. */
  async list<T>(opts?: {
    limit?: number;
    startAfter?: string;
  }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const keys = [...this.m.keys()].sort();
    for (const k of keys) {
      if (opts?.startAfter !== undefined && k <= opts.startAfter) continue;
      if (opts?.limit !== undefined && out.size >= opts.limit) break;
      out.set(k, this.m.get(k) as T);
    }
    return out;
  }
  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let n = 0;
      for (const k of key) if (this.m.delete(k)) n++;
      return n;
    }
    return this.m.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.m.clear();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }
}

describe("R10-04 RateLimitDO storage growth is now reclaimed by an alarm sweep", () => {
  it("each distinct client id still costs a key while live — but the sweep is armed to reclaim it", async () => {
    const storage = new CountingStorage();
    const doInstance = new RateLimitDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );
    const N = 500;
    for (let i = 0; i < N; i++) {
      await doInstance.fetch(
        new Request("https://rl/check", {
          method: "POST",
          body: JSON.stringify({
            bucket: "activate",
            // An IPv6 /64 gives an attacker 2^64 of these for free.
            id: `2001:db8::${i.toString(16)}`,
            limit: 30,
            windowSec: 60,
            now: NOW,
          }),
        }) as unknown as Request,
      );
    }
    expect(storage.m.size).toBe(N);
    expect(storage.putCount).toBe(N);
    // FIXED (R10-04b). The keys are no longer permanent: the first write arms an alarm, and
    // the sweep collects every counter whose window has elapsed. 500 IPv6 addresses cost 500
    // keys for one window, not for ever.
    expect(storage.alarmAt).not.toBeNull();
    // The runtime clears the alarm before invoking the handler; model that so the assertion
    // below is about what `alarm()` re-arms, not about what armed it in the first place.
    storage.alarmAt = null;
    await doInstance.alarm();
    expect(storage.m.size).toBe(0);
    // Nothing left to watch ⇒ the object goes idle instead of waking up for ever.
    expect(storage.alarmAt).toBeNull();
  });

  it("FIXED: keys from an expired window are deleted; a live counter survives the sweep", async () => {
    const storage = new CountingStorage();
    const doInstance = new RateLimitDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );
    const hit = (id: string, now: number) =>
      doInstance.fetch(
        new Request("https://rl/check", {
          method: "POST",
          body: JSON.stringify({
            bucket: "activate",
            id,
            limit: 1,
            windowSec: 60,
            now,
          }),
        }) as unknown as Request,
      );
    // `ip-a`'s window is long gone; `ip-b`'s is current.
    await hit("ip-a", Math.floor(Date.now() / 1000) - 365 * 86400);
    await hit("ip-b", Math.floor(Date.now() / 1000));
    expect([...storage.m.keys()].sort()).toEqual([
      "activate:ip-a",
      "activate:ip-b",
    ]);

    storage.alarmAt = null;
    await doInstance.alarm();
    // The year-stale counter is collected. The live one is kept — sweeping it would reset
    // an in-flight budget, which would be a limiter bypass.
    expect([...storage.m.keys()]).toEqual(["activate:ip-b"]);
    // A live counter remains, so the sweep re-arms itself.
    expect(storage.alarmAt).not.toBeNull();
  });

  it("FIXED: a pre-existing counter with no expiresAt (written before this change) is collectable", async () => {
    const storage = new CountingStorage();
    const doInstance = new RateLimitDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );
    // The old on-disk shape: {window, count} with no expiry. By definition it predates the
    // deploy that added the field, so its window has elapsed.
    await storage.put("activate:legacy-ip", { window: 1, count: 1 });
    await doInstance.alarm();
    expect(storage.m.size).toBe(0);
  });

  it("the DO is a single global shard per product (one hot object, no sharding)", async () => {
    const names: string[] = [];
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.RL = {
      idFromName: (n: string) => {
        names.push(n);
        return { name: n } as unknown as DurableObjectId;
      },
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true })),
      }),
    } as unknown as DurableObjectNamespace;

    await rateLimitOk(
      env,
      "djdl",
      { bucket: "activate", id: "1", limit: 1, windowSec: 1 },
      NOW,
    );
    await rateLimitOk(
      env,
      "djdl",
      { bucket: "token", id: "2", limit: 1, windowSec: 1 },
      NOW,
    );
    await rateLimitOk(
      env,
      "djdl",
      { bucket: "mint", id: "3", limit: 1, windowSec: 1 },
      NOW,
    );
    // FIXED (B2-03). It is no longer one object: the name is `${scope}:${bucket}:${shard}`,
    // so three different buckets can never collide onto one hot object, and the slug alone is
    // never a Durable Object name again.
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    expect(names).not.toContain("djdl");
    for (const name of names) expect(name.startsWith("djdl:")).toBe(true);
  });

  it("FIXED (B2-03): `_admin` — the platform's whole pre-auth login lane — spreads across shards", async () => {
    const names = new Set<string>();
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.RL = {
      idFromName: (n: string) => {
        names.add(n);
        return { name: n } as unknown as DurableObjectId;
      },
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true })),
      }),
    } as unknown as DurableObjectNamespace;

    // 400 distinct clients hitting the single most attractive unauthenticated target in the
    // system. Before this they all serialized through exactly one Durable Object.
    for (let i = 0; i < 400; i++) {
      await rateLimitOk(
        env,
        "_admin",
        {
          bucket: "adminLogin",
          id: `203.0.113.${i % 256}`,
          limit: 20,
          windowSec: 60,
        },
        NOW,
      );
    }
    expect(names.size).toBeGreaterThan(RL_SHARDS / 2);
    expect(names.size).toBeLessThanOrEqual(RL_SHARDS);
  });

  it("FIXED (B2-03): sharding splits contention, never a counter — one id lands in exactly one shard", () => {
    // The property that makes this safe: a client cannot win extra allowance by being routed
    // somewhere else, because there is nowhere else for it to be routed to.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(rateLimitShardName("_portal", "portalLogin", "198.51.100.7"));
    }
    expect(seen.size).toBe(1);
    // …and the bucket is part of the name, so two buckets never share a counter either.
    expect(
      rateLimitShardName("_portal", "portalLogin", "198.51.100.7"),
    ).not.toBe(rateLimitShardName("_portal", "portalMagic", "198.51.100.7"));
  });

  it("FIXED (B5-05): two addresses in the same IPv6 /64 share a bucket; two IPv4 addresses do not", async () => {
    const ip = (address: string) =>
      clientIp(
        new Request("https://key.plrs.im/", {
          headers: { "cf-connecting-ip": address },
        }) as unknown as Request,
      );

    // Every residential and hosting IPv6 assignment is at least a /64, so keying on the full
    // 128-bit address handed one attacker 2^64 free identities — every per-IP budget in the
    // platform was bypassable at zero cost, and every request minted a permanent counter key.
    expect(ip("2001:db8:1:2:3:4:5:6")).toBe(
      ip("2001:db8:1:2:ffff:ffff:ffff:ffff"),
    );
    expect(ip("2001:db8:1:2::1")).toBe(ip("2001:db8:1:2:3:4:5:6"));
    // A DIFFERENT /64 is a different bucket — the aggregation is the network, not the world.
    expect(ip("2001:db8:1:2::1")).not.toBe(ip("2001:db8:1:3::1"));

    // IPv4 is untouched: one address is one host's worth of allowance, which is the intent.
    expect(ip("203.0.113.7")).toBe("203.0.113.7");
    expect(ip("203.0.113.7")).not.toBe(ip("203.0.113.8"));
    // …and a client with no edge IP still shares the one `unknown` bucket.
    expect(
      clientIp(new Request("https://key.plrs.im/") as unknown as Request),
    ).toBe("unknown");

    // End to end: two hosts in one /64 spend ONE budget on a real limited surface.
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.RL = makeRlNamespace();
    const charge = (address: string) =>
      rateLimitOk(
        env,
        "djdl",
        {
          bucket: "activate",
          id: ip(address),
          limit: 2,
          windowSec: 60,
        },
        NOW,
      );
    expect(await charge("2001:db8:9:9::1")).toBe(true);
    expect(await charge("2001:db8:9:9::2")).toBe(true);
    // The third address in the same /64 is over the budget its two siblings already spent.
    expect(await charge("2001:db8:9:9::3")).toBe(false);
    // A host in a different /64 still has its own.
    expect(await charge("2001:db8:9:a::1")).toBe(true);
  });

  it("FIXED (B5-09/B2-04): the sweep makes progress PAST the first batch instead of re-reading it", async () => {
    const storage = new CountingStorage();
    const doInstance = new RateLimitDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );

    // More stale counters than one sweep may examine. Before the resume cursor, `list()`
    // returned the same lexicographic prefix on every tick, so everything past the first
    // batch was structurally unreachable — an attacker minting keys faster than one batch
    // could drain simply grew the object for ever.
    const TOTAL = 2600; // > SWEEP_BATCH (2000)
    const staleWindow = { window: 1, count: 1, expiresAt: 1 };
    for (let i = 0; i < TOTAL; i++) {
      await storage.put(`activate:${String(i).padStart(6, "0")}`, {
        ...staleWindow,
      });
    }
    expect(storage.m.size).toBe(TOTAL);

    // Tick one: the batch cap leaves a remainder, so the sweep records where it stopped.
    storage.alarmAt = null;
    await doInstance.alarm();
    const afterFirst = storage.m.size;
    expect(afterFirst).toBeLessThan(TOTAL);
    // Still work to do ⇒ re-armed rather than going idle on a half-swept object.
    expect(storage.alarmAt).not.toBeNull();

    // Tick two: the whole point. With no cursor this deleted nothing, because the keys it
    // re-listed had already been collected and the survivors were never looked at.
    storage.alarmAt = null;
    await doInstance.alarm();
    expect(storage.m.size).toBeLessThan(afterFirst);

    // A bounded number of further ticks finishes the backlog and the object goes idle.
    for (let i = 0; i < 6 && storage.m.size > 0; i++) await doInstance.alarm();
    expect(storage.m.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-05 — unauthenticated KV-write amplification on the /auth/* surface
// ═════════════════════════════════════════════════════════════════════════════

async function seedOidc(db: Db): Promise<void> {
  await db.run(
    `INSERT INTO oidc_config
       (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json,
        group_role_map_json)
     VALUES (?,?,?,?,?,?,?)`,
    "djdl",
    "custom",
    "https://idp.example",
    "client-id",
    null,
    null,
    "{}",
  );
}

describe("R10-05 /<p>/auth/* is unauthenticated, unrate-limited and writes KV", () => {
  it("POST /<p>/auth/device/start costs 2 KV writes per anonymous request", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl")) as Product;

    for (let i = 0; i < 25; i++) {
      const res = await handleAuthDeviceStart(
        mkReq(
          "POST",
          { "content-type": "application/json" },
          { deviceId: `dev-${i}` },
        ),
        env,
        db,
        product,
      );
      expect(res.status).toBe(200);
    }
    // 25 anonymous requests ⇒ 50 durable KV records. No 429 anywhere.
    expect(kv.keys().length).toBe(50);
    expect(kv.keys().filter((k) => k.includes(":flow:")).length).toBe(25);
    expect(kv.keys().filter((k) => k.includes(":device-flow:")).length).toBe(
      25,
    );
  });

  it("GET /<p>/auth/start costs 1 KV write per anonymous request", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl")) as Product;

    for (let i = 0; i < 30; i++) {
      const res = await handleAuthStart(mkReq("GET", {}), env, db, product);
      expect(res.status).toBe(302);
    }
    expect(kv.keys().length).toBe(30);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-06 — /webhooks/github buffers the whole body before authenticating it
// ═════════════════════════════════════════════════════════════════════════════

// FIXED (B5-04). `handleGithubWebhook` now caps the body at MAX_WEBHOOK_BODY_BYTES (1 MiB),
// with the `content-length` precheck first and a post-read byte-length check behind it, exactly
// as `admin/lib/respond.ts`'s `readBody` does. Both `it`s below are the originals INVERTED: an
// oversized delivery is refused with 413 BEFORE the body is buffered, so no unauthenticated
// stranger can make this route hold megabytes in isolate memory or HMAC them.
//
// The third test is the other half of the fix and the reason the cap may never become a
// truncation: the bytes that are read ARE the HMAC input, so a legitimate, correctly-signed
// delivery must still verify byte-for-byte.

/** A Request stand-in exposing exactly what `handleGithubWebhook` touches, so the test can
 *  DECLARE a `content-length` the runtime would otherwise recompute — and can observe whether
 *  the body was buffered at all. */
function webhookReq(
  headers: Record<string, string>,
  body: Uint8Array,
): { req: Request; reads: () => number } {
  let reads = 0;
  const req = {
    method: "POST",
    headers: new Headers(headers),
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      reads++;
      return body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer;
    },
  };
  return { req: req as unknown as Request, reads: () => reads };
}

async function hubSignature(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body as BufferSource),
  );
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("R10-06 unauthenticated whole-body buffering on /webhooks/github", () => {
  it("a multi-megabyte unsigned body is fully read + HMAC'd before the 401", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    env.GITHUB_WEBHOOK_SECRET = "s3cret";

    const MB = 4;
    const body = "A".repeat(MB * 1024 * 1024);

    // Arm 1 — what Cloudflare actually delivers: 4 MiB WITH a truthful `content-length`. The
    // precheck fires and the body is never buffered at all.
    const declared = webhookReq(
      {
        "x-github-event": "push",
        "content-length": String(MB * 1024 * 1024),
      },
      new TextEncoder().encode(body),
    );
    const prechecked = await handleGithubWebhook(declared.req, env, db, NOW);
    expect(prechecked.status).toBe(413);
    expect(declared.reads()).toBe(0);

    // Arm 2 — the original request object, which carries no `content-length` at all, so the
    // precheck cannot fire. The post-read byte check does. `consumed` is still the whole body
    // (a Request cannot be un-read), but the 413 in place of the old 401 is the proof that the
    // handler returned BEFORE `verifySignature` — nothing HMAC'd 4 MiB to earn a rejection.
    let consumed = 0;
    const req = new Request("https://k/webhooks/github", {
      method: "POST",
      body,
      headers: { "x-github-event": "push" },
    }) as unknown as Request;
    const orig = req.arrayBuffer.bind(req);
    (
      req as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }
    ).arrayBuffer = async () => {
      const buf = await orig();
      consumed = buf.byteLength;
      return buf;
    };

    const res = await handleGithubWebhook(req, env, db, NOW);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "body_too_large",
      message: "request body too large",
    });
    expect(consumed).toBe(MB * 1024 * 1024);
  });

  it("there is no Content-Length precheck on the webhook (unlike /devices/report)", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    env.GITHUB_WEBHOOK_SECRET = "s3cret";
    // A 1 KiB body that CLAIMS half a gigabyte — the shape a streaming flood arrives in. The
    // declared length alone is enough: there is now a precheck, and it refuses before reading.
    const { req, reads } = webhookReq(
      {
        "x-github-event": "push",
        "content-length": String(500 * 1024 * 1024),
      },
      new TextEncoder().encode("x".repeat(1024)),
    );
    const res = await handleGithubWebhook(req, env, db, NOW);
    // Was 401 — "the body was read regardless". The 413 IS the size gate.
    expect(res.status).toBe(413);
    expect(reads()).toBe(0);
  });

  it("the cap refuses, never truncates: a legitimate signed delivery still verifies", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    env.GITHUB_WEBHOOK_SECRET = "s3cret";

    // Multi-byte UTF-8 in the payload on purpose: if anything decoded, re-encoded or sliced the
    // bytes between the read and `verifySignature`, the HMAC over them would stop matching.
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ref: "refs/tags/v1.0.0-ünïcøde", after: "deadbeef" }),
    );
    const { req, reads } = webhookReq(
      {
        "x-github-event": "push",
        "x-github-delivery": "delivery-guid-1",
        "x-hub-signature-256": await hubSignature("s3cret", bytes),
        "content-length": String(bytes.byteLength),
      },
      bytes,
    );
    const res = await handleGithubWebhook(req, env, db, NOW);
    // Past the HMAC, past replay protection, and into the handler's own structural gate.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "non-branch-ref" });
    expect(reads()).toBe(1);

    // …and a single flipped byte still fails, so the 200 above is the signature verifying and
    // not a cap that stopped checking.
    const tampered = new TextEncoder().encode(
      JSON.stringify({ ref: "refs/tags/v1.0.0-ünïcødf", after: "deadbeef" }),
    );
    const forged = webhookReq(
      {
        "x-github-event": "push",
        "x-github-delivery": "delivery-guid-2",
        "x-hub-signature-256": await hubSignature("s3cret", bytes),
        "content-length": String(tampered.byteLength),
      },
      tampered,
    );
    expect((await handleGithubWebhook(forged.req, env, db, NOW)).status).toBe(
      401,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-07 — the 80-char cap never was the guard; the backtracking-free matcher is
// ═════════════════════════════════════════════════════════════════════════════

describe("R10-07 manual-channel regex ReDoS (MAX_REGEX_SOURCE = 80 was never the guard)", () => {
  const EVIL = "(x+x+)+y"; // 8 chars, far below the 80-char cap

  /** Time `resolveChannel` against `count` releases whose tag is `len` x's. */
  function timeMatch(len: number, count: number): number {
    const sel: ChannelSelector = {
      kind: "manual",
      raw: "nightly",
      manual: { name: "nightly", regex: EVIL },
    };
    const releases = Array.from({ length: count }, () => {
      const r = releaseWith([]);
      r.tag_name = "x".repeat(len); // a perfectly legal git tag name
      return r;
    });
    const t0 = Date.now();
    resolveChannel(sel, releases);
    return Date.now() - t0;
  }

  // FIXED (B7-04 / A5-04). `compileManualChannelRegex` no longer calls `new RegExp`; it calls
  // `compileLinearPattern`, the Thompson NFA that closed the same finding for catalog
  // `pattern` (R10-01's knock-on block above). Two consequences, and this block pins both:
  //
  //  1. Patterns that CANNOT be matched without backtracking — backreferences, lookaround,
  //     `\b` — are refused at ingest. The manifest validator emits `invalid_manual_channel`
  //     and `parseManualChannels` drops the row, so they never reach `resolveChannel`.
  //  2. `(x+x+)+y` is NOT one of them. It is perfectly expressible in a non-backtracking
  //     engine; it was only ever expensive because V8 backtracks. So it stays ACCEPTED and is
  //     DEFUSED instead — which is why the three timing assertions below are the original
  //     three, inverted in place rather than deleted. Rejecting it would be the static
  //     "nested quantifier" heuristic `shared-catalog/src/regex.ts` explicitly refuses to
  //     rely on, because it leaks (`(a|a)*` has star height 1 and backtracks just as badly).

  it("the constructs that need backtracking are refused at ingest", async () => {
    const { compileManualChannelRegex, validateManifestDocuments } =
      await import("@polaris-key/manifest");

    for (const regex of ["(v\\d+)-\\1", "(?=(a+)+b)a", "(?<=aa)b", "\\bv1"]) {
      // The shared rule says no…
      expect(compileManualChannelRegex(regex), regex).toBeNull();

      // …so a repo push carrying one is rejected, not stored (githubWebhook → resync → here).
      const res = validateManifestDocuments({
        product: { slug: "acme", name: "Acme" },
        release: {
          release: {
            provider: { type: "github", owner: "acme", repo: "desktop" },
            manualChannels: [{ name: "nightly", regex }],
          },
        },
      });
      expect(
        res.errors.map((e) => e.code),
        regex,
      ).toContain("invalid_manual_channel");

      // …and even a row that predates the fix cannot be revived by the runtime reader.
      const { parseManualChannels } =
        await import("../../src/services/release/channels.js");
      expect(
        parseManualChannels(JSON.stringify([{ name: "nightly", regex }])),
      ).toEqual([]);
    }
  });

  it("an 8-character pattern under the cap no longer backtracks catastrophically", () => {
    expect(EVIL.length).toBeLessThanOrEqual(80);
    // This assertion is the finding, inverted: it used to REQUIRE > 250ms. A 28-character
    // tag was ~2.6s of worker CPU under V8's engine; the NFA walks it in about a microsecond.
    expect(timeMatch(28, 1)).toBeLessThan(250);
  }, 20_000);

  it("runtime grows linearly, not exponentially, with the input character count", () => {
    // +5 characters used to mean ~32x. 40 characters used to mean ~4 minutes of CPU on one
    // request; 4000 was unreachable. All three are now a flat scan.
    expect(timeMatch(22, 1)).toBeLessThan(250);
    expect(timeMatch(27, 1)).toBeLessThan(250);
    expect(timeMatch(40, 1)).toBeLessThan(250);
    expect(timeMatch(4000, 1)).toBeLessThan(250);
  }, 20_000);

  it("a full 100-release page costs no more than a linear scan", () => {
    // The multiplier is still there — `resolveChannel` really does run the pattern against
    // every release — but it now multiplies microseconds. 100 is the GitHub page size, i.e.
    // the most one request can be made to match.
    expect(timeMatch(24, 100)).toBeLessThan(250);
  }, 20_000);

  it("the anchoring the old RegExp gave is preserved, so no channel widens", async () => {
    const { compileManualChannelRegex } = await import("@polaris-key/manifest");
    // `^(?:…)$` still wraps the manifest source: `beta` must not answer for `beta-old`.
    const re = compileManualChannelRegex("v.*-nightly\\..*");
    expect(re).not.toBeNull();
    expect(re!.test("v1.3.0-nightly.7")).toBe(true);
    expect(re!.test("v1.3.0-nightly.7-suffix")).toBe(true); // the author's own `.*`
    expect(re!.test("prefix-v1.3.0-nightly.7")).toBe(false); // but not an unanchored hit
    expect(re!.test("v1.3.0")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-08 — uncapped request headers are written straight into D1
// ═════════════════════════════════════════════════════════════════════════════

// FIXED (B5-07). `deviceMetadata` now truncates every one of the six attacker-controlled
// headers at `MAX_DEVICE_METADATA_CHARS` (128) — the SAME cap `factsFromReport` in the same file
// had applied to `/devices/report` all along. The cap lives inside the helper, not at the call
// sites, so all six consumers (`/activate`, `/enroll`, `/register`, the browser session and both
// document routes) inherit it; the two `it`s below are the originals inverted and cover the two
// ends of that range. The values are still WRITTEN — a truncated user agent is still useful
// inventory — they just cannot be used to inflate a row.
describe("R10-08 device metadata headers are persisted with no length cap", () => {
  it("GET /license/document writes 16 KiB header values verbatim into `devices`", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl")) as Product;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const big = "U".repeat(16 * 1024);
    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "user-agent": big,
        "x-pkey-platform": big,
        "x-pkey-arch": big,
        "x-pkey-version": big,
        "x-pkey-sdk": big,
        "x-pkey-sdk-version": big,
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);

    const row = await getDevice(db, "djdl", "dev-1");
    // Was six columns × 16 KiB. Now six columns × the documented 128-char cap — the same one
    // `/devices/report` has always applied, so the two paths finally agree.
    expect(MAX_DEVICE_METADATA_CHARS).toBe(128);
    for (const value of [
      row?.ua,
      row?.platform,
      row?.arch,
      row?.app_version,
      row?.sdk_name,
      row?.sdk_version,
    ]) {
      expect(value?.length).toBe(MAX_DEVICE_METADATA_CHARS);
    }
    // Truncated at the front, not hashed or dropped: the first 128 characters are preserved.
    expect(row?.ua).toBe(big.slice(0, MAX_DEVICE_METADATA_CHARS));
  });

  it("/activate has the same unbounded write, gated only by 30/min/IP", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl")) as Product;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const big = "A".repeat(8 * 1024);
    await activate(env, db, product, key, "dev-big", { "user-agent": big });
    // Was 8 KiB. The cap is inside `deviceMetadata`, so the mint path inherits it too — the
    // limiter is no longer the only thing bounding what one activation can store.
    expect((await getDevice(db, "djdl", "dev-big"))?.ua?.length).toBe(
      MAX_DEVICE_METADATA_CHARS,
    );
    // A value already under the cap is untouched — this truncates, it does not normalise.
    await activate(env, db, product, key, "dev-small", {
      "user-agent": "pkey-node/1.2.3",
    });
    expect((await getDevice(db, "djdl", "dev-small"))?.ua).toBe(
      "pkey-node/1.2.3",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-10 — the document routes are the priciest unrate-limited endpoints (D1 write per poll)
// ═════════════════════════════════════════════════════════════════════════════

/** Wrap a Db and tally reads/writes, so the per-request D1 cost is measurable. */
function countingDb(inner: Db): { db: Db; reads: number; writes: number } {
  const tally = { reads: 0, writes: 0 };
  const db: Db = {
    all: (sql, ...p) => {
      tally.reads++;
      return inner.all(sql, ...p);
    },
    first: (sql, ...p) => {
      tally.reads++;
      return inner.first(sql, ...p);
    },
    runChanges: (sql, ...p) => {
      tally.writes++;
      return inner.runChanges(sql, ...p);
    },
    run: (sql, ...p) => {
      tally.writes++;
      return inner.run(sql, ...p);
    },
    batch: (s) => {
      tally.writes += s.length;
      return inner.batch(s);
    },
  };
  return {
    db,
    get reads() {
      return tally.reads;
    },
    get writes() {
      return tally.writes;
    },
  };
}

describe("R10-10 GET /<p>/{license,config}/document: no rate limit, one D1 write per poll", () => {
  // A sync is now TWO requests, so the per-poll cost is the pair's. Measuring them together
  // keeps this pinning the same quantity the fused `/config` measured — total D1 work an
  // unauthenticated-to-the-limiter poll loop can force — rather than half of it.
  it("each poll costs multiple D1 reads plus a device row write", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const counted = countingDb(db);
    for (const handler of [handleLicenseDocument, handleConfigDocument]) {
      const res = await handler(
        mkReq("GET", { authorization: `Bearer ${token}` }),
        env,
        counted.db,
        product,
        NOW,
      );
      expect(res.status).toBe(200);
    }
    // ≥1 write per poll (upsertDevice) — unmetered, and D1 is shared by ALL products.
    expect(counted.writes).toBeGreaterThanOrEqual(1);
    expect(counted.reads).toBeGreaterThanOrEqual(5);
    // Recorded for the finding write-up; not an assertion target.
    console.log(
      `[R10-10] one document poll = ${counted.reads} D1 reads + ${counted.writes} D1 writes`,
    );
  });

  // FIXED (A6-05), for `/config/document`. The original polled `/license/document`, but A6-05's
  // scope is the config half — so this is inverted where the fix landed and the licence half is
  // measured alongside it rather than quietly dropped, because the residual matters: the two
  // routes have the same per-poll D1 cost and only one of them is now metered.
  it("200 consecutive polls from one IP are all served — there is no 429 path", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    const poll = (
      handler: typeof handleConfigDocument,
      ip: string,
    ): Promise<Response> =>
      handler(
        mkReq("GET", {
          authorization: `Bearer ${token}`,
          "cf-connecting-ip": ip,
        }),
        env,
        db,
        product,
        NOW,
      );

    // Was: 200 consecutive polls, 200 × HTTP 200, no limiter anywhere. There is now a
    // `configDocument` budget of 120/60s per client, so the loop runs out of allowance.
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) {
      statuses.push((await poll(handleConfigDocument, "203.0.113.9")).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(120);
    expect(statuses.slice(120).every((s) => s === 429)).toBe(true);

    // The standard nested 429 body, not a bare status.
    const blocked = await poll(handleConfigDocument, "203.0.113.9");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: { code: "rate_limited" } });

    // Per CLIENT, not global: a different address still gets served, so one noisy machine
    // cannot deny every other device its configuration.
    expect((await poll(handleConfigDocument, "198.51.100.4")).status).toBe(200);

    // RESIDUAL, pinned deliberately: A6-05 covered `/config/document` only. The same 200 polls
    // against `/license/document` are still all served — that route has no limiter of its own.
    for (let i = 0; i < 200; i++) {
      expect((await poll(handleLicenseDocument, "203.0.113.9")).status).toBe(
        200,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-09 — token records have no TTL and are resurrected by rejected requests
// ═════════════════════════════════════════════════════════════════════════════

describe("R10-09 KV token records: no expirationTtl, revived after revocation", () => {
  it("FIXED (R10-12): putTokenRecord now carries an expirationTtl", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const calls: unknown[][] = [];
    const env = makeEnv(kv, ["djdl"]);
    env.HOT = {
      get: (k: string) => kv.get(k),
      put: (...args: unknown[]) => {
        calls.push(args);
        return kv.put(args[0] as string, args[1] as string);
      },
      delete: (k: string) => kv.delete(k),
    } as unknown as KVNamespace;
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl")) as Product;
    const { key } = await seedLicenseWithKey(db, "djdl");
    await activate(env, db, product, key, "dev-1");

    const tokenPut = calls.find((c) => String(c[0]).includes(":token:"));
    expect(tokenPut).toBeTruthy();
    // FIXED (R10-12). Was: browser sessions / OIDC flows passed { expirationTtl } and token
    // records passed nothing, so the namespace was append-only for the life of the deployment.
    // D1 is the authority (validateDeviceToken re-populates from getDeviceByTokenHash), so an
    // expired record costs one indexed read, never a false 401.
    expect(tokenPut).toHaveLength(3);
    expect(tokenPut![2]).toEqual({
      expirationTtl: TOKEN_RECORD_TTL_SECONDS,
    });
  });

  it("FIXED (R10-12): replaying a revoked token no longer resurrects its KV record", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl")) as Product;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);

    // Revoke exactly as /deauthorize does: flip status + delete the KV record.
    const dev = (await getDevice(db, "djdl", "dev-1"))!;
    await upsertDevice(db, { ...dev, status: "deauthorized" });
    await env.HOT.delete(`p:djdl:token:${tokenHash}`);
    expect(await getTokenRecord(env, "djdl", tokenHash)).toBeNull();

    // The cache is now back-filled only after every check has passed, so a rejected replay
    // leaves the purge intact. Was: the record was rewritten permanently on every attempt.
    const result = await validateDeviceToken(env, db, product, token, NOW);
    expect(result).toEqual({ error: "unauthorized" });
    expect(await getTokenRecord(env, "djdl", tokenHash)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-05 — unauthenticated GitHub-subrequest amplifier on the public release surface
// ═════════════════════════════════════════════════════════════════════════════
//
// The original finding: `/appcast.xml`, `/version`, `/changelog`, `/cli/…`, `/dmg/…` are
// public, unrate-limited and use no Cache API, so EVERY request issues GitHub subrequests
// against a 5,000/hour installation quota. ~1 req/s exhausts it in ~20 minutes, after which
// `github.ts` maps GitHub's 403 to `NotFoundError` and every download and auto-update on the
// platform 404s for that product — a security-update delivery outage from one laptop, with
// no credentials.
//
// FIXED with three layers, tested below:
//   1. the Cloudflare Cache API in front of the metadata reads, keyed canonically so the
//      query string cannot be used to bust it;
//   2. a per-IP rate limit on cache MISSES, failing OPEN (a limiter outage must not become a
//      distribution outage — the `release` bucket's registered fail mode);
//   3. GitHub quota exhaustion now surfaces as 503, not 404, so it is distinguishable from
//      a withdrawn release.

/** A minimal Cache API, matching workerd's `caches.default` closely enough to exercise it. */
class CacheMock {
  readonly store = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    const hit = this.store.get(req.url);
    return hit ? (hit.clone() as unknown as Response) : undefined;
  }
  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, res);
  }
}

/** Run `fn` with a Cache API bound to `globalThis`, as workerd provides it. */
async function withEdgeCache<T>(
  fn: (cache: CacheMock) => Promise<T>,
): Promise<T> {
  const cache = new CacheMock();
  const g = globalThis as { caches?: unknown };
  const prior = g.caches;
  g.caches = { default: cache };
  try {
    return await fn(cache);
  } finally {
    if (prior === undefined) delete g.caches;
    else g.caches = prior;
  }
}

/**
 * A release fetch stub with a call log, so GitHub subrequests can be counted. Unlike
 * `stubReleaseFetch` it answers the LIST endpoint with an array, which is what the moving
 * (`latest`) selectors this section exercises actually parse.
 */
function countingReleaseFetch(rel: Release): {
  fetchImpl: FetchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_x" }), {
        status: 200,
      }) as unknown as Response;
    if (url.includes("/releases?"))
      return new Response(JSON.stringify([rel]), {
        status: 200,
      }) as unknown as Response;
    if (url.includes("/releases"))
      return new Response(JSON.stringify(rel), {
        status: 200,
      }) as unknown as Response;
    return new Response("nope", { status: 404 }) as unknown as Response;
  };
  return { calls, fetchImpl };
}

describe("R10-05 public release surface no longer amplifies into GitHub", () => {
  it("FIXED: N identical /version requests cost ONE round of GitHub subrequests", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const rel = releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]);
    const { fetchImpl, calls } = countingReleaseFetch(rel);

    await withEdgeCache(async () => {
      const first = await handleRelease(
        mkReq("GET", {}),
        env,
        db,
        makeReleaseProduct(),
        "version",
        {},
        fetchImpl,
      );
      expect(first.status).toBe(200);
      const afterFirst = calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      // The attack: hammer the same public URL. Every one of these used to be 1-3 GitHub
      // subrequests against the hourly quota.
      for (let i = 0; i < 25; i++) {
        const res = await handleRelease(
          mkReq("GET", {}),
          env,
          db,
          makeReleaseProduct(),
          "version",
          {},
          fetchImpl,
        );
        expect(res.status).toBe(200);
      }
      expect(calls.length).toBe(afterFirst);
    });
  });

  it("CONTRAST: with no Cache API bound, every request still reaches GitHub", async () => {
    // Pins that the previous test measures the CACHE and not some other memoisation, and
    // documents the pre-fix behaviour exactly.
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const { fetchImpl, calls } = countingReleaseFetch(
      releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]),
    );
    for (let i = 0; i < 5; i++) {
      await handleRelease(
        mkReq("GET", {}),
        env,
        db,
        makeReleaseProduct(),
        "version",
        {},
        fetchImpl,
      );
    }
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("FIXED: the cache key is canonical, so a query string cannot bust it", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const { fetchImpl } = countingReleaseFetch(
      releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]),
    );

    await withEdgeCache(async (cache) => {
      for (let i = 0; i < 10; i++) {
        // `?cachebust=<i>` — the classic way to walk straight through a URL-keyed cache.
        const req = new Request(
          `https://key.plrs.im/djdl/version?cachebust=${i}`,
        ) as unknown as Request;
        await handleRelease(
          req,
          env,
          db,
          makeReleaseProduct(),
          "version",
          {},
          fetchImpl,
        );
      }
      // One entry, not ten: the key is synthesised from (product, kind, selector) only.
      expect(cache.store.size).toBe(1);
      expect([...cache.store.keys()][0]).toContain("/__polaris-release-cache");
    });
  });

  it("FIXED: distinct selectors are cached separately (the cache is correct, not just small)", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const { fetchImpl } = countingReleaseFetch(
      releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]),
    );
    await withEdgeCache(async (cache) => {
      for (const version of ["1.2.3", "1.2.4", undefined]) {
        await handleRelease(
          mkReq("GET", {}),
          env,
          db,
          makeReleaseProduct(),
          "version",
          version ? { version } : {},
          fetchImpl,
        );
      }
      expect(cache.store.size).toBe(3);
    });
  });

  it("FIXED: cache MISSES are rate-limited per IP (the 31st in a minute is a 429)", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const { fetchImpl } = countingReleaseFetch(
      releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]),
    );
    const statuses: number[] = [];
    // Distinct pinned selectors, i.e. the shape that always misses the cache — enumerating
    // versions is exactly how an attacker would defeat a cache-only fix.
    for (let i = 0; i < 32; i++) {
      const res = await handleRelease(
        mkReq("GET", {}),
        env,
        db,
        makeReleaseProduct(),
        "version",
        { version: `1.2.${i}` },
        fetchImpl,
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(statuses[31]).toBe(429);
  });

  it("FIXED: artifact streams get their own, deliberately looser budget", async () => {
    // `cli`/`dmg` are NOT cached (they stream bodies up to 2 GB) and their legitimate shape is
    // bursty — a NAT'd office on release day, parallel Range requests for a resume. Sharing
    // the 30/min metadata budget would 429 real downloads, i.e. re-create the outage.
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const { fetchImpl } = countingReleaseFetch(
      releaseWith([asset("djdl-x86_64", 9)]),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await handleRelease(
        mkReq("GET", {}),
        env,
        db,
        makeReleaseProduct(),
        "cli",
        { version: `1.2.${i}`, arch: "x86_64" },
        fetchImpl,
      );
      statuses.push(res.status);
    }
    // Well past the 30/min metadata budget, and none of them 429.
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });

  it("FIXED: a cache HIT is never metered, so a limited IP still gets served from cache", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const { fetchImpl } = countingReleaseFetch(
      releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]),
    );
    await withEdgeCache(async () => {
      const ok = async (): Promise<number> =>
        (
          await handleRelease(
            mkReq("GET", {}),
            env,
            db,
            makeReleaseProduct(),
            "version",
            {},
            fetchImpl,
          )
        ).status;
      // Prime `latest` into the cache, then burn the whole budget on misses…
      expect(await ok()).toBe(200);
      for (let i = 0; i < 40; i++) {
        await handleRelease(
          mkReq("GET", {}),
          env,
          db,
          makeReleaseProduct(),
          "version",
          { version: `9.9.${i}` },
          fetchImpl,
        );
      }
      // …the already-cached `latest` still serves. Availability is the point of this lane.
      expect(await ok()).toBe(200);
    });
  });

  it("FIXED: the limiter fails OPEN — a DO outage must not become a distribution outage", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    env.RL = brokenRl("reject");
    const { fetchImpl } = countingReleaseFetch(
      releaseWith([asset("djdl-1.2.3-arm64.dmg", 7)]),
    );
    const res = await handleRelease(
      mkReq("GET", {}),
      env,
      db,
      makeReleaseProduct(),
      "version",
      {},
      fetchImpl,
    );
    // Contrast with the credential buckets in R10-03, which deliberately fail CLOSED.
    expect(res.status).toBe(200);
  });

  it("FIXED: GitHub quota exhaustion is a 503, not the old indistinguishable 404", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const exhausted: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "ghs_x" }), {
          status: 200,
        }) as unknown as Response;
      // Primary rate limit: 403 + X-RateLimit-Remaining: 0.
      return new Response("rate limit exceeded", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
      }) as unknown as Response;
    };

    const res = await handleRelease(
      mkReq("GET", {}),
      env,
      db,
      makeReleaseProduct(),
      "version",
      {},
      exhausted,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json()) as unknown).toMatchObject({
      error: "upstream_rate_limited",
    });
  });

  it("a plain 403 (private repo / no access) still 404s — quota is the only 503", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const forbidden: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "ghs_x" }), {
          status: 200,
        }) as unknown as Response;
      return new Response("forbidden", { status: 403 }) as unknown as Response;
    };
    const res = await handleRelease(
      mkReq("GET", {}),
      env,
      db,
      makeReleaseProduct(),
      "version",
      {},
      forbidden,
    );
    // Still information-leak-free: "private" and "absent" remain indistinguishable.
    expect(res.status).toBe(404);
  });

  it("a 503 is never cached (a transient upstream failure must not stick)", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const exhausted: FetchImpl = async (input) =>
      String(input).includes("/access_tokens")
        ? (new Response(JSON.stringify({ token: "ghs_x" }), {
            status: 200,
          }) as unknown as Response)
        : (new Response("rate limit exceeded", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          }) as unknown as Response);

    await withEdgeCache(async (cache) => {
      const res = await handleRelease(
        mkReq("GET", {}),
        env,
        db,
        makeReleaseProduct(),
        "version",
        {},
        exhausted,
      );
      expect(res.status).toBe(503);
      expect(cache.store.size).toBe(0);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-15 — unbounded `.sig` asset read inlined into the appcast XML
// ═════════════════════════════════════════════════════════════════════════════
//
// FIXED. `fetchTextAsset` now checks the declared `Content-Length` AND accounts for the bytes
// it actually streams, cancelling past the cap — so an absent or lying `Content-Length` cannot
// bypass it. A Sparkle EdDSA signature is ~100 bytes; the cap is 4 KiB.

/** A body of `chunks` × 1 KiB that records how many chunks the reader actually pulled. */
function countingStream(chunks: number): {
  body: ReadableStream<Uint8Array>;
  pulled: () => number;
} {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls >= chunks) {
        controller.close();
        return;
      }
      pulls++;
      controller.enqueue(new Uint8Array(1024).fill(65));
    },
  });
  return { body, pulled: () => pulls };
}

describe("R10-15 sidecar text assets are size-capped", () => {
  it("FIXED: a declared Content-Length over the cap is refused before any body is read", async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response("A", {
        status: 200,
        headers: { "content-length": String(200 * 1024 * 1024) },
      }) as unknown as Response;
    await expect(
      fetchTextAsset("tok", "acme", "djdl", 1, fetchImpl),
    ).rejects.toThrow(/asset too large/);
  });

  it("FIXED: an ABSENT Content-Length cannot bypass the cap — the stream is accounted", async () => {
    const { body, pulled } = countingStream(200);
    const fetchImpl: FetchImpl = async () =>
      new Response(body, { status: 200 }) as unknown as Response;

    await expect(
      fetchTextAsset("tok", "acme", "djdl", 1, fetchImpl),
    ).rejects.toThrow(/asset too large/);
    // Bailed out just past the 4 KiB cap (plus the stream's own read-ahead) instead of
    // buffering the whole 200 KiB — which at real sidecar sizes is the 200 MB OOM.
    expect(pulled()).toBeLessThanOrEqual(MAX_TEXT_ASSET_BYTES / 1024 + 4);
    expect(pulled()).toBeLessThan(200);
  });

  it("a real signature (~100 bytes) is unaffected", async () => {
    const sig = "dGhpcyBpcyBhIHNwYXJrbGUgZWQyNTUxOSBzaWduYXR1cmU=";
    const fetchImpl: FetchImpl = async () =>
      new Response(sig, { status: 200 }) as unknown as Response;
    expect(await fetchTextAsset("tok", "acme", "djdl", 1, fetchImpl)).toBe(sig);
  });

  it("FIXED (e2e): an oversized .sig makes the appcast fail closed instead of OOMing", async () => {
    const db = makeTestDb();
    await seedReleaseCfg(db);
    const env = releaseEnv(new KvMock());
    const rel = releaseWith([
      asset("djdl-1.2.3-arm64.dmg", 7),
      asset("djdl-1.2.3-arm64.dmg.sig", 8),
    ]);
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "ghs_x" }), {
          status: 200,
        }) as unknown as Response;
      if (url.includes("/releases/assets/8")) {
        // The hostile sidecar: 200 MB, declared.
        return new Response("A", {
          status: 200,
          headers: { "content-length": String(200 * 1024 * 1024) },
        }) as unknown as Response;
      }
      if (url.includes("/releases?"))
        return new Response(JSON.stringify([rel]), {
          status: 200,
        }) as unknown as Response;
      if (url.includes("/releases"))
        return new Response(JSON.stringify(rel), {
          status: 200,
        }) as unknown as Response;
      return new Response("nope", { status: 404 }) as unknown as Response;
    };

    const res = await handleRelease(
      mkReq("GET", {}),
      env,
      db,
      makeReleaseProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    // 404, not a 500 and not an isolate OOM: the feed refuses to ship an unverifiable item.
    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B5-06 — outbound email amplification: one victim's inbox, many source addresses
// ═════════════════════════════════════════════════════════════════════════════
//
// `POST /api/magic/start` mails a platform-signed sign-in link to any address supplied in the
// body. It was metered per SOURCE IP only (8/min), which bounds one sender and says nothing
// about one RECIPIENT — so rotating the source address turned the endpoint into a mailer aimed
// at a third party who never had an account. FIXED with a second charge on the `portalMagicTarget`
// bucket, keyed on a HASH of the normalised address, 3/hour, registered fail-CLOSED so a Durable
// Object blip cannot reopen the exact hole this closes.

/** A portal env whose EMAIL binding records every message instead of sending it. */
function magicEnv(sent: Array<{ to: string }>): { env: Env; kv: KvMock } {
  const kv = new KvMock();
  const env = makeEnv(kv, []);
  env.EMAIL = {
    send: async (message: { to: string }) => {
      sent.push(message);
    },
  } as unknown as Env["EMAIL"];
  return { env, kv };
}

/** `POST /api/magic/start` for `email`, from `ip`. */
function magicStart(env: Env, db: Db, email: string, ip: string) {
  return handleMagicStart(
    mkReq(
      "POST",
      { "content-type": "application/json", "cf-connecting-ip": ip },
      { email },
    ),
    env,
    db,
  );
}

describe("B5-06 magic-link start: platform-signed mail to any address, per-IP budget only", () => {
  it("one target cannot be flooded from rotating source IPs", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    const sent: Array<{ to: string }> = [];
    const { env, kv } = magicEnv(sent);

    // Twenty DISTINCT source addresses, each well inside the 8/min per-IP budget — the whole
    // point of the attack is that the per-IP limiter never fires. Each of them is also a
    // separate IPv6 /64, so B5-05's aggregation does not do this job either.
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await magicStart(
        env,
        db,
        "victim@example.com",
        `2001:db8:${i}:1::9`,
      );
      statuses.push(res.status);
    }

    // Was: 20 × 200, 20 emails delivered to a stranger. Now the per-target budget is 3/hour.
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
    expect(sent).toHaveLength(3);
    expect(sent.every((m) => m.to === "victim@example.com")).toBe(true);

    // The refusal happens BEFORE the KV record is written, so a flood cannot fill HOT either.
    expect(kv.keys().filter((k) => k.startsWith("portal:magic:"))).toHaveLength(
      3,
    );
  });

  it("case and whitespace cannot buy a second budget", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    const sent: Array<{ to: string }> = [];
    const { env } = magicEnv(sent);

    // The bucket id is a hash of the address AFTER `trim().toLowerCase()` — the same
    // normalisation the seal, the mail and `getOrCreateAccountByEmail` use — so these four
    // spellings are one target, not four.
    for (const spelling of [
      "victim@example.com",
      "Victim@Example.com",
      "  VICTIM@EXAMPLE.COM  ",
      "vIcTiM@eXaMpLe.CoM",
    ]) {
      await magicStart(env, db, spelling, "203.0.113.7");
    }
    expect(sent).toHaveLength(3);

    // …and it really is per-target, not a global cap: a different address still gets its link.
    const other = await magicStart(env, db, "ada@example.com", "203.0.113.7");
    expect(other.status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual([
      "victim@example.com",
      "victim@example.com",
      "victim@example.com",
      "ada@example.com",
    ]);
  });

  it("the target address never reaches the limiter's durable storage in the clear", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    const { env } = magicEnv([]);
    // Capture the Durable Object names the limiter routes to — they are derived from the id,
    // and the DO's own storage keys embed the id verbatim (`${bucket}:${id}`).
    const names: string[] = [];
    const inner = env.RL;
    env.RL = {
      idFromName: (name: string) => {
        names.push(name);
        return inner.idFromName(name);
      },
      get: (id: DurableObjectId) => inner.get(id),
    } as unknown as Env["RL"];

    await magicStart(env, db, "victim@example.com", "203.0.113.7");

    const target = names.filter((n) => n.includes("portalMagicTarget"));
    expect(target).toHaveLength(1);
    expect(names.join(" ")).not.toContain("victim@example.com");
    expect(names.join(" ")).not.toContain("victim");
    // The id is a `hashKey` digest, so the shard name ends in a plain shard index and nothing
    // in it is reversible to an address.
    expect(target[0]).toMatch(/^_portal:portalMagicTarget:\d{1,2}$/);
  });
});
