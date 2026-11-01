"use client";
// The inter-account screens load on demand (CC-19.9), like the holder and Cloud Sync screens: a
// page that never pairs pays only for this file, and the gate's entry carries none of connect.tsx
// (the size budget, SP-47).

import {
  createElement,
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";

type Name = "LinkPairing" | "TransferOffer";
type Loose = ComponentType<Record<string, unknown>>;

/** A screen of `connect.tsx`, imported the first time it is drawn. */
export function connectScreen<P>(name: Name): (props: P) => ReactNode {
  const Loaded = lazy(async () => ({
    default: (await import("./connect.js"))[name] as unknown as Loose,
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
