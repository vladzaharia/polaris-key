/**
 * The UI kits the `build/ui/` docs section knows about: the must and should rows of
 * docs/design/UI-KITS.md §5.1 that ship a kit (the could rows are recipes, and the host design
 * systems are presets, so neither has a row here).
 *
 * One row per kit:
 *   - `id` is the framework page's slug (`/docs/build/ui/frameworks/<id>/`), the sample's folder
 *     (`examples/ui/<id>/`) and, for a kit that records baselines, the `kit` id of ui-qa's
 *     BASELINE_DIRS (packages/ui-qa/src/config.ts). test/ui.test.ts holds the last one to it.
 *   - `label` is the tab label every kit-tabbed block uses. Starlight syncs tabs that share a
 *     label across pages (syncKey "ui-kit"), so a reader who picks "Compose" once keeps it.
 *   - `current` points at the page that documents the kit as it is today, before its rebuild to
 *     the UI-kit spec, when there is one.
 */

export type Tier = "must" | "should";

/** Where a kit is: it ships today, or the work package that builds it. */
export type KitStatus = { ships: true } | { planned: string };

export interface UiKit {
  id: string;
  label: string;
  /** The §5.1 framework column. */
  framework: string;
  /** The §5.1 language or SDK column. */
  sdk: "JS / TS" | "Swift" | "Kotlin" | "Godot" | "Python" | "Node";
  tier: Tier;
  /** The package or module a host installs. */
  package: string;
  /** "Ships today" or "Planned in UK-xx". The package's rebuild (UK-05, UK-07, …) does not change
   *  a shipped kit's status: the names it ships now are the ones its page documents. */
  status: KitStatus;
  current?: { label: string; href: string };
}

export const UI_KITS: readonly UiKit[] = [
  {
    id: "elements",
    label: "Web components",
    framework: "Web Components (Lit 3)",
    sdk: "JS / TS",
    tier: "must",
    package: "@polaris-key/elements",
    status: { planned: "UK-04" },
  },
  {
    id: "react",
    label: "React",
    framework: "React (web, Electron renderer, Tauri, Next.js)",
    sdk: "JS / TS",
    tier: "must",
    package: "@polaris-key/react",
    status: { ships: true },
    current: { label: "React SDK", href: "/docs/build/sdks/react/" },
  },
  {
    id: "electron",
    label: "Electron",
    framework: "Electron (main and preload)",
    sdk: "JS / TS",
    tier: "must",
    package: "@polaris-key/electron",
    status: { planned: "UK-06" },
  },
  {
    id: "vue",
    label: "Vue",
    framework: "Vue 3 and Nuxt",
    sdk: "JS / TS",
    tier: "should",
    package: "@polaris-key/vue",
    status: { planned: "UK-17" },
  },
  {
    id: "svelte",
    label: "Svelte",
    framework: "Svelte 5 and SvelteKit",
    sdk: "JS / TS",
    tier: "should",
    package: "@polaris-key/svelte",
    status: { planned: "UK-18" },
  },
  {
    id: "angular",
    label: "Angular",
    framework: "Angular",
    sdk: "JS / TS",
    tier: "should",
    package: "@polaris-key/angular",
    status: { planned: "UK-19" },
  },
  {
    id: "react-native",
    label: "React Native",
    framework: "React Native and Expo",
    sdk: "JS / TS",
    tier: "should",
    package: "@polaris-key/react-native",
    status: { planned: "UK-20" },
  },
  {
    id: "tauri",
    label: "Tauri",
    framework: "Tauri v2",
    sdk: "JS / TS",
    tier: "should",
    package: "tauri-plugin-polaris-key",
    status: { planned: "UK-21" },
  },
  {
    id: "swiftui",
    label: "SwiftUI",
    framework: "SwiftUI (iOS, iPadOS, macOS; visionOS and tvOS later)",
    sdk: "Swift",
    tier: "must",
    package: "PolarisKeyUI",
    status: { ships: true },
    current: { label: "Swift SDK", href: "/docs/build/sdks/swift/" },
  },
  {
    id: "uikit",
    label: "UIKit",
    framework: "UIKit and Mac Catalyst",
    sdk: "Swift",
    tier: "should",
    package: "PolarisKeyUIKit",
    status: { planned: "UK-23" },
  },
  {
    id: "appkit",
    label: "AppKit",
    framework: "AppKit",
    sdk: "Swift",
    tier: "should",
    package: "PolarisKeyAppKit",
    status: { planned: "UK-24" },
  },
  {
    id: "compose",
    label: "Compose",
    framework: "Jetpack Compose (Android today; Compose Multiplatform planned)",
    sdk: "Kotlin",
    tier: "must",
    package: "im.plrs.key:polaris-key-ui",
    status: { ships: true },
    current: { label: "Compose", href: "/docs/build/ui/frameworks/compose/" },
  },
  {
    id: "android-views",
    label: "Android Views",
    framework: "Android Views (XML, Fragments)",
    sdk: "Kotlin",
    tier: "should",
    package: "im.plrs.key:polaris-key-ui-views",
    status: { planned: "UK-28" },
  },
  {
    id: "godot",
    label: "Godot",
    framework: "Godot Control nodes (GDScript)",
    sdk: "Godot",
    tier: "must",
    package: "the addons/polaris_key addon",
    status: { ships: true },
    current: { label: "Godot", href: "/docs/build/ui/frameworks/godot/" },
  },
  {
    id: "godot-dotnet",
    label: "Godot .NET",
    framework: "Godot .NET (C#)",
    sdk: "Godot",
    tier: "should",
    package: "the addon's C# facade",
    status: { planned: "UK-29" },
  },
  {
    id: "qt",
    label: "Qt",
    framework: "Qt (PySide6, PyQt6)",
    sdk: "Python",
    tier: "must",
    package: "polaris-key[qt]",
    status: { planned: "UK-12" },
  },
  {
    id: "terminal-python",
    label: "Terminal (Python)",
    framework: "Terminal (rich, Textual)",
    sdk: "Python",
    tier: "must",
    package: "polaris-key[cli]",
    status: { ships: true },
    current: { label: "Python SDK", href: "/docs/build/sdks/python/" },
  },
  {
    id: "terminal-node",
    label: "Terminal (Node)",
    framework: "Terminal (CLI prompts, pkey)",
    sdk: "Node",
    tier: "must",
    package: "@polaris-key/node",
    status: { ships: true },
    current: {
      label: "Terminal (Node)",
      href: "/docs/build/ui/frameworks/terminal-node/",
    },
  },
];

export function statusLabel(kit: UiKit): string {
  return "ships" in kit.status
    ? "Ships today"
    : `Planned in ${kit.status.planned}`;
}

export function kitById(id: string): UiKit {
  const kit = UI_KITS.find((k) => k.id === id);
  if (kit === undefined) throw new Error(`unknown UI kit "${id}"`);
  return kit;
}

/** The framework page's URL. */
export function frameworkHref(kit: UiKit): string {
  return `/docs/build/ui/frameworks/${kit.id}/`;
}
