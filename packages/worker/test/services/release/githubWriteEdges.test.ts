/**
 * The GitHub write allow-list's edges: bypass attempts are refused, and a pull request PATCH, a
 * ruleset PUT and an environment's protection fields need what the caller itself confirmed.
 */
import { describe, expect, it } from "vitest";
import {
  authorize,
  WriteRefused,
  type Verified,
} from "../../../src/services/release/github/allow.js";

const O = "acme";
const R = "app";
const root = `/repos/${O}/${R}`;
const refused = (
  a: string,
  method: string,
  path: string,
  body?: unknown,
  verified?: Verified,
) => {
  try {
    authorize(a, O, R, { method, path, body }, verified);
  } catch (e) {
    if (e instanceof WriteRefused) return e.reason;
    throw e;
  }
  return "ACCEPTED";
};

describe("bypass attempts are refused", () => {
  const sha = "a".repeat(40);
  it.each([
    ["setup.branch", "GET", `${root}/git/ref/heads/pkey%2Fsetup`],
    ["setup.branch", "GET", `${root}/git/ref/heads/../../../x`],
    ["setup.branch", "GET", `${root}/git/ref/heads/a//b`],
    ["setup.branch", "get", `${root}/git/ref/heads/main`],
    ["setup.branch", "DELETE", `${root}/git/refs/heads/pkey/setup`],
    ["setup.branch", "PATCH", `${root}/git/refs/heads/main`],
    ["setup.file", "PUT", `${root}/contents/.github/workflows/other.yml`],
    ["setup.file", "PUT", `${root}/contents/.pkey/release.yaml/../../x`],
    ["setup.file", "PUT", `${root}/contents/.pkey/release.yaml?ref=main`],
    ["setup.file", "GET", `${root}/contents/.pkey/release.yaml?ref=main`],
    [
      "setup.file",
      "GET",
      `${root}/contents/.pkey/release.yaml?ref=pkey/setup&ref=main`,
    ],
    ["setup.pr", "GET", `${root}/pulls?head=evil:pkey/setup&state=open`],
    ["setup.pr", "PATCH", `${root}/pulls/0`],
    ["setup.pr", "PUT", `${root}/pulls/1/merge`],
    ["setup.pr", "POST", `/repos/${O}/other/pulls`],
    ["setup.pr", "POST", `/repos/${O}/${R}x/pulls`],
    ["setup.pr", "POST", `/repos/${O}/${R}/../other/pulls`],
    ["env.release", "PUT", `${root}/environments/prod`],
    ["env.release", "DELETE", `${root}/environments/release`],
    ["ruleset.tags", "DELETE", `${root}/rulesets/1`],
    ["ruleset.tags", "GET", `${root}/rulesets?includes_parents=true`],
    ["setup.pr", "GET", `${root}/pulls\n`],
    ["unknown.action", "GET", `${root}/pulls`],
  ])("%s %s %s", (a, m, p) => {
    expect(refused(a, m, p, { sha })).not.toBe("ACCEPTED");
  });
  it("force and a non-setup branch are refused", () => {
    expect(
      refused("setup.branch", "PATCH", `${root}/git/refs/heads/pkey/setup`, {
        sha,
        force: false,
      }),
    ).toBe("body");
    expect(
      refused("setup.branch", "POST", `${root}/git/refs`, {
        ref: "refs/heads/main",
        sha,
      }),
    ).toBe("branch");
    expect(
      refused("setup.file", "PUT", `${root}/contents/.pkey/release.yaml`, {
        message: "m",
        content: "YQ==",
        branch: "main",
      }),
    ).toBe("branch");
    expect(
      refused(
        "setup.pr",
        "PATCH",
        `${root}/pulls/3`,
        { state: "closed" },
        {
          pull: 3,
        },
      ),
    ).toBe("body");
    expect(
      refused(
        "setup.pr",
        "PATCH",
        `${root}/pulls/3`,
        { base: "x" },
        {
          pull: 3,
        },
      ),
    ).toBe("body");
  });
});

const tagBody = (rules: Array<{ type: string }>) => ({
  name: "n",
  target: "tag",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
  rules,
});

describe("what the caller confirmed", () => {
  it("a pull request PATCH needs the number the caller confirmed", () => {
    const body = { title: "x" };
    expect(refused("setup.pr", "PATCH", `${root}/pulls/123`, body)).toBe(
      "path",
    );
    expect(
      refused("setup.pr", "PATCH", `${root}/pulls/123`, body, { pull: 7 }),
    ).toBe("path");
    expect(
      refused("setup.pr", "PATCH", `${root}/pulls/7`, body, { pull: 7 }),
    ).toBe("ACCEPTED");
  });
  it("a ruleset PUT needs the id the caller found by name", () => {
    const body = tagBody([{ type: "deletion" }]);
    expect(refused("ruleset.tags", "PUT", `${root}/rulesets/42`, body)).toBe(
      "path",
    );
    expect(
      refused("ruleset.tags", "PUT", `${root}/rulesets/42`, body, {
        ruleset: 41,
      }),
    ).toBe("path");
    expect(
      refused("ruleset.tags", "PUT", `${root}/rulesets/42`, body, {
        ruleset: 42,
      }),
    ).toBe("ACCEPTED");
  });
  it("an environment PUT carries no reviewers, wait timer or self-review flag", () => {
    for (const extra of [
      { reviewers: [{ type: "User", id: 1 }] },
      { wait_timer: 0 },
      { prevent_self_review: false },
    ])
      expect(
        refused("env.release", "PUT", `${root}/environments/release`, extra),
      ).toBe("body");
    expect(
      refused("env.release", "PUT", `${root}/environments/release`, {
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      }),
    ).toBe("ACCEPTED");
  });
  it("a tag ruleset may carry a creation rule", () => {
    expect(
      refused(
        "ruleset.tags",
        "POST",
        `${root}/rulesets`,
        tagBody([{ type: "creation" }, { type: "deletion" }]),
      ),
    ).toBe("ACCEPTED");
  });
});
