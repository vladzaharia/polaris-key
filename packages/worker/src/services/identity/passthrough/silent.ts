/// <reference types="@cloudflare/workers-types" />

/**
 * What the native grants that sign a person in without a click share (the token exchange, I-13.4,
 * and the restore grant, I-49.7): the context a handler is called with, the consent the person is
 * shown, and the scope a narrowed consent leaves.
 */

import type { ExchangeConsentView } from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { resolveScope } from "./authorize.js";
import type { clientRecordFor } from "./client.js";
import type { consentState } from "./routes.js";

export interface NativeGrantContext {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  form: Map<string, string>;
  settings?: SettingsRegistry | undefined;
}

/**
 * The consent view: who is asking (the client record) and what (§12.11.3 rule 1). `as` is who the
 * app says is signing in: the provider and address of a token, or `null` and `null` for a restore.
 * The key order is the wire's (`exchange-confirm` pins it).
 */
export function consentView<
  A extends { provider: string | null; email: string | null },
>(
  client: Awaited<ReturnType<typeof clientRecordFor>>,
  consent: Awaited<ReturnType<typeof consentState>>,
  as: A,
): Omit<ExchangeConsentView, "as"> & { as: A } {
  return {
    client: {
      appName: client.appName,
      developerName: client.developerName,
      iconUrl: client.iconUrl,
      nameVerified: client.nameVerified,
    },
    as,
    items: consent.items,
    scopeHash: consent.scopeHash,
    firstTime: consent.firstTime,
    changed: consent.changed,
  };
}

/** What the person consented to, never more: a narrowed consent stays narrowed. */
export function consentedScope(
  product: Product,
  consent: { claims: string[] | null },
): string[] {
  return (resolveScope(undefined, product) ?? []).filter((c) =>
    (consent.claims ?? []).includes(c),
  );
}
