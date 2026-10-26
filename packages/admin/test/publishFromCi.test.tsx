import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  HttpError,
  setStepUpRedirectForTests,
  type CiReadiness,
} from "../src/api.js";
import type { QueryClient } from "@tanstack/react-query";
import { createQueryClient } from "../src/console/data/queryClient.js";
import { qk } from "../src/console/data/queries.js";
import { ME } from "./consoleHarness.js";
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
    releaseKeys: false,
    links: {
      install: "https://github.com/apps/polaris-key/installations/new",
      installation:
        "https://github.com/organizations/acme/settings/installations/42",
    },
  };
}

const OK = (id: CiReadiness["checks"][number]["id"], detail?: string) => ({
  id,
  state: "ok" as const,
  ...(detail ? { detail } : {}),
});

function mount(client?: QueryClient): void {
  mountAt(
    "#/p/tonebox/release",
    <PublishFromCiDrawer slug="tonebox" open onOpenChange={() => undefined} />,
    client,
  );
}

const viewer = (): QueryClient => {
  const client = createQueryClient();
  client.setQueryData(qk.me(), {
    ...ME,
    platformAdmin: false,
    permissions: {
      platform: { view: [], edit: [] },
      products: { tonebox: { view: ["ship"], edit: [] } },
    },
  });
  return client;
};

const permissionRefusal = (permission: string): HttpError =>
  new HttpError(
    409,
    { reason: "app_permission" },
    { reason: "app_permission", permission },
  );

function Reopen(): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <PublishFromCiDrawer slug="tonebox" open={open} onOpenChange={setOpen} />
    </>
  );
}

const create = async (name: string): Promise<void> => {
  const r_ = await row(name);
  await userEvent.click(within(r_).getByRole("button", { name: "Create" }));
};

