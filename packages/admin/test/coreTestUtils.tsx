/**
 * Shared set-up for the Core page suites (Overview, Services, Devices, Keys & secrets, Activity,
 * Settings): render one page at a hash with the providers it needs, the jsdom shims Radix wants,
 * and the axe configuration the kit suite uses.
 */

import * as React from "react";
import { render, type RenderResult } from "@testing-library/react";
import { configureAxe } from "vitest-axe";
import { expect } from "vitest";
import { KitProviders } from "../src/kit/KitProviders.js";
import { AppToaster } from "../src/ui/toast.js";
import { queryClient } from "../src/console/data/queryClient.js";
import { resetRouterForTests } from "../src/console/router.js";

/** jsdom computes no layout or colour; `region` is off because a page renders without the shell. */
const axe: (
  el: Element,
) => Promise<{ violations: { id: string; nodes: { target: unknown[] }[] }[] }> =
  configureAxe({
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });

export function shimDom(): void {
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

export function resetCore(): void {
  queryClient.clear();
  resetRouterForTests();
  window.location.hash = "";
  shimDom();
}

/** Mount `page` at `hash` (the page reads its filters from the URL). */
export function renderAt(hash: string, page: React.ReactElement): RenderResult {
  window.location.hash = hash;
  return render(
    <KitProviders>
      <div data-service="core">{page}</div>
      <AppToaster />
    </KitProviders>,
  );
}

/** Assert a container has no axe violations, listing them when it does. */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe(container);
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

/** The current hash's query, for URL round-trip assertions. */
export function hashQuery(): URLSearchParams {
  const h = window.location.hash;
  const i = h.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : h.slice(i + 1));
}
