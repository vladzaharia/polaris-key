/**
 * The console's own `ui/` components and class constants, as the docs use them (docs plan 2026-10-08
 * section 8.2, D7; components.md section 7). One entry point so a docs file never reaches into the
 * admin package by a deep path.
 *
 * Rendered by `@astrojs/react` at build time with no `client:` directive, so none of these ships
 * JavaScript: `Callout`, `StatusPill`, `Kbd`, `ServiceBadge` and `ServiceGlyph`, `SignedBadge`.
 * A component that needs the console's router, stores or query client (`PageHeader`'s masthead,
 * `Section`'s actions, `EmptyState`'s router link) is not rendered here; its class constants
 * are used instead.
 */

export { Callout } from "../../../admin/src/ui/Callout.tsx";
export { StatusPill } from "../../../admin/src/ui/StatusPill.tsx";
export { Kbd } from "../../../admin/src/ui/Kbd.tsx";
export {
  ServiceBadge,
  ServiceGlyph,
} from "../../../admin/src/ui/ServiceBadge.tsx";
export { SignedBadge } from "../../../admin/src/ui/SignedBadge.tsx";
export {
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  CODE_BLOCK,
  TABLE,
} from "../../../admin/src/ui/classes.ts";
