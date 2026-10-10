import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ProductDetail,
  PublisherPolicyDto,
  ReleaseHealth,
} from "../src/api.js";
import { lastAnnouncement } from "../src/ui/LiveRegion.js";
import { CHANNELS, STORE } from "./releaseFixture.js";
import { expectNoAxeViolations, mountAt } from "./releaseHarness.js";

/**
 * The guided Releases empty state (EXPERIENCE.md §0.4 S2, AS 2.2; UX-23): the checks that let CI
 * publish with their fixes inline, CI publishing edited through Keys & secrets' own drawer and
 * dialog, the workflow step with the slug filled in, and a wait that completes out loud (§7.1).
 */

const fns = vi.hoisted(() => ({
  product: vi.fn(),
  releaseHealth: vi.fn(),
  releases: vi.fn(),
  releaseChannels: vi.fn(),
  ciPublisher: vi.fn(),
  putCiPublisher: vi.fn(),
  ciTokens: vi.fn(),
  issueCiToken: vi.fn(),
  resyncProduct: vi.fn(),
  checkRepoLink: vi.fn(),
  linkProductRepo: vi.fn(),
}));

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: Object.fromEntries(
      Object.keys(fns).map((k) => [
        k,
        (...a: unknown[]) =>
          (fns as Record<string, (...x: unknown[]) => unknown>)[k]!(...a),
      ]),
    ),
  };
});

const { ReleasesPage } =
  await import("../src/console/pages/release/ReleasesPage.js");
const { FIRST_RELEASE_POLL_MS, workflowStep } =
  await import("../src/console/pages/release/FirstReleasePanel.js");

const NOW = Math.floor(Date.now() / 1000);

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    slug: "tonebox",
    name: "Tonebox",
    signingKid: "tonebox-2026-a",
    compatMin: "1.0.0",
    compatMax: "2.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    adminGroup: null,
    releaseSource: "github",
    services: {
      license: { enabled: true },
      config: { enabled: false },
      release: { enabled: true },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    },
    createdAt: NOW - 100,
    modifiedAt: NOW - 10,
    ...over,
  } as ProductDetail;
}

const HEALTH_OK: ReleaseHealth = {
  status: "healthy",
  healthy: true,
  missing: [],
  checks: [
    {
      id: "github",
      label: "GitHub access",
      status: "ok",
      message: "Listed 0 releases.",
    },
  ],
};

const POLICY: PublisherPolicyDto = {
  product: "tonebox",
  provider: "github",
  repositoryId: 11,
  repositoryOwnerId: 22,
  repository: "acme/tonebox",
  workflow: ".github/workflows/ship.yml",
  environment: "release",
  scopes: ["release:publish"],
  source: "admin",
  createdAt: NOW,
  modifiedAt: NOW,
  modifiedBy: null,
} as PublisherPolicyDto;

const EMPTY = { releases: [], channels: [], floors: [] };

function mount() {
  return mountAt(
    "#/p/tonebox/release/releases",
    <ReleasesPage slug="tonebox" />,
  );
}

