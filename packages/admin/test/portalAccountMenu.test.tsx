import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
