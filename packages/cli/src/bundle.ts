/**
 * `pkey bundle` — mint one OFFLINE ACTIVATION BUNDLE and write it to a file.
 *
 * The server half is `packages/worker/src/console/handlers/bundles.ts` —
 * `POST /manage/api/products/<slug>/bundles`. It signs the licence and/or config documents an
 * air-gapped install would have fetched, wraps them with the trust manifest needed to verify
 * them, and returns one compact `pkey-bundle+jws`. This module performs that call and drops the
 * JWS on disk as a single file an operator can hand-carry to the offline machine.
 *
 * ── AUTHENTICATION: AN ADMIN API TOKEN ──────────────────────────────────────────────────────
 *
 * This command authenticates with `Authorization: Bearer pkeya_…`, an admin API token read from
 * the environment variable `PKEY_ADMIN_TOKEN`. That is the whole credential story: no cookie, no
 * CSRF header, no pre-flight.
 *
 * WHAT IT REPLACED, AND WHY. This command used to have an operator copy their live
 * `__Host-pkey_admin` console cookie into the environment and then impersonate a browser well
 * enough to satisfy the CSRF double-submit: `GET /manage/api/me` for the session's CSRF token,
 * echoed in `X-PKey-CSRF` on the POST. That worked, and it was wrong in four separate ways. The
 * cookie could not be NARROWED — it carried the operator's entire admin authority, over every
 * product and every route, to a command that needs one. It could not be REVOKED in isolation;
 * killing it meant killing every session that human held. It was INDISTINGUISHABLE in the audit
 * log from that human clicking around the console, so "what has CI been doing with this?" had no
 * answer. And it EXPIRED on the session's schedule, which makes automation flaky rather than
 * safe. A `pkeya_` token fixes each of those separately: it is scoped (`bundles:mint`, which
 * covers exactly this one route — every other admin route refuses a token outright, by default
 * deny), individually revocable, separately attributed as `token:<id>` in the audit trail, and
 * given an explicit expiry at mint. The Worker's admin API token module is the authority on all
 * four.
 *
 * It also removes a network round trip, which is a consequence rather than the point. CSRF
 * defends against a credential the browser attaches AMBIENTLY; nothing attaches an
 * `Authorization` header but the caller, so a token-authenticated request is exempt and there is
 * no CSRF token to go and fetch. One call, one credential.
 *
 * HOW TO OBTAIN ONE. In the console: `/manage` → API tokens → New token. Give it a label naming
 * where it will run and an expiry you are willing to defend. The plaintext appears ONCE, in the
 * mint response, and nothing stored can reproduce it — the server keeps only a hash. Then, in
 * the shell you are about to run `pkey bundle` in:
 *
 *     export PKEY_ADMIN_TOKEN='pkeya_…'
 *
 * WHAT IT IS. A machine credential that can mint an offline bundle for any product on the
 * platform, and a bundle is a signed artifact carrying up to a year of offline grace. Narrower
 * than the cookie it replaced is not the same as harmless: keep it out of commits, out of tickets
 * and out of shells other people share. When one leaks, revoke that token in the console — which
 * is now a thing you can do without disturbing anybody's session.
 *
 * `pkey listing import` shares this module's request plumbing but not its credential: it calls a
 * route a `bundles:mint` token cannot reach, so it still authenticates with the console session
 * cookie (`listing.ts`), and applies the same `--base-url` rule below.
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
 * ["deviceId"]`.
 *
 * `PKEY_ADMIN_TOKEN` is shape-checked here against the same pattern the Worker applies to a
 * presented admin API token, for a sharper version of the same reason. The server deliberately
 * collapses malformed, unknown, revoked, expired and unusable into ONE 401, so that it cannot
 * leak whether a dead string was ever a real token — which means it also cannot tell an operator
 * that they pasted a cookie, or that a copy truncated the value, or that the shell ate a quote.
 * Everything about the SHAPE is knowable locally, so it is answered locally, and the 401 is left
 * to mean what it can actually distinguish.
 *
 * `--base-url` must be `https:`, or `http:` on a loopback host for `wrangler dev` and integration
 * tests — the same rule, the same host list and the same spirit as `normalizeBaseUrl` in
 * `packages/sdk-node/src/core/context.ts`. This command sends a full-authority credential to
 * whatever origin it is handed, so an origin that is mistyped, downgraded by a copy-paste, or
 * supplied by a CI variable somebody else can write is a credential disclosure; plaintext makes
 * it a coffee-shop attack rather than a local one. The check runs before anything is sent.
 *
 * The `--out` collision is checked early for a different reason again: a mint is an audited,
 * non-free event, so discovering the file name is already taken AFTER minting would burn a
 * bundle to learn something knowable up front.
 *
 * ── HOW THE FILE IS WRITTEN ─────────────────────────────────────────────────────────────────
 *
 * The bundle is a signed, credential-bearing artifact, so it is created mode 0600 through an
 * `openSync` with `O_EXCL | O_NOFOLLOW` — the pattern `packages/sdk-node/src/core/store.ts`
 * already uses for the device token, for the same reasons. A plain `writeFile` leaves the file
 * 0644 (world-readable) and follows a symlink planted at the output path, which quietly turns
 * "choose the output name" into "choose where the bundle lands and who gets to read it".
 */

