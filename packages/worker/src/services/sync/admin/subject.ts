/**
 * `GET /manage/api/products/<slug>/sync/subjects/<subject>` (U-11a.1): the Data tab's summary of
 * what Cloud Sync holds for one person of this product, in one read. A console API route, so
 * rule 10 (OpenAPI and `routeCoverage`) does not apply, as for `sync/usage`; the RBAC area is
 * `sync` (`test/fixtures/rbac-route-areas.json`, `GET /products/:slug/sync/**`).
 *
 *   - `encryption`: the product's mode, `e2e` or `server`; `encryptionSince`: the person's store
 *     sequence from which every row is sealed, or `null` before the first sealed write;
 *   - `quota`: the entitlement in force at the person's last write (`sync_directory`), with the
 *     tier's label; `usage`: the person's own object, exact;
 *   - `settings.declared`: each catalog-declared synced setting that is stored, by name, size and
 *     age; `settings.open`: the undeclared ones as a count and bytes, never their names;
 *   - `collections`: the declared collections (and any the object holds) with their counters;
 *   - `uploadsOpen`: uploads begun and not yet settled;
 *   - `ring`: the key ring (`kid`, when made, whether a recovery code is set, the labels of the
 *     devices that can open it), or `null` while the person has none.
 *
 * A value, a record id and a file name never appear in the answer, in either mode: the object
 * answers sizes and names only (`do/protocol.ts` `inspect`). The subject must be a live subject
 * of THIS product (`resolveSubject`); another product's, an absorbed one and a malformed one all
 * answer `404`, so the route cannot confirm that a subject exists elsewhere. Every load is
 * audited once as `sync.data.view` (D-13), with the subject as target and no data in the row.
 */

import {
  resolveCollection,
  syncedSettings,
  type CloudSyncCollection,
} from "@polaris-key/catalog";
import { audit } from "../../../core/audit.js";
import { adminJson, err, notFound } from "../../../core/console/respond.js";
import {
  PAIRWISE_SUBJECT_PATTERN,
  resolveSubject,
} from "../../../core/accounts/accountSubjects.js";
import { syncTierLimits } from "../../../core/accounts/syncTierLimits.js";
import { getRing, listWraps } from "../../../core/keyring/store.js";
import { getActiveSchema } from "../../../core/products/store.js";
import { CloudSyncDoError, callCloudSync } from "../do/client.js";
import type { InspectedCollection, InspectedSetting } from "../do/protocol.js";
import { syncMode } from "../handlers/common.js";
import type { SyncAdminContext } from "./index.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What the active catalog declares: its synced setting routes and its collections. */
function declaredOf(catalogJson: string | undefined): {
  routes: Map<string, { scope: "user" | "platform" }>;
  collections: { name: string; label: string }[];
} {
  const routes = new Map<string, { scope: "user" | "platform" }>();
  const collections: { name: string; label: string }[] = [];
  if (catalogJson === undefined) return { routes, collections };
  try {
    const catalog: unknown = JSON.parse(catalogJson);
    if (!isRecord(catalog)) return { routes, collections };
    const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
    for (const r of syncedSettings({
      entries: entries as Parameters<typeof syncedSettings>[0]["entries"],
    }))
      if (r.route === "synced") routes.set(r.key, { scope: r.scope });
    const cs = catalog.cloudSync;
    const declared =
      isRecord(cs) && Array.isArray(cs.collections) ? cs.collections : [];
    for (const c of declared) {
      if (!isRecord(c) || typeof c.name !== "string") continue;
      const { name, label } = resolveCollection(
        c as unknown as CloudSyncCollection,
      );
      collections.push({ name, label });
    }
  } catch {
    // An unreadable catalog declares nothing: every stored setting then reads as open.
  }
  return { routes, collections };
}

