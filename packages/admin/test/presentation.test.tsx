/**
 * HA-06 — Core → Presentation: every hosted-asset slot with its source, status, size and preview,
 * "Sizes pending", and the three actions (Upload/Replace, Revert to manifest, Delete copy), each
 * through `mutate` so the product card's icon (the registry and the product detail) and Home's
 * summary refresh with the slots.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AssetUsageDto, HostedAssetDto } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  hostedAssets: vi.fn(),
  uploadHostedAsset: vi.fn(),
  deleteHostedAsset: vi.fn(),
  assetUsage: vi.fn(),
  saveAssetSetting: vi.fn(),
  resetAssetSetting: vi.fn(),
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

const { ApiError } = await import("../src/api.js");
const { PresentationPage, slotLabel, statusOf } =
  await import("../src/console/pages/core/Presentation.js");
const { queryClient } = await import("../src/console/data/queryClient.js");
const { qk } = await import("../src/console/data/queries.js");

const NOW = 1_800_000_000;
const IMG = "https://img.example.test";
const A = "a".repeat(64);
const C = "c".repeat(64);

function asset(over: Partial<HostedAssetDto>): HostedAssetDto {
  return {
    slot: "presentation.icon",
    locale: "",
    origin: "manifest",
    sourceKind: "url",
    sourceRef: "https://cdn.example.com/icon.png",
    status: "ready",
    error: null,
    sha256: A,
    size: 126_268,
    contentType: "image/png",
    width: 512,
    height: 512,
    checkedAt: NOW,
    modifiedAt: NOW,
    wanted: { kind: "url", src: "https://cdn.example.com/icon.png" },
    pullPending: false,
    attempts: 0,
    nextAttemptAt: null,
    sizesPending: false,
    widths: [64, 128, 256, 512],
    url: `${IMG}/djdl/a/${A}`,
    previewUrl: `${IMG}/djdl/a/${A}/256.webp`,
    uploadable: true,
    maxBytes: 10 * 1024 * 1024,
    ...over,
  };
}

const ROWS: HostedAssetDto[] = [
  asset({}),
  asset({
    slot: "listing.header",
    origin: "console",
    sourceKind: "upload",
    sourceRef: null,
    sha256: C,
    size: 569_622,
    width: 1920,
    height: 1080,
    wanted: { kind: "repo", src: "art/header.png" },
    sizesPending: true,
    widths: [],
    url: `${IMG}/djdl/a/${C}`,
    previewUrl: `${IMG}/djdl/a/${C}`,
    maxBytes: 20 * 1024 * 1024,
  }),
  asset({
    slot: "listing.screenshot:1",
    origin: "manifest",
    status: "stale",
    error: "status:404",
    wanted: { kind: "url", src: "https://cdn.example.com/s1.png" },
    maxBytes: 20 * 1024 * 1024,
  }),
  asset({
    slot: "release-file",
    origin: "release-mirror",
    sourceKind: "github-asset",
    sourceRef: "123",
    contentType: "application/zip",
    url: null,
    previewUrl: null,
    uploadable: false,
    maxBytes: null,
    wanted: null,
  }),
];

const MiB = 1024 * 1024;

/** HA-10: the usage read, images within quota and release files at theirs. */
function usage(over: Partial<AssetUsageDto> = {}): AssetUsageDto {
  return {
    hosting: true,
    media: { bytes: 128 * MiB, files: 7, quota: 512 * MiB, full: false },
    release: {
      bytes: 2 * 1024 * MiB,
      files: 3,
      quota: 2 * 1024 * MiB,
      full: true,
    },
    settings: [
      {
        key: "assets.releases.mirror",
        label: "Mirror release files",
        description: "Keeps Polaris Key's own copy of every app release file.",
        spec: { kind: "switch" },
        confirm: { on: "L0", off: "L1" },
        value: "on",
        source: "default",
        inherited: "on",
        own: false,
        version: 0,
      },
      {
        key: "assets.quota.mediaBytes",
        label: "Media quota",
        description: "How many bytes of hosted images this product may hold.",
        spec: { kind: "integer", unit: "bytes", min: 0, max: 1024 ** 4 },
        confirm: { up: "L1", down: "L1" },
        value: 512 * MiB,
        source: "default",
        inherited: 512 * MiB,
        own: false,
        version: 0,
      },
      {
        key: "assets.quota.releaseBytes",
        label: "Release-file quota",
        description:
          "How many bytes of mirrored release files this product may hold.",
        spec: { kind: "integer", unit: "bytes", min: 0, max: 10 * 1024 ** 4 },
        confirm: { up: "L1", down: "L1" },
        value: 2 * 1024 * MiB,
        source: "console",
        inherited: 100 * 1024 * MiB,
        own: true,
        version: 3,
      },
    ],
    ...over,
  };
}

