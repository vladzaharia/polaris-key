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
import { ADMIN_COOKIE } from "../../../src/core/console/session.js";
import { linkRepo } from "../../../src/services/release/linkRepo.js";
import { ciReadiness } from "../../../src/services/release/ciReadiness.js";
import { ingestFor } from "../../../src/core/ingest/pipeline.js";
import { SERVICES } from "../../../src/mount.js";

const SLUG = "acme";
const SHA = "b".repeat(40);
const PLATFORM_GROUP = "platform-admins";

const PRODUCT = JSON.stringify({
  name: "Acme",
  slug: SLUG,
  adminGroup: "acme-admins",
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
    if (/\/app\/installations\/4242$/.test(url))
      return w.installation === "gone"
        ? json(404, {})
        : json(200, {
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
    if (url.endsWith("/environments/release"))
      return json(w.environment, { name: "release" });
    if (url.endsWith("/rulesets"))
      return w.rulesetList === 200
        ? json(
            200,
            w.rulesets.map((r) => ({ id: r.id, target: r.target })),
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
      "repository",
      "workflowPreview",
    ]);
  });

  it("refuses a session with no access to the product", async () => {
    const { status } = await call([]);
    expect(status).toBe(403);
  });
});
