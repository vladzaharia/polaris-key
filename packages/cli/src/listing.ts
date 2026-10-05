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
 * Authentication is the console session cookie in `PKEY_ADMIN_COOKIE`, as for `pkey bundle`
 * (`bundle.ts` explains why there is no token). `--dry-run` reads the project and prints the
 * upload as JSON without contacting anything, so CI can check what would be sent.
 */

import {
  adminCookie,
  CSRF_HEADER,
  DEFAULT_BASE_URL,
  httpError,
  readCsrf,
  readJson,
  request,
  statusHint,
} from "./bundle.js";
import { readGodotListing, type GodotListing } from "./godotProject.js";

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

function listingHint(status: number): string | undefined {
  if (status === 404)
    return "No such product, or the product has no Distribution service enabled.";
  return status === 401 || status === 403 || status === 429
    ? statusHint(status)
    : undefined;
}

/** Run the import. See the file comment. */
export async function listingImport(
  opts: ListingImportOptions,
): Promise<ListingImportResult> {
  if (opts.locale !== undefined && !LOCALE.test(opts.locale))
    throw new Error(`--locale must be a code such as en-US.\n${LISTING_USAGE}`);
  if (opts.fields?.length && !opts.apply)
    throw new Error(`--fields goes with --apply.\n${LISTING_USAGE}`);
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
  if (!product) throw new Error(`--product is required.\n${LISTING_USAGE}`);
  const cookie = adminCookie(opts.cookie, "`pkey listing import` imports");
  const baseUrl = (opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const f = opts.fetchImpl ?? fetch;
  const csrf = await readCsrf(f, baseUrl, cookie, undefined);
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
        `Importing at ${url} failed (409): ${String(payload.message ?? payload.reason ?? "conflict")}`,
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
function show(v: unknown): string {
  const s = JSON.stringify(v) ?? "null";
  return s.length > 72 ? `${s.slice(0, 71)}…` : s;
}

/** The human form of a result: the diff, refusals, identifiers, icons and warnings. */
export function formatImport(r: ListingImportResult): string {
  const lines: string[] = [];
  if (r.presets.length) lines.push(`Presets read: ${r.presets.join(", ")}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  const imp = r.import;
  if (!imp) {
    lines.push(JSON.stringify(r.upload, null, 2));
    return lines.join("\n");
  }
  if (imp.createsListing)
    lines.push(
      `The product has no listing yet: this creates it (default locale ${imp.defaultLocale}).`,
    );
  if (!imp.changes.length)
    lines.push("No changes: the listing already holds what the project has.");
  const width = Math.max(0, ...imp.changes.map((c) => c.field.length));
  for (const c of imp.changes) {
    const value =
      c.action === "replace"
        ? `${show(c.current)} -> ${show(c.proposed)}`
        : c.action === "keep"
          ? `${show(c.current)} (kept: ${c.reason ?? "kept"}; godot has ${show(c.proposed)})`
          : show(c.proposed);
    lines.push(`  ${c.action.padEnd(7)}  ${c.field.padEnd(width)}  ${value}`);
  }
  for (const x of imp.refused) lines.push(`refused  ${x.field}: ${x.message}`);
  for (const i of imp.identifiers) {
    const where = i.outlets.length
      ? i.outlets
          .map((o) => `${o.outlet} ${o.matches ? "matches" : `has ${o.value}`}`)
          .join(", ")
      : "no outlet declares one";
    lines.push(`${i.kind} (${i.platform}) ${i.value}: ${where}`);
  }
  for (const a of imp.assets)
    lines.push(
      `icon ${a.slot}: ${a.ref}${a.width && a.height ? ` (${a.width}x${a.height})` : ""}; upload it with pkey listing assets`,
    );
  const applicable = imp.changes.filter((c) => c.action !== "keep").length;
  if (imp.applied)
    lines.push(
      imp.written.length
        ? `Applied ${imp.written.length} change${imp.written.length === 1 ? "" : "s"}: ${imp.written.join(", ")}`
        : "Nothing to apply.",
    );
  else if (applicable)
    lines.push(
      `Nothing written. Re-run with --apply to write ${applicable} change${applicable === 1 ? "" : "s"}.`,
    );
  return lines.join("\n");
}
