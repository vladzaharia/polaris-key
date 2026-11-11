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
type LocalName = "LocalPairing" | "PairedDevices";
type Loose = ComponentType<Record<string, unknown>>;
type Loader = () => Promise<Record<string, unknown>>;

/** The screen `name` of a module, imported the first time it is drawn. */
function lazyScreen<P>(name: string, load: Loader): (props: P) => ReactNode {
  const Loaded = lazy(async () => ({
    default: (await load())[name] as unknown as Loose,
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

/** A screen of `connect.tsx`, imported the first time it is drawn. */
export const connectScreen = <P,>(name: Name): ((props: P) => ReactNode) =>
  lazyScreen<P>(name, () => import("./connect.js"));

/** A screen of `localPairing.tsx` (Pair with a Code), imported the first time it is drawn. */
export const localScreen = <P,>(name: LocalName): ((props: P) => ReactNode) =>
  lazyScreen<P>(name, () => import("./localPairing.js"));
