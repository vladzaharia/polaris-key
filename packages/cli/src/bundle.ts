/**
 * `pkey bundle` — mint one OFFLINE ACTIVATION BUNDLE and write it to a file.
 *
 * The server half is `packages/worker/src/console/handlers/bundles.ts` —
 * `POST /manage/api/products/<slug>/bundles`. It signs the licence and/or config documents an
 * air-gapped install would have fetched, wraps them with the trust manifest needed to verify
 * them, and returns one compact `pkey-bundle+jws`. This module performs that call and drops the
 * JWS on disk as a single file an operator can hand-carry to the offline machine.
 *
 * ── AUTHENTICATION: WHY A BROWSER COOKIE ────────────────────────────────────────────────────
 *
 * The admin API has exactly one credential today: the console's OIDC browser session. There is
 * no API-token surface yet, and inventing one here would mean shipping a second, weaker path to
 * the same authority. So this command reads the operator's live session cookie out of the
 * environment variable `PKEY_ADMIN_COOKIE`, GETs `/manage/api/me` with it to learn that
 * session's CSRF token, and echoes that token in `X-PKey-CSRF` on the POST — the same
 * double-submit the console itself performs (`packages/worker/src/console/api.ts`). This is
 * pre-launch operator-grade pragmatism, stated plainly rather than dressed up: it is the only
 * credential that exists.
 *
 * HOW TO OBTAIN IT. Sign in to the console, open browser devtools → Application → Cookies →
 * the console origin, and copy the `__Host-pkey_admin` cookie. Then, in the shell you are about
 * to run `pkey bundle` in:
 *
 *     export PKEY_ADMIN_COOKIE='__Host-pkey_admin=<value>'
 *
 * (The bare `<value>` is accepted too — this module prefixes the cookie name when the variable
 * holds no `=`.)
 *
 * WHAT IT IS. A short-lived session credential that carries the operator's full admin
 * authority. It must not be committed, written into a script, pasted into a ticket, or exported
 * into a shell other people share. It expires on its own; that is a backstop, not a policy.
 *
 * ── THE FLAG GOTCHA ─────────────────────────────────────────────────────────────────────────
 *
 * `parseArgs` in `index.ts` hands a valueless flag the next bare word, so `--no-config` or
 * `--force` immediately before a positional would swallow it. `pkey bundle` takes no
 * positionals, so the trap cannot spring here — but pass the boolean flags LAST, or as
 * `--no-config=true` / `--force=true`, and it cannot spring anywhere.
 *
 * ── WHAT IS VALIDATED HERE, AND WHY ─────────────────────────────────────────────────────────
 *
 * `--device` and `--grace-days` are checked against the same shapes `bundles.ts` enforces
 * (32 base64url characters; an integer 1…365) BEFORE anything is sent. The server would refuse
 * both with a 400, but a typo in a device id pasted off an offline machine's activation screen
 * should cost a local error message, not a network round trip that reports `fields:
 * ["deviceId"]`. The `--out` collision is checked early for a sharper reason: a mint is an
 * audited, non-free event, so discovering the file name is already taken AFTER minting would
 * burn a bundle to learn something knowable up front.
 */

import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { untrusted } from "./untrusted.js";

/**
 * The platform's production origin — the same value as `DEFAULT_BASE` in
 * `packages/sdk-node/src/core/context.ts`. Restated rather than imported: the CLI does not
 * depend on the SDK, and a build-tool package taking a runtime dependency on a client SDK to
 * borrow one string would be a worse trade than this duplication.
 */
export const DEFAULT_BASE_URL = "https://key.plrs.im";

/** The environment variable this command reads its admin session cookie from. */
export const ADMIN_COOKIE_ENV = "PKEY_ADMIN_COOKIE";

/** The console's session cookie name (`packages/worker/src/core/console/session.ts`). */
export const ADMIN_COOKIE_NAME = "__Host-pkey_admin";

/** The CSRF header every admin-API mutation must echo `/manage/api/me`'s `csrf` in. */
export const CSRF_HEADER = "X-PKey-CSRF";

/** The grace ceiling in days — `MAX_GRACE_DAYS` in the Worker's `core/bundles.ts` (§3.3). */
export const MAX_GRACE_DAYS = 365;

/** Wire v3 §6's device id: 32 base64url characters. */
const DEVICE_ID = /^[A-Za-z0-9_-]{32}$/;

const BUNDLE_EXTENSION = ".pkeybundle";

/** The one usage line, so the help text and every refusal cannot drift apart. */
export const BUNDLE_USAGE =
  "Usage: pkey bundle --product <slug> --device <id> --grace-days <n> " +
  "[--no-config] [--license <id>] [--base-url <url>] [--out <file>] [--force]";

