/**
 * Update → Feed (admin chunk 9): Update settings minus delivery access (now Distribution →
 * Access). One form per section (UPS-1, UPS-6), owner badges with Revert to manifest only while
 * the console owns a block (UPS-7), the operator-only artifact policy with its L2 confirmation,
 * and the endpoint URLs. Replaces `updateSettings.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import {
  apiError,
  bootWith,
  FEED,
  P,
  RELEASES,
  writes,
} from "./distributionFixture.js";
import {
  endpointRows,
  shippedPlatforms,
  updaterNote,
} from "../src/console/sections/update/pages/UpdateChannelsPage.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const HASH = "#/p/djdl/update/feed";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function section(name: string): Promise<HTMLElement> {
  return screen.findByRole("region", { name });
}

async function save(name: string): Promise<void> {
  const bar = await screen.findByRole("region", {
    name: `Unsaved changes in ${name}`,
  });
  await userEvent.click(
    within(bar).getByRole("button", { name: "Save changes" }),
  );
}

describe("Update → Feed", () => {
  it("renders the stored values", async () => {
    bootWith(HASH);
    const access = await section("Metadata access");
    expect(
      screen.getByRole("heading", { level: 1, name: "Feed" }),
    ).toBeTruthy();
    expect(
      within(access)
        .getByRole("radio", { name: /Public/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const compat = await section("Compatibility window");
    expect(
      (within(compat).getByLabelText(/Lowest supported/) as HTMLInputElement)
        .value,
    ).toBe("1.0.0");
    expect(
      (within(compat).getByLabelText(/Highest supported/) as HTMLInputElement)
        .value,
    ).toBe("2.99.0");
    const policy = await section("Artifact policy");
    expect(
      (
        within(policy).getByLabelText(
          /Minimum macOS version/,
        ) as HTMLInputElement
      ).value,
    ).toBe("13.0");
    expect(
      within(policy).getByRole("switch").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("offers entitled as a metadata mode (D-13) and sends only the access mode", async () => {
    const { calls } = bootWith(HASH, {
      [`PATCH ${P("/update/settings")}`]: FEED,
    });
    const access = await section("Metadata access");
    await userEvent.click(
      within(access).getByRole("radio", { name: /Entitled/ }),
    );
    await save("Metadata access");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: P("/update/settings"),
          method: "PATCH",
          body: { metadataAccess: "entitled" },
        }),
      ]),
    );
  });

  it("shows artifact access read-only, linking to Distribution → Access", async () => {
    bootWith(HASH);
    const access = await section("Metadata access");
    const row = within(access)
      .getByText("Artifact access")
      .closest(".px-5") as HTMLElement;
    await waitFor(() => expect(row.textContent).toContain("Licensed"));
    expect(
      within(access)
        .getByRole("link", { name: "Change in Distribution → Access" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/access");
  });

  it("says why artifact access is missing instead of guessing it", async () => {
    bootWith(HASH, {
      [P("/distribution/access")]: () => apiError(500, "internal"),
    });
    const access = await section("Metadata access");
    expect(
      await within(access).findByRole("link", {
        name: "Open Distribution → Access",
      }),
    ).toBeTruthy();
    const row = within(access).getByText("Artifact access").closest(".px-5")!;
    expect(row.textContent).not.toMatch(/Public|Licensed|Entitled/);
  });

  it("locks the access mode and the policy without a release configuration", async () => {
    bootWith(HASH, { [P("/update/settings")]: { ...FEED, configured: false } });
    expect(
      await screen.findByText("No release configuration yet"),
    ).toBeTruthy();
    const access = await section("Metadata access");
    for (const r of within(access).getAllByRole("radio"))
      expect(
        r.hasAttribute("disabled") || r.getAttribute("data-disabled") !== null,
      ).toBe(true);
    const policy = await section("Artifact policy");
    expect(
      (within(policy).getByRole("switch") as HTMLButtonElement).disabled,
    ).toBe(true);
    // The compatibility window still edits.
    const compat = await section("Compatibility window");
    expect(
      (within(compat).getByLabelText(/Lowest supported/) as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });

  it("puts a 422's named field error beside the field, in the server's words", async () => {
    bootWith(HASH, {
      [`PATCH ${P("/update/settings")}`]: () =>
        apiError(
          422,
          "bad_request",
          { fields: ["compatMax"] },
          "compatMax must be at least compatMin",
        ),
    });
    const compat = await section("Compatibility window");
    const max = within(compat).getByLabelText(/Highest supported/);
    await userEvent.clear(max);
    await userEvent.type(max, "3.0.0");
    await save("Compatibility window");
    expect(
      await within(compat).findByText("compatMax must be at least compatMin"),
    ).toBeTruthy();
  });

  it("shows a refusal the server attributes to no field in the section", async () => {
    bootWith(HASH, {
      [`PATCH ${P("/update/settings")}`]: () =>
        apiError(500, "internal", {}, "D1 is unavailable"),
    });
    const access = await section("Metadata access");
    await userEvent.click(
      within(access).getByRole("radio", { name: /^Licensed/ }),
    );
    await save("Metadata access");
    expect(await within(access).findByText("D1 is unavailable")).toBeTruthy();
  });

  it("round-trips a compat edit into the save body, sending only what changed", async () => {
    const { calls } = bootWith(HASH, {
      [`PATCH ${P("/update/settings")}`]: FEED,
    });
    const compat = await section("Compatibility window");
    const min = within(compat).getByLabelText(/Lowest supported/);
    await userEvent.clear(min);
    await userEvent.type(min, "1.2.0");
    await save("Compatibility window");
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({ body: { compatMin: "1.2.0" } }),
      ]),
    );
  });

  it("validates the window as versions before saving", async () => {
    const { calls } = bootWith(HASH);
    const compat = await section("Compatibility window");
    const min = within(compat).getByLabelText(/Lowest supported/);
    await userEvent.clear(min);
    await userEvent.type(min, "3.0.0");
    await save("Compatibility window");
    expect(
      await within(compat).findByText(/same as or higher than the minimum/),
    ).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it("keeps Save out of sight until a value differs", async () => {
    bootWith(HASH);
    await section("Compatibility window");
    expect(
      screen.queryByRole("region", { name: /Unsaved changes/ }),
    ).toBeNull();
  });

  it("shows an error with a working Retry when the settings fail to load", async () => {
    let fail = true;
    bootWith(HASH, {
      [P("/update/settings")]: () => (fail ? apiError(500, "internal") : FEED),
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    await userEvent.click(retry);
    expect(await section("Metadata access")).toBeTruthy();
  });

  it("badges each claimable block with its owner, and the policy with none", async () => {
    bootWith(HASH);
    const access = await section("Metadata access");
    expect(
      within(access).getByRole("button", { name: /Set in console/ }),
    ).toBeTruthy();
    const compat = await section("Compatibility window");
    expect(
      within(compat).getByRole("button", { name: /From manifest/ }),
    ).toBeTruthy();
    const policy = await section("Artifact policy");
    expect(
      within(policy).queryByRole("button", {
        name: /From manifest|Set in console/,
      }),
    ).toBeNull();
  });

  it("reverts one block after confirmation, sending only that block (UPS-7)", async () => {
    const { calls } = bootWith(HASH, {
      [`POST ${P("/update/settings/revert")}`]: FEED,
    });
    const compat = await section("Compatibility window");
    await userEvent.click(
      within(compat).getByRole("button", { name: /From manifest/ }),
    );
    // A manifest-owned block offers no revert.
    expect(screen.queryByRole("button", { name: /^Revert/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    const access = await section("Metadata access");
    await userEvent.click(
      within(access).getByRole("button", { name: /Set in console/ }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Revert/ }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Revert to manifest" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: P("/update/settings/revert"),
          body: { fields: ["access"] },
        }),
      ]),
    );
  });

  describe("artifact policy", () => {
    it("sends a new minimum, and clears it to null when emptied", async () => {
      const { calls } = bootWith(HASH, {
        [`PATCH ${P("/update/settings")}`]: FEED,
      });
      const policy = await section("Artifact policy");
      const min = within(policy).getByLabelText(/Minimum macOS version/);
      await userEvent.clear(min);
      await save("Artifact policy");
      await waitFor(() =>
        expect(writes(calls)).toEqual([
          expect.objectContaining({ body: { minimumSystemVersion: null } }),
        ]),
      );
    });

    it("asks before turning the signature requirement off (L2), and sends nothing when cancelled", async () => {
      const { calls } = bootWith(HASH, {
        [`PATCH ${P("/update/settings")}`]: FEED,
      });
      const policy = await section("Artifact policy");
      await userEvent.click(within(policy).getByRole("switch"));
      await save("Artifact policy");
      const confirm = await screen.findByRole("alertdialog");
      expect(
        within(confirm).getByText(/unsigned or tampered DMG/),
      ).toBeTruthy();
      await userEvent.click(
        within(confirm).getByRole("button", { name: "Cancel" }),
      );
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(writes(calls)).toEqual([]);
      await save("Artifact policy");
      const again = await screen.findByRole("alertdialog");
      await userEvent.click(
        within(again).getByRole("button", { name: "Turn off signatures" }),
      );
      await waitFor(() =>
        expect(writes(calls)).toEqual([
          expect.objectContaining({ body: { requireSparkleSignature: false } }),
        ]),
      );
    });

    it("turns the requirement back on without a confirmation", async () => {
      const { calls } = bootWith(HASH, {
        [P("/update/settings")]: { ...FEED, requireSparkleSignature: false },
        [`PATCH ${P("/update/settings")}`]: FEED,
      });
      const policy = await section("Artifact policy");
      await userEvent.click(within(policy).getByRole("switch"));
      await save("Artifact policy");
      await waitFor(() =>
        expect(writes(calls)).toEqual([
          expect.objectContaining({ body: { requireSparkleSignature: true } }),
        ]),
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  it("lists the public endpoints per channel, with copy", async () => {
    bootWith(HASH);
    const list = await screen.findByRole("list", { name: "Feed endpoints" });
    expect(within(list).getByText(/\/djdl\/update\/version$/)).toBeTruthy();
    expect(
      await within(list).findByText(/\/djdl\/update\/beta\/feed\.jws$/),
    ).toBeTruthy();
    expect(
      within(list).getByRole("button", { name: "Copy the Version check URL" }),
    ).toBeTruthy();
  });

  it("lists only the updaters of the platforms the releases ship (P0-47)", async () => {
    // A Windows-only product: WinSparkle, never a Sparkle appcast.
    const build = (platform: string) => ({
      buildId: `b-${platform}`,
      platform,
      arch: "x86_64",
      format: null,
      buildNumber: null,
      minOs: null,
    });
    bootWith(HASH, {
      [P("/release/releases")]: {
        ...RELEASES,
        releases: RELEASES.releases.map((r) => ({
          ...r,
          builds: [build("windows")],
        })),
      },
    });
    const section = await screen.findByRole("region", { name: "Endpoints" });
    const list = within(section).getByRole("list", { name: "Feed endpoints" });
    expect(
      await within(list).findByText(/\/djdl\/update\/beta\/winsparkle\.xml$/),
    ).toBeTruthy();
    expect(within(list).queryByText(/appcast\.xml$/)).toBeNull();
    expect(
      within(list).getByText(/\/djdl\/update\/beta\/feed\.jws$/),
    ).toBeTruthy();
    // It names only what is missing and when it appears (never "listed for the platforms").
    expect(section.textContent).toContain(
      "Point an app at discovery; it finds the rest. Sparkle appears once a release ships for macOS.",
    );
    expect(section.textContent).not.toMatch(/platforms your releases ship/);
  });

  it("shows skeleton rows under discovery while the releases load (P0-47)", async () => {
    bootWith(HASH);
    // Hold the release list: the section knows discovery and the version check, nothing else.
    const answer = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes(
        "/release/releases",
      )
        ? new Promise<Response>(() => {})
        : answer(input, init),
    );
    const section = await screen.findByRole("region", { name: "Endpoints" });
    const list = within(section).getByRole("list", { name: "Feed endpoints" });
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(within(list).getByText(/\.well-known\/polaris\.json$/)).toBeTruthy();
    expect(within(list).getByText(/\/update\/version$/)).toBeTruthy();
    expect(within(list).queryByText(/feed\.jws$|appcast\.xml$/)).toBeNull();
    expect(list.querySelectorAll(".pk-skeleton").length).toBeGreaterThan(0);
  });

  it("says so in one line when the release list fails, and lists every updater (P0-47)", async () => {
    let fail = true;
    bootWith(HASH, {
      [P("/release/releases")]: () =>
        fail ? apiError(500, "internal") : RELEASES,
    });
    const section = await screen.findByRole("region", { name: "Endpoints" });
    expect(
      await within(section).findByText(
        /Your releases didn.t load, so every updater feed is listed for the stable channel only\./,
      ),
    ).toBeTruthy();
    const list = within(section).getByRole("list", { name: "Feed endpoints" });
    expect(
      within(list).getByText(/\/update\/stable\/winsparkle\.xml$/),
    ).toBeTruthy();
    fail = false;
    await userEvent.click(
      within(section).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() =>
      expect(within(section).queryByText(/didn.t load/)).toBeNull(),
    );
  });

  it("passes axe", async () => {
    bootWith(HASH);
    await section("Artifact policy");
    const results = await axe(document.body);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});

describe("Update → Feed endpoints (P0-47)", () => {
  const store = (platforms: (string | null)[], files: (string | null)[] = []) =>
    ({
      releases: [
        {
          ...RELEASES.releases[0]!,
          builds: platforms.map((platform, i) => ({
            buildId: `b${i}`,
            platform,
            arch: "arm64",
            format: null,
            buildNumber: null,
            minOs: null,
          })),
          artifacts: files.map((platform, i) => ({
            artifactId: `a${i}`,
            name: `f${i}`,
            kind: null,
            platform,
            arch: null,
            sizeBytes: null,
            access: null,
            buildId: null,
            role: null,
            sha256: null,
            locations: null,
          })),
        },
      ],
      channels: [],
      floors: [],
    }) as Parameters<typeof shippedPlatforms>[0];

  it("reads the shipped platforms from builds and files, never a pack's null", () => {
    expect(shippedPlatforms(store(["macos", null], ["windows", null]))).toEqual(
      ["macos", "windows"],
    );
    expect(shippedPlatforms(undefined)).toEqual([]);
  });

  it("names only the updaters it leaves out, and when they appear", () => {
    expect(updaterNote([])).toBeNull();
    expect(updaterNote(["macos", "windows"])).toBeNull();
    expect(updaterNote(["linux"])).toBe(
      "Sparkle and WinSparkle appear once a release ships for macOS or Windows.",
    );
    expect(updaterNote(["macos"])).toBe(
      "WinSparkle appears once a release ships for Windows.",
    );
    expect(updaterNote(["windows", "linux"])).toBe(
      "Sparkle appears once a release ships for macOS.",
    );
  });

  it("lists Sparkle for macOS and WinSparkle for Windows, and every updater while none is known", () => {
    const paths = (platforms: string[]) =>
      endpointRows(["stable"], platforms).map((r) => r.path);
    const common = [
      ".well-known/polaris.json",
      "update/version",
      "update/stable/feed.jws",
    ];
    expect(paths(["macos"])).toEqual([
      ".well-known/polaris.json",
      "update/version",
      "update/appcast.xml",
      "update/stable/feed.jws",
      "update/stable/appcast.xml",
    ]);
    expect(paths(["windows"])).toEqual([
      ...common,
      "update/stable/winsparkle.xml",
    ]);
    expect(paths(["linux", "android"])).toEqual(common);
    expect(paths([])).toEqual([
      ".well-known/polaris.json",
      "update/version",
      "update/appcast.xml",
      "update/stable/feed.jws",
      "update/stable/appcast.xml",
      "update/stable/winsparkle.xml",
    ]);
  });
});
