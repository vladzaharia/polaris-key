import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FEEDS_CI_TOKEN_ENV,
  FEEDS_SETUP_WRITE_COMMAND,
  feedsSetupCiCommand,
} from "@polaris-key/manifest";
import type { FeedsOverviewDto } from "../src/api.js";
import { ALL_ON, boot, productRow, resetConsole } from "./consoleHarness.js";
import { feedDetail, feedRoutes, productOverview } from "./feedsFixture.js";

/** The Install cards on Packages (F-34.10, mockup `packages.feeds`). */

beforeEach(resetConsole);
afterEach(cleanup);

const FEEDS = "/manage/api/products/djdl/distribution/feeds";

/** The fixture's product overview with these ecosystems provisioned, at `access`. */
function overview(ecos: Record<string, string>): FeedsOverviewDto {
  const o = productOverview();
  return {
    ...o,
    feeds: o.feeds.map((f) =>
      f.ecosystem in ecos
        ? {
            ...f,
            configured: true,
            enabled: true,
            status: "enabled" as const,
            reason: null,
            accessMode: ecos[f.ecosystem]!,
          }
        : { ...f, configured: false, enabled: false, status: "off" as const },
    ),
  };
}

async function cards(
  ecos: Record<string, string>,
  namespaces: Record<string, Record<string, unknown>> = {},
): Promise<HTMLElement> {
  const extra: Record<string, unknown> = {
    ...feedRoutes(),
    [FEEDS]: overview(ecos),
    "/manage/api/products/djdl": {
      product: { ...productRow("djdl", "DJDL", ALL_ON), packageFeeds: true },
    },
  };
  for (const [eco, ns] of Object.entries(namespaces)) {
    const d = feedDetail("product", eco as never);
    extra[`${FEEDS}/${eco}`] = {
      ...d,
      settings: { ...d.settings, namespace: ns },
    };
  }
  boot("#/p/djdl/distribution/feeds", { extra });
  const main = await screen.findByRole("main");
  return (
    await within(main).findByRole("heading", {
      name: "Install on your machine",
    })
  ).closest("[data-install-cards]") as HTMLElement;
}

const commands = (root: HTMLElement): string[] =>
  [...root.querySelectorAll("[data-install-command]")].map(
    (c) => c.querySelector("code")!.textContent!,
  );

describe("Install cards (F-34.10)", () => {
  it("npm with a scope: the namespace is in the command; a private feed names the variable, never a token", async () => {
    const root = await cards({ npm: "licensed" }, { npm: { scope: "@djdl" } });
    await waitFor(() => expect(commands(root)).toHaveLength(2));
    expect(commands(root)[0]).toBe(FEEDS_SETUP_WRITE_COMMAND);
    expect(commands(root)[1]).toBe(
      feedsSetupCiCommand("npm", "djdl", {
        namespace: { scope: "@djdl" },
        tokenEnv: FEEDS_CI_TOKEN_ENV,
      }),
    );
    expect(commands(root)[1]).toContain("--namespace scope=@djdl");
    expect(root.textContent).not.toMatch(/pkeyci_[A-Za-z0-9]/);
    expect(root.textContent).toContain("reads PKEY_REGISTRY_TOKEN");
    await waitFor(() =>
      expect(root.textContent).toMatch(/\d service tokens? · .*Manage/),
    );
  });

  it("a public feed has no token flag and no token line", async () => {
    const root = await cards({ npm: "public" }, { npm: { scope: "@djdl" } });
    await waitFor(() => expect(commands(root)).toHaveLength(2));
    expect(commands(root)[1]).not.toContain("--token-env");
    expect(root.textContent).not.toContain(FEEDS_CI_TOKEN_ENV);
  });

  it("Godot only: no CLI command, a link to the feed's Setup tab", async () => {
    const root = await cards({ godot: "licensed" });
    await waitFor(() =>
      expect(
        within(root).getByRole("link", { name: /Open the Godot setup/ }),
      ).toBeTruthy(),
    );
    expect(commands(root)).toEqual([FEEDS_SETUP_WRITE_COMMAND]);
    expect(
      within(root)
        .getByRole("link", { name: /Open the Godot setup/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/feeds/godot/setup");
  });

  it("several ecosystems: one command each", async () => {
    const root = await cards({
      npm: "licensed",
      pypi: "licensed",
      godot: "licensed",
    });
    await waitFor(() => expect(commands(root)).toHaveLength(3));
    expect(
      commands(root)
        .slice(1)
        .map((c) => c.match(/--ecosystem (\w+)/)![1]),
    ).toEqual(["npm", "pypi"]);
    expect(
      within(root).getByRole("link", { name: /Godot setup/ }),
    ).toBeTruthy();
  });

  it("copies the command", async () => {
    const root = await cards({ npm: "licensed" });
    const user = userEvent.setup();
    await user.click(
      within(root).getByRole("button", {
        name: "Copy: Install on your machine",
      }),
    );
    expect(await navigator.clipboard.readText()).toBe(
      FEEDS_SETUP_WRITE_COMMAND,
    );
  });
});
