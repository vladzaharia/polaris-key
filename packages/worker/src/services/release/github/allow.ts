/**
 * The GitHub write allow-list (A-32; plan D-G1, D-G3).
 *
 * Polaris Key writes to a customer's repository through the GitHub App, and only through the
 * closed table below. Every write is one action, one request shape and one permission set:
 * `authorize()` is the single gate, and `github/write.ts` sends nothing it has not passed.
 * Anything not in the table is refused before a request: merging or closing a pull request,
 * deleting a ref, a force update, any branch but `pkey/setup`, the default branch, any path
 * outside the three setup files, collaborators, repository settings, hooks, secrets.
 *
 * THE PERMISSION TABLE. The permissions are the ones GitHub's REST reference gives each
 * endpoint ("Fine-grained access tokens for …", checked 2026-10-24), not the ones the setup
 * design guessed (G11: environments are Administration, not "Environments"). Reads an action
 * needs are inside its permission set (Contents write includes read).
 *
 *  action        endpoint                                                   App permission
 *  ------------  ---------------------------------------------------------  -------------------------
 *  setup.branch  GET   /repos/{o}/{r}/git/ref/heads/{branch}                Contents: read
 *                POST  /repos/{o}/{r}/git/refs (pkey/setup)                 Contents: write
 *                PATCH /repos/{o}/{r}/git/refs/heads/pkey/setup (no force)  Contents: write
 *  setup.file    GET   /repos/{o}/{r}/contents/{path}?ref=pkey/setup        Contents: read
 *                PUT   /repos/{o}/{r}/contents/{path} (branch pkey/setup)   Contents: write
 *                PUT   …/contents/.github/workflows/release.yml             Contents: write + Workflows: write
 *  setup.pr      GET   /repos/{o}/{r}/pulls?head={o}:pkey/setup&state=open  Pull requests: read
 *                POST  /repos/{o}/{r}/pulls (head pkey/setup)               Pull requests: write
 *                PATCH /repos/{o}/{r}/pulls/{n} (title, body only)          Pull requests: write
 *  env.release   PUT   /repos/{o}/{r}/environments/release                  Administration: write
 *                POST  …/environments/release/deployment-branch-policies    Administration: write
 *  ruleset.tags  GET   /repos/{o}/{r}/rulesets                              Metadata: read
 *                POST  /repos/{o}/{r}/rulesets (tag v*)                     Administration: write
 *                PUT   /repos/{o}/{r}/rulesets/{id} (tag v*)                Administration: write
 *
 * Metadata: read rides on every token. `GET /environments/release` (Actions: read) is not in
 * the table: the environment PUT is idempotent.
 */

/** The closed set of write actions. */
export const WRITE_ACTIONS = [
  "setup.branch",
  "setup.file",
  "setup.pr",
  "env.release",
  "ruleset.tags",
] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

/** A GitHub installation permission set, `{ contents: "write", … }`. */
export type Permissions = Record<string, "read" | "write">;

/** The one branch Polaris Key writes. */
export const SETUP_BRANCH = "pkey/setup";

/** The only files the setup pull request may touch. */
const SETUP_FILE =
  /^(?:\.pkey\/(?:distribution|release)\.(?:yaml|yml|json)|\.github\/workflows\/release\.yml)$/;
const WORKFLOW_FILE = ".github/workflows/release.yml";

/** The tag ruleset's one ref pattern, and the rules it may carry (D-G8). */
const TAG_REF = "refs/tags/v*";
const TAG_RULES = new Set(["deletion", "update", "non_fast_forward"]);
/** GitHub's built-in repository-admin role id, the only bypass actor. */
const ADMIN_ROLE_ID = 5;

/** What the caller wants to send; `path` is relative to the API root, query included. */
export interface WriteRequest {
  method: string;
  path: string;
  body?: unknown;
}

export type RefusalReason =
  | "action"
  | "method"
  | "path"
  | "query"
  | "body"
  | "branch"
  | "file"
  | "repository";

/** An out-of-table request. Thrown before any fetch; the message never carries a body. */
export class WriteRefused extends Error {
  readonly code = "write_refused";
  constructor(
    readonly reason: RefusalReason,
    detail: string,
  ) {
    super(`github write refused (${reason}): ${detail}`);
  }
}

const refuse = (reason: RefusalReason, detail: string): never => {
  throw new WriteRefused(reason, detail);
};

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
/** A branch name Polaris Key may *read* the head of (the base for a new setup branch). */
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys of `body` must all be in `allowed`; a missing or extra key is a refusal. */
function exactBody(
  body: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isObject(body)) return refuse("body", "a JSON object is required");
  for (const k of Object.keys(body))
    if (!required.includes(k) && !optional.includes(k))
      refuse("body", `field ${k} is not allowed`);
  for (const k of required)
    if (!(k in body)) refuse("body", `field ${k} is required`);
  return body;
}

const str = (v: unknown, field: string, max = 65536): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max)
    refuse("body", `field ${field} must be a string`);
  return v as string;
};

