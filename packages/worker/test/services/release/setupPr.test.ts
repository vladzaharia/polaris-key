/// <reference types="@cloudflare/workers-types" />
/**
 * A-32.5: the setup pull request. Fake GitHub only (a stateful repository: the default branch,
 * the `pkey/setup` branch and its pull requests). The first pull request, a second change
 * landing in the same one, a branch that already holds the text, an invalid composed manifest
 * (nothing written), the 409 naming the permission and the one command, the foreign or
 * retargeted pull request left alone, the audit row, and the route's gate.
 */
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { TEST_RSA_PKCS8 } from "../../releaseFixtures.js";
import { HEAD_SHA, withDefaultHead } from "../../githubHead.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import type { FetchImpl } from "../../../src/services/release/githubApp.js";
import { handleAdmin } from "../../../src/console/index.js";
import { linkRepo } from "../../../src/services/release/linkRepo.js";
import {
  createSetupPullRequest,
  parseSetupPrBody,
  type SetupPrInput,
} from "../../../src/services/release/setupPr.js";
import { ingestFor } from "../../../src/core/ingest/pipeline.js";
import { SERVICES } from "../../../src/mount.js";

const SLUG = "acme";
const REPO = "acme-org/acme-app";
const PLATFORM_GROUP = "platform-admins";
const ACTION_SHA = "c".repeat(40);
const WORKFLOW = ".github/workflows/release.yml";
const DIST = ".pkey/distribution.json";

const PRODUCT = JSON.stringify({
  slug: SLUG,
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  provisioning: [],
  profiles: [{ id: "standard", name: "standard" }],
  tiers: [{ id: "standard", label: "Standard", profileId: "standard" }],
});
const RELEASE = JSON.stringify({
  release: {
    ghOwner: "acme-org",
    ghRepo: "acme-app",
    binaryName: "acme",
    betaBranch: "main",
    summaryMarker: "pkey:summary",
    publishing: {
      trustedPublisher: { workflow: WORKFLOW, environment: "release" },
    },
  },
});
const DISTRIBUTION = JSON.stringify({
  outlets: { direct: { kind: "direct", platforms: ["macos"] } },
});

interface Pull {
  number: number;
  title: string;
  body: string;
  head: { ref: string; repo: { full_name: string } };
  base: { ref: string };
  html_url: string;
}

interface World {
  /** The default branch. */
  main: Record<string, string>;
  /** `pkey/setup`: null while it does not exist. */
  branch: Record<string, string> | null;
  pulls: Pull[];
  permissions: Record<string, string>;
  calls: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }>;
  tokenRequests: Array<Record<string, unknown>>;
}