const missing = (id: "environment" | "ruleset"): CiReadiness =>
  readiness([OK("app"), { id, state: "missing" }]);

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
    // All done: one line, not seven rows; the Change link is underlined (axe link-in-text-block).
    expect(screen.getByText(/Polaris Key did 5 things/)).toBeTruthy();
    expect(document.querySelectorAll('[data-state="done"]')).toHaveLength(5);
    expect(
      within(publisher).getByRole("link", { name: "Change in Keys" }).className,
    ).toContain("underline");
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
    // Not done is neutral "To do", never a red failure.
    expect(env.getAttribute("data-state")).toBe("will");
    expect(env.textContent).toContain("To do");
    await userEvent.click(within(env).getByRole("button", { name: "Create" }));
    expect(fns.fixCiReadiness).toHaveBeenCalledWith("tonebox", ["environment"]);
    await waitFor(async () =>
      expect(
        (await row("Release environment")).getAttribute("data-state"),
      ).toBe("done"),
    );
  });

  it("names the permission a refusal needs and links to GitHub", async () => {
    fns.ciReadiness.mockResolvedValue(missing("ruleset"));
    fns.fixCiReadiness.mockRejectedValue(
      permissionRefusal("administration: write"),
    );
    mount();
    await create("Tag ruleset");
    await waitFor(async () =>
      expect((await row("Tag ruleset")).getAttribute("data-state")).toBe(
        "needs",
      ),
    );
    const after = await row("Tag ruleset");
    expect(after.textContent).toContain("Administration: Read and write");
    expect(after.textContent).toContain("Ask a repository admin to grant it.");
    const link = within(after).getByRole("link", {
      name: /Review permissions on GitHub/,
    });
    // The installation's own page, not the person's list of Apps.
    expect(link.getAttribute("href")).toBe(
      "https://github.com/organizations/acme/settings/installations/42",
    );
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
    expect(env.textContent).toContain("Administration: Read and write");
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
    expect(env.textContent).toContain("Actions: Read");
  });

  it("a missing scope opens the publisher edit", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([
        OK("app"),
        OK("publisher"),
        { id: "distribution-pr", state: "missing" },
      ]),
    );
    mount();
    const pr = await row("Homebrew and Scoop pull requests");
    await userEvent.click(within(pr).getByRole("button", { name: "Add" }));
    expect(
      await screen.findByRole("dialog", { name: /publisher/i }),
    ).toBeTruthy();
  });

  it("a missing App is one row with one install action, to the App's own page", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([
        { id: "app", state: "missing" },
        { id: "workflow", state: "unknown" },
        { id: "environment", state: "unknown" },
      ]),
    );
    mount();
    const app = await row("GitHub App installed");
    expect(app.getAttribute("data-state")).toBe("will");
    const link = within(app).getByRole("link", {
      name: "Install the GitHub App",
    });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/apps/polaris-key/installations/new",
    );
    expect(document.querySelectorAll("li[data-state]")).toHaveLength(1);
    expect(screen.queryByText("Review permissions on GitHub")).toBeNull();
    expect(screen.queryByText("Your steps")).toBeNull();
    expect(screen.getByRole("button", { name: "Use another CI" })).toBeTruthy();
  });

  it("app_not_installed on a fix re-reads: the list turns into the install", async () => {
    fns.ciReadiness
      .mockResolvedValueOnce(missing("environment"))
      .mockResolvedValue(readiness([{ id: "app", state: "missing" }]));
    fns.fixCiReadiness.mockRejectedValue(
      new HttpError(
        409,
        { reason: "app_not_installed" },
        { reason: "app_not_installed" },
      ),
    );
    mount();
    await create("Release environment");
    await screen.findByRole("link", { name: "Install the GitHub App" });
    expect(screen.queryByText("Needs permission")).toBeNull();
  });

  it("clears a refusal when the drawer is closed and reopened", async () => {
    fns.ciReadiness.mockResolvedValue(missing("ruleset"));
    fns.fixCiReadiness.mockRejectedValueOnce(
      permissionRefusal("administration: write"),
    );
    const view = mountAt("#/p/tonebox/release", <Reopen />);
    await create("Tag ruleset");
    await waitFor(async () =>
      expect((await row("Tag ruleset")).getAttribute("data-state")).toBe(
        "needs",
      ),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Tag ruleset")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(async () =>
      expect((await row("Tag ruleset")).getAttribute("data-state")).toBe(
        "will",
      ),
    );
    view.unmount();
  });

  it("Check again on a refused row drops the refusal and re-reads", async () => {
    fns.ciReadiness.mockResolvedValue(missing("ruleset"));
    fns.fixCiReadiness.mockRejectedValue(
      permissionRefusal("administration: write"),
    );
    mount();
    await create("Tag ruleset");
    await userEvent.click(
      await screen.findByRole("button", { name: "Check again" }),
    );
    await waitFor(async () =>
      expect((await row("Tag ruleset")).getAttribute("data-state")).toBe(
        "will",
      ),
    );
  });

  it("announces a created row", async () => {
    fns.ciReadiness
      .mockResolvedValueOnce(missing("environment"))
      .mockResolvedValue(readiness([OK("app"), OK("environment")]));
    mount();
    await create("Release environment");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Release environment created",
      ),
    );
  });

  it("a viewer sees the write actions disabled, with the reason, and no GitHub failure", async () => {
    fns.ciReadiness.mockResolvedValue(missing("environment"));
    mount(viewer());
    const env = await row("Release environment");
    const create = within(env).getByRole("button", { name: "Create" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(create);
    expect(fns.fixCiReadiness).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/Ship access|edit access/);
  });

  it("a 403 that is not a step-up says so and offers no retry", async () => {
    fns.ciReadiness.mockResolvedValue(missing("environment"));
    fns.fixCiReadiness.mockRejectedValue(
      new HttpError(403, { code: "forbidden" }),
    );
    mount();
    await create("Release environment");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "You need edit access to Ship builds.",
    );
    expect(screen.queryByText("GitHub did not answer. Try again.")).toBeNull();
  });

  it("a step-up refusal asks to sign in again, keeps the click, and does not blame GitHub", async () => {
    fns.ciReadiness.mockResolvedValue(missing("environment"));
    fns.fixCiReadiness.mockRejectedValue(
      new HttpError(403, { code: "step_up_required" }),
    );
    const redirect = vi.fn();
    setStepUpRedirectForTests(redirect);
    mount();
    await create("Release environment");
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in again" }),
    );
    expect(redirect).toHaveBeenCalled();
    expect(screen.queryByText("GitHub did not answer. Try again.")).toBeNull();
    setStepUpRedirectForTests();
  });

  it("folds .pkey/release and the workflow into one row without an action", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([
        OK("app"),
        { id: "release-manifest", state: "missing" },
        { id: "workflow", state: "missing" },
      ]),
    );
    mount();
    const wf = await row("Workflow");
    expect(wf.getAttribute("data-state")).toBe("will");
    expect(within(wf).queryByRole("button")).toBeNull();
    expect(within(wf).queryByRole("link")).toBeNull();
    expect(screen.queryByText(".pkey/release")).toBeNull();
  });

  const SETUP = [
    OK("app"),
    { id: "release-manifest" as const, state: "missing" as const },
    { id: "workflow" as const, state: "missing" as const },
  ];

  const KEYED = (checks: CiReadiness["checks"]): CiReadiness => ({
    ...readiness(checks),
    releaseKeys: true,
  });
  const PR_RESULT = {
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
  };

  it("offers the pull request only where releaseKeys is declared; the command makes the key otherwise", async () => {
    fns.ciReadiness.mockResolvedValue(readiness(SETUP));
    mount();
    await screen.findByText("1. Run one command");
    expect(screen.queryByRole("tab", { name: "Pull request" })).toBeNull();
    expect(document.body.textContent).toContain(
      "It also creates the release key.",
    );
    expect(document.body.textContent).toContain(
      "pkey ci init --channel stable",
    );
  });

  it("opens the setup pull request and shows it once: heading, files, Open on GitHub", async () => {
    fns.ciReadiness.mockResolvedValue(KEYED(SETUP));
    fns.openSetupPullRequest.mockResolvedValue(PR_RESULT);
    mount();
    await screen.findByText("1. Run one command");
    fns.setupPullRequest.mockResolvedValue({
      repository: "acme/tonebox",
      capabilities: ALL,
      state: "open",
      pullRequest: { number: 7, url: "https://github.com/a/b/pull/7" },
    });
    // The zero-terminal path leads.
    expect(screen.getAllByRole("tab")[0]!.textContent).toBe("Pull request");
    await userEvent.click(
      screen.getByRole("button", { name: "Open the pull request" }),
    );
    expect(fns.openSetupPullRequest).toHaveBeenCalledWith("tonebox", {});
    await screen.findByText("1. Merge pull request #7");
    expect(screen.queryByText("Merge pull request #7")).toBeNull();
    expect(screen.queryByText(/Merging it adds/)).toBeNull();
    expect(screen.getByText("After step 1.")).toBeTruthy();
    // The workflow row says where it is.
    expect((await row("Workflow")).textContent).toContain("In pull request #7");
  });

  it("a blocking pull request refusal switches to the command and disables Open", async () => {
    fns.ciReadiness.mockResolvedValue(KEYED(SETUP));
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
      await screen.findByRole("button", { name: "Open the pull request" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Pull requests: Read and write");
    expect(
      screen
        .getByRole("tab", { name: "One command" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "Pull request" }));
    expect(
      screen
        .getByRole("button", { name: "Open the pull request" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("a viewer cannot open the pull request", async () => {
    fns.ciReadiness.mockResolvedValue(KEYED(SETUP));
    mount(viewer());
    const open = await screen.findByRole("button", {
      name: "Open the pull request",
    });
    expect(open.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(open);
    expect(fns.openSetupPullRequest).not.toHaveBeenCalled();
  });

  const RELEASED = {
    releaseId: "app@0.1.0",
    version: "0.1.0",
    publishedAt: Date.now(),
    channel: "stable",
    signer: { kind: "release", kid: "rk_1", recordSha256: "x" },
  };

  it("waits for the tag, then says Done with the channel, the next actions and View release", async () => {
    fns.ciReadiness.mockResolvedValue(
      readiness([OK("app"), OK("release-manifest"), OK("workflow")]),
    );
    mount();
    await screen.findByText(/Waiting for the release from CI/);
    expect(screen.getByText("2. Push a tag")).toBeTruthy();
    expect(document.body.textContent).toContain("git push origin v0.1.0");
    fns.releases.mockResolvedValue({
      releases: [RELEASED],
      channels: [],
      floors: [],
    });
    const done = await screen.findByText(
      /0.1.0 is live on stable/,
      {},
      { timeout: 9000 },
    );
    expect(done.closest("[role=status]")).toBeTruthy();
    expect(done.tagName).toBe("H4");
    expect(screen.getByText("rk_1")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Publish 0.1.0 everywhere" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Set up storefronts" })
        .getAttribute("href"),
    ).toContain("storefronts");
    expect(
      screen.getByRole("link", { name: "View release" }).getAttribute("href"),
    ).toContain(encodeURIComponent("app@0.1.0"));
    expect(screen.queryByRole("button", { name: "Use another CI" })).toBeNull();
  }, 15000);

  it("a product that has released says the next tag, not the first", async () => {
    fns.releases.mockResolvedValue({
      releases: [RELEASED],
      channels: [],
      floors: [],
    });
    fns.ciReadiness.mockResolvedValue(
      readiness([OK("app"), OK("release-manifest"), OK("workflow")]),
    );
    mount();
    await screen.findByText(/Waiting for the release from CI/);
    expect(document.body.textContent).toContain("git push origin v0.1.1");
    expect(document.body.textContent).not.toContain("first tag");
    expect(document.body.textContent).not.toContain("git tag v0.1.0");
  });
});
