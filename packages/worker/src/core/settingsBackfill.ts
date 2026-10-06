/**
 * The settings backfill (ST-01c; notes/S-18 §4.14, owner decision D19 "Revert all console
 * values"). Core-owned: the classifier, the apply's statements, the state guard and the stored
 * reports (`settings_backfill_reports`, migration 0102_settings_backfill_reports).
 *
 * ST-01b gave every claimable setting an owner (`product_settings` claims; `source` on tiers and
 * profiles) but left existing products as they were: every existing tier and profile row reads
 * `manifest` (the column's DEFAULT) and no claim exists for an edit made before ST-01b. The
 * backfill moves each linked product onto that model ONCE, by the owner's rule:
 *
 *   - every field and row the manifest DECLARES takes its manifest value, and its console claim
 *     goes (owner decision D19: no preserve review, no acknowledgement, no 30-day window);
 *   - every tier and profile row the manifest does NOT declare stays, as `source = 'console'`,
 *     so no later resync deletes it (or fails on it because a licence still references it);
 *   - existing `*_source` markers are left alone (S-18 §4.14.1), except the system product's
 *     bootstrap `services_source = 'admin'`, which is reset to `manifest` when the stored services
 *     equal the manifest's (nothing is lost);
 *   - a LIVE break-glass claim (ST-20: `expires_at` set and in the future) is kept: ST-20's rule is
 *     that an apply which does not change the manifest's value for the field does not end it, and
 *     the backfill changes no manifest. The system product's name is never written (F-03).
 *
 * The classification (S-18 §4.14.2 steps 1–5: equal / differs / not declared, with the audit
 * evidence) is still produced, as a report kept for the record, not as a gate. `planBackfill` is
 * the pure half (ST-17 reuses its classification for the drift view); `admin/settingsBackfill.ts`
 * reads the manifest and the stored state, and runs the batch.
 *
 * Concurrency. The apply reads the product's settings state, then (for a linked product) talks to
 * GitHub, then writes. A console edit landing in between must not be reverted unseen, and the
 * report must describe exactly what was written. So the apply's FIRST statement is the report row,
 * inserted only while the product's state token (`STATE_TOKEN_SQL`) still equals the token read
 * before classifying; otherwise its `report_json` is NULL, the NOT NULL constraint fails and the
 * whole batch rolls back (D1 batches are transactions). The caller re-reads the token to tell this
 * conflict from any other failure, and answers 409.
 */

import type {
  ManifestProfile,
  ManifestTier,
  ParsedManifest,
} from "@polaris-key/manifest";
import type { Db, DbStatement } from "../db/types.js";
import type {
  AuditRow,
  ProductRow,
  ProfileRow,
  SchemaRow,
  TierRow,
} from "../repo.js";
import { stmtInsertTier } from "../repo.js";
import { randomId } from "./platform.js";
import { parseWebOrigins, serializeWebOrigins } from "./cors.js";
import { parseServices } from "./services.js";
import {
  auditValue,
  type AuditActor,
  type ClaimKey,
  type ProductSettingRow,
} from "./settingsClaims.js";

// ── The report ──────────────────────────────────────────────────────────────────────────

/** How a field or row compares with the manifest (S-18 §4.14.1's three columns). */
export type BackfillClass = "equal" | "differs" | "not-declared";

/**
 * Who owns the stored value now: the manifest (no claim, a `manifest` row), the console (a claim,
 * a `console` row, an `admin` marker) or a live break-glass claim (ST-20).
 */
export type BackfillOwner = "manifest" | "console" | "break-glass";

/**
 * What the apply does with one item (owner decision D19):
 *
 *   - `none`           nothing (manifest-owned and equal; or undeclared and already `console`);
 *   - `revert`         write the manifest's value and drop any claim (`source = 'manifest'`);
 *   - `release-claim`  the value already equals the manifest: only the claim goes;
 *   - `mark-console`   an undeclared `manifest` row becomes `console`, so resync keeps it;
 *   - `reset-marker`   the system product's bootstrap `services_source = 'admin'` → `manifest`;
 *   - `keep`           left as it is on purpose (`note` says why).
 */
export type BackfillAction =
  | "none"
  | "revert"
  | "release-claim"
  | "mark-console"
  | "reset-marker"
  | "keep";

/** The actions that change something (what `changes` counts). */
const CHANGING: ReadonlySet<BackfillAction> = new Set([
  "revert",
  "release-claim",
  "mark-console",
  "reset-marker",
]);

/** One console audit row offered as evidence for a difference (S-18 §4.14.2 step 3). */
export interface BackfillEvidenceRow {
  at: number;
  action: string;
  actor: string | null;
  summary: string | null;
}

/**
 * Why a field differs, as far as the audit trail can tell: `console-edit` when a console audit row
 * for it is newer than the last apply ("edited in the console since the last sync"), otherwise
 * `no-console-edit` ("the manifest changed since the last sync, or a delivery was missed").
 */
export interface BackfillEvidence {
  verdict: "console-edit" | "no-console-edit";
  /** The newest matching rows, at most `EVIDENCE_PER_ITEM`. */
  rows: BackfillEvidenceRow[];
}

