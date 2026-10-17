/**
 * The per-row plan for tiers and profiles an apply writes (S-18 §4.5 item 3), computed once
 * because License (tiers) and Config (profiles) both read it: a `manifest` row the manifest still
 * declares is upserted; a `console` row is never touched; a `manifest` row the manifest dropped is
 * deleted (refused when something references it). A console row holding the id of a manifest row
 * is skipped: a claim when the last applied manifest declared that id too, a conflict (reported)
 * when the id is new to the manifest.
 */

import type { Db } from "../../db/types.js";
import { listProfiles, listTiers } from "../licensing/store.js";
import { liveRowClaimKeys } from "../rowSettings.js";
import type { ParsedManifest } from "@polaris-key/manifest";
import type { ManifestConflict, RowPlan } from "./types.js";
import { snapshotRowIds } from "./shared.js";

export async function planRows(
  db: Db,
  slug: string,
  manifest: ParsedManifest,
  previousSnapshotJson: string | undefined,
  now: number,
): Promise<{
  plan: RowPlan;
  claimed: string[];
  conflicts: ManifestConflict[];
}> {
  const previousIds = snapshotRowIds(previousSnapshotJson);
  const storedProfiles = await listProfiles(db, slug);
  const storedTiers = await listTiers(db, slug);
  const consoleProfiles = new Set(
    storedProfiles.filter((p) => p.source === "console").map((p) => p.id),
  );
  const consoleTiers = new Set(
    storedTiers.filter((t) => t.source === "console").map((t) => t.id),
  );
  const nextProfileIds = new Set(manifest.profiles.map((p) => p.id));
  const nextTierIds = new Set(manifest.tiers.map((t) => t.id));
  // LX-06: row-backed settings the console has claimed. The owning services' contributors skip
  // them in SQL; they are named here so the answer says what was left alone.
  const claimed: string[] = await liveRowClaimKeys(db, slug, now);
  const conflicts: ManifestConflict[] = [];
  const skip = (
    kind: "tier" | "profile",
    id: string,
    owned: Set<string>,
    before: Set<string>,
  ): boolean => {
    if (!owned.has(id)) return false;
    if (before.has(id)) claimed.push(`${kind}:${id}`);
    else
      conflicts.push({
        path: `/${kind === "tier" ? "tiers" : "profiles"}/${id}`,
        message: `a ${kind} with id ${id} was created in the console; it is kept, and the manifest's ${kind} is not applied until one of them is renamed`,
      });
    return true;
  };
  const applyTiers = manifest.tiers.filter(
    (t) => !skip("tier", t.id, consoleTiers, previousIds.tiers),
  );
  const applyProfiles = manifest.profiles.filter(
    (p) => !skip("profile", p.id, consoleProfiles, previousIds.profiles),
  );
  const dropTiers = storedTiers.filter(
    (t) => t.source !== "console" && !nextTierIds.has(t.id),
  );
  const dropProfiles = storedProfiles.filter(
    (p) => p.source !== "console" && !nextProfileIds.has(p.id),
  );
  // The tiers that survive this resync: the console's, plus the manifest's applied ones.
  const survivingTierProfiles = [
    ...storedTiers
      .filter((t) => consoleTiers.has(t.id))
      .map((t) => t.profile_id),
    ...applyTiers.map((t) => t.profileId ?? null),
  ];
  return {
    plan: {
      applyTiers,
      applyProfiles,
      dropTiers,
      dropProfiles,
      survivingTierProfiles,
      storedTiers,
      storedProfiles,
    },
    claimed,
    conflicts,
  };
}
