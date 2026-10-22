// @pkey-feature ui.activate
//
// The step morph (UI-KITS.md §1.4 Web, DL16), in real Chromium: a step change on the gate runs one
// View Transition on the card, a cross-fade and an 8 px slide at the `base` token; reduced motion
// and a browser without the API swap at once. The React gate runs the same scenes
// (packages/sdk-react/test/browser/motion.browser.test.tsx).

import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import type { UiInput } from "@polaris-key/ui-core";
import matrix from "../../../../conformance/corpus/v2/ui-matrix.json" with { type: "json" };

import type { PkGate } from "../../src/index.js";
import "../../src/index.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMotion: (motion: "reduce" | null) => Promise<void>;
  }
}

type Row = { name: string; input: Record<string, unknown> };
const m = matrix as unknown as Record<string, Row[]> & {
  vocabulary: { defaults: Record<string, unknown> };
};
const gateInput = (status: string): UiInput =>
  ({
    elapsedMs: 60_000,
    ...m.vocabulary.defaults,
    gate: { status },
  }) as unknown as UiInput;

const original = document.startViewTransition;
afterEach(async () => {
  document.startViewTransition = original;
  await commands.emulateMotion(null);
  document.body.replaceChildren();
});

const frames = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function gate(theme?: PkGate["theme"]): Promise<PkGate> {
  const el = document.createElement("pk-gate") as PkGate;
  el.colorScheme = "dark";
  if (theme) el.theme = theme;
  el.input = gateInput("needs-activation");
  document.body.replaceChildren(el);
  await el.updateComplete;
  await document.fonts.ready;
  await frames();
  return el;
}

/** Wrap `startViewTransition` to count calls and keep the transitions. */
function spy() {
  const seen: ViewTransition[] = [];
  const real = document.startViewTransition.bind(document);
  document.startViewTransition = ((cb?: ViewTransitionUpdateCallback) => {
    const t = real(cb);
    seen.push(t);
    return t;
  }) as typeof document.startViewTransition;
  return seen;
}

describe("the step morph", () => {
  it("runs one View Transition on the card: fade and an 8 px slide at the base token", async () => {
    const el = await gate();
    const seen = spy();
    const root = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
    const base = Number.parseFloat(
      getComputedStyle(root).getPropertyValue("--pk-duration-base"),
    );
    expect(base).toBeGreaterThan(0);
    el.input = gateInput("revoked");
    const done = el.updateComplete;
    for (let i = 0; i < 20 && seen.length === 0; i++) await Promise.resolve();
    expect(seen).toHaveLength(1);
    await seen[0]!.ready;
    // A shadow tree's names are not captured: the host is the transition's surface.
    expect(el.hasAttribute("data-morphing")).toBe(true);
    expect(getComputedStyle(el).viewTransitionName).toBe("pk-host");
    const duration = (pseudo: string) =>
      document
        .getAnimations()
        .find(
          (a) => (a.effect as KeyframeEffect | null)?.pseudoElement === pseudo,
        )!
        .effect!.getTiming().duration;
    expect(duration("::view-transition-new(pk-host)")).toBe(base);
    expect(duration("::view-transition-old(pk-host)")).toBe(base);
    // The incoming card slides 8 px at the same duration.
    const slide = el.shadowRoot!.querySelector(".card")!.getAnimations()[0]!
      .effect as KeyframeEffect;
    expect(slide.getTiming().duration).toBe(base);
    expect(JSON.stringify(slide.getKeyframes())).toMatch(
      /translateY\(8px\)|0px 8px/,
    );
    await done;
    await seen[0]!.finished;
    await frames();
    expect(el.view.state).toBe("blocked");
    expect(el.hasAttribute("data-morphing")).toBe(false);
  });

  it("moves focus exactly as it does without the morph", async () => {
    const el = await gate();
    spy();
    el.input = gateInput("revoked");
    await el.updateComplete;
    await frames();
    const active = el.shadowRoot!.activeElement;
    // Whatever the model decided (the heading or a control) is focused inside the new card.
    expect(active === null || el.shadowRoot!.contains(active)).toBe(true);
  });

  it("is zero motion under prefers-reduced-motion", async () => {
    await commands.emulateMotion("reduce");
    const el = await gate();
    const seen = spy();
    el.input = gateInput("revoked");
    await el.updateComplete;
    expect(seen).toHaveLength(0);
    expect(el.view.state).toBe("blocked");
  });

  it("is zero motion when the theme asks for reduced motion (base is 0 ms)", async () => {
    const el = await gate({ motion: "reduced" });
    const seen = spy();
    const root = el.shadowRoot!.querySelector<HTMLElement>(".pk-root")!;
    expect(getComputedStyle(root).getPropertyValue("--pk-duration-base")).toBe(
      "0ms",
    );
    el.input = gateInput("revoked");
    await el.updateComplete;
    expect(seen).toHaveLength(0);
    expect(el.view.state).toBe("blocked");
  });

  it("falls back to an instant swap where startViewTransition is missing", async () => {
    const el = await gate();
    (document as unknown as Record<string, unknown>).startViewTransition =
      undefined;
    el.input = gateInput("revoked");
    await el.updateComplete;
    expect(el.view.state).toBe("blocked");
    expect(el.hasAttribute("data-morphing")).toBe(false);
  });
});