import {
  closeSync,
  constants as fsc,
  fchmodSync,
  openSync,
  writeSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { untrusted } from "./untrusted.js";

/**
 * The platform's production origin — the same value as `DEFAULT_BASE` in
 * `packages/sdk-node/src/core/context.ts`. Restated rather than imported: the CLI does not
 * depend on the SDK, and a build-tool package taking a runtime dependency on a client SDK to
 * borrow one string would be a worse trade than this duplication.
 */
export const DEFAULT_BASE_URL = "https://key.plrs.im";

/** The environment variable this command reads its admin API token from. */
export const ADMIN_TOKEN_ENV = "PKEY_ADMIN_TOKEN";

/** `pkeya_` — `a` for admin. */
const ADMIN_TOKEN_PREFIX = "pkeya_";

/** An admin API token: the prefix plus 43 base64url characters (256 bits). Kept character for
 *  character identical to the Worker's shape check — a local check that is STRICTER than the
 *  server's would refuse a credential the platform accepts, which is worse than not checking at
 *  all. */
const ADMIN_TOKEN = /^pkeya_[A-Za-z0-9_-]{43,}$/;

/** The grace ceiling in days — `MAX_GRACE_DAYS` in the Worker's `console/handlers/bundles.ts` (§3.3). */
export const MAX_GRACE_DAYS = 365;

/** Wire v3 §6's device id: 32 base64url characters. */
const DEVICE_ID = /^[A-Za-z0-9_-]{32}$/;

/** Where `http:` is still allowed: the SDK's `LOOPBACK_HOSTS`. `[::1]` appears in bracketed form
 *  as well because that is what `URL.hostname` hands back for an IPv6 literal. A list, not an
 *  object keyed by hostname: `constructor` is a hostname too. */
const LOOPBACK_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
];

const BUNDLE_EXTENSION = ".pkeybundle";

/**
 * How the symlink refusal is enforced on this platform.
 *
 * `fs.constants.O_NOFOLLOW` is POSIX and present on darwin and linux, where the kernel refuses
 * the `open(2)` atomically. On Windows it is `undefined`, and `undefined | O_WRONLY` evaluates to
 * `NaN` rather than to "the other flags" — a silently broken flag word, not a degraded guard. So
 * it degrades to an explicit `0`, exactly as `SYMLINK_GUARD` does in
 * `packages/sdk-node/src/core/store.ts`, and the protection is simply absent there rather than
 * absent-while-claimed.
 */
const NOFOLLOW: number =
  typeof fsc.O_NOFOLLOW === "number" ? fsc.O_NOFOLLOW : 0;

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
  /** `process.env.PKEY_ADMIN_TOKEN`, read by the caller — this module never touches env. */
  token?: string;
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
  /** The base URL after validation, with trailing slashes stripped. */
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
 * Exactly ONE network call: `POST /manage/api/products/<slug>/bundles`, bearing the admin API
 * token. Everything checkable locally — the flags, the token's shape, the base URL's scheme, the
 * output path — is checked before it.
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
  const token = adminToken(opts.token);
  const baseUrl = normalizeBaseUrl(
    opts.baseUrl?.trim() || DEFAULT_BASE_URL,
    ADMIN_TOKEN_ENV,
  );
  const file = path.resolve(
    opts.cwd,
    opts.out?.trim() || bundleFileName(product, deviceId),
  );
  const force = opts.force === true;
  // Checked here even though `O_EXCL` enforces it at write time: a mint is an audited
  // server-side event, so a name clash that is knowable now must cost nothing.
  await refuseIfExists(file, force);

  const f = opts.fetchImpl ?? fetch;
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
      authorization: `Bearer ${token}`,
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
  writeNewFile(file, bundle, force);

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

/** The bearer token, or an error that says exactly what is wrong and how to get a good one. */
export function adminToken(
  raw: string | undefined,
  command: "bundle" | "migrate" = "bundle",
): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      `${ADMIN_TOKEN_ENV} is not set.\n` +
        `\`pkey ${command}\` calls the admin API, which authenticates it with an ` +
        "admin API token sent as `Authorization: Bearer pkeya_…`.\n" +
        (command === "migrate"
          ? "The token needs the `migrations:report` scope.\n"
          : "The token needs the `bundles:mint` scope.\n") +
        "Mint one in the console: /manage -> API tokens -> New token. Choose a label that says " +
        "where it will run and an expiry. The value is shown ONCE, at mint — nothing stored can " +
        "reproduce it — so copy it then, and run:\n" +
        `  export ${ADMIN_TOKEN_ENV}='${ADMIN_TOKEN_PREFIX}…'\n` +
        (command === "migrate"
          ? "It reaches the migration job list, reports and dry runs, and nothing else: "
          : "It can mint an offline bundle for any product on the platform: ") +
        "do not commit it, and do not export it into a shell other people share. If it leaks, " +
        "revoke that one token in the console.",
    );
  }
  if (!ADMIN_TOKEN.test(value)) {
    // Never echo the value itself. It is malformed by definition, but "malformed" is the
    // caller's claim about a secret and the length is enough to diagnose a truncated paste.
    const prefix = value.startsWith(ADMIN_TOKEN_PREFIX)
      ? ""
      : ` starting \`${clip(value.split(/[=\s]/, 1)[0] ?? "", 12)}\``;
    throw new Error(
      `${ADMIN_TOKEN_ENV} does not look like an admin API token. Expected \`${ADMIN_TOKEN_PREFIX}\` ` +
        `followed by 43 base64url characters (A-Z a-z 0-9 - _); got ${value.length} characters${prefix}.\n` +
        "A console session cookie is a DIFFERENT credential and is no longer accepted here. Mint a " +
        "token in the console (/manage -> API tokens) and export that instead.",
    );
  }
  return value;
}

