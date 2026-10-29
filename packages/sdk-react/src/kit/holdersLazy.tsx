"use client";
// The two holder screens load on demand (UK-42), like the Cloud Sync screens: a page that never
// reaches the Done step after a license key pays only for this file, and the gate's entry carries
// none of holders.tsx (the size budget, SP-47).

import {
  createElement,
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";

type Name = "ActivateDone" | "AddToAccount";
type Loose = ComponentType<Record<string, unknown>>;

/** A screen of `holders.tsx`, imported the first time it is drawn. */
export function holderScreen<P>(name: Name): (props: P) => ReactNode {
  const Loaded = lazy(async () => ({
    default: (await import("./holders.js"))[name] as unknown as Loose,
  }));
  const Screen = (props: P): ReactNode =>
    createElement(
      Suspense,
      { fallback: null },
      createElement(Loaded, props as Record<string, unknown>),
    );
  Screen.displayName = name;
  return Screen;
}
