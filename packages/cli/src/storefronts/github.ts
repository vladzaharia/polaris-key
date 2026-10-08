/**
 * The PR plane's GitHub client (A-18i): the few REST calls a pull-request step and its verifier
 * make, and nothing that merges, closes, deletes or force-pushes. The token is a CI environment
 * secret (owner decision 7: a fine-grained token with `contents:write` and `pull_requests:write`
 * on the own tap and bucket; for winget, a classic `public_repo` token only if A-18k shows a
 * fine-grained one cannot open the PR), read from `PKEY_PR_TOKEN` and never put in argv, a report
 * or a log line. The verifier reads public pull requests, so it also works without one.
 *
 *   read    GET  /user, /repos/{r}, /repos/{r}/git/ref/heads/{b}, /repos/{r}/contents/{p}?ref=,
 *                /repos/{r}/pulls?head=&state=all, /repos/{r}/pulls/{n}, /search/issues
 *   write   POST /repos/{r}/forks (winget), /repos/{fork}/merge-upstream, /repos/{r}/git/trees,
 *                /repos/{r}/git/commits, /repos/{r}/git/refs, /repos/{r}/pulls;
 *           PATCH /repos/{r}/git/refs/heads/{b} (fast-forward only, never `force`)
 */

import type { Sleep } from "../ci.js";
import { untrusted } from "../untrusted.js";

export const GITHUB_API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubPull {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  labels: string[];
  title: string;
}

export interface GitHubClient {
  login(): Promise<string>;
  defaultBranch(repo: string): Promise<string>;
  refSha(repo: string, branch: string): Promise<string | null>;
  /** A file's text on a ref, or null when it does not exist. */
  fileText(repo: string, path: string, ref: string): Promise<string | null>;
  /** Whether a path (file or directory) exists on a ref. */
  exists(repo: string, path: string, ref: string): Promise<boolean>;
  /** Pull requests from `owner:branch`, any state, newest first. */
  pullsFromHead(repo: string, head: string): Promise<GitHubPull[]>;
  /** Pull requests on `repo` whose title contains `phrase`, any state. */
  pullsByTitle(repo: string, phrase: string): Promise<GitHubPull[]>;
  pull(repo: string, n: number): Promise<GitHubPull>;
  /** Fork `repo` into the token's account (idempotent); the fork's `owner/name`. */
  fork(repo: string): Promise<string>;
  /** Bring a fork's branch up to its upstream (best effort). */
  syncFork(fork: string, branch: string): Promise<void>;
  /** One commit on `parent` writing `files`; the commit's sha. */
  commit(
    repo: string,
    parent: string,
    files: readonly { path: string; content: string }[],
    message: string,
  ): Promise<string>;
  createBranch(repo: string, branch: string, sha: string): Promise<void>;
  /** Move a branch to a descendant of its head (never a force). */
  advanceBranch(repo: string, branch: string, sha: string): Promise<void>;
  openPull(
    repo: string,
    p: { title: string; head: string; base: string; body: string },
  ): Promise<GitHubPull>;
}

export interface GitHubClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  apiBase?: string;
}

interface RawPull {
  number: number;
  html_url: string;
  state: string;
  merged_at?: string | null;
  merged?: boolean;
  labels?: { name?: string }[];
  title?: string;
  pull_request?: { merged_at?: string | null; html_url?: string };
}

