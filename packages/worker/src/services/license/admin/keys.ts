/**
 * License keys (`/manage/api/products/<slug>/license/licenses/<id>/keys`): list, mint (raw key
 * returned ONCE), and revoke.
 */

import { ErrorCode } from "../../../core/errors.js";
import { hashKey, mintLicenseKey } from "../../../crypto.js";
import {
  getKey,
  insertKey,
  listKeysByLicense,
  setKeyStatus,
} from "../../../repo.js";
import {
  adminJson,
  notFound as adminNotFound,
  err,
  readBody,
} from "../../../admin/lib/respond.js";
import { audit } from "../../../admin/audit.js";
import type { LicenseAdminContext } from "./index.js";

export async function handleKeys(
  ctx: LicenseAdminContext,
  licenseId: string,
  keyHash: string | undefined,
  action: string | undefined,
): Promise<Response> {
  const { req, env, db, product, session, now } = ctx;
  const slug = product.slug;
  if (!keyHash) {
    if (req.method === "GET") {
      const keys = await listKeysByLicense(db, slug, licenseId);
      return adminJson({
        keys: keys.map((k) => ({
          hash: k.key_hash,
          status: k.status,
          label: k.label ?? undefined,
          createdAt: k.created_at,
          createdBy: k.created_by ?? "",
          lastUsedAt: k.last_used_at ?? undefined,
        })),
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const key = mintLicenseKey(slug);
      const hash = await hashKey(key, env.KEY_HASH_PEPPER);
      await insertKey(db, {
        product: slug,
        key_hash: hash,
        license_id: licenseId,
        status: "active",
        label: typeof body.label === "string" ? body.label : null,
        created_at: now,
        created_by: session.sub,
        last_used_at: null,
      });
      await audit(
        db,
        slug,
        session,
        now,
        "key.create",
        { kind: "key", id: hash },
        `Minted key for ${licenseId}`,
      );
      // Raw key returned ONCE.
      return adminJson(
        {
          key,
          hash,
          record: {
            hash,
            status: "active",
            createdAt: now,
            createdBy: session.sub,
          },
        },
        201,
      );
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  const existing = await getKey(db, slug, keyHash);
  if (!existing || existing.license_id !== licenseId) return adminNotFound();

  if (action === "revoke") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    await setKeyStatus(db, slug, keyHash, "revoked");
    await audit(
      db,
      slug,
      session,
      now,
      "key.revoke",
      { kind: "key", id: keyHash },
      `Revoked key ${keyHash.slice(0, 8)}`,
    );
    return adminJson({ ok: true, hash: keyHash, status: "revoked" });
  }
  return adminNotFound();
}
