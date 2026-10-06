/**
 * The command palette's source model (docs/design/EXPERIENCE.md §0.3 J-1).
 *
 * The palette is one component fed by a static list of **sources** (`registry.ts`). A source turns
 * the console's context (the product on screen, what it runs, the product list) and the query into
 * rows; the palette merges every source's rows, ranks them (`rank.ts`) and draws them in groups.
 * No source hard-codes another's rows: the navigation source knows pages, the actions source knows
 * actions, and the entity (UX-06b) and settings (ST-10) sources plug in beside them.
 */

import type * as React from "react";
import type { Me } from "../../../api.js";
import type { NavFeatures, PageId, ServiceState } from "../../nav.js";
import type { ProductLike } from "../bits.js";

/**
 * The heading a row is drawn under. The palette's own groups are listed in `PALETTE_GROUPS`
 * (`registry.ts`), which says their order and whether they show before anything is typed.
 */
export type PaletteGroup =
  | "Recent"
  | "Pages"
  | "Actions"
  | "Products"
  | "Platform"
  // A heading a later source adds (UX-06b's entities, ST-10's settings) without editing this list.
  | (string & {});

/** What the palette hands an action when it runs. */
export interface PaletteRunApi {
  /** Go to a console hash (built with `r.*`); the palette has already closed. */
  navigate: (href: string) => void;
  /**
   * Open a dialog or drawer over the current page, so an action finishes where the operator is
   * (EXPERIENCE.md §1 "Keep context"). `render` gets the open state to pass straight on.
   */
  openPanel: (render: PanelRender) => void;
}

/** A dialog the palette hosts after it closes: `<CreateLicenseDialog slug open onOpenChange />`. */
export type PanelRender = (props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => React.ReactNode;

/** One palette row. `id` is stable across renders: it keys the recents. */
export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Secondary text: the section and product, the product slug, or what an action needs. */
  detail: string;
  /** Extra words the filter matches. */
  keywords: string;
  icon: React.ReactNode;
  shortcut?: string;
  /** Where the row goes. A row has an `href`, a `perform`, or both (`perform` wins). */
  href?: string;
  /** What the row does instead of navigating (open a dialog, switch the theme). */
  perform?: (api: PaletteRunApi) => void;
  /** Shown only once the query matches it, never in the untyped list (EXPERIENCE.md §0.3 J-1). */
  matchOnly?: boolean;
  /**
   * A right-aligned issue pill (EXPERIENCE.md §7: pills only for issues). Entity rows (UX-06b)
   * carry one when the thing they name has a problem; healthy rows carry none.
   */
  issue?: { tone: "danger" | "warning"; label: string };
  product?: ProductLike;
}

/** A row that goes somewhere: every navigation and product row. */
export type LinkPaletteItem = PaletteItem & { href: string };

/** What the sources read: the console as the operator sees it right now. */
export interface PaletteContext {
  /** The product on screen, when it is one the session has. */
  slug: string | null;
  productName: string | null;
  /** What that product runs; `null` while it loads or off a product. */
  services: ServiceState;
  features: NavFeatures;
  /** Every product the operator can open, the system product excluded. */
  products: ProductLike[];
  /** The page on screen, if any. */
  page: PageId | null;
  me: Me;
}

/**
 * A palette source. `useItems` is called on every render of the open palette, in registry order,
 * so it may use hooks (a server-backed source queries with the query string). The registry is a
 * module constant, which keeps the hook order fixed.
 */
export interface PaletteSource {
  id: string;
  useItems: (ctx: PaletteContext, query: string) => PaletteItem[];
}
