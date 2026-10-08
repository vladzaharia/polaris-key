/**
 * Shared set-up for the Release section's page suites (releases, channels, packs,
 * compatibility): mount a page at a hash with the providers the shell gives it, stub what jsdom
 * lacks, and run axe the way the kit suite does.
 */

import * as React from "react";
import { render, type RenderResult } from "@testing-library/react";
import { configureAxe } from "vitest-axe";
import { expect } from "vitest";
import { ConsoleQueryProvider } from "../src/console/data/queryClient.js";
import { resetRouterForTests } from "../src/console/router.js";
import { Announcer } from "../src/ui/LiveRegion.js";
import { TooltipProvider } from "../src/ui/Tooltip.js";

/** jsdom lacks these APIs that Radix and cmdk reach for. */
export function stubDom(): void {
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
}

/** Mount `ui` with the router at `hash` and a fresh query cache. */
export function mountAt(hash: string, ui: React.ReactElement): RenderResult {
  window.location.hash = hash;
  resetRouterForTests();
  stubDom();
  return render(
    <ConsoleQueryProvider>
      <TooltipProvider delayDuration={300}>
        {ui}
        <Announcer />
      </TooltipProvider>
    </ConsoleQueryProvider>,
  );
}

/** The current hash's query, parsed. */
export function hashQuery(): URLSearchParams {
  const h = window.location.hash;
  const i = h.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : h.slice(i + 1));
}

/**
 * jsdom computes no layout or colour, so `color-contrast` is the brand suite's and the browser's
 * job; `region` is off because a page renders here without the shell's landmarks.
 */
const axe = configureAxe({
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
});

export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe(container);
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

/** A promise that never settles: a query stays in its loading state. */
export function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}
