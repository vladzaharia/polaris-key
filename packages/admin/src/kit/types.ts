import type * as React from "react";

/** The gallery's groups, in display order (components.md §2–§7 plus the templates). */
export const KIT_GROUPS = [
  "Actions",
  "Forms",
  "Overlays",
  "Feedback",
  "Status and badges",
  "Data display",
  "Values",
  "Charts",
  "Templates",
] as const;

export type KitGroup = (typeof KIT_GROUPS)[number];

/**
 * One gallery entry: a component in one or more states. `render` returns plain JSX with fixture
 * data, no network. The jsdom axe suite (test/kit.test.tsx) renders every story in both themes.
 */
export interface Story {
  /** Stable, unique, kebab-case: the gallery anchor (`#/__kit?story=<id>`). */
  id: string;
  group: KitGroup;
  title: string;
  /** One line under the title: what the states show. */
  description?: string;
  render: () => React.ReactNode;
  /**
   * axe rule ids to skip for this story, each with the reason in a comment beside the story.
   * Prefer fixing the component.
   */
  axeDisable?: string[];
}
