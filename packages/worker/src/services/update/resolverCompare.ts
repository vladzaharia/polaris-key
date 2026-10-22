/**
 * The comparator behind the P2-12 switch (P2-12.4, plans/P2-12.md §6.5).
 *
 * Update has two compute steps for the appcast, the channel appcast and `/update/version`: the
 * legacy one (GitHub, per request) and the store one (the truth store in GitHub's shape). This
 * module is what proves them equal, or says why they are not:
 *
 *   - the probe list for these surfaces (`buildProbes`);
 *   - the comparison: status, `content-type`, `cache-control` and the body's SHA-256
 *     (`outcomeOf`, `sameOutcome`);
 *   - the class of a difference (`classifyDifference`), named as in §6.5 and the brief's
 *     Corrections 5 and 6.
 *
 * There is no job here yet (P2-12.7 wraps `compareProbe` in a P0-49 job with pacing). Nothing is
 * routed: the probe runs `computeVersion` / `computeAppcast` directly, on a synthetic request, so
 * it bypasses the edge cache, the access check and the rate limit. The legacy step keeps its
 * resolution cache (`ghCache`), so a probe costs what serving costs.
 *
 * Classification is a pure reading of the store and the two answers. A class that is expected
 * names a deliberate convergence on one meaning per track (D6, D5); `stale-store` and
 * `unexpected` block the switch; `upstream-error` is retried.
 */

import { sha256Hex } from "../../platform/hash.js";
import type { Db } from "../../db/types.js";
import { harden, upstreamUnavailable } from "../release/gateway.js";
import { notFound } from "../../core/errors.js";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import {
  classifyChannel,
  parseManualChannels,
  policyChannelOf,
  versionFromTag,
} from "../release/channels.js";
import { isResolved, type ReleaseConfigRow } from "../release/config.js";
import { serveDownload, type ResolvedDownload } from "../release/source.js";
import { NotFoundError, UpstreamRateLimitedError } from "../release/github.js";
import { RELEASE_PAGE_CAP } from "../release/github.js";
import {
  describedFilesGitHubLacks,
  flooredChannels,
} from "../release/storeRelease.js";
import {
  hiddenFor,
  loadDeliverableState,
  prereleaseOf,
  tagOf,
  type DeliverableState,
} from "../release/resolve.js";
import type { ReleaseParams } from "../release/access.js";
import type { SurfaceContext } from "../release/surface.js";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import {
  computeAppcast,
  computeVersion,
  type UpdateStep,
  type UpdateSurfaceKind,
} from "./feed.js";

// ── Classes (§6.5) ───────────────────────────────────────────────────────────────────────────

/** Every class a comparison row can carry. */
export const RESOLVER_CLASSES = [
  "identical",
  // expected: the deliberate convergence on one meaning per track
  "beta-includes-stable",
  "workflow-channel",
  "beyond-page-cap",
  "duplicate-version",
  "descriptor-channel",
  "descriptor-files",
  // expected: the two ways the legacy view's floor is not the live route's (Corrections 5, 6)
  "beta-workflow-floor",
  "beta-yanked-floor-fallback",
  // blocking
  "stale-store",
  "unexpected",
  // retry
  "upstream-error",
] as const;
export type ResolverClass = (typeof RESOLVER_CLASSES)[number];

/** The classes the lead acknowledges by count (the switch rule's condition 2). */
export const EXPECTED_CLASSES: readonly ResolverClass[] = [
  "beta-includes-stable",
  "workflow-channel",
  "beyond-page-cap",
  "duplicate-version",
  "descriptor-channel",
  "descriptor-files",
  "beta-workflow-floor",
  "beta-yanked-floor-fallback",
];
/** The classes that stop the switch (condition 1). */
export const BLOCKING_CLASSES: readonly ResolverClass[] = [
  "stale-store",
  "unexpected",
];

// ── Probes ───────────────────────────────────────────────────────────────────────────────────

/** `download` is `/release/dl` (and `?checksum=sha256`): P2-12.5. */
export type ProbeSurface = UpdateSurfaceKind | "download";

/** What a `download` probe asks for: the route's `format`, `arch` and whether it wants the sidecar. */
export interface DownloadProbe {
  format: "cli" | "dmg";
  arch: string;
  checksum: boolean;
}

export interface Probe {
  surface: ProbeSurface;
  /** A stable label for the report row: `<selector>` or `<selector>?arch=<arch>`. */
  probe: string;
  /** The selector as the request spelled it (undefined: omitted). */
  selector: string | undefined;
  params: ReleaseParams;
  /** Set on a `download` probe. */
  download?: DownloadProbe;
}

