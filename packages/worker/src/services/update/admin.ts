/// <reference types="@cloudflare/workers-types" />

/**
 * Update's admin surface — `GET|PATCH /manage/api/products/<slug>/update/settings` (§R1).
 *
 * Six settings, and they are here because they are all answers to ONE question — which builds
 * this product offers, and to whom:
 *
 *   metadataAccess / artifactsAccess   who may read the feed, and who may download what it
 *                                      points at (`public` | `authenticated` | `licensed` |
 *                                      `entitled`, D-13)
 *   compatMin / compatMax              the global version window every grant is intersected with
 *   minimumSystemVersion               the operator-only `sparkle:minimumSystemVersion`
 *   requireSparkleSignature            the operator-only signature requirement (R6-03)
 *
 * ── OPERATOR OWNERSHIP (P0-01) ──────────────────────────────────────────────────────────────
 *
 * The access pair and the compat window are ALSO written by a manifest resync. Saving either
 * here claims it (`access_source` / `compat_source` → `admin`), and resync's own UPDATE skips a
 * claimed block — the rule `services_source` established. `POST …/update/settings/revert` with
 * `{ "fields": ["access" | "compat"] }` hands a block back and changes nothing else: the values
 * stay as the operator left them until the next resync re-applies the manifest.
 *
 * The two operator-policy keys have no marker because they have no second writer: they live in
 * `release_config.operator_policy_json`, which no manifest path ever names. Turning the
 * signature requirement OFF is the one edit here that weakens a security control, so it is
 * audited as its own `release.policy.update` event, not folded into the settings update.
 *
 * ── THE COMPAT WINDOW MOVED ─────────────────────────────────────────────────────────────────
 *
 * It used to ride on `PATCH /manage/api/products/<slug>` beside the product's name and device
 * limit, which put a statement about SUPPORTED BUILDS in the form for "what is this product
 * called". Spec §8 relocates it here, and the product PATCH no longer accepts it — a field
 * silently ignored by one endpoint while another owns it is worse than a moved field, because
 * the console would appear to save and the value would not change.
 *
 * ── WHY UPDATE OWNS THE ACCESS MODES ────────────────────────────────────────────────────────
 *
 * The columns are Release's (`release_config`, spec §5.2), so the WRITE goes through Release's
 * own `setReleaseAccess` across the one sanctioned cross-service edge rather than as SQL issued
 * from here. What Update owns is the POLICY: `entitled` exists to gate a feed, and the operator
 * setting it is thinking about update eligibility.
 */

import { ErrorCode } from "../../core/errors.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/adminApi.js";
import { adminJson, audit, err, readBody } from "../../core/adminApi.js";
import {
  getCompatWindow,
  revertCompatWindowToManifest,
  setCompatWindow,
} from "../../core/products.js";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import {
  accessSourceOf,
  artifactPolicy,
  getReleaseConfig,
  isReleaseAccess,
  MINIMUM_SYSTEM_VERSION_RE,
  operatorPolicy,
  revertReleaseAccessToManifest,
  setOperatorPolicy,
  setReleaseAccess,
} from "../release/config.js";

/** A semver bound the window may name. Same shape the manifest validator accepts. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

type Source = "manifest" | "admin";

/** The blocks `…/update/settings/revert` can hand back to the manifest. */
const REVERTIBLE = ["access", "compat"] as const;
type Revertible = (typeof REVERTIBLE)[number];

interface UpdateSettingsView {
  metadataAccess: ReleaseAccess;
  artifactsAccess: ReleaseAccess;
  /** Who owns BOTH access modes: `admin` once an operator saved one here, and resync skips them. */
  accessSource: Source;
  compatMin: string;
  compatMax: string;
  /** Who owns the compat window, with the same meaning. */
  compatSource: Source;
  /** Operator-only; `null` when unset (no `sparkle:minimumSystemVersion` is rendered). */
  minimumSystemVersion: string | null;
  /** Operator-only; `true` unless an operator explicitly turned it off. */
  requireSparkleSignature: boolean;
  /** False when the product has no `release_config` row: the access modes and operator policy
   *  are defaults, not stored values, and a PATCH of them has nothing to write to. */
  configured: boolean;
}

