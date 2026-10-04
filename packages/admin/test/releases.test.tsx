import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DistributionMatrix,
  ProductDetail,
  ReleaseChannelsResponse,
  ReleaseHealth,
  ReleaseStoreResponse,
  ResyncResult,
} from "../src/api.js";
import { CHANNELS, RELEASE_KID, sha, STORE } from "./releaseFixture.js";
import {
  expectNoAxeViolations,
  hashQuery,
  mountAt,
  pending,
} from "./releaseHarness.js";

const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const resyncProduct = vi.fn<(slug: string) => Promise<ResyncResult>>();
const releaseHealth =
  vi.fn<(slug: string) => Promise<{ health: ReleaseHealth }>>();
const releases = vi.fn<(slug: string) => Promise<ReleaseStoreResponse>>();
const releaseChannels =
  vi.fn<(slug: string) => Promise<ReleaseChannelsResponse>>();
const updateReleaseChannel = vi.fn();
const yankRelease = vi.fn();
const unyankRelease = vi.fn();
const distributionMatrix = vi.fn<() => Promise<DistributionMatrix>>();
vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    product: (slug: string) => product(slug),
    resyncProduct: (slug: string) => resyncProduct(slug),
    releaseHealth: (slug: string) => releaseHealth(slug),
    releases: (slug: string) => releases(slug),
    releaseChannels: (slug: string) => releaseChannels(slug),
    updateReleaseChannel: (...a: unknown[]) => updateReleaseChannel(...a),
    yankRelease: (...a: unknown[]) => yankRelease(...a),
    unyankRelease: (...a: unknown[]) => unyankRelease(...a),
    distributionMatrix: () => distributionMatrix(),
  },
}));

const { ReleasesPage } =
  await import("../src/console/pages/release/ReleasesPage.js");
const { ReleaseRecord } =
  await import("../src/console/pages/release/ReleaseRecord.js");

const PRODUCT: ProductDetail = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "kid-2026",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: "djdl-admins",
  releaseSource: "github",
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
    identity: { enabled: true },
  },
  setup: {
    sync: {
      source: "webhook",
      status: "ok",
      lastCheckedAt: 1_720_000_000,
      lastSyncedAt: 1_720_000_000,
      commitSha: "abc123def4567890",
      changedPaths: [".pkey/product.yaml"],
      updated: ["product", "release"],
      errors: [],
      message: null,
    },
  },
  createdAt: 1_700_000_000,
  modifiedAt: 1_710_000_000,
};

const HEALTH: ReleaseHealth = {
  status: "healthy",
  healthy: true,
  missing: [],
  release: {
    tag: "v1.2.3",
    name: "1.2.3",
    prerelease: false,
    assetCount: 5,
    htmlUrl: "https://github.com/acme/djdl/releases/tag/v1.2.3",
  },
  checks: [
    {
      id: "github",
      label: "GitHub access",
      status: "ok",
      message: "Listed 1 release.",
    },
    {
      id: "sparkle-signature",
      label: "Sparkle signature",
      status: "ok",
      message: "Found djdl-arm64.dmg.sig.",
    },
  ],
};

const MATRIX = {
  deliverableId: "app",
  limit: 50,
  outlets: [
    {
      outletId: "direct",
      kind: "direct",
      transport: "https",
      derives: true,
      supported: true,
    },
    {
      outletId: "play",
      kind: "google-play",
      transport: "play",
      derives: false,
      supported: true,
    },
  ],
  releases: [
    {
      releaseId: "v0.4.2",
      version: "0.4.2",
      channel: null,
      publishedAt: 1_728_000_000,
      yanked: false,
    },
  ],
  cells: [
    {
      releaseId: "v0.4.2",
      outletId: "direct",
      availability: "live",
      records: [],
      submission: null,
      rollouts: [
        {
          deliverableId: "app",
          outletId: "direct",
          channel: "stable",
          releaseId: "v0.4.2",
          rolloutBp: 2500,
          state: "active",
          mirrored: false,
          source: "admin",
          startedAt: 1,
          updatedAt: 1,
          updatedBy: "admin:u1",
          controls: ["pause", "halt", "complete"],
        },
      ],
    },
  ],
} as unknown as DistributionMatrix;

