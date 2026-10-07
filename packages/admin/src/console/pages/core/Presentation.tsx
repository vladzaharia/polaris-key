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
 *
 * Hosting and quotas (HA-10; notes/S-20 §6.10): the bytes the product holds against its two
 * quotas (images, mirrored release files), a warning when one is full, whether hosted assets are
 * on for the deployment, and the product's three settings (`assets.releases.mirror`,
 * `assets.quota.mediaBytes`, `assets.quota.releaseBytes`), each saved through `writeSetting()`
 * with the version it was read at; Reset returns a quota to the platform default.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import {
  ApiError,
  api,
  type AssetSettingDto,
  type AssetUsageDto,
  type HostedAssetDto,
  type QuotaUsageDto,
} from "../../../api.js";
import { Callout } from "../../../ui/Callout.js";
import { Meter } from "../../../ui/charts/Meter.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { Switch } from "../../../ui/Switch.js";
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
    case "quota":
      return "the product holds its whole image quota (Hosting and quotas, below)";
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
  if (e.code === "asset_quota_exceeded")
    return "This product holds its whole image quota: the file was not stored, and the current copy keeps serving.";
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
  const usage = useQuery(
    { queryKey: qk.assetUsage(slug), queryFn: () => api.assetUsage(slug) },
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
        { id: "presentation-hosting", title: "Hosting and quotas" },
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
      <SettingsSection
        id="presentation-hosting"
        title="Hosting and quotas"
        description="What Polaris Key holds for this product, against its quotas. Each file counts once, however many slots use it."
      >
        {usage.isPending ? (
          <div className="px-5 py-4">
            <PageSkeleton template="form" label="hosting and quotas" />
          </div>
        ) : usage.isError || !usage.data ? (
          <div className="px-5 py-4">
            <ErrorState
              error={usage.error}
              onRetry={() => void usage.refetch()}
            />
          </div>
        ) : (
          <HostingRows slug={slug} usage={usage.data} />
        )}
      </SettingsSection>
    </SettingsTemplate>
  );
}

const QUOTA_MIB = 1024 * 1024;

/** Bytes in binary units, as the quotas are set ("512 MiB", "100 GiB"). */
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

/** The usage rows and the three settings (HA-10). */
function HostingRows({
  slug,
  usage,
}: {
  slug: string;
  usage: AssetUsageDto;
}): React.ReactElement {
  const byKey = new Map(usage.settings.map((s) => [s.key, s]));
  const mirror = byKey.get("assets.releases.mirror");
  const media = byKey.get("assets.quota.mediaBytes");
  const release = byKey.get("assets.quota.releaseBytes");
  return (
    <>
      {!usage.hosting ? (
        <div className="px-5 py-4">
          <Callout
            tone="warning"
            title="Hosted assets are off on this deployment"
          >
            Every image surface shows the developer&apos;s own URLs and no new
            release file is copied (Platform → Settings → Delivery). The copies
            below stay; release files already copied keep serving from them.
          </Callout>
        </div>
      ) : null}
      <UsageRow
        label="Images"
        usage={usage.media}
        full="This product holds its whole image quota: a new or replaced image is refused, and the current copies keep serving."
      />
      {media ? <QuotaRow slug={slug} setting={media} /> : null}
      <UsageRow
        label="Release files"
        usage={usage.release}
        full="This product holds its whole release-file quota: mirroring has stopped, and GitHub keeps serving the files that have no copy."
      />
      {release ? <QuotaRow slug={slug} setting={release} /> : null}
      {mirror ? <MirrorRow slug={slug} setting={mirror} /> : null}
    </>
  );
}

function UsageRow({
  label,
  usage,
  full,
}: {
  label: string;
  usage: QuotaUsageDto;
  full: string;
}): React.ReactElement {
  return (
    <SettingsRow
      label={label}
      help={
        <>
          <span className="block">
            {binaryBytes(usage.bytes)} of {binaryBytes(usage.quota)} ·{" "}
            {usage.files} {usage.files === 1 ? "file" : "files"}
          </span>
          {usage.full ? (
            <span className="mt-2 block">
              <Callout tone="warning" title="Quota full">
                {full}
              </Callout>
            </span>
          ) : null}
        </>
      }
    >
      <Meter
        label={`${label} used`}
        hideLabel
        value={usage.bytes}
        max={usage.quota}
        format="percent"
        tone={usage.full ? "danger" : "accent"}
        className="w-40"
      />
    </SettingsRow>
  );
}

/** Where a setting's value comes from, in words. */
function settingSourceWords(s: AssetSettingDto): string {
  return s.own
    ? "Set for this product"
    : s.source === "platform"
      ? "Platform default"
      : "Default";
}

