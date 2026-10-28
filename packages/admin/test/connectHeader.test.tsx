/** Cloud Connect's header (CC-16.2): the h1, and no tab strip while Setup is the only page. */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { KitProviders } from "../src/kit/KitProviders.js";
import { ConnectHeader } from "../src/console/sections/connect/ConnectHeader.js";

afterEach(cleanup);

describe("ConnectHeader", () => {
  it("draws the title and no lone tab", () => {
    render(
      <KitProviders>
        <ConnectHeader slug="acme" tab="connect-setup" />
      </KitProviders>,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Cloud Connect" }),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Cloud Connect" }),
    ).toBeNull();
  });
});
