/// <reference types="@cloudflare/workers-types" />

/**
 * The channel feed composer (P3-03, plans/P3-01.md §6; WIRE-CONTRACT-V4 §2.3).
 *
 * Deterministic: the same store gives the same content, so the content's SHA-256 is what decides
 * whether the feed's `seq` moves (`feed.ts`). Nothing device-specific is read — no device, no
 * licence, no bucket — so every caller of a channel gets identical bytes and rollout is
 * evaluated on the client (`rolloutBucket`).
 *
 * Boundaries: Release is read directly (the one sanctioned edge, `update → release`);
 * Distribution only through Core's hooks (`delivery`, `outletCapabilities`). Without the
 * `delivery` hook every target's `outlets` is empty, so nothing is offered: fail closed.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────────────────────
 *
 *   scheme     `app.versionScheme` is the app deliverable's `versioning.scheme`.
 *   targets    in `RELEASE_PLATFORMS` order: the channel's resolved release for each platform
 *              (P2-05's per-platform resolution), when it has a stored record of `kind: app`
 *              whose `seq` and version are the release's. A version that does not parse under
 *              the scheme leaves the target out rather than failing the channel.
 *   critical   the policy's `critical`, when the target is the channel's pointer release.
 *   floor      the highest, by `compareVersions`, of the policy's `min_supported` and — when the
 *              target's record carries `minSupportedSeq = N` — the version of the deliverable's
 *              release with the smallest `seq` from N to the target's that has a build for the
 *              platform (none: the target's own version). Clipped to the target's version, so no
 *              floor asks for more than the platform is offered; null with no input.
 *   outlets    keyed by outlet id, with `kind`: one per live outlet whose kind serves the
 *              platform (`OUTLET_PLATFORMS`, narrowed by `direct.platforms`):
 *                live     the newest release, at or below the target's `seq`, that `availability`
 *                         reports `live` on the outlet for this platform (per release, or for a
 *                         build of this platform); self-hosted outlets are derived live;
 *                halted, rollout   from `delivery.rollout`, when its release is the target's;
 *                listingUrl        composed from the outlet's identity, kept only when it passes
 *                                  §2.3's prefix and character rule;
 *                capabilities      the effective capabilities, only when an operator narrowed.
 *
 * `composeOutletView` is the per-outlet view on its own, for P3-09's updater feeds.
 *
 * P4-13 adds the content members (`packParts.ts`: `packSets`, `packFloors`, `revocations`), composed
 * only for a channel that offers a target; `feedDoc.ts` fits them under the payload cap.
 */

import { APP_DELIVERABLE_ID, RELEASE_PLATFORMS } from "@polaris-key/manifest";
import {
  LISTING_URL_PREFIXES,
  OUTLET_PLATFORMS,
} from "@polaris-key/protocol/distribution";
import type {
  FeedOutletEntry,
  FeedTarget,
  FeedVersionScheme,
} from "@polaris-key/protocol/update";
import {
  compareVersions,
  parseVersion,
} from "@polaris-key/client-core/version";
import { base64UrlDecode } from "@polaris-key/jws";
import type { Db } from "../../core/platform.js";
import type {
  AvailabilityRecord,
  DeliveryOutlet,
  ServiceHooks,
} from "../../core/hooks.js";
import { classifyChannel, parseManualChannels } from "../release/channels.js";
import type { ReleaseConfigRow } from "../release/config.js";
import {
  loadDeliverableState,
  resolveInState,
  type DeliverableState,
} from "../release/resolve.js";
import { recordsByRelease, type ReleaseRecordRow } from "../release/records.js";
import {
  composePackParts,
  NO_PACK_PARTS,
  type ComposedPackParts,
} from "./packParts.js";

export {
  composePackParts,
  effectivePackBindings,
  type ComposedPackParts,
} from "./packParts.js";

