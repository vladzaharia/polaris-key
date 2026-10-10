/**
 * Synthetic console principals for the authorization tests (ST-29). ST-29 can only mint the root
 * one from a real session; the others stand for the members ST-30 to ST-32 will produce, so the
 * route table and `can()` are proven against them before any of those packages lands.
 *
 * The eight, by what they hold:
 *   - `none`: no principal at all (no session).
 *   - `stranger`: a verified session that resolves to no grant (not a member).
 *   - `consoleOnly`: Console access.
 *   - `alphaAdmin`: Product admin of `alpha`, every area.
 *   - `alphaShip`: Product admin of `alpha`, narrowed to Ship builds and Commerce.
 *   - `allProducts`: Product admin of `products:*`.
 *   - `platformAdmin`: Platform admin.
 *   - `root`: Superadmin through the root rule (today's only operator).
 */

import type { Principal } from "../src/core/rbac/can.js";
import { ROOT_GRANT } from "../src/core/rbac/principal.js";

export const ROOT_PRINCIPAL: Principal = {
  memberId: "u1",
  grants: [ROOT_GRANT],
};

export const PRINCIPALS = {
  none: null,
  stranger: { memberId: "m-stranger", grants: [] },
  consoleOnly: {
    memberId: "m-console",
    grants: [
      {
        role: "console_access",
        scope: "platform",
        areas: null,
        source: "rule",
      },
    ],
  },
  alphaAdmin: {
    memberId: "m-alpha",
    grants: [
      {
        role: "product_admin",
        scope: "product:alpha",
        areas: null,
        source: "grant",
      },
    ],
  },
  alphaShip: {
    memberId: "m-alpha-ship",
    grants: [
      {
        role: "product_admin",
        scope: "product:alpha",
        areas: ["ship", "commerce"],
        source: "grant",
      },
    ],
  },
  allProducts: {
    memberId: "m-all",
    grants: [
      {
        role: "product_admin",
        scope: "products:*",
        areas: null,
        source: "grant",
      },
    ],
  },
  platformAdmin: {
    memberId: "m-platform",
    grants: [
      {
        role: "platform_admin",
        scope: "platform",
        areas: null,
        source: "grant",
      },
    ],
  },
  root: { memberId: "m-root", grants: [ROOT_GRANT] },
} as const satisfies Record<string, Principal | null>;

export type PrincipalName = keyof typeof PRINCIPALS;

export const PRINCIPAL_NAMES = Object.keys(PRINCIPALS) as PrincipalName[];
