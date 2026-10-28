// Pure URL and discovery helpers the browser adapter needs at first render. They sit apart from
// `update.ts` (which carries the whole update decision, `runUpdateCheck`) so a page that never
// checks for an update does not load the decision engine.

import type { DiscoveryDocument } from "./discovery.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A service fragment's endpoint template, or null when the fragment lacks it. */
export function endpoint(
  discovery: DiscoveryDocument | null,
  service: "update" | "release" | "distribution",
  name: string,
): string | null {
  const fragment = discovery?.services?.[service as never] as unknown;
  if (!isRecord(fragment) || fragment.enabled !== true) return null;
  const endpoints = fragment.endpoints;
  if (!isRecord(endpoints)) return null;
  const t = endpoints[name];
  return typeof t === "string" && t !== "" ? t : null;
}

/** Substitute `{name}` placeholders (percent-encoded) and resolve against the control plane. */
export function expand(
  template: string,
  baseUrl: string,
  values: Record<string, string>,
): URL {
  let out = template;
  for (const [k, v] of Object.entries(values))
    out = out.split(`{${k}}`).join(encodeURIComponent(v));
  return new URL(out, `${baseUrl}/`);
}

/** The wire code a refusal body names (`{error: {code}}` or `{error: "code"}`), or null. */
export async function wireCodeOf(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const e = body.error;
    if (typeof e === "string" && e !== "") return e;
    if (isRecord(e) && typeof e.code === "string" && e.code !== "")
      return e.code;
    return null;
  } catch {
    return null;
  }
}

/**
 * A build's download URL (plans/P3-01.md §2.4): `distribution.endpoints.builds`, else
 * `release.endpoints.builds`, with `{selector}` = the record's version and `{buildId}` = the
 * build's id, each percent-encoded. That route serves the payload from every location; the
 * blob route is R2-only, so it is never used. Null when discovery has neither template.
 */
export function buildDownloadUrlFor(
  discovery: DiscoveryDocument | null,
  baseUrl: string,
  version: string,
  buildId: string,
): string | null {
  const template =
    endpoint(discovery, "distribution", "builds") ??
    endpoint(discovery, "release", "builds");
  if (template === null) return null;
  return expand(template, baseUrl, { selector: version, buildId }).toString();
}