/** One classified field, row or marker. */
export interface BackfillItem {
  kind: "setting" | "tier" | "profile" | "marker";
  /** A registry key (`core.name`, `config.catalog`, …), a tier or profile id, or `services`. */
  key: string;
  class: BackfillClass;
  owner: BackfillOwner;
  /** The stored value (`null` when absent). Profiles: names and payload KEYS only, never values. */
  before: unknown;
  /** The manifest's value; absent when the manifest does not declare it. Same redaction. */
  manifest?: unknown;
  /** What differs, by field or payload key (never a value), when `class` is `differs`. */
  changed?: string[];
  /** The live claim on the field, when there is one. */
  claim?: {
    by: string;
    at: number;
    version: number;
    reason?: string | null;
    expiresAt?: number;
  };
  action: BackfillAction;
  note?: string;
  evidence?: BackfillEvidence;
}

/** What the "since" bound of the evidence is (S-18 §4.14.2 steps 3–4). */
export interface BackfillEvidenceBasis {
  /**
   * `snapshot`: the last applied manifest's `applied_at` (ST-01a); `last-sync`:
   * `product_sync_state.last_synced_at`; `created`: neither exists (linked before ST-01a and never
   * resynced since), so the product's creation is the bound and the evidence is weak.
   */
  basis: "snapshot" | "last-sync" | "created";
  since: number;
  weak: boolean;
}

/** The corroborating read at the stored push sha (S-18 §4.14.2 step 2). Compare-only. */
export type BackfillCorroboration =
  | { commitSha: null; note: string }
  | { commitSha: string; matches: boolean }
  | { commitSha: string; error: string };

export type BackfillMode = "dry-run" | "apply";
export type BackfillOutcome =
  | "planned"
  | "applied"
  | "unchanged"
  | "unlinked"
  | "unreadable"
  | "refused";

/** Where the manifest the run classified against came from. */
export type BackfillSource =
  | { kind: "github"; repository: string; commit: string }
  | { kind: "deploy-snapshot"; commit: string | null; appliedAt: number };

/** The stored report (`settings_backfill_reports.report_json`). */
export interface BackfillReport {
  version: 1;
  id: string;
  product: string;
  at: number;
  mode: BackfillMode;
  outcome: BackfillOutcome;
  /** For `unlinked`, `unreadable` and `refused`: why nothing was classified or written. */
  message?: string;
  /** The validator's errors, when `.pkey/` did not parse. */
  errors?: string[];
  source?: BackfillSource;
  corroboration?: BackfillCorroboration;
  evidence?: BackfillEvidenceBasis;
  items: BackfillItem[];
  /** How many items the apply changes (a dry run: would change). */
  changes: number;
  /**
   * The manifest snapshot (ST-01a): `written` when this apply recorded one (origin `backfill`),
   * `current` when the stored one already describes this manifest, `not-applicable` for the
   * system product (the deploy hook is its only writer) and for a dry run.
   */
  snapshot: "written" | "current" | "not-applicable";
  batchId: string | null;
  actor: { sub: string | null; name: string | null };
}

// ── Classification ──────────────────────────────────────────────────────────────────────

/** The manifest fields the backfill reads (a ParsedManifest, or the system product's snapshot). */
export type BackfillManifest = Pick<
  ParsedManifest,
  | "product"
  | "catalog"
  | "tiers"
  | "profiles"
  | "webOrigins"
  | "services"
  | "registration"
>;

/** The stored state of one product, read before classifying. */
export interface BackfillState {
  product: ProductRow;
  /** Every `product_settings` row of the product. */
  settings: readonly ProductSettingRow[];
  tiers: readonly TierRow[];
  profiles: readonly ProfileRow[];
  activeSchema: SchemaRow | null;
  /** Console audit rows newer than the evidence bound (`readEvidence`), newest first. */
  evidence: readonly AuditRow[];
}

export interface BackfillPlan {
  items: BackfillItem[];
  /** The apply's own writes, in order (the caller adds the report, snapshot and audit rows). */
  writes: DbStatement[];
  changes: number;
}

/** Console audit actions that count as evidence of a console edit (S-18 §4.14.2 step 3). */
export const EVIDENCE_ACTIONS = [
  "product.update",
  "product.services.update",
  "setting.claim",
  "setting.update",
  "setting.revert",
  "schema.publish",
  "tier.create",
  "tier.update",
  "tier.delete",
  "profile.create",
  "profile.update",
  "profile.overrides",
  "profile.delete",
] as const;

/** The settings whose console edit is the products PATCH (`product.update`). */
const PRODUCT_ROW_KEYS: ReadonlySet<string> = new Set([
  "core.name",
  "license.defaults.maxOfflineDays",
  "license.defaults.deviceLimit",
  "core.web.origins",
  "core.adminGroup",
]);

/** Evidence rows kept per item. */
export const EVIDENCE_PER_ITEM = 5;

/** Comparable JSON with sorted object keys. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  return value;
}

function parseJson(json: string | null | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/**
 * The catalog as content: everything but the document header (`apiVersion`), which a parsed
 * `.pkey/schema` keeps and a bootstrap or console publish does not. Equal content is not a
 * difference, so the backfill publishes no new version for it.
 */
function catalogContent(catalog: unknown): string {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog))
    return canonical(catalog ?? null);
  const { apiVersion: _header, ...rest } = catalog as Record<string, unknown>;
  return canonical(rest);
}

/** The catalog's entry keys mapped to their comparable JSON. */
function catalogEntries(catalog: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const entries =
    catalog && typeof catalog === "object"
      ? (catalog as { entries?: unknown }).entries
      : undefined;
  if (!Array.isArray(entries)) return out;
  for (const e of entries)
    if (
      e &&
      typeof e === "object" &&
      typeof (e as { key?: unknown }).key === "string"
    )
      out.set((e as { key: string }).key, canonical(e));
  return out;
}

