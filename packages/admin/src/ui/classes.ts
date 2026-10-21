/*
 * Class constants for the parts of the console's `ui/` that other surfaces draw too (docs plan
 * 2026-10-08 section 8.2, D7). The console's components use these strings themselves; the docs
 * site imports them for the parts it builds as Astro markup, so no docs file writes its own
 * class string for a part the console has (`packages/docs/test/docsClasses.test.ts`).
 *
 * Strings only: no React, no imports, so an Astro file can import this module.
 */

// ---- Button (ui/Button.tsx) ------------------------------------------------------------------

/** What every button shares: shape, the press pattern, the focus ring, the disabled look. */
export const BUTTON_BASE = [
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-normal",
  // The press pattern (src/motion.css `.pk-pressable`, S-23 §6.1): 0.98 on :active, never when
  // disabled or busy, with the colours at `micro`. Scale is paint only, so neighbours never move.
  "pk-pressable",
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
  "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:not-aria-busy:cursor-not-allowed aria-disabled:not-aria-busy:opacity-50",
  "[&_svg]:shrink-0",
].join(" ");

/** Button variants by name. */
export const BUTTON_VARIANTS = {
  primary:
    "bg-accent text-accent-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-accent),white_10%)] disabled:bg-action-disabled disabled:text-action-disabled-on disabled:opacity-100 disabled:shadow-none aria-disabled:not-aria-busy:bg-action-disabled aria-disabled:not-aria-busy:text-action-disabled-on aria-disabled:not-aria-busy:opacity-100 aria-disabled:not-aria-busy:shadow-none",
  /**
   * The action-neutral primary (BRAND.md B2, SIGN-IN.md §3.1): near-white ink on dark,
   * near-black on light, the label in the page colour. The sign-in card's one filled
   * action; disabled keeps the shape at the role's disabled pair.
   */
  neutral:
    "bg-action text-action-on font-medium hover:not-disabled:not-aria-disabled:bg-action-hover active:not-disabled:not-aria-disabled:bg-action-pressed disabled:bg-action-disabled disabled:text-action-disabled-on disabled:opacity-100 aria-disabled:not-aria-busy:bg-action-disabled aria-disabled:not-aria-busy:text-action-disabled-on aria-disabled:not-aria-busy:opacity-100 forced-colors:bg-[ButtonFace] forced-colors:text-[ButtonText]",
  secondary:
    "bg-hover text-fg-strong hover:not-disabled:not-aria-disabled:bg-surface-sunken",
  outline:
    "border border-border-strong bg-transparent text-fg hover:not-disabled:not-aria-disabled:bg-hover hover:not-disabled:not-aria-disabled:text-fg-strong",
  ghost:
    "bg-transparent text-fg hover:not-disabled:not-aria-disabled:bg-hover hover:not-disabled:not-aria-disabled:text-fg-strong",
  danger:
    "bg-danger text-danger-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-danger),white_10%)] disabled:bg-action-disabled disabled:text-action-disabled-on disabled:opacity-100 disabled:shadow-none aria-disabled:not-aria-busy:bg-action-disabled aria-disabled:not-aria-busy:text-action-disabled-on aria-disabled:not-aria-busy:opacity-100 aria-disabled:not-aria-busy:shadow-none",
  /** Deprecated alias of `danger`, kept for the legacy views until chunk 11. */
  destructive:
    "bg-danger text-danger-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-danger),white_10%)] disabled:bg-action-disabled disabled:text-action-disabled-on disabled:opacity-100 disabled:shadow-none aria-disabled:not-aria-busy:bg-action-disabled aria-disabled:not-aria-busy:text-action-disabled-on aria-disabled:not-aria-busy:opacity-100 aria-disabled:not-aria-busy:shadow-none",
  link: "h-auto px-0 text-accent-fg underline-offset-4 hover:underline",
  /**
   * The customer portal's outlined quick action (PORTAL.md §5.2): transparent, a
   * `border-border-strong` outline, a `text-fg-strong` label, the icon in `text-accent-fg`.
   */
  quiet:
    "border border-border-strong bg-transparent font-medium text-fg-strong [&_svg]:text-accent-fg hover:not-disabled:not-aria-disabled:bg-hover",
  /**
   * The portal header's Activate license (PORTAL.md §5.2): `bg-surface-raised`, a
   * `border-border-strong` outline, the key glyph in `text-accent-fg`.
   */
  action:
    "border border-border-strong bg-surface-raised font-medium text-fg-strong [&_svg]:text-accent-fg hover:not-disabled:not-aria-disabled:bg-hover",
} as const;

/** Button sizes by name. */
export const BUTTON_SIZES = {
  xs: "h-7 min-w-7 px-2 text-xs [&_svg]:size-3.5",
  sm: "h-8 min-w-8 px-3 text-xs [&_svg]:size-4",
  md: "h-9 min-w-9 px-4 text-sm [&_svg]:size-4",
  lg: "h-10 min-w-10 px-6 text-sm [&_svg]:size-4",
  /** Deprecated: a square icon button. Use `IconButton`. */
  icon: "size-9 text-sm [&_svg]:size-4",
} as const;

// ---- Table (ui/data-table/DataTable.tsx) -----------------------------------------------------

/**
 * `DataTable`'s head, row and cell. `rowCompact` / `rowComfortable` are the two densities (the
 * docs use compact on reference pages); the line under a row belongs to its cells.
 */
export const TABLE = {
  table: "table w-full min-w-full border-separate [border-spacing:0] text-sm",
  head: "sticky top-0 z-[2] bg-surface-raised",
  headRow: "[&>th]:border-b [&>th]:border-border",
  headCell:
    "h-9 px-3 align-middle text-xs leading-4 font-medium whitespace-nowrap text-fg-muted",
  rowCompact: "h-9",
  rowComfortable: "h-14",
  row: "bg-surface-raised text-sm text-fg outline-hidden [&>td]:border-b [&>td]:border-border hover:bg-state-hover-tint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus data-[selected]:bg-accent-subtle [&.pk-row-highlight]:bg-accent-subtle",
  cell: "px-3 align-middle",
  /** A column of running text (docs tables): wide enough to read, instead of squeezed by its neighbours. */
  proseCell: "min-w-72",
  /**
   * The labelled, focusable region a table that may scroll sideways sits in (`ScrollTable`). The
   * region scrolls, not the table: a surrounding stylesheet that makes `table` a scrolling block
   * (Starlight's prose does) is undone here.
   */
  scroller:
    "relative overflow-x-auto [&>table]:table [&>table]:min-w-full [&>table]:overflow-visible",
} as const;

// ---- Code block (ui/CodeBlock.tsx) -----------------------------------------------------------

/** `CodeBlock`'s frame: the box, the header bar with the file or language label, the code. */
export const CODE_BLOCK = {
  frame: "overflow-hidden rounded-lg border border-border bg-surface-sunken",
  header: "flex items-center gap-2 border-b border-border px-3 py-1",
  title: "min-w-0 flex-1 truncate font-mono text-xs text-fg-muted",
  pre: "pk-scroll overflow-x-auto p-3 font-mono text-xs leading-5",
} as const;
