/**
 * Fixture for the retired owner-wide READ `pkeyr_` token (F-33b.3). Core refuses to mint one
 * (`owner_read_retired`), but tokens minted before that stay valid until they expire, so the
 * suites that exercise the credential ladder need such a row. This inserts it directly, as an
 * older Worker would have; every other mint goes through `mintRegistryToken`.
 */

import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";
import { mintOpaqueToken, randomId } from "../../src/platform/crypto.js";
import {
  REGISTRY_TOKEN_PREFIX,
  forgetRegistryTokens,
  getRegistryToken,
  hashRegistryToken,
  mintRegistryToken,
  type MintRegistryTokenInput,
  type MintRegistryTokenResult,
} from "../../src/core/registry/registryTokens.js";

/** `mintRegistryToken`, except an owner-bound read token is inserted as the legacy row it was. */
export async function mintCompat(
  env: Env,
  db: Db,
  input: MintRegistryTokenInput,
  now: number,
): Promise<MintRegistryTokenResult> {
  const scopes = [...new Set(input.scopes ?? ["read"])];
  if (input.binding !== "owner" || scopes.includes("publish"))
    return mintRegistryToken(env, db, input, now);
  const token = `${REGISTRY_TOKEN_PREFIX}${mintOpaqueToken()}`;
  const tokenId = randomId("rtok");
  const days = input.expiresInDays ?? (input.presentation === "url" ? 30 : 90);
  await db.run(
    `INSERT INTO registry_tokens
       (product, token_id, token_hash, hint, label, scopes_json, ecosystems_json, binding,
        license_id, presentation, created_by, portal_account_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', NULL, ?, ?, ?, ?, ?)`,
    input.product,
    tokenId,
    await hashRegistryToken(env, token),
    token.slice(-4),
    input.label,
    JSON.stringify(scopes),
    input.presentation === "url"
      ? JSON.stringify(["godot"])
      : input.ecosystems
        ? JSON.stringify([...input.ecosystems].sort())
        : null,
    input.presentation === "url" ? "url" : "header",
    input.createdBy,
    input.portalAccountId ?? null,
    now,
    now + days * 86_400,
  );
  forgetRegistryTokens();
  const view = (await getRegistryToken(db, input.product, tokenId, now))!;
  return { ok: true, token, view };
}