/**
 * The base URL, validated and trailing-slash-stripped. `https:` always; `http:` only on a
 * loopback host, so `wrangler dev` and the integration suites keep working — the same rule
 * `normalizeBaseUrl` enforces in `packages/sdk-node/src/core/context.ts`, applied here because
 * the commands that share this module hand the origin a full-authority credential.
 * `credentialEnv` names that credential's environment variable, for the refusal's message.
 */
export function normalizeBaseUrl(raw: string, credentialEnv: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `--base-url is not a valid URL: ${raw}. Give a full origin, e.g. ${DEFAULT_BASE_URL}.`,
    );
  }
  const loopback =
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      `--base-url must be https: (got ${url.protocol}//${url.host}). ` +
        `${credentialEnv} is sent to this origin as a credential, so plaintext http:// ` +
        "is only accepted for localhost/127.0.0.1 during local development.",
    );
  }
  return raw.replace(/\/+$/, "");
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
 * `{error:{code,message,fields}, code, message, fields}` (`core/console/respond.ts`), so the
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
      `The admin API token in ${ADMIN_TOKEN_ENV} was refused. The server answers one 401 for ` +
      "unknown, revoked and expired alike, on purpose — check the roster in the console " +
      "(/manage -> API tokens) to see which, and mint a replacement there."
    );
  }
  if (status === 403) {
    return (
      "Authenticated, but not allowed. Two causes look identical from here: the token is not " +
      "scoped for this route (a `pkeya_` token needs `bundles:mint`, and every admin route " +
      "outside the bundle mint refuses tokens outright), or the identity behind it is not a " +
      "platform admin."
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
 *
 * This is the PRE-MINT check and nothing else: it exists so a knowable name clash is answered
 * before an audited, non-free server-side event happens, not because it is the enforcement.
 * `O_EXCL` in `writeNewFile` is the enforcement, and it also collapses the TOCTOU window this
 * check would otherwise open.
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

/**
 * Write the bundle, creating it 0600 and refusing to follow a symlink.
 *
 * Without `--force` the flags are `O_CREAT | O_EXCL`, which makes "do not overwrite" a kernel
 * guarantee rather than the result of a `stat` that finished some microseconds ago. `--force`
 * drops `O_EXCL` and adds `O_TRUNC` — but KEEPS `O_NOFOLLOW`, because the two are answers to
 * different questions: `--force` says the operator means to replace an existing regular file at
 * this path, and says nothing whatsoever about following a link that redirects the write to a
 * path outside the directory they named.
 */
function writeNewFile(file: string, body: string, force: boolean): void {
  const flags = force
    ? fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | NOFOLLOW
    : fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(file, flags, 0o600);
  } catch (err) {
    throw openFailure(file, err as NodeJS.ErrnoException);
  }
  try {
    // The creation mode applies only to a NEW file, so `--force` over an existing 0644 file
    // would otherwise leave a signed artifact world-readable. Tightening it is best-effort:
    // `fchmod` is unimplemented on some Windows and network filesystems, and a failure to
    // narrow a mode must not fail the write that was already going to happen.
    try {
      fchmodSync(fd, 0o600);
    } catch {
      /* best effort */
    }
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
}

/** An `open(2)` refusal, translated. A raw errno is not an operator-facing sentence. */
function openFailure(file: string, err: NodeJS.ErrnoException): Error {
  // O_EXCL. The same words `refuseIfExists` uses, because it is the same situation — this is
  // just the half of it that the pre-mint check could not see coming.
  if (err.code === "EEXIST")
    return new Error(`${file} already exists. Pass --force to overwrite.`);
  // O_NOFOLLOW. `--force` reaches here; without it, `O_EXCL` reports a symlink as EEXIST.
  if (err.code === "ELOOP")
    return new Error(
      `${file} is a symbolic link, and this command refuses to follow one. A bundle is a signed ` +
        "credential-bearing artifact; write it to a real path in a directory you control.",
    );
  return new Error(`Could not write the bundle to ${file}: ${err.message}`);
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
