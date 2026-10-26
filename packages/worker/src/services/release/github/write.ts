/**
 * The GitHub write client (A-32; plan D-G1).
 *
 * It lives beside the App in Release (`../githubApp.ts` mints the tokens), not in Core: Core
 * cannot import a service (rule 6). Every request passes `authorize()` (`./allow.ts`) before
 * a token is minted, so an out-of-table request costs no GitHub call at all. A write token is
 * minted per call, narrowed to the one repository and the one permission set the request needs,
 * and is never cached, never logged and never returned to the caller.
 */

import type { Env } from "../../../platform/env.js";
import {
  GITHUB_API,
  appJwt,
  githubHeaders,
  grantedPermissions,
  mintInstallationToken,
  type FetchImpl,
} from "../githubApp.js";
import {
  authorize,
  basePermissions,
  type Permissions,
  type Verified,
  type WriteAction,
  type WriteRequest,
} from "./allow.js";

/**
 * Mint the narrowed token for `action` on the one repository `repo` (GitHub narrows the token to it). `workflow` adds `workflows: write`
 * (only the workflow file needs it). No fallback, no cache: GitHub answers 422 when the App
 * was never granted the permission, and that is surfaced, not widened.
 */
export function writeToken(
  env: Env,
  installId: number,
  repo: string,
  action: WriteAction,
  now: number,
  fetchImpl: FetchImpl = fetch,
  opts: { workflow?: boolean } = {},
): Promise<string> {
  const permissions: Permissions = { ...basePermissions(action) };
  if (opts.workflow && action === "setup.file") permissions.workflows = "write";
  return mintInstallationToken(
    env,
    installId,
    { repositories: [repo], permissions },
    now,
    fetchImpl,
  );
}

/** What GitHub answered: the status and the parsed JSON body (null when empty). */
export interface WriteResult {
  status: number;
  ok: boolean;
  body: unknown;
}

/**
 * Send one allow-listed request. Throws `WriteRefused` (before any fetch) for anything outside
 * the table; otherwise mints the narrowed token, sends, and returns the status and body. A
 * non-2xx is a result, not an exception: the caller decides what 404, 409 or 422 mean.
 */
export async function githubWrite(
  env: Env,
  installId: number,
  target: { owner: string; repo: string; verified?: Verified },
  action: WriteAction | string,
  req: WriteRequest,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<WriteResult> {
  const sent = authorize(
    action,
    target.owner,
    target.repo,
    req,
    target.verified,
  );
  const token = await mintInstallationToken(
    env,
    installId,
    { repositories: [target.repo], permissions: sent.permissions },
    now,
    fetchImpl,
  );
  const res = await fetchImpl(`${GITHUB_API}${sent.path}`, {
    method: sent.method,
    headers: {
      ...githubHeaders(`token ${token}`),
      ...(sent.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(sent.body === undefined ? {} : { body: JSON.stringify(sent.body) }),
    // A redirect would re-send the Authorization header to another host.
    redirect: "manual",
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, ok: res.ok, body };
}

/** What the installation lets Polaris Key do, from the permissions GitHub reports granted. */
export interface WriteCapabilities {
  /** The setup branch and its pull request: Contents and Pull requests write. */
  pullRequest: boolean;
  /** The workflow file: the above and Workflows write. */
  workflow: boolean;
  /** The `release` environment: Administration write. */
  environment: boolean;
  /** The `v*` tag ruleset: Administration write. */
  ruleset: boolean;
}

/** Pure: capabilities from an installation's `permissions` map. Missing means false. */
export function capabilitiesFrom(
  permissions: Readonly<Record<string, string>>,
): WriteCapabilities {
  const w = (k: string): boolean => permissions[k] === "write";
  const pullRequest = w("contents") && w("pull_requests");
  return {
    pullRequest,
    workflow: pullRequest && w("workflows"),
    environment: w("administration"),
    ruleset: w("administration"),
  };
}

const NONE: WriteCapabilities = {
  pullRequest: false,
  workflow: false,
  environment: false,
  ruleset: false,
};

/**
 * `GET /app/installations/{id}` as the App: the permissions the installation accepted, or `null`
 * when it is gone (404) or suspended. Only a network or auth failure of our own throws.
 */
export async function installationPermissions(
  env: Env,
  installId: number,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<Record<string, string> | null> {
  const jwt = await appJwt(env, now);
  const res = await fetchImpl(`${GITHUB_API}/app/installations/${installId}`, {
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`installation lookup failed: ${res.status}`);
  const row = (await res.json()) as {
    permissions?: unknown;
    suspended_at?: unknown;
  };
  return row.suspended_at != null ? null : grantedPermissions(row.permissions);
}

/**
 * What the installation lets Polaris Key do. A suspended or missing installation, and any
 * unreadable answer, has no capabilities (the One-command fallback applies).
 */
export async function installationCapabilities(
  env: Env,
  installId: number,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<WriteCapabilities> {
  const permissions = await installationPermissions(
    env,
    installId,
    now,
    fetchImpl,
  );
  return permissions ? capabilitiesFrom(permissions) : NONE;
}