export async function handleSubject(
  ctx: SyncAdminContext,
  subject: string,
): Promise<Response> {
  const { env, db, product, now, session } = ctx;
  if (!product.services.sync.enabled) return adminJson({ enabled: false });
  const slug = product.slug;
  // Only this product's live subject: another product's, a merged-away alias, a deleted one and
  // a malformed one are all the same `404`.
  if (!PAIRWISE_SUBJECT_PATTERN.test(subject)) return notFound();
  if ((await resolveSubject(db, slug, subject)) !== subject) return notFound();

  let inspected: Awaited<ReturnType<typeof callCloudSync<"inspect">>>;
  try {
    inspected = await callCloudSync<"inspect">(
      env,
      { product: slug, subject },
      {
        op: "inspect",
      },
    );
  } catch (e) {
    if (e instanceof CloudSyncDoError)
      return err(503, "unavailable", "Try again in a moment.");
    throw e;
  }

  const schemaRow = await getActiveSchema(db, slug);
  const declared = declaredOf(schemaRow?.catalog_json);
  const [mode, limits, ring, devices, dir] = await Promise.all([
    syncMode(env, db, slug, schemaRow),
    syncTierLimits(env, db, slug, now),
    getRing(db, slug, subject),
    listWraps(db, slug, subject),
    db.first<{ quota_bytes: number; tier_id: string | null }>(
      "SELECT quota_bytes, tier_id FROM sync_directory WHERE product = ? AND subject = ?",
      slug,
      subject,
    ),
  ]);

  const declaredRows: {
    key: string;
    bytes: number;
    updatedAt: number;
    platform: string | null;
  }[] = [];
  const open = { count: 0, bytes: 0 };
  const sorted: InspectedSetting[] = [...inspected.settings].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  for (const s of sorted) {
    if (declared.routes.has(s.key)) {
      declaredRows.push({
        key: s.key,
        bytes: s.bytes,
        updatedAt: Math.floor(s.updatedAt / 1000),
        platform: s.scope === "platform" ? (s.family ?? null) : null,
      });
    } else {
      open.count += 1;
      open.bytes += s.bytes;
    }
  }

  // The declared collections first, in catalog order, then any the object holds that the
  // catalog no longer declares (their name is the label).
  const held = new Map<string, InspectedCollection>(
    inspected.collections.map((c) => [c.name, c]),
  );
  const shape = (name: string, label: string) => {
    const c = held.get(name);
    held.delete(name);
    return {
      name,
      label,
      records: c?.records ?? 0,
      bytes: c?.bytes ?? 0,
      files: c?.files ?? 0,
      fileBytes: c?.fileBytes ?? 0,
      revisionBytes: c?.revisionBytes ?? 0,
      lastWriteAt:
        c?.lastWriteAt != null ? Math.floor(c.lastWriteAt / 1000) : null,
    };
  };
  const collections = declared.collections.map((c) => shape(c.name, c.label));
  for (const name of [...held.keys()].sort())
    collections.push(shape(name, name));

  const tierId = dir?.tier_id ?? null;
  const body = {
    enabled: true,
    empty: inspected.empty,
    encryption: mode.serve,
    encryptionSince: inspected.encryptionSince,
    quota: {
      bytes: dir ? dir.quota_bytes : null,
      defaultBytes: limits.defaultBytes,
      tierId,
      tierLabel: limits.tiers.find((t) => t.id === tierId)?.label ?? null,
    },
    usage: {
      bytes: inspected.usage.bytes,
      settings: inspected.usage.settings,
      settingsBytes: inspected.usage.settingsBytes,
    },
    settings: { declared: declaredRows, open },
    collections,
    uploadsOpen: inspected.uploadsOpen,
    ring: ring
      ? {
          kid: ring.rootKid,
          createdAt: ring.createdAt,
          recoverySet: ring.recoverySet,
          devices: devices.map((d) => d.label ?? "Unnamed device"),
          ...(ring.previous ? { previousUntil: ring.previous.until } : {}),
        }
      : null,
  };

  await audit(
    db,
    slug,
    session,
    now,
    "sync.data.view",
    { kind: "user", id: subject },
    "Viewed Cloud Sync data",
  );
  return adminJson(body);
}
