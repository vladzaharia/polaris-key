/// <reference types="@cloudflare/workers-types" />

/**
 * A-32.5 (FLOWS W17): the setup pull request.
 *
 *     POST   …/release/setup/pull-request   { outlets?: [{channel, identity?, outletId?}], workflow?: boolean }
 *     GET    …/release/setup/pull-request   the open setup pull request, if any
 *
 * The POST reads `.pkey/` at the default branch's head (the same pinned read a resync makes),
 * composes the change with `composeSetupChange` (validated as a whole; an invalid result writes
 * nothing), then writes it through the GitHub write client onto the one branch `pkey/setup`
 * and opens, or updates, the one pull request (plan D-G7): the branch is created from the
 * default branch's head, or the files land as new commits on top of the existing branch; the
 * pull request is read first and only patched when its head is `pkey/setup` of this repository
 * and its base is the default branch. Never forced, never merged, never closed, never another
 * branch (`github/allow.ts` refuses all of those before a request).
 *
 * Without the write permissions the answer is a 409 `app_permission` naming the permission and
 * the one command that does the same from a terminal. The audit row names the paths and the
 * pull request number, never file content.
 */

import {
  composeSetupChange,
  SetupChangeError,
  WORKFLOW_PATH,
  type IngestDocuments,
  type SetupOutlet,
} from "@polaris-key/manifest";
import { parse as parseYaml } from "yaml";
import { audit } from "../../core/audit.js";
import { ErrorCode } from "../../core/errors.js";
import type { AdminSession } from "../../core/console/session.js";
import { adminJson, err, readBody } from "../../core/console/respond.js";
import type { ServiceContext } from "../../core/registry.js";
import { deployIdentity } from "../../core/ops/deployIdentity.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { getReleaseConfig } from "./config.js";
import { fetchRepoFile } from "./github.js";
import {
  GITHUB_API,
  discoverInstallation,
  githubHeaders,
  type FetchImpl,
} from "./githubApp.js";
import { SETUP_BRANCH, type Verified } from "./github/allow.js";
import {
  githubWrite,
  installationCapabilities,
  installationPermissions,
  type WriteCapabilities,
  type WriteResult,
} from "./github/write.js";
import { MANIFEST_FILES } from "./manifestFiles.js";
import { readLinkedManifest } from "./resync.js";

const MAX_OUTLETS = 10;
const CHANNEL = /^[a-z][a-z0-9-]{0,39}$/;
const OUTLET_ID = /^[a-z][a-z0-9-]{0,39}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

const PR_TITLE = "Set up Polaris Key publishing";
const PR_BODY =
  "Polaris Key changes `.pkey/` and the release workflow. See Files changed. " +
  "Later changes land here as new commits. Merge it when it looks right.";

/** The refusal `reason` and the answer's fields the console and the CLI read. */
export interface SetupPrRefusal {
  status: number;
  reason: string;
  message: string;
  extra?: Record<string, unknown>;
}

export interface SetupPrInput {
  outlets: SetupOutlet[];
  workflow: boolean;
}

export interface SetupPrOk {
  ok: true;
  repository: string;
  branch: string;
  pullRequest: { number: number; url: string; created: boolean };
  /** Every file the change covers; `written` is false when the branch already held it. */
  files: { path: string; written: boolean }[];
  summary: { outlets: string[]; workflow: boolean };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The request body, or the 422 that names the bad field. */
export function parseSetupPrBody(
  body: Record<string, unknown>,
): SetupPrInput | SetupPrRefusal {
  const bad = (field: string, message: string): SetupPrRefusal => ({
    status: 422,
    reason: "invalid_request",
    message,
    extra: { fields: [field] },
  });
  const outlets: SetupOutlet[] = [];
  if (body.outlets !== undefined) {
    if (!Array.isArray(body.outlets) || body.outlets.length > MAX_OUTLETS)
      return bad("outlets", `outlets is a list of at most ${MAX_OUTLETS}.`);
    for (const o of body.outlets as unknown[]) {
      if (
        !isObject(o) ||
        typeof o.channel !== "string" ||
        !CHANNEL.test(o.channel)
      )
        return bad("outlets", "Each outlet names a channel.");
      if (o.identity !== undefined && !isObject(o.identity))
        return bad("outlets", "An outlet's identity is an object.");
      if (
        o.outletId !== undefined &&
        (typeof o.outletId !== "string" || !OUTLET_ID.test(o.outletId))
      )
        return bad(
          "outlets",
          "An outlet id is lowercase letters, digits and hyphens.",
        );
      outlets.push({
        channel: o.channel,
        ...(o.identity ? { identity: o.identity } : {}),
        ...(o.outletId ? { outletId: o.outletId as string } : {}),
      });
    }
  }
  if (body.workflow !== undefined && typeof body.workflow !== "boolean")
    return bad("workflow", "workflow is true or false.");
  const workflow = body.workflow === true;
  if (outlets.length === 0 && !workflow)
    return bad("outlets", "Name an outlet or ask for the workflow.");
  return { outlets, workflow };
}

const isRefusal = (v: SetupPrInput | SetupPrRefusal): v is SetupPrRefusal =>
  "reason" in v;

function parseDoc(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return parseYaml(text, { uniqueKeys: false, maxAliasCount: 100 });
  }
}

