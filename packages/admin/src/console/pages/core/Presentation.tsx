/**
 * Core → Presentation (HA-06; notes/S-20 §6.3, owner decision 11; docs/design/ADMIN.md §2.3).
 *
 * Every image Polaris Key hosts for the product: the product icon, the listing's icon, header and
 * screenshots, and any store slot (A-18) or other hosted copy. Each slot shows its source, its
 * status (pulling, ready, failed with the reason, stale with the last good copy kept), its size and
 * dimensions, a preview from the image host, and "Sizes pending" while its WebP sizes are owed.
 *
 * Actions (T4 settings rows; each write goes through `mutate`, which refreshes the slots, the
 * registry row and the product detail that carry the product card's icon, and Home's summary):
 *
 *   - Upload / Replace: the file goes to `POST …/assets/<slot>` and CLAIMS the slot: a resync and
 *     a CI push leave it alone until Revert.
 *   - Revert to manifest: a claimed slot whose source the manifest names goes back to it; the
 *     console's copy is deleted now and the manifest's is pulled again.
 *   - Delete copy: drops Polaris Key's copy at once (the image host stops serving it); a slot the
 *     manifest still names is pulled again at the next resync.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { ApiError, api, type HostedAssetDto } from "../../../api.js";
import { formatBytes } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import type { Tone } from "../../../lib/status.js";
import { PageHeader } from "../../components/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../templates/Settings.js";

const MiB = 1024 * 1024;
/** The Worker's caps for a slot with no row yet (icon slots 10 MiB, the rest 20 MiB). */
export function slotCap(slot: string): number {
  return /icon/.test(slot) ? 10 * MiB : 20 * MiB;
}

/** The image types an upload may be (the Worker sniffs; never SVG). */
export const UPLOAD_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif";

const MAX_SCREENSHOTS = 16;
const SCREENSHOT_RE = /^listing\.screenshot:(\d+)$/;

export function fetchHostedAssets(slug: string): Promise<HostedAssetDto[]> {
  return api.hostedAssets(slug).then((r) => r.assets);
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
            : slot;
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
    case undefined:
    case null:
      return "unknown";
    default:
      return reason;
  }
}

/** A failed upload, worded from the Worker's refusal. */
function uploadError(e: unknown, maxBytes: number): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === "too_large")
    return `That file is larger than this slot takes (${formatBytes(maxBytes)} at most).`;
  if (e.code === "asset_refused")
    return `The file was refused: ${reasonWords(e.reason ?? null)}.`;
  return null;
}