const world = (over: Partial<World> = {}): World => ({
  main: {
    ".pkey/schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    ".pkey/product.json": PRODUCT,
    ".pkey/release.json": RELEASE,
    [DIST]: DISTRIBUTION,
  },
  branch: null,
  pulls: [],
  permissions: {
    contents: "write",
    pull_requests: "write",
    workflows: "write",
    metadata: "read",
  },
  calls: [],
  tokenRequests: [],
  ...over,
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const blobSha = (s: string): string =>
  Buffer.from(s).toString("hex").padEnd(40, "0").slice(0, 40);

const itch = {
  channel: "itch",
  identity: { target: "acme/dice", gameId: "1" },
};
const ask = (over: Partial<SetupPrInput> = {}): SetupPrInput => ({
  outlets: [itch],
  workflow: true,
  ...over,
});

function github(w: World): FetchImpl {
  return withDefaultHead(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    w.calls.push({ method, path, ...(body ? { body } : {}) });
    if (/\/app\/installations\/4242$/.test(url))
      return json(200, { permissions: w.permissions, suspended_at: null });
    if (url.endsWith("/installation")) return json(200, { id: 4242 });
    if (url.includes("/access_tokens")) {
      w.tokenRequests.push(body ?? {});
      return json(201, { token: "ghs_FAKE" });
    }
    if (/\/repos\/acme-org\/acme-app$/.test(url))
      return json(200, {
        id: 11,
        full_name: "acme-org/acme-app",
        owner: { id: 22 },
        default_branch: "main",
      });
    if (/\/git\/ref\/heads\/pkey\/setup$/.test(url))
      return w.branch
        ? json(200, { object: { sha: "d".repeat(40) } })
        : json(404, {});
    if (method === "POST" && url.endsWith("/git/refs")) {
      w.branch = { ...w.main };
      return json(201, {});
    }
    const content = /\/contents\/([^?]+)(?:\?ref=(.+))?$/.exec(url);
    if (content) {
      const file = decodeURIComponent(content[1]!);
      const ref = content[2] ? decodeURIComponent(content[2]) : "";
      if (method === "PUT") {
        w.branch![file] = Buffer.from(
          body!.content as string,
          "base64",
        ).toString("utf8");
        return json(200, {});
      }
      const files = ref === "pkey/setup" ? w.branch : w.main;
      const text = files?.[file];
      return text === undefined
        ? json(404, {})
        : json(200, {
            content: b64(text),
            encoding: "base64",
            sha: blobSha(text),
          });
    }
    if (method === "GET" && /\/pulls\?/.test(url)) return json(200, w.pulls);
    if (method === "POST" && url.endsWith("/pulls")) {
      const pr: Pull = {
        number: 7,
        title: String(body!.title),
        body: String(body!.body),
        head: { ref: "pkey/setup", repo: { full_name: "acme-org/acme-app" } },
        base: { ref: String(body!.base) },
        html_url: "https://github.com/acme-org/acme-app/pull/7",
      };
      w.pulls.push(pr);
      return json(201, pr);
    }
    const patch = /\/pulls\/(\d+)$/.exec(url);
    if (method === "PATCH" && patch) {
      Object.assign(w.pulls.find((p) => String(p.number) === patch[1])!, body);
      return json(200, {});
    }
    return json(404, {});
  });
}

const envFor = (): Env =>
  Object.assign(makeEnv(new KvMock(), []), {
    PLATFORM_ADMIN_GROUP: PLATFORM_GROUP,
    ADMIN_SESSION_SECRET: "test-admin-session-secret",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: TEST_RSA_PKCS8,
    PKEY_GIT_SHA: ACTION_SHA,
  });

async function linked(w: World) {
  const env = envFor();
  const ingest = ingestFor(SERVICES);
  const db = makeTestDb();
  const res = await linkRepo(env, db, REPO, NOW, github(w), ingest);
  if (!res.ok) throw new Error(JSON.stringify(res));
  w.calls.length = 0;
  w.tokenRequests.length = 0;
  return { db, env };
}

const workflowOnly = async (w: World) => {
  const { db, env } = await linked(w);
  return createSetupPullRequest(
    env,
    db,
    SLUG,
    ask({ outlets: [] }),
    NOW,
    github(w),
  );
};
const writes = (w: World) => w.calls.filter((c) => c.method !== "GET");
const puts = (w: World) => w.calls.filter((c) => c.method === "PUT");
const ok = (r: Awaited<ReturnType<typeof createSetupPullRequest>>) => {
  if (!("ok" in r)) throw new Error(JSON.stringify(r));
  return r;
};

describe("createSetupPullRequest", () => {
  it("opens the first pull request: branch from the head, each file a commit, the PR on the default branch", async () => {
    const w = world();
    const { db, env } = await linked(w);
    const r = ok(
      await createSetupPullRequest(env, db, SLUG, ask(), NOW, github(w)),
    );
    expect(r.pullRequest).toEqual({
      number: 7,
      url: "https://github.com/acme-org/acme-app/pull/7",
      created: true,
    });
    expect(r.files.map((f) => f.path)).toEqual([DIST, WORKFLOW]);
    expect(
      w.calls.find((c) => c.method === "POST" && c.path.endsWith("/git/refs"))
        ?.body,
    ).toEqual({
      ref: "refs/heads/pkey/setup",
      sha: HEAD_SHA,
    });
    expect(puts(w).map((c) => c.body!.branch)).toEqual([
      "pkey/setup",
      "pkey/setup",
    ]);
    expect(
      w.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))
        ?.body,
    ).toMatchObject({
      head: "pkey/setup",
      base: "main",
    });
    // The workflow is pinned to the Worker's commit; the distribution file gained the outlet.
    expect(w.branch![WORKFLOW]).toContain(`@${ACTION_SHA}`);
    expect(Object.keys(JSON.parse(w.branch![DIST]!).outlets)).toEqual([
      "direct",
      "itch",
    ]);
    // Only the workflow commit carried the Workflows permission.
    const withWorkflows = w.tokenRequests.filter(
      (t) => (t.permissions as Record<string, string>)?.workflows === "write",
    );
    expect(withWorkflows).toHaveLength(1);
    // Never a force, a delete, a merge, or another branch.
    expect(w.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(w.calls.some((c) => /merge|force/.test(c.path))).toBe(false);
  });

  it("updates the same pull request with a second change, committing on top", async () => {
    const w = world();
    const { db, env } = await linked(w);
    ok(
      await createSetupPullRequest(
        env,
        db,
        SLUG,
        ask({ workflow: false }),
        NOW,
        github(w),
      ),
    );
    w.calls.length = 0;
    // The default branch moved on; the branch is stale. The next commit still goes on top.
    w.main[DIST] = JSON.stringify({
      outlets: { direct: { kind: "direct", platforms: ["macos", "windows"] } },
    });
    const before = blobSha(w.branch![DIST]!);
    const r = ok(
      await createSetupPullRequest(
        env,
        db,
        SLUG,
        ask({
          workflow: false,
          outlets: [
            {
              channel: "itch",
              identity: { target: "acme/two", gameId: "2" },
              outletId: "itch-two",
            },
          ],
        }),
        NOW + 1,
        github(w),
      ),
    );
    expect(r.pullRequest.created).toBe(false);
    expect(w.pulls).toHaveLength(1);
    const put = puts(w)[0]!;
    expect(put.body!.sha).toBe(before);
    expect(
      w.calls.some(
        (c) => c.method === "POST" && !c.path.includes("access_tokens"),
      ),
    ).toBe(false);
    expect(
      w.calls.some((c) => c.method === "PATCH" && c.path.includes("/git/refs")),
    ).toBe(false);
  });

  it("writes nothing when the branch already holds the text", async () => {
    const w = world();
    const { db, env } = await linked(w);
    ok(await createSetupPullRequest(env, db, SLUG, ask(), NOW, github(w)));
    w.calls.length = 0;
    // The same request again: the outlet is on main only through the branch, so main still lacks it.
    const r = ok(
      await createSetupPullRequest(env, db, SLUG, ask(), NOW + 1, github(w)),
    );
    expect(r.files.every((f) => f.written)).toBe(false);
    expect(puts(w)).toHaveLength(0);
    expect(r.pullRequest).toMatchObject({ number: 7, created: false });
  });

  it("leaves the workflow out when the default branch has it", async () => {
    const w = world();
    w.main[WORKFLOW] = "name: Release\n";
    const { db, env } = await linked(w);
    const r = ok(
      await createSetupPullRequest(env, db, SLUG, ask(), NOW, github(w)),
    );
    expect(r.files.map((f) => f.path)).toEqual([DIST]);
    expect(r.summary.workflow).toBe(false);
  });

  it("refuses a change with nothing to write (400 nothing), writing nothing", async () => {
    const w = world();
    w.main[WORKFLOW] = "name: Release\n";
    const r = await workflowOnly(w);
    expect(r).toMatchObject({ status: 400, reason: "nothing" });
    expect(writes(w)).toEqual([]);
  });

  it("answers 400 for a change that leaves .pkey/ invalid, writing nothing", async () => {
    const w = world();
    const { db, env } = await linked(w);
    const r = await createSetupPullRequest(
      env,
      db,
      SLUG,
      ask({
        workflow: false,
        outlets: [{ channel: "direct", identity: {}, outletId: "direct" }],
      }),
      NOW,
      github(w),
    );
    expect(r).toMatchObject({ status: 400 });
    expect(writes(w)).toEqual([]);
    expect(w.branch).toBeNull();
  });

  it("answers 409 app_permission with the permission and the one command", async () => {
    const w = world({
      permissions: {
        contents: "write",
        pull_requests: "read",
        metadata: "read",
      },
    });
    const { db, env } = await linked(w);
    const r = await createSetupPullRequest(
      env,
      db,
      SLUG,
      ask(),
      NOW,
      github(w),
    );
    expect(r).toMatchObject({
      status: 409,
      reason: "app_permission",
      extra: {
        permission: "pull_requests: write",
        oneCommand: "pkey channel add itch",
      },
    });
    expect(writes(w)).toEqual([]);
  });

  it("names Workflows and `pkey ci init` for a workflow-only change", async () => {
    const w = world({
      permissions: {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
      },
    });
    const r = await workflowOnly(w);
    expect(r).toMatchObject({
      status: 409,
      reason: "app_permission",
      extra: { permission: "workflows: write", oneCommand: "pkey ci init" },
    });
    expect(writes(w)).toEqual([]);
  });

  it("refuses the workflow when the Worker has no commit id to pin", async () => {
    const w = world();
    const { db, env } = await linked(w);
    delete env.PKEY_GIT_SHA;
    const r = await createSetupPullRequest(
      env,
      db,
      SLUG,
      ask(),
      NOW,
      github(w),
    );
    expect(r).toMatchObject({ status: 409, reason: "action_ref" });
    expect(writes(w)).toEqual([]);
  });

  it("does not patch a pull request whose head is not this repository's pkey/setup", async () => {
    const w = world();
    w.pulls.push({
      number: 3,
      title: "x",
      body: "y",
      head: { ref: "pkey/setup", repo: { full_name: "fork-user/acme-app" } },
      base: { ref: "main" },
      html_url: "https://github.com/acme-org/acme-app/pull/3",
    });
    const { db, env } = await linked(w);
    const r = ok(
      await createSetupPullRequest(
        env,
        db,
        SLUG,
        ask({ workflow: false }),
        NOW,
        github(w),
      ),
    );
    expect(r.pullRequest).toMatchObject({ number: 7, created: true });
    expect(w.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("does not touch a setup pull request retargeted off the default branch", async () => {
    const w = world();
    w.pulls.push({
      number: 3,
      title: "x",
      body: "y",
      head: { ref: "pkey/setup", repo: { full_name: "acme-org/acme-app" } },
      base: { ref: "release" },
      html_url: "https://github.com/acme-org/acme-app/pull/3",
    });
    const { db, env } = await linked(w);
    const r = await createSetupPullRequest(
      env,
      db,
      SLUG,
      ask({ workflow: false }),
      NOW,
      github(w),
    );
    expect(r).toMatchObject({ status: 409, reason: "pull_request_base" });
    expect(
      w.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls")),
    ).toBe(false);
    expect(w.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("parseSetupPrBody", () => {
  it("needs an outlet or the workflow, and checks each field", () => {
    expect(parseSetupPrBody({})).toMatchObject({ status: 422 });
    expect(parseSetupPrBody({ workflow: "yes" })).toMatchObject({
      status: 422,
    });
    expect(parseSetupPrBody({ outlets: [{ channel: "x; rm" }] })).toMatchObject(
      { status: 422 },
    );
    expect(parseSetupPrBody({ workflow: true })).toEqual({
      outlets: [],
      workflow: true,
    });
  });
});

describe("…/release/setup/pull-request", () => {
  async function call(
    groups: string[],
    method: "GET" | "POST",
    body?: unknown,
    w: World = world(),
  ) {
    const { db, env } = await linked(w);
    const s = await consoleTestSession(
      env,
      db,
      { sub: "u1", name: "Ada", email: "ada@x.io", groups },
      NOW,
    );
    vi.stubGlobal("fetch", github(w));
    try {
      const path = `/api/products/${SLUG}/release/setup/pull-request`;
      const res = await handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          method,
          headers: {
            cookie: s.cookie,
            "X-PKey-CSRF": s.csrf,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
        db,
        path,
        { now: NOW },
      );
      return {
        w,
        db,
        status: res.status,
        body: (await res.json()) as Record<string, any>,
      };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  const auditRows = (db: Db) =>
    db.all<{ action: string; summary: string; actor_email: string }>(
      "SELECT action, summary, actor_email FROM audit WHERE product = ? AND action = 'release.setup.pull_request'",
      SLUG,
    );

  it("opens the pull request for a platform admin and audits paths and number, not content", async () => {
    const r = await call([PLATFORM_GROUP], "POST", {
      outlets: [itch],
      workflow: true,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      ok: true,
      branch: "pkey/setup",
      pullRequest: { number: 7, created: true },
    });
    const rows = await auditRows(r.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain("#7");
    expect(rows[0]!.summary).toContain(DIST);
    expect(rows[0]!.summary).not.toContain("gameId");
  });

  it("answers the 409 as JSON with reason, permission and oneCommand", async () => {
    const w = world({ permissions: { contents: "read", metadata: "read" } });
    const r = await call([PLATFORM_GROUP], "POST", { outlets: [itch] }, w);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      reason: "app_permission",
      permission: "contents: write",
      oneCommand: "pkey channel add itch",
    });
    expect(await auditRows(r.db)).toHaveLength(0);
    expect(writes(w)).toEqual([]);
  });

  it("reads the state with GET", async () => {
    const r = await call([PLATFORM_GROUP], "GET");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      repository: "acme-org/acme-app",
      state: "none",
      pullRequest: null,
    });
  });

  it("refuses a session with no access to the product, for both methods", async () => {
    expect((await call([], "POST", { workflow: true })).status).toBe(403);
    expect((await call([], "GET")).status).toBe(403);
  });
});