/** `+key` added, `-key` removed, `~key` changed; `header` for a non-entry difference. */
function catalogChanges(stored: unknown, declared: unknown): string[] {
  const a = catalogEntries(stored);
  const b = catalogEntries(declared);
  const out: string[] = [];
  for (const k of b.keys()) if (!a.has(k)) out.push(`+${k}`);
  for (const k of a.keys()) if (!b.has(k)) out.push(`-${k}`);
  for (const [k, v] of b) if (a.has(k) && a.get(k) !== v) out.push(`~${k}`);
  if (out.length === 0) out.push("schemaVersion or cloudSync");
  return out;
}

function catalogView(
  catalog: unknown,
  version?: number,
): { entries: number; version?: number } {
  return {
    entries: catalogEntries(catalog).size,
    ...(version !== undefined ? { version } : {}),
  };
}

/** A tier's manifest-owned columns, as `stmtInsertTier` writes them. */
function tierInput(
  product: string,
  t: ManifestTier,
  now: number,
): Parameters<typeof stmtInsertTier>[0] {
  return {
    product,
    id: t.id,
    label: t.label,
    profileId: t.profileId ?? null,
    policyExpiryDays: t.policyExpiryDays ?? null,
    policyDeviceLimit: t.policyDeviceLimit ?? null,
    policyFingerprint: t.policyFingerprint ?? null,
    channels: t.channels ?? [],
    minVersion: t.minVersion ?? null,
    maxVersion: t.maxVersion ?? null,
    modifiedAt: now,
  };
}

/** The comparable columns, in `stmtInsertTier`'s parameter order (2..9), named. */
const TIER_FIELDS = [
  "label",
  "profileId",
  "policyExpiryDays",
  "policyDeviceLimit",
  "channels",
  "minVersion",
  "maxVersion",
  "policyFingerprint",
] as const;

function storedTierColumns(t: TierRow): unknown[] {
  return [
    t.label,
    t.profile_id,
    t.policy_expiry_days,
    t.policy_device_limit,
    t.channels_json,
    t.min_version,
    t.max_version,
    t.policy_fingerprint ?? null,
  ];
}

function tierView(columns: readonly unknown[]): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  TIER_FIELDS.forEach((f, i) => {
    view[f] =
      f === "channels"
        ? (parseJson(columns[i] as string | null) ?? [])
        : columns[i];
  });
  return view;
}

/** A profile as the report shows it: names and payload keys, never a value. */
function profileView(
  name: string,
  description: string | null,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const keys: Record<string, string[]> = {};
  for (const [bucket, value] of Object.entries(payload))
    keys[bucket] =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).sort()
        : [];
  return { name, description, payloadKeys: keys };
}

/** The payload keys (`bucket.key`) whose values differ, without the values. */
function payloadChanges(
  stored: Record<string, unknown>,
  declared: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const buckets = new Set([...Object.keys(stored), ...Object.keys(declared)]);
  const isMap = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  for (const bucket of [...buckets].sort()) {
    // An absent bucket reads as an empty one: the console writes `{}` buckets a manifest omits.
    const a = stored[bucket] ?? {};
    const b = declared[bucket] ?? {};
    if (!isMap(a) || !isMap(b)) {
      if (canonical(a ?? null) !== canonical(b ?? null)) out.push(bucket);
      continue;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort())
      if (canonical(a[key] ?? null) !== canonical(b[key] ?? null))
        out.push(`${bucket}.${key}`);
  }
  return out;
}

