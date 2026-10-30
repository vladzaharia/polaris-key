/// <reference types="@cloudflare/workers-types" />
/**
 * A-32.3: the CI readiness read. Fake GitHub only. Each check's three states, `unknown` naming
 * the permission, the trusted publisher by name, `distribution:pr` only for a tap or bucket
 * outlet, the workflow preview pinned to the Worker's commit, and the route's gate.
 */
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { TEST_RSA_PKCS8 } from "../../releaseFixtures.js";
import { withDefaultHead } from "../../githubHead.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import type { Env } from "../../../src/platform/env.js";
import type { FetchImpl } from "../../../src/services/release/githubApp.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { linkRepo } from "../../../src/services/release/linkRepo.js";
import { ciReadiness } from "../../../src/services/release/ciReadiness.js";
import {
  fixCiReadiness,
  releaseRuleset,
} from "../../../src/services/release/ciFix.js";
import { ingestFor } from "../../../src/core/ingest/pipeline.js";
import { SERVICES } from "../../../src/mount.js";

const SLUG = "acme";
const SHA = "b".repeat(40);
const PLATFORM_GROUP = "platform-admins";

const PRODUCT = JSON.stringify({
  name: "Acme",
  slug: SLUG,
  tiers: [{ id: "standard", label: "Standard", profileId: "standard" }],
  profiles: [{ id: "standard", name: "standard" }],
  provisioning: [],
  defaultDeviceLimit: 3,
  defaultMaxOfflineDays: 14,
  compatMin: "1.0.0",
  compatMax: "9.0.0",
});
const SCHEMA = JSON.stringify({ schemaVersion: 1, entries: [] });
const RELEASE = JSON.stringify({
  release: {
    ghOwner: "acme-org",
    ghRepo: "acme-app",
    binaryName: "acme",
    betaBranch: "main",
    summaryMarker: "pkey:summary",
    publishing: {
      trustedPublisher: {
        workflow: ".github/workflows/release.yml",
        environment: "release",
      },
    },
  },
});
const DISTRIBUTION = JSON.stringify({
  outlets: {
    direct: {
      platforms: ["macos"],
      homebrewCask: "acme",
      homebrewTap: "acme-org/homebrew-tap",
    },
  },
});

interface World {
  files: Record<string, string>;
  permissions: Record<string, string>;
  installation: "ok" | "gone" | "suspended";
  environment: number;
  rulesets: Array<Record<string, unknown>>;
  rulesetList: number;
  calls: string[];
  /** Write requests GitHub received: method, path, parsed body. */
  writes: Array<{ method: string; path: string; body: unknown }>;
  /** A status to answer the deployment-branch-policy POST with. */
  policyStatus: number;
  /** The environment's deployment-branch policies, and whether it limits deploys to them. */
  policies: Array<{ name: string; type: string }>;
  customPolicies: boolean;
}

