/**
 * Core → Integration (ST-41): the page over ST-40's read model, driven through the whole console.
 * Verified is a fact the server computed; the page shows it per platform as text, the SDK picker is
 * a keyboard tablist whose pick lives in the hash query, and Hide is the operator's own choice.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { boot } from "./consoleHarness.js";
import { expectNoAxeViolations } from "./coreTestUtils.js";

const NOW = Math.floor(Date.now() / 1000);
const API = "/manage/api/products/djdl";

const seenOn = (platform: string, sdk = "swift", sdkVersion = "1.2.3") => ({
  sdk,
  platform,
  arch: "arm64",
  sdkVersion,
  lastOkAt: NOW - 120,
});

function view(over: Record<string, unknown> = {}) {
  return {
    product: "djdl",
    now: NOW,
    snippet: {
      slug: "djdl",
      services: ["license", "config"],
      pins: [{ kid: "djdl-a", publicKey: "PUBKEY-A" }],
    },
    features: [
      {
        id: "licensing",
        service: "license",
        prerequisites: [{ id: "tiers", met: true }],
        unavailable: false,
        facts: {},
        status: "verified",
        verifiedOn: [seenOn("macos"), seenOn("ios")],
      },
      {
        id: "config",
        service: "config",
        prerequisites: [{ id: "catalog", met: false }],
        unavailable: false,
        facts: {},
        status: "blocked",
        verifiedOn: [],
      },
    ],
    server: [],
    sightings: [
      {
        sdk: "swift",
        platform: "macos",
        arch: "arm64",
        sdkVersion: "1.2.3",
        firstSeenAt: NOW - 900,
        lastSeenAt: NOW - 120,
      },
    ],
    verified: true,
    ...over,
  };
}

const page = () =>
  screen.findByRole("heading", { level: 1, name: "Integration" });

afterEach(cleanup);

describe("Core → Integration", () => {
  it("shows each feature's setup, its code and where it was seen, per platform", async () => {
    boot("#/p/djdl/integration", { extra: { [`${API}/integration`]: view() } });
    await page();
    expect(await screen.findByText("1 of 2 features Verified")).toBeTruthy();
    const licensing = (
      await screen.findByRole("heading", { level: 2, name: "Licensing" })
    ).closest("section")!;
    expect(licensing.getAttribute("data-service")).toBe("license");
    const seen = within(licensing).getByRole("list", { name: "Verified on" });
    expect(within(seen).getByText("macOS")).toBeTruthy();
    expect(within(seen).getByText("iOS")).toBeTruthy();
    expect(seen.textContent).toContain("Swift 1.2.3");
    // The blocked feature names what it waits on and links the fix.
    const config = screen
      .getByRole("heading", { level: 2, name: "Managed config" })
      .closest("section")!;
    expect(within(config).getByText("Waiting on setup")).toBeTruthy();
    expect(
      within(config)
        .getByRole("link", { name: "Publish a catalog" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/config/catalog");
    // Per-platform progress for a product seen on a platform.
    expect(
      within(
        screen.getByRole("list", { name: "Progress by platform" }),
      ).getByText("macOS"),
    ).toBeTruthy();
    // The install routes to pkg.plrs.im first, with the pins in the config.
    const text = document.body.textContent ?? "";
    expect(text).toContain("pkg.plrs.im");
    expect(text).toContain("PUBKEY-A");
  });

  it("renders a client-supplied SDK version as text, never markup", async () => {
    const evil = '1.0"><img src=x onerror=alert(1)>';
    boot("#/p/djdl/integration", {
      extra: {
        [`${API}/integration`]: view({
          features: [
            {
              ...view().features[0],
              verifiedOn: [seenOn("macos", "swift", evil)],
            },
          ],
        }),
      },
    });
    await page();
    const seen = await screen.findByRole("list", { name: "Verified on" });
    expect(seen.textContent).toContain(evil);
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("a feature no app has called yet links 'Not seen yet' troubleshooting", async () => {
    boot("#/p/djdl/integration", {
      extra: {
        [`${API}/integration`]: view({
          features: [
            { ...view().features[0], status: "not_seen", verifiedOn: [] },
          ],
          verified: false,
        }),
      },
    });
    await page();
    const link = await screen.findByRole("link", {
      name: "Not seen after running it?",
    });
    expect(link.getAttribute("href")).toBe(
      "/docs/build/troubleshooting/#not-seen-yet",
    );
    // Hide is not offered before anything is Verified.
    expect(screen.queryByText("Hide Integration")).toBeNull();
  });

  it("the SDK picker is a tablist: arrows and End move, Tab leaves, the pick is in the hash", async () => {
    boot("#/p/djdl/integration", { extra: { [`${API}/integration`]: view() } });
    await page();
    const list = (await screen.findAllByRole("tablist", { name: "SDK" }))[1]!;
    const tabs = within(list).getAllByRole("tab");
    const selected = tabs.find(
      (t) => t.getAttribute("aria-selected") === "true",
    )!;
    // Roving tabindex: only the selected tab is in the Tab order.
    expect(tabs.filter((t) => t.tabIndex === 0)).toEqual([selected]);
    selected.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(window.location.hash).toContain("sdk="));
    const after = within(list)
      .getAllByRole("tab")
      .find((t) => t.getAttribute("aria-selected") === "true")!;
    expect(after).not.toBe(selected);
    expect(document.activeElement).toBe(after);
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(window.location.hash).toContain("sdk=godot"));
    expect(document.body.textContent).toContain("polaris_key");
    await userEvent.keyboard("{Home}");
    await waitFor(() => expect(window.location.hash).toContain("sdk=node"));
    // Tab leaves the list for the panel's content.
    await userEvent.tab();
    expect(list.contains(document.activeElement)).toBe(false);
  });

  it("opens on the SDK named in the hash", async () => {
    boot("#/p/djdl/integration?sdk=python", {
      extra: { [`${API}/integration`]: view() },
    });
    await page();
    await waitFor(() =>
      expect(document.body.textContent).toContain("from polaris_key"),
    );
  });

  it("Hide Integration is offered once a feature is Verified and saves core.setup", async () => {
    const user = userEvent.setup();
    const log = boot("#/p/djdl/integration", {
      extra: {
        [`${API}/integration`]: view(),
        [`${API}/settings/effective`]: { settings: [] },
        [`PATCH ${API}/settings/core.setup`]: {
          ok: true,
          claimed: false,
          setting: {
            key: "core.setup",
            version: 1,
            value: {
              integrationHidden: { at: NOW, by: "ada@x.io" },
              notUsing: [],
              runnerConsent: null,
              skipped: [],
            },
          },
        },
      },
    });
    await page();
    const hide = await screen.findAllByRole("button", {
      name: "Hide Integration",
    });
    await user.click(hide[0]!);
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => c.method === "PATCH" && c.path.endsWith("/core.setup"),
        ),
      ).toBe(true),
    );
    const patch = log.calls.find((c) => c.method === "PATCH")!;
    expect(
      (patch.json as { value: { integrationHidden: unknown } }).value
        .integrationHidden,
    ).toMatchObject({ by: "ada@x.io" });
  });

  it("passes axe", async () => {
    boot("#/p/djdl/integration", { extra: { [`${API}/integration`]: view() } });
    await page();
    await screen.findByText("1 of 2 features Verified");
    await expectNoAxeViolations(document.body);
  });
});
