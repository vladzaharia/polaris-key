/**
 * IMPORTING INTO THE SHARED LISTING (A-18b's manifest import, generalised by A-18c; notes/S-15
 * §7.2). An import is an explicit operator action in two steps, never a manifest ingest:
 *
 *   1. PREVIEW. The named sources are read (`sources.ts`: the App Store, Google Play and the
 *      Microsoft Store through their adapters' `readListing`, the Godot project the CLI uploaded,
 *      `.pkey/distribution`, `.pkey/product`) and lined up against the model by precedence
 *      (`planImport`, `core/storefront/listingImport.ts`). The answer is a field-by-field diff —
 *      `add`, `replace` or `keep`, with the current value, who wrote it, the proposed value and
 *      the source it came from — plus what the sources point at that the model does not store as
 *      text (assets, version and bundle ids), and a `digest` of the diff. Nothing is written.
 *   2. APPLY. The same request with `confirm: <digest>` re-reads the sources, recomputes the diff
 *      and writes it only if the digest still matches (otherwise 409 `import_changed` with the
 *      fresh preview: what would be written is no longer what the operator saw). `fields` narrows
 *      the apply to some of the changes. Applied rows carry `source = 'import'` and each field's
 *      source in `provenance_json`; one `distribution.listing.import` audit row names the sources
 *      and the fields, never their text.
 *
 * Rules (S-15 §7.2, the A-18b brief): a value over the model's limit is refused and reported, never
 * cut; a value an operator typed is kept unless `overwrite`; a value an earlier import wrote is
 * replaced only by a source that ranks at least as high for that field ("the store that is live
 * wins", reorderable per field). Imports never write to a store: every store read goes through its
 * adapter's read path, under the same gate as everything else.
 */

import { parseJsonColumn } from "../../../platform/json.js";
import { sha256Hex } from "../../../platform/hash.js";
import type { Db, DbStatement } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import type { FetchImpl } from "../../../core/outletTokens.js";
import {
  canonicalJson,
  importWrite,
  planImport,
  selectChanges,
  type CurrentListing,
  type ImportChange,
  type ImportPlan,
  type ImportRefusal,
  type ImportSource,
  type ListingSnapshot,
  type SourceOutcome,
} from "../../../core/storefront/listingImport.js";
import { localeProblem } from "../../../core/storefront/listingModel.js";
import { listOutlets } from "../outlets.js";
import {
  appStoreSource,
  godotSnapshot,
  IMPORT_SOURCES,
  manifestSource,
  msStoreSource,
  playSource,
  productSource,
  type GodotProblem,
  type SourceContext,
} from "./sources.js";
import {
  localeOf,
  precedenceOf,
  provenanceOf,
  readListing,
  stmtUpsertListing,
  stmtUpsertLocale,
  type StoredListing,
} from "./store.js";

/** One source an import names. */
export interface SourceSpec {
  source: ImportSource;
  /** `manifest`: the outlet whose listing to read (else the first live one with a listing). */
  outlet?: string | null;
  /** `godot`: what the CLI read from the project. */
  godot?: unknown;
}

export interface ImportRequest {
  sources: SourceSpec[];
  /** A new listing's default locale, and the locale `.pkey/distribution`'s text goes to. */
  locale: string | null;
  overwrite: boolean;
  /** The preview's digest: apply. Null: preview only. */
  confirm: string | null;
  /** Apply only these changes (by `field`); null: every `add` and `replace`. */
  fields: string[] | null;
}

/** How one source fared. */
export interface SourceReport {
  source: ImportSource;
  ref: string | null;
  ok: boolean;
  reason?: string;
  message?: string;
}

/** A version or bundle id a source declares, beside what the outlets declare. */
export interface IdentifierReport {
  source: ImportSource;
  kind: "version" | "bundleId";
  platform: string;
  value: string;
  /** Outlets whose identity names the same kind of id, and whether it is this one. */
  outlets: { outlet: string; kind: string; value: string; matches: boolean }[];
}

export interface ImportPreview {
  applied: boolean;
  digest: string;
  createsListing: boolean;
  defaultLocale: string;
  sources: SourceReport[];
  changes: ImportChange[];
  refused: ImportRefusal[];
  skipped: { source: ImportSource; field: string; reason: string }[];
  /** Assets the sources point at: reported for `pkey listing assets` (A-18d), never written. */
  assets: (ListingSnapshot["assets"][number] & { source: ImportSource })[];
  identifiers: IdentifierReport[];
  /** After an apply: the fields written (empty for a preview). */
  written: string[];
}

