/**
 * The Release section's pack pages over a mocked admin API (ADMIN.md §6.3.4): Deliverables (the
 * app and two packs; the "not pinned" warning with its next step; a gate that differs from the
 * latest release's signed entitlement), a pack's record (releases with signer and pinned-by
 * links, yank and unyank, the release drawer with variants, deltas and files, the delivery gate,
 * the file browser), an app release's content on its record, and Content keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DelegationsResponse,
  DeliverablesResponse,
  DeliveryAccess,
  PackFilesResponse,
  PackReleasesResponse,
  ProductDetail,
  ReleaseChannelsResponse,
  ReleaseDto,
  ReleaseStoreResponse,
} from "../src/api.js";
import { sha } from "./releaseFixture.js";
import {
  expectNoAxeViolations,
  hashQuery,
  mountAt,
  pending,
} from "./releaseHarness.js";

const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const deliverables = vi.fn<(slug: string) => Promise<DeliverablesResponse>>();
const delegations = vi.fn<(slug: string) => Promise<DelegationsResponse>>();
const packReleases =
  vi.fn<(slug: string, id: string) => Promise<PackReleasesResponse>>();
const packFiles =
  vi.fn<
    (
      slug: string,
      id: string,
      releaseId: string,
      variant: string,
    ) => Promise<PackFilesResponse>
  >();
const releases = vi.fn<(slug: string) => Promise<ReleaseStoreResponse>>();
const releaseChannels =
  vi.fn<(slug: string) => Promise<ReleaseChannelsResponse>>();
const deliveryAccess = vi.fn<(slug: string) => Promise<DeliveryAccess>>();
const saveDeliveryAccess = vi.fn();
const yankRelease = vi.fn();
const unyankRelease = vi.fn();
vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    product: (slug: string) => product(slug),
    deliverables: (slug: string) => deliverables(slug),
    delegations: (slug: string) => delegations(slug),
    packReleases: (slug: string, id: string) => packReleases(slug, id),
    packFiles: (slug: string, id: string, releaseId: string, variant: string) =>
      packFiles(slug, id, releaseId, variant),
    releases: (slug: string) => releases(slug),
    releaseChannels: (slug: string) => releaseChannels(slug),
    deliveryAccess: (slug: string) => deliveryAccess(slug),
    saveDeliveryAccess: (...a: unknown[]) => saveDeliveryAccess(...a),
    yankRelease: (...a: unknown[]) => yankRelease(...a),
    unyankRelease: (...a: unknown[]) => unyankRelease(...a),
  },
}));

const { DeliverablesPage } =
  await import("../src/console/pages/release/DeliverablesPage.js");
const { PackRecord } =
  await import("../src/console/pages/release/PackRecord.js");
const { ContentKeysPage } =
  await import("../src/console/pages/release/ContentKeysPage.js");
const { ReleaseRecord } =
  await import("../src/console/pages/release/ReleaseRecord.js");

const SLUG = "diceroll";
const CORE = "diceroll.core3d";
const MUSIC = "diceroll.music";
const CORE_14 = sha(140);

const PRODUCT = {
  slug: SLUG,
  name: "Diceroll",
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
    identity: { enabled: true },
  },
} as unknown as ProductDetail;

const LIST: DeliverablesResponse = {
  gateKnown: true,
  deliverables: [
    {
      id: "app",
      kind: "app",
      type: null,
      declared: true,
      binding: null,
      required: null,
      baseline: null,
      delivery: null,
      variantKeys: [],
      assertedEntitlement: null,
      gate: null,
      latest: {
        releaseId: "app@1.5.0",
        version: "1.5.0",
        seq: 15,
        publishedAt: 1_720_000_000,
        yanked: false,
        entitlement: null,
      },
      releaseCount: 3,
      pinnedByAppReleases: null,
    },
    {
      id: CORE,
      kind: "pack",
      type: "godot.pck",
      declared: true,
      binding: "pinned",
      required: true,
      baseline: "embedded",
      delivery: "essential",
      variantKeys: ["texture=etc2", "texture=s3tc"],
      assertedEntitlement: null,
      gate: "vip",
      latest: {
        releaseId: `${CORE}@1.4.0`,
        version: "1.4.0",
        seq: 12,
        publishedAt: 1_719_000_000,
        yanked: true,
        entitlement: null,
      },
      releaseCount: 2,
      pinnedByAppReleases: 2,
    },
    {
      id: MUSIC,
      kind: "pack",
      type: "files.tree",
      declared: true,
      binding: "pinned",
      required: false,
      baseline: "none",
      delivery: "on-demand",
      variantKeys: [""],
      assertedEntitlement: null,
      gate: null,
      latest: null,
      releaseCount: 0,
      pinnedByAppReleases: 0,
    },
  ],
};

const RELEASES: PackReleasesResponse = {
  deliverable: CORE,
  releases: [
    {
      releaseId: `${CORE}@1.4.0`,
      version: "1.4.0",
      seq: 12,
      channel: "stable",
      publishedAt: 1_719_000_000,
      yank: { reason: "broken mounts", at: 1_719_500_000, by: "admin:u1" },
      recordSha256: CORE_14,
      formatVersion: 1,
      entitlement: null,
      signer: {
        kind: "delegated",
        delegation: sha(900),
        scope: "diceroll",
        seq: 2,
      },
      variants: [
        {
          variantKey: "texture=s3tc",
          variant: { texture: "s3tc" },
          engine: "godot-4.7",
          payload: { size: 3 * 1024 * 1024, sha256: sha(1) },
          fullBytes: 2 * 1024 * 1024,
          indexBytes: 900,
          deltas: [
            {
              scope: "payload",
              method: "zstd-patch-from",
              from: sha(2),
              fromVersion: "1.0.0",
              bytes: 40 * 1024,
              memBytes: 6 * 1024 * 1024,
            },
          ],
        },
      ],
      pinnedBy: [
        {
          appReleaseId: "app@1.5.0",
          appVersion: "1.5.0",
          appYank: null,
          required: true,
          delivery: "essential",
          recordSha256: CORE_14,
        },
        {
          appReleaseId: "app@1.4.1",
          appVersion: "1.4.1",
          appYank: { reason: "crash", at: 1_719_600_000, by: "admin:u1" },
          required: true,
          delivery: "essential",
          recordSha256: CORE_14,
        },
      ],
    },
    {
      releaseId: `${CORE}@1.0.0`,
      version: "1.0.0",
      seq: 1,
      channel: "stable",
      publishedAt: 1_710_000_000,
      yank: null,
      recordSha256: sha(100),
      formatVersion: 1,
      entitlement: null,
      signer: { kind: "release", kid: "diceroll-release-2026" },
      variants: [],
      pinnedBy: [],
    },
  ],
};

const FILES: PackFilesResponse = {
  deliverable: CORE,
  releaseId: `${CORE}@1.4.0`,
  variant: "texture=s3tc",
  total: 3,
  files: [
    {
      path: "assets/core/a.bin",
      size: 100,
      sha256: sha(7),
      offset: 10,
      blob: { sha256: sha(7), bytes: 100, codec: "none" },
    },
    {
      path: "assets/core/b.bin",
      size: 50,
      sha256: sha(8),
      offset: 120,
      blob: { sha256: sha(8), bytes: 50, codec: "none" },
    },
    {
      path: "readme.txt",
      size: 5,
      sha256: sha(9),
      offset: 170,
      blob: { sha256: sha(9), bytes: 5, codec: "none" },
    },
  ],
};

const ACCESS: DeliveryAccess = {
  modes: ["public", "authenticated", "licensed", "entitled"],
  app: { deliverableId: "app", mode: "licensed", source: "manifest" },
  deliverables: [
    {
      deliverableId: CORE,
      mode: "entitled",
      entitlement: "vip",
      source: "admin",
      modifiedAt: 1_719_000_000,
    },
  ],
};

beforeEach(() => {
  product.mockReset().mockResolvedValue({ product: PRODUCT });
  deliverables.mockReset().mockResolvedValue(LIST);
  delegations.mockReset().mockResolvedValue({ delegations: [] });
  packReleases.mockReset().mockResolvedValue(RELEASES);
  packFiles.mockReset().mockResolvedValue(FILES);
  releases
    .mockReset()
    .mockResolvedValue({ releases: [], channels: [], floors: [] });
  releaseChannels.mockReset().mockResolvedValue({ deliverables: [] });
  deliveryAccess.mockReset().mockResolvedValue(ACCESS);
  saveDeliveryAccess.mockReset().mockResolvedValue(ACCESS);
  yankRelease.mockReset().mockResolvedValue({ ok: true });
  unyankRelease.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountList(hash = `#/p/${SLUG}/release/deliverables`) {
  return mountAt(hash, <DeliverablesPage slug={SLUG} />);
}

function mountPack(id: string, tab?: string, query = "") {
  return mountAt(
    `#/p/${SLUG}/release/deliverables/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}${query}`,
    <PackRecord slug={SLUG} id={id} tab={tab} />,
  );
}

async function deliverableRow(name: string): Promise<HTMLElement> {
  return (await screen.findByRole("link", { name })).closest("tr")!;
}

describe("Deliverables (T2, DLV-1 to DLV-5)", () => {
  it("lists the app and both packs; the app links to Releases, a pack to its record", async () => {
    mountList();
    const appRow = await deliverableRow("App");
    expect(
      within(appRow).getByRole("link", { name: "App" }).getAttribute("href"),
    ).toBe(`#/p/${SLUG}/release/releases`);
    expect(within(appRow).getByText("1.5.0")).toBeTruthy();

    const coreRow = await deliverableRow(CORE);
    expect(
      within(coreRow).getByRole("link", { name: CORE }).getAttribute("href"),
    ).toBe(`#/p/${SLUG}/release/deliverables/${encodeURIComponent(CORE)}`);
    expect(within(coreRow).getByText("Pack")).toBeTruthy();
    expect(within(coreRow).getByText("Pinned")).toBeTruthy();
    expect(within(coreRow).getByText("Yanked")).toBeTruthy();
    expect(within(coreRow).getByText("2 app releases")).toBeTruthy();
    // The gate links to where it is set (DLV-3) and flags what the latest release signed.
    const gate = within(coreRow).getByRole("link", { name: "vip" });
    expect(gate.getAttribute("href")).toBe(
      `#/p/${SLUG}/distribution/access?deliverable=${encodeURIComponent(CORE)}`,
    );
    expect(within(coreRow).getByText("Latest signed no gate")).toBeTruthy();

    const musicRow = await deliverableRow(MUSIC);
    expect(within(musicRow).getByText("None yet")).toBeTruthy();
    expect(
      within(musicRow).getByRole("link", { name: "Ungated" }),
    ).toBeTruthy();
  });

  it("starts the low-value columns hidden, one tick away in Columns (DLV-2)", async () => {
    window.localStorage.clear();
    mountList();
    await deliverableRow(CORE);
    expect(screen.queryByRole("columnheader", { name: /Type/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    for (const c of ["Type", "Required", "Baseline", "Delivery"]) {
      const box = (await screen.findByRole("checkbox", {
        name: c,
      })) as HTMLInputElement;
      expect(box.checked).toBe(false);
    }
    await userEvent.click(screen.getByRole("checkbox", { name: "Type" }));
    expect(screen.getByRole("columnheader", { name: /Type/ })).toBeTruthy();
    window.localStorage.clear();
  });

  it("warns about a pack no app release pins, with the next step (DLV-4)", async () => {
    mountList();
    const musicRow = await deliverableRow(MUSIC);
    expect(within(musicRow).getByText("Not pinned")).toBeTruthy();
    await userEvent.click(
      within(musicRow).getByRole("button", {
        name: `What to do about ${MUSIC}`,
      }),
    );
    expect(
      await screen.findByText(/Pin it from an app release's manifest/),
    ).toBeTruthy();
    const coreRow = await deliverableRow(CORE);
    expect(within(coreRow).queryByText("Not pinned")).toBeNull();
  });

  it("does not flag a compatible pack without pins (it ships through the resolved sets)", async () => {
    deliverables.mockResolvedValue({
      ...LIST,
      deliverables: LIST.deliverables.map((d) =>
        d.id === MUSIC ? { ...d, binding: "compatible" } : d,
      ),
    });
    mountList();
    const musicRow = await deliverableRow(MUSIC);
    expect(within(musicRow).queryByText("Not pinned")).toBeNull();
    expect(within(musicRow).getByText("None (resolved sets)")).toBeTruthy();
  });

  it("round-trips its facets through the URL", async () => {
    mountList(`#/p/${SLUG}/release/deliverables?kind=pack`);
    await deliverableRow(CORE);
    expect(screen.queryByRole("link", { name: "App" })).toBeNull();
    expect(hashQuery().get("kind")).toBe("pack");
  });

  it("hides the gates while Distribution is off", async () => {
    deliverables.mockResolvedValue({ ...LIST, gateKnown: false });
    mountList();
    expect(
      await screen.findByText(/Distribution is off for this product/),
    ).toBeTruthy();
    expect(screen.queryByText("vip")).toBeNull();
  });

  it("shows skeletons while loading, the load error with Retry, and the first-run state", async () => {
    deliverables.mockReturnValueOnce(pending());
    const { container } = mountList();
    await screen.findByRole("heading", { level: 1, name: /Deliverables/ });
    expect(container.querySelectorAll("tbody tr[aria-hidden]")).toHaveLength(5);
    cleanup();
    deliverables
      .mockReset()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ gateKnown: true, deliverables: [] });
    mountList();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No deliverables yet")).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mountList();
    await deliverableRow(CORE);
    await expectNoAxeViolations(container);
  });
});

describe("a pack's record (T3, PKD-1 to PKD-8)", () => {
  async function releaseRow(version: string): Promise<HTMLElement> {
    return (
      await screen.findByRole("link", {
        name: new RegExp(`^${version.replace(/\./g, "\\.")}( Yanked)?$`),
      })
    ).closest("tr")!;
  }

  it("heads the record with the declaration, breadcrumb and gate", async () => {
    mountPack(CORE);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(
      CORE,
    );
    expect(screen.getByText("godot.pck")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("2 app releases")).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Breadcrumb" }))
        .getByRole("link", { name: "Deliverables" })
        .getAttribute("href"),
    ).toBe(`#/p/${SLUG}/release/deliverables`);
  });

  it("lists releases with signer and pinned-by links; a yanked release keeps its pins (PKD-4, PKD-5, PKD-8)", async () => {
    mountPack(CORE);
    const newest = await releaseRow("1.4.0");
    expect(within(newest).getByText("Yanked")).toBeTruthy();
    const pins = within(newest).getByRole("list", { name: "Pinned by" });
    expect(
      within(pins).getByRole("link", { name: "1.5.0" }).getAttribute("href"),
    ).toBe(`#/p/${SLUG}/release/releases/${encodeURIComponent("app@1.5.0")}`);
    expect(within(pins).getByText("(yanked)")).toBeTruthy();
    // A delegated content key signed it.
    expect(within(newest).getByText(/diceroll\.\* #2/)).toBeTruthy();
    const oldest = await releaseRow("1.0.0");
    expect(within(oldest).getByText("No app release")).toBeTruthy();
    expect(within(oldest).getByText("diceroll-release-2026")).toBeTruthy();
    expect(packReleases).toHaveBeenCalledWith(SLUG, CORE);
  });

  it("yanks a pack release (danger) and unyanks one (caution) from the row menu (PKD-1)", async () => {
    mountPack(CORE);
    const oldest = await releaseRow("1.0.0");
    await userEvent.click(
      within(oldest).getByRole("button", { name: "Actions for 1.0.0" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Yank…" }),
    );
    let dialog = await screen.findByRole("alertdialog");
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Reason/ }),
      "corrupt textures",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Yank 1.0.0" }),
    );
    await waitFor(() =>
      expect(yankRelease).toHaveBeenCalledWith(
        SLUG,
        `${CORE}@1.0.0`,
        "corrupt textures",
      ),
    );
    await waitFor(() =>
      expect(packReleases.mock.calls.length).toBeGreaterThan(1),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    const newest = await releaseRow("1.4.0");
    await userEvent.click(
      within(newest).getByRole("button", { name: "Actions for 1.4.0" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Unyank…" }),
    );
    dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unyank 1.4.0" }),
    );
    await waitFor(() =>
      expect(unyankRelease).toHaveBeenCalledWith(SLUG, `${CORE}@1.4.0`),
    );
  });

  it("opens a release in a drawer: variants as cards with axes, sizes and the delta menu (PKD-6)", async () => {
    mountPack(
      CORE,
      "releases",
      `?release=${encodeURIComponent(`${CORE}@1.4.0`)}`,
    );
    const drawer = await screen.findByRole("dialog");
    const variant = within(drawer).getByRole("region", {
      name: "Variant texture=s3tc",
    });
    expect(within(variant).getByText("texture: s3tc")).toBeTruthy();
    expect(within(variant).getByText("Engine godot-4.7")).toBeTruthy();
    expect(within(variant).getByText("3.1 MB")).toBeTruthy();
    expect(within(variant).getByText("2.1 MB")).toBeTruthy();
    expect(within(variant).getByText("payload")).toBeTruthy();
    expect(within(variant).getByText("1.0.0")).toBeTruthy();
    expect(within(variant).getByText(/41 kB/)).toBeTruthy();
    expect(within(drawer).getByText(/broken mounts/)).toBeTruthy();
  });

  it("reads a variant's files on demand, as a searchable tree (PKD-7)", async () => {
    mountPack(
      CORE,
      "releases",
      `?release=${encodeURIComponent(`${CORE}@1.4.0`)}`,
    );
    const drawer = await screen.findByRole("dialog");
    expect(packFiles).not.toHaveBeenCalled();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Show files" }),
    );
    const tree = await within(drawer).findByRole("group", {
      name: "Files of texture=s3tc",
    });
    expect(packFiles).toHaveBeenCalledWith(
      SLUG,
      CORE,
      `${CORE}@1.4.0`,
      "texture=s3tc",
    );
    expect(within(drawer).getByText("3 files")).toBeTruthy();
    // Directories first, collapsed; files at the root show.
    expect(within(tree).getByText("readme.txt")).toBeTruthy();
    expect(within(tree).queryByText("a.bin")).toBeNull();
    await userEvent.click(
      within(tree).getByRole("button", { name: /assets\// }),
    );
    await userEvent.click(within(tree).getByRole("button", { name: /core\// }));
    expect(within(tree).getByText("a.bin")).toBeTruthy();
    // Search flattens to matching paths.
    await userEvent.type(
      within(drawer).getByRole("textbox", { name: "Search files" }),
      "b.bin",
    );
    expect(within(tree).getByText("assets/core/b.bin")).toBeTruthy();
    expect(within(tree).queryByText("readme.txt")).toBeNull();
    expect(within(drawer).getByText("1 of 3 files match")).toBeTruthy();
  });

  it("retries a failed files index (PKD-7)", async () => {
    packFiles
      .mockReset()
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(FILES);
    mountPack(CORE, "files");
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("readme.txt")).toBeTruthy();
  });

  it("edits the delivery gate on the Delivery tab (DLV-3)", async () => {
    mountPack(CORE, "delivery");
    const form = await screen.findByRole("form", {
      name: `${CORE} delivery gate`,
    });
    const ent = within(form).getByRole("textbox", { name: /Entitlement/ });
    expect((ent as HTMLInputElement).value).toBe("vip");
    await userEvent.clear(ent);
    await userEvent.type(ent, "hd-textures");
    await userEvent.click(await screen.findByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(saveDeliveryAccess).toHaveBeenCalledWith(SLUG, {
        deliverable: CORE,
        mode: "entitled",
        entitlement: "hd-textures",
      }),
    );
    await waitFor(() =>
      expect(deliverables.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("flags an unpinned pack on its record too, and its empty releases", async () => {
    packReleases.mockResolvedValue({ deliverable: MUSIC, releases: [] });
    mountPack(MUSIC);
    expect(await screen.findByText("Not pinned")).toBeTruthy();
    expect(await screen.findByText("No releases yet")).toBeTruthy();
  });

  it("names an unknown pack instead of rendering nothing (PKD-2)", async () => {
    mountPack("diceroll.nope");
    expect(
      await screen.findByText("No pack diceroll.nope in Diceroll"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "All deliverables" })
        .getAttribute("href"),
    ).toBe(`#/p/${SLUG}/release/deliverables`);
  });

  it("shows the releases load error with Retry (PKD-2)", async () => {
    packReleases
      .mockReset()
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(RELEASES);
    mountPack(CORE);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await releaseRow("1.4.0")).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mountPack(CORE);
    await releaseRow("1.4.0");
    await expectNoAxeViolations(container);
  });
});

describe("an app release's content, on its record", () => {
  const APP_RELEASE: ReleaseDto = {
    releaseId: "app@1.5.0",
    version: "1.5.0",
    title: null,
    publishedAt: 1_720_000_000,
    sourceUrl: null,
    status: "ok",
    artifacts: [],
    deliverable: "app",
    seq: 15,
    channel: "stable",
    yank: null,
    contentApi: 3,
    pins: [
      {
        pack: CORE,
        packReleaseId: `${CORE}@1.4.0`,
        packVersion: "1.4.0",
        packYank: { reason: "broken mounts", at: 1, by: "admin:u1" },
        required: true,
        delivery: "essential",
        recordSha256: CORE_14,
      },
    ],
    builds: [
      {
        buildId: "ios-arm64",
        platform: "ios",
        arch: "arm64",
        format: "ipa",
        buildNumber: "1041",
        minOs: null,
        embeds: [CORE],
      },
      {
        buildId: "web-wasm32",
        platform: "web",
        arch: "wasm32",
        format: "zip",
        buildNumber: null,
        minOs: null,
        embeds: [],
      },
    ],
  };

  it("shows its contentApi and pins on the Packs tab, and each build's embeds", async () => {
    releases.mockResolvedValue({
      releases: [APP_RELEASE],
      channels: [],
      floors: [],
    });
    mountAt(
      `#/p/${SLUG}/release/releases/app%401.5.0/packs`,
      <ReleaseRecord slug={SLUG} id="app@1.5.0" tab="packs" />,
    );
    expect(await screen.findByText(/Content API/)).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByRole("link", { name: CORE })).toBeTruthy();
    expect(screen.getByRole("link", { name: "1.4.0" })).toBeTruthy();
    expect(screen.getByText("Yanked")).toBeTruthy();
    cleanup();
    mountAt(
      `#/p/${SLUG}/release/releases/app%401.5.0`,
      <ReleaseRecord slug={SLUG} id="app@1.5.0" tab={undefined} />,
    );
    const ios = await screen.findByRole("region", { name: "Build ios-arm64" });
    expect(within(ios).getByText(/Embeds/)).toBeTruthy();
    expect(within(ios).getByRole("link", { name: CORE })).toBeTruthy();
    const web = screen.getByRole("region", { name: "Build web-wasm32" });
    expect(within(web).queryByText(/Embeds/)).toBeNull();
  });

  it("says a release without content pins nothing", async () => {
    const { contentApi: _c, pins: _p, ...legacy } = APP_RELEASE;
    releases.mockResolvedValue({
      releases: [legacy],
      channels: [],
      floors: [],
    });
    mountAt(
      `#/p/${SLUG}/release/releases/app%401.5.0/packs`,
      <ReleaseRecord slug={SLUG} id="app@1.5.0" tab="packs" />,
    );
    expect(await screen.findByText("No packs pinned")).toBeTruthy();
  });
});

describe("Content keys (P4-19, CKY-1 to CKY-3)", () => {
  const KEYS: DelegationsResponse = {
    delegations: [
      {
        sha256: sha(900),
        scope: "diceroll.events",
        types: ["files.tree", "godot.pck"],
        effectiveTypes: ["files.tree"],
        seq: 2,
        issuedAt: 1_719_000_000,
        expiresAt: 4_102_444_800,
        status: "active",
        origin: "submit",
        signedBy: "diceroll-release-2026",
        keyFingerprint: "ab".repeat(32),
        releaseCount: 3,
        revocation: null,
      },
      {
        sha256: sha(901),
        scope: "diceroll.l10n",
        types: ["l10n.table"],
        effectiveTypes: ["l10n.table"],
        seq: 1,
        issuedAt: 1_700_000_000,
        expiresAt: 1_710_000_000,
        status: "revoked",
        origin: "submit",
        signedBy: "diceroll-release-2026",
        keyFingerprint: "cd".repeat(32),
        releaseCount: 0,
        revocation: {
          sha256: sha(902),
          kid: "diceroll-release-2026",
          reason: "key leaked",
          issuedAt: 1_705_000_000,
        },
      },
    ],
  };

  function mountKeys(query = "") {
    return mountAt(
      `#/p/${SLUG}/release/content-keys${query}`,
      <ContentKeysPage slug={SLUG} />,
    );
  }

  it("lists each delegation read-only: scope, types, status, window, signer, key and releases", async () => {
    delegations.mockResolvedValue(KEYS);
    mountKeys();
    expect(
      await screen.findByRole("heading", { level: 1, name: /Content keys/ }),
    ).toBeTruthy();
    const row = (await screen.findByText("diceroll.events.*")).closest("tr")!;
    expect(within(row).getByText("files.tree")).toBeTruthy();
    // What was delegated vs what still applies (CKY-3).
    expect(
      within(row).getByText("Delegated: files.tree, godot.pck"),
    ).toBeTruthy();
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(within(row).getByText(/^Expires in/)).toBeTruthy();
    expect(within(row).getByText("diceroll-release-2026")).toBeTruthy();
    // The fingerprint is a Hash with copy (CKY-1).
    expect(
      within(row).getByRole("button", { name: "Copy key fingerprint" }),
    ).toBeTruthy();
    // Releases link to the scope's deliverables.
    expect(
      within(row).getByRole("link", { name: /3/ }).getAttribute("href"),
    ).toBe(`#/p/${SLUG}/release/deliverables?q=diceroll.events`);
    const revoked = screen.getByText("diceroll.l10n.*").closest("tr")!;
    expect(within(revoked).getByText("Revoked")).toBeTruthy();
    expect(within(revoked).getByText(/key leaked/)).toBeTruthy();
    expect(within(revoked).getByText(/^Expired/)).toBeTruthy();
    // No write controls: delegating and revoking are CI acts.
    expect(
      screen.queryByRole("button", { name: /revoke|delegate/i }),
    ).toBeNull();
  });

  it("filters by status through the URL (CKY-3)", async () => {
    delegations.mockResolvedValue(KEYS);
    mountKeys("?status=revoked");
    expect(await screen.findByText("diceroll.l10n.*")).toBeTruthy();
    expect(screen.queryByText("diceroll.events.*")).toBeNull();
  });

  it("explains content keys when there are none, and shows errors with Retry", async () => {
    mountKeys();
    expect(await screen.findByText("No content keys")).toBeTruthy();
    cleanup();
    delegations
      .mockReset()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce(KEYS);
    mountKeys();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("diceroll.events.*")).toBeTruthy();
  });

  it("passes axe", async () => {
    delegations.mockResolvedValue(KEYS);
    const { container } = mountKeys();
    await screen.findByText("diceroll.events.*");
    await expectNoAxeViolations(container);
  });
});
