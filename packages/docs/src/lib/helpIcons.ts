/**
 * The few line icons Help's chrome draws (24 px grid, 2 px stroke, round caps: the console's
 * Lucide set). Inline, so the page loads no icon font and the CSP needs nothing.
 */
const svg = (paths: string) =>
  `<svg class="pk-help-ic" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const HELP_ICONS = {
  moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  sun: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  ),
  arrowUpRight: svg('<path d="M7 7h10v10M7 17 17 7"/>'),
  arrowRight: svg('<path d="M5 12h14M12 5l7 7-7 7"/>'),
  copy: svg(
    '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  ),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  star: svg(
    '<path d="M11.5 2.3a.5.5 0 0 1 1 0l2.3 4.7a2 2 0 0 0 1.5 1.1l5.1.7a.5.5 0 0 1 .3.9l-3.7 3.6a2 2 0 0 0-.6 1.8l.9 5.1a.5.5 0 0 1-.7.5l-4.6-2.4a2 2 0 0 0-1.9 0l-4.6 2.4a.5.5 0 0 1-.7-.5l.9-5.1a2 2 0 0 0-.6-1.8L2.2 9.7a.5.5 0 0 1 .3-.9l5.1-.7A2 2 0 0 0 9.1 7l2.4-4.7Z"/>',
  ),
} as const;

/** The door cards' glyphs (the console's Lucide set, as HELP_ICONS). */
export const DOOR_ICONS = {
  help: svg(
    '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  ),
  code: svg('<path d="m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16"/>'),
  dashboard: svg(
    '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  ),
  lock: svg(
    '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  ),
} as const;
