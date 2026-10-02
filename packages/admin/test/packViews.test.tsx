/**
 * P4-09 — the console's pack views over a mocked admin API: the Deliverables tab (the app and two
 * packs with kind, type, binding and required; the "not pinned by any app release" flag; a gate
 * that differs from the latest release's signed entitlement), a pack's page (each release's
 * "pinned by", a yanked release keeping its pins, sizes and the delta menu) and an app release's
 * content (contentApi, pins, each build's embeds).
 */

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
  DeliverablesResponse,
  PackFilesResponse,
  PackReleasesResponse,
  ReleaseDto,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { sha } from "./releaseFixture.js";

const deliverables = vi.fn<(slug: string) => Promise<DeliverablesResponse>>();
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
vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    deliverables: (slug: string) => deliverables(slug),
    packReleases: (slug: string, id: string) => packReleases(slug, id),
    packFiles: (slug: string, id: string, releaseId: string, variant: string) =>
      packFiles(slug, id, releaseId, variant),
  },
}));

const { Deliverables } = await import("../src/views/releases/Deliverables.js");
const { DeliverableDetail } =
  await import("../src/views/releases/DeliverableDetail.js");
const { ReleaseBuilds } =
  await import("../src/views/releases/ReleaseBuilds.js");

const SLUG = "diceroll";
const CORE = "diceroll.core3d";
const MUSIC = "diceroll.music";
const CORE_14 = sha(140);

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
      variants: [],
      pinnedBy: [],
    },
  ],
};