export type ImportOutcome =
  | { ok: true; result: ImportPreview }
  | {
      ok: false;
      status: 404 | 409 | 422 | 502;
      reason: string;
      message: string;
      problems?: GodotProblem[];
      preview?: ImportPreview;
    };

export interface ImportContext {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
  actor: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}

/** The model as `planImport` reads it, with each row's provenance (legacy rows materialised). */
export function currentOf(stored: StoredListing | null): CurrentListing {
  if (!stored)
    return {
      exists: false,
      defaultLocale: null,
      app: {},
      locales: {},
      appProvenance: {},
      localeProvenance: {},
      precedence: {},
    };
  const { defaultLocale, ...app } = stored.model.app;
  return {
    exists: true,
    defaultLocale,
    app,
    locales: stored.model.locales,
    appProvenance: provenanceOf(
      stored.row,
      stored.model.app as unknown as Record<string, unknown>,
    ),
    localeProvenance: Object.fromEntries(
      stored.locales.map((r) => [
        r.locale,
        provenanceOf(r, localeOf(r) as Record<string, unknown>),
      ]),
    ),
    precedence: precedenceOf(stored.row),
  };
}

/** The digest an apply must echo: the diff exactly as shown (values, sources, actions). */
export async function planDigest(
  product: string,
  plan: ImportPlan,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      v: 1,
      product,
      createsListing: plan.createsListing,
      defaultLocale: plan.defaultLocale,
      changes: plan.changes.map((c) => ({
        field: c.field,
        action: c.action,
        current: c.current,
        currentSource: c.currentSource,
        proposed: c.proposed,
        proposedSource: c.proposedSource,
      })),
    }),
  );
}

async function readSource(
  ctx: ImportContext,
  spec: SourceSpec,
  textLocale: string,
): Promise<SourceOutcome | { ok: false; godot: GodotProblem[] }> {
  const sc: SourceContext = {
    env: ctx.env,
    db: ctx.db,
    product: ctx.product,
    hooks: ctx.hooks,
    now: ctx.now,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  };
  switch (spec.source) {
    case "app-store":
      return appStoreSource(sc);
    case "play":
      return playSource(sc);
    case "ms-store":
      return msStoreSource(sc);
    case "manifest":
      return manifestSource(
        ctx.db,
        ctx.product,
        spec.outlet ?? null,
        textLocale,
      );
    case "product":
      return productSource(ctx.db, ctx.product);
    case "godot": {
      const g = godotSnapshot(spec.godot);
      return g.ok ? g : { ok: false, godot: g.problems };
    }
  }
}

/** The identity key holding a bundle id, by the platform a source names it for. */
function identityKeyFor(platform: string): string {
  return platform === "android" ? "packageName" : "bundleId";
}

async function identifierReports(
  db: Db,
  product: string,
  snapshots: readonly ListingSnapshot[],
): Promise<IdentifierReport[]> {
  const outlets = (await listOutlets(db, product))
    .filter((o) => o.removed_at === null)
    .map((o) => {
      const id = parseJsonColumn(o.identity_json);
      return {
        outlet: o.outlet_id,
        kind: o.kind,
        identity:
          id && typeof id === "object" && !Array.isArray(id)
            ? (id as Record<string, unknown>)
            : {},
      };
    });
  const out: IdentifierReport[] = [];
  for (const s of snapshots)
    for (const i of s.identifiers) {
      const key = identityKeyFor(i.platform);
      out.push({
        source: s.source,
        ...i,
        outlets:
          i.kind === "bundleId"
            ? outlets
                .filter((o) => typeof o.identity[key] === "string")
                .map((o) => ({
                  outlet: o.outlet,
                  kind: o.kind,
                  value: o.identity[key] as string,
                  matches: o.identity[key] === i.value,
                }))
            : [],
      });
    }
  return out;
}

const MAX_AUDIT_FIELDS = 20;

