/**
 * The role x area matrix (ST-31.10): the rows behind the console's Roles tab and the docs page
 * `reference/roles`. Data only; `tools/gen-roles-matrix.ts` renders both from it, and
 * `test/rolesMatrix.test.ts` proves every cell against `can()` over one synthetic principal per
 * role, so a rule that changes in `can.ts` fails here until the matrix follows.
 *
 * A cell is one of three things:
 *   - `tick`: the role manages the area (`can()` allows it);
 *   - `none`: it does not (`can()` denies it, and no other door opens it);
 *   - `word`: an exception the tick would overstate or understate, named by one of the four
 *     exception words and explained by a footnote. `can` says what `can()` answers for the row's
 *     probe; the footnote says what else is true.
 */

import { AREAS, PRODUCT_AREAS, type AreaId } from "./areas.js";
import type { Role } from "./can.js";

/** The role columns, in display order. */
export const MATRIX_ROLES: readonly Role[] = [
  "superadmin",
  "platform_admin",
  "product_admin",
  "console_access",
];

/** The role names the console shows. */
export const ROLE_NAMES: Readonly<Record<Role, string>> = {
  superadmin: "Superadmin",
  platform_admin: "Platform admin",
  product_admin: "Product admin",
  console_access: "Console access",
};

export type ExceptionWord = "Create" | "Invite" | "Name only" | "Most";

export interface Footnote {
  id: string;
  word: ExceptionWord;
  /** The role whose cell it explains, when the same word means different things per role. */
  role?: Role;
  text: string;
}

export const FOOTNOTES: readonly Footnote[] = [
  { id: "name-only", word: "Name only", text: "Name and status on Home." },
  {
    id: "invite-platform",
    word: "Invite",
    role: "platform_admin",
    text: "Gives Console access and removes people without a platform role.",
  },
  {
    id: "invite-product",
    word: "Invite",
    role: "product_admin",
    text: "Gives Product admin of its product, up to its own areas.",
  },
  {
    id: "create",
    word: "Create",
    text: "Creating a product makes the person its admin.",
  },
  { id: "most", word: "Most", text: "All but the operator pages." },
];

export type Cell =
  | { kind: "tick" }
  | { kind: "none" }
  | {
      kind: "word";
      word: ExceptionWord;
      /** What `can()` (or, for Docs, the member and admin tiers) answers for the row's probe. */
      can: boolean;
      note: string;
    };

const TICK: Cell = { kind: "tick" };
const NONE: Cell = { kind: "none" };
const word = (w: ExceptionWord, can: boolean, note: string): Cell => ({
  kind: "word",
  word: w,
  can,
  note,
});

/** What `can()` is asked for a row. `docs` rows are read through the docs tiers instead. */
export type Probe =
  | { kind: "product"; area: AreaId }
  | { kind: "platform"; area: AreaId }
  | { kind: "docs" };

export interface MatrixRow {
  /** The area id for a product row (stable, stored in bindings); absent for a platform row. */
  area?: AreaId;
  /** Stable key for the row. */
  id: string;
  name: string;
  /** One short line of what the row covers, when the name alone does not say. */
  detail?: string;
  probe: Probe;
  /** One cell per `MATRIX_ROLES`, in that order. */
  cells: readonly [Cell, Cell, Cell, Cell];
}

/** What each product area covers, where the name alone is not enough. */
const PRODUCT_DETAIL: Partial<Record<AreaId, string>> = {
  core: "Overview, Integration, Access, Devices, Users, Activity",
  keys: "Signing keys, secrets, CI and service tokens",
  settings: "Features, presentation, repository, delete product",
  members: "Who can manage this product",
};

/** The product areas' cells. Core and Members carry the exceptions. */
function productCells(area: AreaId): MatrixRow["cells"] {
  if (area === "core")
    return [TICK, word("Name only", false, "name-only"), TICK, NONE];
  if (area === "members")
    return [TICK, NONE, word("Invite", true, "invite-product"), NONE];
  return [TICK, NONE, TICK, NONE];
}

/**
 * The ten product areas a Product admin holds per product, in `AREAS` order with Members last:
 * the product's own areas read first, then who manages it.
 */
export const PRODUCT_ROW_ORDER: readonly AreaId[] = [
  ...PRODUCT_AREAS.filter((a) => a !== "members"),
  "members",
];

export const PRODUCT_ROWS: readonly MatrixRow[] = PRODUCT_ROW_ORDER.map(
  (id) => {
    const def = AREAS.find((a) => a.id === id)!;
    return {
      area: id,
      id,
      name: def.name,
      ...(PRODUCT_DETAIL[id] ? { detail: PRODUCT_DETAIL[id] } : {}),
      probe: { kind: "product", area: id },
      cells: productCells(id),
    } satisfies MatrixRow;
  },
);

/** The platform rows: what a role does outside any one product. */
export const PLATFORM_ROWS: readonly MatrixRow[] = [
  {
    id: "platform-members",
    name: "Members",
    probe: { kind: "platform", area: "members" },
    cells: [TICK, word("Invite", true, "invite-platform"), NONE, NONE],
  },
  {
    id: "connections",
    name: "Connections",
    probe: { kind: "platform", area: "platform" },
    cells: [TICK, TICK, NONE, NONE],
  },
  {
    id: "platform-settings",
    name: "Platform settings",
    probe: { kind: "platform", area: "platform" },
    cells: [TICK, TICK, NONE, NONE],
  },
  {
    id: "packages-status",
    name: "Packages and Status",
    probe: { kind: "platform", area: "platform" },
    cells: [TICK, TICK, NONE, NONE],
  },
  {
    id: "new-products",
    name: "New products",
    probe: { kind: "platform", area: "platform" },
    cells: [TICK, word("Create", true, "create"), NONE, NONE],
  },
  {
    id: "docs",
    name: "Docs",
    probe: { kind: "docs" },
    cells: [
      TICK,
      TICK,
      word("Most", false, "most"),
      word("Most", false, "most"),
    ],
  },
];

export const MATRIX_ROWS: readonly MatrixRow[] = [
  ...PRODUCT_ROWS,
  ...PLATFORM_ROWS,
];

/** The footnote a word cell points at. */
export function footnoteOf(id: string): Footnote {
  const f = FOOTNOTES.find((n) => n.id === id);
  if (!f) throw new Error(`roles matrix: no footnote ${id}`);
  return f;
}
