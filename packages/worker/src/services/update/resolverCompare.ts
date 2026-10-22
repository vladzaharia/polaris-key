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
 * `resolverCompareJob` (P2-12.7, below) wraps `compareProbe` in a report-only P0-49 job with
 * pacing. Nothing is routed: the probe runs `computeVersion` / `computeAppcast` directly, on a synthetic request, so
 * it bypasses the edge cache, the access check and the rate limit. The legacy step keeps its
 * resolution cache (`ghCache`), so a probe costs what serving costs.
 *
 * Classification is a pure reading of the store and the two answers. A class that is expected
 * names a deliberate convergence on one meaning per track (D6, D5); `stale-store` and
 * `unexpected` block the switch; `upstream-error` is retried.
 */

import { sha256Hex } from "../../platform/hash.js";
import type { Env } from "../../platform/env.js";
import { pk as kvKey } from "../../platform/kv.js";
import type {
  MigrationContext,
  MigrationJob,
  UnitPlan,
} from "../../core/migrate/job.js";
import { loadProduct } from "../../core/products.js";
import { listAllProductSlugs } from "../../core/products/store.js";
import type { FetchImpl } from "../release/githubApp.js";
import { meterUpstreamCalls } from "../release/gateway.js";
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
import {
  getReleaseConfig,
  isResolved,
  type ReleaseConfigRow,
} from "../release/config.js";
import { serveDownload, type ResolvedDownload } from "../release/source.js";
import { NotFoundError, UpstreamRateLimitedError } from "../release/github.js";
import { RELEASE_PAGE_CAP } from "../release/github.js";
import {
  describedFilesGitHubLacks,
  flooredChannels,
  resolveStoreSelector,
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

  // The same difference when the entitlement check refuses what the store's beta resolved: the
  // legacy beta has no prerelease (404), the store's beta resolves the stable release (D6), and
  // the grant refuses it (401 without a token, 403 for a capped grant). Only a refusal of the
  // stable release counts; the refusal body names no version, so the store is asked.
  if (
    f.channel === "beta" &&
    oldO.status === 404 &&
    (newO.status === 401 || newO.status === 403) &&
    (await storeResolvesStable(db, cfg, probe.selector))
  )
    return "beta-includes-stable";

  // `v1.2.0` and `1.2.0` both exist: the legacy path preferred `v`, the store the later one.
  for (const v of [oldO.version, newO.version]) {
    if (v !== null && rowsOfVersion(f, v).filter(f.visible).length > 1)
      return "duplicate-version";
  }

  return "unexpected";
}

