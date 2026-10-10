/**
 * The vocabulary shared by the frontmatter schema, the MDX components, the lints and the tests
 * (docs plan §2, §4). One list each, so a new SDK or page type is added in one place.
 */

/** Page types (README §2). `help` and `help-messages` are the consumer types. */
export const PAGE_TYPES = [
  "overview",
  "quickstart",
  "how-to",
  "concept",
  "reference",
  "troubleshooting",
  "help",
  "help-messages",
  "runbook",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** `shipped` pages are live. A `stub` reserves a path: hidden from the sidebar, search and sitemap. */
export const PAGE_STATUSES = ["shipped", "stub"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

/** The SDK picker's values, in display order. */
export const SDK_IDS = [
  "node",
  "react",
  "python",
  "swift",
  "kotlin",
  "godot",
] as const;
export type SdkId = (typeof SDK_IDS)[number];

export const SDK_LABELS: Readonly<Record<SdkId, string>> = {
  node: "Node",
  react: "React",
  python: "Python",
  swift: "Swift",
  kotlin: "Kotlin",
  godot: "Godot",
};

/** The two integration lanes: equal depth, no recommended one (README §0 D3). */
export const LANE_IDS = ["kit", "library"] as const;
export type LaneId = (typeof LANE_IDS)[number];

export const LANE_LABELS: Readonly<Record<LaneId, string>> = {
  kit: "Drop-in UI kit",
  library: "Your own UI",
};

/** Tab axes and their sync keys (README §4). */
export const SYNC_KEYS = {
  sdk: "sdk",
  lane: "lane",
  packageManager: "pm",
  surface: "surface",
} as const;

/** Where a step runs (style guide §6). */
export const STEP_PLACES = ["Console", "App", "Server", "CLI"] as const;
export type StepPlace = (typeof STEP_PLACES)[number];

/** Admonition types and their one meaning each (style guide §8). */
export const CALLOUT_TYPES = ["note", "tip", "caution", "danger"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

export const PILL_TONES = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "signed",
] as const;
export type PillTone = (typeof PILL_TONES)[number];

/** A kit component or feature on a platform: live, or a "Not built yet" row. */
export const STATUS_STATES = ["shipped", "not-built", "beta"] as const;
export type StatusState = (typeof STATUS_STATES)[number];

export const STATUS_LABELS: Readonly<Record<StatusState, string>> = {
  shipped: "Shipped",
  "not-built": "Not built yet",
  beta: "Beta",
};

/** The repo files `<RunbookSection>` can render by H2 section. */
export const RUNBOOK_FILES = ["RUNBOOK", "DEPLOYMENT"] as const;
export type RunbookFile = (typeof RUNBOOK_FILES)[number];
