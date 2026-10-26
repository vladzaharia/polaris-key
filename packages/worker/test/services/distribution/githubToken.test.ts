/**
 * A-32.7 — `POST /<p>/distribution/pr/github-token` (`services/distribution/pr/githubToken.ts`),
 * through the real dispatcher and the real Release provider over a fake GitHub (a stubbed global
 * `fetch`; no real credential, nothing reaches api.github.com): the opt-in `distribution:pr`
 * scope, every refusal, the narrowed mint body, `no-store`, and that the token reaches the one
 * response and nothing else (audit rows, console output).
 *
 * The `pkeyci_` lookup (`lookupCiToken`) is mocked, as in the other CI-route suites.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The `pkeyci_` records the lookup answers: product, subject, scopes, tokenHash, expiresAt.
const tokens = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("../../../src/core/publisher.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../../src/core/publisher.js")>();
  return {
    ...real,
    lookupCiToken: async (...a: unknown[]) =>
      tokens.get(a[2] as string) ?? null,
  };
});

import { KvMock } from "../../kvMock.js";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import { CONSOLE, enableServices, envFor } from "../../releaseRoutesFixture.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { dispatch } from "../../../src/dispatch.js";
import { CI_SCOPES } from "../../../src/core/ciVocabulary.js";
import { DEFAULT_CI_SCOPES } from "../../../src/core/publisher.js";

const SLUG = "acme";
const TAPPER = "pkeyci_tapper";
const PUBLISHER = "pkeyci_publisher";
const SECRET = "ghs_FAKE_PR_TOKEN_9f3a";

let db: Db;
let env: Env;
let calls: Array<{ url: string; method: string; body: unknown }>;
let installed: Set<string>;
/** Repositories another customer installed the same App on (a different installation). */
let others: Set<string>;
let mintStatus: number;

function fakeGithub(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const inst = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
    if (inst)
      return installed.has(inst[1]!)
        ? Response.json({ id: 9 })
        : others.has(inst[1]!)
          ? Response.json({ id: 77 })
          : new Response("{}", { status: 404 });
    if (url.endsWith("/app/installations/77/access_tokens"))
      return Response.json({ token: SECRET }, { status: 201 });
    if (url.endsWith("/app/installations/9/access_tokens"))
      return mintStatus === 201
        ? Response.json({ token: SECRET }, { status: 201 })
        : new Response("{}", { status: mintStatus });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
}