/** True when the store's step resolves `selector` to a stable (non-prerelease) release. */
async function storeResolvesStable(
  db: Db,
  cfg: ReleaseConfigRow,
  selector: string | undefined,
): Promise<boolean> {
  try {
    const { release } = await resolveStoreSelector(db, cfg, selector);
    return !release.prerelease;
  } catch {
    return false;
  }
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

// ── The job (P2-12.7, plans/P2-12.md §6.5) ───────────────────────────────────────────────────

/** Rows kept in a unit's report detail, worst first; the class counts always cover every row. */
export const COMPARE_ROW_CAP = 50;
/** Pause when GitHub says fewer calls than this are left in the installation's hour. */
export const COMPARE_MIN_REMAINING = 500;
/** Probes between checkpoint writes (KV allows one write a second per key). */
const CHECKPOINT_EVERY = 10;
/** A checkpoint is resumable for this long (seconds); a dry run later than that starts over. */
const CHECKPOINT_TTL = 3600;
/** The longest and the default pause (seconds). */
const PAUSE_MAX = 3600;
const PAUSE_DEFAULT = 900;

/** The synthetic origin of the probes' requests; both steps see the same one. */
const COMPARE_ORIGIN = "https://key.plrs.im";

/** Where the switch rule lives: what `delegatedTo` names (L-P1, L-U5). */
export const RESOLVER_SWITCH_RULE =
  "the P2-12 switch rule (plans/P2-12.md §6.5): flip RESOLVE_FROM_STORE in release N+1 once a fresh dry run of this job holds no stale-store or unexpected row and the lead has acknowledged the expected classes by count";

/** A compact outcome for a report row: the hash is cut to what a person can compare. */
function compact(o: ProbeOutcome) {
  return {
    status: o.status,
    contentType: o.contentType,
    cacheControl: o.cacheControl,
    bodySha256: o.bodySha256 === null ? null : o.bodySha256.slice(0, 12),
    version: o.version,
    ...(o.threw !== undefined ? { threw: o.threw } : {}),
  };
}

const SEVERITY: Record<ResolverClass, number> = {
  unexpected: 0,
  "stale-store": 1,
  "upstream-error": 2,
  identical: 99,
  "beta-includes-stable": 10,
  "workflow-channel": 11,
  "beyond-page-cap": 12,
  "duplicate-version": 13,
  "descriptor-channel": 14,
  "descriptor-files": 15,
  "beta-workflow-floor": 16,
  "beta-yanked-floor-fallback": 17,
};

/** Class counts and the worst rows, capped: the unit's report detail. */
export function reportDetail(rows: readonly CompareRow[]) {
  const counts: Partial<Record<ResolverClass, number>> = {};
  for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
  const different = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.class !== "identical")
    .sort((a, b) => SEVERITY[a.r.class] - SEVERITY[b.r.class] || a.i - b.i);
  return {
    counts,
    rows: different.slice(0, COMPARE_ROW_CAP).map(({ r }) => ({
      surface: r.surface,
      probe: r.probe,
      old: compact(r.old),
      new: compact(r.new),
      class: r.class,
    })),
    truncated: Math.max(0, different.length - COMPARE_ROW_CAP),
  };
}

interface Checkpoint {
  /** The probe list the rows belong to: a different list starts over. */
  signature: string;
  rows: CompareRow[];
}

interface Pause {
  reason: string;
  /** GitHub refused a call (403, 429): the probe it hit proves nothing and runs again. */
  refused?: boolean;
  /** Epoch seconds after which the run may continue. */
  until: number;
}

const pauseKey = (scope: string) => kvKey(scope, "resolver-compare", "pause");
const cursorKey = (product: string) =>
  kvKey(product, "resolver-compare", "cursor");

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  try {
    const raw = await env.HOT.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(
  env: Env,
  key: string,
  value: unknown,
  ttl: number,
): Promise<void> {
  try {
    await env.HOT.put(key, JSON.stringify(value), {
      expirationTtl: Math.max(60, Math.ceil(ttl)),
    });
  } catch {
    /* a lost checkpoint only costs a re-run of its probes */
  }
}

/**
 * The environment a product's run sees: a KV whose resolution cache (`ghCache`) is private to the
 * run, so the legacy step resolves against GitHub as it is now, and not against a 90-s entry an
 * unrelated request left (yank, pin and promote do not drop the legacy step's entries in every
 * colo). It still costs what serving costs inside the run. Everything else, the Sparkle memo
 * included, passes through to the real KV: a DMG streams at most once, shared by both steps.
 */
function freshResolutionCache(env: Env): Env {
  const real = env.HOT;
  const mem = new Map<string, string>();
  const own = (key: string) => key.includes(":release-resolution:");
  const hot = {
    get: (key: string, ...rest: unknown[]) =>
      own(key)
        ? Promise.resolve(mem.get(key) ?? null)
        : (real.get as (...a: unknown[]) => unknown)(key, ...rest),
    put: (key: string, value: string, ...rest: unknown[]) => {
      if (own(key)) {
        mem.set(key, value);
        return Promise.resolve();
      }
      return (real.put as (...a: unknown[]) => unknown)(key, value, ...rest);
    },
    delete: (key: string) =>
      own(key) ? Promise.resolve(void mem.delete(key)) : real.delete(key),
  } as unknown as KVNamespace;
  return { ...env, HOT: hot } as Env;
}

/** What GitHub's headers said about the installation's quota. */
interface Quota {
  pause: Pause | null;
}

/** Observe, never alter, every GitHub answer: a 403 or 429, or a low `x-ratelimit-remaining`. */
function observing(base: FetchImpl, quota: Quota, now: number): FetchImpl {
  return async (input, init) => {
    const res = await base(input, init);
    const remaining = res.headers.get("x-ratelimit-remaining");
    const status = res.status;
    let reason: string | null = null;
    if (status === 403 || status === 429) reason = `github ${status}`;
    else if (
      remaining !== null &&
      remaining !== "" &&
      Number(remaining) < COMPARE_MIN_REMAINING
    )
      reason = `github x-ratelimit-remaining ${remaining}`;
    if (reason !== null) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const retry = Number(res.headers.get("retry-after"));
      const wait =
        Number.isFinite(retry) && res.headers.get("retry-after") !== null
          ? retry
          : Number.isFinite(reset) && reset > now
            ? reset - now
            : PAUSE_DEFAULT;
      quota.pause = {
        reason,
        ...(status === 403 || status === 429 ? { refused: true } : {}),
        until: now + Math.min(PAUSE_MAX, Math.max(60, Math.ceil(wait))),
      };
    }
    return res;
  };
}