/** The standard slots, plus any other row, in display order. */
function layout(rows: readonly HostedAssetDto[]): {
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

export function PresentationPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const assets = useQuery(
    { queryKey: qk.hostedAssets(slug), queryFn: () => fetchHostedAssets(slug) },
    queryClient,
  );
  useLoadingAnnouncement("presentation", assets.isPending);
  const header = (
    <PageHeader
      title="Presentation"
      refetching={assets.isFetching && !assets.isPending}
    />
  );
  if (assets.isPending)
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="presentation" />
      </div>
    );
  if (assets.isError)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={assets.error}
          onRetry={() => void assets.refetch()}
        />
      </div>
    );
  const rows = assets.data;
  const byKey = new Map(rows.map((r) => [`${r.slot}@${r.locale}`, r]));
  const { presentation, listing, other } = layout(rows);
  const slotRow = (slot: string) => (
    <SlotRow
      key={slot}
      slug={slug}
      slot={slot}
      locale=""
      asset={byKey.get(`${slot}@`) ?? null}
    />
  );
  return (
    <SettingsTemplate
      header={header}
      sections={[
        { id: "presentation-product", title: "Product" },
        { id: "presentation-listing", title: "Listing" },
        ...(other.length
          ? [{ id: "presentation-other", title: "Other slots" }]
          : []),
      ]}
    >
      <SettingsSection
        id="presentation-product"
        title="Product"
        description="Polaris Key hosts a copy of each file and serves it from its image host; your original is unchanged."
      >
        {presentation.map(slotRow)}
      </SettingsSection>
      <SettingsSection id="presentation-listing" title="Listing">
        {listing.map(slotRow)}
      </SettingsSection>
      {other.length ? (
        <SettingsSection id="presentation-other" title="Other slots">
          {other.map((a) => (
            <SlotRow
              key={`${a.slot}@${a.locale}`}
              slug={slug}
              slot={a.slot}
              locale={a.locale}
              asset={a}
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsTemplate>
  );
}

function SlotRow({
  slug,
  slot,
  locale,
  asset,
}: {
  slug: string;
  slot: string;
  locale: string;
  asset: HostedAssetDto | null;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<"revert" | "delete" | null>(
    null,
  );
  const label = slotLabel(slot, locale);
  const uploadable = asset?.uploadable ?? true;
  const maxBytes = asset?.maxBytes ?? slotCap(slot);
  const canRevert = asset?.origin === "console" && asset.wanted !== null;
  const canDelete = uploadable && asset !== null && asset.sha256 !== null;
  const status = asset ? statusOf(asset) : null;

  const upload = async (file: File): Promise<void> => {
    if (file.size > maxBytes) {
      toast.error(
        `That file is larger than this slot takes (${formatBytes(maxBytes)} at most).`,
      );
      return;
    }
    setBusy(true);
    try {
      await mutate(
        "uploadHostedAsset",
        slug,
        slot,
        file,
        locale ? locale : undefined,
      );
      toast.success(`${label}: Polaris Key now hosts your file`, {
        description:
          "It is yours now: a resync and a CI push leave this slot alone.",
      });
    } catch (e) {
      const words = uploadError(e, maxBytes);
      if (words) toast.error(words);
      else toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const release = async (): Promise<void> => {
    const out = await mutate(
      "deleteHostedAsset",
      slug,
      slot,
      locale ? locale : undefined,
    );
    if (out.outcome === "reverted")
      toast.success(`${label} returned to the manifest`, {
        description: out.pulling
          ? "Polaris Key is pulling the manifest's file."
          : "The manifest's file is pulled at the next resync.",
      });
    else toast.success(`${label}: hosted copy deleted`);
  };

  const help: React.ReactNode = asset ? (
    <>
      <span className="block">{sourceWords(asset)}</span>
      {canRevert && asset.wanted ? (
        <span className="block">
          The manifest names {asset.wanted.src}; Revert returns the slot to it.
        </span>
      ) : null}
      {asset.status === "failed" || asset.status === "stale" ? (
        <span className="block">
          {asset.status === "stale" ? "Source gone" : "Last pull failed"}:{" "}
          {reasonWords(asset.error)}.{" "}
          {asset.sha256
            ? "The last good copy keeps serving."
            : "Nothing is served for it yet."}
        </span>
      ) : null}
      {asset.size !== null ? (
        <span className="block">
          {formatBytes(asset.size)}
          {asset.width !== null && asset.height !== null
            ? ` · ${asset.width}×${asset.height}`
            : ""}
          {asset.contentType ? ` · ${asset.contentType}` : ""}
        </span>
      ) : null}
    </>
  ) : (
    "Nothing hosted yet."
  );

  return (
    <SettingsRow
      label={label}
      help={help}
      aside={
        status ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={status.tone} size="sm">
              {status.label}
            </StatusPill>
            {asset?.sizesPending ? (
              <StatusPill tone="neutral" size="sm">
                Sizes pending
              </StatusPill>
            ) : null}
          </span>
        ) : null
      }
    >
      <span className="flex flex-wrap items-center justify-end gap-2">
        {asset?.previewUrl ? (
          <img
            src={asset.previewUrl}
            alt={`${label} preview`}
            crossOrigin="anonymous"
            loading="lazy"
            className="size-16 rounded-md border border-border bg-surface-sunken object-contain"
          />
        ) : null}
        {uploadable ? (
          <label
            aria-disabled={busy || undefined}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border-strong px-3 text-xs font-medium text-fg hover:bg-hover focus-within:ring-2 focus-within:ring-focus"
          >
            <Upload aria-hidden className="size-4" />
            {asset?.sha256 ? "Replace" : "Upload"}
            <input
              type="file"
              accept={UPLOAD_ACCEPT}
              aria-label={`${asset?.sha256 ? "Replace" : "Upload"} ${label}`}
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </label>
        ) : null}
        {canRevert ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirm("revert")}
          >
            Revert to manifest
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirm("delete")}
          >
            Delete copy
          </Button>
        ) : null}
      </span>
      <ConfirmDialog
        open={confirm === "revert"}
        onOpenChange={(o) => setConfirm(o ? "revert" : null)}
        intent="caution"
        title={`Revert ${label} to the manifest?`}
        description={
          asset?.wanted
            ? `Polaris Key pulls ${asset.wanted.src} again.`
            : undefined
        }
        consequences={[
          "The console's upload is deleted now.",
          "Nothing is shown for this slot until the manifest's file arrives.",
        ]}
        confirmLabel="Revert"
        onConfirm={release}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => setConfirm(o ? "delete" : null)}
        intent="danger"
        title={`Delete the hosted copy of ${label}?`}
        consequences={[
          "The image host stops serving it at once.",
          ...(asset?.wanted
            ? [
                "The manifest still names this file, so the next resync pulls it again. Remove it from the manifest, or upload a replacement, to keep it gone.",
              ]
            : []),
          "Your original is unchanged.",
        ]}
        confirmLabel="Delete copy"
        onConfirm={release}
      />
    </SettingsRow>
  );
}
