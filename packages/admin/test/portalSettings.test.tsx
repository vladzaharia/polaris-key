/**
 * ST-14 — Settings → Polaris Locker: the three switches and the branding editor, one form, one
 * save. The save sends only what changed to the portal route; a refused branding field is named
 * on the field and the draft survives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PortalProductSettings } from "../src/api.js";
import { expectNoAxeViolations, renderAt, resetCore } from "./coreTestUtils.js";

const fns = vi.hoisted(() => ({
  portalSettings: vi.fn(),
  updatePortalSettings: vi.fn(),
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

const { HttpError } = await import("../src/api.js");
const { PortalPage, draftOf, patchOf, validatePortal } =
  await import("../src/console/sections/core/pages/Portal.js");

const SERVER: PortalProductSettings = {
  portalEnabled: true,
  keyReissueEnabled: false,
  claimByKey: false,
  branding: { developerName: "Fennick", tintColor: "#3a7bd5" },
  modifiedAt: 1,
};

const mount = () =>
  renderAt("#/p/djdl/settings/portal", <PortalPage slug="djdl" />);

beforeEach(() => {
  resetCore();
  for (const f of Object.values(fns)) f.mockReset();
  fns.portalSettings.mockResolvedValue({ settings: SERVER });
  fns.updatePortalSettings.mockResolvedValue({
    ok: true,
    settings: { ...SERVER, portalEnabled: false },
  });
});
afterEach(cleanup);

describe("the draft", () => {
  it("reads the server's values, an absent branding as empty fields", () => {
    expect(draftOf(SERVER)).toMatchObject({
      portalEnabled: true,
      developerName: "Fennick",
      tintColor: "#3a7bd5",
      website: "",
    });
    expect(draftOf({ portalEnabled: true })).toMatchObject({
      keyReissueEnabled: false,
      claimByKey: false,
      developerName: "",
    });
  });

  it("sends only the switches that moved, and the whole branding if one field did", () => {
    const server = draftOf(SERVER);
    expect(patchOf(server, { ...server, claimByKey: true })).toEqual({
      claimByKey: true,
    });
    expect(
      patchOf(server, {
        ...server,
        website: " https://f.example ",
        tintColor: "",
      }),
    ).toEqual({
      branding: { developerName: "Fennick", website: "https://f.example" },
    });
    expect(patchOf(server, server)).toEqual({});
  });

  it("checks what the Worker checks", () => {
    const d = draftOf(SERVER);
    expect(validatePortal(d)).toEqual({});
    expect(
      Object.keys(
        validatePortal({
          ...d,
          tintColor: "blue",
          tintColorDark: "#12",
          website: "http://x.example",
          supportUrl: "ftp://x",
          supportEmail: "nobody",
          developerName: "x".repeat(61),
        }),
      ).sort(),
    ).toEqual([
      "developerName",
      "supportEmail",
      "supportUrl",
      "tintColor",
      "tintColorDark",
      "website",
    ]);
  });
});

describe("Settings → Polaris Locker", () => {
  it("shows the two switches and the branding fields", async () => {
    const { container } = mount();
    const checked = (el: HTMLElement) => el.getAttribute("aria-checked");
    expect(
      checked(
        await screen.findByRole("switch", {
          name: /Show djdl in Polaris Locker/,
        }),
      ),
    ).toBe("true");
    // Hidden until the Locker has the reissue action (G7).
    expect(
      screen.queryByRole("switch", { name: /replace a lost key/i }),
    ).toBeNull();
    expect(
      checked(
        screen.getByRole("switch", { name: /adds its license to whoever/i }),
      ),
    ).toBe("false");
    expect(
      (screen.getByLabelText("Developer name") as HTMLInputElement).value,
    ).toBe("Fennick");
    expect(
      (screen.getByLabelText("Accent color") as HTMLInputElement).value,
    ).toBe("#3a7bd5");
    await expectNoAxeViolations(container);
  });

  it("saves one change as one PATCH and names the result", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("switch", {
        name: /Show djdl in Polaris Locker/,
      }),
    );
    await user.click(await screen.findByRole("button", { name: /^Save/ }));
    await waitFor(() =>
      expect(fns.updatePortalSettings).toHaveBeenCalledWith("djdl", {
        portalEnabled: false,
      }),
    );
  });

  it("warns while claim by key is on", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await user.click(
      await screen.findByRole("switch", {
        name: /adds its license to whoever/i,
      }),
    );
    expect(
      screen.getByText(/leaked key can add an email-bound license/i),
    ).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("names a refused branding field and keeps the draft", async () => {
    const user = userEvent.setup();
    fns.updatePortalSettings.mockRejectedValue(
      new HttpError(422, { fields: ["branding.supportEmail"] }),
    );
    mount();
    const email = await screen.findByLabelText("Support email");
    await user.type(email, "ops@fennick.example");
    await user.click(await screen.findByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(fns.updatePortalSettings).toHaveBeenCalled());
    expect(await screen.findByText("Check this value.")).toBeTruthy();
    expect(
      (screen.getByLabelText("Support email") as HTMLInputElement).value,
    ).toBe("ops@fennick.example");
  });

  it("blocks a bad color before it is sent", async () => {
    const user = userEvent.setup();
    mount();
    const color = await screen.findByLabelText("Accent color");
    await user.clear(color);
    await user.type(color, "blue");
    await user.click(await screen.findByRole("button", { name: /^Save/ }));
    expect(
      await screen.findByText("Use a six-digit color such as #3a7bd5."),
    ).toBeTruthy();
    expect(fns.updatePortalSettings).not.toHaveBeenCalled();
  });

  it("shows Try again when the settings do not load", async () => {
    fns.portalSettings.mockRejectedValue(new HttpError(500));
    mount();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
