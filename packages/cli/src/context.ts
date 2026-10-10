/**
 * What a `pkey` command acts on when the flags do not say (P0-45): the product from the nearest
 * `.pkey/product`, the base URL from `PKEY_BASE_URL`, else the production origin. A flag always
 * wins. `pkey help` and `pkey doctor` print the same facts, so the line a person reads is the
 * value the command will use.
 */

import { DEFAULT_BASE_URL } from "./bundle.js";
import { findProductManifest } from "./manifest.js";
import type { ContextKey } from "./help.js";

export const BASE_URL_ENV = "PKEY_BASE_URL";

export type ContextSource = "flag" | "manifest" | "env" | "default";

export interface PkeyContext {
  /** The product, or `null` when no flag and no `.pkey/product` names one. */
  product: {
    slug: string;
    name?: string;
    source: "flag" | "manifest";
    file?: string;
  } | null;
  baseUrl: { url: string; source: "flag" | "env" | "default" };
}

export interface ContextInput {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  product?: string;
  baseUrl?: string;
}

export async function resolveContext(
  input: ContextInput,
): Promise<PkeyContext> {
  const found = await findProductManifest(input.cwd);
  const env = input.env[BASE_URL_ENV]?.trim();
  return {
    product: input.product
      ? {
          slug: input.product,
          source: "flag",
          // The name is the manifest's only when the flag names the manifest's own product.
          ...(found?.slug === input.product && found.name
            ? { name: found.name }
            : {}),
        }
      : found
        ? {
            slug: found.slug,
            ...(found.name ? { name: found.name } : {}),
            source: "manifest",
            file: found.file,
          }
        : null,
    baseUrl: input.baseUrl
      ? { url: input.baseUrl, source: "flag" }
      : env
        ? { url: env, source: "env" }
        : { url: DEFAULT_BASE_URL, source: "default" },
  };
}

/**
 * Fill `--product` and `--base-url` into a command's parsed flags from the context, for the
 * values the registry says the command defaults (`PkeyCommand.context`). `--base-url` is filled
 * only from the environment: a command's own fallback to the production origin stays its own.
 */
export async function applyContext(
  keys: readonly ContextKey[] | undefined,
  flags: Record<string, string | boolean>,
  input: { cwd: string; env: ContextInput["env"] },
): Promise<void> {
  if (!keys?.length) return;
  const given = (name: string) =>
    typeof flags[name] === "string" && String(flags[name]).trim() !== "";
  const wantProduct = keys.includes("product") && !given("product");
  const wantBase = keys.includes("baseUrl") && !given("base-url");
  if (!wantProduct && !wantBase) return;
  const ctx = await resolveContext(input);
  if (wantProduct && ctx.product) flags["product"] = ctx.product.slug;
  if (wantBase && ctx.baseUrl.source === "env")
    flags["base-url"] = ctx.baseUrl.url;
}
