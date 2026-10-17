/**
 * The store notification hooks' one spelling lives in `core/storefront/hookPath.ts` (a
 * declaration module the ASC write gate's rule table may import); this re-export is the name
 * services and the router use (CM-29, plans/CM-29.md §3.2).
 */
export * from "../storefront/hookPath.js";
