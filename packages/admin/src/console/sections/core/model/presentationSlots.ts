/** The hosted-asset slots in the operator's words: labels, sources, statuses and refusals. */

import { HttpError, type HostedAssetDto } from "../../../../api.js";
import type { Tone } from "../../../../lib/status.js";

export const MiB = 1024 * 1024;
/** The Worker's caps for a slot with no row yet (icon slots 10 MiB, the rest 20 MiB). */
export function slotCap(slot: string): number {
  return /icon/.test(slot) ? 10 * MiB : 20 * MiB;
}

/** The image types an upload may be (the Worker sniffs; never SVG). */
export const UPLOAD_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif";

export const MAX_SCREENSHOTS = 16;
const SCREENSHOT_RE = /^listing\.screenshot:(\d+)$/;

/** Bytes in binary units, as the quotas are set ("512 MiB", "100 GiB"), on every size of the page. */
export function binaryBytes(bytes: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const n = u === 0 ? v : Math.round(v * 10) / 10;
  return `${new Intl.NumberFormat("en").format(n)} ${units[u]}`;
}

/** A slot id as words: `release-file` is "Release file", never the raw id. */
function humanSlot(slot: string): string {
  const words = slot.replace(/[-_.:]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : slot;
}

/** A slot in the operator's words. */
export function slotLabel(slot: string, locale = ""): string {
  const base =
    slot === "presentation.icon"
      ? "Product icon"
      : slot === "listing.icon"
        ? "Listing icon"
        : slot === "listing.header"
          ? "Header"
          : SCREENSHOT_RE.test(slot)
            ? `Screenshot ${SCREENSHOT_RE.exec(slot)![1]}`
            : humanSlot(slot);
  return locale ? `${base} (${locale})` : base;
}

/** Where the slot's copy came from, in words. */
export function sourceWords(a: HostedAssetDto): string {
  switch (a.origin) {
    case "console":
      return "Uploaded in the console";
    case "ci":
      return "Pushed from CI";
    case "release-mirror":
      return "Copied from the release";
    default:
      if (a.sourceKind === "repo" && a.sourceRef) {
        const at = a.sourceRef.lastIndexOf("@");
        const path = at > 0 ? a.sourceRef.slice(0, at) : a.sourceRef;
        const commit = at > 0 ? a.sourceRef.slice(at + 1, at + 8) : "";
        return `From the repository: ${path}${commit ? ` at ${commit}` : ""}`;
      }
      return a.sourceRef ? `From ${a.sourceRef}` : "From the manifest";
  }
}

/** The slot's status pill: the word and its tone. */
export function statusOf(a: HostedAssetDto): { label: string; tone: Tone } {
  switch (a.status) {
    case "ready":
      return a.pullPending
        ? { label: "Updating", tone: "info" }
        : { label: "Ready", tone: "success" };
    case "pending":
      return { label: "Pulling", tone: "info" };
    case "stale":
      return { label: "Source gone", tone: "warning" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    default:
      return { label: a.status, tone: "neutral" };
  }
}

/** What a refused upload or pull means, in a sentence. */
export function reasonWords(reason: string | null | undefined): string {
  switch (reason) {
    case "not-an-image":
      return "the file is not a PNG, JPEG, WebP, GIF or AVIF image";
    case "too-large":
      return "the file is larger than this slot takes";
    case "size-mismatch":
      return "the file ended before all of it arrived";
    case "sha256-mismatch":
      return "the file's SHA-256 is not the one the manifest names";
    case "status:404":
    case "status:410":
      return "the source answered that the file is gone";
    case "timeout":
      return "the source took too long to answer";
    case "retry":
      return "the file could not be stored just then";
    case "quota":
      return "the product holds its whole image quota (Hosting and quotas, below)";
    case undefined:
    case null:
      return "unknown";
    default:
      return reason;
  }
}

export const ACCEPTED_FORMATS = "PNG, JPEG, WebP, GIF or AVIF";

/**
 * A failed upload, worded from the Worker's refusal. Every failure says what keeps serving (when
 * a copy exists); a 415 names the formats a slot accepts.
 */
export function uploadError(
  e: unknown,
  maxBytes: number,
  hasCopy = true,
): string {
  const keeps = hasCopy ? " The current copy keeps serving." : "";
  if (e instanceof HttpError) {
    if (e.code === "too_large")
      return `That file is larger than this slot takes (${binaryBytes(maxBytes)} at most).${keeps}`;
    if (e.code === "asset_refused")
      return `The file was refused: ${reasonWords(e.reason ?? null)}.${keeps}`;
    if (e.code === "asset_quota_exceeded")
      return `This product holds its whole image quota: the file was not stored.${keeps}`;
    if (e.status === 415)
      return `That file type is not accepted. Use ${ACCEPTED_FORMATS}.${keeps}`;
  }
  if (e instanceof HttpError) return `The upload failed. Try again.${keeps}`;
  return `The upload didn't reach Polaris Key. Check your connection and try again.${keeps}`;
}

/** The standard slots, plus any other row, in display order. */
export function layout(rows: readonly HostedAssetDto[]): {
  presentation: string[];
  listing: string[];
  other: HostedAssetDto[];
} {
  const shots = rows
    .filter((r) => r.locale === "" && SCREENSHOT_RE.test(r.slot))
    .map((r) => Number(SCREENSHOT_RE.exec(r.slot)![1]))
    .sort((a, b) => a - b);
  const next = Math.min(MAX_SCREENSHOTS, (shots.at(-1) ?? 0) + 1);
  const shotSlots = [...new Set([...shots, next])]
    .filter((n) => n >= 1 && n <= MAX_SCREENSHOTS)
    .map((n) => `listing.screenshot:${n}`);
  const listing = ["listing.icon", "listing.header", ...shotSlots];
  const standard = new Set(["presentation.icon", ...listing]);
  return {
    presentation: ["presentation.icon"],
    listing,
    other: rows.filter((r) => r.locale !== "" || !standard.has(r.slot)),
  };
}
