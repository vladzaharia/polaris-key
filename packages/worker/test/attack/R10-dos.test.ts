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
import { loadProduct, type Product } from "../../src/product.js";
import type { Env } from "../../src/env.js";
import type { Db } from "../../src/db/types.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import { Catalog } from "@polaris-key/catalog";
import { handleActivate, handleConfig } from "../../src/licensing.js";
import { handleSchema as handleAdminSchema } from "../../src/admin/handlers/schema.js";
import { handleRelease } from "../../src/release/index.js";
import { matchRoute } from "../../src/router.js";
import { rateLimitOk } from "../../src/rateLimit.js";
import { RateLimitDO } from "../../src/rateLimitDo.js";
import { handleGithubWebhook } from "../../src/githubWebhook.js";
import { handleAuthDeviceStart, handleAuthStart } from "../../src/oidc.js";
import {
  resolveChannel,
  type ChannelSelector,
} from "../../src/release/channels.js";
import type { Release, ReleaseAsset } from "../../src/release/github.js";
import type { FetchImpl } from "../../src/release/githubApp.js";
import type { AdminSession } from "../../src/admin/session.js";
import { getDevice, upsertDevice } from "../../src/repo.js";
import { hashKey } from "../../src/crypto.js";
import { getTokenRecord, TOKEN_RECORD_TTL_SECONDS } from "../../src/kv.js";
import { validateDeviceToken } from "../../src/licenseCore.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../../src/fingerprint.js";

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
// R10-01 — Ajv codegen on the /config hot path ⇒ guaranteed 500 on workerd
// ═════════════════════════════════════════════════════════════════════════════