function payloadOf(json: string): Record<string, unknown> {
  const parsed = parseJson(json);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** The live claim on `key` among `rows` (ordinary or break-glass), or `null`. */
function liveClaim(
  rows: readonly ProductSettingRow[],
  key: ClaimKey,
  now: number,
): ProductSettingRow | null {
  const row = rows.find((r) => r.key === key && r.source === "console");
  if (!row) return null;
  return row.expires_at === null || row.expires_at > now ? row : null;
}

function claimOf(row: ProductSettingRow): NonNullable<BackfillItem["claim"]> {
  return {
    by: row.updated_by,
    at: row.updated_at,
    version: row.version,
    ...(row.expires_at !== null
      ? { reason: row.reason, expiresAt: row.expires_at }
      : {}),
  };
}

/** Which audit rows count as evidence for one item. */
function evidenceFor(
  item: Pick<BackfillItem, "kind" | "key">,
  rows: readonly AuditRow[],
): BackfillEvidence {
  const matches = rows.filter((r) => {
    switch (item.kind) {
      case "tier":
        return r.target_kind === "tier" && r.target_id === item.key;
      case "profile":
        return r.target_kind === "profile" && r.target_id === item.key;
      case "marker":
        return r.action === "product.services.update";
      case "setting":
        if (r.target_kind === "setting" && r.target_id === item.key)
          return true;
        if (item.key === "config.catalog") return r.action === "schema.publish";
        return PRODUCT_ROW_KEYS.has(item.key) && r.action === "product.update";
    }
  });
  return {
    verdict: matches.length > 0 ? "console-edit" : "no-console-edit",
    rows: matches.slice(0, EVIDENCE_PER_ITEM).map((r) => ({
      at: r.at,
      action: r.action,
      actor: r.actor_name ?? r.actor_sub,
      summary: r.summary,
    })),
  };
}

export interface PlanOptions {
  now: number;
  /** The system product (`system = 1`): its name is kept (F-03), its services marker reset. */
  system: boolean;
  /**
   * The payload a declared profile is written with: the manifest's, with the stored row's sealed
   * secret values carried (R2, `withStoredSecrets` in `services/release/resync.ts`): a manifest
   * cannot express a secret value, so reverting a profile must not wipe one.
   */
  profilePayload: (
    profile: ManifestProfile,
    stored: ProfileRow | undefined,
  ) => Record<string, unknown>;
  /**
   * The ROW-BACKED claimable settings (LX-06: the value lives in `product_settings.value_json`),
   * each with the value the manifest declares for it. The caller takes them from the registry, so
   * Core names no service here.
   */
  rowSettings?: readonly RowSettingInput[];
}

/** One row-backed claimable setting as the backfill sees it. */
export interface RowSettingInput {
  key: string;
  /** The manifest's value; `undefined` when the manifest does not declare it. */
  declared: unknown;
  /** Whether the registry's value spec accepts `declared` (a resync skips one it does not). */
  fits: boolean;
}

const BREAK_GLASS_NOTE =
  "a live break-glass claim (ST-20): an apply that does not change the manifest's value for the field leaves it, and the backfill changes no manifest";

/**
 * Classify every field and row of one product against its manifest (S-18 §4.14.1), decide each
 * one's action by owner decision D19, and build the apply's writes. Pure: reads nothing.
 */
export function planBackfill(
  manifest: BackfillManifest,
  state: BackfillState,
  opts: PlanOptions,
): BackfillPlan {
  const { product } = state;
  const slug = product.slug;
  const { now, system } = opts;
  const items: BackfillItem[] = [];
  const writes: DbStatement[] = [];
  const claimDrops: DbStatement[] = [];
  const columns: [string, string | number | null][] = [];

  const differs = (item: BackfillItem): BackfillItem =>
    item.class === "differs"
      ? { ...item, evidence: evidenceFor(item, state.evidence) }
      : item;

  // ── the column-backed claimable settings and the admin group ──────────────────────────
  const scalar = (
    key: ClaimKey | "core.adminGroup",
    column: string,
    stored: unknown,
    declared: unknown,
    write: string | number | null,
    view: (v: unknown) => unknown = (v) => v,
  ): void => {
    const claimRow =
      key === "core.adminGroup" ? null : liveClaim(state.settings, key, now);
    const breakGlass = claimRow !== null && claimRow.expires_at !== null;
    const cls: BackfillClass =
      canonical(stored ?? null) === canonical(declared ?? null)
        ? "equal"
        : "differs";
    const item: BackfillItem = {
      kind: "setting",
      key,
      class: cls,
      owner: breakGlass ? "break-glass" : claimRow ? "console" : "manifest",
      before: view(stored ?? null),
      manifest: view(declared ?? null),
      ...(claimRow ? { claim: claimOf(claimRow) } : {}),
      action: "none",
    };
    if (system && key === "core.name" && cls === "differs") {
      item.action = "keep";
      item.note = "the system product keeps its name (F-03)";
    } else if (breakGlass) {
      item.action = "keep";
      item.note = BREAK_GLASS_NOTE;
    } else if (cls === "differs") {
      item.action = "revert";
      columns.push([column, write]);
    } else if (claimRow) {
      item.action = "release-claim";
    }
    if (claimRow && !breakGlass && item.action !== "keep")
      claimDrops.push(stmtDropClaim(slug, key as ClaimKey, claimRow.version));
    items.push(differs(item));
  };

  const m = manifest.product;
  scalar("core.name", "name", product.name, m.name, m.name);
  scalar(
    "license.defaults.maxOfflineDays",
    "default_max_offline_days",
    product.default_max_offline_days,
    m.defaultMaxOfflineDays,
    m.defaultMaxOfflineDays,
  );
  scalar(
    "license.defaults.deviceLimit",
    "default_device_limit",
    product.default_device_limit,
    m.defaultDeviceLimit,
    m.defaultDeviceLimit,
  );
  // `web.origins` is omit-clears (P0-05): an undeclared list is `[]`, stored as NULL.
  const origins = manifest.webOrigins ?? [];
  scalar(
    "core.web.origins",
    "web_origins_json",
    product.web_origins_json ?? null,
    serializeWebOrigins(origins),
    serializeWebOrigins(origins),
    (v) => parseWebOrigins(v as string | null),
  );
  // Manifest-only (owner decision 1): never claimable, always follows the manifest.
  scalar(
    "core.adminGroup",
    "admin_group",
    product.admin_group ?? null,
    m.adminGroup ?? null,
    m.adminGroup ?? null,
  );

  // ── the catalog (one claimable unit, `config.catalog`) ─────────────────────────────────
  {
    const storedCatalog = state.activeSchema
      ? parseJson(state.activeSchema.catalog_json)
      : null;
    const claimRow = liveClaim(state.settings, "config.catalog", now);
    const breakGlass = claimRow !== null && claimRow.expires_at !== null;
    const cls: BackfillClass =
      state.activeSchema &&
      catalogContent(storedCatalog) === catalogContent(manifest.catalog)
        ? "equal"
        : "differs";
    const item: BackfillItem = {
      kind: "setting",
      key: "config.catalog",
      class: cls,
      owner: breakGlass ? "break-glass" : claimRow ? "console" : "manifest",
      before: state.activeSchema
        ? catalogView(storedCatalog, state.activeSchema.catalog_version)
        : null,
      manifest: catalogView(manifest.catalog),
      ...(cls === "differs"
        ? { changed: catalogChanges(storedCatalog, manifest.catalog) }
        : {}),
      ...(claimRow ? { claim: claimOf(claimRow) } : {}),
      action: "none",
    };
    if (breakGlass) {
      item.action = "keep";
      item.note = BREAK_GLASS_NOTE;
    } else if (cls === "differs") {
      item.action = "revert";
      writes.push(...catalogPublishStatements(slug, manifest.catalog, now));
    } else if (claimRow) {
      item.action = "release-claim";
    }
    if (claimRow && !breakGlass)
      claimDrops.push(stmtDropClaim(slug, "config.catalog", claimRow.version));
    items.push(differs(item));
  }

  // ── profiles, per row (before tiers, which may name one) ───────────────────────────────
  const storedProfiles = new Map(state.profiles.map((p) => [p.id, p]));
  const declaredProfiles = new Set(manifest.profiles.map((p) => p.id));
  for (const p of manifest.profiles) {
    const stored = storedProfiles.get(p.id);
    const payload = opts.profilePayload(p, stored);
    const description = p.description ?? null;
    const declaredView = profileView(p.name, description, payload);
    const owner: BackfillOwner =
      stored?.source === "console" ? "console" : "manifest";
    if (!stored) {
      items.push(
        differs({
          kind: "profile",
          key: p.id,
          class: "differs",
          owner: "manifest",
          before: null,
          manifest: declaredView,
          changed: ["(absent)"],
          action: "revert",
        }),
      );
      writes.push(stmtProfileAsManifest(slug, p, payload, now));
      continue;
    }
    const storedPayload = payloadOf(stored.payload_json);
    const changed = [
      ...(stored.name !== p.name ? ["name"] : []),
      ...((stored.description ?? null) !== description ? ["description"] : []),
      ...(stored.payload_json !== JSON.stringify(payload)
        ? payloadChanges(storedPayload, payload)
        : []),
    ];
    // A payload whose JSON differs only in key order is not a difference worth a write.
    const cls: BackfillClass = changed.length > 0 ? "differs" : "equal";
    const item: BackfillItem = {
      kind: "profile",
      key: p.id,
      class: cls,
      owner,
      before: profileView(stored.name, stored.description, storedPayload),
      manifest: declaredView,
      ...(cls === "differs" ? { changed } : {}),
      action: "none",
    };
    if (cls === "differs") {
      item.action = "revert";
      writes.push(stmtProfileAsManifest(slug, p, payload, now));
    } else if (owner === "console") {
      item.action = "release-claim";
      writes.push(stmtRowSource("profiles", slug, p.id, "manifest"));
    }
    items.push(differs(item));
  }
  for (const stored of state.profiles) {
    if (declaredProfiles.has(stored.id)) continue;
    const console = stored.source === "console";
    items.push({
      kind: "profile",
      key: stored.id,
      class: "not-declared",
      owner: console ? "console" : "manifest",
      before: profileView(
        stored.name,
        stored.description,
        payloadOf(stored.payload_json),
      ),
      action: console ? "none" : "mark-console",
    });
    if (!console)
      writes.push(stmtRowSource("profiles", slug, stored.id, "console"));
  }

  // ── tiers, per row ─────────────────────────────────────────────────────────────────────
  const storedTiers = new Map(state.tiers.map((t) => [t.id, t]));
  const declaredTiers = new Set(manifest.tiers.map((t) => t.id));
  for (const t of manifest.tiers) {
    const input = tierInput(slug, t, now);
    const declaredColumns = stmtInsertTier(input).params.slice(2, 10);
    const stored = storedTiers.get(t.id);
    if (!stored) {
      items.push(
        differs({
          kind: "tier",
          key: t.id,
          class: "differs",
          owner: "manifest",
          before: null,
          manifest: tierView(declaredColumns),
          changed: ["(absent)"],
          action: "revert",
        }),
      );
      writes.push(stmtTierAsManifest(input));
      continue;
    }
    const storedColumns = storedTierColumns(stored);
    const changed = TIER_FIELDS.filter(
      (_, i) =>
        canonical(storedColumns[i] ?? null) !==
        canonical(declaredColumns[i] ?? null),
    );
    const cls: BackfillClass = changed.length > 0 ? "differs" : "equal";
    const owner: BackfillOwner =
      stored.source === "console" ? "console" : "manifest";
    const item: BackfillItem = {
      kind: "tier",
      key: t.id,
      class: cls,
      owner,
      before: tierView(storedColumns),
      manifest: tierView(declaredColumns),
      ...(cls === "differs" ? { changed: [...changed] } : {}),
      action: "none",
    };
    if (cls === "differs") {
      item.action = "revert";
      writes.push(stmtTierAsManifest(input));
    } else if (owner === "console") {
      item.action = "release-claim";
      writes.push(stmtRowSource("tiers", slug, t.id, "manifest"));
    }
    items.push(differs(item));
  }
  for (const stored of state.tiers) {
    if (declaredTiers.has(stored.id)) continue;
    const console = stored.source === "console";
    items.push({
      kind: "tier",
      key: stored.id,
      class: "not-declared",
      owner: console ? "console" : "manifest",
      before: tierView(storedTierColumns(stored)),
      action: console ? "none" : "mark-console",
    });
    if (!console)
      writes.push(stmtRowSource("tiers", slug, stored.id, "console"));
  }

  // ── row-backed claimable settings (LX-06: the value is the `product_settings` row) ──────
  for (const def of opts.rowSettings ?? []) {
    const row =
      state.settings.find((r) => r.key === def.key && r.value_json !== null) ??
      null;
    const stored = row ? parseJson(row.value_json) : null;
    if (def.declared === undefined) {
      // Not declared: a console row stays a console row; a manifest row is the resync's to clear
      // (omit-clears). Nothing to report when there is no row at all.
      if (!row) continue;
      items.push({
        kind: "setting",
        key: def.key,
        class: "not-declared",
        owner: row.source === "console" ? "console" : "manifest",
        before: stored,
        action: "none",
        ...(row.source === "manifest"
          ? {
              note: "omit-clears: the next resync removes the manifest row and the default applies",
            }
          : {}),
      });
      continue;
    }
    const breakGlass =
      row !== null &&
      row.source === "console" &&
      row.expires_at !== null &&
      row.expires_at > now;
    const cls: BackfillClass =
      row && canonical(stored) === canonical(def.declared)
        ? "equal"
        : "differs";
    const item: BackfillItem = {
      kind: "setting",
      key: def.key,
      class: cls,
      owner: breakGlass
        ? "break-glass"
        : row?.source === "console"
          ? "console"
          : "manifest",
      before: stored,
      manifest: def.declared,
      ...(row?.source === "console" ? { claim: claimOf(row) } : {}),
      action: "none",
    };
    if (!def.fits) {
      item.action = "keep";
      item.note =
        "the manifest's value is outside the registry's bounds, so no apply writes it";
    } else if (breakGlass) {
      item.action = "keep";
      item.note = BREAK_GLASS_NOTE;
    } else if (cls === "differs" || row?.source === "console") {
      item.action = cls === "differs" ? "revert" : "release-claim";
      writes.push(stmtRowSettingAsManifest(slug, def.key, def.declared, now));
    }
    items.push(differs(item));
  }

  // ── the services marker (an existing `*_source` column, S-18 §4.14.1) ──────────────────
  {
    const stored = parseServices(product.services_json ?? null);
    const servicesView = (
      services: Record<string, { enabled: boolean }>,
      registration: unknown,
    ) => ({
      enabled: Object.keys(services)
        .filter((s) => services[s]?.enabled)
        .sort(),
      ...(registration !== undefined ? { registration } : {}),
    });
    const before = servicesView(stored.services, stored.registration);
    const declared = servicesView(manifest.services, manifest.registration);
    const cls: BackfillClass =
      canonical(before) === canonical(declared) ? "equal" : "differs";
    const claimed = product.services_source === "admin";
    const item: BackfillItem = {
      kind: "marker",
      key: "services",
      class: cls,
      owner: claimed ? "console" : "manifest",
      before,
      manifest: declared,
      action: "none",
    };
    if (!claimed) {
      if (cls === "differs")
        item.note = "manifest-owned: the next resync applies it";
    } else if (system && cls === "equal") {
      item.action = "reset-marker";
      item.note =
        "the bootstrap's services_source = 'admin' is reset: the stored services equal the root .pkey/";
      writes.push({
        sql: `UPDATE products SET services_source = 'manifest'
                WHERE slug = ? AND services_source = 'admin'`,
        params: [slug],
      });
    } else {
      item.action = "keep";
      item.note = system
        ? "the stored services differ from the root .pkey/: switch them in the console to match (or commit the change to .pkey/), and a later backfill resets the marker"
        : "an existing claim marker (services_source = 'admin'), left as it is (S-18 §4.14.1)";
    }
    items.push(differs(item));
  }

  if (columns.length > 0)
    writes.unshift({
      sql: `UPDATE products SET ${columns.map(([c]) => `${c} = ?`).join(", ")}, modified_at = ?
              WHERE slug = ?`,
      params: [...columns.map(([, v]) => v), now, slug],
    });
  writes.unshift(...claimDrops);

  return {
    items,
    writes,
    changes: items.filter((i) => CHANGING.has(i.action)).length,
  };
}

/** Drop a console claim at the version classified (the state guard makes that exact). */
function stmtDropClaim(
  product: string,
  key: ClaimKey,
  version: number,
): DbStatement {
  return {
    sql: `DELETE FROM product_settings
            WHERE product = ? AND key = ? AND source = 'console' AND version = ?`,
    params: [product, key, version],
  };
}

/** A row-backed setting set to the manifest's value and handed to the manifest. */
function stmtRowSettingAsManifest(
  product: string,
  key: string,
  value: unknown,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO product_settings
            (product, key, value_json, source, version, updated_at, updated_by, reason, expires_at)
          VALUES (?, ?, ?, 'manifest', 1, ?, 'backfill', NULL, NULL)
          ON CONFLICT(product, key) DO UPDATE SET
            value_json = excluded.value_json, source = 'manifest',
            version = product_settings.version + 1, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by, reason = NULL, expires_at = NULL`,
    params: [product, key, JSON.stringify(value), now],
  };
}

/** A new active catalog version with the manifest's catalog, exactly as a resync publishes one. */
function catalogPublishStatements(
  product: string,
  catalog: unknown,
  now: number,
): DbStatement[] {
  return [
    {
      sql: "UPDATE product_schema SET active = 0 WHERE product = ?",
      params: [product],
    },
    {
      sql: `INSERT INTO product_schema (product, catalog_version, catalog_json, active, created_at)
            SELECT ?, next.v, ?, 1, ?
              FROM (SELECT COALESCE(MAX(catalog_version), 0) + 1 AS v
                      FROM product_schema WHERE product = ?) AS next`,
      params: [product, JSON.stringify(catalog), now, product],
    },
  ];
}

/** A declared profile written with the manifest's values and handed to the manifest. */
function stmtProfileAsManifest(
  product: string,
  p: ManifestProfile,
  payload: Record<string, unknown>,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at, source)
          VALUES (?, ?, ?, ?, ?, NULL, ?, 'manifest')
          ON CONFLICT(product, id) DO UPDATE SET
            name = excluded.name, description = excluded.description,
            payload_json = excluded.payload_json, modified_by = NULL,
            modified_at = excluded.modified_at, source = 'manifest'`,
    params: [
      product,
      p.id,
      p.name,
      p.description ?? null,
      JSON.stringify(payload),
      now,
    ],
  };
}

