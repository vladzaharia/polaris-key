import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpError, type CiReadiness } from "../src/api.js";
import { mountAt } from "./releaseHarness.js";

/**
 * Publish from CI (A-32.11): one row per readiness check, the two writes one click each, and a
 * refusal that names the permission and sends the owner to GitHub.
 */

const fns = vi.hoisted(() => ({
  ciReadiness: vi.fn(),
  fixCiReadiness: vi.fn(),
  ciPublisher: vi.fn(),
  putCiPublisher: vi.fn(),
}));

vi.mock("../src/api.js", async () =>
  (await import("./apiFnsMock.js")).apiFnsMock(fns),
);

const { PublishFromCiDrawer } =
  await import("../src/console/sections/release/components/PublishFromCi/PublishFromCiDrawer.js");

const ALL = {
  pullRequest: true,
  workflow: true,
  environment: true,
  ruleset: true,
};

function readiness(
  checks: CiReadiness["checks"],
  capabilities: Partial<CiReadiness["capabilities"]> = {},
): CiReadiness {
  return {
    repository: "acme/tonebox",
    capabilities: { ...ALL, ...capabilities },
    checks,
    workflowPreview: null,
  };
}

const OK = (id: CiReadiness["checks"][number]["id"], detail?: string) => ({
  id,
  state: "ok" as const,
  ...(detail ? { detail } : {}),
});

function mount(): void {
  mountAt(
    "#/p/tonebox/release",
    <PublishFromCiDrawer slug="tonebox" open onOpenChange={() => undefined} />,
  );
}

const row = async (name: string): Promise<HTMLElement> =>
  (await screen.findByText(name)).closest("li") as HTMLElement;

beforeEach(() => {
  fns.ciPublisher.mockResolvedValue({ policy: null });
  fns.fixCiReadiness.mockResolvedValue({
    ok: true,
    repository: "acme/tonebox",
    results: [],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Publish from CI", () => {
  it("shows done rows, with the publisher named and Change leading to Keys", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([
        OK("app"),
        OK("release-manifest"),
        OK("workflow"),
        OK("environment"),
        OK("ruleset"),
        OK("publisher", ".github/workflows/release.yml · release"),
      ]),
    );
    mount();
    const publisher = await row("Trusted publisher");
    expect(publisher.getAttribute("data-state")).toBe("done");
    expect(publisher.textContent).toContain(".github/workflows/release.yml");
    expect(
      within(publisher)
        .getByRole("link", { name: "Change in Keys" })
        .getAttribute("href"),
    ).toContain("keys");
    expect(document.querySelectorAll('[data-state="done"]')).toHaveLength(6);
  });

  it("creates the environment in one click and re-reads", async () => {
    fns.ciReadiness
      .mockResolvedValueOnce(
        readiness([
          OK("app"),
          { id: "environment", state: "missing" },
          OK("ruleset"),
        ]),
      )
      .mockResolvedValue(
        readiness([OK("app"), OK("environment"), OK("ruleset")]),
      );
    mount();
    const env = await row("Release environment");
    expect(env.getAttribute("data-state")).toBe("failed");
    await userEvent.click(within(env).getByRole("button", { name: "Create" }));
    expect(fns.fixCiReadiness).toHaveBeenCalledWith("tonebox", ["environment"]);
    await waitFor(async () =>
      expect(
        (await row("Release environment")).getAttribute("data-state"),
      ).toBe("done"),
    );
  });

  it("names the permission a refusal needs and links to GitHub", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([OK("app"), { id: "ruleset", state: "missing" }]),
    );
    fns.fixCiReadiness.mockRejectedValue(
      new HttpError(
        409,
        { reason: "app_permission" },
        {
          reason: "app_permission",
          permission: "administration: write",
        },
      ),
    );
    mount();
    const rs = await row("Tag ruleset for v*");
    await userEvent.click(within(rs).getByRole("button", { name: "Create" }));
    await waitFor(async () =>
      expect((await row("Tag ruleset for v*")).getAttribute("data-state")).toBe(
        "needs",
      ),
    );
    const after = await row("Tag ruleset for v*");
    expect(after.textContent).toContain("administration: write");
    const link = within(after).getByRole("link", {
      name: /Review permissions on GitHub/,
    });
    expect(link.getAttribute("href")).toMatch(/^https:\/\/github\.com\//);
  });

  it("asks for the permission up front when the App cannot write", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([OK("app"), { id: "environment", state: "missing" }], {
        environment: false,
      }),
    );
    mount();
    const env = await row("Release environment");
    expect(env.getAttribute("data-state")).toBe("needs");
    expect(env.textContent).toContain("administration: write");
    expect(within(env).queryByRole("button", { name: "Create" })).toBeNull();
    expect(
      within(env).getByRole("link", { name: /Review permissions on GitHub/ }),
    ).toBeTruthy();
  });

  it("an unknown read names the permission it lacks", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([
        OK("app"),
        { id: "environment", state: "unknown", permission: "actions: read" },
      ]),
    );
    mount();
    const env = await row("Release environment");
    expect(env.getAttribute("data-state")).toBe("needs");
    expect(env.textContent).toContain("actions: read");
  });

  it("a missing app offers the install; a missing scope opens the publisher edit", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([
        { id: "app", state: "missing" },
        OK("publisher"),
        { id: "distribution-pr", state: "missing" },
      ]),
    );
    mount();
    const app = await row("GitHub App installed");
    expect(
      within(app).getByRole("link", { name: /Install on GitHub/ }),
    ).toBeTruthy();
    const pr = await row("Pull requests to homebrew and scoop");
    await userEvent.click(within(pr).getByRole("button", { name: "Add" }));
    expect(
      await screen.findByRole("dialog", { name: /publisher/i }),
    ).toBeTruthy();
  });

  it("leaves the setup-pull-request rows without an action", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([
        OK("app"),
        { id: "release-manifest", state: "missing" },
        { id: "workflow", state: "missing" },
      ]),
    );
    mount();
    const wf = await row("Release workflow");
    expect(within(wf).queryByRole("button")).toBeNull();
    expect(within(wf).queryByRole("link")).toBeNull();
  });
});
