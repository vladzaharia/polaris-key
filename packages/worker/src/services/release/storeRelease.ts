/**
 * The truth store, in GitHub's shape (P2-12.3, plans/P2-12.md D3 and §6.2).
 *
 * The legacy compute steps (appcast, version check, download) take a GitHub `Release`. This
 * module builds that same object from the rows the sync wrote, "as GitHub last listed it", so
 * the compute steps keep their logic and the bytes match given the same input. Nothing here is
 * routed in PR 1; PR 2 points the surfaces at `resolveStoreSelector`.
 *
 * Which `release_artifacts` rows a release offers (D3):
 *
 *   - an undescribed release: only the rows named in `metadata_json.listedAssets`, because
 *     nothing deletes artifact rows (a clobbered or deleted asset leaves a stale row that would
 *     tie `matchAsset` and mislead the `.sig` and `.sha256` lookups);
 *   - a described release: the descriptor's rows (those with a `build_id`) plus those;
 *   - a release the sync has not listed since `listedAssets` was introduced (it has no such
 *     member, only possible beyond the 1,000-release read) offers all of its rows.
 *
 * A row whose `artifact_id` is not a GitHub asset id (a descriptor file held elsewhere is
 * `file:<name>`) cannot be a GitHub asset and is not offered here; the byte routes serve it
 * from the descriptor's own locations.
 */

import type { Db } from "../../db/types.js";
import {
  type ChannelSelector,
  classifyChannel,
  parseManualChannels,
  policyChannelOf,
} from "./channels.js";
import type { ReleaseConfigRow } from "./config.js";
import { NotFoundError, type Release, type ReleaseAsset } from "./github.js";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import {
  hiddenFor,
  loadDeliverableState,
  resolveInState,
  tagOf,
} from "./resolve.js";
import type { ReleaseArtifactRow, ReleaseMetadataRow } from "./store.js";

/** GitHub's asset digest as the store keeps it, lower-case (SR-P1 N5). */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

interface StoredMeta {
  tag?: unknown;
  prerelease?: unknown;
  listedAssets?: unknown;
}

function parseMeta(json: string | null): StoredMeta {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as StoredMeta) : {};
  } catch {
    return {};
  }
}

/**
 * `{asset id: GitHub digest | null}` as the sync recorded it, or null when the row has none (a
 * release not listed since PR 1). A malformed member reads as none, never as an empty set.
 */
function listedAssetsOf(meta: StoredMeta): Map<string, string | null> | null {
  const raw = meta.listedAssets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = new Map<string, string | null>();
  for (const [id, digest] of Object.entries(raw as Record<string, unknown>))
    out.set(id, typeof digest === "string" ? digest : null);
  return out;
}

/**
 * The digest to offer for a stored GitHub digest: the value only when it has the exact shape
 * `sha256:<64 lower-case hex>` (upper-case hex is folded first, as `assetSha256` does), else
 * absent. The digest is a blob lookup key downstream; a malformed one must not become one.
 */
export function checkedDigest(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const folded = raw.toLowerCase();
  return DIGEST_RE.test(folded) ? folded : null;
}

/** GitHub's `published_at` spelling (`2026-01-02T03:04:05Z`, no milliseconds). */
function isoSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
}

function assetOf(
  row: ReleaseArtifactRow,
  listed: Map<string, string | null> | null,
): ReleaseAsset | null {
  if (!/^\d+$/.test(row.artifact_id)) return null;
  const fromGitHub = checkedDigest(listed?.get(row.artifact_id));
  const fromRow = row.sha256 ? checkedDigest(`sha256:${row.sha256}`) : null;
  const digest = fromGitHub ?? fromRow;
  return {
    id: Number(row.artifact_id),
    name: row.name,
    size: row.size_bytes ?? 0,
    content_type: row.content_type ?? "application/octet-stream",
    browser_download_url: row.source_url ?? "",
    // Absent, like GitHub's own older responses, rather than an explicit null.
    ...(digest !== null ? { digest } : {}),
  };
}

/**
 * The `Release` the legacy compute steps take, built from the store row `releaseId` (read by
 * key: the whole row and its artifacts, never a narrow resolution row). Null when the row is
 * missing, is not a GitHub release (a tagless `<deliverable>@<version>` id, or no recorded
 * `tag`): such a row is never offered in GitHub's shape.
 */
export async function storeRelease(
  db: Db,
  product: string,
  releaseId: string,
): Promise<Release | null> {
  const row = await db.first<ReleaseMetadataRow>(
    "SELECT * FROM release_metadata WHERE product = ? AND release_id = ? AND deliverable_id = ?",
    product,
    releaseId,
    APP_DELIVERABLE_ID,
  );
  if (!row || tagOf(row) === null) return null;
  const meta = parseMeta(row.metadata_json);
  if (typeof meta.tag !== "string" || meta.tag === "") return null;

  const listed = listedAssetsOf(meta);
  const artifacts = await db.all<ReleaseArtifactRow>(
    "SELECT * FROM release_artifacts WHERE product = ? AND release_id = ?",
    product,
    releaseId,
  );
  const assets = artifacts
    .filter(
      (a) =>
        listed === null || listed.has(a.artifact_id) || a.build_id !== null,
    )
    .map((a) => assetOf(a, listed))
    .filter((a): a is ReleaseAsset => a !== null)
    // GitHub lists a release's assets by id; the row order is no order at all.
    .sort((a, b) => a.id - b.id);

  return {
    tag_name: row.release_id,
    name: row.title,
    body: row.notes,
    published_at:
      row.published_at === null ? null : isoSeconds(row.published_at),
    html_url: row.source_url ?? "",
    prerelease: meta.prerelease === true,
    draft: false,
    assets,
  };
}