const world = (over: Partial<World> = {}): World => ({
  files: {
    ".pkey/schema.json": SCHEMA,
    ".pkey/product.json": PRODUCT,
    ".pkey/release.json": RELEASE,
    ".github/workflows/release.yml": "name: Release\n",
  },
  permissions: {
    contents: "write",
    pull_requests: "write",
    workflows: "write",
    administration: "write",
    actions: "read",
    metadata: "read",
  },
  installation: "ok",
  environment: 200,
  rulesets: [
    {
      id: 9,
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    },
  ],
  rulesetList: 200,
  calls: [],
  writes: [],
  policyStatus: 201,
  policies: [{ name: "v*", type: "tag" }],
  customPolicies: true,
  ...over,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

function github(w: World): FetchImpl {
  return withDefaultHead(async (input, init) => {
    const url = String(input);
    w.calls.push(
      `${init?.method ?? "GET"} ${url.replace("https://api.github.com", "")}`,
    );
    if (url.endsWith("/app"))
      return json(200, { slug: "polaris-key-ci", id: 12345 });
    if (/\/app\/installations\/4242$/.test(url))
      return w.installation === "gone"
        ? json(404, {})
        : json(200, {
            html_url:
              "https://github.com/organizations/acme-org/settings/installations/4242",
            permissions: w.permissions,
            suspended_at: w.installation === "suspended" ? "2026-01-01" : null,
          });
    if (/\/repos\/acme-org\/acme-app$/.test(url))
      return json(200, {
        id: 11,
        full_name: "acme-org/acme-app",
        owner: { id: 22 },
      });
    if (url.endsWith("/installation")) return json(200, { id: 4242 });
    if (url.includes("/access_tokens")) return json(201, { token: "ghs_FAKE" });
    const content = /\/contents\/([^?]+)/.exec(url);
    if (content) {
      const body = w.files[decodeURIComponent(content[1]!)];
      return body === undefined
        ? json(404, {})
        : json(200, {
            content: Buffer.from(body, "utf8").toString("base64"),
            encoding: "base64",
          });
    }
    const method = init?.method ?? "GET";
    if (method !== "GET" && !url.includes("/access_tokens")) {
      w.writes.push({
        method,
        path: url.replace("https://api.github.com", ""),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/environments/release")) {
        w.environment = 200;
        w.customPolicies = true;
        return json(200, { name: "release" });
      }
      if (url.endsWith("/deployment-branch-policies")) {
        if (w.policyStatus === 201 || w.policyStatus === 200)
          w.policies.push({ name: "v*", type: "tag" });
        return json(w.policyStatus, {});
      }
      if (url.endsWith("/rulesets")) {
        w.rulesets.push({ id: 77, target: "tag", enforcement: "active" });
        return json(201, { id: 77 });
      }
      return json(200, {});
    }
    if (url.endsWith("/environments/release"))
      return json(w.environment, {
        name: "release",
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: w.customPolicies,
        },
      });
    if (url.endsWith("/environments/release/deployment-branch-policies"))
      return json(200, {
        total_count: w.policies.length,
        branch_policies: w.policies,
      });
    if (url.endsWith("/rulesets"))
      return w.rulesetList === 200
        ? json(
            200,
            w.rulesets.map((r) => ({
              id: r.id,
              target: r.target,
              name: r.name,
            })),
          )
        : json(w.rulesetList, {});
    const one = /\/rulesets\/(\d+)$/.exec(url);
    if (one) {
      const r = w.rulesets.find((x) => String(x.id) === one[1]);
      return r ? json(200, r) : json(404, {});
    }
    return json(404, {});
  });
}

const envFor = (): Env => {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
};

async function linked(w: World) {
  const db = makeTestDb();
  const env = envFor();
  const res = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    NOW,
    github(w),
    ingestFor(SERVICES),
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return { db, env };
}

const states = (r: Awaited<ReturnType<typeof ciReadiness>>) =>
  Object.fromEntries(r.checks.map((c) => [c.id, c.state]));

describe("ciReadiness", () => {
  it("is ready: every check ok, the publisher named, capabilities from the grant", async () => {
    const w = world();
    const { db, env } = await linked(w);
    const r = await ciReadiness(env, db, SLUG, NOW, github(w));
    expect(r.repository).toBe("acme-org/acme-app");
    expect(states(r)).toEqual({
      app: "ok",
      "release-manifest": "ok",
      workflow: "ok",
      environment: "ok",
      ruleset: "ok",
      publisher: "ok",
    });
    expect(r.checks.find((c) => c.id === "publisher")?.detail).toBe(
      ".github/workflows/release.yml · release",
    );
    expect(r.capabilities).toEqual({
      pullRequest: true,
      workflow: true,
      environment: true,
      ruleset: true,
    });
    expect(r.workflowPreview).toContain("name: Release");
    expect(r.workflowPreview).toContain("<commit-sha>");
    // Reads only: nothing but GET and the token mint.
    expect(
      w.calls.filter((c) => !/^GET /.test(c) && !c.includes("/access_tokens")),
    ).toEqual([]);
  });

  it("pins the preview to the commit the Worker runs", async () => {
    const w = world();
    const { db, env } = await linked(w);
    env.PKEY_GIT_SHA = SHA;
    const r = await ciReadiness(env, db, SLUG, NOW, github(w));
    expect(r.workflowPreview).toContain(`publish@${SHA}`);
  });

  it("reports what is missing: workflow, environment, ruleset", async () => {
    const w = world({ environment: 404, rulesets: [] });
    delete w.files[".github/workflows/release.yml"];
    const { db, env } = await linked(w);
    const r = await ciReadiness(env, db, SLUG, NOW, github(w));
    expect(states(r)).toMatchObject({
      workflow: "missing",
      environment: "missing",
      ruleset: "missing",
      app: "ok",
    });
  });

  it("a ruleset that is not active or covers another ref is missing", async () => {
    const w = world({
      rulesets: [
        {
          id: 9,
          target: "tag",
          enforcement: "evaluate",
          conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
        },
        {
          id: 10,
          target: "tag",
          enforcement: "active",
          conditions: { ref_name: { include: ["refs/tags/x*"], exclude: [] } },
        },
      ],
    });
    const { db, env } = await linked(w);
    expect(
      states(await ciReadiness(env, db, SLUG, NOW, github(w))).ruleset,
    ).toBe("missing");
  });

  it("names the permission when the installation cannot read the environment", async () => {
    const w = world({ permissions: { contents: "read", metadata: "read" } });
    const { db, env } = await linked(w);
    const r = await ciReadiness(env, db, SLUG, NOW, github(w));
    expect(r.checks.find((c) => c.id === "environment")).toEqual({
      id: "environment",
      state: "unknown",
      permission: "actions: read",
    });
    expect(w.calls.some((c) => c.includes("/environments/"))).toBe(false);
    expect(r.capabilities.pullRequest).toBe(false);
  });

  it("a GitHub refusal is unknown, not missing", async () => {
    const w = world({ environment: 403, rulesetList: 403 });
    const { db, env } = await linked(w);
    expect(
      states(await ciReadiness(env, db, SLUG, NOW, github(w))),
    ).toMatchObject({
      environment: "unknown",
      ruleset: "unknown",
    });
  });

  it("an invalid manifest is missing, with its reason, and the rest still answers", async () => {
    const w = world();
    const { db, env } = await linked(w);
    w.files[".pkey/product.json"] = "{";
    const r = await ciReadiness(env, db, SLUG, NOW, github(w));
    expect(r.checks.find((c) => c.id === "release-manifest")?.state).toBe(
      "missing",
    );
    expect(states(r).workflow).toBe("ok");
  });

  it("no publisher policy is missing", async () => {
    const w = world();
    const { db, env } = await linked(w);
    await db.run("DELETE FROM ci_publishers WHERE product = ?", SLUG);
    expect(
      states(await ciReadiness(env, db, SLUG, NOW, github(w))).publisher,
    ).toBe("missing");
  });

  it("an installation that is gone or suspended is not installed; the rest is unknown", async () => {
    for (const installation of ["gone", "suspended"] as const) {
      const w = world();
      const { db, env } = await linked(w);
      w.installation = installation;
      const r = await ciReadiness(env, db, SLUG, NOW, github(w));
      expect(states(r)).toEqual({
        app: "missing",
        "release-manifest": "unknown",
        workflow: "unknown",
        environment: "unknown",
        ruleset: "unknown",
        publisher: "unknown",
      });
      expect(r.capabilities.pullRequest).toBe(false);
      expect(r.workflowPreview).toContain("name: Release");
    }
  });

  it("asks for distribution:pr only when a Homebrew or Scoop outlet is declared", async () => {
    const plain = world();
    const a = await linked(plain);
    expect(
      states(await ciReadiness(a.env, a.db, SLUG, NOW, github(plain))),
    ).not.toHaveProperty("distribution-pr");

    const tap = world();
    tap.files[".pkey/distribution.json"] = DISTRIBUTION;
    const b = await linked(tap);
    expect(
      states(await ciReadiness(b.env, b.db, SLUG, NOW, github(tap)))[
        "distribution-pr"
      ],
    ).toBe("missing");
    await b.db.run(
      "UPDATE ci_publishers SET scopes_json = ? WHERE product = ?",
      JSON.stringify(["release:publish", "distribution:pr"]),
      SLUG,
    );
    expect(
      states(await ciReadiness(b.env, b.db, SLUG, NOW, github(tap)))[
        "distribution-pr"
      ],
    ).toBe("ok");
  });

  it("links to the App's install page while it is missing, and to the installation while a permission is", async () => {
    const gone = world({ installation: "gone" });
    const { db, env } = await linked(world());
    const a = await ciReadiness(env, db, SLUG, NOW, github(gone));
    expect(a.links).toEqual({
      install: "https://github.com/apps/polaris-key-ci/installations/new",
      installation: null,
    });
    const lacking = world({
      permissions: { contents: "write", metadata: "read" },
    });
    const b = await ciReadiness(env, db, SLUG, NOW, github(lacking));
    expect(b.links.installation).toBe(
      "https://github.com/organizations/acme-org/settings/installations/4242",
    );
    const ready = await ciReadiness(env, db, SLUG, NOW, github(world()));
    expect(ready.links).toEqual({ install: null, installation: null });
  });

  it("a GitHub that does not answer for the links leaves them null", async () => {
    const w = world({ installation: "gone" });
    const { db, env } = await linked(world());
    const fetchImpl: FetchImpl = async (input, init) =>
      String(input).endsWith("/app") ? json(500, {}) : github(w)(input, init);
    const r = await ciReadiness(env, db, SLUG, NOW, fetchImpl);
    expect(r.links.install).toBeNull();
    expect(r.releaseKeys).toBe(false);
  });

  it("a product without a repository is not installed", async () => {
    const db = makeTestDb();
    const r = await ciReadiness(envFor(), db, "nobody", NOW, github(world()));
    expect(r.repository).toBeNull();
    expect(states(r).app).toBe("missing");
  });
});

describe("GET …/release/ci-readiness", () => {
  async function call(groups: string[]) {
    const w = world();
    const { db, env } = await linked(w);
    const { token } = await consoleTestSession(
      env,
      db,
      { sub: "u1", name: "Ada", email: "ada@x.io", groups },
      NOW,
    );
    vi.stubGlobal("fetch", github(w));
    try {
      const path = `/api/products/${SLUG}/release/ci-readiness`;
      const res = await handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          headers: { cookie: `${ADMIN_COOKIE}=${token}` },
        }),
        env,
        db,
        path,
        { now: NOW },
      );
      return {
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
      };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("answers the checks to a platform admin", async () => {
    const { status, body } = await call([PLATFORM_GROUP]);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "capabilities",
      "checks",
      "environmentName",
      "links",
      "releaseKeys",
      "repository",
      "workflowPreview",
    ]);
  });

  it("refuses a session with no access to the product", async () => {
    const { status } = await call([]);
    expect(status).toBe(403);
  });
});