/** Preview, or (with `confirm`) apply, one import. See the file comment. */
export async function runImport(
  ctx: ImportContext,
  req: ImportRequest,
): Promise<ImportOutcome> {
  if (req.locale !== null && localeProblem(req.locale))
    return {
      ok: false,
      status: 422,
      reason: "invalid_locale",
      message: "locale must be a code such as en-US",
    };
  const stored = await readListing(ctx.db, ctx.product);
  const current = currentOf(stored);
  const textLocale = req.locale ?? current.defaultLocale ?? "en-US";

  // The Godot upload is checked before any store is read: a malformed one costs no vendor call.
  for (const spec of req.sources)
    if (spec.source === "godot") {
      const g = godotSnapshot(spec.godot);
      if (!g.ok)
        return {
          ok: false,
          status: 422,
          reason: "invalid_import",
          message: g.problems[0]!.message,
          problems: g.problems,
        };
    }

  const reports: SourceReport[] = [];
  const snapshots: ListingSnapshot[] = [];
  let firstFailure: Extract<SourceOutcome, { ok: false }> | null = null;
  for (const spec of req.sources) {
    const r = await readSource(ctx, spec, textLocale);
    if ("godot" in r)
      return {
        ok: false,
        status: 422,
        reason: "invalid_import",
        message: r.godot[0]!.message,
        problems: r.godot,
      };
    if (r.ok) {
      snapshots.push(r.snapshot);
      reports.push({ source: spec.source, ref: r.snapshot.ref, ok: true });
    } else {
      firstFailure ??= r;
      reports.push({
        source: spec.source,
        ref: null,
        ok: false,
        reason: r.reason,
        message: r.message,
      });
    }
  }
  if (!snapshots.length && firstFailure)
    return {
      ok: false,
      status: firstFailure.status,
      reason: firstFailure.reason,
      message: firstFailure.message,
    };

  const plan = planImport(current, snapshots, {
    overwrite: req.overwrite,
    locale: req.locale,
  });
  const preview: ImportPreview = {
    applied: false,
    digest: await planDigest(ctx.product, plan),
    createsListing: plan.createsListing,
    defaultLocale: plan.defaultLocale,
    sources: reports,
    changes: plan.changes,
    refused: plan.refused,
    skipped: snapshots.flatMap((s) =>
      s.skipped.map((k) => ({ source: s.source, ...k })),
    ),
    assets: snapshots.flatMap((s) =>
      s.assets.map((a) => ({ ...a, source: s.source })),
    ),
    identifiers: await identifierReports(ctx.db, ctx.product, snapshots),
    written: [],
  };
  if (req.confirm === null) return { ok: true, result: preview };

  if (req.confirm !== preview.digest)
    return {
      ok: false,
      status: 409,
      reason: "import_changed",
      message:
        "the import no longer matches the preview you confirmed (a source or the listing changed): review the new diff and confirm it",
      preview,
    };
  const { selected, unknown } = selectChanges(plan, req.fields);
  if (unknown.length)
    return {
      ok: false,
      status: 422,
      reason: "unknown_fields",
      message: `not changes this import can apply: ${unknown.join(", ")}`,
      preview,
    };
  if (!selected.length)
    return { ok: true, result: { ...preview, applied: true } };

  const write = importWrite(current, selected);
  const stmts: DbStatement[] = [];
  if (Object.keys(write.app).length || !current.exists)
    stmts.push(
      stmtUpsertListing(
        ctx.product,
        write.app,
        undefined,
        "import",
        ctx.actor,
        ctx.now,
        plan.defaultLocale,
        write.appProvenance,
      ),
    );
  else
    // A locale-only import still moves the listing's stamp (the feeds' cache follows it).
    stmts.push({
      sql: "UPDATE dist_listings SET modified_at = ?, modified_by = ? WHERE product = ?",
      params: [ctx.now, ctx.actor, ctx.product],
    });
  for (const [locale, w] of Object.entries(write.locales))
    stmts.push(
      stmtUpsertLocale(
        ctx.product,
        locale,
        w.patch,
        "import",
        ctx.actor,
        ctx.now,
        w.provenance,
      ),
    );
  await ctx.db.batch(stmts);
  return {
    ok: true,
    result: {
      ...preview,
      applied: true,
      written: selected.map((c) => c.field),
    },
  };
}

/** The audit summary of an applied import: the sources and the fields, never their text. */
export function importSummary(result: ImportPreview): string {
  const sources = [
    ...new Set(
      result.changes
        .filter((c) => result.written.includes(c.field))
        .map((c) => c.proposedSource),
    ),
  ];
  const fields = result.written.slice(0, MAX_AUDIT_FIELDS);
  const more = result.written.length - fields.length;
  return `Imported the store listing from ${sources.join(", ")}: ${fields.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Whether `s` names an import source. */
export function isImportSource(s: unknown): s is ImportSource {
  return (IMPORT_SOURCES as readonly unknown[]).includes(s);
}