/**
 * `resolveSelector` (`gateway.ts`) from the store, in the legacy view (plan §6.2): the same
 * classification, the same canonical policy channel, and `resolveInState` for the pick. The
 * narrow state read stays inside this function, so a narrow row is never handed on: the picked
 * row is read whole by key in `storeRelease()`. Throws `NotFoundError` where the GitHub path
 * does (an unknown selector, nothing resolving, a regressed floor).
 */
export async function resolveStoreSelector(
  db: Db,
  cfg: ReleaseConfigRow,
  raw: string | undefined,
): Promise<{ release: Release; sel: ChannelSelector }> {
  const sel = classifyChannel(
    raw,
    parseManualChannels(cfg.manual_channels_json),
  );
  if (!sel) throw new NotFoundError(`unknown selector: ${raw}`);
  // A moving selector resolves by its canonical channel; a pinned version names itself.
  const selector = policyChannelOf(sel) ?? sel.raw;
  const state = await loadDeliverableState(
    db,
    cfg.product,
    APP_DELIVERABLE_ID,
    cfg,
    { narrow: true, view: "legacy" },
  );
  const picked = state
    ? resolveInState(state, { selector, view: "legacy" })
    : null;
  const release = picked
    ? await storeRelease(db, cfg.product, picked.release.release_id)
    : null;
  if (!release) throw new NotFoundError(`no release for selector: ${raw}`);
  return { release, sel };
}

/**
 * What the store answers for a MOVING selector, and whether its channel regressed (P2-12.5, the
 * health check's store variant). `regressed` is the legacy meaning: the best release the channel
 * has sits below its floor and the floor's release is gone, so the channel answers nothing.
 * `offered` is that best release (the pick without the floor). No GitHub read: the floor's
 * release is a store row or it is not.
 */
export async function storeResolution(
  db: Db,
  cfg: ReleaseConfigRow,
  sel: ChannelSelector,
): Promise<{
  release: Release | null;
  offered: Release | null;
  regressed: boolean;
}> {
  const selector = policyChannelOf(sel) ?? sel.raw;
  const state = await loadDeliverableState(
    db,
    cfg.product,
    APP_DELIVERABLE_ID,
    cfg,
    { narrow: true, view: "legacy" },
  );
  if (!state) return { release: null, offered: null, regressed: false };
  const read = async (st: typeof state) => {
    const picked = resolveInState(st, { selector, view: "legacy" });
    return picked
      ? await storeRelease(db, cfg.product, picked.release.release_id)
      : null;
  };
  const release = await read(state);
  if (release) return { release, offered: release, regressed: false };
  const offered = await read({ ...state, floors: new Map() });
  return {
    release: null,
    offered,
    regressed: offered !== null && state.floors.has(selector),
  };
}

/**
 * The release GitHub would answer for the exact tag `tag` (`getReleaseByTag`), from the store:
 * the legacy view's rows only, so a release the sync did not list or saw gone upstream is null,
 * as GitHub's 404 is. The appcast's `v<version>` twin check reads it (plan §6.1).
 */
export async function storeReleaseByTag(
  db: Db,
  cfg: ReleaseConfigRow,
  tag: string,
): Promise<Release | null> {
  const state = await loadDeliverableState(
    db,
    cfg.product,
    APP_DELIVERABLE_ID,
    cfg,
    { narrow: true, view: "legacy" },
  );
  if (!state || hiddenFor(state, "legacy").has(tag)) return null;
  return storeRelease(db, cfg.product, tag);
}

/** Whether a described release holds a file row GitHub's listing for it does not contain. */
export async function describedFilesGitHubLacks(
  db: Db,
  product: string,
  releaseId: string,
): Promise<boolean> {
  const meta = await db.first<{ metadata_json: string | null }>(
    "SELECT metadata_json FROM release_metadata WHERE product = ? AND release_id = ? AND deliverable_id = ?",
    product,
    releaseId,
    APP_DELIVERABLE_ID,
  );
  let listed: Set<string> | null = null;
  try {
    const raw = meta?.metadata_json
      ? (JSON.parse(meta.metadata_json) as { listedAssets?: unknown })
          .listedAssets
      : undefined;
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      listed = new Set(Object.keys(raw));
  } catch {
    listed = null;
  }
  const files = await db.all<{ artifact_id: string }>(
    "SELECT artifact_id FROM release_artifacts WHERE product = ? AND release_id = ? AND build_id IS NOT NULL",
    product,
    releaseId,
  );
  return files.some(
    (a) =>
      !/^\d+$/.test(a.artifact_id) || (listed && !listed.has(a.artifact_id)),
  );
}

/** The channels that have a recorded anti-rollback floor (R6-10). */
export async function flooredChannels(
  db: Db,
  product: string,
): Promise<string[]> {
  const rows = await db.all<{ channel: string }>(
    "SELECT channel FROM release_channel_floors WHERE product = ?",
    product,
  );
  return rows.map((r) => r.channel);
}
