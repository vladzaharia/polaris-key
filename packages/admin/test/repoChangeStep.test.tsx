/** RepoChangeStep (A-32.10): both modes, the tabs' keyboard, copy, and the live region. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  lintFlow,
  RepoChangeStep,
  type FlowDef,
} from "../src/ui/wizard/index.js";

afterEach(cleanup);

const files = [
  {
    id: "wf",
    label: "Workflow",
    filename: ".github/workflows/release.yml",
    code: "name: release",
    where: "Add the workflow",
  },
];
const permission = {
  needs: "Contents: write",
  reviewUrl: "https://github.com/settings/installations",
};
const base = { waiting: "Waiting for the change", found: null };

describe("RepoChangeStep: pull request mode", () => {
  const pullRequest = {
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    summary: "Adds the release workflow.",
    files: [{ path: ".pkey/release.json", change: "added" as const }],
  };

  it("shows the summary, the files and Open on GitHub, with no tabs", () => {
    render(<RepoChangeStep {...base} pullRequest={pullRequest} />);
    expect(screen.getByText("Merge pull request #12")).toBeTruthy();
    expect(screen.getByText("Adds the release workflow.")).toBeTruthy();
    expect(screen.getByText(".pkey/release.json")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Open on GitHub/ }).getAttribute("href"),
    ).toBe(pullRequest.url);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText(/Waiting for the change/)).toBeTruthy();
  });

  it("announces the event once it is seen", () => {
    render(
      <RepoChangeStep
        {...base}
        pullRequest={pullRequest}
        found="Merged 4 s ago"
      />,
    );
    expect(screen.getByText("Merged 4 s ago")).toBeTruthy();
  });
});

describe("RepoChangeStep: by hand mode", () => {
  const props = {
    ...base,
    command: "pkey ci init --product acme",
    files,
    permission,
  };

  it("opens on One command, with three tabs", () => {
    render(<RepoChangeStep {...props} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "One command",
      "By hand",
      "Pull request",
    ]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain("pkey ci init --product acme");
  });

  it("moves with the arrow keys, Home and End (roving tabindex)", async () => {
    const user = userEvent.setup();
    render(<RepoChangeStep {...props} />);
    const [a, b, c] = screen.getAllByRole("tab");
    a!.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(b);
    expect(b!.getAttribute("aria-selected")).toBe("true");
    expect(b!.tabIndex).toBe(0);
    expect(a!.tabIndex).toBe(-1);
    expect(document.body.textContent).toContain("name: release");
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(c);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(a);
  });

  it("names the permission and links to its review", async () => {
    const user = userEvent.setup();
    render(<RepoChangeStep {...props} />);
    await user.click(screen.getByRole("tab", { name: /Pull request/ }));
    expect(screen.getByText("Contents: write")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Review permissions on GitHub/ })
        .getAttribute("href"),
    ).toBe(permission.reviewUrl);
  });

  it("copies the command", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<RepoChangeStep {...props} />);
    await user.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("pkey ci init --product acme");
  });

  it("omits a tab whose input is absent", () => {
    render(<RepoChangeStep {...base} command="pkey ci init" files={[]} />);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });
});

describe("flow lint with a repository-change step", () => {
  const flow: FlowDef = {
    id: "publish-from-ci",
    title: "Publish from CI",
    steps: [
      { id: "repository", label: "Choose the repository", kind: "choice" },
      { id: "change", label: "Change the repository", kind: "custom" },
      {
        id: "first-release",
        label: "Wait for the first release",
        kind: "wait",
      },
      { id: "done", label: "Done", kind: "done" },
    ],
  };
  it("passes, and fails when the change opens the flow as a wait", () => {
    expect(lintFlow(flow)).toEqual([]);
    expect(
      lintFlow({ ...flow, steps: [flow.steps[2]!, ...flow.steps] }).join(),
    ).toMatch(/opens with a wait/);
  });
});
