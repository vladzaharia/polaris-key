import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ImageIcon, Upload } from "lucide-react";
import { ApiError, type HostedAssetDto } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { ActionMenu } from "../../../../ui/ActionMenu.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import {
  ACCEPTED_FORMATS,
  UPLOAD_ACCEPT,
  binaryBytes,
  reasonWords,
  slotCap,
  slotLabel,
  sourceWords,
  statusOf,
  uploadError,
} from "../model/presentationSlots.js";

/** Who filled the slot, as the neutral pill beside its name. */
function originPill(a: HostedAssetDto | null): string | null {
  switch (a?.origin) {
    case undefined:
      return null;
    case "console":
      return "Uploaded";
    case "ci":
      return "CI";
    case "release-mirror":
      return "Release";
    default:
      return "Manifest";
  }
}

/**
 * One hosted slot as a row of the page (products.settings-presentation): a thumbnail, the name
 * with its source pill, one fact per line, and only the actions that apply. A refused upload
 * stays inline at the row with the old copy still serving.
 */
export function PresentationSlotRow({
  slug,
  slot,
  locale,
  asset,
  quotaFull = false,
}: {
  slug: string;
  slot: string;
  locale: string;
  asset: HostedAssetDto | null;
  /** The product holds its whole image quota: the Worker would refuse the file. */
  quotaFull?: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<"revert" | "delete" | null>(
    null,
  );
  const label = slotLabel(slot, locale);
  const uploadable = asset?.uploadable ?? true;
  const maxBytes = asset?.maxBytes ?? slotCap(slot);
  const canRevert = asset?.origin === "console" && asset.wanted !== null;
  // The server turns a delete of a claim the manifest still names into a Revert, so the page
  // offers Revert there and never promises "pulled again at the next resync".
  const canDelete =
    uploadable && asset !== null && asset.sha256 !== null && !canRevert;
  const status = asset ? statusOf(asset) : null;
  const pill = originPill(asset);
  const verb = asset?.sha256 ? "Replace" : "Upload";
  const errorId = `slot-${slot.replace(/[^a-z0-9]+/gi, "-")}${locale ? `-${locale}` : ""}-error`;

  const upload = async (file: File): Promise<void> => {
    setFailure(null);
    if (file.size > maxBytes) {
      setFailure(
        `That file is ${binaryBytes(file.size)}: this slot takes ${binaryBytes(maxBytes)} at most.${asset?.sha256 ? " The current copy keeps serving." : ""}`,
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
      setFailure(uploadError(e, maxBytes, Boolean(asset?.sha256)));
    } finally {
      setBusy(false);
    }
  };

  const release = async (): Promise<void> => {
    let out;
    try {
      out = await mutate(
        "deleteHostedAsset",
        slug,
        slot,
        locale ? locale : undefined,
      );
    } catch (e) {
      // Another upload or a pull landed first: show the slot as it is now.
      if (e instanceof ApiError && e.code === "asset_changed")
        void queryClient.invalidateQueries({
          queryKey: qk.hostedAssets(slug),
        });
      throw e;
    }
    if (out.outcome === "reverted")
      toast.success(`${label} returned to the manifest`, {
        description: out.pulling
          ? "Polaris Key is pulling the manifest's file."
          : "The manifest's file is pulled at the next resync.",
      });
    else toast.success(`${label}: hosted copy deleted`);
  };

  const facts: React.ReactNode[] = asset
    ? [
        asset.size !== null
          ? [
              asset.width !== null && asset.height !== null
                ? `${asset.width} × ${asset.height}`
                : null,
              binaryBytes(asset.size),
              asset.contentType,
            ]
              .filter(Boolean)
              .join(" · ")
          : "Nothing served yet",
        sourceWords(asset),
        canRevert && asset.wanted
          ? `The manifest names ${asset.wanted.src}; Revert returns the slot to it.`
          : null,
        asset.status === "failed" || asset.status === "stale"
          ? `${asset.status === "stale" ? "Source gone" : "Last pull failed"}: ${reasonWords(asset.error)}. ${asset.sha256 ? "The last good copy keeps serving." : "Nothing is served for it yet."}`
          : null,
      ].filter(Boolean)
    : ["Nothing hosted yet"];
  if (uploadable && quotaFull)
    facts.push("Image quota full: free space under Hosting and quotas first");
  else if (uploadable && !failure)
    facts.push(`${ACCEPTED_FORMATS}, up to ${binaryBytes(maxBytes)}`);

  const menu = canDelete
    ? [{ label: "Delete copy", onSelect: () => setConfirm("delete") }]
    : [];

  return (
    <div role="group" aria-label={label} className="px-5 py-4">
      <div className="flex items-start gap-4 max-sm:grid max-sm:grid-cols-[auto_minmax(0,1fr)]">
        {asset?.previewUrl ? (
          <img
            src={asset.previewUrl}
            alt=""
            crossOrigin="anonymous"
            loading="lazy"
            className="size-12 shrink-0 rounded-md border border-border bg-surface-sunken object-contain"
          />
        ) : (
          <span
            aria-hidden
            className="inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken text-fg-muted"
          >
            <ImageIcon className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-strong">
            {label}
            {pill ? (
              <StatusPill tone="neutral" icon={false} size="sm">
                {pill}
              </StatusPill>
            ) : null}
            {status && status.label !== "Ready" ? (
              <StatusPill tone={status.tone} size="sm">
                {status.label}
              </StatusPill>
            ) : null}
            {asset?.sizesPending ? (
              <StatusPill tone="neutral" size="sm">
                Sizes pending
              </StatusPill>
            ) : null}
          </p>
          {facts.map((f, i) => (
            <p
              key={i}
              className="text-sm text-fg-muted [overflow-wrap:anywhere]"
            >
              {f}
            </p>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 max-sm:col-span-2 max-sm:justify-start">
          {uploadable ? (
            <label
              aria-disabled={busy || quotaFull || undefined}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border-strong px-3 text-xs font-normal text-fg hover:bg-hover focus-within:ring-2 focus-within:ring-focus aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
            >
              <Upload aria-hidden className="size-4" />
              {verb}
              <input
                type="file"
                accept={UPLOAD_ACCEPT}
                aria-label={`${verb} ${label}`}
                aria-describedby={failure ? errorId : undefined}
                className="sr-only"
                disabled={busy || quotaFull}
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
              aria-label={`Revert ${label} to manifest`}
              onClick={() => setConfirm("revert")}
            >
              Revert to manifest
            </Button>
          ) : null}
          {menu.length ? (
            <ActionMenu label={`More for ${label}`} items={menu} />
          ) : null}
        </div>
      </div>
      {failure ? (
        <p
          id={errorId}
          role="alert"
          className="mt-2 pl-16 text-sm text-danger max-sm:pl-0"
        >
          {failure}
        </p>
      ) : null}
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
        describeError={errorCopy}
        onConfirm={release}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => setConfirm(o ? "delete" : null)}
        intent="danger"
        title={`Delete the hosted copy of ${label}?`}
        consequences={[
          "The image host stops serving this slot's copy at once. The same file in another slot (the listing icon that falls back to the product icon) keeps serving.",
          ...(asset?.wanted
            ? [
                "The manifest still names this file, so the next resync pulls it again. Remove it from the manifest, or upload a replacement, to keep it gone.",
              ]
            : []),
          "Your original is unchanged.",
        ]}
        confirmLabel="Delete copy"
        describeError={errorCopy}
        onConfirm={release}
      />
    </div>
  );
}
