/// <reference types="@cloudflare/workers-types" />

/**
 * The shared listing model's admin surface (A-18b; notes/S-15 §7, §8.2) —
 * `/manage/api/products/<slug>/distribution/listing…`:
 *
 *     GET  …/distribution/listing                          the model: app fields, locales,
 *                                                          overrides, assets, precedence, and the
 *                                                          limits, slots and stores the editor
 *                                                          needs
 *     PUT  …/distribution/listing                          { app?, locales?: {<locale>: {…} |
 *                                                          null}, precedence? } (`null` clears a
 *                                                          field, removes a locale, resets the
 *                                                          precedence); creating the listing
 *                                                          needs `app.defaultLocale`
 *     PUT  …/distribution/listing/overrides                { store, locale?, field, value } —
 *                                                          `value: null` removes it
 *     GET  …/distribution/listing/release-notes/<release>  the release's store notes per locale
 *                                                          (stored, or the default from its
 *                                                          release notes) with a proposed short cut
 *     PUT  …/distribution/listing/release-notes/<release>  { locale, text, short? } — `text: null`
 *                                                          removes the locale's notes
 *     GET  …/distribution/listing/fit[?release=<id>]       the fit report: per store, per field and
 *                                                          locale, green, amber or red, and the
 *                                                          payload when nothing blocks
 *     POST …/distribution/listing/import                   { sources: [{source, outlet?, godot?}]
 *                                                          (or one `source`), locale?, overwrite?,
 *                                                          confirm?, fields? } — without `confirm`
 *                                                          the field-by-field diff of an import
 *                                                          from the stores, the Godot project,
 *                                                          `.pkey/distribution` or `.pkey/product`;
 *                                                          with the diff's `digest` as `confirm`,
 *                                                          apply it (A-18c, `import.ts`)
 *
 * Narrative-only like the rest of the console API (`routeCoverage`'s `adminApi` kind); session,
 * CSRF, rate limit and the platform-admin gate run in `admin/api.ts` first. Every write is
 * audited (`distribution.listing.*`) with the fields it changed, never their text. Every value is
 * validated against the model's limits (`core/storefront/listingModel.ts`) and refused, never cut;
 * a store's tighter limit is the fit report's to show.
 */

import { ErrorCode } from "../../../core/errors.js";
import type { ServiceContext } from "../../../core/registry.js";
import type { AdminSession } from "../../../core/adminApi.js";
import { adminJson, audit, err, readBody } from "../../../core/adminApi.js";
import {
  appProblems,
  DEFAULT_PRECEDENCE,
  LISTING_ASSET_SLOTS,
  LISTING_LIMITS,
  localeProblem,
  localeTextProblems,
  MODEL_FIELDS,
  overrideProblems,
  precedenceProblems,
  PRECEDENCE_FIELDS,
  releaseNotesProblems,
  type ListingModel,
  type ModelProblem,
} from "../../../core/storefront/listingModel.js";
import {
  LISTING_STORES,
  STORE_LISTING_COLUMNS,
  type ListingStore,
} from "../../../core/storefront/listingProfiles.js";
import { fitReport } from "../../../core/storefront/projection.js";
import type { DbStatement } from "../../../core/platform.js";
import { FEED_LISTING_STORES } from "./feed.js";
import {
  importSummary,
  isImportSource,
  runImport,
  type SourceSpec,
} from "./import.js";
import { notesForProjection, releaseNotesView } from "./notes.js";
import {
  countOverrides,
  deleteOverride,
  deleteReleaseNotes,
  listAssets,
  localeOf,
  overrideOf,
  precedenceOf,
  provenanceAfterEdit,
  provenanceOf,
  readListing,
  stmtDeleteLocale,
  stmtUpsertListing,
  stmtUpsertLocale,
  upsertOverride,
  upsertReleaseNotes,
  type StoredListing,
} from "./store.js";

type AdminCtx = ServiceContext & { session: AdminSession };

/** The stores an override may name: every listing column and the two feeds that read the model. */
export const OVERRIDE_STORES: readonly string[] = [
  ...LISTING_STORES,
  ...FEED_LISTING_STORES,
];

/** The locale the model falls back to before a listing exists. */
const FALLBACK_LOCALE = "en-US";

