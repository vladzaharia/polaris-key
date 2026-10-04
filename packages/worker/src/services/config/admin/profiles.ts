/**
 * Profiles (`/manage/api/products/<slug>/config/profiles/...`): reusable managed-payload
 * templates. List/create, detail (redacted), catalog-validated payload edits (PUT batch), name
 * and description edits (PATCH, ADMIN.md A-7), and delete.
 *
 * The list and the detail say what points at each profile (`usedBy`: the tiers whose baseline it
 * is, the licenses that list it), so the console can show "Used by" and keep Delete disabled
 * while the server would refuse it. Create refuses an id that is taken (409 `profile_exists`):
 * it used to upsert, so a duplicate id silently replaced that profile's whole payload.
 *
 * Config's, because a profile IS a bundle of catalog values — the same config/secret/flag keys
 * the signed config document carries, named once and pointed at from many licences. It is
 * validated against the catalog on every write by the same compiler that serves the catalog.
 */

import { ErrorCode } from "../../../core/errors.js";
import { randomId } from "../../../core/platform.js";
import {
  adminJson,
  adminNotFound,
  applyOverrides,
  audit,
  countLicensesUsingProfile,
  deleteProfile,
  err,
  listProfileReferences,
  listProfiles,
  loadCatalog,
  parsePayload,
  readBody,
  redactPayload,
  upsertProfile,
  type OverrideUpdate,
} from "../../../core/adminApi.js";
import type { ConfigAdminContext } from "./index.js";

export async function handleProfiles(
  ctx: ConfigAdminContext,
  id: string | undefined,
): Promise<Response> {
  const { req, env, db, product, session, now } = ctx;
  const slug = product.slug;
  if (!id) {
    if (req.method === "GET") {
      const [rows, refs] = await Promise.all([
        listProfiles(db, slug),
        listProfileReferences(db, slug),
      ]);
      return adminJson({
        profiles: rows.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? undefined,
          modifiedBy: p.modified_by ?? undefined,
          modifiedAt: p.modified_at,
          usedBy: {
            tiers: refs.tiers.filter((t) => t.profile_id === p.id).length,
            licenses: refs.licenses.filter((l) => l.profile_id === p.id).length,
          },
        })),
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const profileId = String(body.id ?? randomId("prof"));
      const existing = await listProfiles(db, slug);
      if (existing.some((p) => p.id === profileId))
        return err(409, ErrorCode.BadRequest, "profile id already exists", {
          reason: "profile_exists",
        });
      await upsertProfile(db, {
        product: slug,
        id: profileId,
        name: String(body.name ?? profileId),
        description:
          typeof body.description === "string" ? body.description : null,
        payload_json: JSON.stringify({
          config: {},
          secrets: {},
          entitlements: {},
        }),
        modified_by: session.sub,
        modified_at: now,
      });
      await audit(
        db,
        slug,
        session,
        now,
        "profile.create",
        { kind: "profile", id: profileId },
        `Created profile ${profileId}`,
      );
      return adminJson({ ok: true, id: profileId }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  const row = await listProfiles(db, slug).then(
    (rows) => rows.find((p) => p.id === id) ?? null,
  );
  if (!row) return adminNotFound();
  if (req.method === "GET") {
    const [catalog, refs] = await Promise.all([
      loadCatalog(db, slug),
      listProfileReferences(db, slug),
    ]);
    return adminJson({
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      payload: redactPayload(parsePayload(row.payload_json), catalog),
      modifiedBy: row.modified_by ?? undefined,
      modifiedAt: row.modified_at,
      usedBy: {
        tiers: refs.tiers
          .filter((t) => t.profile_id === id)
          .map((t) => ({ id: t.id, label: t.label })),
        licenses: refs.licenses
          .filter((l) => l.profile_id === id)
          .map((l) => ({
            id: l.id,
            name: l.name ?? undefined,
            email: l.email ?? undefined,
          })),
      },
    });
  }
  if (req.method === "PATCH") {
    // A-7: name and description only. The id is the stable reference tiers and licenses hold;
    // the payload has its own catalog-validated PUT.
    const body = await readBody(req);
    const fields: string[] = [];
    let name = row.name;
    let description = row.description;
    if ("name" in body) {
      if (typeof body.name !== "string" || body.name.trim() === "")
        fields.push("name");
      else name = body.name.trim();
    }
    if ("description" in body) {
      if (body.description === null) description = null;
      else if (typeof body.description === "string")
        description = body.description.trim() === "" ? null : body.description;
      else fields.push("description");
    }
    if (fields.length)
      return err(422, ErrorCode.BadRequest, "invalid profile details", {
        fields,
      });
    await upsertProfile(db, {
      ...row,
      name,
      description,
      modified_by: session.sub,
      modified_at: now,
    });
    await audit(
      db,
      slug,
      session,
      now,
      "profile.update",
      { kind: "profile", id },
      `Updated profile ${id} details`,
    );
    return adminJson({ ok: true, id });
  }
  if (req.method === "PUT") {
    const catalog = await loadCatalog(db, slug);
    if (!catalog)
      return err(409, ErrorCode.BadRequest, "no active catalog", {
        reason: "no_active_catalog",
      });
    const body = await readBody(req);
    const updates = Array.isArray(body.updates)
      ? (body.updates as OverrideUpdate[])
      : [];
    const result = await applyOverrides(
      env,
      slug,
      parsePayload(row.payload_json),
      updates,
      catalog,
      now,
    );
    if (!result.ok)
      return err(422, result.code, "validation failed", {
        fields: result.fields,
      });
    await upsertProfile(db, {
      ...row,
      payload_json: JSON.stringify(result.payload),
      modified_by: session.sub,
      modified_at: now,
    });
    await audit(
      db,
      slug,
      session,
      now,
      "profile.overrides",
      { kind: "profile", id },
      `Updated profile ${id}`,
    );
    return adminJson({ ok: true, id });
  }
  if (req.method === "DELETE") {
    const refs = await countLicensesUsingProfile(db, slug, id);
    if (refs > 0)
      return err(409, ErrorCode.BadRequest, "profile is still referenced", {
        reason: "profile_in_use",
        references: refs,
      });
    await deleteProfile(db, slug, id);
    await audit(
      db,
      slug,
      session,
      now,
      "profile.delete",
      { kind: "profile", id },
      `Deleted profile ${id}`,
    );
    return adminJson({ ok: true, id });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}
