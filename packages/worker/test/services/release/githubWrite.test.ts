/// <reference types="@cloudflare/workers-types" />
/**
 * A-32.1: the GitHub write client, its allow-list and never-list, and App capabilities.
 * Fakes only: nothing here reaches api.github.com, and no real credential is used.
 */
import { describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { KvMock } from "../../kvMock.js";
import { makeEnv } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import {
  authorize,
  WriteRefused,
  type WriteRequest,
} from "../../../src/services/release/github/allow.js";
import {
  capabilitiesFrom,
  githubWrite,
  installationCapabilities,
  writeToken,
} from "../../../src/services/release/github/write.js";

/** One write to acme/app through the fake GitHub, at a fixed time. */
const send = (
  env: Env,
  gh: { fetchImpl: (u: string, i?: RequestInit) => Promise<Response> },
  action: string,
  req: WriteRequest,
): ReturnType<typeof githubWrite> =>
  githubWrite(
    env,
    7,
    { owner: "acme", repo: "app" },
    action,
    req,
    1000,
    gh.fetchImpl,
  );

const SHA = "a".repeat(40);
const R = "/repos/acme/app";

async function appEnv(kv = new KvMock()): Promise<Env> {
  const env = makeEnv(kv);
  env.GITHUB_APP_ID = "123456";
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  env.GITHUB_APP_PRIVATE_KEY = await exportPKCS8(privateKey);
  return env;
}

interface Call {
  url: string;
  method: string;
  auth: string;
  body: unknown;
}

/** A fake GitHub: token mints answer `ghs_FAKE`, everything else answers `reply`. */
function fakeGithub(reply: () => Response = () => json(201, { ok: true })): {
  fetchImpl: (u: string, i?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: init?.method ?? "GET",
        auth: headers.Authorization ?? "",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/access_tokens"))
        return json(201, { token: "ghs_FAKE" });
      return reply();
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const tagRuleset = {
  name: "Polaris Key release tags",
  target: "tag",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  rules: [
    { type: "deletion" },
    { type: "update" },
    { type: "non_fast_forward" },
  ],
  bypass_actors: [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ],
};

/** One accepted request per action: the exact request and the permissions it needs. */
const ACCEPTED: Array<[string, string, WriteRequest, Record<string, string>]> =
  [
    [
      "setup.branch",
      "read base ref",
      { method: "GET", path: `${R}/git/ref/heads/main` },
      { contents: "write", metadata: "read" },
    ],
    [
      "setup.branch",
      "create",
      {
        method: "POST",
        path: `${R}/git/refs`,
        body: { ref: "refs/heads/pkey/setup", sha: SHA },
      },
      { contents: "write", metadata: "read" },
    ],
    [
      "setup.branch",
      "fast-forward",
      {
        method: "PATCH",
        path: `${R}/git/refs/heads/pkey/setup`,
        body: { sha: SHA },
      },
      { contents: "write", metadata: "read" },
    ],
    [
      "setup.file",
      "read",
      { method: "GET", path: `${R}/contents/.pkey/release.yml?ref=pkey/setup` },
      { contents: "read", metadata: "read" },
    ],
    [
      "setup.file",
      "put manifest",
      {
        method: "PUT",
        path: `${R}/contents/.pkey/distribution.yaml`,
        body: { message: "Add outlets", content: "YQ==", branch: "pkey/setup" },
      },
      { contents: "write", metadata: "read" },
    ],
    [
      "setup.file",
      "put workflow",
      {
        method: "PUT",
        path: `${R}/contents/.github/workflows/release.yml`,
        body: {
          message: "Add workflow",
          content: "YQ==",
          branch: "pkey/setup",
          sha: SHA,
        },
      },
      { contents: "write", workflows: "write", metadata: "read" },
    ],
    [
      "setup.pr",
      "find",
      {
        method: "GET",
        path: `${R}/pulls?head=acme:pkey/setup&state=open`,
      },
      { pull_requests: "read", metadata: "read" },
    ],
    [
      "setup.pr",
      "create",
      {
        method: "POST",
        path: `${R}/pulls`,
        body: { title: "Set up", head: "pkey/setup", base: "main", body: "x" },
      },
      { pull_requests: "write", metadata: "read" },
    ],
    [
      "setup.pr",
      "update",
      {
        method: "PATCH",
        path: `${R}/pulls/12`,
        body: { title: "t", body: "b" },
      },
      { pull_requests: "write", metadata: "read" },
    ],
    [
      "env.release",
      "environment",
      {
        method: "PUT",
        path: `${R}/environments/release`,
        body: {
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        },
      },
      { administration: "write", metadata: "read" },
    ],
    [
      "env.release",
      "tag policy",
      {
        method: "POST",
        path: `${R}/environments/release/deployment-branch-policies`,
        body: { name: "v*", type: "tag" },
      },
      { administration: "write", metadata: "read" },
    ],
    [
      "ruleset.tags",
      "list",
      { method: "GET", path: `${R}/rulesets` },
      { metadata: "read" },
    ],
    [
      "ruleset.tags",
      "create",
      { method: "POST", path: `${R}/rulesets`, body: tagRuleset },
      { administration: "write", metadata: "read" },
    ],
    [
      "ruleset.tags",
      "update",
      { method: "PUT", path: `${R}/rulesets/42`, body: tagRuleset },
      { administration: "write", metadata: "read" },
    ],
  ];

/** The caller's own confirmation of the pull request or ruleset the path ends in. */
const confirmed = (path: string) => {
  const n = Number(/\/(?:pulls|rulesets)\/(\d+)$/.exec(path)?.[1]);
  return Number.isInteger(n) ? { pull: n, ruleset: n } : {};
};

describe("allow-list", () => {
  it.each(ACCEPTED)("%s: %s", (action, _name, req, permissions) => {
    const a = authorize(action, "acme", "app", req, confirmed(req.path));
    expect(a.permissions).toEqual(permissions);
    expect(a.method).toBe(req.method);
    expect(a.path).toBe(req.path);
  });
});

/** Every one of these is refused, and none reaches fetch. */
const REFUSED: Array<[string, string, string, WriteRequest]> = [
  [
    "merge a pull request",
    "setup.pr",
    "method",
    { method: "PUT", path: `${R}/pulls/12/merge`, body: {} },
  ],
  [
    "close a pull request",
    "setup.pr",
    "body",
    { method: "PATCH", path: `${R}/pulls/12`, body: { state: "closed" } },
  ],
  [
    "retarget a pull request",
    "setup.pr",
    "body",
    { method: "PATCH", path: `${R}/pulls/12`, body: { base: "dev" } },
  ],
  [
    "open a pull request from another branch",
    "setup.pr",
    "branch",
    {
      method: "POST",
      path: `${R}/pulls`,
      body: { title: "t", head: "feature", base: "main" },
    },
  ],
  [
    "let maintainers modify",
    "setup.pr",
    "body",
    {
      method: "POST",
      path: `${R}/pulls`,
      body: {
        title: "t",
        head: "pkey/setup",
        base: "main",
        maintainer_can_modify: true,
      },
    },
  ],
  [
    "delete the setup ref",
    "setup.branch",
    "method",
    {
      method: "DELETE",
      path: `${R}/git/refs/heads/pkey/setup`,
    } as WriteRequest,
  ],
  [
    "force-update the setup ref",
    "setup.branch",
    "body",
    {
      method: "PATCH",
      path: `${R}/git/refs/heads/pkey/setup`,
      body: { sha: SHA, force: true },
    },
  ],
  [
    "send force: false",
    "setup.branch",
    "body",
    {
      method: "PATCH",
      path: `${R}/git/refs/heads/pkey/setup`,
      body: { sha: SHA, force: false },
    },
  ],
  [
    "update the default branch",
    "setup.branch",
    "method",
    { method: "PATCH", path: `${R}/git/refs/heads/main`, body: { sha: SHA } },
  ],
  [
    "create another branch",
    "setup.branch",
    "branch",
    {
      method: "POST",
      path: `${R}/git/refs`,
      body: { ref: "refs/heads/other", sha: SHA },
    },
  ],
  [
    "create a tag",
    "setup.branch",
    "branch",
    {
      method: "POST",
      path: `${R}/git/refs`,
      body: { ref: "refs/tags/v1", sha: SHA },
    },
  ],
  [
    "write a file to the default branch",
    "setup.file",
    "branch",
    {
      method: "PUT",
      path: `${R}/contents/.pkey/release.yml`,
      body: { message: "m", content: "YQ==", branch: "main" },
    },
  ],
  [
    "write a file with no branch",
    "setup.file",
    "body",
    {
      method: "PUT",
      path: `${R}/contents/.pkey/release.yml`,
      body: { message: "m", content: "YQ==" },
    },
  ],
  [
    "write a file outside the list",
    "setup.file",
    "file",
    {
      method: "PUT",
      path: `${R}/contents/README.md`,
      body: { message: "m", content: "YQ==", branch: "pkey/setup" },
    },
  ],
  [
    "write another workflow",
    "setup.file",
    "file",
    {
      method: "PUT",
      path: `${R}/contents/.github/workflows/evil.yml`,
      body: { message: "m", content: "YQ==", branch: "pkey/setup" },
    },
  ],
  [
    "traverse out of .pkey",
    "setup.file",
    "path",
    {
      method: "PUT",
      path: `${R}/contents/.pkey/../.github/workflows/x.yml`,
      body: { message: "m", content: "YQ==", branch: "pkey/setup" },
    },
  ],
  [
    "encode a path",
    "setup.file",
    "path",
    {
      method: "PUT",
      path: `${R}/contents/.pkey%2Frelease.yml`,
      body: { message: "m", content: "YQ==", branch: "pkey/setup" },
    },
  ],
  [
    "override the committer",
    "setup.file",
    "body",
    {
      method: "PUT",
      path: `${R}/contents/.pkey/release.yml`,
      body: {
        message: "m",
        content: "YQ==",
        branch: "pkey/setup",
        committer: { name: "x", email: "x@x" },
      },
    },
  ],
  [
    "delete a file",
    "setup.file",
    "method",
    {
      method: "DELETE",
      path: `${R}/contents/.pkey/release.yml`,
      body: {},
    } as WriteRequest,
  ],
  [
    "add a collaborator",
    "setup.pr",
    "method",
    { method: "PUT", path: `${R}/collaborators/mallory`, body: {} },
  ],
  [
    "change repository settings",
    "setup.pr",
    "repository",
    { method: "PATCH", path: `${R}`, body: { private: false } },
  ],
  [
    "create a webhook",
    "env.release",
    "method",
    { method: "POST", path: `${R}/hooks`, body: {} },
  ],
  [
    "create an environment secret",
    "env.release",
    "method",
    { method: "PUT", path: `${R}/environments/release/secrets/KEY`, body: {} },
  ],
  [
    "write another environment",
    "env.release",
    "method",
    { method: "PUT", path: `${R}/environments/prod`, body: {} },
  ],
  [
    "a branch policy that is not v*",
    "env.release",
    "body",
    {
      method: "POST",
      path: `${R}/environments/release/deployment-branch-policies`,
      body: { name: "*", type: "tag" },
    },
  ],
  [
    "delete the environment",
    "env.release",
    "method",
    { method: "DELETE", path: `${R}/environments/release` } as WriteRequest,
  ],
  [
    "a branch ruleset",
    "ruleset.tags",
    "body",
    {
      method: "POST",
      path: `${R}/rulesets`,
      body: { ...tagRuleset, target: "branch" },
    },
  ],
  [
    "a ruleset over every tag",
    "ruleset.tags",
    "body",
    {
      method: "POST",
      path: `${R}/rulesets`,
      body: {
        ...tagRuleset,
        conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      },
    },
  ],
  [
    "a ruleset rule outside the list",
    "ruleset.tags",
    "body",
    {
      method: "POST",
      path: `${R}/rulesets`,
      body: { ...tagRuleset, rules: [{ type: "required_signatures" }] },
    },
  ],
  [
    "a bypass for everyone",
    "ruleset.tags",
    "body",
    {
      method: "POST",
      path: `${R}/rulesets`,
      body: {
        ...tagRuleset,
        bypass_actors: [
          {
            actor_id: 1,
            actor_type: "OrganizationAdmin",
            bypass_mode: "always",
          },
        ],
      },
    },
  ],
  [
    "delete a ruleset",
    "ruleset.tags",
    "method",
    { method: "DELETE", path: `${R}/rulesets/42` } as WriteRequest,
  ],
  [
    "another repository",
    "setup.pr",
    "repository",
    {
      method: "POST",
      path: "/repos/acme/other/pulls",
      body: { title: "t", head: "pkey/setup", base: "main" },
    },
  ],
  [
    "another owner",
    "setup.pr",
    "repository",
    {
      method: "POST",
      path: "/repos/evil/app/pulls",
      body: { title: "t", head: "pkey/setup", base: "main" },
    },
  ],
  [
    "a user endpoint",
    "setup.pr",
    "repository",
    { method: "GET", path: "/user/repos" },
  ],
  [
    "an action used for another's request",
    "setup.file",
    "file",
    {
      method: "POST",
      path: `${R}/pulls`,
      body: { title: "t", head: "pkey/setup", base: "main" },
    },
  ],
  [
    "an unknown action",
    "setup.merge",
    "action",
    { method: "PUT", path: `${R}/pulls/12/merge` },
  ],
  [
    "an extra query",
    "setup.pr",
    "query",
    {
      method: "GET",
      path: `${R}/pulls?head=acme:pkey/setup&state=open&per_page=1`,
    },
  ],
  [
    "a head from another owner",
    "setup.pr",
    "query",
    { method: "GET", path: `${R}/pulls?head=evil:pkey/setup&state=open` },
  ],
];

describe("never-list", () => {
  it.each(REFUSED)("refuses %s", (_name, action, reason, req) => {
    let err: unknown;
    try {
      authorize(action, "acme", "app", req, confirmed(req.path));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WriteRefused);
    expect((err as WriteRefused).reason).toBe(reason);
  });

  it("makes no request, not even a token mint, for a refused write", async () => {
    const env = await appEnv();
    const gh = fakeGithub();
    for (const [, action, , req] of REFUSED)
      await expect(send(env, gh, action, req)).rejects.toBeInstanceOf(
        WriteRefused,
      );
    expect(gh.calls).toEqual([]);
  });

  it("refuses an invalid owner or repository name", () => {
    expect(() =>
      authorize("setup.pr", "ac/me", "app", {
        method: "GET",
        path: `${R}/pulls`,
      }),
    ).toThrow(WriteRefused);
  });
});

describe("client", () => {
  it("mints a token narrowed to the repository and the action's permissions, then sends", async () => {
    const kv = new KvMock();
    const env = await appEnv(kv);
    const gh = fakeGithub();
    const req: WriteRequest = {
      method: "POST",
      path: `${R}/pulls`,
      body: { title: "Set up", head: "pkey/setup", base: "main" },
    };
    const out = await send(env, gh, "setup.pr", req);
    expect(out).toEqual({ status: 201, ok: true, body: { ok: true } });
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls[0]).toMatchObject({
      url: "https://api.github.com/app/installations/7/access_tokens",
      method: "POST",
      body: {
        repositories: ["app"],
        permissions: { pull_requests: "write", metadata: "read" },
      },
    });
    expect(gh.calls[1]).toMatchObject({
      url: `https://api.github.com${R}/pulls`,
      method: "POST",
      auth: "token ghs_FAKE",
      body: req.body,
    });
    // Never cached beside the read tokens.
    expect(kv.keys()).toEqual([]);
  });

  it("mints the workflows scope only for the workflow file", async () => {
    const env = await appEnv();
    const gh = fakeGithub();
    const put = (path: string): Promise<unknown> =>
      send(env, gh, "setup.file", {
        method: "PUT",
        path: `${R}/contents/${path}`,
        body: { message: "m", content: "YQ==", branch: "pkey/setup" },
      });
    await put(".pkey/release.json");
    await put(".github/workflows/release.yml");
    const mints = gh.calls.filter((c) => c.url.endsWith("/access_tokens"));
    expect((mints[0]!.body as { permissions: object }).permissions).toEqual({
      contents: "write",
      metadata: "read",
    });
    expect((mints[1]!.body as { permissions: object }).permissions).toEqual({
      contents: "write",
      workflows: "write",
      metadata: "read",
    });
  });

  it("returns a non-2xx as a result and never echoes the token", async () => {
    const env = await appEnv();
    const gh = fakeGithub(() => json(422, { message: "Validation Failed" }));
    const out = await send(env, gh, "setup.pr", {
      method: "POST",
      path: `${R}/pulls`,
      body: { title: "t", head: "pkey/setup", base: "main" },
    });
    expect(out).toMatchObject({ status: 422, ok: false });
    expect(JSON.stringify(out)).not.toContain("ghs_FAKE");
  });

  it("does not widen when GitHub refuses the permission", async () => {
    const env = await appEnv();
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return json(422, { message: "permissions" });
    };
    await expect(
      writeToken(env, 7, "app", "env.release", 1000, fetchImpl),
    ).rejects.toThrow("installation token failed: 422");
    expect(calls).toHaveLength(1);
  });
});

describe("capabilities", () => {
  it("is false for each missing permission", () => {
    expect(capabilitiesFrom({ contents: "read", metadata: "read" })).toEqual({
      pullRequest: false,
      workflow: false,
      environment: false,
      ruleset: false,
    });
    expect(
      capabilitiesFrom({ contents: "write", pull_requests: "write" }),
    ).toEqual({
      pullRequest: true,
      workflow: false,
      environment: false,
      ruleset: false,
    });
    expect(
      capabilitiesFrom({
        contents: "write",
        pull_requests: "write",
        workflows: "write",
        administration: "write",
      }),
    ).toEqual({
      pullRequest: true,
      workflow: true,
      environment: true,
      ruleset: true,
    });
    // Workflows alone cannot open the pull request that carries it.
    expect(capabilitiesFrom({ workflows: "write" }).workflow).toBe(false);
  });

  it("reads the installation's granted permissions as the App", async () => {
    const env = await appEnv();
    const calls: Call[] = [];
    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        auth: "",
        body: undefined,
      });
      return json(200, {
        id: 7,
        permissions: {
          contents: "write",
          pull_requests: "write",
          administration: "read",
        },
      });
    };
    const caps = await installationCapabilities(env, 7, 1000, fetchImpl);
    expect(caps).toEqual({
      pullRequest: true,
      workflow: false,
      environment: false,
      ruleset: false,
    });
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/7");
  });

  it("has none for a suspended or missing installation", async () => {
    const env = await appEnv();
    const none = {
      pullRequest: false,
      workflow: false,
      environment: false,
      ruleset: false,
    };
    expect(
      await installationCapabilities(env, 7, 1000, async () =>
        json(200, {
          permissions: { contents: "write", pull_requests: "write" },
          suspended_at: "2026-01-01T00:00:00Z",
        }),
      ),
    ).toEqual(none);
    expect(
      await installationCapabilities(env, 7, 1000, async () => json(404, {})),
    ).toEqual(none);
  });
});
