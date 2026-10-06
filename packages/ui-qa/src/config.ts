// What `pnpm ui:lint` and `pnpm ui:report` look at by default.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const BOARDS_DIR = "docs/design/ui-kits";
export const SHOTS_DIR = "docs/design/ui-kits/shots";
export const STRINGS_ALLOW = "packages/ui-qa/rules/strings.allow.json";

/**
 * Rule profiles. `web` is the full §7.3 set for the web kits (React, elements, Vue, Svelte,
 * Angular, and the Electron and Tauri renderers). `native` is the set that applies to a mockup of
 * a native kit drawn in HTML: the platform's own materials (glass, Mica, Adwaita, the Godot
 * panel) are drawn there with literal colours, and its controls take their states from the
 * platform rather than from CSS, so `colour-literal` and `interactive-states` are checked in the
 * native kit itself instead (the per-kit source lint, bin/kit-lint.mjs, and each kit's tests).
 */
export const PROFILES = {
  web: { skip: [] as string[] },
  native: { skip: ["colour-literal", "interactive-states"] },
} as const;
export type Profile = keyof typeof PROFILES;

export interface Board {
  name: string;
  /** The catalog platform its variants are written for (kit-copy `variants`). */
  platform: string;
  profile: Profile;
  /** Weight 700 is allowed only on these (§1.5 rule 6: the game wordmark fallback). */
  allowWeight700?: string[];
}

export const BOARDS: Board[] = [
  { name: "web", platform: "web", profile: "web" },
  { name: "ios", platform: "ios", profile: "native" },
  { name: "apple", platform: "ios", profile: "native" },
  { name: "android", platform: "android", profile: "native" },
  { name: "desktop", platform: "macos", profile: "native" },
  { name: "windows", platform: "windows", profile: "native" },
  { name: "linux", platform: "linux", profile: "native" },
  { name: "qt", platform: "qt", profile: "native" },
  {
    name: "godot",
    platform: "godot",
    profile: "native",
    allowWeight700: [".wordmark"],
  },
  { name: "terminal", platform: "terminal", profile: "native" },
];

/**
 * Where each kit commits its baselines (UI-KITS.md §7.1). `pnpm ui:report` shows whichever exist;
 * the mockup shots are always there. File names are `<state>-<theme>.png` (or
 * `<board>-<state>-<theme>.png` for the mockups).
 */
export const BASELINE_DIRS: Array<{ kit: string; dir: string }> = [
  { kit: "react", dir: "packages/sdk-react/test/visual/__screenshots__" },
  { kit: "elements", dir: "packages/elements/test/visual/__screenshots__" },
  { kit: "vue", dir: "packages/vue/test/visual/__screenshots__" },
  { kit: "svelte", dir: "packages/svelte/test/visual/__screenshots__" },
  { kit: "angular", dir: "packages/angular/test/visual/__screenshots__" },
  {
    kit: "swiftui",
    dir: "sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__",
  },
  { kit: "compose", dir: "sdks/kotlin/ui/src/test/snapshots" },
  { kit: "godot", dir: "sdks/godot/tests/ui/snapshots" },
  { kit: "qt", dir: "sdks/python/tests/ui/snapshots" },
  { kit: "terminal-node", dir: "packages/sdk-node/test/cli/golden" },
  { kit: "terminal-python", dir: "sdks/python/tests/cli/golden" },
];

/** The two web renderers that share one styles.css and must not drift (§7.1). */
export const CROSS_RENDERER = {
  a: "packages/sdk-react/test/visual/__screenshots__",
  b: "packages/elements/test/visual/__screenshots__",
};
