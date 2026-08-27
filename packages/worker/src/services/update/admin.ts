/// <reference types="@cloudflare/workers-types" />

/**
 * Update's admin surface — `GET|PATCH /manage/api/products/<slug>/update/settings` (§R1).
 *
 * Four settings, and they are here because they are all answers to ONE question — which builds
 * this product offers, and to whom:
 *
 *   metadataAccess / artifactsAccess   who may read the feed, and who may download what it
 *                                      points at (`public` | `authenticated` | `licensed` |
 *                                      `entitled`, D-13)
 *   compatMin / compatMax              the global version window every grant is intersected with
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
import { setCompatWindow } from "../../core/products.js";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import {
  artifactPolicy,
  getReleaseConfig,
  isReleaseAccess,
  setReleaseAccess,
} from "../release/config.js";

/** A semver bound the window may name. Same shape the manifest validator accepts. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

interface UpdateSettingsView {
  metadataAccess: ReleaseAccess;
  artifactsAccess: ReleaseAccess;
  compatMin: string;
  compatMax: string;
  /** False when the product has no `release_config` row: the access modes are defaults, not
   *  stored values, and a PATCH has nothing to write to. */
  configured: boolean;
}

async function settingsView(
  ctx: Pick<ServiceContext, "db" | "product">,
): Promise<UpdateSettingsView> {
  const cfg = await getReleaseConfig(ctx.db, ctx.product.slug);
  const access = cfg
    ? artifactPolicy(cfg).access
    : { metadata: "public" as const, artifacts: "public" as const };
  return {
    metadataAccess: access.metadata,
    artifactsAccess: access.artifacts,
    compatMin: ctx.product.compatMin,
    compatMax: ctx.product.compatMax,
    configured: Boolean(cfg),
  };
}

export async function handleUpdateAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, db, product, rest, session, now } = ctx;
  if (rest.length !== 1 || rest[0] !== "settings") return null;
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

  if (fields.length > 0)
    return err(422, ErrorCode.BadRequest, "invalid update settings", {
      fields,
    });

  if (metadata !== undefined || artifacts !== undefined) {
    // 422 rather than a silent no-op: `setReleaseAccess`'s UPDATE would match no rows and the
    // console would show a saved value the next GET does not return.
    if (!(await getReleaseConfig(db, slug))) {
      return err(
        422,
        ErrorCode.BadRequest,
        "product has no release configuration to set access modes on",
        { fields: ["metadataAccess", "artifactsAccess"] },
      );
    }
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

  await audit(
    db,
    slug,
    session,
    now,
    "update.settings.update",
    { kind: "product", id: slug },
    `Updated update settings for ${slug}`,
  );

  // Re-read: the compat window lives on the product row this context was loaded from, so the
  // echo has to come from storage or it would report the values the request arrived with.
  const view = await settingsView(ctx);
  return adminJson({
    ...view,
    ...(compatMin !== undefined ? { compatMin } : {}),
    ...(compatMax !== undefined ? { compatMax } : {}),
  });
}
