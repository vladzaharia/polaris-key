/**
 * The Locker's inline link (BRAND §7.9; SIGN-IN §3.1.1): weight 400, `--pk-text-default`, a 1 px
 * `--pk-border-strong` underline at a 3 px offset with skip-ink, `--pk-text-strong` on hover, the family's
 * focus ring. It inherits the size of the sentence it sits in. Standalone card links use
 * `AUTH_LINK_CLASS` (14/20, 44 px target under a coarse pointer).
 */
export const LINK_CLASS =
  "rounded-sm font-normal text-fg underline decoration-border-strong decoration-1 underline-offset-[3px] [text-decoration-skip-ink:auto] transition-colors duration-(--pk-duration-fast) hover:text-fg-strong hover:decoration-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