async function settingsView(
  ctx: Pick<ServiceContext, "db" | "product">,
): Promise<UpdateSettingsView> {
  const slug = ctx.product.slug;
  const cfg = await getReleaseConfig(ctx.db, slug);
  const access = cfg
    ? artifactPolicy(cfg).access
    : { metadata: "public" as const, artifacts: "public" as const };
  const operator = cfg
    ? operatorPolicy(cfg)
    : { requireSparkleSignature: true, minimumSystemVersion: undefined };
  // Read fresh rather than from `ctx.product`: that was loaded before this request's write.
  const compat = await getCompatWindow(ctx.db, slug);
  return {
    metadataAccess: access.metadata,
    artifactsAccess: access.artifacts,
    accessSource: cfg ? accessSourceOf(cfg) : "manifest",
    compatMin: compat?.min ?? ctx.product.compatMin,
    compatMax: compat?.max ?? ctx.product.compatMax,
    compatSource: compat?.source ?? "manifest",
    minimumSystemVersion: operator.minimumSystemVersion ?? null,
    requireSparkleSignature: operator.requireSparkleSignature,
    configured: Boolean(cfg),
  };
}

export async function handleUpdateAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { rest } = ctx;
  if (rest[0] !== "settings") return null;
  if (rest.length === 1) return handleSettings(ctx);
  if (rest.length === 2 && rest[1] === "revert") return handleRevert(ctx);
  return null;
}

async function handleSettings(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;

  if (req.method === "GET") return adminJson(await settingsView(ctx));
  if (req.method !== "PATCH")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const fields: string[] = [];

  // Partial patch throughout: an omitted key keeps its current value. A console that only knows
  // about the access modes must not be able to reset a compat window it never displayed.
  let metadata: ReleaseAccess | undefined;
  if (body.metadataAccess !== undefined) {
    if (isReleaseAccess(body.metadataAccess)) metadata = body.metadataAccess;
    else fields.push("metadataAccess");
  }
  let artifacts: ReleaseAccess | undefined;
  if (body.artifactsAccess !== undefined) {
    if (isReleaseAccess(body.artifactsAccess)) artifacts = body.artifactsAccess;
    else fields.push("artifactsAccess");
  }
  let compatMin: string | undefined;
  if (body.compatMin !== undefined) {
    if (typeof body.compatMin === "string" && SEMVER.test(body.compatMin))
      compatMin = body.compatMin;
    else fields.push("compatMin");
  }
  let compatMax: string | undefined;
  if (body.compatMax !== undefined) {
    if (typeof body.compatMax === "string" && SEMVER.test(body.compatMax))
      compatMax = body.compatMax;
    else fields.push("compatMax");
  }
  // `null` clears the minimum; `undefined` leaves it alone. Same shape check the feed applies
  // before rendering, so a value this accepts is a value the appcast will actually carry.
  let minimumSystemVersion: string | null | undefined;
  if (body.minimumSystemVersion !== undefined) {
    if (body.minimumSystemVersion === null) minimumSystemVersion = null;
    else if (
      typeof body.minimumSystemVersion === "string" &&
      MINIMUM_SYSTEM_VERSION_RE.test(body.minimumSystemVersion)
    )
      minimumSystemVersion = body.minimumSystemVersion;
    else fields.push("minimumSystemVersion");
  }
  let requireSparkleSignature: boolean | undefined;
  if (body.requireSparkleSignature !== undefined) {
    if (typeof body.requireSparkleSignature === "boolean")
      requireSparkleSignature = body.requireSparkleSignature;
    else fields.push("requireSparkleSignature");
  }

  if (fields.length > 0)
    return err(422, ErrorCode.BadRequest, "invalid update settings", {
      fields,
    });

  const touchesAccess = metadata !== undefined || artifacts !== undefined;
  const touchesPolicy =
    minimumSystemVersion !== undefined || requireSparkleSignature !== undefined;
  const cfg =
    touchesAccess || touchesPolicy ? await getReleaseConfig(db, slug) : null;
  // 422 rather than a silent no-op: `release_config`'s UPDATEs would match no rows and the
  // console would show a saved value the next GET does not return. Checked for BOTH halves
  // before either is written, so a refused request writes nothing.
  if ((touchesAccess || touchesPolicy) && !cfg) {
    return err(
      422,
      ErrorCode.BadRequest,
      touchesAccess
        ? "product has no release configuration to set access modes on"
        : "product has no release configuration to set an artifact policy on",
      {
        fields: [
          ...(touchesAccess ? ["metadataAccess", "artifactsAccess"] : []),
          ...(minimumSystemVersion !== undefined
            ? ["minimumSystemVersion"]
            : []),
          ...(requireSparkleSignature !== undefined
            ? ["requireSparkleSignature"]
            : []),
        ],
      },
    );
  }

  if (touchesAccess) {
    await setReleaseAccess(db, slug, {
      ...(metadata !== undefined ? { metadata } : {}),
      ...(artifacts !== undefined ? { artifacts } : {}),
    });
  }
  if (compatMin !== undefined || compatMax !== undefined) {
    await setCompatWindow(
      db,
      slug,
      {
        ...(compatMin !== undefined ? { min: compatMin } : {}),
        ...(compatMax !== undefined ? { max: compatMax } : {}),
      },
      now,
    );
  }
  if (touchesPolicy && cfg) {
    const before = operatorPolicy(cfg);
    await setOperatorPolicy(db, slug, {
      ...(requireSparkleSignature !== undefined
        ? { requireSparkleSignature }
        : {}),
      ...(minimumSystemVersion !== undefined ? { minimumSystemVersion } : {}),
    });
    const changes: string[] = [];
    if (
      requireSparkleSignature !== undefined &&
      requireSparkleSignature !== before.requireSparkleSignature
    )
      changes.push(
        requireSparkleSignature
          ? "required Sparkle signatures"
          : "DISABLED the Sparkle signature requirement",
      );
    if (
      minimumSystemVersion !== undefined &&
      minimumSystemVersion !== (before.minimumSystemVersion ?? null)
    )
      changes.push(
        minimumSystemVersion === null
          ? "cleared minimumSystemVersion"
          : `set minimumSystemVersion to ${minimumSystemVersion}`,
      );
    // Its own event, not folded into `update.settings.update`: the signature requirement is a
    // security control, and switching it off must be findable in the audit log by action alone.
    await audit(
      db,
      slug,
      session,
      now,
      "release.policy.update",
      { kind: "product", id: slug },
      changes.length > 0
        ? `Artifact policy for ${slug}: ${changes.join("; ")}`
        : `Artifact policy for ${slug} saved unchanged`,
    );
  }

  await audit(
    db,
    slug,
    session,
    now,
    "update.settings.update",
    { kind: "product", id: slug },
    `Updated update settings for ${slug}`,
  );

  return adminJson(await settingsView(ctx));
}