describe("fixCiReadiness (A-32.6)", () => {
  const bare = () => world({ environment: 404, rulesets: [] });
  const fixOnly = async (w: World, check: "environment" | "ruleset") => {
    const { db, env } = await linked(w);
    return fixCiReadiness(env, db, SLUG, [check], NOW, github(w));
  };
  const fixBoth = async (w: World) => {
    const { db, env } = await linked(w);
    return fixCiReadiness(
      env,
      db,
      SLUG,
      ["environment", "ruleset"],
      NOW,
      github(w),
    );
  };

  it("creates both, with the exact request bodies", async () => {
    const w = bare();
    const r = await fixBoth(w);
    expect(r).toEqual({
      ok: true,
      repository: "acme-org/acme-app",
      results: [
        { id: "environment", state: "created" },
        { id: "ruleset", state: "created" },
      ],
    });
    expect(w.writes).toEqual([
      {
        method: "PUT",
        path: "/repos/acme-org/acme-app/environments/release",
        body: {
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        },
      },
      {
        method: "POST",
        path: "/repos/acme-org/acme-app/environments/release/deployment-branch-policies",
        body: { name: "v*", type: "tag" },
      },
      {
        method: "POST",
        path: "/repos/acme-org/acme-app/rulesets",
        body: {
          bypass_actors: [
            {
              bypass_mode: "always",
              actor_type: "RepositoryRole",
              actor_id: 5,
            },
          ],
          rules: ["non_fast_forward", "update", "deletion", "creation"]
            .reverse()
            .map((type) => ({ type })),
          conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
          enforcement: "active",
          target: "tag",
          name: "Polaris Key release tags",
        },
      },
    ]);
  });

  it("is idempotent: what exists is left alone and reported ok", async () => {
    const w = world();
    const r = await fixBoth(w);
    expect(r).toMatchObject({
      ok: true,
      results: [
        { id: "environment", state: "ok" },
        { id: "ruleset", state: "ok" },
      ],
    });
    expect(w.writes).toEqual([]);
  });

  it("fixes only what was asked: one missing, one existing", async () => {
    const w = world({ rulesets: [] });
    const { db, env } = await linked(w);
    const r = await fixCiReadiness(env, db, SLUG, ["ruleset"], NOW, github(w));
    expect(r).toMatchObject({ ok: true, results: [{ id: "ruleset" }] });
    expect(w.writes.map((x) => x.path)).toEqual([
      "/repos/acme-org/acme-app/rulesets",
    ]);
  });

  it("updates Polaris Key's own inactive ruleset in place", async () => {
    const w = world({
      rulesets: [
        {
          id: 9,
          name: "Polaris Key release tags",
          target: "tag",
          enforcement: "disabled",
          conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
        },
      ],
    });
    const { db, env } = await linked(w);
    const r = await fixCiReadiness(env, db, SLUG, ["ruleset"], NOW, github(w));
    expect(r).toMatchObject({ ok: true, results: [{ state: "updated" }] });
    expect(w.writes).toEqual([
      {
        method: "PUT",
        path: "/repos/acme-org/acme-app/rulesets/9",
        body: releaseRuleset(),
      },
    ]);
  });

  it("a duplicate deployment policy (GitHub's 303) is not a failure", async () => {
    const w = world({ environment: 404, policyStatus: 303 });
    const r = await fixOnly(w, "environment");
    expect(r).toMatchObject({ ok: true, results: [{ state: "created" }] });
  });

  it("a rejected deployment policy (422) is a failure, not created", async () => {
    const w = world({ environment: 404, policyStatus: 422 });
    const r = await fixOnly(w, "environment");
    expect(r).toMatchObject({ ok: false, status: 502, reason: "github" });
  });

  it("without Administration write: 409 naming it, nothing written", async () => {
    const w = world({
      environment: 404,
      rulesets: [],
      permissions: {
        contents: "write",
        actions: "read",
        metadata: "read",
        administration: "read",
      },
    });
    const r = await fixBoth(w);
    expect(r).toEqual({
      ok: false,
      status: 409,
      reason: "app_permission",
      permission: "administration: write",
      results: [],
    });
    expect(w.writes).toEqual([]);
  });

  it("a permission that is present for what is ok does not block: only missing checks need it", async () => {
    const w = world({
      permissions: { contents: "write", actions: "read", metadata: "read" },
    });
    const r = await fixOnly(w, "environment");
    expect(r).toMatchObject({ ok: true, results: [{ state: "ok" }] });
  });

  it("an unreadable check is skipped, not written", async () => {
    const w = world({ environment: 403 });
    const r = await fixOnly(w, "environment");
    expect(r).toMatchObject({ ok: true, results: [{ state: "skipped" }] });
    expect(w.writes).toEqual([]);
  });

  it("no installation: 409 app_not_installed", async () => {
    const w = world();
    const { db, env } = await linked(w);
    w.installation = "gone";
    expect(
      await fixCiReadiness(env, db, SLUG, ["ruleset"], NOW, github(w)),
    ).toMatchObject({ ok: false, status: 409, reason: "app_not_installed" });
  });
});

