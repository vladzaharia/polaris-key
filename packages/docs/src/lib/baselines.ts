/**
 * The kits' committed visual-QA baselines (docs/design/UI-KITS.md §7.1), imported straight from
 * each kit's baseline directory so the component pages show what the kit's tests compare
 * against, and cannot drift from it (§6.2). A baseline that is renamed or removed simply leaves
 * the page; nothing is copied or committed under packages/docs.
 *
 * Every file a glob matches is emitted into the site, whether a page shows it or not, so each
 * kit's pattern is its **docs subset**: one default render per state and theme, never every
 * size, preset and font scale the kit records. A kit narrows or widens its own line when it
 * lands its baselines; the default is ui-qa's flat `<state>-<theme>.png` at the top of the
 * directory. Vite needs each pattern and its options as literals, which is why the calls repeat.
 *
 * `DIRS` must equal ui-qa's BASELINE_DIRS, and every pattern must sit inside its kit's directory:
 * test/ui.test.ts checks both, so a kit that moves its baselines updates this file too.
 */

import type { ImageMetadata } from "astro";
import { classify, type ShotName } from "./shots";

/** Where each kit commits its baselines, relative to the repository root (ui-qa BASELINE_DIRS). */
export const DIRS: Readonly<Record<string, string>> = {
  react: "packages/sdk-react/test/visual/__screenshots__",
  elements: "packages/elements/test/visual/__screenshots__",
  vue: "packages/vue/test/visual/__screenshots__",
  svelte: "packages/svelte/test/visual/__screenshots__",
  angular: "packages/angular/test/visual/__screenshots__",
  swiftui: "sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__",
  compose: "sdks/kotlin/ui/src/test/snapshots",
  godot: "sdks/godot/tests/ui/snapshots",
  qt: "sdks/python/tests/ui/snapshots",
  "terminal-node": "packages/sdk-node/test/cli/golden",
  "terminal-python": "sdks/python/tests/cli/golden",
};

/** The glob keys are relative to this file; this prefix reaches the repository root. */
const ROOT = "../../../../";

const GLOBS: Readonly<Record<string, Record<string, ImageMetadata>>> = {
  react: import.meta.glob<ImageMetadata>(
    "../../../../packages/sdk-react/test/visual/__screenshots__/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  elements: import.meta.glob<ImageMetadata>(
    "../../../../packages/elements/test/visual/__screenshots__/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  vue: import.meta.glob<ImageMetadata>(
    "../../../../packages/vue/test/visual/__screenshots__/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  svelte: import.meta.glob<ImageMetadata>(
    "../../../../packages/svelte/test/visual/__screenshots__/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  angular: import.meta.glob<ImageMetadata>(
    "../../../../packages/angular/test/visual/__screenshots__/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  swiftui: import.meta.glob<ImageMetadata>(
    "../../../../sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  // Roborazzi's layout, <state>/<variant>-<theme>.png; the docs show the branded phone render.
  compose: import.meta.glob<ImageMetadata>(
    "../../../../sdks/kotlin/ui/src/test/snapshots/*/phone-branded-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  godot: import.meta.glob<ImageMetadata>(
    "../../../../sdks/godot/tests/ui/snapshots/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  qt: import.meta.glob<ImageMetadata>(
    "../../../../sdks/python/tests/ui/snapshots/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  "terminal-node": import.meta.glob<ImageMetadata>(
    "../../../../packages/sdk-node/test/cli/golden/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
  "terminal-python": import.meta.glob<ImageMetadata>(
    "../../../../sdks/python/tests/cli/golden/*-{dark,light}.png",
    { eager: true, import: "default" },
  ),
};

export interface Baseline extends ShotName {
  kit: string;
  /** Repository-relative path of the committed file. */
  file: string;
  image: ImageMetadata;
}

/** One state (and variant) of one component in one kit, in both themes where both exist. */
export interface BaselinePair {
  kit: string;
  component: string | null;
  state: string;
  variant: string;
  name: string;
  dark?: Baseline;
  light?: Baseline;
}

function collect(): Baseline[] {
  const out: Baseline[] = [];
  for (const [kit, files] of Object.entries(GLOBS)) {
    const dir = `${ROOT}${DIRS[kit]}/`;
    for (const [key, image] of Object.entries(files)) {
      if (!key.startsWith(dir)) continue;
      const shot = classify(key.slice(dir.length));
      if (shot === null) continue;
      out.push({ ...shot, kit, file: key.slice(ROOT.length), image });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export const BASELINES: readonly Baseline[] = collect();

/** Group baselines into dark/light pairs. */
export function pairs(baselines: readonly Baseline[]): BaselinePair[] {
  const byKey = new Map<string, BaselinePair>();
  for (const b of baselines) {
    const key = [b.kit, b.component ?? "", b.name, b.state, b.variant].join(
      "\u0000",
    );
    let pair = byKey.get(key);
    if (pair === undefined) {
      pair = {
        kit: b.kit,
        component: b.component,
        state: b.state,
        variant: b.variant,
        name: b.name,
      };
      byKey.set(key, pair);
    }
    pair[b.theme] = b;
  }
  return [...byKey.values()];
}

/** A pair's visible label: the state (or "default"), then the variant. */
export function pairLabel(
  pair: Pick<BaselinePair, "state" | "variant">,
): string {
  return [pair.state === "" ? "default" : pair.state, pair.variant]
    .filter((s) => s !== "")
    .join(" · ");
}
