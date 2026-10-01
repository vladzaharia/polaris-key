// The Release service's browser surface (P1b-07, PARITY §5.5): the changelog, plus the install
// and artifact URLs — the same three verbs `@polaris-key/node`'s, `polaris_key`'s and Swift's
// `PolarisKeyRelease` clients have, pinned by the release-changelog transcript.
//
// Standalone functions over an injected `fetch`, like `discoverProduct`, so the transcript
// replayer drives exactly the code the browser adapter calls. The adapter adds the D-21 refusal
// (`service-disabled` when the product does not run Release) and the busy/error bookkeeping.
//
// A browser holds a cookie session, not a device bearer, so it never authenticates a release
// read: under the `entitled` access mode the Worker refuses it 401, and that refusal surfaces as
// `release-refused` carrying the body's own code — never as a generic failure to retry.

import { ErrorCode } from "../constants.generated.js";
import { PolarisError, type ChangelogEntry } from "../core/types.js";
import type { DownloadUrlOptions } from "../core/types.js";

export interface ReleaseRequestOptions {
  baseUrl: string;
  product: string;
  fetchImpl: typeof fetch;
  /** Extra request headers (the adapter's `X-PKey-*` metadata). */
  headers?: Record<string, string>;
}

function productUrl(baseUrl: string, product: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(product)}/${path}`;
}

/** The refusal's own code: nested v3 (`{"error":{"code":…}}`) or flat (`{"error":"…"}`). */
async function refusalCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: string | { code?: string } };
    const code = typeof body.error === "string" ? body.error : body.error?.code;
    return code || undefined;
  } catch {
    return undefined;
  }
}

/** One entry, tolerant of a missing field the way the other SDKs are. */
function toEntry(v: unknown): ChangelogEntry | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  return {
    version: str(o.version),
    tag: str(o.tag),
    date: typeof o.date === "string" ? o.date : null,
    summary: typeof o.summary === "string" ? o.summary : null,
    url: str(o.url),
  };
}

/** `GET /<product>/release/changelog` — the published release list, newest first. */
export async function fetchChangelog(
  opts: ReleaseRequestOptions,
): Promise<ChangelogEntry[]> {
  let res: Response;
  try {
    res = await opts.fetchImpl(
      productUrl(opts.baseUrl, opts.product, "release/changelog"),
      {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json", ...(opts.headers ?? {}) },
      },
    );
  } catch (e) {
    throw new PolarisError("network", (e as Error).message);
  }
  if (res.status === 401 || res.status === 403) {
    const wire =
      (await refusalCode(res)) ??
      (res.status === 401 ? ErrorCode.unauthorized : ErrorCode.forbidden);
    throw new PolarisError(
      ErrorCode.releaseRefused,
      res.status === 401
        ? "release/changelog refused: this feed needs a usable licence."
        : "release/changelog refused: this build is not entitled to that feed.",
      wire,
    );
  }
  if (!res.ok) {
    throw new PolarisError("network", `release/changelog ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const entries = (body as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.map(toEntry).filter((e): e is ChangelogEntry => e !== null);
}

/** The canonical install-script URL. Built, not fetched. */
export function buildInstallUrl(baseUrl: string, product: string): string {
  return productUrl(baseUrl, product, "release/install.sh");
}

/** `/<product>/release/dl/:version/:binary-:arch[.dmg][?checksum=sha256]`. Built, not fetched. */
export function buildDownloadUrl(
  baseUrl: string,
  product: string,
  version: string,
  binary: string,
  arch: string,
  opts: DownloadUrlOptions = {},
): string {
  const name = `${binary}-${arch}${opts.dmg ? ".dmg" : ""}`;
  const url = new URL(
    productUrl(
      baseUrl,
      product,
      `release/dl/${encodeURIComponent(version)}/${encodeURIComponent(name)}`,
    ),
  );
  if (opts.checksum) url.searchParams.set("checksum", "sha256");
  return url.toString();
}