beforeEach(() => {
  resetCache();
  deliverables.mockReset().mockResolvedValue(LIST);
  packReleases.mockReset().mockResolvedValue(RELEASES);
  packFiles.mockReset();
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("Deliverables tab", () => {
  it("lists the app and both packs with kind, type, binding and required", async () => {
    render(<Deliverables slug={SLUG} />);
    const appCell = await screen.findByText("app", {
      selector: "span.font-mono",
    });
    const appRow = appCell.closest("tr")!;
    expect(within(appRow).getByText("1.5.0")).toBeTruthy();

    const coreRow = screen
      .getByRole("button", { name: `Open pack ${CORE}` })
      .closest("tr")!;
    expect(within(coreRow).getByText("pack")).toBeTruthy();
    expect(within(coreRow).getByText("godot.pck")).toBeTruthy();
    expect(within(coreRow).getByText("pinned")).toBeTruthy();
    expect(within(coreRow).getByText("required")).toBeTruthy();
    expect(within(coreRow).getByText("embedded")).toBeTruthy();
    expect(within(coreRow).getByText("essential")).toBeTruthy();
    expect(within(coreRow).getByText("yanked")).toBeTruthy();
    expect(within(coreRow).getByText("2 app releases")).toBeTruthy();
    // The gate an operator set differs from what the latest release signed.
    expect(within(coreRow).getByText("vip")).toBeTruthy();
    expect(
      within(coreRow).getByText("latest release signed no gate"),
    ).toBeTruthy();

    const musicRow = screen
      .getByRole("button", { name: `Open pack ${MUSIC}` })
      .closest("tr")!;
    expect(within(musicRow).getByText("files.tree")).toBeTruthy();
    expect(within(musicRow).getByText("optional")).toBeTruthy();
    expect(within(musicRow).getByText("on-demand")).toBeTruthy();
    expect(within(musicRow).getByText("none yet")).toBeTruthy();
  });

  it("flags a pack no app release pins", async () => {
    render(<Deliverables slug={SLUG} />);
    const musicRow = (
      await screen.findByRole("button", { name: `Open pack ${MUSIC}` })
    ).closest("tr")!;
    expect(
      within(musicRow).getByText("Not pinned by any app release"),
    ).toBeTruthy();
    const coreRow = screen
      .getByRole("button", { name: `Open pack ${CORE}` })
      .closest("tr")!;
    expect(
      within(coreRow).queryByText("Not pinned by any app release"),
    ).toBeNull();
  });

  it("opens a pack's page by its id", async () => {
    render(<Deliverables slug={SLUG} />);
    await userEvent.click(
      await screen.findByRole("button", { name: `Open pack ${CORE}` }),
    );
    expect(window.location.hash).toBe(
      `#/p/${SLUG}/deliverables/${encodeURIComponent(CORE)}`,
    );
  });

  it("hides the gates while Distribution is off", async () => {
    deliverables.mockResolvedValue({ ...LIST, gateKnown: false });
    render(<Deliverables slug={SLUG} />);
    expect(
      await screen.findByText(/Distribution is off for this product/),
    ).toBeTruthy();
    expect(screen.queryByText("vip")).toBeNull();
  });

  it("shows the load error with a retry", async () => {
    deliverables.mockRejectedValue(new Error("boom"));
    render(<Deliverables slug={SLUG} />);
    expect(
      await screen.findByText("Couldn’t load the deliverables"),
    ).toBeTruthy();
  });
});

describe("a pack's page", () => {
  it("shows every app release that pins each release; a yanked release keeps its pins", async () => {
    render(<DeliverableDetail slug={SLUG} id={CORE} />);
    const newest = (await screen.findByText("1.4.0")).closest("tr")!;
    expect(within(newest).getByText("Yanked: broken mounts")).toBeTruthy();
    const pins = within(newest).getByRole("list", { name: "Pinned by" });
    expect(within(pins).getByText("app 1.5.0")).toBeTruthy();
    expect(within(pins).getByText("app 1.4.1")).toBeTruthy();
    // An app release that is itself yanked is marked.
    expect(within(pins).getByText("(yanked)")).toBeTruthy();

    const oldest = screen
      .getByText("1.0.0", { selector: "span" })
      .closest("tr")!;
    expect(within(oldest).getByText("no app release")).toBeTruthy();
    expect(packReleases).toHaveBeenCalledWith(SLUG, CORE);
  });

  it("shows the declaration with its pin count", async () => {
    render(<DeliverableDetail slug={SLUG} id={CORE} />);
    expect(await screen.findByText("Declaration")).toBeTruthy();
    expect(screen.getByText("texture=etc2, texture=s3tc")).toBeTruthy();
    expect(screen.getByText("2 app releases")).toBeTruthy();
  });

  it("flags an unpinned pack on its page too", async () => {
    packReleases.mockResolvedValue({ deliverable: MUSIC, releases: [] });
    render(<DeliverableDetail slug={SLUG} id={MUSIC} />);
    expect(
      await screen.findByText("Not pinned by any app release"),
    ).toBeTruthy();
    expect(await screen.findByText("No releases yet")).toBeTruthy();
  });

  it("expands a release into its variants: payload, full download and the delta menu", async () => {
    render(<DeliverableDetail slug={SLUG} id={CORE} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Show variants of 1.4.0" }),
    );
    const variants = screen.getByLabelText("Variants of 1.4.0");
    expect(within(variants).getByText("texture=s3tc")).toBeTruthy();
    expect(within(variants).getByText("godot-4.7")).toBeTruthy();
    expect(within(variants).getByText("3.0 MB")).toBeTruthy();
    expect(within(variants).getByText("2.0 MB")).toBeTruthy();
    expect(within(variants).getByText("payload")).toBeTruthy();
    expect(within(variants).getByText("1.0.0")).toBeTruthy();
    expect(within(variants).getByText(/40 KB/)).toBeTruthy();
  });

  it("reads a variant's files on demand, one index per request", async () => {
    packFiles.mockResolvedValue({
      deliverable: CORE,
      releaseId: `${CORE}@1.4.0`,
      variant: "texture=s3tc",
      total: 2,
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
      ],
    });
    render(<DeliverableDetail slug={SLUG} id={CORE} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Show variants of 1.4.0" }),
    );
    expect(packFiles).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Show files of texture=s3tc in 1.4.0",
      }),
    );
    const list = await screen.findByRole("list", {
      name: "Files of texture=s3tc",
    });
    expect(within(list).getByText("assets/core/a.bin")).toBeTruthy();
    expect(within(list).getByText("assets/core/b.bin")).toBeTruthy();
    expect(screen.getByText("2 files")).toBeTruthy();
    expect(packFiles).toHaveBeenCalledWith(
      SLUG,
      CORE,
      `${CORE}@1.4.0`,
      "texture=s3tc",
    );
  });

  it("shows the load error", async () => {
    packReleases.mockRejectedValue(new Error("nope"));
    render(<DeliverableDetail slug={SLUG} id={CORE} />);
    await waitFor(() =>
      expect(screen.getByText("Couldn’t load this pack")).toBeTruthy(),
    );
  });
});

describe("an app release's content", () => {
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

  it("shows its contentApi, its pins and each build's embeds", () => {
    render(<ReleaseBuilds release={APP_RELEASE} />);
    expect(screen.getByText(/Content API 3 · Pins \(1\)/)).toBeTruthy();
    const pins = screen.getByRole("list", { name: "Pinned packs" });
    expect(within(pins).getByText(CORE)).toBeTruthy();
    expect(within(pins).getByText("1.4.0")).toBeTruthy();
    expect(within(pins).getByText("yanked")).toBeTruthy();
    expect(within(pins).getByText("required")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Embeds" })).toBeTruthy();
    const ios = screen.getByText("ios-arm64").closest("tr")!;
    expect(within(ios).getByText(CORE)).toBeTruthy();
    const web = screen.getByText("web-wasm32").closest("tr")!;
    expect(within(web).getByText("none")).toBeTruthy();
  });

  it("renders nothing pack-related for a release without content", () => {
    const { contentApi: _c, pins: _p, ...legacy } = APP_RELEASE;
    render(
      <ReleaseBuilds
        release={{
          ...legacy,
          builds: legacy.builds.map(({ embeds: _e, ...b }) => b),
        }}
      />,
    );
    expect(screen.queryByText(/Content API/)).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Embeds" })).toBeNull();
  });
});
