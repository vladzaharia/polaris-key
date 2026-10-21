import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountMenu } from "../src/portal/components/AccountMenu.js";

afterEach(cleanup);

describe("portal account chip", () => {
  it("shows the person's name when there is one", () => {
    render(
      <AccountMenu
        account={{
          id: "a",
          name: "Mara Fennick",
          email: "mara@fennick.studio",
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Account: Mara Fennick" }),
    ).toBeTruthy();
  });

  it("falls back to the email when the name is empty or just the email", () => {
    render(
      <AccountMenu
        account={{ id: "a", name: " ", email: "mara@fennick.studio" }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Account: mara@fennick.studio" }),
    ).toBeTruthy();
    cleanup();
    render(
      <AccountMenu
        account={{
          id: "a",
          name: "mara@fennick.studio",
          email: "mara@fennick.studio",
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Account: mara@fennick.studio" }),
    ).toBeTruthy();
  });
});

describe("portal account menu: Open console (ST-30)", () => {
  const open = async (console?: string | null) => {
    render(
      <AccountMenu
        account={{
          id: "a",
          name: "Ada",
          email: "ada@x.io",
          ...(console !== undefined ? { console } : {}),
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Account:/ }));
    return screen.findByRole("menu");
  };

  it("an operator's account is offered the console, at the address the Worker names", async () => {
    const menu = await open("https://key.plrs.im/manage/");
    const item = await screen.findByRole("menuitem", { name: "Open console" });
    expect(menu.contains(item)).toBe(true);
    expect(item.getAttribute("href")).toBe("https://key.plrs.im/manage/");
  });

  it.each([[null], [undefined]])(
    "no entry for anyone else (%s)",
    async (value) => {
      await open(value);
      expect(
        screen.queryByRole("menuitem", { name: "Open console" }),
      ).toBeNull();
    },
  );
});
