/** Shared setup for the issuer's flow tests: a world with the issuer on, one account, and clients. */
import { pkcePair } from "../../../../src/platform/pkce.js";
import {
  createClient,
  type ClientRecord,
  type NewClient,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import { NOW } from "../../../seed.js";
import { SLUG, world, type World } from "../../connect/connectFixture.js";
import { enableIssuer } from "./issuerHelpers.js";

/** Every scope a registered client may be granted. */
export const ALL_SCOPES: NewClient["scopes"] = [
  "openid",
  "profile",
  "email",
  "pkey:entitlements",
  "offline_access",
];

/** Register a client of the default product; `name` defaults to its key. */
export async function mkClient(
  w: World,
  over: Pick<NewClient, "key" | "type" | "redirectUris"> & Partial<NewClient>,
): Promise<ClientRecord> {
  const r = await createClient(
    w.db,
    {
      product: SLUG,
      origin: "console",
      name: over.key,
      developerName: null,
      postLogoutRedirectUris: [],
      scopes: ALL_SCOPES,
      claimsRequired: ["name"],
      iconUrl: null,
      ...over,
    },
    NOW,
  );
  if (!r.ok) throw new Error(r.reason);
  return r.client;
}

/** A world with the issuer on, the account that holds the world's subject, and a PKCE pair. */
export async function issuerWorld(): Promise<{
  w: World;
  accountId: string;
  pair: { verifier: string; challenge: string };
}> {
  const w = await world();
  await enableIssuer(w.db, SLUG);
  const accountId = (await w.db.first<{ account_id: string }>(
    "SELECT account_id FROM account_product_subjects WHERE product = ? AND subject = ?",
    SLUG,
    w.subject,
  ))!.account_id;
  return { w, accountId, pair: await pkcePair() };
}
