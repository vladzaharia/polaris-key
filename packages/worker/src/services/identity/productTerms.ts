/**
 * A product's terms (I-09; plans/I-27.md §2.4, §3): `identity.terms` `{version, url?}` from the
 * manifest's `identity:` block (or a console claim), resolved through ST-04's resolver, as the
 * `TermsRequirement` the email gate asks for (`card/gate.ts`, `accounts/terms.ts`). A person who
 * signs in through the product accepts each version once; a new version asks again.
 *
 * The answer is `null`, so nothing is asked, when the product declares no terms, when the stored
 * value is not one (a drifted row), when the product is unknown, and when there is no https URL to
 * show. A version with no `url` would take the listing's EULA URL (I-27 §3), but that URL lives in
 * Distribution's listing model and no Core hook carries it yet, so such a declaration asks nothing
 * until one does.
 */

import { IDENTITY_TERMS_VERSION_RE } from "@polaris-key/manifest";
import type { Db } from "../../db/types.js";
import type { Env } from "../../env.js";
import type { SettingsRegistry } from "../../core/settings/registry.js";
import { resolveProductSetting } from "../../core/settings/resolve.js";
import type { TermsRequirement } from "./accounts/terms.js";

/** The registry key (`settings.ts`). */
export const TERMS_SETTING = "identity.terms";

/** A stored `identity.terms` value as a requirement, or `null` when it is not a usable one. */
export function termsRequirementOf(value: unknown): TermsRequirement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, url } = value as { version?: unknown; url?: unknown };
  if (typeof version !== "string" || !IDENTITY_TERMS_VERSION_RE.test(version))
    return null;
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "")
      return null;
  } catch {
    return null;
  }
  return { url, version };
}

/**
 * The product's terms in force, or `null` (see the module header). Without the settings registry
 * (a context built by hand) nothing is asked.
 */
export async function productTerms(
  ctx: { env: Env; db: Db; registry?: SettingsRegistry },
  product: string,
): Promise<TermsRequirement | null> {
  if (!ctx.registry?.get(TERMS_SETTING, "product")) return null;
  const r = await resolveProductSetting(
    { env: ctx.env, db: ctx.db, registry: ctx.registry },
    product,
    TERMS_SETTING,
  );
  return termsRequirementOf(r?.value ?? null);
}
