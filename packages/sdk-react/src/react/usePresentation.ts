// `usePresentation()`: discovery's `core.presentation` for a React screen (HA-13). The adapter's
// `presentationSource()` holds the member and the verified icon; this hook re-renders when the
// member changes and hands out the icon as a `blob:` URL (D2: an integrator's CSP needs
// `img-src blob:`). No presentation, or an icon that failed its fetch or its hash, is `null`:
// the screen keeps its monogram, and nothing is an error.

import { useContext, useEffect, useState } from "react";
import type { ProductPresentation } from "@polaris-key/client-core/presentation";
import type { ReactPresentationSource } from "../core/presentation.js";
import { PolarisContext } from "./context.js";

export interface UsePresentationOptions {
  /** The hero's size in CSS px. Default 64. */
  px?: number;
  /** The screen's scale. Default `window.devicePixelRatio`, else 1. */
  scale?: number;
}

export interface UsePresentation {
  /** The member as client-core normalised it, or null (none served, or not known yet). */
  presentation: ProductPresentation | null;
  /** A `blob:` URL of the verified icon, or null. */
  iconUrl: string | null;
}

const NONE: UsePresentation = { presentation: null, iconUrl: null };

function defaultScale(): number {
  const dpr =
    typeof window !== "undefined" ? Number(window.devicePixelRatio) : NaN;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/** The presentation of `source` (null: none), re-rendered on every change. */
export function usePresentationOf(
  source: ReactPresentationSource | null,
  o: UsePresentationOptions = {},
): UsePresentation {
  const px = o.px ?? 64;
  const scale = o.scale ?? defaultScale();
  const [presentation, setPresentation] = useState<ProductPresentation | null>(
    () => safeCurrent(source),
  );
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!source) {
      setPresentation(null);
      return;
    }
    setPresentation(safeCurrent(source));
    try {
      return source.subscribe((p) => setPresentation(p));
    } catch {
      return undefined;
    }
  }, [source]);

  const iconKey = presentation?.icon?.sha256 ?? null;
  useEffect(() => {
    let live = true;
    setIconUrl(null);
    if (!source || iconKey === null) return;
    source
      .iconUrl(px, scale)
      .then((url) => {
        if (live) setIconUrl(url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [source, iconKey, px, scale]);

  return source ? { presentation, iconUrl } : NONE;
}

function safeCurrent(
  source: ReactPresentationSource | null,
): ProductPresentation | null {
  try {
    return source?.current() ?? null;
  } catch {
    return null;
  }
}

/**
 * The product's presentation from discovery, inside a `<PolarisKeyProvider>`: its name,
 * developer, accents, and a `blob:` URL of its verified icon. The integrator's own theme always
 * wins where it sets a value; this is what the kit shows when it sets none.
 */
export function usePresentation(
  o: UsePresentationOptions = {},
): UsePresentation {
  const ctx = useContext(PolarisContext);
  if (!ctx)
    throw new Error("usePresentation must be used inside <PolarisKeyProvider>");
  return usePresentationOf(ctx.adapter.presentationSource(), o);
}
