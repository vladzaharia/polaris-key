/**
 * `pkey listing import --godot <project>` (A-18c; notes/S-15 §7.2): read a Godot project's listing
 * facts without the editor (`godotProject.ts`) and import them into the product's shared listing
 * through the admin API (`POST /manage/api/products/<slug>/distribution/listing/import`, source
 * `godot`).
 *
 * An import is two steps, and so is this command:
 *
 *   1. it uploads what it read and prints the Worker's field-by-field diff against the listing
 *      (`add`, `replace`, `keep` and why), the values the model refused, the bundle ids beside the
 *      outlets' identities, and the icons found. NOTHING is written;
 *   2. with `--apply` it sends the same upload with the diff's digest, and the Worker writes it,
 *      only if the diff is still the one printed (otherwise it answers with the new diff, which is
 *      printed, and the command fails: re-run to review it). `--fields` applies some changes only.
 *
 * Precedence is the Worker's ("the store that is live wins"): a value an App Store import wrote
 * stays unless the operator ranks the Godot project higher for that field, and a value typed in
 * the console stays unless `--overwrite`.
 *
 * Authentication is the console session cookie in `PKEY_ADMIN_COOKIE` — not the admin API token
 * `pkey bundle` uses (`bundle.ts`). A `bundles:mint` token reaches exactly one route, and the
 * import route is not it: every other admin route refuses a token outright, so this command
 * still presents the operator's console session, with the CSRF double-submit the console itself
 * performs. `--base-url` obeys the same https-or-loopback rule as `pkey bundle`, checked before
 * the cookie is sent anywhere. `--dry-run` reads the project and prints the upload as JSON
 * without contacting anything, so CI can check what would be sent.
 */

import {
  DEFAULT_BASE_URL,
  httpError,
  normalizeBaseUrl,
  readJson,
  request,
  statusHint,
} from "./bundle.js";
import { readGodotListing, type GodotListing } from "./godotProject.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";
import { UsageError } from "./errors.js";

/** The environment variable this command reads its admin session cookie from. */
export const ADMIN_COOKIE_ENV = "PKEY_ADMIN_COOKIE";

/** The console's session cookie name (`packages/worker/src/core/console/session.ts`). */
export const ADMIN_COOKIE_NAME = "__Host-pkey_admin";

/** The CSRF header every admin-API mutation must echo `/manage/api/me`'s `csrf` in. */
export const CSRF_HEADER = "X-PKey-CSRF";

export const LISTING_USAGE =
  "Usage: pkey listing import --godot <project> --product <slug> [--preset <name> ...]\n" +
  "              [--locale <code>] [--overwrite] [--apply [--fields a,b]] [--json]\n" +
  "              [--base-url <url>]\n" +
  "       pkey listing import --godot <project> --dry-run [--preset <name> ...]";

export interface ListingImportOptions {
  godot: string;
  product?: string;
  presets?: readonly string[];
  locale?: string;
  overwrite?: boolean;
  apply?: boolean;
  fields?: readonly string[];
  dryRun?: boolean;
  baseUrl?: string;
  /** `process.env.PKEY_ADMIN_COOKIE`, read by the caller. */
  cookie?: string;
  fetchImpl?: typeof fetch;
}

export interface ListingImportResult {
  /** What was (or, with `dryRun`, would be) uploaded. */
  upload: GodotListing;
  presets: string[];
  warnings: string[];
  /** The Worker's preview, or the apply's answer (absent for a dry run). */
  import?: ImportAnswer;
}

/** The parts of the Worker's import answer this command prints. */
export interface ImportAnswer {
  applied: boolean;
  digest: string;
  createsListing: boolean;
  defaultLocale: string;
  changes: Array<{
    field: string;
    action: "add" | "replace" | "keep";
    current: unknown;
    currentSource: string | null;
    proposed: unknown;
    proposedSource: string;
    reason: string | null;
  }>;
  refused: Array<{ field: string; message: string; source: string }>;
  identifiers: Array<{
    kind: string;
    platform: string;
    value: string;
    outlets: Array<{ outlet: string; value: string; matches: boolean }>;
  }>;
  assets: Array<{
    slot: string;
    ref: string;
    width: number | null;
    height: number | null;
  }>;
  written: string[];
}

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/** The cookie-authenticated commands' hints: a refused cookie, and the rate limit. */
function cookieHint(status: number): string | undefined {
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
  return status === 429 ? statusHint(status) : undefined;
}