export interface ProbeSet {
  /** Selectors to probe on the channel appcast and the version check (moving ones, by name). */
  channels: readonly string[];
  /** The current stable version, probed pinned both bare and as `v<version>` on `/version`. */
  stableVersion?: string | null;
}

/** The architectures the unparameterised and the per-arch appcast answer. */
export const APPCAST_ARCHES = [undefined, "arm64", "x86_64"] as const;

/**
 * The probe list for a product (§6.5): the appcast with no `arch`, `arm64` and `x86_64`; the
 * channel appcast for every channel; `/version` on every selector (omitted included), plus the
 * current stable pinned bare and as `v`.
 */
export function buildProbes(set: ProbeSet): Probe[] {
  const out: Probe[] = [];
  for (const arch of APPCAST_ARCHES)
    out.push({
      surface: "appcast",
      probe: arch ? `stable?arch=${arch}` : "stable",
      selector: "stable",
      params: arch ? { arch } : {},
    });
  const channels = [...new Set(set.channels)].filter((c) => c !== "stable");
  for (const channel of channels)
    out.push({
      surface: "channelAppcast",
      probe: channel,
      selector: channel,
      params: { channel },
    });
  out.push({
    surface: "version",
    probe: "(omitted)",
    selector: undefined,
    params: {},
  });
  for (const selector of ["latest", "stable", ...channels])
    out.push({
      surface: "version",
      probe: selector,
      selector,
      params: { channel: selector },
    });
  if (set.stableVersion) {
    for (const pinned of [set.stableVersion, `v${set.stableVersion}`])
      out.push({
        surface: "version",
        probe: pinned,
        selector: pinned,
        params: { version: pinned },
      });
  }
  return out;
}

/** The architectures the download probes ask for. */
export const DOWNLOAD_ARCHES = ["arm64", "x86_64"] as const;

/**
 * The `/release/dl` probes (P2-12.5): `cli` and `dmg` x `arm64` and `x86_64` x plain and
 * checksum, on `latest` and every channel, plus the current stable pinned bare. Kept apart from
 * `buildProbes` so the appcast and version list is unchanged; the job runs both lists.
 */
export function buildDownloadProbes(set: ProbeSet): Probe[] {
  const out: Probe[] = [];
  const channels = [...new Set(set.channels)].filter((c) => c !== "stable");
  const selectors = [
    "latest",
    ...channels,
    ...(set.stableVersion ? [set.stableVersion] : []),
  ];
  for (const selector of selectors)
    for (const format of ["cli", "dmg"] as const)
      for (const arch of DOWNLOAD_ARCHES)
        for (const checksum of [false, true])
          out.push({
            surface: "download",
            probe: `${selector}/${format}-${arch}${checksum ? "?checksum=sha256" : ""}`,
            selector,
            params: {},
            download: { format, arch, checksum },
          });
  return out;
}

/**
 * The moving selectors worth probing for a product: `beta`, `staging`, each manual channel, each
 * channel with a recorded floor, and any `extra` (the job adds `pr-<n>` for workflow products).
 */
export async function probeChannels(
  db: Db,
  cfg: ReleaseConfigRow,
  extra: readonly string[] = [],
): Promise<string[]> {
  const floored = await flooredChannels(db, cfg.product);
  return [
    ...new Set([
      "beta",
      "staging",
      ...parseManualChannels(cfg.manual_channels_json).map((m) => m.name),
      ...floored,
      ...extra,
    ]),
  ];
}

// ── Outcomes ─────────────────────────────────────────────────────────────────────────────────

export interface ProbeOutcome {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  /** SHA-256 of the body, hex; null for no body. */
  bodySha256: string | null;
  /** The version the answer names (`/version`'s `version`, the appcast's short version). */
  version: string | null;
  /** The step threw something that is not a 404 or a quota refusal. */
  threw?: string;
}

const SHORT_VERSION = /<sparkle:shortVersionString>([^<]*)</;

/** Reduce a response to what is compared (§6.5). Consumes the body. */
export async function outcomeOf(
  surface: ProbeSurface,
  res: Response,
): Promise<ProbeOutcome> {
  const text = await res.text();
  let version: string | null = null;
  if (res.status === 200) {
    if (surface === "version") {
      try {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        version = typeof v === "string" ? v : null;
      } catch {
        version = null;
      }
    } else {
      version = SHORT_VERSION.exec(text)?.[1] ?? null;
    }
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    bodySha256:
      text.length > 0 ? await sha256Hex(new TextEncoder().encode(text)) : null,
    version,
  };
}

/** Status, `content-type`, `cache-control` and the body hash all equal. */
export function sameOutcome(a: ProbeOutcome, b: ProbeOutcome): boolean {
  return (
    a.status === b.status &&
    a.contentType === b.contentType &&
    a.cacheControl === b.cacheControl &&
    a.bodySha256 === b.bodySha256 &&
    a.threw === undefined &&
    b.threw === undefined
  );
}