function toPull(r: RawPull): GitHubPull {
  const merged = Boolean(r.merged || r.merged_at || r.pull_request?.merged_at);
  return {
    number: r.number,
    url: r.pull_request?.html_url ?? r.html_url,
    state: r.state === "open" ? "open" : "closed",
    merged,
    labels: (r.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .sort(),
    title: r.title ?? "",
  };
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function githubClient(o: GitHubClientOptions = {}): GitHubClient {
  const f = o.fetchImpl ?? fetch;
  const base = o.apiBase ?? GITHUB_API;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "polaris-key-pkey",
    };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await f(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404 && allow404) return null;
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.ok) return parsed as T;
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? untrusted((parsed as { message: unknown }).message, {})
        : `HTTP ${res.status}`;
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new GitHubError(
      `GitHub ${method} ${path.split("?")[0]}: ${res.status} ${message}${remaining === "0" ? " (the token's rate limit is spent; retry after X-RateLimit-Reset)" : ""}`,
      res.status,
    );
  }

  const client: GitHubClient = {
    async login() {
      const u = await call<{ login: string }>("GET", "/user");
      return u!.login;
    },
    async defaultBranch(repo) {
      const r = await call<{ default_branch: string }>("GET", `/repos/${repo}`);
      return r!.default_branch;
    },
    async refSha(repo, branch) {
      const r = await call<{ object: { sha: string } }>(
        "GET",
        `/repos/${repo}/git/ref/heads/${enc(branch)}`,
        undefined,
        true,
      );
      return r?.object.sha ?? null;
    },
    async fileText(repo, path, ref) {
      const r = await call<{
        content?: string;
        encoding?: string;
        type?: string;
      }>(
        "GET",
        `/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
        undefined,
        true,
      );
      if (!r || r.type !== "file" || typeof r.content !== "string") return null;
      return Buffer.from(r.content, "base64").toString("utf8");
    },
    async exists(repo, path, ref) {
      const r = await call<unknown>(
        "GET",
        `/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
        undefined,
        true,
      );
      return r !== null;
    },
    async pullsFromHead(repo, head) {
      const r = await call<RawPull[]>(
        "GET",
        `/repos/${repo}/pulls?state=all&per_page=20&head=${encodeURIComponent(head)}`,
      );
      return (r ?? []).map(toPull);
    },
    async pullsByTitle(repo, phrase) {
      const q = `repo:${repo} is:pr in:title "${phrase.replace(/"/g, "")}"`;
      const r = await call<{ items: RawPull[] }>(
        "GET",
        `/search/issues?per_page=20&q=${encodeURIComponent(q)}`,
      );
      return (r?.items ?? [])
        .map(toPull)
        .filter((p) => p.title.includes(phrase));
    },
    async pull(repo, n) {
      return toPull((await call<RawPull>("GET", `/repos/${repo}/pulls/${n}`))!);
    },
    async fork(repo) {
      const r = await call<{ full_name: string }>(
        "POST",
        `/repos/${repo}/forks`,
        { default_branch_only: true },
      );
      const name = r!.full_name;
      // A new fork appears asynchronously: wait until its repository answers.
      for (let attempt = 0; attempt < 10; attempt++) {
        const there = await call<unknown>(
          "GET",
          `/repos/${name}`,
          undefined,
          true,
        );
        if (there) return name;
        await sleep(3000);
      }
      throw new GitHubError(`GitHub: the fork ${name} did not appear`, 504);
    },
    async syncFork(fork, branch) {
      try {
        await call("POST", `/repos/${fork}/merge-upstream`, { branch });
      } catch {
        // Best effort: the branch is created from the upstream's commit either way.
      }
    },
    async commit(repo, parent, files, message) {
      const c = await call<{ tree: { sha: string } }>(
        "GET",
        `/repos/${repo}/git/commits/${parent}`,
      );
      const tree = await call<{ sha: string }>(
        "POST",
        `/repos/${repo}/git/trees`,
        {
          base_tree: c!.tree.sha,
          tree: files.map((x) => ({
            path: x.path,
            mode: "100644",
            type: "blob",
            content: x.content,
          })),
        },
      );
      const commit = await call<{ sha: string }>(
        "POST",
        `/repos/${repo}/git/commits`,
        { message, tree: tree!.sha, parents: [parent] },
      );
      return commit!.sha;
    },
    async createBranch(repo, branch, sha) {
      await call("POST", `/repos/${repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      });
    },
    async advanceBranch(repo, branch, sha) {
      await call("PATCH", `/repos/${repo}/git/refs/heads/${enc(branch)}`, {
        sha,
        force: false,
      });
    },
    async openPull(repo, p) {
      return toPull(
        (await call<RawPull>("POST", `/repos/${repo}/pulls`, {
          ...p,
          maintainer_can_modify: true,
        }))!,
      );
    },
  };
  return client;
}
