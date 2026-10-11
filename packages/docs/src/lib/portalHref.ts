/**
 * Where a link into the customer portal points (docs plan §8.3, `<PortalLink to>`).
 *
 * The portal is one page at the site root that routes by hash (`packages/admin/src/portal/
 * router.ts`): `#/` is the Library and every other page is `#/<page>`, as `#/account` or
 * `#/account/methods`. The Worker serves the portal's shell for `/`, `/index.html`, `/activate`
 * and `/assets/` only (`packages/worker/src/router.ts`), so a path such as `/library` or
 * `/account` is a 404, not the portal. `library` is the portal's home; any other page is a hash
 * route.
 */
export function portalHref(to: string): string {
  const page = to.replace(/^[/#]+/, "");
  return page === "" || page === "library" ? "/" : `/#/${page}`;
}