/** How far below the target `live` looks for an outlet's newest live release. */
export const LIVE_LOOKBACK_RELEASES = 16;
const MAX_LISTING_URL_BYTES = 2048;

/** The canonical channel a requested name stands for (V3 §5.1 rule 6), or null. */
export function canonicalFeedChannel(
  requested: string,
  cfg: Pick<ReleaseConfigRow, "manual_channels_json">,
): string | null {
  const sel = classifyChannel(
    requested,
    parseManualChannels(cfg.manual_channels_json),
  );
  if (!sel) return null;
  // A pinned `X.Y.Z` names a release, not a channel.
  if (sel.kind === "stable" && sel.raw !== "latest" && sel.raw !== "stable")
    return null;
  if (sel.kind === "stable") return "stable";
  if (sel.kind === "beta") return "beta";
  return sel.raw;
}

/** What the composer produced for one canonical channel: every platform's target, and the
 *  content members (P4-13, `packParts.ts`), before any size shedding. */
export interface ComposedFeed {
  channel: string;
  versionScheme: FeedVersionScheme;
  targets: FeedTarget[];
  content: ComposedPackParts;
}

export interface ComposeContext {
  db: Db;
  product: string;
  hooks: ServiceHooks;
  cfg: ReleaseConfigRow;
}

/** The `minSupportedSeq` a stored record carries, read from its verified-at-ingest payload. */
function minSupportedSeqOf(row: ReleaseRecordRow): number | null {
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(row.jws.split(".")[1] ?? "")),
    ) as { minSupportedSeq?: unknown };
    return typeof payload.minSupportedSeq === "number" &&
      Number.isSafeInteger(payload.minSupportedSeq) &&
      payload.minSupportedSeq >= 1
      ? payload.minSupportedSeq
      : null;
  } catch {
    return null;
  }
}

function hasBuildFor(
  state: DeliverableState,
  releaseId: string,
  platform: string,
): boolean {
  return (state.buildsByRelease.get(releaseId) ?? []).some(
    (b) => b.platform === platform,
  );
}

/** §6's per-target floor, or null. */
function floorFor(
  state: DeliverableState,
  scheme: FeedVersionScheme,
  platform: string,
  target: { version: string; seq: number },
  minSupported: string | null,
  record: ReleaseRecordRow,
): { minVersion: string } | null {
  const inputs: string[] = [];
  if (minSupported !== null && parseVersion(scheme, minSupported) !== null)
    inputs.push(minSupported);
  const n = minSupportedSeqOf(record);
  if (n !== null) {
    const floorRelease = state.rows
      .filter(
        (r) =>
          r.seq !== null &&
          r.seq >= n &&
          r.seq <= target.seq &&
          hasBuildFor(state, r.release_id, platform),
      )
      .sort((a, b) => (a.seq as number) - (b.seq as number))[0];
    const v = floorRelease ? floorRelease.version : target.version;
    if (parseVersion(scheme, v) !== null) inputs.push(v);
  }
  if (inputs.length === 0) return null;
  let best = inputs[0] as string;
  for (const v of inputs.slice(1))
    if ((compareVersions(scheme, v, best) ?? 0) > 0) best = v;
  if ((compareVersions(scheme, best, target.version) ?? 1) > 0)
    best = target.version;
  return { minVersion: best };
}

/** The platforms an outlet serves: its kind's, narrowed by `direct.platforms` when declared. */
export function outletPlatforms(o: DeliveryOutlet): readonly string[] {
  const byKind =
    (OUTLET_PLATFORMS as Record<string, readonly string[]>)[o.kind] ?? [];
  const declared = o.identity.platforms;
  if (o.kind === "direct" && Array.isArray(declared))
    return byKind.filter((p) => declared.includes(p));
  return byKind;
}

function isListingSafe(url: string, kind: string): boolean {
  if (url.length < 1 || url.length > MAX_LISTING_URL_BYTES) return false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return (LISTING_URL_PREFIXES[kind] ?? []).some((p) => url.startsWith(p));
}

