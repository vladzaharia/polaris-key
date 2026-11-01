"use client";
// The nearby sign-in screens load on demand (I-47b.3), like the inter-account ones: a page that
// never shows them pays only for this file (the size budget, SP-47).

import {
  createElement,
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";

type Name = "NearbySignIn" | "NearbyApprover" | "NearbyEntry";
type Loose = ComponentType<Record<string, unknown>>;

/** A screen of `nearby.tsx`, imported the first time it is drawn. */
export function nearbyScreen<P>(name: Name): (props: P) => ReactNode {
  const Loaded = lazy(async () => ({
    default: (await import("./nearby.js"))[name] as unknown as Loose,
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
