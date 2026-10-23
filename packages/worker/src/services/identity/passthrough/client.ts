/**
 * The client record (WIRE-CONTRACT-V4 §12.7.2, plans/PX-W13.md §2.2): the server-side view of the
 * app asking to sign the person in, built from data the Worker already holds. No table: the
 * presentation is the portal's (`presentationFor`, the listing through Distribution's delivery
 * hook, art only as the same-origin `/media/<p>/icon` §12.7.2 names; since HA-07 that path 302s to
 * the product's hosted icon on the image host), the origins are the product's registered
 * `web.origins`, and the services are its toggles.
 *
 * A render-time re-check of the display-name rules (`@polaris-key/manifest` `checkDisplayName`)
 * covers names written before the rules existed and names accepted with a warning: a failing
 * app name is replaced by the product slug with `nameVerified: false` (PX-14 renders the neutral
 * frame), and a failing developer name is dropped.
 */

import { checkDisplayName } from "@polaris-key/manifest";
import { displayCheckOptions } from "../../../core/accounts/reservedDisplayNames.js";
import type { ClientKind, ClientRecord } from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { ProductPublic } from "../../../core/products.js";
import type { PortalHooksFor } from "../portal/api.js";
import { presentationFor } from "../portal/library.js";

/**
 * Whether the product runs Cloud Sync (slug `sync`, U-04's service-table row). It reads the
 * product's `services.sync.enabled`, so the consent list and the client record follow the toggle.
 */
export function cloudSyncOn(product: ProductPublic): boolean {
  const services = product.services as Readonly<
    Record<string, { enabled?: boolean } | undefined>
  >;
  return services.sync?.enabled === true;
}

export async function clientRecordFor(
  env: Env,
  db: Db,
  product: ProductPublic,
  kind: ClientKind,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<ClientRecord> {
  const presentation = await presentationFor(
    env,
    db,
    product,
    hooksFor,
    now,
    "client",
  );
  const check = await displayCheckOptions(env, db, product.slug);
  const nameVerified = checkDisplayName(presentation.name, check) === null;
  const developer = presentation.developerName;
  return {
    product: product.slug,
    kind,
    appName: nameVerified ? presentation.name : product.slug,
    developerName:
      developer !== null && checkDisplayName(developer, check) === null
        ? developer
        : null,
    iconUrl: presentation.iconUrl,
    ...(presentation.headerUrl ? { artUrl: presentation.headerUrl } : {}),
    origins: [...product.webOrigins],
    services: {
      license: product.services.license.enabled,
      cloudSync: cloudSyncOn(product),
    },
    nameVerified,
  };
}
