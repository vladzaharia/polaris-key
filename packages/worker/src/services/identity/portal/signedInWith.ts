/**
 * The export's `signedInWith` member (I-21.15; I-11's allow-list): the registered clients a person
 * signed in to with a product's account, and what each was allowed to get. Both exports carry it
 * (the account export for every product, a product export for its own), assembled field by field:
 * never a scope hash, a token, a redirect URI or a secret.
 */

import { loadProductPublic } from "../../../core/products.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { clientRecordFor } from "../passthrough/client.js";
import { getClient } from "../issuer/clientsRepo.js";
import { listAllAccountGrants } from "../issuer/grantsRepo.js";
import { registeredClientRecord } from "../issuer/registeredView.js";
import type { PortalHooksFor } from "./api.js";

export interface ExportedSignedInWith {
  product: string;
  clientId: string;
  /** The client's name as the person saw it. */
  clientName: string;
  developer: string | null;
  /** The optional claims the person allowed. */
  granted: string[];
  /** The optional claims the person declined. */
  declined: string[];
  /** `entitlements` and `offline`: given by signing in, ended by Disconnect. */
  lines: string[];
  grantedAt: number;
  changedAt: number;
  lastUsedAt: number | null;
}

/** The account's grants, for one product or all, newest first. */
export async function exportSignedInWith(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
  only?: string,
): Promise<ExportedSignedInWith[]> {
  const out: ExportedSignedInWith[] = [];
  const developers = new Map<string, string | null>();
  for (const g of await listAllAccountGrants(db, accountId)) {
    if (only !== undefined && g.product !== only) continue;
    const product = await loadProductPublic(db, g.product);
    const client = product ? await getClient(db, g.product, g.clientId) : null;
    if (!product || !client) continue;
    if (!developers.has(g.product))
      developers.set(
        g.product,
        (await clientRecordFor(env, db, product, "web", now, hooksFor))
          .developerName,
      );
    const shown = await registeredClientRecord(
      env,
      db,
      product,
      client,
      client.redirectUris[0] ?? "",
      developers.get(g.product) ?? null,
    );
    out.push({
      product: g.product,
      clientId: g.clientId,
      clientName: shown.name,
      developer: shown.developerName,
      granted: [...g.claimsGranted],
      declined: [...g.claimsDeclined],
      lines: [
        ...(g.scopes.includes("pkey:entitlements") ? ["entitlements"] : []),
        ...(g.scopes.includes("offline_access") ? ["offline"] : []),
      ],
      grantedAt: g.grantedAt,
      changedAt: g.changedAt,
      lastUsedAt: g.lastUsedAt,
    });
  }
  return out;
}