function invalid(problems: ModelProblem[]): Response {
  return err(422, ErrorCode.BadRequest, problems[0]!.message, {
    reason: "invalid_listing",
    fields: problems.map((p) => p.field),
    problems,
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function view(ctx: AdminCtx, stored: StoredListing | null) {
  const { db, product } = ctx;
  const precedence = precedenceOf(stored?.row ?? null);
  return {
    listing: stored
      ? {
          app: stored.model.app,
          source: stored.row.source,
          provenance: provenanceOf(
            stored.row,
            stored.model.app as unknown as Record<string, unknown>,
          ),
          createdAt: stored.row.created_at,
          modifiedAt: stored.row.modified_at,
          modifiedBy: stored.row.modified_by,
        }
      : null,
    locales: (stored?.locales ?? []).map((r) => ({
      locale: r.locale,
      ...localeOf(r),
      source: r.source,
      provenance: provenanceOf(r, localeOf(r) as Record<string, unknown>),
      modifiedAt: r.modified_at,
      modifiedBy: r.modified_by,
    })),
    overrides: (stored?.overrides ?? []).map((r) => ({
      ...overrideOf(r),
      source: r.source,
      modifiedAt: r.modified_at,
      modifiedBy: r.modified_by,
    })),
    assets: (await listAssets(db, product.slug)).map((a) => ({
      slot: a.slot,
      locale: a.locale === "" ? null : a.locale,
      blob: a.blob,
      sha256: a.sha256,
      width: a.width,
      height: a.height,
      alpha: a.alpha === 1,
      derivedFrom: a.derived_from,
      textAllowed: a.text_allowed,
      source: a.source,
      modifiedAt: a.modified_at,
    })),
    precedence: Object.fromEntries(
      PRECEDENCE_FIELDS.map((f) => [
        f,
        { order: precedence[f] ?? DEFAULT_PRECEDENCE, custom: f in precedence },
      ]),
    ),
    limits: LISTING_LIMITS,
    slots: LISTING_ASSET_SLOTS,
    stores: LISTING_STORES.map((s) => ({
      store: s,
      label: STORE_LISTING_COLUMNS[s].label,
    })),
    overrideStores: OVERRIDE_STORES,
    modelFields: MODEL_FIELDS,
  };
}

/** Distribution's `listing` admin routes; `null` when the path is not one. */
export async function handleListingAdmin(
  ctx: AdminCtx,
): Promise<Response | null> {
  const { req, rest } = ctx;
  if (rest[0] !== "listing") return null;
  const method = req.method;
  const sub = rest[1];
  const notAllowed = () => err(405, ErrorCode.BadRequest, "method not allowed");

  if (rest.length === 1) {
    if (method === "GET")
      return adminJson(
        await view(ctx, await readListing(ctx.db, ctx.product.slug)),
      );
    if (method === "PUT") return putListing(ctx);
    return notAllowed();
  }
  if (sub === "overrides" && rest.length === 2)
    return method === "PUT" ? putOverride(ctx) : notAllowed();
  if (sub === "fit" && rest.length === 2)
    return method === "GET" ? getFit(ctx) : notAllowed();
  if (sub === "import" && rest.length === 2)
    return method === "POST" ? postImport(ctx) : notAllowed();
  if (sub === "release-notes" && rest.length === 3) {
    if (method === "GET") return getNotes(ctx, rest[2]!);
    if (method === "PUT") return putNotes(ctx, rest[2]!);
    return notAllowed();
  }
  return null;
}

/** Touch the listing row so the feeds' cache stamp moves with any listing write. */
function stmtTouch(ctx: AdminCtx): DbStatement {
  return {
    sql: "UPDATE dist_listings SET modified_at = ?, modified_by = ? WHERE product = ?",
    params: [ctx.now, ctx.session.sub, ctx.product.slug],
  };
}

async function putListing(ctx: AdminCtx): Promise<Response> {
  const { db, product, session, now } = ctx;
  const slug = product.slug;
  const body = await readBody(ctx.req);
  const known = new Set(["app", "locales", "precedence"]);
  const stray = Object.keys(body).filter((k) => !known.has(k));
  if (stray.length)
    return invalid(
      stray.map((k) => ({ field: k, message: `${k} is not a listing part` })),
    );
  const existing = await readListing(db, slug);
  const app = body.app === undefined ? {} : body.app;
  if (!isRecord(app))
    return invalid([{ field: "app", message: "app must be an object" }]);
  const problems = appProblems(app, existing === null);
  const locales = body.locales === undefined ? {} : body.locales;
  if (!isRecord(locales))
    return invalid([
      { field: "locales", message: "locales must be an object" },
    ]);
  for (const [locale, patch] of Object.entries(locales)) {
    if (localeProblem(locale)) {
      problems.push({
        field: `locales.${locale}`,
        message: `${locale} is not a locale code such as en-US`,
      });
      continue;
    }
    if (patch === null) continue;
    if (!isRecord(patch)) {
      problems.push({
        field: `locales.${locale}`,
        message: `locales.${locale} must be an object or null`,
      });
      continue;
    }
    problems.push(...localeTextProblems(locale, patch));
  }
  if (body.precedence !== undefined)
    problems.push(...precedenceProblems(body.precedence));
  if (problems.length) return invalid(problems);

  const have = new Set((existing?.locales ?? []).map((l) => l.locale));
  for (const [locale, patch] of Object.entries(locales))
    if (patch === null) have.delete(locale);
    else have.add(locale);
  if (have.size > LISTING_LIMITS.locales)
    return invalid([
      {
        field: "locales",
        message: `a listing has at most ${LISTING_LIMITS.locales} locales`,
      },
    ]);

  const defaultLocale =
    (app.defaultLocale as string | undefined) ??
    existing?.row.default_locale ??
    FALLBACK_LOCALE;
  // An operator's edit owns what it changed: those fields lose their import source (A-18c).
  const appBefore = (existing?.model.app ?? {}) as unknown as Record<
    string,
    unknown
  >;
  const stmts: DbStatement[] = [
    stmtUpsertListing(
      slug,
      app,
      body.precedence as Record<string, unknown> | null | undefined,
      "admin",
      session.sub,
      now,
      defaultLocale,
      provenanceAfterEdit(
        provenanceOf(existing?.row ?? null, appBefore),
        appBefore,
        app,
      ),
    ),
  ];
  const changedLocales: string[] = [];
  const removedLocales: string[] = [];
  for (const [locale, patch] of Object.entries(locales)) {
    if (patch === null) {
      if (existing?.locales.some((l) => l.locale === locale)) {
        stmts.push(stmtDeleteLocale(slug, locale));
        removedLocales.push(locale);
      }
      continue;
    }
    const row = existing?.locales.find((l) => l.locale === locale) ?? null;
    const before = (row ? localeOf(row) : {}) as Record<string, unknown>;
    stmts.push(
      stmtUpsertLocale(
        slug,
        locale,
        patch as Record<string, unknown>,
        "admin",
        session.sub,
        now,
        provenanceAfterEdit(
          provenanceOf(row, before),
          before,
          patch as Record<string, unknown>,
        ),
      ),
    );
    changedLocales.push(locale);
  }
  await db.batch(stmts);

  const parts = [
    ...Object.keys(app).map((k) => `app.${k}`),
    ...changedLocales.map(
      (l) =>
        `${l} (${Object.keys(locales[l] as object).join(", ") || "created"})`,
    ),
    ...removedLocales.map((l) => `${l} removed`),
    ...(body.precedence !== undefined ? ["precedence"] : []),
  ];
  await audit(
    db,
    slug,
    session,
    now,
    "distribution.listing.update",
    { kind: "listing", id: slug },
    `${existing ? "Updated" : "Created"} the store listing${parts.length ? `: ${parts.join("; ")}` : ""}`,
  );
  return adminJson(await view(ctx, await readListing(db, slug)));
}

async function putOverride(ctx: AdminCtx): Promise<Response> {
  const { db, product, session, now } = ctx;
  const slug = product.slug;
  const body = await readBody(ctx.req);
  const problems = overrideProblems(body, OVERRIDE_STORES);
  if (problems.length) return invalid(problems);
  if (!(await readListing(db, slug)))
    return err(409, ErrorCode.BadRequest, "the product has no listing yet", {
      reason: "no_listing",
    });
  const key = {
    store: body.store as string,
    locale: (body.locale as string | null | undefined) ?? null,
    field: body.field as string,
  };
  const target = {
    kind: "listing_override",
    id: `${key.store}/${key.locale ?? "*"}/${key.field}`,
  };
  if (body.value === null) {
    if (!(await deleteOverride(db, slug, key)))
      return err(404, ErrorCode.NotFound, "no such override", {
        reason: "unknown_override",
      });
    await db.batch([stmtTouch(ctx)]);
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.listing.override.remove",
      target,
      `Removed the ${key.store} override of ${key.field}${key.locale ? ` (${key.locale})` : ""}`,
    );
  } else {
    const exists = (await readListing(db, slug))!.overrides.some(
      (o) =>
        o.store === key.store &&
        o.locale === (key.locale ?? "") &&
        o.field === key.field,
    );
    if (!exists && (await countOverrides(db, slug)) >= LISTING_LIMITS.overrides)
      return invalid([
        {
          field: "store",
          message: `a listing has at most ${LISTING_LIMITS.overrides} overrides`,
        },
      ]);
    await upsertOverride(
      db,
      slug,
      { ...key, value: body.value as string | string[] },
      "admin",
      session.sub,
      now,
    );
    await db.batch([stmtTouch(ctx)]);
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.listing.override",
      target,
      `Set the ${key.store} override of ${key.field}${key.locale ? ` (${key.locale})` : ""}`,
    );
  }
  return adminJson(await view(ctx, await readListing(db, slug)));
}

async function notesFor(ctx: AdminCtx, releaseId: string) {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const stored = await readListing(ctx.db, ctx.product.slug);
  return releaseNotesView(
    ctx.db,
    catalog,
    ctx.product.slug,
    releaseId,
    stored?.row.default_locale ?? FALLBACK_LOCALE,
  );
}

const unknownRelease = (releaseId: string) =>
  err(404, ErrorCode.NotFound, `no release ${releaseId}`, {
    reason: "unknown_release",
  });

async function getNotes(ctx: AdminCtx, releaseId: string): Promise<Response> {
  const v = await notesFor(ctx, releaseId);
  if (!v) return unknownRelease(releaseId);
  return adminJson({
    notes: v,
    limits: {
      short: LISTING_LIMITS.releaseNotesShort,
      text: LISTING_LIMITS.releaseNotes,
    },
  });
}

async function putNotes(ctx: AdminCtx, releaseId: string): Promise<Response> {
  const { db, product, session, now } = ctx;
  const slug = product.slug;
  const body = await readBody(ctx.req);
  const locale = body.locale;
  if (localeProblem(locale))
    return invalid([
      { field: "locale", message: "locale must be a code such as en-US" },
    ]);
  const before = await notesFor(ctx, releaseId);
  if (!before) return unknownRelease(releaseId);
  if (body.text === null) {
    if (!(await deleteReleaseNotes(db, slug, releaseId, locale as string)))
      return err(404, ErrorCode.NotFound, "no stored notes in that locale", {
        reason: "unknown_notes",
      });
    await db.batch([stmtTouch(ctx)]);
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.listing.notes.remove",
      { kind: "release", id: releaseId },
      `Removed the ${locale as string} store notes of ${before.version}`,
    );
  } else {
    const problems = releaseNotesProblems(body);
    if (problems.length) return invalid(problems);
    await upsertReleaseNotes(
      db,
      slug,
      releaseId,
      locale as string,
      {
        text: body.text as string,
        short: (body.short as string | null | undefined) ?? null,
      },
      "admin",
      session.sub,
      now,
    );
    await db.batch([stmtTouch(ctx)]);
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.listing.notes",
      { kind: "release", id: releaseId },
      `Set the ${locale as string} store notes of ${before.version}${body.short ? " (with a short form)" : ""}`,
    );
  }
  return adminJson({ notes: await notesFor(ctx, releaseId) });
}