/** A declared tier written with the manifest's values and handed to the manifest. */
function stmtTierAsManifest(
  input: Parameters<typeof stmtInsertTier>[0],
): DbStatement {
  return {
    sql: `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit,
             channels_json, min_version, max_version, policy_fingerprint, modified_by, modified_at,
             source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'manifest')
          ON CONFLICT(product, id) DO UPDATE SET
            label = excluded.label, profile_id = excluded.profile_id,
            policy_expiry_days = excluded.policy_expiry_days,
            policy_device_limit = excluded.policy_device_limit,
            channels_json = excluded.channels_json, min_version = excluded.min_version,
            max_version = excluded.max_version, policy_fingerprint = excluded.policy_fingerprint,
            modified_by = NULL, modified_at = excluded.modified_at, source = 'manifest'`,
    params: stmtInsertTier(input).params,
  };
}

/** Hand a tier or profile row to the manifest or the console without touching its values. */
function stmtRowSource(
  table: "tiers" | "profiles",
  product: string,
  id: string,
  source: "manifest" | "console",
): DbStatement {
  return {
    sql: `UPDATE ${table} SET source = ? WHERE product = ? AND id = ?`,
    params: [source, product, id],
  };
}

// ── The state guard ─────────────────────────────────────────────────────────────────────

