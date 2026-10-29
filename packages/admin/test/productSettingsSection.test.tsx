/**
 * ProductSettingsSection stabilization (B-032, B-035): a number that only applies with a switch
 * says so and refuses edits while the switch is off, and an empty field names the platform value
 * it follows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpError, type ProductSetting } from "../src/api.js";
import { renderAt, resetCore, testQueryClient } from "./coreTestUtils.js";
import { qk } from "../src/console/data/queries.js";

const fns = vi.hoisted(() => ({
  productSettings: vi.fn(),
  updateProductSetting: vi.fn(),
}));

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      ...actual.api,
      productSettings: (...a: unknown[]) => fns.productSettings(...a),
      updateProductSetting: (...a: unknown[]) => fns.updateProductSetting(...a),
    },
  };
});

const { ProductSettingsSection } =
  await import("../src/console/components/ProductSettingsSection.js");

function setting(key: string, over: Partial<ProductSetting>): ProductSetting {
  return {
    key,
    area: "assets",
    service: "core",
    label: key,
    description: `What ${key} does.`,
    docs: "",
    spec: { kind: "integer", unit: "count", min: 1, max: 100 },
    confirm: { up: "L0", down: "L0" },
    critical: false,
    manifestPath: null,
    visibleWhen: null,
    serviceEnabled: true,
    value: 25,
    source: "default",
    defaultValue: 25,
    version: 0,
    updatedAt: null,
    updatedBy: null,
    reason: null,
    ...over,
  };
}

beforeEach(resetCore);
afterEach(cleanup);

describe("ProductSettingsSection", () => {
  it("B-032: a key that waits for a switch is locked, with the reason, while the switch is off", async () => {
    fns.productSettings.mockResolvedValue({
      settings: [
        setting("lazy.on", {
          label: "Lazy deltas",
          spec: { kind: "switch" },
          value: "off",
          defaultValue: "off",
        }),
        setting("lazy.hot", { label: "Hot devices" }),
      ],
    });
    renderAt(
      "#/p/djdl/settings",
      <ProductSettingsSection
        slug="djdl"
        area="assets"
        id="s"
        title="Deltas"
        lockedBy={{ "lazy.hot": "lazy.on" }}
      />,
    );
    const card = await screen.findByRole("region", { name: "Deltas" });
    expect(
      await within(card).findByText("Applies once Lazy deltas is on."),
    ).toBeTruthy();
    expect(
      (within(card).getByRole("textbox") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("B-032: the key is editable once the switch is on", async () => {
    fns.productSettings.mockResolvedValue({
      settings: [
        setting("lazy.on", {
          label: "Lazy deltas",
          spec: { kind: "switch" },
          value: "on",
          defaultValue: "off",
        }),
        setting("lazy.hot", { label: "Hot devices" }),
      ],
    });
    renderAt(
      "#/p/djdl/settings",
      <ProductSettingsSection
        slug="djdl"
        area="assets"
        id="s"
        title="Deltas"
        lockedBy={{ "lazy.hot": "lazy.on" }}
      />,
    );
    const card = await screen.findByRole("region", { name: "Deltas" });
    await within(card).findByRole("textbox");
    expect(within(card).queryByText(/Applies once/)).toBeNull();
    expect(
      (within(card).getByRole("textbox") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("B-035: an unset field names the platform value it follows", async () => {
    fns.productSettings.mockResolvedValue({
      settings: [
        setting("email.dailyCap", {
          label: "Daily sign-in mail cap",
          spec: { kind: "integer", unit: "perDay", min: 1, max: 1_000_000 },
          value: null,
          defaultValue: null,
          inherited: 200,
        }),
      ],
    });
    renderAt(
      "#/p/djdl/settings",
      <ProductSettingsSection
        slug="djdl"
        area="general"
        id="s"
        title="Email"
      />,
    );
    const field = await screen.findByRole("textbox");
    expect(field.getAttribute("placeholder")).toBe(
      "Platform default: 200 a day",
    );
  });

  it("PX-W13c: a platform-only key is read-only for a product admin, editable for a platform admin", async () => {
    const approval = setting("identity.displayNameApproved", {
      label: "Approved display name",
      spec: { kind: "boolean" },
      confirm: { on: "L1", off: "L0" },
      value: false,
      defaultValue: false,
      rbacArea: "signin",
      platformOnly: true,
      ownership: "operator",
    });
    fns.productSettings.mockResolvedValue({ settings: [approval] });
    const me = (platform: string[]) => ({
      sub: "s",
      name: "N",
      email: "n@x.io",
      csrf: "c",
      platformAdmin: false,
      products: [],
      permissions: {
        roles: [],
        platform: { view: platform, edit: platform },
        products: { djdl: { view: ["signin"], edit: ["signin"] } },
      },
    });
    testQueryClient().setQueryData(qk.me(), me(["console"]));
    const { unmount } = renderAt(
      "#/p/djdl/app-sign-in",
      <ProductSettingsSection
        slug="djdl"
        area="identity.signIn"
        id="s"
        title="Display name"
      />,
    );
    const card = await screen.findByRole("region", { name: "Display name" });
    await within(card).findByText("Approved display name");
    expect(within(card).queryByRole("switch")).toBeNull();
    expect(
      within(card).getByText(/^Only platform admins change this\./),
    ).toBeTruthy();
    unmount();

    testQueryClient().setQueryData(qk.me(), me(["console", "platform"]));
    renderAt(
      "#/p/djdl/app-sign-in",
      <ProductSettingsSection
        slug="djdl"
        area="identity.signIn"
        id="s"
        title="Display name"
      />,
    );
    const open = await screen.findByRole("region", { name: "Display name" });
    expect(
      (await within(open).findByRole("switch")).hasAttribute("disabled"),
    ).toBe(false);
  });

  describe("a string row", () => {
    const id = setting("identity.platformSignIn.playGames.serverClientId", {
      label: "Play Games server client id",
      spec: {
        kind: "string",
        pattern: "^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$",
        maxLength: 100,
      },
      value: null,
      defaultValue: null,
      ownership: "claimable",
    });
    const mount = () => {
      fns.productSettings.mockResolvedValue({ settings: [id] });
      renderAt(
        "#/p/djdl/app-sign-in",
        <ProductSettingsSection
          slug="djdl"
          area="identity.platformSignIn"
          id="s"
          title="Platform sign-in"
        />,
      );
    };

    it("is a text field: no quotes or null, the format checked as typed, Save sends the text", async () => {
      fns.updateProductSetting.mockResolvedValue({ setting: id });
      mount();
      const field = (await screen.findByRole("textbox", {
        name: "Play Games server client id",
      })) as HTMLInputElement;
      expect(field.value).toBe("");
      expect(document.body.textContent).not.toContain("null");
      await userEvent.type(field, "not an id");
      expect(
        await screen.findByText("That isn't in the expected format."),
      ).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      await userEvent.clear(field);
      await userEvent.type(field, "123-web.apps.googleusercontent.com");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(fns.updateProductSetting).toHaveBeenCalledWith(
          "djdl",
          id.key,
          expect.objectContaining({
            value: "123-web.apps.googleusercontent.com",
          }),
        ),
      );
    });

    it("says a claimed id is another product's, inline", async () => {
      fns.updateProductSetting.mockRejectedValue(
        new HttpError(422, { reason: "value_claimed", message: "claimed" }),
      );
      mount();
      const field = await screen.findByRole("textbox", {
        name: "Play Games server client id",
      });
      await userEvent.type(field, "123-web.apps.googleusercontent.com");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(
        await screen.findByText("Another product already uses this id."),
      ).toBeTruthy();
    });
  });
});
