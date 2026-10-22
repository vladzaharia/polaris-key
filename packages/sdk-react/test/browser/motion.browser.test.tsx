// @pkey-feature ui.activate
//
// The step morph (UI-KITS.md §1.4 Web, DL16) in the React gate, in real Chromium: a step change
// runs one View Transition on the card, a cross-fade and an 8 px slide at the `base` token;
// reduced motion and a browser without the API swap at once. The elements run the same scenes
// (packages/elements/test/browser/motion.browser.test.ts).

import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import matrixJson from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };
import type { UiInput } from "@polaris-key/ui-core";

import * as Kit from "@polaris-key/react/kit";

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMotion: (motion: "reduce" | null) => Promise<void>;
  }
}

const m = matrixJson as unknown as {
  vocabulary: { defaults: Record<string, unknown> };
};
const gateInput = (status: string): UiInput =>
  ({
    elapsedMs: 60_000,
    ...m.vocabulary.defaults,
    gate: { status },
  }) as unknown as UiInput;

const original = document.startViewTransition;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  document.startViewTransition = original;
  await commands.emulateMotion(null);
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

const frames = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function gate(motion?: "reduced"): Promise<{
  rerender: (status: string) => void;
  root: HTMLElement;
}> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const theme = { colorScheme: "dark" as const, ...(motion ? { motion } : {}) };
  const rerender = (status: string) =>
    root!.render(
      <Kit.PolarisKeyGate input={gateInput(status)} theme={theme} />,
    );
  rerender("needs-activation");
  for (let i = 0; i < 100 && !host.querySelector(".pk-root"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await document.fonts.ready;
  await frames();
  return { rerender, root: host.querySelector<HTMLElement>(".pk-root")! };
}

function spy() {
  const seen: (ViewTransition & { drawn?: string | null | undefined })[] = [];
  const real = document.startViewTransition.bind(document);
  document.startViewTransition = ((cb?: ViewTransitionUpdateCallback) => {
    // What the card says at the moment the transition starts: the old step, not yet swapped.
    const drawn = document.querySelector(".pk-root h1")?.textContent;
    const t: ViewTransition & { drawn?: string | null | undefined } = real(cb);
    t.drawn = drawn;
    seen.push(t);
    return t;
  }) as typeof document.startViewTransition;
  return seen;
}

describe("the step morph", () => {
  it("runs one View Transition on the card: fade and an 8 px slide at the base token", async () => {
    const g = await gate();
    const seen = spy();
    const base = Number.parseFloat(
      getComputedStyle(g.root).getPropertyValue("--pk-duration-base"),
    );
    expect(base).toBeGreaterThan(0);
    const before = g.root.querySelector("h1")?.textContent;
    g.rerender("revoked");
    for (let i = 0; i < 50 && seen.length === 0; i++) await frames();
    expect(seen).toHaveLength(1);
    // The old card is still drawn until the transition has captured it.
    expect(seen[0]!.drawn).toBe(before);
    await seen[0]!.ready;
    expect(g.root.hasAttribute("data-morphing")).toBe(true);
    expect(
      getComputedStyle(g.root.querySelector(".card")!).viewTransitionName,
    ).toBe("pk-card");
    const by = (pseudo: string) =>
      document
        .getAnimations()
        .find(
          (a) => (a.effect as KeyframeEffect | null)?.pseudoElement === pseudo,
        )!.effect as KeyframeEffect;
    expect(by("::view-transition-new(pk-card)").getTiming().duration).toBe(
      base,
    );
    expect(by("::view-transition-old(pk-card)").getTiming().duration).toBe(
      base,
    );
    expect(
      JSON.stringify(by("::view-transition-new(pk-card)").getKeyframes()),
    ).toContain("translateY(8px)");
    await seen[0]!.finished;
    await frames();
    expect(g.root.querySelector("h1")?.textContent).not.toBe(before);
    expect(g.root.getAttribute("data-state")).toBe("blocked");
    expect(g.root.hasAttribute("data-morphing")).toBe(false);
  });

  it("is zero motion under prefers-reduced-motion", async () => {
    await commands.emulateMotion("reduce");
    const g = await gate();
    const seen = spy();
    g.rerender("revoked");
    for (let i = 0; i < 10; i++) await frames();
    expect(seen).toHaveLength(0);
    expect(g.root.getAttribute("data-state")).toBe("blocked");
  });

  it("is zero motion when the theme asks for reduced motion (base is 0 ms)", async () => {
    const g = await gate("reduced");
    const seen = spy();
    expect(
      getComputedStyle(g.root).getPropertyValue("--pk-duration-base"),
    ).toBe("0ms");
    g.rerender("revoked");
    for (let i = 0; i < 10; i++) await frames();
    expect(seen).toHaveLength(0);
    expect(g.root.getAttribute("data-state")).toBe("blocked");
  });

  it("falls back to an instant swap where startViewTransition is missing", async () => {
    const g = await gate();
    (document as unknown as Record<string, unknown>).startViewTransition =
      undefined;
    g.rerender("revoked");
    for (let i = 0; i < 10; i++) await frames();
    expect(g.root.getAttribute("data-state")).toBe("blocked");
    expect(g.root.hasAttribute("data-morphing")).toBe(false);
  });
});
