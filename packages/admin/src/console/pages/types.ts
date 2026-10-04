import type { Route } from "../routes.js";

/** A product route, as a section's page module receives it. */
export type ProductRoute = Extract<Route, { kind: "product" }>;

export interface SectionPageProps {
  route: ProductRoute;
}