/** A form control in `scope` by its field name. */
function input(scope: HTMLElement, name: string): HTMLInputElement {
  return scope.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

/** The panel's checklist row whose title is `title`. */
async function row(title: string | RegExp): Promise<HTMLElement> {
  const text = await screen.findByText(title);
  return text.closest("li")!;
}

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset();
  fns.product.mockResolvedValue({ product: product() });
  fns.releaseHealth.mockResolvedValue({ health: HEALTH_OK });
  fns.releases.mockResolvedValue(EMPTY);
  fns.releaseChannels.mockResolvedValue(CHANNELS);
  fns.ciPublisher.mockResolvedValue({ ok: true, policy: null });
  fns.ciTokens.mockResolvedValue({ ok: true, tokens: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Releases → guided first release (UX-23)", () => {
  it("replaces the empty table with the guided panel, and drops the zero count", async () => {
    mount();
    const panel = (
      await screen.findByRole("heading", { name: "Ship your first release" })
    ).closest("section")!;
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(panel).getByText(/signed with Tonebox's key/)).toBeTruthy();
    // The checks, in order: App, publisher, the live wait.
    const list = within(panel).getByRole("list", {
      name: "Before the first release",
    });
    await within(list).findByText("Polaris Key app installed");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("data-step-state")),
    ).toEqual(["done", "todo", "waiting"]);
    expect(
      within(list).getByText("Waiting for the first release…"),
    ).toBeTruthy();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Releases");
  });

  it("fills the workflow step with the slug, and copies it", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "Copy workflow step" }),
    );
    expect(await navigator.clipboard.readText()).toBe(workflowStep("tonebox"));
    expect(workflowStep("tonebox")).toContain("product: tonebox");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Release docs/ }).getAttribute("href"),
    ).toBe("/docs/features/ship-builds/ci/");
  });

  it("allows the workflow inline, through Keys & secrets' own publisher drawer", async () => {
    const user = userEvent.setup();
    fns.putCiPublisher.mockResolvedValue({ ok: true, policy: POLICY });
    mount();
    const publisher = await row("Trusted publisher");
    await user.click(
      await within(publisher).findByRole("button", { name: "Allow workflow…" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Set trusted publisher",
    });
    await user.type(input(drawer, "repository"), "acme/tonebox");
    await user.type(input(drawer, "repositoryId"), "11");
    await user.type(input(drawer, "repositoryOwnerId"), "22");
    fns.ciPublisher.mockResolvedValue({ ok: true, policy: POLICY });
    await user.click(
      within(drawer).getByRole("button", { name: "Save publisher" }),
    );
    await waitFor(() =>
      expect(fns.putCiPublisher).toHaveBeenCalledWith(
        "tonebox",
        expect.objectContaining({
          repository: "acme/tonebox",
          repositoryId: 11,
          repositoryOwnerId: 22,
        }),
      ),
    );
    // The row completes, and the step names the publisher's workflow file.
    const done = await screen.findByText(".github/workflows/ship.yml", {
      selector: "li span",
    });
    expect(done.closest("li")!.getAttribute("data-step-state")).toBe("done");
    expect(
      within(done.closest("li")!).getByRole("button", { name: "Edit…" }),
    ).toBeTruthy();
  });

  it("names a GitHub access failure with its fix, and checks again", async () => {
    const user = userEvent.setup();
    fns.releaseHealth.mockResolvedValue({
      health: {
        ...HEALTH_OK,
        status: "unhealthy",
        healthy: false,
        checks: [
          {
            id: "github",
            label: "GitHub access",
            status: "error",
            message: "404 Not Found",
          },
        ],
      },
    });
    mount();
    const app = await row("Polaris Key app can't read the repository");
    expect(app.getAttribute("data-step-state")).toBe("failed");
    // Never the raw HTTP error.
    expect(screen.queryByText(/404/)).toBeNull();
    fns.releaseHealth.mockResolvedValue({ health: HEALTH_OK });
    await user.click(within(app).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Polaris Key app installed")).toBeTruthy();
  });

  it("offers a manual product a trusted publisher or a CI token, and shows the token once", async () => {
    const user = userEvent.setup();
    fns.product.mockResolvedValue({
      product: product({ releaseSource: "manual" }),
    });
    fns.issueCiToken.mockResolvedValue({
      ok: true,
      token: "pkeyci_once",
      tokenId: "cit_9",
      expiresAt: NOW + 1000,
      scopes: ["release:publish"],
    });
    mount();
    const token = await row("Or a CI token");
    expect(screen.queryByText(/Polaris Key app/)).toBeNull();
    expect(await row("Trusted publisher")).toBeTruthy();
    await user.click(
      within(token).getByRole("button", { name: "Issue a CI token…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Issue a CI token",
    });
    fns.ciTokens.mockResolvedValue({
      ok: true,
      tokens: [
        {
          tokenId: "cit_9",
          kind: "static",
          scopes: ["release:publish"],
          subject: "static:cit_9",
          label: null,
          issuedAt: NOW,
          expiresAt: NOW + 1000,
          revokedAt: null,
          createdBy: "u1",
        },
      ],
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Issue token" }),
    );
    expect(await screen.findByText("pkeyci_once")).toBeTruthy();
    expect(
      await screen.findByText("CI token issued", { selector: "li p" }),
    ).toBeTruthy();
  });

  it("offers a manual product Link a repository, through Settings' own drawer", async () => {
    const user = userEvent.setup();
    fns.product.mockResolvedValue({
      product: product({ releaseSource: "manual" }),
    });
    fns.checkRepoLink.mockResolvedValue({
      ok: true,
      dryRun: true,
      slug: "tonebox",
      repository: "acme/tonebox",
      manifestDigest: "a".repeat(64),
      plan: {
        apply: [{ area: "tiers", id: "pro", summary: "Tier pro added" }],
        skipClaimed: [],
        delete: [],
        conflicts: [],
      },
      remainingSecrets: [],
    });
    fns.linkProductRepo.mockResolvedValue({
      ok: true,
      slug: "tonebox",
      repository: "acme/tonebox",
      plan: { apply: [], skipClaimed: [], delete: [], conflicts: [] },
      updated: ["product"],
      remainingSecrets: [],
    });
    mount();
    const link = await row("Link a repository");
    await user.click(
      within(link).getByRole("button", { name: "Link repository…" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Link repository",
    });
    await user.type(
      within(drawer).getByRole("textbox", { name: /Repository/ }),
      "acme/tonebox",
    );
    await user.click(within(drawer).getByRole("button", { name: "Check" }));
    await within(drawer).findByText("Tier pro added");
    await user.click(
      within(drawer).getByRole("button", {
        name: /^Link (repository|and remove)/,
      }),
    );
    await waitFor(() =>
      expect(fns.linkProductRepo).toHaveBeenCalledWith(
        "tonebox",
        "acme/tonebox",
        "a".repeat(64),
      ),
    );
  });

  it("polls the store and announces the release that ends the wait", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await screen.findByText("Waiting for the first release…");
    const before = fns.releases.mock.calls.length;
    fns.releases.mockResolvedValue(STORE);
    await act(() => vi.advanceTimersByTimeAsync(FIRST_RELEASE_POLL_MS));
    await waitFor(() =>
      expect(fns.releases.mock.calls.length).toBeGreaterThan(before),
    );
    await waitFor(() =>
      expect(lastAnnouncement()).toBe("0.4.2 published from CI"),
    );
    expect(screen.queryByText("Waiting for the first release…")).toBeNull();
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByText("Polaris Key app installed");
    await expectNoAxeViolations(container);
  });
});
