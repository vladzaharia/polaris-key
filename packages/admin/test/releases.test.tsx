import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ProductDetail,
  ReleaseChannelsResponse,
  ReleaseHealth,
  ReleaseStoreResponse,
  ResyncResult,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { CHANNELS, sha, STORE } from "./releaseFixture.js";

const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const resyncProduct = vi.fn<(slug: string) => Promise<ResyncResult>>();
const releaseHealth =
  vi.fn<(slug: string) => Promise<{ health: ReleaseHealth }>>();
// P2.T2 gave the truth store a writer, so this view finally has something to read: the card is
// the PRIMARY one now, which is why every case here has to answer this call.
const releases = vi.fn<(slug: string) => Promise<ReleaseStoreResponse>>();
// P2-07: the channels panel reads the policy model beside the store.
const releaseChannels =
  vi.fn<(slug: string) => Promise<ReleaseChannelsResponse>>();
vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    product: (slug: string) => product(slug),
    resyncProduct: (slug: string) => resyncProduct(slug),
    releaseHealth: (slug: string) => releaseHealth(slug),
    releases: (slug: string) => releases(slug),
    releaseChannels: (slug: string) => releaseChannels(slug),
  },
}));

const { Releases } = await import("../src/views/Releases.js");

const PRODUCT: ProductDetail = {
  slug: "djdl",
  name: "DJDL",
  signingKid: "kid-2026",
  compatMin: "1.0.0",
  compatMax: "2.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: "djdl-admins",
  // Resync is a repo-linked-only action, so the fixture has to say which kind of product
  // this is; `releaseSourceOf` defaults an absent value to "manual".
  releaseSource: "github",
  setup: {
    sync: {
      source: "webhook",
      status: "ok",
      lastCheckedAt: 1_720_000_000,
      lastSyncedAt: 1_720_000_000,
      commitSha: "abc123",
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

beforeEach(() => {
  resetCache();
  product.mockReset();
  resyncProduct.mockReset();
  releaseHealth.mockReset();
  releases.mockReset();
  releaseChannels.mockReset();
  product.mockResolvedValue({ product: PRODUCT });
  releaseHealth.mockResolvedValue({ health: HEALTH });
  releases.mockResolvedValue(STORE);
  releaseChannels.mockResolvedValue(CHANNELS);
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
});
afterEach(cleanup);

describe("Releases view", () => {
  it("renders the read-only product/release metadata and the manifest note", async () => {
    render(<Releases slug="djdl" />);

    expect(await screen.findByText("DJDL")).toBeTruthy();
    expect(screen.getByText("kid-2026")).toBeTruthy();
    // The compatibility window is NOT here any more — spec §8 relocated it to Update settings
    // (see the dedicated case below); a read-only copy would be the first place an operator
    // looked to change it.
    expect(screen.getByText("djdl-admins")).toBeTruthy();
    expect(await screen.findByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("GitHub access")).toBeTruthy();
    expect(screen.getByText(".pkey/product.yaml")).toBeTruthy();
    expect(screen.getByText("product")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();

    // The note explaining release config lives in the repo manifest.
    expect(screen.getByText(/managed from the repo manifest/i)).toBeTruthy();
  });

  it("resyncs from the repo via the confirm dialog, calling resyncProduct", async () => {
    resyncProduct.mockResolvedValue({ ok: true, slug: "djdl" });
    render(<Releases slug="djdl" />);
    await screen.findByText("DJDL");

    await userEvent.click(
      screen.getByRole("button", { name: /Resync from repo/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Resync" }),
    );

    await waitFor(() => expect(resyncProduct).toHaveBeenCalledWith("djdl"));
  });

  it("disables resync for a product that is not linked to a repo", async () => {
    // `release/resync.ts` returns "product is not linked to a repo" (422) for any product
    // whose `release_source` is not `github`, so an enabled button here is an affordance the
    // server is guaranteed to refuse.
    product.mockResolvedValue({
      product: { ...PRODUCT, releaseSource: "manual" },
    });
    render(<Releases slug="djdl" />);
    await screen.findByText("DJDL");

    const button = screen.getByRole("button", { name: /Resync from repo/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(resyncProduct).not.toHaveBeenCalled();
  });

  it("shows an error state with retry when the product fails to load", async () => {
    product.mockReset();
    product
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce({ product: PRODUCT });
    render(<Releases slug="djdl" />);

    expect(await screen.findByText("Couldn’t load the product")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("DJDL")).toBeTruthy();
  });
});

describe("Releases view — the truth store (P2.T2)", () => {
  it("reads the store rather than re-deriving releases from health", async () => {
    render(<Releases slug="djdl" />);
    // The version, the channel the sync saw pointing at it, and the build and file counts are
    // what a feed decision turns on, so they are what this pins. The version appears in the
    // store row, the channel map and the channels panel by design: presence, not cardinality.
    expect((await screen.findAllByText("0.4.2")).length).toBeGreaterThan(0);
    expect(screen.getByText("Snake eyes")).toBeTruthy();
    expect(screen.getAllByText(/stable/).length).toBeGreaterThan(0);
    expect(releases).toHaveBeenCalledWith("djdl");
    // The row reports how many builds and files were indexed — what a feed selects from.
    const row = screen.getByText("Loaded dice").closest("tr")!;
    expect(within(row).getByText("6")).toBeTruthy();
    expect(within(row).getByText("9")).toBeTruthy();
  });

  it("degrades to an empty state when the store has no rows, without hiding health", async () => {
    releases.mockResolvedValue({ releases: [], channels: [], floors: [] });
    render(<Releases slug="djdl" />);
    // Health still renders: an unsynced store is a fact about the sync, not about the product.
    expect(await screen.findByText("Release health")).toBeTruthy();
    expect(screen.queryByText("Snake eyes")).toBeNull();
  });

  it("moves the compatibility window out of this view — it is Update settings' now", async () => {
    // Spec §8 relocated it. Leaving a read-only copy here would be a second place an operator
    // could read a value they cannot edit here, and the first place they would look to change it.
    render(<Releases slug="djdl" />);
    await screen.findByText("Distribution & compatibility");
    expect(screen.queryByText(/^min 1\.0\.0$/)).toBeNull();
    expect(screen.getByText(/Update settings/)).toBeTruthy();
  });
});

describe("Releases view — builds and artifacts (P2-07)", () => {
  async function expand(version: string): Promise<HTMLElement> {
    render(<Releases slug="djdl" />);
    await userEvent.click(
      await screen.findByRole("button", { name: `Show builds of ${version}` }),
    );
    return screen.findByLabelText(`Builds of ${version}`);
  }

  it("shows each of six builds' platform, arch, format, build number and payload SHA-256", async () => {
    const builds = await expand("0.4.1");
    const rows = within(builds)
      .getAllByRole("row")
      .filter((r) => within(r).queryAllByRole("cell").length === 7);
    expect(rows).toHaveLength(6);
    const want: Array<[string, string, string, string, string, number]> = [
      // Platform and arch by their display names; the raw arch follows where it differs.
      ["macos-universal", "macOS", "Universal", "zip", "41", 100],
      ["windows-x86_64", "Windows", "x64 (x86_64)", "zip", "41", 101],
      ["linux-x86_64", "Linux", "x86_64", "tar.gz", "41", 102],
      ["ios-arm64", "iOS / iPadOS", "arm64", "ipa", "1041", 103],
      ["android-arm64", "Android", "ARM64", "aab", "4041", 104],
      ["web-wasm32", "Web", "wasm32", "zip", "41", 105],
    ];
    for (const [
      i,
      [id, platform, arch, format, number, seed],
    ] of want.entries()) {
      const cells = within(rows[i]!).getAllByRole("cell");
      expect(cells.map((c) => c.textContent)).toEqual([
        id,
        platform,
        arch,
        format,
        number,
        expect.any(String),
        `${sha(seed).slice(0, 12)}…`,
      ]);
      // Shortened on screen; the full hash is one copy away and in the title.
      expect(
        within(cells[6]!).getByRole("button", {
          name: `Copy SHA-256 ${sha(seed)}`,
        }),
      ).toBeTruthy();
    }
    // Minimum OS, where the build declares one.
    expect(within(rows[0]!).getByText("12.0")).toBeTruthy();
  });

  it("groups files under their build, says where the bytes live, and hides sidecars until toggled", async () => {
    const builds = await expand("0.4.1");
    expect(
      within(builds).getByText("diceroll-v0.4.1-macos-universal.zip"),
    ).toBeTruthy();
    // R2 and GitHub for a self-hosted payload, Store for the iOS one, External for the web one.
    expect(within(builds).getAllByText("R2").length).toBeGreaterThan(0);
    expect(within(builds).getAllByText("Store")).toHaveLength(1);
    expect(within(builds).getAllByText("External")).toHaveLength(1);

    // Two signatures and a checksum file are sidecars: collapsed by default.
    expect(
      within(builds).queryByText("diceroll-v0.4.1-macos-universal.sig"),
    ).toBeNull();
    expect(within(builds).queryByText("SHA256SUMS")).toBeNull();
    await userEvent.click(
      within(builds).getByRole("button", { name: "Show sidecars (3)" }),
    );
    expect(
      within(builds).getByText("diceroll-v0.4.1-macos-universal.sig"),
    ).toBeTruthy();
    // A file no descriptor tied to a build is listed on its own.
    expect(within(builds).getByText("Files not tied to a build")).toBeTruthy();
    expect(within(builds).getByText("SHA256SUMS")).toBeTruthy();
    await userEvent.click(
      within(builds).getByRole("button", { name: "Hide sidecars" }),
    );
    expect(within(builds).queryByText("SHA256SUMS")).toBeNull();
  });

  it("lists a legacy release's synced files with their bytes on GitHub", async () => {
    const builds = await expand("0.3.0");
    expect(within(builds).getByText(/No builds declared/)).toBeTruthy();
    expect(within(builds).getByText("diceroll-macos.zip")).toBeTruthy();
    expect(within(builds).getByText("GitHub (synced)")).toBeTruthy();
    // A file listed on its own carries its platform and arch together, never a bare arch.
    expect(within(builds).getByText("macOS Universal").title).toBe(
      "macOS · Universal",
    );
  });

  it("badges a yanked release with its reason", async () => {
    render(<Releases slug="djdl" />);
    expect(
      await screen.findByText("Yanked: corrupts saves on Android"),
    ).toBeTruthy();
  });
});

describe("Releases view — floor health (P0-02 wave-1 sync)", () => {
  it("renders the channel-floor-unverified warning and points at the floor action", async () => {
    releaseHealth.mockResolvedValue({
      health: {
        ...HEALTH,
        status: "healthy",
        checks: [
          ...HEALTH.checks,
          {
            id: "channel-floor-unverified-beta",
            label: "Channel floor (beta)",
            status: "warning",
            message:
              "beta is floored at 0.5.0, but the releases read so far do not reach it and the follow-up GitHub lookup failed (rate limited), so whether the floor release still exists is unknown.",
          },
        ],
      },
    });
    render(<Releases slug="djdl" />);
    const label = await screen.findByText("Channel floor (beta)");
    const item = label.closest("li")!;
    expect(within(item).getByText("warning")).toBeTruthy();
    expect(within(item).getByText(/beta is floored at 0\.5\.0/)).toBeTruthy();
    expect(within(item).getByText(/Lower or clear the floor/)).toBeTruthy();
  });
});

describe("Releases view — release artifacts in health", () => {
  it("lists the files the latest release carries, with platform and arch where known", async () => {
    releaseHealth.mockResolvedValue({
      health: {
        ...HEALTH,
        checks: [
          ...HEALTH.checks,
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
    render(<Releases slug="djdl" />);
    const label = await screen.findByText("Release artifacts");
    const item = label.closest("li")!;
    expect(within(item).getByText("v1.2.3 carries 2 files.")).toBeTruthy();
    const files = within(item).getByRole("list", {
      name: "Release artifacts files",
    });
    expect(within(files).getAllByRole("listitem")).toHaveLength(2);
    expect(within(files).getByText("game-linux-x86_64.tar.gz")).toBeTruthy();
    expect(within(files).getByText("Linux · x86_64")).toBeTruthy();
    expect(within(files).getByText("notes.txt")).toBeTruthy();
    // No assumed DMG/CLI rows are rendered: the view shows only the checks it is given.
    expect(screen.queryByText(/DMG/)).toBeNull();
  });

  it("renders a declared entry's missing state and an ambiguous entry's candidates generically", async () => {
    releaseHealth.mockResolvedValue({
      health: {
        ...HEALTH,
        status: "needs-setup",
        healthy: false,
        missing: ["win: file matching Game-*-windows.zip"],
        checks: [
          ...HEALTH.checks,
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
    render(<Releases slug="djdl" />);
    const win = (await screen.findByText("win (windows x86_64 zip)")).closest(
      "li",
    )!;
    expect(within(win).getByText("missing")).toBeTruthy();
    expect(
      within(win).getByText("Missing: win: file matching Game-*-windows.zip"),
    ).toBeTruthy();
    const linux = screen
      .getByText("linux (linux x86_64 tar.gz)")
      .closest("li")!;
    const candidates = within(linux).getByRole("list", {
      name: "linux (linux x86_64 tar.gz) files",
    });
    expect(within(candidates).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(candidates).getAllByText("Linux · x86_64 · tar.gz"),
    ).toHaveLength(2);
  });
});