/**
 * One string that changes whenever a console write the backfill could revert lands: the product
 * row (every product PATCH and services write bumps `modified_at`), its claims (a claim, re-claim
 * or Revert changes their count, version sum or newest `updated_at`), its tiers and profiles (a
 * create or delete changes the count, an edit the newest `modified_at`, a source flip the console
 * count) and its catalog versions. Binds the product slug six times (`stateTokenParams`).
 *
 * Granularity is the second: two edits to the same row in the same second, one on each side of
 * the read, are indistinguishable. That window is far narrower than the GitHub round trips the
 * guard exists for.
 */
export const STATE_TOKEN_SQL = `(
  (SELECT COALESCE(modified_at, 0) || '/' || COALESCE(services_source, '') || '/' ||
          COALESCE(admin_group, '') FROM products WHERE slug = ?)
  || '|' || (SELECT COUNT(*) || ':' || COALESCE(SUM(version), 0) || ':' ||
                    COALESCE(MAX(updated_at), 0) FROM product_settings WHERE product = ?)
  || '|' || (SELECT COUNT(*) || ':' || COALESCE(MAX(modified_at), 0) || ':' ||
                    COALESCE(SUM(CASE WHEN source = 'console' THEN 1 ELSE 0 END), 0)
               FROM tiers WHERE product = ?)
  || '|' || (SELECT COUNT(*) || ':' || COALESCE(MAX(modified_at), 0) || ':' ||
                    COALESCE(SUM(CASE WHEN source = 'console' THEN 1 ELSE 0 END), 0)
               FROM profiles WHERE product = ?)
  || '|' || (SELECT COALESCE(MAX(catalog_version), 0) || ':' ||
                    COALESCE(SUM(active), 0) FROM product_schema WHERE product = ?)
  || '|' || (SELECT COUNT(*) FROM product_manifest_snapshot WHERE product = ?)
)`;