/**
 * `POST …/update/settings/revert` — `{ "fields": ["access" | "compat", …] }`.
 *
 * Flips the named ownership markers back to `manifest` and NOTHING else, exactly like
 * `POST …/services/revert` (see `core/servicesAdmin.ts` for why reverting never reaches out to
 * GitHub on the spot). The live values stay as the operator left them; the next resync re-applies
 * the manifest.
 */
async function handleRevert(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const slug = product.slug;
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const raw = body.fields;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every(
      (f): f is Revertible =>
        typeof f === "string" && (REVERTIBLE as readonly string[]).includes(f),
    )
  ) {
    return err(
      422,
      ErrorCode.BadRequest,
      'fields must be a non-empty array of "access" and/or "compat"',
      { fields: ["fields"] },
    );
  }
  const blocks = new Set<Revertible>(raw);

  if (blocks.has("access") && !(await getReleaseConfig(db, slug))) {
    return err(
      422,
      ErrorCode.BadRequest,
      "product has no release configuration to revert access modes on",
      { fields: ["fields"] },
    );
  }

  if (blocks.has("access")) await revertReleaseAccessToManifest(db, slug);
  if (blocks.has("compat")) await revertCompatWindowToManifest(db, slug, now);

  const names = [...blocks].sort();
  await audit(
    db,
    slug,
    session,
    now,
    "update.settings.revert",
    { kind: "product", id: slug },
    `Returned ${names.join(" and ")} settings for ${slug} to manifest control`,
  );

  return adminJson(await settingsView(ctx));
}
