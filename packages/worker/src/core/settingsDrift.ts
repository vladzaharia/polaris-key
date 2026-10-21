/**
 * The drift view's read (ST-17, S-18 §4.5 items 4–5): every setting the console has claimed on a
 * repo-linked product, set against the last applied manifest (ST-01a's snapshot), plus the plan
 * the last apply recorded (`product_sync_state.plan_json`).
 *
 * A claim keeps a resync from overwriting the field; this is how an operator sees what the
 * manifest says now and chooses Revert (`DELETE …/claims/<key>` or `…/settings/<key>`, which hand
 * the field back) or Keep (the claim stays, so nothing to call). Read-only.
 */

import type { Db } from "../db/types.js";
import { tryParseJson } from "../platform/json.js";
import { getActiveSchema } from "./products/store.js";
import { getManifestSnapshot } from "./manifestSnapshot.js";
import { liveRowClaimKeys } from "./rowSettings.js";
import { listClaims, type ClaimView } from "./settingsClaims.js";
import { snapshotValue } from "./settings/snapshot.js";
import {
  resolveProductSettings,
  sameValue,
  type SettingsContext,
} from "./settings/resolve.js";
import type { ProductRow } from "./repo.js";
import type { StoredSyncPlan } from "./ingest/types.js";

export interface DriftItem {
  key: string;
  label: string;
  area: string;
  claimedBy: string | null;
  claimedAt: number | null;
  /** The row version a Revert of a row-backed key sends as `expectedVersion`. */
  version: number;
  breakGlass?: { reason: string; expiresAt: number };
  /** `claim`: `DELETE …/claims/<key>`; `setting`: `DELETE …/settings/<key>` with `version`. */
  revert: "claim" | "setting";
  /** The manifest's value is known (a snapshot exists and carries the key). */
  manifestKnown: boolean;
  /** Known, and different from the console's. */
  differs: boolean;
  /** The console's value; `null` for the catalog (see `changes`). */
  console: unknown;
  manifest: unknown;
  /** The catalog: which keys the manifest adds, drops or changes against the console's. */
  changes?: { added: string[]; removed: string[]; changed: string[] };
}

export interface DriftView {
  /** The last applied manifest, or `null` (linked before ST-01a and not resynced since). */
  snapshot: {
    origin: string;
    appliedAt: number;
    appliedSha: string | null;
  } | null;
  items: DriftItem[];
  /** What the last apply did (`StoredSyncPlan`), or `null` before one was recorded. */
  lastPlan: StoredSyncPlan | null;
}

function catalogKeys(catalog: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const entries =
    catalog && typeof catalog === "object"
      ? (catalog as { entries?: unknown }).entries
      : undefined;
  if (Array.isArray(entries))
    for (const e of entries)
      if (
        e &&
        typeof e === "object" &&
        typeof (e as { key?: unknown }).key === "string"
      )
        out.set((e as { key: string }).key, JSON.stringify(e));
  return out;
}

export async function driftView(
  ctx: SettingsContext,
  product: ProductRow,
  planJson: string | null | undefined,
  now: number,
): Promise<DriftView> {
  const { db, registry } = ctx;
  const snap = await getManifestSnapshot(db, product.slug);
  const manifest = snap ? tryParseJson(snap.manifest_json) : undefined;

  const claims = await listClaims(db, product.slug, now);
  const claimBy = new Map<string, ClaimView>(claims.map((c) => [c.key, c]));
  const rowKeys = await liveRowClaimKeys(db, product.slug, now);
  const keys = [...claims.map((c) => c.key as string), ...rowKeys];
  const scalarKeys = keys.filter((k) => k !== "config.catalog");
  const resolved = new Map(
    (scalarKeys.length > 0
      ? await resolveProductSettings(ctx, product, {
          keys: scalarKeys,
          withDrift: true,
          now,
        })
      : []
    ).map((r) => [r.key, r]),
  );
  const rowMeta = new Map(
    (
      await db.all<{
        key: string;
        updated_by: string;
        updated_at: number;
        expires_at: number | null;
        reason: string | null;
      }>(
        "SELECT key, updated_by, updated_at, expires_at, reason FROM product_settings WHERE product = ? AND source = 'console'",
        product.slug,
      )
    ).map((r) => [r.key, r]),
  );

  const items: DriftItem[] = [];
  for (const key of keys) {
    const def = registry.get(key, "product");
    const base = {
      key,
      label: def?.label ?? key,
      area: def?.area ?? "core",
    };
    if (key === "config.catalog") {
      const c = claimBy.get(key)!;
      const active = await getActiveSchema(db, product.slug);
      const mine = catalogKeys(tryParseJson(active?.catalog_json));
      const theirs = catalogKeys(
        manifest ? snapshotValue(key, manifest) : undefined,
      );
      const known =
        manifest !== undefined && snapshotValue(key, manifest) !== undefined;
      const changes = {
        added: [...theirs.keys()].filter((k) => !mine.has(k)),
        removed: [...mine.keys()].filter((k) => !theirs.has(k)),
        changed: [...theirs.keys()].filter(
          (k) => mine.has(k) && mine.get(k) !== theirs.get(k),
        ),
      };
      items.push({
        ...base,
        claimedBy: c.claimedBy,
        claimedAt: c.claimedAt,
        version: c.version,
        ...(c.breakGlass ? { breakGlass: c.breakGlass } : {}),
        revert: "claim",
        manifestKnown: known,
        differs:
          known &&
          (changes.added.length > 0 ||
            changes.removed.length > 0 ||
            changes.changed.length > 0),
        console: null,
        manifest: null,
        changes,
      });
      continue;
    }
    const r = resolved.get(key);
    const c = claimBy.get(key);
    const meta = rowMeta.get(key);
    const declared =
      manifest !== undefined ? snapshotValue(key, manifest, def) : undefined;
    const expires =
      c?.breakGlass ??
      (meta?.expires_at != null
        ? { reason: meta.reason ?? "", expiresAt: meta.expires_at }
        : undefined);
    items.push({
      ...base,
      claimedBy: c?.claimedBy ?? meta?.updated_by ?? null,
      claimedAt: c?.claimedAt ?? meta?.updated_at ?? null,
      version: r?.version ?? c?.version ?? 0,
      ...(expires ? { breakGlass: expires } : {}),
      revert: c ? "claim" : "setting",
      manifestKnown: declared !== undefined,
      differs: declared !== undefined && !sameValue(declared, r?.value),
      console: r?.value ?? null,
      manifest: declared ?? null,
    });
  }
  items.sort((a, b) => a.key.localeCompare(b.key));

  const stored = tryParseJson(planJson);
  return {
    snapshot: snap
      ? {
          origin: snap.origin,
          appliedAt: snap.applied_at,
          appliedSha: snap.applied_sha,
        }
      : null,
    items,
    lastPlan:
      stored &&
      typeof stored === "object" &&
      (stored as { v?: unknown }).v === 1
        ? (stored as StoredSyncPlan)
        : null,
  };
}