const b64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const unb64 = (raw: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(atob(raw.replace(/\s+/g, "")), (c) => c.charCodeAt(0)),
  );

/** The first write permission the grant lacks, as `<name>: write`, or null. */
function missingPermission(
  permissions: Record<string, string> | null,
  workflow: boolean,
): string | null {
  const have = permissions ?? {};
  for (const name of [
    "contents",
    "pull_requests",
    ...(workflow ? ["workflows"] : []),
  ])
    if (have[name] !== "write") return `${name}: write`;
  return null;
}

/** The one command that does the same change from a terminal. */
function oneCommand(input: SetupPrInput): string {
  return input.outlets.length > 0
    ? `pkey channel add ${input.outlets[0]!.channel}`
    : "pkey ci init";
}

const githubFailure = (what: string, status?: number): SetupPrRefusal => ({
  status: 502,
  reason: "github",
  message: `GitHub did not accept the ${what}.`,
  ...(status ? { extra: { githubStatus: status } } : {}),
});

interface PullRow {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRef: string;
}

/** The open pull request whose head is `pkey/setup` of this repository, from a list answer. */
function setupPull(body: unknown, owner: string, repo: string): PullRow | null {
  if (!Array.isArray(body)) return null;
  for (const p of body as unknown[]) {
    if (!isObject(p) || !isObject(p.head) || !isObject(p.base)) continue;
    const headRepo = isObject(p.head.repo) ? p.head.repo.full_name : null;
    if (
      p.head.ref !== SETUP_BRANCH ||
      typeof headRepo !== "string" ||
      headRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      typeof p.number !== "number" ||
      typeof p.html_url !== "string"
    )
      continue;
    return {
      number: p.number,
      url: p.html_url,
      title: typeof p.title === "string" ? p.title : "",
      body: typeof p.body === "string" ? p.body : "",
      baseRef: typeof p.base.ref === "string" ? p.base.ref : "",
    };
  }
  return null;
}

async function installFor(
  env: Env,
  cfg: { gh_installation_id: number | null },
  owner: string,
  repo: string,
  now: number,
  fetchImpl: FetchImpl,
): Promise<number> {
  return (
    cfg.gh_installation_id ??
    (await discoverInstallation(env, owner, repo, now, fetchImpl))
  );
}