function listingHint(status: number): string | undefined {
  if (status === 404)
    return "No such product, or the product has no Distribution service enabled.";
  return cookieHint(status);
}

/** The cookie header value, or an error that says exactly how to get one. */
function adminCookie(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      `${ADMIN_COOKIE_ENV} is not set.\n` +
        "`pkey listing import` imports through the admin API, which this command authenticates " +
        "with the console's browser session: the admin API token `pkey bundle` uses is scoped " +
        "to minting bundles and cannot reach this route.\n" +
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

/**
 * `GET /manage/api/me` → the session's CSRF token. The console reads it from the same place for
 * the same reason: the token is bound to the session, so it cannot be derived from the cookie
 * alone, and a stale cookie surfaces HERE rather than as a confusing 403 on the import.
 */
async function readCsrf(
  f: typeof fetch,
  baseUrl: string,
  cookie: string,
): Promise<string> {
  const url = `${baseUrl}/manage/api/me`;
  const res = await request(f, url, {
    headers: { accept: "application/json", cookie },
  });
  if (!res.ok)
    throw await httpError(
      res,
      `Reading the admin session at ${url}`,
      cookieHint,
    );

  const csrf = (await readJson(res, url)).csrf;
  if (typeof csrf !== "string" || !csrf.trim()) {
    throw new Error(
      `${url} returned no CSRF token, so the import cannot be authorised. ` +
        `Check that ${ADMIN_COOKIE_ENV} holds a console session cookie and not, say, a proxy's.`,
    );
  }
  return csrf;
}

/** Run the import. See the file comment. */
export async function listingImport(
  opts: ListingImportOptions,
): Promise<ListingImportResult> {
  if (opts.locale !== undefined && !LOCALE.test(opts.locale))
    throw new UsageError(
      `--locale must be a code such as en-US.\n${LISTING_USAGE}`,
    );
  if (opts.fields?.length && !opts.apply)
    throw new UsageError(`--fields goes with --apply.\n${LISTING_USAGE}`);
  const read = await readGodotListing(opts.godot, {
    ...(opts.presets?.length ? { presets: opts.presets } : {}),
  });
  const result: ListingImportResult = {
    upload: read.listing,
    presets: read.presets,
    warnings: read.warnings,
  };
  if (opts.dryRun) return result;

  const product = opts.product?.trim();
  if (!product)
    throw new UsageError(`--product is required.\n${LISTING_USAGE}`);
  const cookie = adminCookie(opts.cookie);
  const baseUrl = normalizeBaseUrl(
    opts.baseUrl?.trim() || DEFAULT_BASE_URL,
    ADMIN_COOKIE_ENV,
  );
  const f = opts.fetchImpl ?? fetch;
  const csrf = await readCsrf(f, baseUrl, cookie);
  const url = `${baseUrl}/manage/api/products/${encodeURIComponent(product)}/distribution/listing/import`;
  const body = {
    source: "godot",
    godot: read.listing,
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.overwrite ? { overwrite: true } : {}),
  };
  const post = async (extra: Record<string, unknown>) => {
    const res = await request(f, url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie,
        [CSRF_HEADER]: csrf,
      },
      body: JSON.stringify({ ...body, ...extra }),
    });
    if (res.status === 409) {
      const payload = await readJson(res, url);
      if (payload.reason === "import_changed" && payload.import) {
        result.import = payload.import as ImportAnswer;
        throw new Error(
          `The listing or its sources changed since the preview, so nothing was written. ` +
            `The new diff:\n${formatImport(result)}\nRe-run to review and apply it.`,
        );
      }
      throw new Error(
        `Importing at ${url} failed (409): ${untrusted(payload.message ?? payload.reason ?? "conflict", {})}`,
      );
    }
    if (!res.ok) throw await httpError(res, `Importing at ${url}`, listingHint);
    const payload = await readJson(res, url);
    const answer = payload.import as ImportAnswer | undefined;
    if (!answer || typeof answer.digest !== "string")
      throw new Error(`${url} answered ${res.status} without an import diff.`);
    return answer;
  };

  const preview = await post({});
  result.import = preview;
  if (!opts.apply) return result;
  result.import = await post({
    confirm: preview.digest,
    ...(opts.fields?.length ? { fields: opts.fields } : {}),
  });
  return result;
}

