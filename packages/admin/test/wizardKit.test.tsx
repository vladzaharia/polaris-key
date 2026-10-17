/**
 * The wizard kit (ST-39; SETUP.md §1): `ui/wizard` is the one place a stepper lives, every flow
 * passes the flow lint, and the pieces behave as the pattern says.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import {
  AutoList,
  lintFlow,
  PrereqList,
  prereqsMet,
  Stepper,
  WaitingFor,
  Wizard,
  type FlowDef,
} from "../src/ui/wizard/index.js";
import { FLOWS, FLOW_EXEMPT } from "../src/console/wizard/flows.js";
import {
  edit,
  EMPTY_SETUP,
  parseSetup,
  skippedIn,
} from "../src/console/wizard/setup.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

afterEach(cleanup);
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??=
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
});

describe("no wizard outside ui/wizard", () => {
  const files = walk(SRC).filter((f) => {
    const rel = relative(SRC, f);
    return !rel.startsWith("ui/wizard/") && !rel.startsWith("kit/");
  });

  it("nothing else marks a step current or imports the retired Stepper", () => {
    const offenders = files.filter((f) => {
      const t = readFileSync(f, "utf8");
      return (
        /aria-current=["'{]+\s*["']?step/.test(t) ||
        /ui\/Stepper(\.js)?["']/.test(t)
      );
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("the old ui/Stepper is gone", () => {
    expect(() => statSync(join(SRC, "ui/Stepper.tsx"))).toThrow();
  });
});

describe("flow lint", () => {
  const ok: FlowDef = {
    id: "demo",
    title: "Demo",
    steps: [
      { id: "choose", label: "Choose the cask", kind: "choice" },
      { id: "add", label: "Add Homebrew to your repository", kind: "snippet" },
      { id: "wait", label: "Wait for the first cask", kind: "wait" },
      { id: "done", label: "Done", kind: "done" },
    ],
  };
  const steps = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      label: `Do thing ${i}`,
      kind: "custom" as const,
    }));

  it("passes a flow that follows the pattern", () => {
    expect(lintFlow(ok)).toEqual([]);
  });

  it("fails each rule it names", () => {
    expect(lintFlow({ ...ok, steps: steps(6) })[0]).toMatch(/at most 5/);
    expect(
      lintFlow({
        ...ok,
        steps: [...ok.steps.slice(0, 1), { ...ok.steps[0]!, label: "Again" }],
      }).join(),
    ).toMatch(/repeated/);
    expect(
      lintFlow({
        ...ok,
        steps: [{ id: "Step_1", label: "x", kind: "form" }],
      }).join(),
    ).toMatch(/kebab-case/);
    expect(
      lintFlow({
        ...ok,
        steps: [{ id: "one", label: "Step 3", kind: "form" }],
      }).join(),
    ).toMatch(/name what the operator does/);
    expect(
      lintFlow({
        ...ok,
        steps: [
          { id: "done", label: "Done", kind: "done" },
          { id: "x", label: "After", kind: "form" },
        ],
      }).join(),
    ).toMatch(/not last/);
    expect(
      lintFlow({
        ...ok,
        steps: [{ id: "w", label: "Wait for it", kind: "wait" }],
      }).join(),
    ).toMatch(/opens with a wait/);
    expect(lintFlow({ ...ok, steps: [] }).join()).toMatch(/no steps/);
  });

  it("holds every console flow, within its exemption", () => {
    for (const f of FLOWS) {
      const ex = FLOW_EXEMPT[f.id];
      expect(lintFlow(f, ex?.max)).toEqual([]);
      // The exemption only shrinks: a flow within five steps loses it.
      if (ex) expect(f.steps.length).toBeGreaterThan(5);
    }
  });
});

describe("Stepper", () => {
  const STEPS = [
    { id: "a", label: "Provider", decided: "Kestrel Labs" },
    { id: "b", label: "Client" },
    { id: "c", label: "Test" },
  ];

  it("a done step says what was decided; a skipped one says Skipped; a future one says why it waits", async () => {
    const onStep = vi.fn();
    render(
      <Stepper steps={STEPS} current="c" skipped={["b"]} onStep={onStep} />,
    );
    const nav = screen.getByRole("navigation", { name: "Steps" });
    expect(nav.textContent).toContain("Kestrel Labs");
    expect(nav.textContent).toContain("Skipped");
    await userEvent.click(
      screen.getByRole("button", { name: /Provider.*completed/ }),
    );
    expect(onStep).toHaveBeenCalledWith("a");
    expect(nav.querySelector("[aria-current=step]")!.textContent).toContain(
      "Test",
    );
  });

  it("a future step is disabled and names what to finish first", () => {
    render(<Stepper steps={STEPS} current="a" />);
    const next = screen.getAllByRole("button", { name: /Client/ })[0]!;
    // aria-disabled, not hidden from the reader; the reason is its description, not part of its name.
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.textContent).not.toContain("Complete");
    const reason = document.getElementById(
      next.getAttribute("aria-describedby")!,
    );
    expect(reason?.textContent).toBe("Complete Provider first");
  });

  it("marks steps from facts: unmet warns, visited is neutral, a skip can be undone", async () => {
    const onStep = vi.fn();
    const onUndoSkip = vi.fn();
    render(
      <Stepper
        steps={[...STEPS, { id: "d", label: "Ship", decided: "1 of 2 ready" }]}
        current="c"
        done={["a"]}
        unmet={["d"]}
        visited={["b"]}
        skipped={[]}
        onStep={onStep}
        onUndoSkip={onUndoSkip}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Ship.*needs attention/ }),
    ).toBeTruthy();
    const visitedBtn = screen.getByRole("button", { name: "Client" });
    expect(visitedBtn.textContent).not.toMatch(/completed|attention/);
    await userEvent.click(visitedBtn);
    expect(onStep).toHaveBeenCalledWith("b");
  });

  it("Undo beside a skipped step clears the skip", async () => {
    const onUndoSkip = vi.fn();
    render(
      <Stepper
        steps={STEPS}
        current="c"
        skipped={["b"]}
        onStep={() => {}}
        onUndoSkip={onUndoSkip}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(onUndoSkip).toHaveBeenCalledWith("b");
  });

  it("the phone toggle says where you are and opens the list", async () => {
    render(<Stepper steps={STEPS} current="b" />);
    const toggle = screen.getByRole("button", { name: /Step 2 of 3 · Client/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("segments (the drawer) are a list with the current one marked", () => {
    render(<Stepper variant="segments" steps={STEPS} current="b" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(document.querySelectorAll("[aria-current=step]")).toHaveLength(1);
  });
});

describe("Wizard", () => {
  function Demo(): React.ReactElement {
    const [cur, setCur] = React.useState("a");
    return (
      <Wizard
        label="Demo"
        steps={[
          { id: "a", label: "One" },
          { id: "b", label: "Two" },
        ]}
        current={cur}
        title={cur === "a" ? "First question" : "Second question"}
        footer={{
          reason: "Choose one to continue",
          onBack: cur === "b" ? () => setCur("a") : undefined,
          primary: <button onClick={() => setCur("b")}>Continue</button>,
        }}
      >
        <p>body</p>
      </Wizard>
    );
  }

  it("names the region by the step's heading and counts the steps", () => {
    render(<Demo />);
    expect(screen.getByRole("region", { name: "First question" })).toBeTruthy();
    // The stepper numbers the steps; a live line says where the operator is.
    expect(screen.getByRole("status").textContent).toBe(
      "Demo, step 1 of 2, First question",
    );
    expect(screen.getByText("Choose one to continue")).toBeTruthy();
    // The reason describes the primary itself, not a wrapper around it.
    expect(
      screen
        .getByRole("button", { name: "Continue" })
        .getAttribute("aria-describedby"),
    ).toBeTruthy();
  });

  it("Skip stays visible with its reason when it is off, and a footer may have no primary", () => {
    const onSkip = vi.fn();
    render(
      <Wizard
        label="Demo"
        steps={[{ id: "a", label: "One" }]}
        current="a"
        title="Q"
        footer={{ onSkip, skipDisabledReason: "Ask Ada for Core access." }}
      >
        <p>body</p>
      </Wizard>,
    );
    const skip = screen.getByRole("button", { name: "Skip this step" });
    expect(skip.getAttribute("aria-disabled")).toBe("true");
    skip.click();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("moves focus to the step's heading when the step changes, not on first render", async () => {
    render(<Demo />);
    const first = screen.getByRole("heading", { level: 2 });
    expect(document.activeElement).not.toBe(first);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const next = screen.getByRole("heading", { name: "Second question" });
    expect(document.activeElement).toBe(next);
  });
});

describe("WaitingFor", () => {
  it("waits, then turns into the event", () => {
    const { rerender } = render(
      <WaitingFor waiting="Waiting for CI" found={null} />,
    );
    expect(screen.getByText("Waiting for CI…")).toBeTruthy();
    rerender(<WaitingFor waiting="Waiting for CI" found="0.1.0 arrived" />);
    expect(screen.getByText("0.1.0 arrived")).toBeTruthy();
  });

  it("stops after the timeout and offers Check again, rather than looping", () => {
    vi.useFakeTimers();
    const onCheck = vi.fn();
    render(
      <WaitingFor
        waiting="Waiting for CI"
        found={null}
        timeoutMs={1000}
        onCheck={onCheck}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.queryByText("Waiting for CI…")).toBeNull();
  });
});

describe("PrereqList and AutoList", () => {
  it("a blocking unmet row holds Continue; a non-blocking one only warns; unknown never blocks", () => {
    const rows = [
      { id: "a", label: "A", state: "met" as const },
      { id: "b", label: "B", state: "unknown" as const },
    ];
    expect(prereqsMet(rows)).toBe(true);
    expect(prereqsMet([...rows, { id: "c", label: "C", state: "unmet" }])).toBe(
      false,
    );
    expect(
      prereqsMet([
        ...rows,
        { id: "c", label: "C", state: "unmet", blocking: false },
      ]),
    ).toBe(true);
  });

  it("states are words with icons, and the fix shows on an unmet row only", () => {
    render(
      <PrereqList
        rows={[
          { id: "a", label: "Team connection", state: "met", fix: <i>x</i> },
          {
            id: "b",
            label: "The app",
            state: "unmet",
            fix: <button>Pick the app</button>,
          },
        ]}
      />,
    );
    expect(screen.getByText("Met")).toBeTruthy();
    expect(screen.getByText("Not met")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("AutoList shows the retry only on a failed row", () => {
    render(
      <AutoList
        items={[
          {
            id: "1",
            label: "Open the PR",
            state: "done",
            action: <button>no</button>,
          },
          {
            id: "2",
            label: "Add the ruleset",
            state: "failed",
            action: <button>Retry</button>,
          },
        ]}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Retry",
    ]);
  });
});

describe("setup choices", () => {
  it("edits are pure and idempotent", () => {
    const a = edit.skip("storefronts", "assets")(EMPTY_SETUP);
    expect(a.skipped).toEqual(["storefronts.assets"]);
    expect(edit.skip("storefronts", "assets")(a)).toEqual(a);
    expect(edit.skip("storefronts", "assets", false)(a).skipped).toEqual([]);
    expect(skippedIn(a, "storefronts")).toEqual(["assets"]);
    expect(skippedIn(a, "other")).toEqual([]);
    expect(edit.notUsing("steam")(EMPTY_SETUP).notUsing).toEqual(["steam"]);
    const stamp = { at: 1, by: "ana" };
    expect(edit.hideIntegration(stamp)(EMPTY_SETUP).integrationHidden).toEqual(
      stamp,
    );
    expect(EMPTY_SETUP.skipped).toEqual([]);
  });

  it("anything that is not the shape reads as nothing chosen", () => {
    expect(parseSetup(null)).toEqual(EMPTY_SETUP);
    expect(parseSetup("x")).toEqual(EMPTY_SETUP);
    expect(parseSetup({ skipped: ["a.b", 3] }).skipped).toEqual(["a.b"]);
  });
});