function noBranchBut(body: Record<string, unknown>, field: string): void {
  if (body[field] !== SETUP_BRANCH)
    refuse("branch", `only ${SETUP_BRANCH} may be written`);
}

/** The permission set one authorized request needs. */
export interface Authorized {
  action: WriteAction;
  method: string;
  /** The path as sent, `/repos/{owner}/{repo}/…`. */
  path: string;
  body?: unknown;
  permissions: Permissions;
}

/**
 * The permission set an action's token carries by default: the union its requests need,
 * without the workflow scope (`setup.file` adds Workflows only for the workflow file).
 */
export function basePermissions(action: WriteAction): Permissions {
  switch (action) {
    case "setup.branch":
    case "setup.file":
      return { contents: "write", metadata: "read" };
    case "setup.pr":
      return { pull_requests: "write", metadata: "read" };
    case "env.release":
    case "ruleset.tags":
      return { administration: "write", metadata: "read" };
  }
}

function split(req: WriteRequest): { path: string; query: URLSearchParams } {
  const i = req.path.indexOf("?");
  const path = i < 0 ? req.path : req.path.slice(0, i);
  const query = new URLSearchParams(i < 0 ? "" : req.path.slice(i + 1));
  if (!path.startsWith("/") || path.includes("//") || path.includes("%"))
    refuse("path", "malformed");
  for (const seg of path.split("/").slice(1))
    if (seg === "." || seg === "..") refuse("path", "dot segment");
  return { path, query };
}

function onlyQuery(query: URLSearchParams, want: Record<string, string>): void {
  const keys = [...query.keys()];
  if (keys.length !== Object.keys(want).length)
    refuse("query", "unexpected parameters");
  for (const [k, v] of Object.entries(want))
    if (query.get(k) !== v) refuse("query", `${k} is not allowed`);
}

/**
 * Check one request against the table. Returns the request to send and the permission set its
 * token needs, or throws `WriteRefused`. `owner` and `repo` bind the request to one
 * repository: a path naming any other is refused.
 */