// FIXED (R10-01): `@polaris-key/catalog` interprets schema fragments instead of compiling
// them, so nothing on this path constructs a function from a string. These five assertions
// are the originals INVERTED — each now pins the fixed behaviour it used to disprove. The
// `withoutCodegen` harness is retained deliberately: it is what makes these Node tests
// meaningful about workerd. See the workerd re-verification in R10-dos.md §Remediation.
describe("R10-01 catalog validation no longer generates code at request time", () => {
  it("GET /<product>/config performs ZERO dynamic codegen", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const { result, codegen } = await countCodegen(() =>
      handleConfig(
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
      handleConfig(
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

  it("with codegen disabled (as workerd does) GET /config still returns a signed 200", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const res = await withoutCodegen(() =>
      handleConfig(
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
      handleConfig(
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
    ) as { payload: { config: Record<string, { value: unknown }> } };
    // The out-of-range override never reaches the signed doc…
    expect(claims.payload.config["run.concurrency"]?.value).not.toBe(9999);
    // …while a schema-valid override on the same request does.
    expect(claims.payload.config["ui.theme"]?.value).toBe("light");
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

    const res = await withoutCodegen(() =>
      handleAdminSchema(req, db, session, "djdl", NOW),
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
  it("the router hands `aarch64`/`amd64` through verbatim as an `Arch`", () => {
    expect(matchRoute("/djdl/dmg/1.2.3/app-aarch64.dmg")).toMatchObject({
      kind: "dmg",
      arch: "aarch64",
    });
    expect(matchRoute("/djdl/cli/1.2.3/djdl-amd64")).toMatchObject({
      kind: "cli",
      arch: "amd64",
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
  async list<T>(opts?: { limit?: number }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.m) {
      if (opts?.limit !== undefined && out.size >= opts.limit) break;
      out.set(k, v as T);
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
    // Every bucket, every client, every colo → the same single object.
    expect(new Set(names)).toEqual(new Set(["djdl"]));
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

describe("R10-06 unauthenticated whole-body buffering on /webhooks/github", () => {
  it("a multi-megabyte unsigned body is fully read + HMAC'd before the 401", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    env.GITHUB_WEBHOOK_SECRET = "s3cret";

    const MB = 4;
    const body = "A".repeat(MB * 1024 * 1024);
    let consumed = 0;
    const req = new Request("https://k/webhooks/github", {
      method: "POST",
      body,
      headers: { "x-github-event": "push" },
    }) as unknown as Request;
    // Wrap arrayBuffer so we can observe the full read the handler performs.
    const orig = req.arrayBuffer.bind(req);
    (
      req as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }
    ).arrayBuffer = async () => {
      const buf = await orig();
      consumed = buf.byteLength;
      return buf;
    };

    const res = await handleGithubWebhook(req, env, db, NOW);
    expect(res.status).toBe(401);
    // The whole body was resident in isolate memory before any auth decision.
    expect(consumed).toBe(MB * 1024 * 1024);
  });

  it("there is no Content-Length precheck on the webhook (unlike /config/report)", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    env.GITHUB_WEBHOOK_SECRET = "s3cret";
    const req = new Request("https://k/webhooks/github", {
      method: "POST",
      body: "x".repeat(1024),
      headers: {
        "x-github-event": "push",
        "x-declared-length": String(500 * 1024 * 1024),
      },
    }) as unknown as Request;
    const res = await handleGithubWebhook(req, env, db, NOW);
    // A 413 would prove a size gate exists. It is a 401 — the body was read regardless.
    expect(res.status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-07 — 80-char cap does not stop catastrophic regex backtracking
// ═════════════════════════════════════════════════════════════════════════════

describe("R10-07 manual-channel regex ReDoS (MAX_REGEX_SOURCE = 80 is not a guard)", () => {
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

  it("an 8-character pattern under the cap backtracks catastrophically", () => {
    expect(EVIL.length).toBeLessThanOrEqual(80);
    // Non-pathological matching is sub-millisecond; past 250ms is catastrophic backtracking.
    // Cost doubles per extra character: a 40-char tag is ~4 minutes of CPU on one request.
    expect(timeMatch(28, 1)).toBeGreaterThan(250);
  }, 20_000);

  it("runtime doubles per extra input character (exponential, not linear)", () => {
    const short = Math.max(timeMatch(22, 1), 1);
    const longer = timeMatch(27, 1); // +5 chars ⇒ ~32x
    expect(longer).toBeGreaterThan(short * 8);
  }, 20_000);

  it("cost is multiplied by the release list length (up to 100 per request)", () => {
    const single = Math.max(timeMatch(24, 1), 1);
    const batch = timeMatch(24, 10);
    expect(batch).toBeGreaterThan(single * 5);
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-08 — uncapped request headers are written straight into D1
// ═════════════════════════════════════════════════════════════════════════════

describe("R10-08 device metadata headers are persisted with no length cap", () => {
  it("GET /config writes 16 KiB header values verbatim into `devices`", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl")) as Product;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const big = "U".repeat(16 * 1024);
    const res = await handleConfig(
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
    // Six columns × 16 KiB, versus the 128-char cap the /config/report path applies.
    expect(row?.ua?.length).toBe(16 * 1024);
    expect(row?.platform?.length).toBe(16 * 1024);
    expect(row?.arch?.length).toBe(16 * 1024);
    expect(row?.app_version?.length).toBe(16 * 1024);
    expect(row?.sdk_name?.length).toBe(16 * 1024);
    expect(row?.sdk_version?.length).toBe(16 * 1024);
  });

  it("/activate has the same unbounded write, gated only by 30/min/IP", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl")) as Product;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const big = "A".repeat(8 * 1024);
    await activate(env, db, product, key, "dev-big", { "user-agent": big });
    expect((await getDevice(db, "djdl", "dev-big"))?.ua?.length).toBe(8 * 1024);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-10 — /config is the priciest unrate-limited endpoint (D1 write per poll)
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

describe("R10-10 GET /<p>/config: no rate limit, one D1 write per poll", () => {
  it("each poll costs multiple D1 reads plus a device row write", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");

    const counted = countingDb(db);
    const res = await handleConfig(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      env,
      counted.db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    // ≥1 write per poll (upsertDevice) — unmetered, and D1 is shared by ALL products.
    expect(counted.writes).toBeGreaterThanOrEqual(1);
    expect(counted.reads).toBeGreaterThanOrEqual(5);
    // Recorded for the finding write-up; not an assertion target.
    console.log(
      `[R10-10] one GET /config = ${counted.reads} D1 reads + ${counted.writes} D1 writes`,
    );
  });

  it("200 consecutive polls from one IP are all served — there is no 429 path", async () => {
    const { db, env, product } = await seedRealCatalogProduct();
    const { key } = await seedLicenseWithKey(db, "djdl");
    const token = await activate(env, db, product, key, "dev-1");
    for (let i = 0; i < 200; i++) {
      const res = await handleConfig(
        mkReq("GET", {
          authorization: `Bearer ${token}`,
          "cf-connecting-ip": "203.0.113.9",
        }),
        env,
        db,
        product,
        NOW,
      );
      expect(res.status).toBe(200);
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