/** One value, quoted and clipped, control characters escaped (imported text is data). */
function show(v: unknown, env: UntrustedEnv): string {
  const s = JSON.stringify(v) ?? "null";
  // JSON escapes C0 but leaves DEL and C1 as they are: `untrusted` removes those too.
  return untrusted(s.length > 72 ? `${s.slice(0, 71)}…` : s, env);
}

/**
 * The human form of a result: the diff, refusals, identifiers, icons and warnings. Everything in
 * `r.import` is the server's answer, so each field is cleaned on its own (`untrusted.ts`); pass
 * the job's `env` so inside GitHub Actions no field reads as a workflow command either.
 */
export function formatImport(
  r: ListingImportResult,
  env: UntrustedEnv = {},
): string {
  const u = (v: unknown) => untrusted(v, env);
  const lines: string[] = [];
  if (r.presets.length) lines.push(`Presets read: ${r.presets.join(", ")}`);
  for (const w of r.warnings) lines.push(`warning: ${u(w)}`);
  const imp = r.import;
  if (!imp) {
    lines.push(JSON.stringify(r.upload, null, 2));
    return lines.join("\n");
  }
  if (imp.createsListing)
    lines.push(
      `The product has no listing yet: this creates it (default locale ${u(imp.defaultLocale)}).`,
    );
  if (!imp.changes.length)
    lines.push("No changes: the listing already holds what the project has.");
  const width = Math.max(0, ...imp.changes.map((c) => u(c.field).length));
  for (const c of imp.changes) {
    const value =
      c.action === "replace"
        ? `${show(c.current, env)} -> ${show(c.proposed, env)}`
        : c.action === "keep"
          ? `${show(c.current, env)} (kept: ${u(c.reason ?? "kept")}; godot has ${show(c.proposed, env)})`
          : show(c.proposed, env);
    lines.push(
      `  ${u(c.action).padEnd(7)}  ${u(c.field).padEnd(width)}  ${value}`,
    );
  }
  for (const x of imp.refused)
    lines.push(`refused  ${u(x.field)}: ${u(x.message)}`);
  for (const i of imp.identifiers) {
    const where = i.outlets.length
      ? i.outlets
          .map(
            (o) =>
              `${u(o.outlet)} ${o.matches ? "matches" : `has ${u(o.value)}`}`,
          )
          .join(", ")
      : "no outlet declares one";
    lines.push(`${u(i.kind)} (${u(i.platform)}) ${u(i.value)}: ${where}`);
  }
  for (const a of imp.assets)
    lines.push(
      `icon ${u(a.slot)}: ${u(a.ref)}${a.width && a.height ? ` (${u(a.width)}x${u(a.height)})` : ""}; upload it with pkey listing assets`,
    );
  const applicable = imp.changes.filter((c) => c.action !== "keep").length;
  if (imp.applied)
    lines.push(
      imp.written.length
        ? `Applied ${imp.written.length} change${imp.written.length === 1 ? "" : "s"}: ${imp.written.map(u).join(", ")}`
        : "Nothing to apply.",
    );
  else if (applicable)
    lines.push(
      `Nothing written. Re-run with --apply to write ${applicable} change${applicable === 1 ? "" : "s"}.`,
    );
  return lines.join("\n");
}
