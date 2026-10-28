/** `vi.mock` factory body for `core/rbac/principal.js`: a lookup from member id to a synthetic principal (read lazily). */
import type { Principal } from "../src/core/rbac/can.js";

type Real = typeof import("../src/core/rbac/principal.js");

export async function withSyntheticPrincipals(
  importOriginal: () => Promise<Real>,
  lookup: (memberId: string) => Principal | undefined,
): Promise<Real> {
  const real = await importOriginal();
  return {
    ...real,
    resolvePrincipal: async (...args: Parameters<Real["resolvePrincipal"]>) =>
      lookup(args[2].sub) ?? real.resolvePrincipal(...args),
  };
}