async function outlet(
  id: string,
  kind: string,
  identity: Record<string, unknown>,
  removedAt: number | null = null,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, removed_at, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    SLUG,
    id,
    kind,
    JSON.stringify(identity),
    removedAt,
    NOW,
    NOW,
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  tokens.clear();
  tokens.set(TAPPER, {
    product: SLUG,
    subject: "static:tok_pr",
    scopes: ["distribution:pr"],
    tokenHash: "hash-tapper",
    expiresAt: NOW + 3600,
  });
  tokens.set(PUBLISHER, {
    product: SLUG,
    subject: "static:tok_pub",
    scopes: [...DEFAULT_CI_SCOPES],
    tokenHash: "hash-publisher",
    expiresAt: NOW + 3600,
  });
  calls = [];
  installed = new Set(["acme/homebrew-tap", "acme/bucket"]);
  others = new Set(["victimco/homebrew-private", "victimco/private-app"]);
  mintStatus = 201;
  vi.stubGlobal("fetch", fakeGithub());
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
  // The product's own linked installation: the one id the token may be minted through.
  await db.run(
    `INSERT INTO release_config (product, gh_owner, gh_repo, gh_installation_id, beta_branch,
       binary_name, summary_marker, metadata_access, artifacts_access)
     VALUES (?, 'acme', 'app', 9, 'main', 'acme', 'pkey:summary', 'public', 'public')`,
    SLUG,
  );
  await outlet("direct", "direct", { homebrewTap: "acme/homebrew-tap" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function post(body: unknown, token = TAPPER): Promise<Response> {
  return dispatch(
    new Request(`${CONSOLE}/${SLUG}/distribution/pr/github-token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    db,
  );
}

const refusal = async (res: Response) =>
  (await res.json()) as { error?: string; reason?: string };

describe("distribution:pr scope", () => {
  it("is a CI scope, opt-in", () => {
    expect(CI_SCOPES).toContain("distribution:pr");
    expect(DEFAULT_CI_SCOPES).not.toContain("distribution:pr");
  });

  it("needs a pkeyci_ token that holds it", async () => {
    const none = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/distribution/pr/github-token`, {
        method: "POST",
        body: "{}",
      }),
      env,
      db,
    );
    expect(none.status).toBe(401);
    const wrong = await post({ outlet: "direct" }, PUBLISHER);
    expect(wrong.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("POST /<p>/distribution/pr/github-token", () => {
  it("mints a token narrowed to the tap, no-store, one hour", async () => {
    const res = await post({ outlet: "direct" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      token: SECRET,
      expiresAt: NOW + 3600,
      repository: "acme/homebrew-tap",
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /repos/acme/homebrew-tap/installation",
      "POST /app/installations/9/access_tokens",
    ]);
    expect(calls[1]!.body).toEqual({
      repositories: ["homebrew-tap"],
      permissions: {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
      },
    });
  });

  it("takes the bucket, and needs the store when both are declared", async () => {
    await outlet("both", "direct", {
      homebrewTap: "acme/homebrew-tap",
      scoopBucket: "acme/bucket",
    });
    const ambiguous = await post({ outlet: "both" });
    expect(ambiguous.status).toBe(400);
    expect((await refusal(ambiguous)).reason).toBe("store_required");
    const scoop = await post({ outlet: "both", store: "scoop" });
    expect(((await scoop.json()) as { repository: string }).repository).toBe(
      "acme/bucket",
    );
  });

  it("refuses winget, flathub, a removed or unknown outlet, and an undeclared repository", async () => {
    await outlet("w", "winget", { packageIdentifier: "Acme.App" });
    await outlet("f", "flathub", { homebrewTap: "acme/homebrew-tap" });
    await outlet("gone", "direct", { homebrewTap: "acme/homebrew-tap" }, NOW);
    await outlet("none", "direct", { homebrewCask: "app" });
    const reasons: Record<string, string> = {};
    for (const id of ["w", "f", "gone", "none", "nope"])
      reasons[id] = (await refusal(await post({ outlet: id }))).reason!;
    expect(reasons).toEqual({
      w: "outlet_not_supported",
      f: "outlet_not_supported",
      gone: "unknown_outlet",
      none: "no_repository",
      nope: "unknown_outlet",
    });
    expect(calls).toEqual([]);
  });

  it("refuses an unparseable or official repository", async () => {
    await outlet("bad", "direct", { homebrewTap: "../../etc/homebrew-x" });
    await outlet("org", "direct", { homebrewTap: "Homebrew/homebrew-cask" });
    await outlet("scoop", "direct", { scoopBucket: "ScoopInstaller/Main" });
    for (const id of ["bad", "org", "scoop"])
      expect((await refusal(await post({ outlet: id }))).reason).toBe(
        "no_repository",
      );
    expect(calls).toEqual([]);
  });

  it("ignores a repository in the body and refuses a bad body", async () => {
    const res = await post({ outlet: "direct", repository: "evil/repo" });
    expect(((await res.json()) as { repository: string }).repository).toBe(
      "acme/homebrew-tap",
    );
    expect((await refusal(await post({}))).reason).toBe("bad_outlet");
    expect(
      (await refusal(await post({ outlet: "direct", store: "x" }))).reason,
    ).toBe("bad_store");
  });

  it("answers 404 app_not_installed when the App is not on the repository", async () => {
    installed.clear();
    const res = await post({ outlet: "direct" });
    expect(res.status).toBe(404);
    expect((await refusal(res)).reason).toBe("app_not_installed");
    expect(calls).toHaveLength(1);
  });

  it("refuses another customer's repository, and answers it exactly like 'not installed'", async () => {
    await outlet("other", "direct", {
      homebrewTap: "victimco/homebrew-private",
    });
    await outlet("other2", "direct", { scoopBucket: "victimco/private-app" });
    await outlet("none", "direct", { scoopBucket: "victimco/not-installed" });
    const answers: Array<{ status: number; body: string }> = [];
    for (const [id, store] of [
      ["other", "homebrew"],
      ["other2", "scoop"],
      ["none", "scoop"],
    ] as const) {
      const res = await post({ outlet: id, store });
      answers.push({ status: res.status, body: await res.text() });
    }
    expect(answers.map((a) => a.status)).toEqual([404, 404, 404]);
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
    // No token was minted for any of them.
    expect(calls.some((c) => c.url.endsWith("/access_tokens"))).toBe(false);
    expect(JSON.stringify(answers)).not.toContain(SECRET);
  });

  it("refuses when the product has no linked installation", async () => {
    await db.run("DELETE FROM release_config WHERE product = ?", SLUG);
    const res = await post({ outlet: "direct" });
    expect(res.status).toBe(404);
    expect(calls.some((c) => c.url.endsWith("/access_tokens"))).toBe(false);
  });

  it("answers 503 app_permission when GitHub refuses the narrowed grant", async () => {
    mintStatus = 422;
    const res = await post({ outlet: "direct" });
    expect(res.status).toBe(503);
    expect((await refusal(res)).reason).toBe("app_permission");
  });

  it("is not-found while Release is off", async () => {
    await enableServices(db, false, SLUG);
    const res = await post({ outlet: "direct" });
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("audits the outlet and repository, never the token, and logs nothing", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    const res = await post({ outlet: "direct" });
    expect(res.status).toBe(200);
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM audit WHERE product = ?",
      SLUG,
    );
    const mine = rows.filter(
      (r) => r.action === "distribution.pr.github_token",
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.actor_sub).toBe("ci:static:tok_pr");
    expect(mine[0]!.target_id).toBe("direct");
    expect(String(mine[0]!.summary)).toContain("acme/homebrew-tap");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain(
      SECRET,
    );
  });

  it("answers another method with the not-found", async () => {
    const res = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/distribution/pr/github-token`, {
        headers: { authorization: `Bearer ${TAPPER}` },
      }),
      env,
      db,
    );
    expect(res.status).toBe(404);
  });
});
