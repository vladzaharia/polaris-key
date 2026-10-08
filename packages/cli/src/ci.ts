/**
 * The HTTP plumbing every CI-facing command shares (P2-06): `ciClient(baseUrl, product)` posts
 * JSON to the product's release routes with a `pkeyci_` token, renders the Worker's refusals as
 * something a failed job log can be read by, and retries exactly what the Worker says may be
 * retried.
 *
 * ── THE RETRY RULE ──────────────────────────────────────────────────────────────────────────
 *
 * A Worker refusal is FINAL unless its body says `"retryable": true` (P2-02: the lost-race
 * `release_exists` 409 and `promote_failed` 409). The one other case is `429 rate_limited` on
 * the token exchange, which is a back-off-and-retry by construction. Nothing else is retried
 * here — not a 5xx, not a dropped connection — because a submit is not blindly repeatable: a
 * submit that died after redeeming its ticket answers `ticket_redeemed` the second time, and
 * re-running the publish (a new ticket) is the honest recovery. The S3 uploads have their own,
 * looser rule (`s3.ts`): a PUT of content-addressed bytes is idempotent.
 *
 * P2b-03, P2b-04 and P2b-05 reuse this client for `pkey distribution report`, `rollout|halt`
 * and `pkey feeds fdroid`.
 */

import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import { DEFAULT_BASE_URL } from "./bundle.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";

export type Out = Pick<NodeJS.WriteStream, "write">;
export type Sleep = (ms: number) => Promise<void>;

/**
 * Where a long command reports its stages (`pkey release publish`, `pkey listing assets`). The
 * CLI passes a spinner that draws on stderr only on an interactive terminal (`terminal.ts`);
 * off a terminal, under CI, or from a library caller it is absent and nothing extra is printed.
 */
export interface StageProgress {
  /**
   * A new stage starts and replaces the previous one ("Hashing 4 files"); an empty label means
   * nothing long is running (the summary that follows prints without a spinner beside it).
   */
  stage(label: string): void;
  /** How far a counted stage is. */
  advance(done: number, total: number): void;
}

export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** How many times one request is attempted before its last refusal is reported. */
export const MAX_ATTEMPTS = 4;
/** The first back-off; doubled per attempt unless the server sends `Retry-After`. */
export const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** A refusal the Worker answered, with its machine-readable reason. */
export class CiRequestError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  readonly retryable: boolean;
  readonly body: Record<string, unknown>;
  constructor(
    message: string,
    status: number,
    body: Record<string, unknown>,
    retryable: boolean,
  ) {
    super(message);
    this.name = "CiRequestError";
    this.status = status;
    this.body = body;
    this.reason = typeof body.reason === "string" ? body.reason : undefined;
    this.retryable = retryable;
  }
}

/** The base URL, trailing slashes stripped; `DEFAULT_BASE_URL` when none is given. */
export function normalizeBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--base-url ${JSON.stringify(raw)} is not a URL.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error(
      `--base-url must be https (got ${url.protocol}//${url.host}); a CI token must never cross plain HTTP.`,
    );
  return raw;
}

export interface CiClientOptions {
  baseUrl?: string;
  product: string;
  /** The `pkeyci_` token; required by every route but the token exchange. */
  token?: string;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  maxAttempts?: number;
  /** Where a retry is announced (stderr). */
  log?: Out;
  /**
   * The job's environment: inside GitHub Actions a refusal's fields are also kept from reading
   * as workflow commands (`untrusted()`). Without it they are still stripped of every control.
   */
  env?: UntrustedEnv;
}

export interface PostOptions {
  /** Send the token (`false` for the exchange itself). Default true. */
  auth?: boolean;
  /** Also retry `429 rate_limited` (the token exchange). */
  retryRateLimit?: boolean;
  /** What the request is, for error messages: "Exchanging the OIDC token". */
  what: string;
  /** Rebuild the body per attempt (the token exchange needs a fresh OIDC token each time). */
  body: unknown | (() => Promise<unknown>);
}

export interface CiClient {
  readonly baseUrl: string;
  readonly product: string;
  /** `<baseUrl>/<product>/<path>`. */
  url(path: string): string;
  postJson<T = Record<string, unknown>>(
    path: string,
    opts: PostOptions,
  ): Promise<T>;
  /** GET a CI read route (P2b-05's F-Droid inputs), with the same refusal rendering. */
  getJson<T = Record<string, unknown>>(
    path: string,
    opts: { what: string },
  ): Promise<T>;
}

