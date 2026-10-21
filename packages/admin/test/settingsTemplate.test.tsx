/** The settings template's rail follows its own width, not the screen's (B-042). */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { SettingsTemplate } from "../src/console/templates/Settings.js";
import { resetCore, renderAt } from "./coreTestUtils.js";

afterEach(cleanup);

describe("SettingsTemplate", () => {
  it("B-042: the rail and the pills switch on the template's container width", () => {
    resetCore();
    renderAt(
      "#/p/djdl/settings",
      <SettingsTemplate
        jump
        header={<h1>Settings</h1>}
        sections={[
          { id: "a", title: "A" },
          { id: "b", title: "B" },
          { id: "c", title: "C" },
        ]}
      >
        <p>Body</p>
      </SettingsTemplate>,
    );
    const rail = screen.getByRole("navigation", {
      name: "On this page",
      hidden: true,
    });
    expect(rail.className).toContain("@min-[60rem]:block");
    expect(rail.className).not.toContain("xl:");
    expect(rail.parentElement!.className).toContain(
      "@min-[60rem]:grid-cols-[12rem_minmax(0,1fr)]",
    );
  });
});
