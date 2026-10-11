/** ST-08: the settings hub's tabs and heading, and the web-origins editor. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { renderAt, resetCore } from "./coreTestUtils.js";
import { SettingsHub } from "../src/console/sections/core/pages/SettingsHub.js";
import {
  OriginsEditor,
  originProblem,
} from "../src/console/components/OriginsEditor.js";
import { PageHeader } from "../src/ui/PageHeader.js";

afterEach(() => {
  cleanup();
  resetCore();
});

describe("Settings hub", () => {
  it("has one h1, six area tabs as links, and demotes the area's own header", () => {
    renderAt(
      "#/p/djdl/settings/features",
      <SettingsHub slug="djdl" page="services">
        <PageHeader title="Services" />
      </SettingsHub>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 2, name: "Services" }),
    ).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings areas" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "General",
      "Services",
      "Presentation",
      "Keys & secrets",
      "Members",
      "All settings",
    ]);
    expect(links[1]!.getAttribute("aria-current")).toBe("page");
    expect(links[2]!.getAttribute("href")).toBe(
      "#/p/djdl/settings/presentation",
    );
  });
});

describe("originProblem", () => {
  it.each([
    ["https://app.example.com", null],
    ["http://localhost:5173", null],
    [
      "https://a.example/x",
      "Write it the way a browser sends it: https://a.example",
    ],
    ["http://a.example", "Use https. Plain http works only for localhost."],
    ["https://*.example.com", "No wildcards or spaces."],
  ])("%s", (v, why) => expect(originProblem(v)).toBe(why));
});

describe("OriginsEditor", () => {
  function Host({ onChange }: { onChange: (n: string[]) => void }) {
    const [v, setV] = React.useState<string[]>(["https://a.example"]);
    return (
      <OriginsEditor
        id="o"
        value={v}
        onChange={(n) => {
          setV(n);
          onChange(n);
        }}
      />
    );
  }
  it("adds with Enter, refuses a repeat and a bad origin, and removes", async () => {
    const onChange = vi.fn();
    renderAt("#/", <Host onChange={onChange} />);
    const u = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Add a web origin" });
    await u.type(box, "https://b.example{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([
      "https://a.example",
      "https://b.example",
    ]);
    await u.type(box, "https://b.example{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Already in the list.",
    );
    await u.clear(box);
    await u.type(box, "nope{Enter}");
    expect(onChange).toHaveBeenCalledTimes(1);
    await u.click(
      screen.getByRole("button", { name: "Remove https://a.example" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(["https://b.example"]);
  });
});