/**
 * A download's outcome. The bytes of a plain download are the artifact (up to 2 GB, streamed from
 * R2 or from GitHub), so they are not read: the body is stood in for by the release, the asset's
 * name and its size, which is what makes two downloads the same file (§6.5). The checksum
 * sidecar is a few bytes and is compared as served.
 */
async function downloadOutcome(
  res: Response,
  probe: DownloadProbe,
  resolved: ResolvedDownload | null,
): Promise<ProbeOutcome> {
  const identity = res.status === 200 && !probe.checksum && resolved?.asset;
  let bodySha256: string | null = null;
  if (identity) {
    await res.body?.cancel().catch(() => undefined);
    bodySha256 = await sha256Hex(
      new TextEncoder().encode(
        `${resolved.tag}\n${resolved.asset!.name}\n${resolved.asset!.size}`,
      ),
    );
  } else {
    const text = await res.text();
    bodySha256 =
      text.length > 0 ? await sha256Hex(new TextEncoder().encode(text)) : null;
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    bodySha256,
    version: resolved ? versionFromTag(resolved.tag) : null,
  };
}

export interface StepOptions {
  artifactsAccess?: ReleaseAccess;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Run one probe through one step the way `runSurface` does around the compute (the two upstream
 * mappings, `harden`), with none of the edge cache, the rate limit or the access check.
 * Anything else a step throws is recorded on the outcome rather than propagated, so one bad
 * probe cannot end a product's run.
 */
export async function runProbe(
  step: UpdateStep,
  probe: Probe,
  ctx: Omit<SurfaceContext, "params">,
  opts: StepOptions = {},
): Promise<ProbeOutcome> {
  // The probe stands in for no caller, so the access check is not part of what is compared:
  // both modes read public here, and the (identical) refusal a gated product would answer is
  // never the question. The access modes are the one thing neither step decides.
  const full: SurfaceContext = {
    ...ctx,
    cfg: { ...ctx.cfg, metadata_access: "public" },
    params: probe.params,
  };
  let resolved: ResolvedDownload | null = null;
  try {
    if (probe.download && probe.surface === "download") {
      const dl = probe.download;
      const cfg = full.cfg;
      const res = isResolved(cfg)
        ? await serveDownload(
            {
              env: full.env,
              db: full.db,
              product: full.product,
              now: full.now,
            },
            cfg,
            {
              kind: "dl",
              selector: probe.selector,
              arch: dl.arch,
              format: dl.format,
              checksum: dl.checksum,
              access: "public",
            },
            full.req,
            full.fetchImpl,
            step,
            (r) => (resolved = r),
          )
        : harden(notFound());
      return await downloadOutcome(harden(res), dl, resolved);
    }
    const res =
      probe.surface === "version"
        ? await computeVersion(full, step)
        : await computeAppcast(
            probe.surface === "appcast"
              ? { ...probe.params, channel: "stable" }
              : probe.params,
            full,
            opts.artifactsAccess ?? "public",
            opts.waitUntil,
            step,
          );
    return await outcomeOf(probe.surface as UpdateSurfaceKind, harden(res));
  } catch (err) {
    const mapped =
      err instanceof UpstreamRateLimitedError
        ? upstreamUnavailable(err)
        : err instanceof NotFoundError
          ? notFound()
          : null;
    if (mapped)
      return probe.download
        ? downloadOutcome(harden(mapped), probe.download, resolved)
        : outcomeOf(probe.surface as UpdateSurfaceKind, harden(mapped));
    return {
      status: 0,
      contentType: null,
      cacheControl: null,
      bodySha256: null,
      version: null,
      threw: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Classification ───────────────────────────────────────────────────────────────────────────

export interface CompareRow {
  product: string;
  surface: ProbeSurface;
  probe: string;
  old: ProbeOutcome;
  new: ProbeOutcome;
  class: ResolverClass;
}

/** The first two pages' worth of releases the legacy read could see, newest first. */
const LEGACY_WINDOW = RELEASE_PAGE_CAP.live * 100;

interface Facts {
  state: DeliverableState;
  cfg: ReleaseConfigRow;
  channel: string | null;
  kind: string;
  visible: (row: DeliverableState["rows"][number]) => boolean;
}

function rowsOfVersion(f: Facts, version: string | null) {
  if (version === null) return [];
  return f.state.rows.filter((r) => {
    const tag = tagOf(r);
    return tag !== null && versionFromTag(tag) === version;
  });
}

/** The track a release holds by GitHub's flag alone. */
const githubTrack = (r: DeliverableState["rows"][number]): string =>
  prereleaseOf(r) ? "beta" : "stable";

/**
 * Why two answers differ. The checks run most specific first and the first hit wins. Pure over
 * the store: it reads the same rows both steps read, and never GitHub.
 */
export async function classifyDifference(
  db: Db,
  cfg: ReleaseConfigRow,
  probe: Probe,
  oldO: ProbeOutcome,
  newO: ProbeOutcome,
): Promise<ResolverClass> {
  if (sameOutcome(oldO, newO)) return "identical";
  // GitHub refused or failed on the legacy side: nothing to conclude, retry later.
  if (oldO.status === 503 || oldO.threw !== undefined) return "upstream-error";
  if (newO.threw !== undefined || newO.status === 503) return "unexpected";

  const state = await loadDeliverableState(
    db,
    cfg.product,
    APP_DELIVERABLE_ID,
    cfg,
    { narrow: true, view: "legacy" },
  );
  if (!state) return "stale-store";
  const hidden = hiddenFor(state, "legacy");
  const sel = classifyChannel(
    probe.selector,
    parseManualChannels(cfg.manual_channels_json),
  );
  const f: Facts = {
    state,
    cfg,
    channel: sel ? policyChannelOf(sel) : null,
    kind: sel?.kind ?? "",
    visible: (r) => !hidden.has(r.release_id),
  };
  const oldRows = rowsOfVersion(f, oldO.version);
  const newRows = rowsOfVersion(f, newO.version);

  // The legacy side answered a release the store never listed (or saw gone): the sync is behind.
  if (oldO.status === 200 && !oldRows.some(f.visible)) return "stale-store";

  // Correction 5: the live path never floors `beta` for a channel-workflow product.
  if (
    f.channel === "beta" &&
    cfg.channel_workflow &&
    oldO.status === 200 &&
    newO.status === 404 &&
    state.floors.has("beta")
  )
    return "beta-workflow-floor";

  // Correction 6: a yanked beta floor falls back by store membership (beta includes stable).
  const betaFloor = f.channel === "beta" ? state.floors.get("beta") : undefined;
  if (
    betaFloor?.releaseId &&
    state.yanked.has(betaFloor.releaseId) &&
    oldO.status === 200 &&
    newO.status === 200 &&
    oldO.version !== newO.version
  )
    return "beta-yanked-floor-fallback";

  const answered = [...oldRows, ...newRows];

  // The descriptor's `channel` wins over GitHub's flag.
  if (
    answered.some(
      (r) =>
        state.described.has(r.release_id) &&
        r.channel !== null &&
        r.channel !== githubTrack(r),
    )
  )
    return "descriptor-channel";

  // A described release's descriptor names a file GitHub does not list.
  for (const r of answered) {
    if (!state.described.has(r.release_id)) continue;
    if (await describedFilesGitHubLacks(db, cfg.product, r.release_id))
      return "descriptor-files";
  }

  // The legacy beta (and `pr-<n>`) is the channel workflow's tags, not a track.
  if (cfg.channel_workflow && (f.channel === "beta" || f.kind === "pr"))
    return "workflow-channel";

  // The legacy read stopped at three pages.
  if (newO.version !== null) {
    const ranked = state.rows
      .filter((r) => state.listed.has(r.release_id) && f.visible(r))
      .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
    const rank = ranked.findIndex((r) =>
      newRows.some((n) => n.release_id === r.release_id),
    );
    if (rank >= LEGACY_WINDOW) return "beyond-page-cap";
  }

  // Beta includes stable: the store's beta can answer a stable release the legacy beta skipped.
  if (
    f.channel === "beta" &&
    newO.status === 200 &&
    newRows.length > 0 &&
    newRows.every((r) => githubTrack(r) === "stable")
  )
    return "beta-includes-stable";

  // `v1.2.0` and `1.2.0` both exist: the legacy path preferred `v`, the store the later one.
  for (const v of [oldO.version, newO.version]) {
    if (v !== null && rowsOfVersion(f, v).filter(f.visible).length > 1)
      return "duplicate-version";
  }

  return "unexpected";
}

/** Run a probe through both steps and classify the pair: one report row (§6.5). */
export async function compareProbe(
  db: Db,
  cfg: ReleaseConfigRow,
  probe: Probe,
  ctx: Omit<SurfaceContext, "params">,
  opts: StepOptions = {},
): Promise<CompareRow> {
  const oldO = await runProbe("legacy", probe, ctx, opts);
  const newO = await runProbe("store", probe, ctx, opts);
  return {
    product: cfg.product,
    surface: probe.surface,
    probe: probe.probe,
    old: oldO,
    new: newO,
    class: await classifyDifference(db, cfg, probe, oldO, newO),
  };
}