const HASH = "#/p/djdl/release/releases";

function mountList(hash = HASH) {
  return mountAt(hash, <ReleasesPage slug="djdl" />);
}

beforeEach(() => {
  for (const f of [
    product,
    resyncProduct,
    releaseHealth,
    releases,
    releaseChannels,
    updateReleaseChannel,
    yankRelease,
    unyankRelease,
    distributionMatrix,
  ])
    f.mockReset();
  product.mockResolvedValue({ product: PRODUCT });
  releaseHealth.mockResolvedValue({ health: HEALTH });
  releases.mockResolvedValue(STORE);
  releaseChannels.mockResolvedValue(CHANNELS);
  distributionMatrix.mockResolvedValue(MATRIX);
  updateReleaseChannel.mockResolvedValue({ ok: true });
  yankRelease.mockResolvedValue({ ok: true });
  unyankRelease.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

/** The table row whose primary link is `version`. */
async function rowOf(version: string): Promise<HTMLElement> {
  const link = await screen.findByRole("link", {
    name: new RegExp(`^${version.replace(/\./g, "\\.")}( Yanked)?$`),
  });
  return link.closest("tr")!;
}

describe("Releases page (T2, ADMIN.md §6.3.1)", () => {
  it("reads the store: one row per app release with channels, builds and signer", async () => {
    mountList();
    expect(
      await screen.findByRole("heading", { level: 1, name: /Releases/ }),
    ).toBeTruthy();
    const row = await rowOf("0.4.2");
    expect(releases).toHaveBeenCalledWith("djdl");
    // The version links to the release record (REL-10's nested expansion is gone).
    expect(
      within(row)
        .getByRole("link", { name: /^0\.4\.2$/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/release/releases/v0.4.2");
    // Both channels serve 0.4.2 on at least one platform: the server's resolution, once (REL-4).
    expect(await within(row).findByText("stable")).toBeTruthy();
    expect(within(row).getByText("beta")).toBeTruthy();
    // Builds as platform glyphs, with a labelled list for assistive tech.
    const builds = within(row).getByRole("list", { name: "Builds of 0.4.2" });
    expect(within(builds).getAllByRole("listitem")).toHaveLength(5);
    // Signed by the CI release key, in gold.
    expect(within(row).getByText(RELEASE_KID)).toBeTruthy();
    // The GitHub release (REL-9).
    expect(
      within(row)
        .getByRole("link", { name: /0\.4\.2 on GitHub/ })
        .getAttribute("href"),
    ).toBe("https://github.com/vladzaharia/diceroll/releases/tag/v0.4.2");
    // A legacy release lists its files instead of builds, and has no signed record.
    const legacy = await rowOf("0.3.0");
    expect(within(legacy).getByText("1 file")).toBeTruthy();
    expect(within(legacy).getByText("No signed record")).toBeTruthy();
  });

  it("strikes through and labels a yanked release", async () => {
    mountList();
    const row = await rowOf("0.4.0");
    expect(within(row).getByText("Yanked")).toBeTruthy();
  });

  it("shows skeleton rows while the store loads", async () => {
    releases.mockReturnValue(pending());
    const { container } = mountList();
    await screen.findByRole("heading", { level: 1, name: /Releases/ });
    expect(container.querySelectorAll("tbody tr[aria-hidden]")).toHaveLength(5);
    expect(screen.queryByRole("link", { name: /^0\.4\.2$/ })).toBeNull();
  });

  it("shows the load error in the table with Retry, and recovers", async () => {
    releases.mockReset();
    releases
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(STORE);
    mountList();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await rowOf("0.4.2")).toBeTruthy();
  });

  it("says what fills the store when it is empty (first run)", async () => {
    releases.mockResolvedValue({ releases: [], channels: [], floors: [] });
    mountList();
    expect(await screen.findByText("No releases yet")).toBeTruthy();
    expect(
      screen.getByText(/the linked repository publishes one/),
    ).toBeTruthy();
  });

  it("round-trips its filters through the URL, with a no-results state that clears them", async () => {
    mountList(`${HASH}?yank=yanked`);
    expect(await rowOf("0.4.0")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^0\.4\.2$/ })).toBeNull();
    await userEvent.type(
      screen.getByRole("searchbox", { name: /Search version or title/ }),
      "nothing-matches",
    );
    await waitFor(() => expect(hashQuery().get("q")).toBe("nothing-matches"));
    expect(hashQuery().get("yank")).toBe("yanked");
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "Clear filters" }))[0]!,
    );
    await waitFor(() => expect(hashQuery().get("yank")).toBeNull());
    expect(hashQuery().get("q")).toBeNull();
    expect(await rowOf("0.4.2")).toBeTruthy();
  });

  it("resyncs from the repo through a caution confirm, then lists what changed in the Repo sync drawer", async () => {
    resyncProduct.mockResolvedValue({
      ok: true,
      slug: "djdl",
      updated: ["catalog", "channels"],
      refused: [
        {
          code: "release_key_is_product_key",
          path: ".pkey/release",
          message: "the release key is a product key",
        },
      ],
    });
    mountList();
    await rowOf("0.4.2");
    await userEvent.click(
      screen.getByRole("button", { name: "Resync from repo" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/re-applied from the manifest/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Resync from repo" }),
    );
    await waitFor(() => expect(resyncProduct).toHaveBeenCalledWith("djdl"));
    // A result panel, not just a toast (RSY-3).
    const drawer = await screen.findByRole("dialog", { name: "Repo sync" });
    expect(
      await within(drawer).findByText("Updated: catalog, channels."),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(/the release key is a product key/),
    ).toBeTruthy();
    expect(hashQuery().get("panel")).toBe("sync");
    // Everything under the product refetches (RSY-1).
    await waitFor(() => expect(releases.mock.calls.length).toBeGreaterThan(1));
  });

  it("disables Resync with a visible reason for a product with no repository (RSY-2)", async () => {
    product.mockResolvedValue({
      product: { ...PRODUCT, releaseSource: "manual" },
    });
    mountList();
    await rowOf("0.4.2");
    const button = screen.getByRole("button", { name: /Resync from repo/ });
    await waitFor(() =>
      expect(button.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(
      screen.getAllByText("This product isn't linked to a repository.").length,
    ).toBeGreaterThan(0);
    await userEvent.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(resyncProduct).not.toHaveBeenCalled();
  });

  it("yanks from the row menu: a danger confirm that needs a reason, then refreshes", async () => {
    mountList();
    const row = await rowOf("0.4.2");
    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for 0.4.2" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Yank…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    // The reason is not marked invalid before an attempt (PAD-6).
    const reason = within(dialog).getByRole("textbox", { name: /Reason/ });
    expect(reason.getAttribute("aria-invalid")).toBeNull();
    const confirm = within(dialog).getByRole("button", { name: "Yank 0.4.2" });
    expect(confirm.className).toMatch(/bg-danger/);
    await userEvent.click(confirm);
    expect(yankRelease).not.toHaveBeenCalled();
    expect(
      await within(dialog).findByText("Enter a reason for the yank."),
    ).toBeTruthy();
    await userEvent.type(reason, "crashes on launch");
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(yankRelease).toHaveBeenCalledWith(
        "djdl",
        "v0.4.2",
        "crashes on launch",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(releases.mock.calls.length).toBeGreaterThan(1));
  });

  it("unyanks from the row menu with a caution confirm, weaker than Yank (REL-5)", async () => {
    mountList();
    const row = await rowOf("0.4.0");
    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for 0.4.0" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Unyank…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Unyank 0.4.0",
    });
    expect(confirm.className).not.toMatch(/bg-danger/);
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(unyankRelease).toHaveBeenCalledWith("djdl", "v0.4.0"),
    );
  });

  it("promotes from the row menu with the release preselected", async () => {
    mountList();
    const row = await rowOf("0.4.1");
    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for 0.4.1" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Promote…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        /Promote moves the pointer; newer releases still flow/,
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Promote 0.4.1" }),
    );
    await waitFor(() =>
      expect(updateReleaseChannel).toHaveBeenCalledWith("djdl", "stable", {
        deliverable: "app",
        pointer: "v0.4.1",
      }),
    );
  });

  it("passes axe", async () => {
    const { container } = mountList();
    await rowOf("0.4.2");
    await expectNoAxeViolations(container);
  });
});

