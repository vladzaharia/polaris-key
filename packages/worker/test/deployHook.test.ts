/**
 * F-10 automation — the deploy hook, `POST /webhooks/deploy` (src/platformDeploy.ts): deploy.yml's
 * idempotent registration of the platform's own packages. Through the real dispatcher, with a
 * fake GitHub OIDC token (a local RSA key behind the JWKS test seam):
 *
 *   - it bootstraps the system product, links it to the platform repository and applies the root
 *     `.pkey/` (the package deliverables and the trusted publisher, with the numeric ids from the
 *     configuration, never the manifest);
 *   - a rerun changes nothing and never turns back on what an operator switched off;
 *   - an operator-claimed publisher is left exactly as set;
 *   - the policy: only deploy.yml of the configured repository, in its environment, at a protected
 *     v* tag; a replayed token, a foreign repository, another workflow, a branch, a bad body or a
 *     manifest that is not the system product's are refused; no configuration, no route.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from "jose";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_KEK } from "./seed.js";
import { CONSOLE, envFor } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { dispatchWith } from "../src/dispatch.js";
import { matchRoute } from "../src/router.js";
import {
  claimPublisherPolicy,
  getPublisherPolicy,
  GITHUB_OIDC_ISSUER,
} from "../src/core/publisher.js";
import { getProduct } from "../src/repo.js";
import { parseServices, serializeServices } from "../src/core/services.js";
import {
  DEPLOY_HOOK_PATH,
  setDeployHookJwksFetcherForTests,
} from "../src/platformDeploy.js";
import { ensureSystemProduct } from "../src/admin/systemProduct.js";

const ROOT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
);
const REPO = "vladzaharia/polaris-key";
const REPO_ID = 1278490640;
const OWNER_ID = 79390;
const HOOK = `${CONSOLE}${DEPLOY_HOOK_PATH}`;

/** The committed root `.pkey/`, as deploy.yml sends it. */
const FILES = {
  product: readFileSync(join(ROOT, ".pkey", "product.yaml"), "utf8"),
  schema: readFileSync(join(ROOT, ".pkey", "schema.yaml"), "utf8"),
  release: readFileSync(join(ROOT, ".pkey", "release.yaml"), "utf8"),
};

let key: { privateKey: KeyLike; publicKey: KeyLike };
let jwk: JWK;
beforeAll(async () => {
  key = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(key.publicKey)), kid: "gh-deploy", alg: "RS256" };
});

let db: Db;
let env: Env;
beforeEach(() => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_KEK = TEST_KEK;
  env.PLATFORM_REPOSITORY = REPO;
  env.PLATFORM_REPOSITORY_ID = String(REPO_ID);
  env.PLATFORM_REPOSITORY_OWNER_ID = String(OWNER_ID);
  setDeployHookJwksFetcherForTests(async () => ({ keys: [jwk] }));
});
afterEach(() => setDeployHookJwksFetcherForTests(null));

let jti = 0;
async function token(over: Record<string, unknown> = {}): Promise<string> {
  const ref = (over.ref as string | undefined) ?? "refs/tags/v0.9.0";
  return new SignJWT({
    sub: `repo:${REPO}:environment:production`,
    repository: REPO,
    repository_id: String(REPO_ID),
    repository_owner_id: String(OWNER_ID),
    job_workflow_ref: `${REPO}/.github/workflows/deploy.yml@${ref}`,
    ref,
    ref_protected: "true",
    environment: "production",
    runner_environment: "github-hosted",
    event_name: "push",
    run_id: "4242",
    ...over,
  })
    .setProtectedHeader({ alg: "RS256", kid: "gh-deploy" })
    .setIssuer(GITHUB_OIDC_ISSUER)
    .setAudience((over.aud as string | undefined) ?? HOOK)
    .setIssuedAt(NOW - 5)
    .setExpirationTime(NOW + 300)
    .setJti(`deploy-jti-${++jti}`)
    .sign(key.privateKey);
}