function QuotaRow({
  slug,
  setting,
}: {
  slug: string;
  setting: AssetSettingDto;
}): React.ReactElement {
  const current = typeof setting.value === "number" ? setting.value : 0;
  const [mib, setMib] = React.useState<number | null>(
    Math.round(current / QUOTA_MIB),
  );
  const [confirm, setConfirm] = React.useState<"save" | "reset" | null>(null);
  React.useEffect(() => setMib(Math.round(current / QUOTA_MIB)), [current]);
  const max =
    setting.spec.kind === "integer"
      ? Math.floor(setting.spec.max / QUOTA_MIB)
      : undefined;
  const next = mib === null ? null : mib * QUOTA_MIB;
  const changed = next !== null && next !== current;
  const id = `asset-setting-${setting.key}`;
  const saveRef = React.useRef<HTMLButtonElement>(null);
  /**
   * After a save, the saved value comes back and disables Save, which may hold focus by then
   * (the dialog returns focus to it): keep focus in the row by moving it to the field. Watches
   * for a few seconds, never steals focus from anything else.
   */
  const keepFocusInRow = (): void => {
    const until = Date.now() + 5000;
    const tick = (): void => {
      const save = saveRef.current;
      const active = document.activeElement;
      const lost = !active || active === document.body || active === save;
      if (save?.disabled && lost) {
        document.getElementById(id)?.focus({ preventScroll: true });
        return;
      }
      if (Date.now() < until) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const inherited =
    typeof setting.inherited === "number" ? setting.inherited : null;
  return (
    <SettingsRow
      label={setting.label}
      htmlFor={id}
      help={
        <>
          <span className="block">{setting.description}</span>
          <span className="block">
            {settingSourceWords(setting)}: {binaryBytes(current)}
          </span>
        </>
      }
    >
      <span className="flex flex-wrap items-center justify-end gap-2">
        <NumberInput
          id={id}
          className="w-32"
          value={mib}
          onChange={setMib}
          integer
          min={0}
          max={max}
          unit="MiB"
          aria-label={`${setting.label} in MiB`}
        />
        <Button
          ref={saveRef}
          size="sm"
          disabled={!changed}
          onClick={() => setConfirm("save")}
        >
          Save
        </Button>
        {setting.own ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirm("reset")}>
            Reset
          </Button>
        ) : null}
      </span>
      <ConfirmDialog
        open={confirm === "save"}
        onOpenChange={(o) => setConfirm(o ? "save" : null)}
        intent="caution"
        title={`Set the ${setting.label.toLowerCase()} to ${next === null ? "" : binaryBytes(next)}?`}
        consequences={[
          next !== null && next < current
            ? "A file that would take the product past it is refused; the copies it already holds keep serving."
            : "More of this product's files can be copied and served.",
          "Only this product changes; the platform default stays.",
        ]}
        confirmLabel="Save"
        onConfirm={async () => {
          if (next === null) return;
          await mutate("saveAssetSetting", slug, setting.key, {
            value: next,
            expectedVersion: setting.version,
          });
          keepFocusInRow();
          toast.success(`${setting.label} set to ${binaryBytes(next)}`);
        }}
      />
      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(o) => setConfirm(o ? "reset" : null)}
        intent="caution"
        title={`Reset the ${setting.label.toLowerCase()}?`}
        consequences={[
          inherited === null
            ? "The product follows the platform default again."
            : `The product follows the platform default again: ${binaryBytes(inherited)}.`,
        ]}
        confirmLabel="Reset"
        onConfirm={async () => {
          await mutate("resetAssetSetting", slug, setting.key, setting.version);
          toast.success(`${setting.label} follows the platform default`);
        }}
      />
    </SettingsRow>
  );
}

function MirrorRow({
  slug,
  setting,
}: {
  slug: string;
  setting: AssetSettingDto;
}): React.ReactElement {
  const on = setting.value === "on";
  const [confirmOff, setConfirmOff] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const save = async (value: "on" | "off"): Promise<void> => {
    await mutate("saveAssetSetting", slug, setting.key, {
      value,
      expectedVersion: setting.version,
    });
    toast.success(
      value === "on"
        ? "Release files are mirrored again"
        : "No new release file is copied; copies already made keep serving",
    );
  };
  const id = `asset-setting-${setting.key}`;
  return (
    <SettingsRow
      label={setting.label}
      htmlFor={id}
      help={
        <>
          <span className="block">{setting.description}</span>
          <span className="block">{settingSourceWords(setting)}</span>
        </>
      }
    >
      <Switch
        id={id}
        checked={on}
        disabled={busy}
        onCheckedChange={(c) => {
          if (!c) {
            setConfirmOff(true);
            return;
          }
          setBusy(true);
          save("on")
            .catch((e: unknown) => toast.error(e))
            .finally(() => setBusy(false));
        }}
      />
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        intent="caution"
        title="Stop mirroring this product's release files?"
        consequences={[
          "No new release file is copied; GitHub serves them.",
          "Copies already made stay valid and keep serving.",
        ]}
        confirmLabel="Stop mirroring"
        onConfirm={() => save("off")}
      />
    </SettingsRow>
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
  // The server turns a delete of a claim the manifest still names into a Revert, so the page
  // offers Revert there and never promises "pulled again at the next resync".
  const canDelete =
    uploadable && asset !== null && asset.sha256 !== null && !canRevert;
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
          "The image host stops serving this slot's copy at once. The same file in another slot (the listing icon that falls back to the product icon) keeps serving.",
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
