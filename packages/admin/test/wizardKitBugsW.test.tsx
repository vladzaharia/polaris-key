/**
 * Bug package W, the wizard kit (B-216, B-218 … B-221): the narrow and the large-text cases, the
 * phone footer, WaitingFor's timeout, and the small kit nits. Layout itself is proved in the
 * browser (e2e layout ZOOM_CASES); these pin the structure that makes it hold.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import * as React from "react";
import { Button } from "../src/ui/Button.js";
import {
  AutoList,
  SnippetStep,
  Stepper,
  WaitingFor,
  Wizard,
} from "../src/ui/wizard/index.js";

afterEach(cleanup);
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??=
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
});

const STEPS = [
  { id: "a", label: "Limits" },
  { id: "b", label: "Delivery" },
  { id: "c", label: "Review" },
];

describe("Stepper (B-216, B-221)", () => {
  it("segments wrap their labels instead of cutting them, and a narrow drawer names the current step on one line", () => {
    const { container } = render(
      <Stepper variant="segments" steps={STEPS} current="b" />,
    );
    const labels = [...container.querySelectorAll("li span.text-xs")].filter(
      (e) => e.textContent === "Limits",
    );
    expect(labels).toHaveLength(1);
    expect(labels[0]!.className).not.toContain("truncate");
    expect(labels[0]!.className).toContain("break-words");
    // The other labels give way to the one line below a container width, never to "Lim…".
    expect(labels[0]!.className).toContain("@max-md:sr-only");
    expect(container.textContent).toContain("Step 2 of 3 · Delivery");
  });

  it("the phone toggle does not repeat the heading it sits above", () => {
    render(<Stepper steps={STEPS} current="c" headingLabel="Review" />);
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle.textContent?.replace(/\s+/g, " ").trim()).toBe("Step 3 of 3");
  });
});

describe("Wizard footer (B-218, B-219)", () => {
  it("a wrapped primary grows with its text instead of keeping Button md's fixed height", () => {
    render(
      <Wizard
        label="Demo"
        steps={STEPS}
        current="a"
        title="Q"
        footer={{ primary: <Button>Send the changes for review</Button> }}
      >
        <p>body</p>
      </Wizard>,
    );
    const b = screen.getByRole("button", {
      name: "Send the changes for review",
    });
    expect(b.className).toContain("h-auto");
    expect(b.className).toContain("min-h-9");
    expect(b.className).not.toMatch(/(^| )h-9( |$)/);
  });

  it("on a phone the page footer stacks: reason, primary, Back, Do this later, each full width", () => {
    render(
      <Wizard
        label="Demo"
        steps={STEPS}
        current="b"
        title="Q"
        footer={{
          reason: "Choose one to continue",
          onBack: () => {},
          later: <Button variant="ghost">Do this later</Button>,
          primary: <Button>Continue</Button>,
        }}
      >
        <p>body</p>
      </Wizard>,
    );
    const foot = document.querySelector("[data-wizard-foot]") as HTMLElement;
    expect(foot.className).toContain("max-sm:flex-col");
    const order = (el: Element) =>
      /max-sm:order-(\d)/.exec(
        (el.closest("[class*='max-sm:order-']") ?? el).className,
      )?.[1];
    expect(order(within(foot).getByText("Choose one to continue"))).toBe("1");
    expect(order(within(foot).getByRole("button", { name: "Continue" }))).toBe(
      "2",
    );
    expect(order(within(foot).getByRole("button", { name: /Back/ }))).toBe("3");
    expect(
      order(within(foot).getByRole("button", { name: "Do this later" })),
    ).toBe("4");
    expect(
      within(foot).getByRole("button", { name: "Continue" }).className,
    ).toContain("max-sm:w-full");
  });
});

describe("WaitingFor (B-220)", () => {
  it("waits 15 minutes by default, then says Still waiting and offers Keep waiting, which starts another round", async () => {
    vi.useFakeTimers();
    render(
      <WaitingFor waiting="Waiting for CI" found={null} onCheck={() => {}} />,
    );
    act(() => {
      vi.advanceTimersByTime(14 * 60_000);
    });
    expect(screen.getByText("Waiting for CI…")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/Still waiting\./)).toBeTruthy();
    expect(screen.queryByText(/Nothing yet/)).toBeNull();
    act(() => {
      screen.getByRole("button", { name: "Keep waiting" }).click();
    });
    expect(screen.getByText("Waiting for CI…")).toBeTruthy();
    vi.useRealTimers();
  });

  it("the text can shrink beside the spinner", () => {
    render(<WaitingFor waiting="Waiting for CI" found={null} />);
    expect(screen.getByText("Waiting for CI…").className).toContain("min-w-0");
  });
});

describe("AutoList and SnippetStep (B-221)", () => {
  it("a row that needs a permission is a warning with a lock, not the red cross of a failure", () => {
    const { container } = render(
      <AutoList
        items={[
          { id: "n", label: "Needs it", state: "needs" },
          { id: "f", label: "Broke", state: "failed" },
        ]}
      />,
    );
    const needs = container.querySelector("[data-state=needs]")!;
    const failed = container.querySelector("[data-state=failed]")!;
    expect(needs.querySelector("svg.text-warning")).toBeTruthy();
    expect(needs.querySelector(".text-danger")).toBeNull();
    expect(failed.querySelector("svg.text-danger")).toBeTruthy();
  });

  it("the snippet names its file once (the code block), and the line says where it goes", async () => {
    const { container } = render(
      <SnippetStep
        tabs={[
          {
            id: "t",
            label: "Text",
            filename: "release.yml",
            code: "on: push",
            where: "In .github/workflows",
          },
        ]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text.split("release.yml").length - 1).toBe(1);
    expect(text).toContain("In .github/workflows.");
  });
});