describe("POST …/release/ci-readiness/fix", () => {
  async function call(groups: string[], body: unknown, stepUp = true) {
    const w = world({ environment: 404, rulesets: [] });
    const { db, env } = await linked(w);
    const { token, csrf } = await consoleTestSession(
      env,
      db,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups,
        ...(stepUp ? { authTime: NOW, stepUp: true } : {}),
      },
      NOW,
    );
    vi.stubGlobal("fetch", github(w));
    try {
      const path = `/api/products/${SLUG}/release/ci-readiness/fix`;
      const res = await handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          method: "POST",
          headers: {
            cookie: `${ADMIN_COOKIE}=${token}`,
            "content-type": "application/json",
            [CSRF_HEADER]: csrf,
          },
          body: JSON.stringify(body),
        }),
        env,
        db,
        path,
        { now: NOW },
      );
      const audits = await db.all<{ action: string; summary: string }>(
        "SELECT action, summary FROM audit WHERE action LIKE 'release.ci.%' ORDER BY action",
      );
      return {
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
        audits,
        w,
      };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("creates, audits each write, and returns the outcomes", async () => {
    const r = await call([PLATFORM_GROUP], {
      checks: ["environment", "ruleset"],
    });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([
      { id: "environment", state: "created" },
      { id: "ruleset", state: "created" },
    ]);
    expect(r.audits.map((a) => a.action)).toEqual([
      "release.ci.environment",
      "release.ci.ruleset",
    ]);
    expect(JSON.stringify(r.audits)).not.toContain("ghs_");
  });

  it("422 for an unknown or empty checks list", async () => {
    for (const checks of [[], ["workflow"], ["ruleset", "ruleset"], "ruleset"])
      expect((await call([PLATFORM_GROUP], { checks })).status).toBe(422);
  });

  it("needs a recent sign-in proof (step-up): nothing is written without one", async () => {
    const r = await call([PLATFORM_GROUP], { checks: ["ruleset"] }, false);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("step_up_required");
    expect(r.w.writes).toEqual([]);
  });

  it("refuses a session with no access to the product", async () => {
    const r = await call([], { checks: ["ruleset"] });
    expect(r.status).toBe(403);
    expect(r.w.writes).toEqual([]);
  });
});

