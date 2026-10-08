/**
 * The shared look of the text controls (components.md §3.3): a 3:1 control boundary
 * (`border-border-strong`), the sunken well, the violet focus ring, the danger edge when invalid,
 * 36 px tall (32 px minimum hit target, 36 px on coarse pointers).
 */
export const CONTROL_INPUT = [
  "h-9 w-full min-w-0 rounded-md border border-border-strong bg-surface-sunken px-3 text-sm text-fg",
  "transition-colors duration-(--pk-duration-fast) ease-standard",
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "read-only:bg-surface-page read-only:text-fg-muted",
  "aria-[invalid=true]:border-danger",
  "pointer-coarse:h-10",
].join(" ");