/** The store listing URL an outlet's identity composes to (P2b-02's identities), or null. */
export function listingUrlFor(o: DeliveryOutlet): string | null {
  const id = o.identity;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v !== "" ? v : null;
  let url: string | null = null;
  switch (o.kind) {
    case "app-store":
      url = str(id.appleId)
        ? `https://apps.apple.com/app/id${str(id.appleId)}`
        : null;
      break;
    case "testflight":
      url = str(id.publicLink)
        ? `https://testflight.apple.com/join/${str(id.publicLink)}`
        : null;
      break;
    case "play":
      url = str(id.packageName)
        ? `https://play.google.com/store/apps/details?id=${str(id.packageName)}`
        : null;
      break;
    case "play-testing":
      url = str(id.packageName)
        ? `https://play.google.com/apps/testing/${str(id.packageName)}`
        : null;
      break;
    case "ms-store":
      url = str(id.productId)
        ? `https://apps.microsoft.com/detail/${str(id.productId)}`
        : null;
      break;
  }
  return url !== null && isListingSafe(url, o.kind) ? url : null;
}

/**
 * Memoised per composition: availability per release, rollout per outlet, capabilities per
 * outlet. One composition reads each at most once.
 */
interface OutletReads {
  availability(releaseId: string): Promise<AvailabilityRecord[]>;
  rollout(
    outletId: string,
  ): ReturnType<NonNullable<ReturnType<ServiceHooks["delivery"]>>["rollout"]>;
  capabilities(
    outletId: string,
  ): ReturnType<ServiceHooks["outletCapabilities"]>;
}

function outletReads(
  hooks: ServiceHooks,
  channel: string,
  deliverable: string,
): OutletReads {
  const delivery = hooks.delivery();
  const avail = new Map<string, Promise<AvailabilityRecord[]>>();
  const rollouts = new Map<
    string,
    ReturnType<NonNullable<typeof delivery>["rollout"]>
  >();
  const caps = new Map<
    string,
    ReturnType<ServiceHooks["outletCapabilities"]>
  >();
  return {
    availability(releaseId) {
      let p = avail.get(releaseId);
      if (!p) {
        p = delivery ? delivery.availability(releaseId) : Promise.resolve([]);
        avail.set(releaseId, p);
      }
      return p;
    },
    rollout(outletId) {
      let p = rollouts.get(outletId);
      if (!p) {
        p = delivery
          ? delivery.rollout({ deliverable, outlet: outletId, channel })
          : Promise.resolve(null);
        rollouts.set(outletId, p);
      }
      return p;
    },
    capabilities(outletId) {
      let p = caps.get(outletId);
      if (!p) {
        p = hooks.outletCapabilities(outletId);
        caps.set(outletId, p);
      }
      return p;
    },
  };
}

/**
 * One outlet's entry for one target: the per-outlet view (target release, rollout, halt,
 * availability, listing, narrowed capabilities). Exported for P3-09's renderers.
 */
