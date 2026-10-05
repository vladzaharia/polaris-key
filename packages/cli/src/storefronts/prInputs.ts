/**
 * What a PR-plane generator reads (A-18i): the answer of `GET /<p>/distribution/pr/<store>`
 * (`packages/worker/src/services/distribution/prInputs.ts`), with the `pkeyci_` token that also
 * reports the step back (`distribution:report`). The Worker assembles the release, the listing
 * model's projection and the feed URLs, so the generators never reassemble Release's and
 * Distribution's rules from public feeds. These types mirror the Worker's.
 */

import type { CiClient } from "../ci.js";

export interface PrInputBuild {
  platform: string | null;
  arch: string;
  name: string;
  url: string;
  sha256: string | null;
  size: number | null;
}

export interface PrInputIssue {
  field: string;
  locale: string | null;
  issue: string;
  severity: string;
}

export interface PrInputs {
  store: string;
  channel: string;
  product: { slug: string; name: string };
  outlet: { id: string; kind: string; identity: Record<string, unknown> };
  release: {
    releaseId: string;
    version: string;
    publishedAt: number | null;
    builds: PrInputBuild[];
  } | null;
  notes: Record<string, { text: string | null; short: string | null }> | null;
  listing: {
    exists: boolean;
    status: string;
    payload: {
      app: Record<string, unknown>;
      locales: Record<string, Record<string, unknown>>;
    } | null;
    issues: PrInputIssue[];
  } | null;
  app: {
    defaultLocale: string;
    name: string;
    subtitle: string | null;
    shortDescription: string | null;
    description: string | null;
    developerName: string | null;
    copyright: string | null;
    website: string | null;
    supportUrl: string | null;
    privacyUrl: string | null;
    tint: string | null;
    tintDark: string | null;
    contentDescriptors: Record<string, unknown> | null;
    locales: Record<string, { name: string | null; subtitle: string | null }>;
    iconUrl: string | null;
    screenshots: string[];
  };
  links: { downloadJson: string; scoopFeed: string; flathubFeed: string };
  scoop?: unknown | null;
  selfUpdates: boolean;
}

/** One file a generator writes: its path in the repository and its content. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** Read the inputs for `store` on `channel` (and `outlet`, when given). */
export async function fetchPrInputs(
  client: CiClient,
  store: string,
  channel: string,
  outlet?: string,
): Promise<PrInputs> {
  const q = new URLSearchParams({ channel });
  if (outlet) q.set("outlet", outlet);
  const body = await client.getJson<{ inputs: PrInputs }>(
    `distribution/pr/${encodeURIComponent(store)}?${q.toString()}`,
    { what: `Reading the ${store} generator's inputs` },
  );
  return body.inputs;
}

/** The release, or a clear error when the channel serves none on the outlet yet. */
export function needRelease(i: PrInputs): NonNullable<PrInputs["release"]> {
  if (!i.release)
    throw new Error(
      `The ${i.channel} channel serves no release on the ${i.outlet.id} outlet yet: publish one first.`,
    );
  return i.release;
}

/** The listing projection's payload, or an error naming what blocks it. */
export function needPayload(
  i: PrInputs,
  label: string,
): NonNullable<NonNullable<PrInputs["listing"]>["payload"]> {
  const l = i.listing;
  if (l?.payload) return l.payload;
  const blocking = (l?.issues ?? [])
    .filter((x) => x.severity === "block")
    .map((x) => `${x.field}${x.locale ? ` (${x.locale})` : ""}: ${x.issue}`)
    .join("; ");
  throw new Error(
    `The listing's ${label} projection is blocked${l && !l.exists ? " (the product has no listing yet)" : ""}: ${blocking || "fix it in the console's Listing editor"}.`,
  );
}

/** `YYYY-MM-DD` of a Unix time in seconds, or null. */
export function isoDate(seconds: number | null): string | null {
  return seconds === null
    ? null
    : new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Whether a URL is `https:`. */
export function isHttps(u: string): boolean {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}
