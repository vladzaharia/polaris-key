// @pkey-feature ui.kit ui.kit.account ui.update ui.devicelimit
//
// UK-59 review 2, in the built React kit: the update prompt never draws a separator beside a
// part it dropped and offers one verb per state; the account pane names the person only when the
// host knows who, and draws its rows as the web settings frames do; the device limit's title is
// the catalog's "Replace a device" with the count under it.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  AccountAndLicense,
  DeviceLimit,
  UpdatePrompt,
} from "@polaris-key/react/kit";
import type { UiInput } from "@polaris-key/ui-core";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const presentation = {
  name: "Tidewater Studio",
  developerName: "Harbor Audio",
  icon: false,
};
const draw = (ui: ReactElementLike) => render(ui).container;
type ReactElementLike = Parameters<typeof render>[0];

const prompt = (input: UiInput) =>
  draw(<UpdatePrompt input={{ ...input, presentation }} />);
const keys = (
  c: HTMLElement,
  sel = "[data-part=primary],[data-part=secondary]",
) => [...c.querySelectorAll<HTMLElement>(sel)].map((e) => e.dataset.key);

describe("UpdatePrompt", () => {
  it("draws no line for a download whose figures it does not have (the bar and percent stand)", () => {
    const c = prompt({
      update: {
        action: "binary",
        version: "2.5.0",
        progress: { phase: "download", fraction: 0.4 },
      },
    });
    expect(c.querySelector("[data-part=status]")).toBeNull();
    expect(c.querySelector(".percent")?.textContent).toBe("40%");
  });

  it("keeps the separator between the parts it has", () => {
    const c = prompt({
      update: {
        action: "binary",
        version: "2.5.0",
        progress: {
          phase: "download",
          fraction: 0.4,
          size: "24 MB",
          total: "61 MB",
          timeLeft: "20 seconds",
        },
      },
    });
    expect(c.querySelector("[data-part=status]")!.textContent).toBe(
      "Downloading · 24 MB of 61 MB · About 20 seconds left",
    );
  });

  it("offers Update now and Later when an update is available, never Restart when ready", () => {
    const c = prompt({ update: { action: "binary", version: "2.5.0" } });
    expect(keys(c)).toEqual(["update.install", "update.later"]);
    expect(c.querySelector("[data-part=primary]")!.textContent).toBe(
      "Update now",
    );
  });

  it("offers Restart when ready, as the one primary, while the download runs", () => {
    const c = prompt({
      update: {
        action: "binary",
        version: "2.5.0",
        progress: { phase: "download", fraction: 0.4 },
      },
    });
    expect(keys(c, "[data-part=primary]")).toEqual(["update.restartWhenReady"]);
    expect(keys(c)).not.toContain("update.install");
  });

  it("offers Restart now when the update is ready, and only Update now when mandatory", () => {
    const ready = prompt({
      update: { action: "code-ready", version: "2.5.0" },
    });
    expect(keys(ready, "[data-part=primary]")).toEqual(["update.restartNow"]);
    cleanup();
    const must = prompt({
      update: { action: "binary", version: "2.5.0", mandatory: true },
    });
    expect(keys(must)).toEqual(["update.install"]);
  });
});

describe("AccountAndLicense", () => {
  const pane = (account: NonNullable<UiInput["account"]>) =>
    draw(
      <AccountAndLicense
        input={{
          account,
          bundle: { slug: "t", name: "T", version: "2.4.1" },
          presentation,
        }}
      />,
    );

  it("names the person who is signed in", () => {
    const c = pane({ signedIn: true, holder: "Mara Fennick", tier: "Pro" });
    expect(c.querySelector("[data-key='account.holder']")!.textContent).toBe(
      "Signed in as Mara Fennick",
    );
  });

  it("drops the line when the host has no name, never a placeholder word", () => {
    const c = pane({ signedIn: true, tier: "Pro" });
    const line = c.querySelector<HTMLElement>("[data-key='account.holder']");
    expect(line === null || line.hidden).toBe(true);
    expect(c.textContent).not.toMatch(/Signed in as/);
    expect(c.querySelector("p:empty:not([hidden])")).toBeNull();
  });

  it("keeps the Updates heading off a pane with no update rows", () => {
    const c = draw(
      <AccountAndLicense
        input={{ account: { signedIn: false, tier: "Pro" }, presentation }}
      />,
    );
    const heading = c.querySelector<HTMLElement>(
      "h2[data-key='account.updates']",
    );
    expect(heading === null || heading.hidden).toBe(true);
  });

  it("draws labelled rows with their values at the end, in groups", () => {
    const c = pane({
      signedIn: true,
      holder: "Mara Fennick",
      tier: "Pro",
      devices: { used: 2, limit: 3 },
      autoUpdate: true,
    });
    const rows = [...c.querySelectorAll("[data-part=settings-row]")];
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(row.querySelector(":scope > .row-title")).not.toBeNull();
      expect(row.querySelector(":scope > .row-value")).not.toBeNull();
    }
    const devices = c.querySelector(
      "[data-key='account.devices']",
    )!.parentElement!;
    expect(devices.querySelector(".row-value")!.textContent).toBe(
      "2 of 3 in use",
    );
    expect(c.querySelector("[role=switch]")!.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      c.querySelector("[role=radiogroup] [aria-checked=true]")!.textContent,
    ).toBe("Stable");
    // The update rows sit under their own heading.
    expect(c.querySelectorAll("[data-part=account-list]").length).toBe(3);
    expect(c.querySelector("h2[data-key='account.updates']")).not.toBeNull();
  });
});

describe("DeviceLimit", () => {
  it("is titled by the catalog's deviceLimit.title, with the count under it", () => {
    const c = draw(
      <DeviceLimit
        input={
          {
            presentation,
            activation: { deviceCount: 3, limit: 3 },
            devices: [
              {
                id: "a",
                name: "Work laptop",
                lastSeen: "last week",
                platform: "windows",
              },
            ],
          } as unknown as UiInput
        }
      />,
    );
    const h1 = c.querySelector("h1")!;
    expect(h1.dataset.key).toBe("deviceLimit.title");
    expect(h1.textContent).toBe("Replace a device");
    expect(
      c.querySelector("[data-key='deviceLimit.heading']")!.textContent,
    ).toBe("Your license is on 3 of 3 devices");
  });
});
