/**
 * Profiles (`/api/products/<slug>/profiles/...`): reusable managed-payload templates. List/
 * create, detail (redacted), catalog-validated payload edits (PUT batch), and delete.
 */

import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { randomId } from "../../crypto.js";
import {
  countLicensesUsingProfile,
  deleteProfile,
  listProfiles,
  upsertProfile,
} from "../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound, readBody } from "../lib/respond.js";
import { redactPayload, parsePayload } from "../lib/redact.js";
import { applyOverrides, type OverrideUpdate } from "../lib/overrides.js";
import { loadCatalog } from "../lib/shape.js";

export async function handleProfiles(
  req: Request,
  db: Db,
  session: AdminSession,
  slug: string,
  id: string | undefined,
  now: number,
): Promise<Response> {
  if (!id) {
    if (req.method === "GET") {
      const rows = await listProfiles(db, slug);
      return adminJson({
        profiles: rows.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? undefined,
          modifiedBy: p.modified_by ?? undefined,
          modifiedAt: p.modified_at,
        })),
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const profileId = String(body.id ?? randomId("prof"));
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
  if (!row) return notFound();
  if (req.method === "GET") {
    const catalog = await loadCatalog(db, slug);
    return adminJson({
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      payload: redactPayload(parsePayload(row.payload_json), catalog),
      modifiedBy: row.modified_by ?? undefined,
      modifiedAt: row.modified_at,
    });
  }
  if (req.method === "PUT") {
    const catalog = await loadCatalog(db, slug);
    if (!catalog) return err(409, ErrorCode.BadRequest, "no active catalog");
    const body = await readBody(req);
    const updates = Array.isArray(body.updates)
      ? (body.updates as OverrideUpdate[])
      : [];
    const result = applyOverrides(
      parsePayload(row.payload_json),
      updates,
      catalog,
      now,
    );
    if (!result.ok)
      return err(422, ErrorCode.BadRequest, "validation failed", {
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