/** Compose, write and open or update the setup pull request. */
export async function createSetupPullRequest(
  env: Env,
  db: Db,
  slug: string,
  input: SetupPrInput,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<SetupPrOk | SetupPrRefusal> {
  // 1. Read `.pkey/` at the default branch's head.
  const read = await readLinkedManifest(env, db, slug, now, fetchImpl);
  if (!read.ok)
    return {
      status: 409,
      reason: read.check,
      message: read.error,
      ...(read.errors ? { extra: { errors: read.errors } } : {}),
    };
  const { owner, repo, token, commit, cfg } = read;
  const root = `/repos/${owner}/${repo}`;

  // 2. The workflow is omitted when the default branch has it already.
  let workflow = input.workflow;
  try {
    if (
      workflow &&
      (await fetchRepoFile(
        token,
        owner,
        repo,
        WORKFLOW_PATH,
        fetchImpl,
        commit,
      )) !== null
    )
      workflow = false;
  } catch {
    return githubFailure("read of the workflow file");
  }

  // 3. The App must be able to write.
  let permissions: Record<string, string> | null;
  let installId: number;
  try {
    installId = await installFor(env, cfg, owner, repo, now, fetchImpl);
    permissions = await installationPermissions(env, installId, now, fetchImpl);
  } catch {
    return githubFailure("installation lookup");
  }
  const missing = missingPermission(permissions, workflow);
  if (missing)
    return {
      status: 409,
      reason: "app_permission",
      message: `The Polaris Key GitHub App needs ${missing} on this repository.`,
      extra: { permission: missing, oneCommand: oneCommand(input) },
    };

  // 4. Compose.
  const parsed = (name: string) => parseDoc(read.files[name]);
  const product = parsed("product");
  if (!isObject(product))
    return {
      status: 409,
      reason: "manifest",
      message: ".pkey/product is not an object.",
    };
  const documents: IngestDocuments = {
    product,
    schema: parsed("schema"),
    release: parsed("release"),
    distribution: parsed("distribution"),
  };
  let distribution: { path: string; text: string } | null = null;
  try {
    if (input.outlets.length > 0 && read.files.distribution !== undefined)
      for (const path of MANIFEST_FILES.distribution) {
        const text = await fetchRepoFile(
          token,
          owner,
          repo,
          path,
          fetchImpl,
          commit,
        );
        if (text !== null) {
          distribution = { path, text };
          break;
        }
      }
  } catch {
    return githubFailure("read of the distribution file");
  }
  let actionRef: string | null = null;
  if (workflow) {
    actionRef = deployIdentity(env).gitSha;
    if (!actionRef)
      return {
        status: 409,
        reason: "action_ref",
        message:
          "This Worker has no commit id to pin the workflow's Action to.",
      };
  }
  let change;
  try {
    change = composeSetupChange({
      documents,
      distribution,
      outlets: input.outlets,
      ...(workflow
        ? {
            workflow: {
              actionRef: actionRef!,
              channel: "stable",
              packs: (read.manifest.release?.packDeliverables ?? []).map(
                (p) => ({
                  id: p.id,
                  dir: `packs/${p.id}`,
                }),
              ),
            },
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof SetupChangeError)
      return {
        status: 400,
        reason: e.code,
        message: e.message,
        ...(e.errors.length > 0 ? { extra: { errors: e.errors } } : {}),
      };
    throw e;
  }

  // 5. The default branch's name (the pull request's base).
  let base: string;
  try {
    const res = await fetchImpl(`${GITHUB_API}${root}`, {
      headers: githubHeaders(`token ${token}`),
      redirect: "manual",
    });
    const row = res.ok
      ? ((await res.json()) as { default_branch?: unknown })
      : null;
    if (
      !row ||
      typeof row.default_branch !== "string" ||
      !BRANCH.test(row.default_branch) ||
      row.default_branch === SETUP_BRANCH
    )
      return githubFailure("read of the default branch", res.status);
    base = row.default_branch;
  } catch {
    return githubFailure("read of the default branch");
  }

  const write = (
    action: string,
    method: string,
    path: string,
    body?: unknown,
    verified?: Verified,
  ): Promise<WriteResult> =>
    githubWrite(
      env,
      installId,
      { owner, repo, ...(verified ? { verified } : {}) },
      action,
      {
        method,
        path: `${root}${path}`,
        ...(body === undefined ? {} : { body }),
      },
      now,
      fetchImpl,
    );

  try {
    // 6. The branch: created from the head the read used, or left as it is (commits go on top).
    const ref = await write(
      "setup.branch",
      "GET",
      `/git/ref/heads/${SETUP_BRANCH}`,
    );
    if (ref.status === 404) {
      const made = await write("setup.branch", "POST", "/git/refs", {
        ref: `refs/heads/${SETUP_BRANCH}`,
        sha: commit,
      });
      if (made.status !== 201)
        return githubFailure("setup branch", made.status);
    } else if (!ref.ok)
      return githubFailure("read of the setup branch", ref.status);

    // 7. The files, each as a new commit on the branch (none when it holds the text already).
    const files: SetupPrOk["files"] = [];
    for (const f of change.files) {
      const at = `/contents/${f.path}`;
      const cur = await write("setup.file", "GET", `${at}?ref=${SETUP_BRANCH}`);
      let sha: string | undefined;
      if (cur.ok && isObject(cur.body) && typeof cur.body.sha === "string") {
        sha = cur.body.sha;
        if (
          typeof cur.body.content === "string" &&
          unb64(cur.body.content) === f.text
        ) {
          files.push({ path: f.path, written: false });
          continue;
        }
      } else if (cur.status !== 404) {
        return githubFailure("read of a setup file", cur.status);
      }
      const put = await write("setup.file", "PUT", at, {
        message: `Polaris Key: ${sha ? "update" : "add"} ${f.path}`,
        content: b64(f.text),
        branch: SETUP_BRANCH,
        ...(sha ? { sha } : {}),
      });
      if (put.status !== 200 && put.status !== 201)
        return githubFailure(`write of ${f.path}`, put.status);
      files.push({ path: f.path, written: true });
    }

    // 8. The pull request: read first; patch only the one whose head is pkey/setup.
    const list = await write(
      "setup.pr",
      "GET",
      `/pulls?head=${encodeURIComponent(`${owner}:${SETUP_BRANCH}`)}&state=open`,
    );
    if (!list.ok) return githubFailure("read of the pull request", list.status);
    const open = setupPull(list.body, owner, repo);
    let pullRequest: SetupPrOk["pullRequest"];
    if (open) {
      if (open.baseRef !== base)
        return {
          status: 409,
          reason: "pull_request_base",
          message: `The open setup pull request targets ${open.baseRef}, not ${base}.`,
          extra: { number: open.number, url: open.url },
        };
      if (open.title !== PR_TITLE || open.body !== PR_BODY) {
        const patched = await write(
          "setup.pr",
          "PATCH",
          `/pulls/${open.number}`,
          {
            title: PR_TITLE,
            body: PR_BODY,
          },
          { pull: open.number },
        );
        if (!patched.ok)
          return githubFailure("pull request update", patched.status);
      }
      pullRequest = { number: open.number, url: open.url, created: false };
    } else {
      const made = await write("setup.pr", "POST", "/pulls", {
        title: PR_TITLE,
        head: SETUP_BRANCH,
        base,
        body: PR_BODY,
      });
      const row = made.body;
      if (
        made.status !== 201 ||
        !isObject(row) ||
        typeof row.number !== "number" ||
        typeof row.html_url !== "string"
      )
        return githubFailure("pull request", made.status);
      pullRequest = { number: row.number, url: row.html_url, created: true };
    }
    return {
      ok: true,
      repository: `${owner}/${repo}`,
      branch: SETUP_BRANCH,
      pullRequest,
      files,
      summary: change.summary,
    };
  } catch {
    // A refused mint (the grant changed under us) or a network failure: nothing more is known.
    return githubFailure("write");
  }
}

export interface SetupPrState {
  repository: string | null;
  capabilities: WriteCapabilities;
  /** `unknown` when GitHub would not say. */
  state: "none" | "open" | "unknown";
  pullRequest: { number: number; url: string } | null;
}

const NONE: WriteCapabilities = {
  pullRequest: false,
  workflow: false,
  environment: false,
  ruleset: false,
};

/** The open setup pull request, if any. Reads only. */
export async function setupPullRequestState(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<SetupPrState> {
  const cfg = await getReleaseConfig(db, slug);
  const owner = cfg?.gh_owner;
  const repo = cfg?.gh_repo;
  if (!cfg || !owner || !repo)
    return {
      repository: null,
      capabilities: NONE,
      state: "none",
      pullRequest: null,
    };
  const repository = `${owner}/${repo}`;
  try {
    const installId = await installFor(env, cfg, owner, repo, now, fetchImpl);
    const capabilities = await installationCapabilities(
      env,
      installId,
      now,
      fetchImpl,
    );
    const list = await githubWrite(
      env,
      installId,
      { owner, repo },
      "setup.pr",
      {
        method: "GET",
        path: `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${SETUP_BRANCH}`)}&state=open`,
      },
      now,
      fetchImpl,
    );
    if (!list.ok)
      return { repository, capabilities, state: "unknown", pullRequest: null };
    const open = setupPull(list.body, owner, repo);
    return {
      repository,
      capabilities,
      state: open ? "open" : "none",
      pullRequest: open ? { number: open.number, url: open.url } : null,
    };
  } catch {
    return {
      repository,
      capabilities: NONE,
      state: "unknown",
      pullRequest: null,
    };
  }
}

/** The console route: `…/release/setup/pull-request`. */
export async function handleSetupPullRequest(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response> {
  const { req, env, db, product, session, now } = ctx;
  const slug = product.slug;
  if (req.method === "GET")
    return adminJson(await setupPullRequestState(env, db, slug, now));
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const input = parseSetupPrBody(await readBody(req));
  const refuse = (r: SetupPrRefusal): Response =>
    err(r.status, ErrorCode.BadRequest, r.message, {
      reason: r.reason,
      ...(r.extra ?? {}),
    });
  if (isRefusal(input)) return refuse(input);
  const result = await createSetupPullRequest(env, db, slug, input, now);
  if (!("ok" in result)) return refuse(result);
  await audit(
    db,
    slug,
    session,
    now,
    "release.setup.pull_request",
    { kind: "product", id: slug },
    `${result.pullRequest.created ? "Opened" : "Updated"} setup pull request #${result.pullRequest.number}: ${
      result.files
        .filter((f) => f.written)
        .map((f) => f.path)
        .join(", ") || "no file changed"
    }`,
  );
  const { ok: _ok, ...rest } = result;
  return adminJson(
    { ok: true, ...rest },
    result.pullRequest.created ? 201 : 200,
  );
}