const fixEnv = (
  env: Env,
  db: ReturnType<typeof makeTestDb>,
  w: World,
): ReturnType<typeof fixCiReadiness> =>
  fixCiReadiness(env, db, SLUG, ["environment"], NOW, github(w));

/** The one outcome of fixing the environment of a linked world. */
async function fixSkipped(w: World): Promise<string> {
  const { db, env } = await linked(w);
  const r = await fixEnv(env, db, w);
  return r.ok ? r.results[0]!.state : "failed";
}

describe("the environment check reads its deployment policies", () => {
  it("an environment without the v* tag policy is missing, and the fix adds only the policy", async () => {
    const w = world({ policies: [] });
    const { db, env } = await linked(w);
    const after = await ciReadiness(env, db, SLUG, NOW, github(w));
    expect(states(after).environment).toBe("missing");
    const r = await fixEnv(env, db, w);
    expect(r).toMatchObject({ ok: true });
    // No PUT: an update of an existing environment may reset its reviewers.
    expect(
      w.writes.map((x) => `${x.method} ${x.path.split("/").pop()}`),
    ).toEqual(["POST deployment-branch-policies"]);
    expect(
      states(await ciReadiness(env, db, SLUG, NOW, github(w))).environment,
    ).toBe("ok");
  });

  it("a half-applied fix is offered again", async () => {
    const w = world({
      environment: 404,
      rulesets: [],
      policyStatus: 500,
      policies: [],
    });
    const { db, env } = await linked(w);
    const first = await fixEnv(env, db, w);
    expect(first).toMatchObject({
      ok: false,
      status: 502,
      reason: "github",
      results: [
        {
          id: "environment",
          state: "created",
          detail: "environment created, tag policy not added",
        },
      ],
    });
    expect(
      states(await ciReadiness(env, db, SLUG, NOW, github(w))).environment,
    ).toBe("missing");
    w.policyStatus = 201;
    const again = await fixEnv(env, db, w);
    expect(again).toMatchObject({
      ok: true,
      results: [{ id: "environment", state: "created" }],
    });
    expect(
      states(await ciReadiness(env, db, SLUG, NOW, github(w))).environment,
    ).toBe("ok");
  });

  it("an environment not limited to selected tags is left to the person (no PUT)", async () => {
    const w = world({ customPolicies: false, policies: [] });
    expect(await fixSkipped(w)).toBe("skipped");
    expect(w.writes).toEqual([]);
  });

  it("an environment name of dots is not read", async () => {
    const w = world();
    w.files[".pkey/release.json"] = RELEASE.replace(
      '"environment":"release"',
      '"environment":".."',
    );
    const { db, env } = await linked(w);
    await ciReadiness(env, db, SLUG, NOW, github(w));
    expect(w.calls.some((c) => /\/\.\.(\/|$)/.test(c))).toBe(false);
  });

  it("the fix writes release only when the manifest names that environment", async () => {
    const w = world({ environment: 404, rulesets: [] });
    w.files[".pkey/release.json"] = RELEASE.replace(
      '"environment":"release"',
      '"environment":"production"',
    );
    expect(await fixSkipped(w)).toBe("skipped");
    expect(w.writes).toEqual([]);
  });
});

describe("the tag ruleset", () => {
  it("also blocks creating a v* tag", () => {
    expect(releaseRuleset().rules.map((r) => r.type)).toContain("creation");
  });
});