/** The CI client for one product (name and shape proposed by the P2-06 brief's hand-off). */
export function ciClient(opts: CiClientOptions): CiClient {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const product = opts.product.trim();
  // The one product slug shape (P0-14); an existing product, so not the reservations.
  if (!PRODUCT_SLUG_RE.test(product))
    throw new Error(
      `--product must be a product slug (got ${JSON.stringify(opts.product)}).`,
    );
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const env = opts.env ?? {};
  const url = (path: string) =>
    `${baseUrl}/${encodeURIComponent(product)}/${path.replace(/^\/+/, "")}`;

  async function postJson<T>(path: string, p: PostOptions): Promise<T> {
    const target = url(path);
    const auth = p.auth !== false;
    if (auth && !opts.token)
      throw new Error(`${p.what}: no CI token (this is a bug in pkey).`);
    for (let attempt = 1; ; attempt++) {
      const body =
        typeof p.body === "function"
          ? await (p.body as () => Promise<unknown>)()
          : p.body;
      let res: Response;
      try {
        res = await f(target, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(auth ? { authorization: `Bearer ${opts.token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new Error(
          `${p.what}: could not reach ${target}: ${(e as Error).message}`,
        );
      }
      const parsed = await readBody(res);
      if (res.ok) return parsed as T;
      const retryable =
        parsed.retryable === true ||
        (p.retryRateLimit === true &&
          res.status === 429 &&
          parsed.reason === "rate_limited");
      const err = new CiRequestError(
        renderRefusal(p.what, target, res.status, parsed, env),
        res.status,
        parsed,
        retryable,
      );
      if (!retryable || attempt >= maxAttempts) throw err;
      const wait = backoff(attempt, res.headers.get("retry-after"));
      opts.log?.write(
        `${p.what}: ${res.status} ${untrusted(err.reason ?? "", env)} is retryable; attempt ${attempt + 1} of ${maxAttempts} in ${Math.round(wait / 1000)}s\n`,
      );
      await sleep(wait);
    }
  }

  async function getJson<T>(path: string, p: { what: string }): Promise<T> {
    const target = url(path);
    if (!opts.token)
      throw new Error(`${p.what}: no CI token (this is a bug in pkey).`);
    let res: Response;
    try {
      res = await f(target, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${opts.token}`,
        },
      });
    } catch (e) {
      throw new Error(
        `${p.what}: could not reach ${target}: ${(e as Error).message}`,
      );
    }
    const parsed = await readBody(res);
    if (res.ok) return parsed as T;
    throw new CiRequestError(
      renderRefusal(p.what, target, res.status, parsed, env),
      res.status,
      parsed,
      false,
    );
  }

  return { baseUrl, product, url, postJson, getJson };
}

/** `Retry-After` seconds when the server sent one, else exponential from `BASE_BACKOFF_MS`. */
export function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Not JSON: a proxy's page. Keep a clipped prefix as the message.
  }
  const trimmed = text.trim();
  return trimmed ? { message: clip(trimmed) } : {};
}

/**
 * One refusal as the job log shows it: what failed, the status and `reason`, the server's
 * message, and the details a reason carries (`claim` for `policy_mismatch`, the validator's
 * findings for `invalid_descriptor`, the staged `key` for an upload problem), then a hint.
 *
 * Every field is the server's, so each goes through `untrusted()` on its own: no control
 * character, no line break of its own, and (with `env` inside Actions) no workflow command. The
 * line breaks are pkey's, one per detail.
 */
export function renderRefusal(
  what: string,
  target: string,
  status: number,
  body: Record<string, unknown>,
  env: UntrustedEnv = {},
): string {
  const u = (v: unknown) => untrusted(v, env);
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const code = typeof body.error === "string" ? body.error : undefined;
  const label = [String(status), reason ?? code]
    .filter(Boolean)
    .map(u)
    .join(" ");
  const lines = [`${what} failed (${label}) at ${target}`];
  if (typeof body.message === "string") lines.push(`  ${u(body.message)}`);
  if (typeof body.claim === "string")
    lines.push(`  failing claim: ${u(body.claim)}`);
  if (typeof body.key === "string") lines.push(`  object: ${u(body.key)}`);
  if (Array.isArray(body.fields) && body.fields.length)
    lines.push(`  fields: ${body.fields.map(u).join(", ")}`);
  if (Array.isArray(body.errors)) {
    for (const e of body.errors.slice(0, 50)) {
      const rec = (e ?? {}) as {
        path?: unknown;
        code?: unknown;
        message?: unknown;
      };
      lines.push(
        `  ${u(rec.path ?? "")} ${u(rec.code ?? "")}: ${u(rec.message ?? "")}`,
      );
    }
  }
  const hint = refusalHint(status, reason);
  if (hint) lines.push(hint);
  return lines.join("\n");
}

function refusalHint(status: number, reason: string | undefined): string {
  switch (reason) {
    case "policy_mismatch":
      return (
        "The job's OIDC token does not satisfy the product's publisher policy. Check the " +
        "workflow file and environment named in .pkey/release publishing.trustedPublisher, " +
        "that a branch or tag ruleset protects the ref (ref_protected), and that the job runs " +
        "on a GitHub-hosted runner. See /docs/build/ci/#troubleshooting."
      );
    case "publisher_not_configured":
      return "The product has no publisher policy: add publishing.trustedPublisher to .pkey/release and resync.";
    case "invalid_oidc_token":
      return "Request the OIDC token for the audience <base-url>/<product>/release/publish (pkey does this itself).";
    case "missing_scope":
      return "The CI token lacks this operation's scope; an operator grants scopes in the console.";
    case "oidc_token_replayed":
      return "Each OIDC token is exchanged once; pkey requests a fresh one per exchange, so another step reused it.";
    case "ticket_redeemed":
      return "This upload ticket was already redeemed by an earlier submit. Re-run the publish; it requests a new ticket, and an identical release is a no-op.";
    case "rate_limited":
      return "Rate limited. Wait a minute and re-run the job.";
    default:
      if (status === 401)
        return "The CI token is missing, expired or revoked. OIDC tokens live 30 minutes; re-run the job.";
      if (status === 404)
        return "Not found: check --product and --base-url, and that the product has Release enabled.";
      return "";
  }
}

function clip(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