export interface CompareJobOptions {
  /** The GitHub fetch; default the runtime's. */
  fetchImpl?: FetchImpl;
  /** Called after each probe of a unit (`index` counts from 0); the tests kill a run here. */
  onProbe?: (product: string, index: number) => void | Promise<void>;
}

/** Every probe a product is compared on (appcast, channel appcast, version, download). */
async function probesFor(
  ctx: MigrationContext,
  cfg: ReleaseConfigRow,
): Promise<Probe[]> {
  const channels = await probeChannels(ctx.db, cfg);
  let stableVersion: string | null = null;
  try {
    const { release } = await resolveStoreSelector(ctx.db, cfg, "stable");
    stableVersion = versionFromTag(release.tag_name);
  } catch {
    /* nothing stable: no pinned probe */
  }
  const set = { channels, stableVersion };
  return [...buildProbes(set), ...buildDownloadProbes(set)];
}

const signatureOf = (probes: readonly Probe[]) =>
  probes.map((p) => `${p.surface}|${p.probe}`).join("\n");

/**
 * `update.resolver-compare` (P2-12.7): the dry run that proves the two update steps equal. REPORT
 * ONLY: it reads and writes nothing in D1; the only thing it stores is KV (a checkpoint and a
 * pause marker, both expiring). A unit is a product with a resolved release config, run one at a
 * time. A unit's report is its class counts plus the worst rows (`reportDetail`); its `changes`
 * is what blocks the switch: the `unexpected` and `stale-store` rows, the `upstream-error` rows
 * and the probes a pause left unrun. The expected classes are acknowledged by count, not here.
 *
 * Pacing. After a probe that saw GitHub answer 403 or 429, or `x-ratelimit-remaining` under 500,
 * the run stops for the whole installation (a pause marker in KV until GitHub's reset), and the
 * rest of the report says `paused`. An `UpstreamRateLimitedError` (the product's own budget, or
 * GitHub's quota as the step mapped it) is an `upstream-error` row and pauses that product. A
 * checkpoint holds the rows done, so the next dry run, after a pause or a killed call, resumes
 * where this one stopped. `apply` and `down` are `delegated`.
 */
