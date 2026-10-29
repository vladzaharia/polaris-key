import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FEEDS_CI_TOKEN_ENV,
  FEEDS_SETUP_WRITE_COMMAND,
  feedsSetupCiCommand,
} from "@polaris-key/manifest";
import { ALL_ON, boot, productRow, resetConsole } from "./consoleHarness.js";
import { feedRoutes } from "./feedsFixture.js";

/** The Install cards on Packages (F-34.10, mockup `packages.feeds`). */

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function cards(): Promise<HTMLElement> {
  boot("#/p/djdl/distribution/feeds", {
    extra: {
      ...feedRoutes(),
      "/manage/api/products/djdl": {
        product: { ...productRow("djdl", "DJDL", ALL_ON), packageFeeds: true },
      },
    },
  });
  const main = await screen.findByRole("main");
  return (
    await within(main).findByRole("heading", {
      name: "Install on your machine",
    })
  ).closest("[data-install-cards]") as HTMLElement;
}

describe("Install cards (F-34.10)", () => {
  it("prints the CLI's own commands and names the token variable, never a token", async () => {
    const root = await cards();
    const cmds = [...root.querySelectorAll("[data-install-command]")].map(
      (c) => c.textContent,
    );
    expect(cmds[0]).toContain(FEEDS_SETUP_WRITE_COMMAND);
    expect(cmds[1]).toContain(feedsSetupCiCommand("npm", "djdl"));
    expect(root.textContent).toContain(FEEDS_CI_TOKEN_ENV);
    expect(root.textContent).not.toMatch(/pkeyci_[A-Za-z0-9]/);
    expect(
      within(root)
        .getByRole("link", { name: "Create a Service token" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/feeds/tokens");
  });

  it("copies each command", async () => {
    const root = await cards();
    const user = userEvent.setup();
    await user.click(
      within(root).getByRole("button", {
        name: "Copy: Install on your machine",
      }),
    );
    expect(await navigator.clipboard.readText()).toBe(
      FEEDS_SETUP_WRITE_COMMAND,
    );
    await user.click(
      within(root).getByRole("button", {
        name: "Copy: Install in CI and on servers",
      }),
    );
    expect(await navigator.clipboard.readText()).toBe(
      feedsSetupCiCommand("npm", "djdl"),
    );
  });
});
