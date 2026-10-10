/**
 * Code splitting per section (ADMIN.md §2.6): each section's pages are one lazy chunk, prefetched
 * when the operator hovers or focuses one of its sidebar items. Home and Products are in the main
 * chunk: they are where most sessions start.
 */

import * as React from "react";
import type { SectionKey } from "../nav.js";
import type { SectionPageProps } from "./types.js";

type Loader = () => Promise<{ default: React.ComponentType<SectionPageProps> }>;

const LOADERS: Record<SectionKey, Loader> = {
  core: () => import("../sections/core/index.js"),
  license: () => import("../sections/license/index.js"),
  config: () => import("../sections/config/index.js"),
  release: () => import("../sections/release/index.js"),
  distribution: () => import("../sections/distribution/index.js"),
  update: () => import("../sections/update/index.js"),
  identity: () => import("../sections/identity/index.js"),
  sync: () => import("../sections/sync/index.js"),
};

const LAZY = Object.fromEntries(
  Object.entries(LOADERS).map(([key, load]) => [key, React.lazy(load)]),
) as Record<
  SectionKey,
  React.LazyExoticComponent<React.ComponentType<SectionPageProps>>
>;

/** Start loading a section's chunk (idempotent: the module system caches it). */
export function prefetchSection(key: SectionKey): void {
  void LOADERS[key]().catch(() => undefined);
}

/** The lazy page component of a section. */
export function sectionPages(
  key: SectionKey,
): React.LazyExoticComponent<React.ComponentType<SectionPageProps>> {
  return LAZY[key];
}