describe("Repo sync drawer (REL-2, REL-8, REL-9)", () => {
  async function openDrawer(): Promise<HTMLElement> {
    mountList(`${HASH}?panel=sync`);
    return screen.findByRole("dialog", { name: "Repo sync" });
  }

  it("shows health, the latest tag, and the last sync's lists untruncated", async () => {
    const paths = Array.from({ length: 15 }, (_, i) => `.pkey/file-${i}.yaml`);
    product.mockResolvedValue({
      product: {
        ...PRODUCT,
        setup: { sync: { ...PRODUCT.setup!.sync!, changedPaths: paths } },
      },
    });
    const drawer = await openDrawer();
    expect(await within(drawer).findByText("GitHub access")).toBeTruthy();
    expect(
      within(drawer).getByText("v1.2.3").closest("a")?.getAttribute("href"),
    ).toBe(HEALTH.release!.htmlUrl);
    expect(await within(drawer).findByText("Changed paths (15)")).toBeTruthy();
    for (const p of paths) expect(within(drawer).getByText(p)).toBeTruthy();
    expect(within(drawer).getByText("A push to the repository")).toBeTruthy();
    expect(within(drawer).getByText("abc123def456")).toBeTruthy();
    expect(within(drawer).getByText("Updated sections (2)")).toBeTruthy();
  });

  it("points a floor warning at the channel's floor action on Channels", async () => {
    releaseHealth.mockResolvedValue({
      health: {
        ...HEALTH,
        checks: [
          ...HEALTH.checks,
          {
            id: "channel-floor-unverified-beta",
            label: "Channel floor (beta)",
            status: "warning",
            message:
              "beta is floored at 0.5.0, but the releases read so far do not reach it.",
          },
        ],
      },
    });
    const drawer = await openDrawer();
    const item = (
      await within(drawer).findByText("Channel floor (beta)")
    ).closest("li")!;
    expect(within(item).getByText("Warning")).toBeTruthy();
    expect(within(item).getByText(/beta is floored at 0\.5\.0/)).toBeTruthy();
    expect(
      within(item).getByRole("link", { name: "Channels" }).getAttribute("href"),
    ).toBe("#/p/djdl/release/channels");
  });

  it("lists the files the latest release carries, with platform and arch where known", async () => {
    releaseHealth.mockResolvedValue({
      health: {
        ...HEALTH,
        checks: [
          {
            id: "release-artifacts",
            label: "Release artifacts",
            status: "ok",
            message: "v1.2.3 carries 2 files.",
            files: [
              {
                name: "game-linux-x86_64.tar.gz",
                platform: "linux",
                arch: "x86_64",
              },
              { name: "notes.txt" },
            ],
          },
        ],
      },
    });
    const drawer = await openDrawer();
    const files = await within(drawer).findByRole("list", {
      name: "Release artifacts files",
    });
    expect(within(files).getAllByRole("listitem")).toHaveLength(2);
    expect(within(files).getByText("Linux · x86_64")).toBeTruthy();
    expect(within(files).getByText("notes.txt")).toBeTruthy();
    expect(within(drawer).queryByText(/DMG/)).toBeNull();
  });

  it("renders a declared entry's missing state and an ambiguous entry's candidates", async () => {
    releaseHealth.mockResolvedValue({
      health: {
        ...HEALTH,
        status: "needs-setup",
        healthy: false,
        missing: ["win: file matching Game-*-windows.zip"],
        checks: [
          {
            id: "artifact-win",
            label: "win (windows x86_64 zip)",
            status: "missing",
            message:
              'No file in the latest release matches "Game-*-windows.zip".',
            missing: ["win: file matching Game-*-windows.zip"],
          },
          {
            id: "artifact-linux",
            label: "linux (linux x86_64 tar.gz)",
            status: "missing",
            message: "2 files match, so none is served.",
            files: [
              {
                name: "Game-1-linux.tar.gz",
                platform: "linux",
                arch: "x86_64",
                format: "tar.gz",
              },
              {
                name: "Game-1-rc-linux.tar.gz",
                platform: "linux",
                arch: "x86_64",
                format: "tar.gz",
              },
            ],
          },
        ],
      },
    });
    const drawer = await openDrawer();
    expect(
      (await within(drawer).findAllByText("Needs setup")).length,
    ).toBeGreaterThan(0);
    const win = within(drawer)
      .getByText("win (windows x86_64 zip)")
      .closest("li")!;
    expect(within(win).getByText("Missing")).toBeTruthy();
    expect(
      within(win).getByText("Missing: win: file matching Game-*-windows.zip"),
    ).toBeTruthy();
    const candidates = within(drawer).getByRole("list", {
      name: "linux (linux x86_64 tar.gz) files",
    });
    expect(
      within(candidates).getAllByText("Linux · x86_64 · tar.gz"),
    ).toHaveLength(2);
  });

  it("shows a health error with Retry inside the drawer", async () => {
    releaseHealth.mockReset();
    releaseHealth
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ health: HEALTH });
    const drawer = await openDrawer();
    await userEvent.click(
      await within(drawer).findByRole("button", { name: "Retry" }),
    );
    expect(await within(drawer).findByText("GitHub access")).toBeTruthy();
  });
});