export interface MintBundleOptions {
  /** The directory `out` resolves against — the handler's `cwd`, never `process.cwd()`. */
  cwd: string;
  product: string;
  deviceId: string;
  graceDays: number;
  /**
   * `false` ⇒ `includeConfig: false` rides on the request. Anything else ⇒ the field is not
   * sent at all, and the server's own default (true, collapsed against enablement) applies.
   */
  includeConfig?: boolean;
  /** Required by the server when the product's License service is enabled. */
  licenseId?: string;
  baseUrl?: string;
  /** Output path; relative paths resolve against `cwd`. Defaults to `bundleFileName(...)`. */
  out?: string;
  force?: boolean;
  /** `process.env.PKEY_ADMIN_COOKIE`, read by the caller — this module never touches env. */
  cookie?: string;
  /** The test seam: `packages/sdk-node/src/discovery.ts` establishes it repo-wide. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface MintBundleResult {
  bundleId: string;
  /** The compact `pkey-bundle+jws`, exactly as written to `file`. */
  bundle: string;
  /** Absolute path of the file written. */
  file: string;
  deviceId: string;
  graceDays: number;
  /** The base URL after trailing slashes were stripped. */
  baseUrl: string;
  /** The mint endpoint that answered. */
  url: string;
}

/** `<product>-<first 8 of deviceId>.pkeybundle`. The slug is reduced to filename-safe
 *  characters so a slug can never contribute a path separator to the default name. */
export function bundleFileName(product: string, deviceId: string): string {
  const safe = product.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe}-${deviceId.slice(0, 8)}${BUNDLE_EXTENSION}`;
}

/**
 * Mint one bundle and write it to disk.
 *
 * Two calls, in order: `GET /manage/api/me` for the session's CSRF token, then
 * `POST /manage/api/products/<slug>/bundles`. Everything checkable locally is checked before
 * either of them.
 */
export async function mintBundle(
  opts: MintBundleOptions,
): Promise<MintBundleResult> {
  const product = opts.product.trim();
  if (!product) throw new Error(`--product is required.\n${BUNDLE_USAGE}`);

  const deviceId = opts.deviceId.trim();
  if (!DEVICE_ID.test(deviceId)) {
    throw new Error(
      `--device must be 32 base64url characters (A-Z a-z 0-9 - _); got ${deviceId.length}. ` +
        "Copy it from the offline machine's activation screen exactly, without spaces or line breaks.",
    );
  }

  if (
    !Number.isInteger(opts.graceDays) ||
    opts.graceDays < 1 ||
    opts.graceDays > MAX_GRACE_DAYS
  ) {
    throw new Error(
      `--grace-days must be a whole number from 1 to ${MAX_GRACE_DAYS}` +
        `${Number.isFinite(opts.graceDays) ? ` (got ${opts.graceDays})` : ""}. ` +
        "It is the offline window the minted documents grant, in days.",
    );
  }

  const licenseId = opts.licenseId?.trim() || undefined;
  const cookie = adminCookie(opts.cookie);
  const baseUrl = (opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const file = path.resolve(
    opts.cwd,
    opts.out?.trim() || bundleFileName(product, deviceId),
  );
  const force = opts.force === true;
  // Checked here AND at write time on purpose: a mint is an audited server-side event, so a
  // name clash must cost nothing, but the window between the two checks is not zero.
  await refuseIfExists(file, force);

  const f = opts.fetchImpl ?? fetch;
  const csrf = await readCsrf(f, baseUrl, cookie, opts.signal);

  const url = `${baseUrl}/manage/api/products/${encodeURIComponent(product)}/bundles`;
  const body = JSON.stringify({
    deviceId,
    graceDays: opts.graceDays,
    ...(opts.includeConfig === false ? { includeConfig: false } : {}),
    ...(licenseId ? { licenseId } : {}),
  });
  const res = await request(f, url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      [CSRF_HEADER]: csrf,
    },
    body,
    signal: opts.signal,
  });
  if (!res.ok) throw await httpError(res, `Minting a bundle at ${url}`);

  const payload = await readJson(res, url);
  const bundleId = asString(payload.bundleId);
  const bundle = asString(payload.bundle);
  if (!bundleId || !bundle) {
    throw new Error(
      `${url} answered ${res.status} without a bundle. Expected {bundleId, bundle}.`,
    );
  }

  // No trailing newline: the file IS the JWS, so a naive read feeds a verifier directly.
  await writeNewFile(file, bundle, force);

  return {
    bundleId,
    bundle,
    file,
    deviceId,
    graceDays: opts.graceDays,
    baseUrl,
    url,
  };
}

/**
 * `GET /manage/api/me` → the session's CSRF token. The console reads it from the same place
 * for the same reason: the token is bound to the session, so it cannot be derived from the
 * cookie alone, and a stale cookie surfaces HERE rather than as a confusing 403 on the mint.
 */
export async function readCsrf(
  f: typeof fetch,
  baseUrl: string,
  cookie: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const url = `${baseUrl}/manage/api/me`;
  const res = await request(f, url, {
    headers: { accept: "application/json", cookie },
    signal,
  });
  if (!res.ok)
    throw await httpError(res, `Reading the admin session at ${url}`);

  const body = await readJson(res, url);
  const csrf = asString(body.csrf);
  if (!csrf) {
    throw new Error(
      `${url} returned no CSRF token, so the mint cannot be authorised. ` +
        `Check that ${ADMIN_COOKIE_ENV} holds a console session cookie and not, say, a proxy's.`,
    );
  }
  return csrf;
}

