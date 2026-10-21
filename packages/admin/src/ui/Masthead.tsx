import * as React from "react";

/** One ancestor in the masthead's orientation line. The last crumb of a page takes no link. */
export interface MastheadCrumb {
  label: React.ReactNode;
  /** A console hash. */
  to?: string;
}

/**
 * What the console shell tells a `PageHeader` about where it is (B4, console shell v2). The shell
 * owns the route, the product and the nav model; the header owns the layout. `ui/` cannot import
 * the console, so the shell hands its pieces over as nodes and a render function.
 */
export interface MastheadValue {
  /** The service accent of the page (`data-service`): the canvas rule, the chip and the tile. */
  accent: string;
  /** The route addresses a record (h1 32/40) rather than a collection or a landing (36/44). */
  record: boolean;
  /**
   * The 48 px tile, drawn from 1024 px only (B4): a product's icon on a product Core page, the
   * feature's glyph on a feature landing page. `null` on a dense data page.
   */
  tile: React.ReactNode | null;
  /**
   * The ONE orientation line: the glyph chip, the shell's ancestors (product, feature) and the
   * page's own `extra` crumbs. Never "Platform" on a product page, never an eyebrow repeating it.
   */
  orientation: (extra: MastheadCrumb[]) => React.ReactNode;
}

export const MastheadContext = React.createContext<MastheadValue | null>(null);

export function useMasthead(): MastheadValue | null {
  return React.useContext(MastheadContext);
}

/**
 * A crumb element a `PageHeader` can fold into the orientation line: `Breadcrumbs` marks itself
 * with `crumbsOf`, so the header reads its `items` instead of drawing a second line. Any other
 * eyebrow (a feed switcher) is drawn under the line, as before.
 */
export const CRUMBS_MARK = "pkCrumbs" as const;

export function crumbItemsOf(node: React.ReactNode): MastheadCrumb[] | null {
  if (!React.isValidElement(node)) return null;
  const type = node.type as { [CRUMBS_MARK]?: boolean };
  if (!type || type[CRUMBS_MARK] !== true) return null;
  const items = (node.props as { items?: MastheadCrumb[] }).items;
  return Array.isArray(items) ? items : null;
}
