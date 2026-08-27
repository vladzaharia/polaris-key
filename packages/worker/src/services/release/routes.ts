/// <reference types="@cloudflare/workers-types" />

/**
 * Release's own sub-router, over the path segments AFTER `/<product>/release`.
 *
 *     /release/changelog
 *     /release/install.sh            (+ the permanent alias `/<p>/install.sh`)
 *     /release/dl/:version/:binary-:arch[.dmg]
 *
 * Returning `null` for an unmatched segment is the registry contract (`core/registry.ts`): only
 * Core decides what "no route here" means, which is what makes a disabled service, an
 * unregistered slug and a bad path indistinguishable from outside.
 *
 * The alias reaches this file having been rewritten by the core router into the canonical
 * segments, so there is exactly one code path per surface and the two spellings cannot drift.
 */

import type { ServiceContext } from "../../core/registry.js";
import { normalizeArch } from "./assets.js";
import { handleRelease } from "./surfaces.js";

/** `<binary>-<arch>` with the arch aliases the old `/cli/` and `/dmg/` routes accepted. */
const ARCH_SUFFIX = /^(?:[^/]+)-(arm64|aarch64|x86_64|amd64)$/;

export async function handleReleaseRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest } = ctx;

  if (rest.length === 1) {
    if (rest[0] === "changelog")
      return handleRelease(req, env, db, product, "changelog", {});
    if (rest[0] === "install.sh")
      return handleRelease(req, env, db, product, "install", {});
    return null;
  }

  // /release/dl/<version>/<binary>-<arch>[.dmg]
  if (rest.length === 3 && rest[0] === "dl") {
    const version = rest[1] as string;
    const leaf = rest[2] as string;
    const dmg = leaf.endsWith(".dmg");
    const name = dmg ? leaf.slice(0, -".dmg".length) : leaf;
    const arch = normalizeArch(name.match(ARCH_SUFFIX)?.[1]);
    if (!arch) return null;
    return handleRelease(req, env, db, product, dmg ? "dmg" : "cli", {
      version,
      arch,
    });
  }

  return null;
}
