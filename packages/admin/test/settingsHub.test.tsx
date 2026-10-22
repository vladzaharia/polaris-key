/** ST-08: the settings hub's tabs and heading, and the web-origins editor. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { renderAt, resetCore, testQueryClient } from "./coreTestUtils.js";
import { qk } from "../src/console/data/queries.js";
import { ME } from "./consoleHarness.js";
import { SettingsHub } from "../src/console/sections/core/pages/SettingsHub.js";
import {
  OriginsEditor,
  originProblem,
} from "../src/console/components/OriginsEditor.js";

afterEach(() => {
  cleanup();
  resetCore();
});

describe("Settings hub", () => {
  it("has one h1, five tabs as links, History and All settings in the header, and no area header", () => {
    renderAt(
      "#/p/djdl/settings/features",
      <SettingsHub slug="djdl" page="services">
        <p>Body</p>
      </SettingsHub>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    const nav = screen.getByRole("navigation", { name: "Settings" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Features and general",
      "Presentation",
      "Polaris Locker",
      "Keys and secrets",
      "Members",
    ]);
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
    expect(links[1]!.getAttribute("href")).toBe(
      "#/p/djdl/settings/presentation",
    );
    expect(
      screen.getByRole("link", { name: "All settings" }).getAttribute("href"),
    ).toBe("#/p/djdl/settings/all");
    expect(
      screen.getByRole("link", { name: "History" }).getAttribute("href"),
    ).toBe("#/p/djdl/activity");
  });

  it("keeps Features current on the product's own settings route", () => {
    renderAt(
      "#/p/djdl/settings",
      <SettingsHub slug="djdl" page="settings">
        <p>Body</p>
      </SettingsHub>,
    );
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(nav)
        .getByRole("link", { name: "Features and general" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});

describe("the view-only notice (UX review M8)", () => {
  const viewOnly = () =>
    testQueryClient().setQueryData(qk.me(), {
      ...ME,
      platformAdmin: false,
      permissions: {
        platform: { view: [], edit: [] },
        products: { djdl: { view: ["core", "keys"], edit: [] } },
      },
    });
  it.each([
    ["services", "Settings"],
    ["settings", "Settings"],
    ["portal", "Settings"],
    ["presentation", "Settings"],
    ["keys", "Keys and secrets"],
  ] as const)(
    "%s: one callout, naming %s access and never Core",
    async (page, name) => {
      resetCore();
      viewOnly();
      renderAt(
        `#/p/djdl/settings/${page}`,
        <SettingsHub slug="djdl" page={page}>
          <p>Body</p>
        </SettingsHub>,
      );
      const notice = await screen.findByText("You can view these settings");
      expect(notice).toBeTruthy();
      expect(document.body.textContent).toContain(`${name} edit access`);
      expect(document.body.textContent).not.toMatch(/\bCore\b/);
      // The sentence is said once on the page.
      expect(screen.getAllByText(/edit access/)).toHaveLength(1);
    },
  );
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

  it("keeps focus in the editor: Add returns to the field, Remove to the next Remove or the field, and a problem describes it", async () => {
    renderAt("#/", <Host onChange={vi.fn()} />);
    const u = userEvent.setup();
    const box = screen.getByRole("textbox", { name: "Add a web origin" });
    await u.type(box, "https://b.example");
    await u.click(screen.getByRole("button", { name: "Add" }));
    expect(document.activeElement).toBe(box);
    await u.click(
      screen.getByRole("button", { name: "Remove https://a.example" }),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove https://b.example" }),
    );
    await u.click(
      screen.getByRole("button", { name: "Remove https://b.example" }),
    );
    expect(document.activeElement).toBe(box);
    await u.type(box, "nope{Enter}");
    const problem = await screen.findByRole("alert");
    expect(box.getAttribute("aria-describedby")).toContain(problem.id);
  });
});
