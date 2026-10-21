/**
 * Core → Integration (ST-41): the page over ST-40's read model, driven through the whole console.
 * Verified is a fact the server computed; the page shows it per platform as text, the SDK picker is
 * a keyboard tablist whose pick lives in the hash query, and Hide is the operator's own choice.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lastAnnouncement } from "../src/ui/LiveRegion.js";
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
      releaseKeys: [],
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

/** A Verified feature with nothing left to do is one row; open it. */
const openFeature = async (name: string) => {
  const card = (await screen.findByRole("heading", { level: 2, name })).closest(
    "section",
  )!;
  await userEvent.click(
    within(card).getByRole("button", { name: `Show ${name}` }),
  );
  return card;
};

const page = () =>
  screen.findByRole("heading", { level: 1, name: "Integration" });

afterEach(cleanup);

describe("Core → Integration", () => {
  it("shows the product's first moment once when it arrives from New product (ST-43)", async () => {
    boot("#/p/djdl/integration?created=1", {
      extra: { [`${API}/integration`]: view() },
    });
    await page();
    const moment = await screen.findByText(/is ready$/);
    expect(moment).toBeTruthy();
    await waitFor(() => expect(lastAnnouncement()).toMatch(/is ready$/));
    // Focus lands on the page's heading, not on the document.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
    // The link is a plain Integration link afterwards: a refresh does not repeat it.
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/integration"),
    );
  });

  it("shows each feature's setup, its code and where it was seen, per platform", async () => {
    boot("#/p/djdl/integration", { extra: { [`${API}/integration`]: view() } });
    await page();
    expect(await screen.findByText("1 of 2 features verified")).toBeTruthy();
    const licensing = await openFeature("Licensing");
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
    await userEvent.click(screen.getByRole("radio", { name: "By hand" }));
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
    await openFeature("Licensing");
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
    const link = (
      await screen.findAllByRole("link", {
        name: "Not seen after running it?",
      })
    )[0]!;
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
    // The first three SDKs and the pick show; More reveals the rest, and End reaches the last.
    await userEvent.click(
      within(list.parentElement!).getByRole("button", { name: "More SDKs" }),
    );
    within(list)
      .getAllByRole("tab")
      .find((t) => t.getAttribute("aria-selected") === "true")!
      .focus();
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(window.location.hash).toContain("sdk=godot"));
    await userEvent.keyboard("{Home}");
    await waitFor(() => expect(window.location.hash).toContain("sdk=swift"));
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

  it("uses this product's names in the snippets, a visible placeholder where it has none (F6)", async () => {
    boot("#/p/djdl/integration?sdk=node&feature=config", {
      extra: {
        [`${API}/integration`]: view(),
        [`${API}/config/catalog`]: {
          schemaVersion: 1,
          entries: [
            { key: "audio.gain", kind: "config", default: 3 },
            { key: "pro-mode", kind: "flag" },
          ],
        },
      },
    });
    await page();
    await waitFor(() =>
      expect(document.body.textContent).toContain("audio.gain"),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("<your-secret>");
    expect(text).not.toContain("tidewater");
    expect(text).not.toContain("audio.musicVolume");
  });

  it("shows the server card whatever SDK is picked, with its own Verified (F5)", async () => {
    boot("#/p/djdl/integration?sdk=swift", {
      extra: {
        [`${API}/integration`]: view({
          server: [seenOn("node-server", "linux")],
        }),
      },
    });
    await page();
    const card = (
      await screen.findByRole("heading", { level: 2, name: "Your server" })
    ).closest("section")!;
    expect(within(card).getByText("Verified")).toBeTruthy();
    expect(card.textContent).toContain("Swift has no server snippet");
  });

  it("leads with the SDK last seen and folds the rest under More (F7)", async () => {
    boot("#/p/djdl/integration", { extra: { [`${API}/integration`]: view() } });
    await page();
    const list = (await screen.findAllByRole("tablist", { name: "SDK" }))[0]!;
    const tabs = within(list).getAllByRole("tab");
    expect(tabs[0]!.textContent).toBe("Swift");
    expect(tabs).toHaveLength(3);
    expect(
      within(list.parentElement!).getByRole("button", { name: "More SDKs" }),
    ).toBeTruthy();
  });

  it("counts a platform Verified on a feature even when no sighting names it (F11)", async () => {
    boot("#/p/djdl/integration", {
      extra: {
        [`${API}/integration`]: view({
          sightings: [],
          features: [
            {
              ...view().features[0],
              verifiedOn: [seenOn("android", "kotlin")],
            },
          ],
        }),
      },
    });
    await page();
    const meters = await screen.findByRole("list", {
      name: "Progress by platform",
    });
    expect(within(meters).getByText("Android")).toBeTruthy();
  });

  it("a failed Hide says why in a toast and leaves the page as it was (F1)", async () => {
    const user = userEvent.setup();
    boot("#/p/djdl/integration", {
      extra: {
        [`${API}/integration`]: view(),
        [`${API}/settings/effective`]: { settings: [] },
        [`PATCH ${API}/settings/core.setup`]: new Response(
          JSON.stringify({ error: "forbidden" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await page();
    await user.click(
      await screen.findByRole("button", { name: "Hide Integration" }),
    );
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/permission|allowed|couldn/i),
    );
    expect(
      screen.getByRole("button", { name: "Hide Integration" }),
    ).toBeTruthy();
  });

  it("One command names the product and carries every pin's fingerprint (N1)", async () => {
    boot("#/p/djdl/integration?sdk=python", {
      extra: { [`${API}/integration`]: view() },
    });
    await page();
    await waitFor(() =>
      expect(document.body.textContent).toMatch(
        /pkey sdk add python \\\s+--product djdl \\\s+--expect djdl-a@sha256:[0-9a-f]{64}/,
      ),
    );
    expect(document.body.textContent).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it("adds one --release-key per declared release key, and none without (N1)", async () => {
    boot("#/p/djdl/integration?sdk=node", {
      extra: {
        [`${API}/integration`]: view({
          snippet: {
            slug: "djdl",
            services: ["license", "release"],
            pins: [{ kid: "djdl-a", publicKey: "PUBKEY-A" }],
            releaseKeys: [{ kid: "djdl-ci", publicKey: "RELKEY" }],
          },
        }),
      },
    });
    await page();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "--release-key djdl-ci=RELKEY",
      ),
    );
  });

  it("puts Your app before the cards in the DOM, and says when no signing key is active (N2, N6)", async () => {
    boot("#/p/djdl/integration", {
      extra: {
        [`${API}/integration`]: view(),
        [`${API}`]: {
          product: { slug: "djdl", name: "DJDL", services: {}, signing: null },
        },
      },
    });
    await page();
    const aside = (
      await screen.findByRole("heading", { level: 2, name: "Your app" })
    ).closest("aside")!;
    const card = (
      await screen.findByRole("heading", { level: 2, name: "Managed config" })
    ).closest("section")!;
    expect(
      aside.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(aside).getByText("No signing key is active.")).toBeTruthy();
  });

  it("passes axe", async () => {
    boot("#/p/djdl/integration", { extra: { [`${API}/integration`]: view() } });
    await page();
    await screen.findByText("1 of 2 features verified");
    await expectNoAxeViolations(document.body);
  });
});
