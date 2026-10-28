/** `vi.mock` factory body for `core/rbac/principal.js`: a lookup from the console IdP subject (the member id on a break-glass session) to a synthetic principal (read lazily). */
import type { Principal } from "../src/core/rbac/can.js";

/**
 * A test signs an operator in by IdP subject (`consoleTestSession`), but the console resolves the
 * principal for the member id. The helper records the pair here, and a synthetic principal is
 * looked up by the IdP subject the test named.
 */
const IDP_SUB_OF_MEMBER = new Map<string, string>();
export const rememberMember = (memberId: string, idpSub: string): void => {
  IDP_SUB_OF_MEMBER.set(memberId, idpSub);
};
export const syntheticKey = (sub: string): string =>
  IDP_SUB_OF_MEMBER.get(sub) ?? sub;

type Real = typeof import("../src/core/rbac/principal.js");

export async function withSyntheticPrincipals(
  importOriginal: () => Promise<Real>,
  lookup: (memberId: string) => Principal | undefined,
): Promise<Real> {
  const real = await importOriginal();
  return {
    ...real,
    resolvePrincipal: async (...args: Parameters<Real["resolvePrincipal"]>) =>
      lookup(syntheticKey(args[2].sub)) ?? real.resolvePrincipal(...args),
  };
}