/** The cookie header value, or an error that says exactly how to get one. */
export function adminCookie(
  raw: string | undefined,
  command = "`pkey bundle` mints",
): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      `${ADMIN_COOKIE_ENV} is not set.\n` +
        `${command} through the admin API, which is authenticated by the console's ` +
        "browser session — there is no API token yet.\n" +
        "Sign in to the console, then in devtools: Application -> Cookies -> the console " +
        `origin -> copy the \`${ADMIN_COOKIE_NAME}\` cookie, and run:\n` +
        `  export ${ADMIN_COOKIE_ENV}='${ADMIN_COOKIE_NAME}=<value>'\n` +
        "It is a short-lived session credential carrying full admin authority: do not commit " +
        "it and do not export it into a shared shell.",
    );
  }
  // Operators paste either the whole `name=value` pair or just the value; `__Host-` cookies
  // always contain `=`, so the absence of one is unambiguous.
  return value.includes("=") ? value : `${ADMIN_COOKIE_NAME}=${value}`;
}

/** `fetch`, with transport failures named. Bare `fetch failed` tells an operator nothing. */
export async function request(
  f: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await f(url, init);
  } catch (e) {
    throw new Error(`Could not reach ${url}: ${(e as Error).message}`);
  }
}

/**
 * A non-OK admin response, rendered as something worth reading. The admin API answers
 * `{error:{code,message,fields}, code, message, fields}` (`admin/lib/respond.ts`), so the
 * server's own words are always available — a bare status is never the best we can do.
 */
export async function httpError(
  res: Response,
  what: string,
  hintFor: (status: number) => string | undefined = statusHint,
): Promise<Error> {
  const detail = await errorDetail(res);
  // The server's words: each cleaned (`untrusted.ts`) before it joins pkey's message.
  const u = (v: unknown) => untrusted(v, {});
  const label = [String(res.status), detail.code && u(detail.code)]
    .filter(Boolean)
    .join(" ");
  const message = detail.message ? `: ${u(detail.message)}` : "";
  const fields = detail.fields?.length
    ? ` (fields: ${detail.fields.map(u).join(", ")})`
    : "";
  const hint = hintFor(res.status);
  return new Error(
    `${what} failed (${label})${message}${fields}${hint ? `\n${hint}` : ""}`,
  );
}

export function statusHint(status: number): string | undefined {
  if (status === 401) {
    return (
      `The admin session cookie in ${ADMIN_COOKIE_ENV} is missing or expired. Sign in to the ` +
      `console again and copy a fresh \`${ADMIN_COOKIE_NAME}\` cookie (devtools -> Application -> Cookies).`
    );
  }
  if (status === 403) {
    return (
      `Rejected on authorization or CSRF. Confirm the account is a platform admin, and that ` +
      `${ADMIN_COOKIE_ENV} holds the CURRENT \`${ADMIN_COOKIE_NAME}\` value — the ${CSRF_HEADER} ` +
      "token is read from /manage/api/me with that same cookie, so a half-stale session fails here."
    );
  }
  if (status === 404) {
    return "No such product, or it has no usable signing key — a product that cannot sign cannot mint.";
  }
  if (status === 429) {
    return "The admin API rate limit tripped. Wait a minute and retry.";
  }
  return undefined;
}

interface ErrorDetail {
  code?: string;
  message?: string;
  fields?: string[];
}

async function errorDetail(res: Response): Promise<ErrorDetail> {
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // An HTML error page or a proxy's plain text: show a clipped prefix rather than nothing.
    const trimmed = text.trim();
    return trimmed ? { message: clip(trimmed) } : {};
  }
  if (!isRecord(parsed)) return {};
  const nested = isRecord(parsed.error) ? parsed.error : {};
  const detail: ErrorDetail = {};
  const code = asString(parsed.code) ?? asString(nested.code);
  const message = asString(parsed.message) ?? asString(nested.message);
  const fields = asStrings(parsed.fields) ?? asStrings(nested.fields);
  if (code) detail.code = code;
  if (message) detail.message = message;
  if (fields) detail.fields = fields;
  return detail;
}

export async function readJson(
  res: Response,
  url: string,
): Promise<Record<string, unknown>> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `${url} answered ${res.status} with a body that is not JSON: ${clip(text.trim())}`,
    );
  }
  if (!isRecord(parsed))
    throw new Error(
      `${url} answered ${res.status} with a non-object JSON body.`,
    );
  return parsed;
}

/**
 * The overwrite guard, the same ENOENT `stat` dance `manifest.ts`'s module-private
 * `writeNewFile` uses — untangled so the refusal is thrown outside the `try` rather than
 * through its own `catch`.
 */
async function refuseIfExists(file: string, force: boolean): Promise<void> {
  if (force) return;
  try {
    await stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  throw new Error(`${file} already exists. Pass --force to overwrite.`);
}

async function writeNewFile(
  file: string,
  body: string,
  force: boolean,
): Promise<void> {
  await refuseIfExists(file, force);
  await writeFile(file, body, "utf8");
}

function clip(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
