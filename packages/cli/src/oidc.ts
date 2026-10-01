/**
 * `pkey auth github-oidc` (P2-06): trade the GitHub Actions job's OIDC token for a `pkeyci_`
 * token at `POST /<product>/release/publish/token` (P2-02), so a product's repository stores no
 * long-lived secret.
 *
 *   1. Request the job's OIDC token for the product's audience — `<origin>/<product>/release/
 *      publish` — from `ACTIONS_ID_TOKEN_REQUEST_URL` (`&audience=`), bearer
 *      `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. Both exist only in a job granted
 *      `permissions: id-token: write`.
 *   2. Exchange it. Each OIDC token can be exchanged ONCE, so every attempt (a `429` back-off)
 *      requests a fresh one.
 *   3. `::add-mask::` the result BEFORE anything else could print it, then (the explicit command
 *      only) append `PKEY_CI_TOKEN=<token>` to `$GITHUB_ENV` for later steps.
 *
 * Every other command resolves its token through `resolveCiToken`: `PKEY_CI_TOKEN` when set (an
 * operator's static `pkeyci_` token, the fallback for CI that is not GitHub), else this exchange
 * when the job is an Actions job with an OIDC grant, else a refusal that says which to provide.
 *
 * Nothing here ever prints a token. This module reads the environment only through the `env`
 * object it is handed, so the tests drive it without touching `process.env`.
 */

import { appendFile } from "node:fs/promises";
import { ciClient, type Out, type Sleep } from "./ci.js";

export const CI_TOKEN_ENV = "PKEY_CI_TOKEN";
const CI_TOKEN_SHAPE = /^pkeyci_[A-Za-z0-9_-]{43,}$/;

export type CiEnv = Record<string, string | undefined>;

export interface ExchangedToken {
  token: string;
  expiresAt: number;
  scopes: string[];
}

/** The audience a product's publish OIDC token must carry (P2-02's `publishAudience`). */
export function publishAudience(baseUrl: string, product: string): string {
  return `${new URL(baseUrl).origin}/${product}/release/publish`;
}

/** True in an Actions job granted `id-token: write`. */
export function canRequestGithubOidc(env: CiEnv): boolean {
  return Boolean(
    env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  );
}

/** True inside any GitHub Actions job — where `::add-mask::` means something. */
export function inGithubActions(env: CiEnv): boolean {
  return env.GITHUB_ACTIONS === "true";
}

/**
 * Hide `value` from the rest of the job's log. A workflow command, so it goes to stdout; written
 * only inside Actions (elsewhere it would just print the secret it was meant to hide).
 */
export function mask(env: CiEnv, out: Out, value: string): void {
  if (inGithubActions(env) && value) out.write(`::add-mask::${value}\n`);
}

/** Step 1: the job's OIDC token for `audience`. */
export async function requestGithubOidcToken(
  env: CiEnv,
  audience: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!base || !bearer)
    throw new Error(
      "This job cannot request a GitHub OIDC token: ACTIONS_ID_TOKEN_REQUEST_URL is unset. " +
        "Grant the job `permissions: id-token: write` (and contents: read).",
    );
  const url = `${base}${base.includes("?") ? "&" : "?"}audience=${encodeURIComponent(audience)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        authorization: `bearer ${bearer}`,
        accept: "application/json",
      },
    });
  } catch (e) {
    throw new Error(
      `Could not reach the Actions OIDC endpoint: ${(e as Error).message}`,
    );
  }
  if (!res.ok)
    throw new Error(
      `The Actions OIDC endpoint answered ${res.status}. Check the job's id-token: write permission.`,
    );
  const body = (await res.json().catch(() => ({}))) as { value?: unknown };
  if (typeof body.value !== "string" || body.value.split(".").length !== 3)
    throw new Error("The Actions OIDC endpoint returned no token.");
  return body.value;
}

export interface ExchangeOptions {
  baseUrl?: string;
  product: string;
  env: CiEnv;
  /** Where `::add-mask::` goes (stdout). */
  out: Out;
  /** Where retries are announced (stderr). */
  log?: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

/** Steps 1–2 and the mask: a fresh OIDC token per attempt, exchanged for a `pkeyci_` token. */
export async function exchangeGithubOidc(
  opts: ExchangeOptions,
): Promise<ExchangedToken> {
  const client = ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.log,
  });
  const audience = publishAudience(client.baseUrl, client.product);
  const body = await client.postJson<Record<string, unknown>>(
    "release/publish/token",
    {
      auth: false,
      retryRateLimit: true,
      what: "Exchanging the GitHub OIDC token",
      body: async () => ({
        token: await requestGithubOidcToken(opts.env, audience, opts.fetchImpl),
      }),
    },
  );
  const token = typeof body.token === "string" ? body.token : "";
  if (!CI_TOKEN_SHAPE.test(token))
    throw new Error(
      `${client.url("release/publish/token")} answered without a pkeyci_ token.`,
    );
  mask(opts.env, opts.out, token);
  return {
    token,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : 0,
    scopes: Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === "string")
      : [],
  };
}

/**
 * `pkey auth github-oidc`: exchange, mask, and hand the token to the job's later steps through
 * `$GITHUB_ENV`. Refuses outside an Actions job: there is no `$GITHUB_ENV` to write to, and
 * printing the token instead would defeat the point.
 */
export async function authGithubOidc(
  opts: ExchangeOptions,
): Promise<ExchangedToken> {
  const githubEnv = opts.env.GITHUB_ENV;
  if (!githubEnv || !canRequestGithubOidc(opts.env))
    throw new Error(
      "pkey auth github-oidc runs inside a GitHub Actions job with `permissions: id-token: write`. " +
        `Elsewhere, export ${CI_TOKEN_ENV} with a static pkeyci_ token an operator issued.`,
    );
  const issued = await exchangeGithubOidc(opts);
  await appendFile(githubEnv, `${CI_TOKEN_ENV}=${issued.token}\n`, "utf8");
  return issued;
}

/**
 * The token a CI command uses: `PKEY_CI_TOKEN`, else an implicit OIDC exchange in an Actions job,
 * else a refusal naming both.
 */
export async function resolveCiToken(opts: ExchangeOptions): Promise<string> {
  const fromEnv = opts.env[CI_TOKEN_ENV]?.trim();
  if (fromEnv) {
    if (!CI_TOKEN_SHAPE.test(fromEnv))
      throw new Error(
        `${CI_TOKEN_ENV} is set but is not a pkeyci_ token. Unset it to use the job's OIDC token.`,
      );
    mask(opts.env, opts.out, fromEnv);
    return fromEnv;
  }
  if (canRequestGithubOidc(opts.env))
    return (await exchangeGithubOidc(opts)).token;
  throw new Error(
    `No CI credential. In GitHub Actions, grant the job \`permissions: id-token: write\` and ` +
      `pkey exchanges the job's OIDC token itself; elsewhere, export ${CI_TOKEN_ENV} with a ` +
      "static pkeyci_ token an operator issued in the console.",
  );
}
