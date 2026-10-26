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
  setupPullRequest: vi.fn(),
  openSetupPullRequest: vi.fn(),
  releases: vi.fn(),
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
  fns.setupPullRequest.mockResolvedValue({
    repository: "acme/tonebox",
    capabilities: ALL,
    state: "none",
    pullRequest: null,
  });
  fns.releases.mockResolvedValue({ releases: [], channels: [], floors: [] });
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

  const SETUP = [
    OK("app"),
    { id: "release-manifest" as const, state: "missing" as const },
    { id: "workflow" as const, state: "missing" as const },
  ];

  it("opens the setup pull request and shows what merging does", async () => {
    fns.ciReadiness.mockResolvedValue(readiness(SETUP));
    fns.openSetupPullRequest.mockResolvedValue({
      ok: true,
      repository: "acme/tonebox",
      branch: "pkey/setup",
      pullRequest: {
        number: 7,
        url: "https://github.com/a/b/pull/7",
        created: true,
      },
      files: [
        { path: ".pkey/release", written: true },
        { path: ".github/workflows/release.yml", written: true },
      ],
      summary: { outlets: [], workflow: true },
    });
    mount();
    await screen.findByText("1. Run one command");
    await userEvent.click(screen.getByRole("tab", { name: /Let Polaris Key/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "Open the pull request" }),
    );
    expect(fns.openSetupPullRequest).toHaveBeenCalledWith("tonebox", {});
    await screen.findByText("Merge pull request #7");
    expect(screen.getByText("After step 1.")).toBeTruthy();
  });

  it("falls back to the command when GitHub refuses the permission", async () => {
    fns.ciReadiness.mockResolvedValue(readiness(SETUP));
    fns.openSetupPullRequest.mockRejectedValue(
      new HttpError(
        409,
        { reason: "app_permission" },
        {
          reason: "app_permission",
          permission: "pull_requests: write",
          oneCommand: "pkey ci init",
        },
      ),
    );
    mount();
    await userEvent.click(
      await screen.findByRole("tab", { name: /Let Polaris Key/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open the pull request" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("pull_requests: write");
    await userEvent.click(screen.getByRole("tab", { name: "One command" }));
    expect(document.body.textContent).toContain(
      "pkey ci init --channel stable",
    );
  });

  it("waits for the tag, then says Done with the release", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([OK("app"), OK("release-manifest"), OK("workflow")]),
    );
    mount();
    await screen.findByText(/Waiting for the release from CI/);
    expect(document.body.textContent).toContain("git push origin v0.1.0");
    fns.releases.mockResolvedValue({
      releases: [
        {
          releaseId: "app@0.1.0",
          version: "0.1.0",
          publishedAt: Date.now(),
          signer: { kind: "release", kid: "rk_1", recordSha256: "x" },
        },
      ],
      channels: [],
      floors: [],
    });
    const done = await screen.findByText(
      /0.1.0 is published/,
      {},
      { timeout: 9000 },
    );
    expect(done.getAttribute("role")).toBe("status");
    expect(screen.getByText("rk_1")).toBeTruthy();
  }, 15000);
});
