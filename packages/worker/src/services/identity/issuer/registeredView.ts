/**
 * `ClientRecord.registered` (I-21.6; V5 §12.13.2): the card's view of the registered client that
 * asked. Built from the stored client and the request's matched redirect URI, never from a query
 * parameter. The product's own presentation (`appName`, `iconUrl`) is untouched.
 *
 * The client's names are re-checked at render time with the same display-name rules as the
 * product's (`@polaris-key/manifest` `checkDisplayName`): a failing `name` shows the client's
 * `key` and sets `nameVerified: false` (the neutral frame, IS-1); a failing `developerName` is
 * dropped for the product's developer. The icon is shown only when it is a same-origin
 * `/media/…` path. `returnHost` is the host of an `https` redirect, and `null` for a loopback or
 * private-use URI, which returns to an app on the same device.
 */

import { checkDisplayName } from "@polaris-key/manifest";
import type { RegisteredClientRecord } from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { displayCheckOptions } from "../../../core/accounts/reservedDisplayNames.js";
import type { ClientRecord } from "./clientsRepo.js";

export async function registeredClientRecord(
  env: Env,
  db: Db,
  product: { slug: string },
  client: ClientRecord,
  redirectUri: string,
  productDeveloper: string | null,
): Promise<RegisteredClientRecord> {
  const check = await displayCheckOptions(env, db, product.slug);
  const nameOk = checkDisplayName(client.name, check) === null;
  const developerOk =
    client.developerName === null ||
    checkDisplayName(client.developerName, check) === null;
  const developer =
    client.developerName !== null && developerOk
      ? client.developerName
      : productDeveloper;
  return {
    clientId: client.clientId,
    name: nameOk ? client.name : client.key,
    developerName: developer,
    iconUrl:
      client.iconUrl !== null &&
      /^\/media\/[A-Za-z0-9._~/-]+$/.test(client.iconUrl) &&
      !client.iconUrl.includes("..")
        ? client.iconUrl
        : null,
    returnHost: redirectUri.startsWith("https://")
      ? new URL(redirectUri).host
      : null,
    nameVerified: nameOk && developerOk,
  };
}