async function hook(
  bearer: string | null,
  body: unknown = { files: FILES },
  method = "POST",
): Promise<Response> {
  return dispatchWith(
    new Request(HOOK, {
      method,
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    NOW,
  );
}

async function packageIds(): Promise<string[]> {
  const rows = await db.all<{ deliverable_id: string }>(
    "SELECT deliverable_id FROM release_deliverables WHERE product = ? AND kind = 'package' ORDER BY deliverable_id",
    SYSTEM_PRODUCT_SLUG,
  );
  return rows.map((r) => r.deliverable_id);
}

describe("the deploy hook (F-10 automation)", () => {
  it("is a platform route, matched before product slugs", () => {
    expect(matchRoute(DEPLOY_HOOK_PATH).kind).toBe("deployHook");
  });

  it("bootstraps, links and applies the root .pkey/ in one call", async () => {
    const res = await hook(await token());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      slug: SYSTEM_PRODUCT_SLUG,
      created: true,
      repository: REPO,
      publisher: {
        workflow: ".github/workflows/publish-package.yml",
        environment: "package-registry",
      },
      publisherClaimed: false,
      publisherChanged: true,
    });
    const row = (await getProduct(db, SYSTEM_PRODUCT_SLUG))!;
    expect(row.system).toBe(1);
    expect(row.release_source).toBe("github");
    const cfg = await db.first<{ gh_owner: string; gh_repo: string }>(
      "SELECT gh_owner, gh_repo FROM release_config WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(cfg).toEqual({ gh_owner: "vladzaharia", gh_repo: "polaris-key" });
    // The `main` channel every push to main publishes to is a declared manual channel.
    const channels = await db.first<{ manual_channels_json: string }>(
      "SELECT manual_channels_json FROM release_config WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(
      (JSON.parse(channels!.manual_channels_json) as { name: string }[]).map(
        (c) => c.name,
      ),
    ).toEqual(["main"]);
    // Every package the committed manifest declares is now what a publish is checked against.
    const ids = await packageIds();
    expect(ids).toEqual(body.packages);
    expect(ids).toEqual(
      expect.arrayContaining([
        "npm.node",
        "pypi.polaris-key",
        "swift.polariskey",
        "maven.core",
        "godot.polaris-key",
        "oci.pkey",
      ]),
    );
    // The trusted publisher pins the CONFIGURED numeric ids.
    expect(await getPublisherPolicy(db, SYSTEM_PRODUCT_SLUG)).toMatchObject({
      repositoryId: REPO_ID,
      repositoryOwnerId: OWNER_ID,
      repository: REPO,
      workflow: ".github/workflows/publish-package.yml",
      environment: "package-registry",
      source: "manifest",
    });
    // One platform activity row, from the deploy, never a secret.
    const audit = await db.first<{ action: string; actor_sub: string }>(
      "SELECT action, actor_sub FROM platform_audit ORDER BY at DESC LIMIT 1",
    );
    expect(audit?.action).toBe("feed.bootstrap");
    expect(audit?.actor_sub).toContain(
      "ci:github:repo:vladzaharia/polaris-key",
    );
  });

  it("is idempotent, and never turns back on what an operator switched off", async () => {
    expect((await hook(await token())).status).toBe(200);
    // An operator turns Distribution and the package feeds off.
    const row = (await getProduct(db, SYSTEM_PRODUCT_SLUG))!;
    const services = parseServices(row.services_json);
    services.services.distribution = { enabled: false };
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = ?",
      serializeServices(services),
      SYSTEM_PRODUCT_SLUG,
    );
    await db.run(
      "UPDATE dist_registry_owners SET enabled = 0 WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    const before = await packageIds();
    const res = await hook(await token());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      created: false,
      publisherChanged: false,
    });
    expect(await packageIds()).toEqual(before);
    const after = (await getProduct(db, SYSTEM_PRODUCT_SLUG))!;
    expect(
      parseServices(after.services_json).services.distribution.enabled,
    ).toBe(false);
    const owner = await db.first<{ enabled: number }>(
      "SELECT enabled FROM dist_registry_owners WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(owner?.enabled).toBe(0);
  });

  it("a later deploy re-applies the manifest-owned release settings, and keeps an operator's", async () => {
    expect((await hook(await token())).status).toBe(200);
    await db.run(
      `UPDATE release_config SET manual_channels_json = NULL, gh_installation_id = 99,
              access_source = 'admin', artifacts_access = 'entitled' WHERE product = ?`,
      SYSTEM_PRODUCT_SLUG,
    );
    expect((await hook(await token())).status).toBe(200);
    const cfg = await db.first<{
      manual_channels_json: string | null;
      gh_installation_id: number | null;
      artifacts_access: string;
    }>(
      "SELECT manual_channels_json, gh_installation_id, artifacts_access FROM release_config WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(cfg?.manual_channels_json).toContain('"main"');
    expect(cfg?.gh_installation_id).toBe(99);
    expect(cfg?.artifacts_access).toBe("entitled");
  });

  it("links a system product the console bootstrapped earlier", async () => {
    const pre = await ensureSystemProduct(env, db, "u1", NOW - 100);
    expect(pre).toMatchObject({ ok: true, created: true });
    const res = await hook(await token());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false });
    expect((await packageIds()).length).toBeGreaterThan(20);
  });

  it("leaves an operator-claimed trusted publisher exactly as set", async () => {
    expect((await hook(await token())).status).toBe(200);
    await claimPublisherPolicy(
      db,
      SYSTEM_PRODUCT_SLUG,
      { workflow: ".github/workflows/other.yml", environment: "elsewhere" },
      "u1",
      NOW,
    );
    const res = await hook(await token());
    expect(await res.json()).toMatchObject({
      publisherClaimed: true,
      publisherChanged: false,
    });
    expect(await getPublisherPolicy(db, SYSTEM_PRODUCT_SLUG)).toMatchObject({
      workflow: ".github/workflows/other.yml",
      environment: "elsewhere",
      source: "admin",
    });
  });

  it("refuses a replayed token", async () => {
    const t = await token();
    expect((await hook(t)).status).toBe(200);
    const again = await hook(t);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ reason: "oidc_token_replayed" });
  });

  it.each([
    ["another repository", { repository_id: "1" }, "repository_id"],
    ["another owner", { repository_owner_id: "2" }, "repository_owner_id"],
    [
      "another workflow",
      {
        job_workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/tags/v0.9.0`,
      },
      "job_workflow_ref",
    ],
    ["another environment", { environment: "staging" }, "environment"],
    ["an unprotected ref", { ref_protected: "false" }, "ref_protected"],
    [
      "a self-hosted runner",
      { runner_environment: "self-hosted" },
      "runner_environment",
    ],
    ["a pull request", { event_name: "pull_request" }, "event_name"],
    ["a branch", { ref: "refs/heads/main" }, "ref"],
  ])("refuses a token from %s", async (_what, over, claim) => {
    const res = await hook(await token(over));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "policy_mismatch",
      claim,
    });
    expect(await getProduct(db, SYSTEM_PRODUCT_SLUG)).toBeNull();
  });

  it("refuses no token, a token for another audience, and an unsigned one", async () => {
    expect((await hook(null)).status).toBe(401);
    const wrongAud = await hook(
      await token({ aud: `${CONSOLE}/polaris-key/release/publish` }),
    );
    expect(wrongAud.status).toBe(401);
    expect(await wrongAud.json()).toMatchObject({
      reason: "invalid_oidc_token",
    });
    const forged = (await token()).replace(/\.[^.]+$/, ".AAAA");
    expect((await hook(forged)).status).toBe(401);
    expect(await getProduct(db, SYSTEM_PRODUCT_SLUG)).toBeNull();
  });

  it("refuses a bad body and a manifest that is not the system product's", async () => {
    const bad = await hook(await token(), { files: { secrets: "x" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ reason: "bad_body" });
    const invalid = await hook(await token(), {
      files: { ...FILES, release: "release: [" },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ reason: "invalid_manifest" });
    const other = await hook(await token(), {
      files: {
        ...FILES,
        product: FILES.product.replace('slug: "polaris-key"', 'slug: "djdl"'),
      },
    });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ reason: "wrong_manifest" });
    const foreign = await hook(await token(), {
      files: {
        ...FILES,
        release: FILES.release.replace(
          'owner: "vladzaharia"',
          'owner: "someone-else"',
        ),
      },
    });
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toMatchObject({ reason: "wrong_manifest" });
    // Nothing was linked by any of them.
    expect(await getPublisherPolicy(db, SYSTEM_PRODUCT_SLUG)).toBeNull();
  });

  it("does not exist without the platform repository's configuration", async () => {
    delete env.PLATFORM_REPOSITORY_ID;
    const res = await hook(await token());
    expect(res.status).toBe(404);
    expect(await getProduct(db, SYSTEM_PRODUCT_SLUG)).toBeNull();
  });

  it("answers POST only", async () => {
    expect((await hook(await token(), undefined, "GET")).status).toBe(405);
  });
});