export function createResolverCompareJob(
  opts: CompareJobOptions = {},
): MigrationJob {
  const upstream: FetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  return {
    id: "update.resolver-compare",
    summary:
      "Compare the legacy (GitHub) and store update steps on every probe, per product (report only)",
    delegatedTo: RESOLVER_SWITCH_RULE,
    async units({ db }) {
      const out: string[] = [];
      for (const slug of await listAllProductSlugs(db)) {
        const cfg = await getReleaseConfig(db, slug);
        if (cfg && isResolved(cfg)) out.push(slug);
      }
      return out;
    },
    async plan(ctx, unit): Promise<UnitPlan> {
      const cfg = await getReleaseConfig(ctx.db, unit);
      const product = cfg ? await loadProduct(ctx.env, ctx.db, unit) : null;
      if (!cfg || !product)
        return { changes: 0, detail: { skipped: "no release config" } };
      const probes = await probesFor(ctx, cfg);
      const signature = signatureOf(probes);
      const saved = await readJson<Checkpoint>(ctx.env, cursorKey(unit));
      const rows: CompareRow[] =
        saved &&
        saved.signature === signature &&
        saved.rows.length <= probes.length
          ? [...saved.rows]
          : [];
      const resumedFrom = rows.length;

      const quota: Quota = { pause: null };
      const standing =
        (await readJson<Pause>(ctx.env, pauseKey("platform"))) ??
        (await readJson<Pause>(ctx.env, pauseKey(unit)));
      let pause: Pause | null =
        standing && standing.until > ctx.now ? standing : null;

      const env = freshResolutionCache(ctx.env);
      const fetchImpl = meterUpstreamCalls(
        ctx.env,
        unit,
        ctx.now,
        observing(upstream, quota, ctx.now),
      );
      const probeCtx = {
        req: new Request(`${COMPARE_ORIGIN}/${unit}/update/version`),
        env,
        db: ctx.db,
        product,
        cfg,
        origin: COMPARE_ORIGIN,
        now: ctx.now,
        fetchImpl,
      };

      const checkpoint = (): Promise<void> => {
        // An upstream-error row is not a result: it runs again on resume.
        const bad = rows.findIndex((r) => r.class === "upstream-error");
        return writeJson(
          ctx.env,
          cursorKey(unit),
          {
            signature,
            rows: bad === -1 ? rows : rows.slice(0, bad),
          } satisfies Checkpoint,
          CHECKPOINT_TTL,
        );
      };

      for (let i = rows.length; i < probes.length && !pause; i++) {
        const probe = probes[i]!;
        const row = await compareProbe(ctx.db, cfg, probe, probeCtx);
        if (quota.pause) {
          pause = quota.pause;
          // A call GitHub refused leaves a row that proves nothing, unless it already reads as
          // the upstream error it is: the probe runs again on resume.
          if (!pause.refused || row.class === "upstream-error") rows.push(row);
          await writeJson(
            ctx.env,
            pauseKey("platform"),
            pause,
            pause.until - ctx.now,
          );
        } else if (row.class === "upstream-error" && row.old.status === 503) {
          rows.push(row);
          // The product's own budget, or a quota the step mapped to a 503.
          pause = {
            reason: "upstream rate limited",
            until: ctx.now + PAUSE_DEFAULT,
          };
          await writeJson(ctx.env, pauseKey(unit), pause, PAUSE_DEFAULT);
        } else rows.push(row);
        if (pause || (i + 1) % CHECKPOINT_EVERY === 0) await checkpoint();
        await opts.onProbe?.(unit, i);
      }

      const finished = rows.length === probes.length && !pause;
      if (finished)
        await ctx.env.HOT.delete(cursorKey(unit)).catch(() => undefined);
      const detail = reportDetail(rows);
      const unrun = probes.length - rows.length;
      const blocking = rows.filter(
        (r) =>
          BLOCKING_CLASSES.includes(r.class) || r.class === "upstream-error",
      ).length;
      return {
        changes: blocking + unrun,
        detail: {
          probes: probes.length,
          compared: rows.length,
          resumedFrom,
          ...detail,
          ...(pause || unrun > 0
            ? {
                paused: {
                  reason: pause?.reason ?? "incomplete",
                  until: pause?.until ?? null,
                  unrun,
                },
              }
            : {}),
        },
      };
    },
    apply: () => Promise.reject(new Error("delegated")),
    down: () => Promise.reject(new Error("delegated")),
  };
}

/** The registered job: the runtime's GitHub fetch. */
export const resolverCompareJob = createResolverCompareJob();