const mount = () =>
  renderAt("#/p/djdl/presentation", <PresentationPage slug="djdl" />);

/** The settings row whose label is `label`. */
async function row(label: string): Promise<HTMLElement> {
  const el = await screen.findByText(label, {
    selector: "span.font-bold, label.font-bold",
  });
  return el.closest("[data-align]") as HTMLElement;
}

beforeEach(() => {
  resetCore();
  for (const f of Object.values(fns)) f.mockReset();
  fns.hostedAssets.mockResolvedValue({ assets: ROWS });
  fns.assetUsage.mockResolvedValue(usage());
});
afterEach(cleanup);

describe("Core → Presentation", () => {
  it("draws every slot with its source, status, size, preview and Sizes pending", async () => {
    const { container } = mount();
    const icon = await row("Product icon");
    expect(
      within(icon).getByText("From https://cdn.example.com/icon.png"),
    ).toBeTruthy();
    expect(within(icon).getByText("Ready")).toBeTruthy();
    expect(within(icon).getByText(/512×512/)).toBeTruthy();
    expect(
      within(icon).getByRole("img", { name: "Product icon preview" }),
    ).toHaveProperty("src", `${IMG}/djdl/a/${A}/256.webp`);
    const header = await row("Header");
    expect(within(header).getByText("Uploaded in the console")).toBeTruthy();
    expect(within(header).getByText("Sizes pending")).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "Revert to manifest" }),
    ).toBeTruthy();
    // Revert only for a console claim the manifest names, and then no Delete copy: the server
    // would revert it rather than leave it for the next resync.
    expect(
      within(icon).queryByRole("button", { name: "Revert to manifest" }),
    ).toBeNull();
    expect(
      within(header).queryByRole("button", { name: "Delete copy" }),
    ).toBeNull();
    const shot = await row("Screenshot 1");
    expect(within(shot).getByText("Source gone")).toBeTruthy();
    expect(
      within(shot).getByText(/the source answered that the file is gone/),
    ).toBeTruthy();
    // An empty slot for the next screenshot, and the empty listing icon.
    expect(await row("Screenshot 2")).toBeTruthy();
    expect(
      within(await row("Listing icon")).getByText("Nothing hosted yet."),
    ).toBeTruthy();
    // A release file is listed read-only.
    const other = await row("release-file");
    expect(within(other).queryByText("Upload")).toBeNull();
    expect(
      within(other).queryByRole("button", { name: "Delete copy" }),
    ).toBeNull();
    await expectNoAxeViolations(container);
  });

  it("uploads through mutate and refreshes the slots, the registry, the product and Home's summary", async () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    fns.uploadHostedAsset.mockResolvedValue({
      asset: asset({ origin: "console" }),
    });
    mount();
    const input = await screen.findByLabelText("Replace Product icon");
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "i.png", {
      type: "image/png",
    });
    await userEvent.upload(input, file);
    await waitFor(() => expect(fns.uploadHostedAsset).toHaveBeenCalled());
    expect(fns.uploadHostedAsset).toHaveBeenCalledWith(
      "djdl",
      "presentation.icon",
      file,
      undefined,
    );
    expect(
      await screen.findByText("Product icon: Polaris Key now hosts your file"),
    ).toBeTruthy();
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    for (const k of [
      qk.hostedAssets("djdl"),
      qk.products(),
      qk.product("djdl"),
      qk.summary(),
    ])
      expect(keys).toContain(JSON.stringify(k));
    spy.mockRestore();
  });

  it("refuses a file over the cap before sending it, and words a Worker refusal", async () => {
    mount();
    const input = await screen.findByLabelText("Replace Product icon");
    const big = new File([new Uint8Array(10)], "big.png", {
      type: "image/png",
    });
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    await userEvent.upload(input, big);
    expect(await screen.findByText(/larger than this slot takes/)).toBeTruthy();
    expect(fns.uploadHostedAsset).not.toHaveBeenCalled();
    fns.uploadHostedAsset.mockRejectedValue(
      new ApiError(422, undefined, "asset_refused", undefined, "not-an-image"),
    );
    await userEvent.upload(
      input,
      new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }),
    );
    expect(
      await screen.findByText(
        "The file was refused: the file is not a PNG, JPEG, WebP, GIF or AVIF image.",
      ),
    ).toBeTruthy();
  });

  it("Revert asks first, then returns the slot to the manifest", async () => {
    fns.deleteHostedAsset.mockResolvedValue({
      outcome: "reverted",
      pulling: true,
    });
    mount();
    const header = await row("Header");
    await userEvent.click(
      within(header).getByRole("button", { name: "Revert to manifest" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/pulls art\/header.png again/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revert" }),
    );
    await waitFor(() =>
      expect(fns.deleteHostedAsset).toHaveBeenCalledWith(
        "djdl",
        "listing.header",
        undefined,
      ),
    );
    expect(
      await screen.findByText("Header returned to the manifest"),
    ).toBeTruthy();
  });

  it("Delete copy says a manifest-declared slot is pulled again", async () => {
    fns.deleteHostedAsset.mockResolvedValue({ outcome: "deleted" });
    mount();
    const icon = await row("Product icon");
    await userEvent.click(
      within(icon).getByRole("button", { name: "Delete copy" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/the next resync pulls it again/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete copy" }),
    );
    expect(
      await screen.findByText("Product icon: hosted copy deleted"),
    ).toBeTruthy();
  });
});

describe("the page's words", () => {
  it("names slots and statuses", () => {
    expect(slotLabel("listing.screenshot:3")).toBe("Screenshot 3");
    expect(slotLabel("play:icon", "de-DE")).toBe("play:icon (de-DE)");
    expect(statusOf(asset({ status: "pending" })).label).toBe("Pulling");
    expect(statusOf(asset({ pullPending: true })).label).toBe("Updating");
    expect(statusOf(asset({ status: "failed" })).tone).toBe("danger");
  });
});

describe("Core → Presentation → Hosting and quotas (HA-10)", () => {
  it("Hosting and quotas: usage against each quota, a warning when one is full", async () => {
    const { container } = mount();
    const images = await row("Images");
    expect(
      within(images).getByText(/128 MiB of 512 MiB · 7 files/),
    ).toBeTruthy();
    expect(within(images).queryByText("Quota full")).toBeNull();
    const files = await row("Release files");
    expect(within(files).getByText(/2 GiB of 2 GiB · 3 files/)).toBeTruthy();
    expect(within(files).getByText("Quota full")).toBeTruthy();
    expect(within(files).getByText(/mirroring has stopped/)).toBeTruthy();
    expect(
      within(await row("Media quota")).getByText("Default: 512 MiB"),
    ).toBeTruthy();
    expect(
      within(await row("Release-file quota")).getByText(
        "Set for this product: 2 GiB",
      ),
    ).toBeTruthy();
    // Hosting is on: no deployment warning.
    expect(
      screen.queryByText("Hosted assets are off on this deployment"),
    ).toBeNull();
    await expectNoAxeViolations(container);
  });

  it("says when hosted assets are off on the deployment", async () => {
    fns.assetUsage.mockResolvedValue(usage({ hosting: false }));
    mount();
    expect(
      await screen.findByText("Hosted assets are off on this deployment"),
    ).toBeTruthy();
  });

  it("saves a quota through mutate, with the version it was read at, and Reset returns it to the platform", async () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    fns.saveAssetSetting.mockResolvedValue(usage());
    fns.resetAssetSetting.mockResolvedValue(usage());
    mount();
    const quota = await row("Media quota");
    const input = within(quota).getByLabelText("Media quota in MiB");
    await userEvent.clear(input);
    await userEvent.type(input, "1024");
    await userEvent.click(within(quota).getByRole("button", { name: "Save" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Save", hidden: false }),
    );
    await waitFor(() => expect(fns.saveAssetSetting).toHaveBeenCalled());
    expect(fns.saveAssetSetting).toHaveBeenCalledWith(
      "djdl",
      "assets.quota.mediaBytes",
      { value: 1024 * MiB, expectedVersion: 0 },
    );
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(qk.hostedAssets("djdl")));
    spy.mockRestore();

    const release = await row("Release-file quota");
    await userEvent.click(
      within(release).getByRole("button", { name: "Reset" }),
    );
    expect(
      await screen.findByText(/follows the platform default again: 100 GiB/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Reset" }).at(-1)!,
    );
    await waitFor(() =>
      expect(fns.resetAssetSetting).toHaveBeenCalledWith(
        "djdl",
        "assets.quota.releaseBytes",
        3,
      ),
    );
  });

  it("turning mirroring off asks first", async () => {
    fns.saveAssetSetting.mockResolvedValue(usage());
    mount();
    const mirror = await row("Mirror release files");
    await userEvent.click(within(mirror).getByRole("switch"));
    expect(
      await screen.findByText("Stop mirroring this product's release files?"),
    ).toBeTruthy();
    expect(fns.saveAssetSetting).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Stop mirroring" }),
    );
    await waitFor(() =>
      expect(fns.saveAssetSetting).toHaveBeenCalledWith(
        "djdl",
        "assets.releases.mirror",
        { value: "off", expectedVersion: 0 },
      ),
    );
  });
});