export async function composeOutletView(
  state: DeliverableState,
  scheme: FeedVersionScheme,
  platform: string,
  target: { releaseId: string; seq: number },
  outlet: DeliveryOutlet,
  reads: OutletReads,
): Promise<FeedOutletEntry> {
  // live: the newest release at or below the target that the outlet has live for this platform.
  let live: FeedOutletEntry["live"] = null;
  const lookback = state.rows
    .filter((r) => r.seq !== null && r.seq <= target.seq)
    .sort((a, b) => (b.seq as number) - (a.seq as number))
    .slice(0, LIVE_LOOKBACK_RELEASES);
  for (const r of lookback) {
    const builds = state.buildsByRelease.get(r.release_id) ?? [];
    const records = await reads.availability(r.release_id);
    const isLive = records.some(
      (a) =>
        a.outletId === outlet.outletId &&
        a.state === "live" &&
        (a.buildId === ""
          ? builds.some((b) => b.platform === platform)
          : builds.some(
              (b) => b.build_id === a.buildId && b.platform === platform,
            )),
    );
    if (!isLive) continue;
    live =
      parseVersion(scheme, r.version) !== null
        ? { version: r.version, seq: r.seq as number }
        : null;
    break;
  }

  const entry: FeedOutletEntry = { kind: outlet.kind, live, halted: false };
  const rollout = await reads.rollout(outlet.outletId);
  if (rollout && rollout.releaseId === target.releaseId) {
    entry.halted = rollout.state === "halted";
    if (
      !rollout.mirrored &&
      (rollout.state === "active" || rollout.state === "paused") &&
      Number.isSafeInteger(rollout.rolloutBp) &&
      rollout.rolloutBp >= 0 &&
      rollout.rolloutBp <= 10000 &&
      /^[0-9a-f]{32}$/.test(rollout.rolloutSalt)
    )
      entry.rollout = { bp: rollout.rolloutBp, salt: rollout.rolloutSalt };
  }
  const listingUrl = listingUrlFor(outlet);
  if (listingUrl !== null) entry.listingUrl = listingUrl;
  if (outlet.narrowed) {
    const caps = await reads.capabilities(outlet.outletId);
    if (caps) {
      const { outletId: _id, ...rest } = caps;
      entry.capabilities = rest;
    }
  }
  return entry;
}

/**
 * Compose one canonical channel's feed content. `null` when the requested name is no channel
 * (the route's not-found).
 */
export async function composeChannelFeed(
  ctx: ComposeContext,
  requested: string,
): Promise<ComposedFeed | null> {
  const channel = canonicalFeedChannel(requested, ctx.cfg);
  if (channel === null) return null;
  const state = await loadDeliverableState(
    ctx.db,
    ctx.product,
    APP_DELIVERABLE_ID,
    ctx.cfg,
  );
  const scheme: FeedVersionScheme = state?.scheme ?? "semver";
  if (!state)
    return {
      channel,
      versionScheme: scheme,
      targets: [],
      content: NO_PACK_PARTS,
    };

  const records = await recordsByRelease(
    ctx.db,
    ctx.product,
    APP_DELIVERABLE_ID,
  );
  const policy = state.policyRows.get(channel) ?? null;
  const delivery = ctx.hooks.delivery();
  const outlets = delivery ? await delivery.outlets() : [];
  const reads = outletReads(ctx.hooks, channel, APP_DELIVERABLE_ID);

  const targets: FeedTarget[] = [];
  for (const platform of RELEASE_PLATFORMS) {
    const res = resolveInState(state, { selector: channel, platform });
    if (!res) continue;
    const release = res.release;
    const record = records.get(release.release_id);
    if (
      !record ||
      record.kind !== "app" ||
      release.seq === null ||
      record.seq !== release.seq ||
      parseVersion(scheme, release.version) === null
    )
      continue;
    const pin = {
      sha256: record.record_sha256,
      seq: record.seq,
      version: release.version,
    };
    const outletEntries: Record<string, FeedOutletEntry> = {};
    for (const o of outlets) {
      if (!outletPlatforms(o).includes(platform)) continue;
      outletEntries[o.outletId] = await composeOutletView(
        state,
        scheme,
        platform,
        { releaseId: release.release_id, seq: release.seq },
        o,
        reads,
      );
    }
    targets.push({
      platform,
      release: pin,
      floor: floorFor(
        state,
        scheme,
        platform,
        pin,
        policy?.min_supported ?? null,
        record,
      ),
      critical:
        policy !== null &&
        policy.critical === 1 &&
        policy.pointer_release_id === release.release_id,
      outlets: outletEntries,
    });
  }
  const content =
    targets.length > 0 ? await composePackParts(ctx, channel) : NO_PACK_PARTS;
  return { channel, versionScheme: scheme, targets, content };
}
