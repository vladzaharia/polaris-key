/**
 * The questions `pkey init` asks on a terminal (ST-46.3): "What is it for?" (a multi-select over
 * the console's features, with the console's rules) and, when Licensing is chosen, "Start with a
 * Free tier?". Only for answers the flags did not give, and only when stdin and stdout are
 * terminals, not CI and not TERM=dumb (D-S5). Anywhere else the caller never gets here and init
 * is what it always was (D-S3).
 */

import {
  featureNeeds,
  featureUnlocked,
  MANIFEST_FEATURES,
  servicesForFeatures,
  toggleFeature,
  type ManifestFeatureId,
  type ProductModule,
} from "@polaris-key/manifest";
import {
  CANCEL,
  clean,
  fitScreen,
  INTERRUPT,
  keyHints,
  KeyReader,
  layoutColumns,
  promptConfirm,
  promptMultiSelect,
  railLines,
  type Line,
  type PromptContext,
  type RailRow,
  type TerminalInput,
} from "@polaris-key/node/terminal";
import type { Term, TermOut } from "./terminal.js";

/** The keys init reads: a real `KeyReader`, or a test's scripted one. */
export type InitKeys = Pick<KeyReader, "next" | "close">;

export interface InitAnswers {
  modules?: ProductModule[];
  starterTier?: "free" | "none";
}

export interface InitAsk {
  term: Term;
  stdout: TermOut;
  stdin: TerminalInput;
  keys?: InitKeys;
  /** The product name init will write (the question names it). */
  name: string;
  /** The services `--modules` named, when it was given: the features are not asked then. */
  givenServices?: readonly string[];
  /** `--starter-tier` was given: the tier is not asked. */
  tierGiven: boolean;
}

/** Ticked when the question opens. */
export const INITIAL_FEATURES: readonly ManifestFeatureId[] = [
  "licensing",
  "ship-builds",
];

const KEYS = (ascii: boolean) =>
  `${ascii ? "Up/Down" : "↑↓"} move · Space toggle · Enter confirm · Esc cancel`;
const CONFIRM_KEYS = "y yes · n no · Esc cancel";

/** "A, B and C". */
const andList = (xs: readonly string[]): string =>
  xs.length > 1
    ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`
    : (xs[0] ?? "");

/** The prompts may run: both streams are terminals, not CI, not TERM=dumb. */
export function mayPrompt(term: Term, stdin: { isTTY?: boolean }): boolean {
  return term.caps.interactive && stdin.isTTY === true;
}

const missing = (
  id: ManifestFeatureId,
  chosen: readonly ManifestFeatureId[],
): string[] =>
  featureNeeds(id)
    .filter((n) => !chosen.includes(n))
    .map(labelOf);

const labelOf = (id: ManifestFeatureId): string =>
  MANIFEST_FEATURES.find((f) => f.id === id)!.label;

const text = (t: string, style?: string[]): Line => [
  style ? { text: t, style } : { text: t },
];

/** The answers, or the exit code when the person cancelled (nothing is written then). */
export async function askInit(ask: InitAsk): Promise<InitAnswers | number> {
  const { term, stdout } = ask;
  const keys = ask.keys ?? new KeyReader(ask.stdin);
  const caps = { ...term.caps };
  const render = (rows: readonly RailRow[]) =>
    railLines(rows, term.painter, term.symbols, caps.columns);
  const ctx: PromptContext = {
    caps,
    painter: term.painter,
    symbols: term.symbols,
    out: stdout as PromptContext["out"],
    keys: keys as KeyReader,
    host: {
      caps,
      refreshSize: () => {
        if (stdout.columns) caps.columns = layoutColumns(stdout.columns);
        if (stdout.rows) caps.rows = stdout.rows;
      },
      render,
      fit: (rows) =>
        fitScreen(rows, {
          maxRows: caps.rows - 1,
          columns: caps.columns,
          separator: term.symbols.separator,
          render,
        }),
    },
  };
  const cancelled = (): RailRow[] => [
    { mark: "warn", spans: text("Canceled. Nothing was written.") },
  ];
  const exit = (r: unknown): number | null =>
    r === INTERRUPT ? 130 : r === CANCEL ? 1 : null;
  try {
    const answers: InitAnswers = {};
    let licensing = false;
    if (!ask.givenServices) {
      const r = await promptMultiSelect<ManifestFeatureId>(ctx, {
        title: text(`What is ${clean(ask.name)} for?`),
        options: MANIFEST_FEATURES.map((f) => ({
          value: f.id,
          label: text(f.label),
        })),
        initial: INITIAL_FEATURES,
        hints: keyHints(KEYS(term.symbols.rail === "|"), term.symbols),
        toggle: (chosen, id) => {
          const t = toggleFeature(chosen, id, !chosen.includes(id));
          return {
            chosen: t.features,
            note: t.cleared.length
              ? text(
                  `${andList(t.cleared.map(labelOf))} ${t.cleared.length === 1 ? "is" : "are"} off too: ${t.cleared.length === 1 ? "it needs" : "they need"} ${labelOf(id)}.`,
                  ["muted"],
                )
              : null,
          };
        },
        locked: (id, chosen) =>
          featureUnlocked(id, chosen)
            ? null
            : text(`Needs ${andList(missing(id, chosen))}`),
        lockedNote: (id, chosen) =>
          text(`Tick ${andList(missing(id, chosen))} first.`),
        check: (chosen) => (chosen.length ? null : text("Tick at least one.")),
        done: (chosen) => [
          {
            mark: "done",
            spans: [
              ...text("Features  "),
              {
                text: chosen.map(labelOf).join(", "),
                style: ["strong"],
              },
            ],
          },
        ],
        cancelled,
      });
      const code = exit(r);
      if (code !== null) return code;
      const features = r as ManifestFeatureId[];
      licensing = features.includes("licensing");
      answers.modules = servicesForFeatures(features).services;
    } else licensing = ask.givenServices.includes("license");
    if (licensing && !ask.tierGiven) {
      const r = await promptConfirm(ctx, {
        title: text("Start with a Free tier? (Y/n)"),
        detail: text("Lifetime, 5 devices."),
        hints: keyHints(CONFIRM_KEYS, term.symbols),
        initial: true,
        done: (yes) => [
          {
            mark: "done",
            spans: [
              ...text("Free tier  "),
              { text: yes ? "Yes" : "No", style: ["strong"] },
            ],
          },
        ],
        cancelled,
      });
      const code = exit(r);
      if (code !== null) return code;
      answers.starterTier = r === true ? "free" : "none";
    }
    return answers;
  } finally {
    keys.close();
  }
}