async function getFit(ctx: AdminCtx): Promise<Response> {
  const url = new URL(ctx.req.url);
  const releaseId = url.searchParams.get("release");
  const storeParam = url.searchParams.get("store");
  if (
    storeParam !== null &&
    !(LISTING_STORES as readonly string[]).includes(storeParam)
  )
    return invalid([
      {
        field: "store",
        message: `store must be one of ${LISTING_STORES.join(", ")}`,
      },
    ]);
  const stored = await readListing(ctx.db, ctx.product.slug);
  const model: ListingModel = stored?.model ?? {
    app: { defaultLocale: FALLBACK_LOCALE },
    locales: {},
    overrides: [],
  };
  let notes = null;
  if (releaseId !== null) {
    const v = await notesFor(ctx, releaseId);
    if (!v) return unknownRelease(releaseId);
    notes = notesForProjection(v);
  }
  const stores = storeParam ? [storeParam as ListingStore] : LISTING_STORES;
  return adminJson({
    exists: stored !== null,
    release: releaseId,
    stores: fitReport({ model, releaseNotes: notes }, stores),
  });
}

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_FIELDS = 1000;

/** The import request, validated: `{sources | source, outlet?, godot?, locale?, overwrite?,
 *  confirm?, fields?}`. */
function importRequest(body: Record<string, unknown>):
  | {
      ok: true;
      sources: SourceSpec[];
      locale: string | null;
      overwrite: boolean;
      confirm: string | null;
      fields: string[] | null;
    }
  | { ok: false; problems: ModelProblem[] } {
  const problems: ModelProblem[] = [];
  const known = new Set([
    "sources",
    "source",
    "outlet",
    "godot",
    "locale",
    "overwrite",
    "confirm",
    "fields",
  ]);
  for (const k of Object.keys(body))
    if (!known.has(k))
      problems.push({ field: k, message: `${k} is not part of an import` });
  let raw: unknown[];
  if (body.sources !== undefined) {
    if (
      body.source !== undefined ||
      body.outlet !== undefined ||
      body.godot !== undefined
    )
      problems.push({
        field: "sources",
        message:
          "name the sources either as sources or as one source, not both",
      });
    raw = Array.isArray(body.sources) ? body.sources : [];
    if (!Array.isArray(body.sources) || raw.length === 0)
      problems.push({
        field: "sources",
        message: "sources must be a non-empty list",
      });
  } else
    raw = [
      {
        source: body.source,
        ...(body.outlet !== undefined ? { outlet: body.outlet } : {}),
        ...(body.godot !== undefined ? { godot: body.godot } : {}),
      },
    ];
  const sources: SourceSpec[] = [];
  const seen = new Set<string>();
  raw.forEach((r, i) => {
    const at = body.sources !== undefined ? `sources[${i}]` : "source";
    if (!isRecord(r) || !isImportSource(r.source)) {
      problems.push({
        field: at,
        message: `${at} must be one of app-store, play, ms-store, godot, manifest, product`,
      });
      return;
    }
    if (seen.has(r.source)) {
      problems.push({ field: at, message: `${r.source} is named twice` });
      return;
    }
    seen.add(r.source);
    const stray = Object.keys(r).filter(
      (k) =>
        k !== "source" &&
        !(k === "outlet" && r.source === "manifest") &&
        !(k === "godot" && r.source === "godot"),
    );
    if (stray.length) {
      problems.push({
        field: at,
        message: `${stray.join(", ")} does not go with source ${r.source}`,
      });
      return;
    }
    if (
      r.outlet !== undefined &&
      r.outlet !== null &&
      typeof r.outlet !== "string"
    ) {
      problems.push({ field: `${at}.outlet`, message: "outlet must be text" });
      return;
    }
    if (r.source === "godot" && !isRecord(r.godot)) {
      problems.push({
        field: `${at}.godot`,
        message: "a godot import carries what pkey listing import --godot read",
      });
      return;
    }
    sources.push({
      source: r.source,
      ...(r.outlet !== undefined ? { outlet: r.outlet as string | null } : {}),
      ...(r.godot !== undefined ? { godot: r.godot } : {}),
    });
  });
  if (
    body.locale !== undefined &&
    body.locale !== null &&
    typeof body.locale !== "string"
  )
    problems.push({ field: "locale", message: "locale must be text" });
  if (body.overwrite !== undefined && typeof body.overwrite !== "boolean")
    problems.push({
      field: "overwrite",
      message: "overwrite must be a boolean",
    });
  if (
    body.confirm !== undefined &&
    body.confirm !== null &&
    (typeof body.confirm !== "string" || !DIGEST.test(body.confirm))
  )
    problems.push({
      field: "confirm",
      message: "confirm must be the preview's digest",
    });
  if (
    body.fields !== undefined &&
    body.fields !== null &&
    (!Array.isArray(body.fields) ||
      body.fields.length > MAX_FIELDS ||
      !body.fields.every((f) => typeof f === "string" && f.length <= 200))
  )
    problems.push({
      field: "fields",
      message: "fields must be a list of field names",
    });
  if (
    body.fields != null &&
    (body.confirm === undefined || body.confirm === null)
  )
    problems.push({ field: "fields", message: "fields go with confirm" });
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    sources,
    locale: (body.locale as string | null | undefined) ?? null,
    overwrite: body.overwrite === true,
    confirm: (body.confirm as string | null | undefined) ?? null,
    fields: (body.fields as string[] | null | undefined) ?? null,
  };
}

async function postImport(ctx: AdminCtx): Promise<Response> {
  const { db, product, session, now } = ctx;
  const slug = product.slug;
  const req = importRequest(await readBody(ctx.req));
  if (!req.ok) return invalid(req.problems);
  const r = await runImport(
    {
      env: ctx.env,
      db,
      product: slug,
      hooks: ctx.hooks,
      now,
      actor: session.sub,
    },
    req,
  );
  if (!r.ok)
    return err(
      r.status,
      r.status === 404 ? ErrorCode.NotFound : ErrorCode.BadRequest,
      r.message,
      {
        reason: r.reason,
        ...(r.problems
          ? { fields: r.problems.map((p) => p.field), problems: r.problems }
          : {}),
        ...(r.preview ? { import: r.preview } : {}),
      },
    );
  if (r.result.written.length)
    await audit(
      db,
      slug,
      session,
      now,
      "distribution.listing.import",
      { kind: "listing", id: slug },
      importSummary(r.result),
    );
  return adminJson({
    import: r.result,
    ...(await view(ctx, await readListing(db, slug))),
  });
}
