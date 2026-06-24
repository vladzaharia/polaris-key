/**
 * License keys (`/api/products/<slug>/licenses/<id>/keys`): list, mint (raw key returned
 * ONCE), and revoke. Minting/revoking keeps the KV key-record mirror in sync with D1.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { hashKey, mintLicenseKey } from "../../crypto.js";
import { putKeyRecord, deleteKeyRecord } from "../../kv.js";
import { insertKey, listKeysByLicense, setKeyStatus, getKey } from "../../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound } from "../lib/respond.js";
import { readBody } from "../lib/respond.js";

export async function handleKeys(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  licenseId: string,
  keyHash: string | undefined,
  action: string | undefined,
  now: number,
): Promise<Response> {
  if (!keyHash) {
    if (req.method === "GET") {
      const keys = await listKeysByLicense(db, slug, licenseId);
      return adminJson({
        keys: keys.map((k) => ({ hash: k.key_hash, status: k.status, label: k.label ?? undefined, createdAt: k.created_at, createdBy: k.created_by ?? "", lastUsedAt: k.last_used_at ?? undefined })),
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
      await putKeyRecord(env, slug, hash, { product: slug, licenseId, status: "active" });
      await audit(db, slug, session, now, "key.create", { kind: "key", id: hash }, `Minted key for ${licenseId}`);
      // Raw key returned ONCE.
      return adminJson({ key, hash, record: { hash, status: "active", createdAt: now, createdBy: session.sub } }, 201);
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  const existing = await getKey(db, slug, keyHash);
  if (!existing || existing.license_id !== licenseId) return notFound();

  if (action === "revoke") {
    if (req.method !== "POST") return err(405, ErrorCode.BadRequest, "method not allowed");
    await setKeyStatus(db, slug, keyHash, "revoked");
    await deleteKeyRecord(env, slug, keyHash);
    await audit(db, slug, session, now, "key.revoke", { kind: "key", id: keyHash }, `Revoked key ${keyHash.slice(0, 8)}`);
    return adminJson({ ok: true, hash: keyHash, status: "revoked" });
  }
  return notFound();
}