export function stateTokenParams(product: string): string[] {
  return [product, product, product, product, product, product];
}

/** The product's current state token (`STATE_TOKEN_SQL`). */
export async function readStateToken(db: Db, product: string): Promise<string> {
  const row = await db.first<{ token: string | null }>(
    `SELECT ${STATE_TOKEN_SQL} AS token`,
    ...stateTokenParams(product),
  );
  return row?.token ?? "";
}

// ── Evidence ────────────────────────────────────────────────────────────────────────────

/** The console audit rows newer than `since` that can explain a difference, newest first. */
export function readEvidence(
  db: Db,
  product: string,
  since: number,
): Promise<AuditRow[]> {
  return db.all<AuditRow>(
    `SELECT * FROM audit
      WHERE product = ? AND at > ?
        AND action IN (${EVIDENCE_ACTIONS.map(() => "?").join(", ")})
      ORDER BY at DESC, id DESC
      LIMIT 500`,
    product,
    since,
    ...EVIDENCE_ACTIONS,
  );
}

// ── Stored reports ──────────────────────────────────────────────────────────────────────

/** A stored report row, as D1 returns it. */
export interface BackfillReportRow {
  product: string;
  id: string;
  at: number;
  mode: BackfillMode;
  outcome: BackfillOutcome;
  batch_id: string | null;
  commit_sha: string | null;
  changes: number;
  actor_sub: string | null;
  actor_name: string | null;
  report_json: string;
}

/** A fresh report id. */
export function newReportId(): string {
  return randomId("sbf");
}

/** A fresh platform batch id. */
export function newBatchId(): string {
  return randomId("sbb");
}

