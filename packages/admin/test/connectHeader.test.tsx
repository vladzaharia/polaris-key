/** Cloud Connect's header (CC-16.2): the h1, and the three route tabs. */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { KitProviders } from "../src/kit/KitProviders.js";
import { ConnectHeader } from "../src/console/sections/connect/ConnectHeader.js";

afterEach(cleanup);

describe("ConnectHeader", () => {
  it("draws the title and the Setup, Usage and Linked devices tabs", () => {
    render(
      <KitProviders>
        <ConnectHeader slug="acme" tab="connect-setup" />
      </KitProviders>,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Cloud Connect" }),
    ).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Cloud Connect" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Setup", "Usage", "Linked devices"]);
  });
});