describe("Release record (T3, ADMIN.md §6.3.2)", () => {
  function mountRecord(id: string, tab?: string) {
    return mountAt(
      `#/p/djdl/release/releases/${id}${tab ? `/${tab}` : ""}`,
      <ReleaseRecord slug="djdl" id={id} tab={tab} />,
    );
  }

  it("heads the record with version, where it is live, its signer and the GitHub release", async () => {
    mountRecord("v0.4.2");
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("0.4.2");
    expect(await screen.findByText("Live on stable, beta")).toBeTruthy();
    expect(screen.getAllByText(RELEASE_KID).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: /GitHub release/ }).getAttribute("href"),
    ).toBe(STORE.releases[0]!.sourceUrl);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(crumbs)
        .getByRole("link", { name: "Releases" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/release/releases");
    // Tabs are route links.
    expect(
      screen.getByRole("link", { name: /^Packs/ }).getAttribute("href"),
    ).toBe("#/p/djdl/release/releases/v0.4.2/packs");
  });

  it("shows builds as cards: summary, files, hashes and where the bytes live; sidecars on request (RBD-1, RBD-2)", async () => {
    mountRecord("v0.4.1", "builds");
    const mac = await screen.findByRole("region", {
      name: "Build macos-universal",
    });
    expect(
      within(mac).getByText(/macOS · Universal · zip · build 41/),
    ).toBeTruthy();
    expect(
      within(mac).getByText("diceroll-v0.4.1-macos-universal.zip"),
    ).toBeTruthy();
    expect(within(mac).getAllByText("R2").length).toBeGreaterThan(0);
    expect(within(mac).getByText("Access: Licensed")).toBeTruthy();
    expect(screen.getAllByRole("region", { name: /^Build / })).toHaveLength(6);
    expect(screen.getAllByText("Store")).toHaveLength(1);
    expect(screen.getAllByText("External")).toHaveLength(1);
    // A location badge explains itself in a popover, never a title.
    await userEvent.click(
      within(mac).getAllByRole("button", { name: /^R2/ })[0]!,
    );
    expect(
      await screen.findByText(/Stored in Polaris Key's object storage/),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    // Sidecars collapsed by default.
    expect(
      screen.queryByText("diceroll-v0.4.1-macos-universal.sig"),
    ).toBeNull();
    expect(screen.queryByText("SHA256SUMS")).toBeNull();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Show signatures and checksums (3)",
      }),
    );
    expect(
      screen.getByText("diceroll-v0.4.1-macos-universal.sig"),
    ).toBeTruthy();
    expect(screen.getByText("Files not tied to a build")).toBeTruthy();
    expect(screen.getByText("SHA256SUMS")).toBeTruthy();
    // Each payload's SHA-256 is shortened, with the full value one copy away.
    expect(
      screen.getAllByRole("button", { name: "Copy SHA-256" }).length,
    ).toBeGreaterThanOrEqual(6);
    expect(sha(100)).toHaveLength(64);
  });

  it("lists a legacy release's synced files with their bytes on GitHub", async () => {
    mountRecord("v0.3.0");
    expect(await screen.findByText(/No builds declared/)).toBeTruthy();
    expect(screen.getByText("diceroll-macos.zip")).toBeTruthy();
    expect(screen.getByText("GitHub (synced)")).toBeTruthy();
  });

  it("lists the packs it pins as links to the pack record (RBD-2)", async () => {
    releases.mockResolvedValue({
      ...STORE,
      releases: [
        {
          ...STORE.releases[0]!,
          contentApi: 3,
          pins: [
            {
              pack: "textures",
              packReleaseId: "textures@1.3.0",
              packVersion: "1.3.0",
              packYank: null,
              required: true,
              delivery: "essential",
              recordSha256: sha(7),
            },
          ],
        },
        ...STORE.releases.slice(1),
      ],
    });
    mountRecord("v0.4.2", "packs");
    const link = await screen.findByRole("link", { name: "1.3.0" });
    expect(link.getAttribute("href")).toBe(
      "#/p/djdl/release/deliverables/textures/releases?release=textures%401.3.0",
    );
    expect(
      screen.getByRole("link", { name: "textures" }).getAttribute("href"),
    ).toBe("#/p/djdl/release/deliverables/textures");
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("Delivery: essential")).toBeTruthy();
  });

  it("says where each channel serves it, per platform", async () => {
    mountRecord("v0.4.1", "channels");
    expect(await screen.findAllByText("Serves 0.4.1 on iOS.")).toHaveLength(2);
  });

  it("lists its outlets from Distribution's matrix, with the rollout", async () => {
    mountRecord("v0.4.2", "distribution");
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.getByText(/Rolling out\s+25 %/)).toBeTruthy();
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: "Open in matrix" })[0]!
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/matrix?cell=v0.4.2%3Adirect");
  });

  it("says a release outside Distribution's window is not tracked, not unserved", async () => {
    mountRecord("v0.4.1", "distribution");
    expect(
      await screen.findByText(
        "Not in the newest 50 releases tracked by Distribution",
      ),
    ).toBeTruthy();
  });

  it("disables Promote on a yanked release with the reason, and names the yank", async () => {
    mountRecord("v0.4.0");
    expect(
      await screen.findByText("Yanked: corrupts saves on Android"),
    ).toBeTruthy();
    const promote = screen.getAllByRole("button", { name: "Promote…" })[0]!;
    expect(promote.getAttribute("aria-disabled")).toBe("true");
  });

  it("names a missing release instead of rendering nothing", async () => {
    mountRecord("v9.9.9");
    expect(await screen.findByText("No release v9.9.9 in DJDL")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "All releases" }).getAttribute("href"),
    ).toBe("#/p/djdl/release/releases");
  });

  it("passes axe", async () => {
    const { container } = mountRecord("v0.4.1");
    await screen.findByRole("region", { name: "Build macos-universal" });
    await expectNoAxeViolations(container);
  });
});
