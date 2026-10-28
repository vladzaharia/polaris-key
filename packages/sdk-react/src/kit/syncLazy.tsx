"use client";
// The Cloud Sync screens load on demand (U-42.2): a page that never needs to unlock sync pays only
// for this file, and the gate's entry carries none of it (the size budget, SP-47).

import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

import type * as Screens from "./syncScreens.js";

type Name = "UnlockSync" | "RecoveryCode" | "RingChange";

/** A screen of `syncScreens.tsx`, imported the first time it is drawn. */
export function syncScreen<P>(name: Name): (props: P) => ReactNode {
  const Loaded = lazy(() =>
    import("./syncScreens.js").then((m: typeof Screens) => ({
      default: m[name] as unknown as ComponentType<Record<string, unknown>>,
    })),
  );
  const Screen = (props: P): ReactNode => (
    <Suspense fallback={null}>
      <Loaded {...(props as Record<string, unknown>)} />
    </Suspense>
  );
  Screen.displayName = name;
  return Screen;
}