/**
 * The insert for one report. With `guard` (the apply), the row is inserted only while the
 * product's state token still equals `guard.token`; otherwise `report_json` is NULL and the NOT
 * NULL constraint aborts the whole batch (see the module comment). It must be the batch's FIRST
 * statement, so the token is compared before any of the apply's own writes change it.
 */
export function stmtInsertReport(
  report: BackfillReport,
  guard?: { token: string },
): DbStatement {
  const commit = report.source?.commit ?? null;
  const values = [
    report.product,
    report.id,
    report.at,
    report.mode,
    report.outcome,
    report.batchId,
    commit,
    report.changes,
    report.actor.sub,
    report.actor.name,
  ];
  const json = JSON.stringify(report);
  if (!guard)
    return {
      sql: `INSERT INTO settings_backfill_reports
              (product, id, at, mode, outcome, batch_id, commit_sha, changes, actor_sub,
               actor_name, report_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [...values, json],
    };
  return {
    sql: `INSERT INTO settings_backfill_reports
            (product, id, at, mode, outcome, batch_id, commit_sha, changes, actor_sub,
             actor_name, report_json)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 CASE WHEN ${STATE_TOKEN_SQL} = ? THEN ? ELSE NULL END`,
    params: [...values, ...stateTokenParams(report.product), guard.token, json],
  };
}

/** Parse a stored row back into its report (`null` for a row that does not parse). */
export function reportOf(row: BackfillReportRow): BackfillReport | null {
  const parsed = parseJson(row.report_json);
  return parsed && typeof parsed === "object"
    ? (parsed as BackfillReport)
    : null;
}

/** A product's reports, newest first. */
export function listReports(
  db: Db,
  product: string,
  limit = 20,
): Promise<BackfillReportRow[]> {
  return db.all<BackfillReportRow>(
    `SELECT * FROM settings_backfill_reports WHERE product = ?
      ORDER BY at DESC, id DESC LIMIT ?`,
    product,
    limit,
  );
}

/** One report by id. */
export function getReport(
  db: Db,
  product: string,
  id: string,
): Promise<BackfillReportRow | null> {
  return db.first<BackfillReportRow>(
    "SELECT * FROM settings_backfill_reports WHERE product = ? AND id = ?",
    product,
    id,
  );
}

/** Every product's newest report (the platform view), without the report bodies. */
export function latestReportPerProduct(
  db: Db,
): Promise<Omit<BackfillReportRow, "report_json">[]> {
  return db.all<Omit<BackfillReportRow, "report_json">>(
    `SELECT r.product, r.id, r.at, r.mode, r.outcome, r.batch_id, r.commit_sha, r.changes,
            r.actor_sub, r.actor_name
       FROM settings_backfill_reports r
      WHERE r.id = (SELECT id FROM settings_backfill_reports x
                     WHERE x.product = r.product ORDER BY x.at DESC, x.id DESC LIMIT 1)
      ORDER BY r.product`,
  );
}

// ── The audit row ───────────────────────────────────────────────────────────────────────

/** The longest summary the apply's one audit row carries; the report holds the rest. */
const SUMMARY_MAX = 2000;

function describe(item: BackfillItem): string {
  const name =
    item.kind === "setting"
      ? item.key
      : item.kind === "marker"
        ? `${item.key} marker`
        : `${item.kind} ${item.key}`;
  switch (item.action) {
    case "revert":
      if (item.kind === "setting" && item.key !== "config.catalog")
        return `${name}: ${auditValue(item.before)} → ${auditValue(item.manifest)}${item.owner === "console" ? " (claim dropped)" : ""}`;
      return `${name}: reverted to the manifest (${(item.changed ?? []).join(", ")})`;
    case "release-claim":
      return `${name}: console claim dropped (value already the manifest's)`;
    case "mark-console":
      return `${name}: kept as a console row (not declared)`;
    case "reset-marker":
      return `${name}: admin → manifest`;
    default:
      return name;
  }
}

/**
 * The apply's ONE audit row (`setting.backfill`): every changed value with before and after, as
 * far as `SUMMARY_MAX` allows, and the report id that holds the full record.
 */
export function stmtBackfillAudit(
  report: BackfillReport,
  actor: AuditActor,
): DbStatement {
  const at = report.source?.commit
    ? ` at ${report.source.commit.slice(0, 12)}`
    : "";
  const changed = report.items.filter((i) => CHANGING.has(i.action));
  const head = `Settings backfill${at}: ${changed.length} change${changed.length === 1 ? "" : "s"}${report.snapshot === "written" ? ", manifest snapshot recorded" : ""}`;
  const tail = ` (report ${report.id})`;
  let body = "";
  let shown = 0;
  for (const item of changed) {
    const next = `${shown === 0 ? ": " : "; "}${describe(item)}`;
    if (
      head.length + body.length + next.length + tail.length + 40 >
      SUMMARY_MAX
    )
      break;
    body += next;
    shown++;
  }
  const more =
    shown < changed.length ? `; and ${changed.length - shown} more` : "";
  return {
    sql: `INSERT INTO audit
            (product, id, at, actor_sub, actor_name, actor_email, action, target_kind,
             target_id, parent_id, summary)
          VALUES (?, ?, ?, ?, ?, ?, 'setting.backfill', 'product', ?, NULL, ?)`,
    params: [
      report.product,
      randomId("aud"),
      report.at,
      actor.sub,
      actor.name,
      actor.email,
      report.product,
      `${head}${body}${more}${tail}`,
    ],
  };
}
