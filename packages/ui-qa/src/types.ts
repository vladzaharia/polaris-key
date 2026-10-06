// Shared shapes of the modernity lint (UI-KITS.md §7.3).

/** Options passed to the in-page lint (src/browser/lint.js). */
export interface LintOptions {
  /** Each element matching this is one scope (default "[data-shot]"; the page if none). */
  scope?: string;
  /** The theme's font families; default: the first family of --pk-font-sans / --pk-font-mono. */
  fonts?: string[];
  /** Selectors where weight 700 is allowed (the game wordmark fallback, §1.5 rule 6). */
  allowWeight700?: string[];
  /** Dismissal labels that must not sit beside a close X (default: the English catalog words). */
  dismissWords?: string[];
  /** Selectors marked as chrome around the kit (status bars, keyboards, host apps, captions). */
  chrome?: string[];
  /** Selectors marked as touch variants (touch targets ≥ 44 px). */
  touch?: string[];
  /** rule id → selectors where that rule is allowed (each with its reason in config). */
  allow?: Record<string, string[]>;
  /** Check every authored style rule, not only those that match a linted element (kit CSS). */
  allRules?: boolean;
}

export interface Violation {
  rule: string;
  scope: string;
  target: string;
  detail: string;
}

export interface VisibleString {
  scope: string;
  target: string;
  text: string;
}

export interface LintResult {
  violations: Violation[];
  strings: VisibleString[];
}
