/**
 * Small pieces the Release pages share (ADMIN.md §6.3): platform glyph lists, where a file's bytes
 * live (explained in a popover, RBD-2), who signed a record (gold, AGENTS rule 2), and the mapping
 * from the API's release shapes to the policy dialog's picker options.
 */

import * as React from "react";
import { buildLabel } from "@polaris-key/manifest";
import {
  Globe,
  HelpCircle,
  Laptop,
  Monitor,
  Smartphone,
  Tablet,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type {
  ArtifactLocationDto,
  PackReleaseDto,
  ReleaseDto,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { label, PLATFORM_LABELS } from "../../../../lib/labels.js";
import { Popover } from "../../../../ui/Popover.js";
import { SignedBadge } from "../../../../ui/SignedBadge.js";
import type { ReleaseOption } from "./PolicyDialog.js";

/** The app deliverable's id (worker `APP_DELIVERABLE_ID`). */
export const APP = "app";

export function platformName(platform: string | null | undefined): string {
  if (!platform) return "Any platform";
  return label(PLATFORM_LABELS, platform);
}

const PLATFORM_ICON: Record<string, LucideIcon> = {
  macos: Laptop,
  windows: Monitor,
  linux: Terminal,
  ios: Smartphone,
  ipados: Tablet,
  android: Smartphone,
  web: Globe,
};

/**
 * A row of platform glyphs with the labels in an sr-only list (ADMIN.md §6.3.1 "Builds"). Each
 * glyph has its short label beside it at ≥ 640 px, so the fact never rests on the icon alone.
 */
export function PlatformGlyphs({
  platforms,
  label: listLabel,
  iconsOnly = false,
}: {
  platforms: (string | null)[];
  label: string;
  /** A table cell: one icon per platform, named in its tooltip and for AT. */
  iconsOnly?: boolean;
}): React.ReactElement {
  const unique = [...new Set(platforms.map((p) => p ?? "any"))];
  if (unique.length === 0)
    return <span className="text-xs text-fg-muted">No builds</span>;
  return (
    <ul
      aria-label={listLabel}
      className={cn(
        "flex items-center gap-1",
        iconsOnly ? "flex-nowrap" : "flex-wrap",
      )}
    >
      {unique.map((p) => {
        const Icon = PLATFORM_ICON[p] ?? HelpCircle;
        const name = p === "any" ? "Any platform" : platformName(p);
        return (
          <li
            key={p}
            title={iconsOnly ? name : undefined}
            className={cn(
              "inline-flex items-center gap-1 rounded-sm border border-border py-0.5 text-xs text-fg",
              iconsOnly ? "px-1" : "px-1.5",
            )}
          >
            <Icon aria-hidden className="size-3.5 text-fg-muted" />
            <span className={iconsOnly ? "sr-only" : undefined}>{name}</span>
          </li>
        );
      })}
    </ul>
  );
}

const LOCATION: Record<
  ArtifactLocationDto["provider"],
  { label: string; help: string }
> = {
  r2: {
    label: "R2",
    help: "Stored in Polaris Key's object storage and served from the bytes host.",
  },
  github: {
    label: "GitHub",
    help: "A GitHub release asset; Polaris Key serves it through its own routes.",
  },
  store: {
    label: "Store",
    help: "Delivered by a store (App Store, Google Play); Polaris Key holds no bytes.",
  },
  external: {
    label: "External",
    help: "Hosted at a URL the descriptor named, pinned by the file's SHA-256.",
  },
};

const SYNCED = {
  label: "GitHub (synced)",
  help: "No descriptor declared this file; the GitHub sync indexed it from the release's assets, so its bytes are on GitHub.",
};

/** Where a file's bytes live, one entry per provider. */
export function locationsOf(
  locations: ArtifactLocationDto[] | null,
): { label: string; help: string }[] {
  if (!locations || locations.length === 0) return [SYNCED];
  const seen = new Set<string>();
  const out: { label: string; help: string }[] = [];
  for (const l of locations) {
    if (seen.has(l.provider)) continue;
    seen.add(l.provider);
    out.push(LOCATION[l.provider] ?? { label: String(l.provider), help: "" });
  }
  return out;
}

/** Location badges that explain themselves in a popover (RBD-2), never in a `title`. */
export function LocationBadges({
  locations,
  file,
}: {
  locations: ArtifactLocationDto[] | null;
  file: string;
}): React.ReactElement {
  const list = locationsOf(locations);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {list.map((l) => (
        <Popover
          key={l.label}
          label={`Where ${file} is stored`}
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs text-fg hover:bg-hover"
            >
              {l.label}
              <HelpCircle aria-hidden className="size-3 text-fg-muted" />
              <span className="sr-only">: where the bytes live</span>
            </button>
          }
        >
          <p className="max-w-64 text-xs text-fg">{l.help}</p>
        </Popover>
      ))}
    </span>
  );
}

/** A build's one-line description: "macOS · universal · zip · build 41 · min 12.0". */
export function buildSummary(b: {
  platform: string | null;
  arch: string;
  format: string | null;
  buildNumber: string | null;
  minOs: string | null;
}): string {
  const l = buildLabel(b);
  return [
    l.platform,
    l.arch ?? b.arch,
    b.format,
    b.buildNumber ? `build ${b.buildNumber}` : null,
    b.minOs ? `min ${l.platform} ${b.minOs}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** An app release's signer, in gold; "Unsigned" (muted) for a legacy release with no record. */
export function ReleaseSigner({
  signer,
  truncateKid = false,
}: {
  signer: ReleaseDto["signer"];
  /** In a table column: the kid truncates, whole in its tooltip. */
  truncateKid?: boolean;
}): React.ReactElement {
  if (!signer)
    return (
      <span className="text-xs text-fg-muted">
        {signer === null ? "No signed record" : "—"}
      </span>
    );
  return (
    <SignedBadge
      kid={signer.kid}
      by="the release key"
      truncateKid={truncateKid}
    />
  );
}

/** A pack release's signer (PKD-4): the release key, or a delegated content key. */
export function PackSigner({
  signer,
}: {
  signer: PackReleaseDto["signer"];
}): React.ReactElement {
  if (!signer) return <span className="text-xs text-fg-muted">—</span>;
  if (signer.kind === "release")
    return <SignedBadge kid={signer.kid} by="the release key" />;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <SignedBadge by="a content key" />
      <span className="text-xs text-fg-muted">
        content key{" "}
        <span className="font-mono">
          {signer.scope}.* #{signer.seq}
        </span>
      </span>
    </span>
  );
}

export function optionOfRelease(r: ReleaseDto): ReleaseOption {
  return {
    releaseId: r.releaseId,
    version: r.version,
    channel: r.channel,
    publishedAt: r.publishedAt,
    seq: r.seq,
    yanked: r.yank !== null,
  };
}

export function optionOfPackRelease(r: PackReleaseDto): ReleaseOption {
  return {
    releaseId: r.releaseId,
    version: r.version,
    channel: r.channel,
    publishedAt: r.publishedAt,
    seq: r.seq,
    yanked: r.yank !== null,
  };
}

/** Who did something, as the console says it: `admin:u1` → "u1 (console)", `ci:…` → CI. */
export function actorName(by: string | null | undefined): string {
  if (!by) return "someone";
  if (by.startsWith("admin:")) return by.slice("admin:".length);
  if (by.startsWith("ci:")) return `CI (${by.slice("ci:".length)})`;
  return by;
}