export function authorize(
  action: string,
  owner: string,
  repo: string,
  req: WriteRequest,
): Authorized {
  if (!(WRITE_ACTIONS as readonly string[]).includes(action))
    refuse("action", "unknown action");
  const act = action as WriteAction;
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo))
    refuse("repository", "invalid owner or repository");
  const { path, query } = split(req);
  const root = `/repos/${owner}/${repo}`;
  if (!path.startsWith(`${root}/`))
    return refuse("repository", "path is outside the bound repository");
  const rest = path.slice(root.length); // "/git/refs", "/pulls/12", …
  const permissions: Permissions = { ...basePermissions(act) };
  const ok = (body?: unknown): Authorized => ({
    action: act,
    method: req.method,
    path: req.path,
    ...(body === undefined ? {} : { body }),
    permissions,
  });
  const noQuery = (): void => onlyQuery(query, {});

  switch (act) {
    case "setup.branch": {
      const ref = /^\/git\/ref\/heads\/([A-Za-z0-9._/-]+)$/.exec(rest);
      if (req.method === "GET" && ref) {
        if (!BRANCH.test(ref[1]!) || ref[1]!.includes(".."))
          refuse("branch", "invalid branch name");
        noQuery();
        return ok();
      }
      if (req.method === "POST" && rest === "/git/refs") {
        noQuery();
        const b = exactBody(req.body, ["ref", "sha"]);
        if (b.ref !== `refs/heads/${SETUP_BRANCH}`)
          refuse("branch", `only ${SETUP_BRANCH} may be created`);
        if (typeof b.sha !== "string" || !SHA.test(b.sha))
          refuse("body", "sha must be a commit id");
        return ok(b);
      }
      if (
        req.method === "PATCH" &&
        rest === `/git/refs/heads/${SETUP_BRANCH}`
      ) {
        noQuery();
        // `force` is never accepted, not even `false`: every update is a fast-forward.
        const b = exactBody(req.body, ["sha"]);
        if (typeof b.sha !== "string" || !SHA.test(b.sha))
          refuse("body", "sha must be a commit id");
        return ok(b);
      }
      return refuse("method", "not an allowed branch request");
    }

    case "setup.file": {
      const m = /^\/contents\/(.+)$/.exec(rest);
      if (!m || !SETUP_FILE.test(m[1]!))
        return refuse("file", "path is not a setup file");
      if (m[1] === WORKFLOW_FILE) permissions.workflows = "write";
      if (req.method === "GET") {
        // A read needs no write scope: narrow to the read permissions.
        onlyQuery(query, { ref: SETUP_BRANCH });
        return {
          ...ok(),
          permissions: { contents: "read", metadata: "read" },
        };
      }
      if (req.method === "PUT") {
        noQuery();
        const b = exactBody(
          req.body,
          ["message", "content", "branch"],
          ["sha"],
        );
        noBranchBut(b, "branch");
        str(b.message, "message", 2000);
        str(b.content, "content", 1024 * 1024);
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b.content as string))
          refuse("body", "content must be base64");
        if ("sha" in b && (typeof b.sha !== "string" || !SHA.test(b.sha)))
          refuse("body", "sha must be a blob id");
        return ok(b);
      }
      return refuse("method", "not an allowed file request");
    }

    case "setup.pr": {
      if (req.method === "GET" && rest === "/pulls") {
        onlyQuery(query, { head: `${owner}:${SETUP_BRANCH}`, state: "open" });
        return {
          ...ok(),
          permissions: { pull_requests: "read", metadata: "read" },
        };
      }
      if (req.method === "POST" && rest === "/pulls") {
        noQuery();
        // No `maintainer_can_modify`, no `issue`, no `head_repo`: a plain same-repo PR.
        const b = exactBody(
          req.body,
          ["title", "head", "base"],
          ["body", "draft"],
        );
        noBranchBut(b, "head");
        str(b.title, "title", 256);
        const base = str(b.base, "base", 200);
        if (!BRANCH.test(base) || base === SETUP_BRANCH)
          refuse("branch", "invalid base");
        if ("body" in b) str(b.body, "body");
        if ("draft" in b && typeof b.draft !== "boolean")
          refuse("body", "draft must be a boolean");
        return ok(b);
      }
      if (req.method === "PATCH" && /^\/pulls\/[1-9][0-9]{0,9}$/.test(rest)) {
        noQuery();
        // Title and body only: no `state` (close), no `base` (retarget). The caller must have
        // read the PR and confirmed its head is `pkey/setup`.
        const b = exactBody(req.body, [], ["title", "body"]);
        if (Object.keys(b).length === 0) refuse("body", "nothing to update");
        if ("title" in b) str(b.title, "title", 256);
        if ("body" in b) str(b.body, "body");
        return ok(b);
      }
      return refuse("method", "not an allowed pull request request");
    }

    case "env.release": {
      if (req.method === "PUT" && rest === "/environments/release") {
        noQuery();
        const b = exactBody(
          req.body,
          [],
          [
            "deployment_branch_policy",
            "wait_timer",
            "prevent_self_review",
            "reviewers",
          ],
        );
        if ("deployment_branch_policy" in b) {
          const p = b.deployment_branch_policy;
          if (p !== null) {
            const pb = exactBody(p, [
              "protected_branches",
              "custom_branch_policies",
            ]);
            if (
              typeof pb.protected_branches !== "boolean" ||
              typeof pb.custom_branch_policies !== "boolean"
            )
              refuse("body", "deployment_branch_policy flags must be booleans");
          }
        }
        return ok(b);
      }
      if (
        req.method === "POST" &&
        rest === "/environments/release/deployment-branch-policies"
      ) {
        noQuery();
        const b = exactBody(req.body, ["name", "type"]);
        if (b.name !== "v*" || b.type !== "tag")
          refuse("body", "only the v* tag policy is allowed");
        return ok(b);
      }
      return refuse("method", "not an allowed environment request");
    }

    case "ruleset.tags": {
      if (req.method === "GET" && rest === "/rulesets") {
        onlyQuery(query, {});
        return { ...ok(), permissions: { metadata: "read" } };
      }
      const isPut =
        req.method === "PUT" && /^\/rulesets\/[1-9][0-9]{0,15}$/.test(rest);
      if ((req.method === "POST" && rest === "/rulesets") || isPut) {
        noQuery();
        const b = exactBody(
          req.body,
          ["name", "target", "enforcement", "conditions", "rules"],
          ["bypass_actors"],
        );
        str(b.name, "name", 100);
        if (b.target !== "tag") refuse("body", "only a tag ruleset is allowed");
        if (b.enforcement !== "active" && b.enforcement !== "evaluate")
          refuse("body", "enforcement must be active or evaluate");
        const cond = exactBody(b.conditions, ["ref_name"]);
        const ref = exactBody(cond.ref_name, ["include", "exclude"]);
        if (
          !Array.isArray(ref.include) ||
          ref.include.length !== 1 ||
          ref.include[0] !== TAG_REF ||
          !Array.isArray(ref.exclude) ||
          ref.exclude.length !== 0
        )
          refuse("body", `the ruleset must cover exactly ${TAG_REF}`);
        if (!Array.isArray(b.rules) || b.rules.length === 0)
          refuse("body", "rules are required");
        for (const r of b.rules as unknown[]) {
          const rule = exactBody(r, ["type"]);
          if (typeof rule.type !== "string" || !TAG_RULES.has(rule.type))
            refuse("body", "rule type is not allowed");
        }
        if ("bypass_actors" in b) {
          if (!Array.isArray(b.bypass_actors)) refuse("body", "bypass_actors");
          for (const a of b.bypass_actors as unknown[]) {
            const act2 = exactBody(a, [
              "actor_id",
              "actor_type",
              "bypass_mode",
            ]);
            if (
              act2.actor_id !== ADMIN_ROLE_ID ||
              act2.actor_type !== "RepositoryRole" ||
              act2.bypass_mode !== "always"
            )
              refuse("body", "only repository admins may bypass");
          }
        }
        return ok(b);
      }
      return refuse("method", "not an allowed ruleset request");
    }
  }
}
