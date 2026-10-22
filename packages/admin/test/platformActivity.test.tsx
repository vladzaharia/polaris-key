import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { boot, resetConsole } from "./consoleHarness.js";

/**
 * Platform → Activity (ST-51): the product union with the Product facet, Timeline and Table, Load
 * more by cursor, CSV of the loaded rows, and the routed event drawer.
 */

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function item(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    at: 1_790_000_000,
    product: null,
    actor: { sub: "u1", name: "Ana Lima", email: "ana@example.com" },
    action: "platform.setting.set",
    target: { kind: "setting", id: "session.length" },
    summary: "Changed Session length from 30 days to 14 days",
    before: 30,
    after: 14,
    ...over,
  };
}

const FIRST = {
  items: [
    item("e1"),
    item("e2", {
      at: 1_789_990_000,
      product: "djdl",
      actor: { sub: "u2", name: "Jun Park", email: "" },
      action: "commerce.enable",
      target: null,
      summary: "Turned on Commerce",
      before: null,
      after: null,
    }),
  ],
  nextCursor: { beforeAt: 1_789_990_000, beforeId: "e2" },
};
const SECOND = {
  items: [
    item("e3", {
      at: 1_789_980_000,
      actor: { sub: "", name: "", email: "" },
      action: "kek.reseal",
      summary: "Re-sealed 12 values",
    }),
  ],
  nextCursor: null,
};

function activity(q: URLSearchParams) {
  if (q.get("id") === "e1") return { items: [item("e1")], nextCursor: null };
  return q.get("beforeId") ? SECOND : FIRST;
}

const main = (): HTMLElement => screen.getByRole("main");

describe("Platform → Activity", () => {
  it("lists every product's events and the platform's, asking for the union", async () => {
    const log = boot("#/platform/activity", {
      extra: { "/manage/api/platform/activity": activity },
    });
    await screen.findByRole("heading", { level: 1, name: "Activity" });
    const table = await screen.findByRole("table", { name: "Activity" });
    expect(within(table).getByText("Turned on Commerce")).toBeTruthy();
    expect(within(table).getByText("djdl", { exact: false })).toBeTruthy();
    expect(within(table).getAllByText("Platform").length).toBeGreaterThan(0);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["When", "Who", "What", "Product"]);
    const call = log.calls.find(
      (c) => c.path === "/manage/api/platform/activity",
    );
    expect(call?.query).toContain("product=all");
    expect(call?.query).toContain("since=");
    expect(main().textContent).toContain("2 events");
  });

  it("pages with Load more", async () => {
    boot("#/platform/activity", {
      extra: { "/manage/api/platform/activity": activity },
    });
    await screen.findByRole("table", { name: "Activity" });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Re-sealed 12 values");
    expect(main().textContent).toContain("3 events");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("filters on the server by product, and the choice is in the URL", async () => {
    const log = boot("#/platform/activity", {
      extra: { "/manage/api/platform/activity": activity },
    });
    await screen.findByRole("table", { name: "Activity" });
    await userEvent.click(screen.getByRole("combobox", { name: "Product" }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Platform" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toContain("product=platform"),
    );
    await waitFor(() =>
      expect(
        log.calls.some((c) => String(c.query).includes("product=platform")),
      ).toBe(true),
    );
  });

  it("opens an event in a drawer the URL names, with before and after", async () => {
    boot("#/platform/activity/e1", {
      extra: { "/manage/api/platform/activity": activity },
    });
    const drawer = await screen.findByRole("dialog");
    expect(
      await within(drawer).findByRole("heading", {
        name: "Changed Session length from 30 days to 14 days",
      }),
    ).toBeTruthy();
    expect(within(drawer).getByText("30")).toBeTruthy();
    expect(within(drawer).getByText("14")).toBeTruthy();
    expect(within(drawer).getByText("Ana Lima · ana@example.com")).toBeTruthy();
    expect(
      within(drawer).getByRole("button", { name: "Open the setting" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(window.location.hash).toBe("#/platform/activity"),
    );
  });

  it("says so when the event is gone", async () => {
    boot("#/platform/activity/nope", {
      extra: {
        "/manage/api/platform/activity": (q: URLSearchParams) =>
          q.get("id") ? { items: [], nextCursor: null } : FIRST,
      },
    });
    expect(await screen.findByText(/no longer in the log/)).toBeTruthy();
  });

  it("shows the first-run, filtered-empty and error states, each with Try again", async () => {
    const empty = { items: [], nextCursor: null };
    boot("#/platform/activity", {
      extra: { "/manage/api/platform/activity": empty },
    });
    await screen.findByText("No activity yet");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();
    resetConsole();
    boot("#/platform/activity?action=license.", {
      extra: { "/manage/api/platform/activity": empty },
    });
    await screen.findByText("No activity matches these filters");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();
    resetConsole();
    boot("#/platform/activity", {
      extra: {
        "/manage/api/platform/activity": new Response(
          JSON.stringify({ code: "internal", message: "boom" }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      },
    });
    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeTruthy();
  });

  it("sits in the Platform sidebar and passes axe in both views", async () => {
    boot("#/platform/activity?view=timeline", {
      extra: { "/manage/api/platform/activity": activity },
    });
    await screen.findByRole("list", { name: "Activity" });
    const nav = screen.getAllByRole("navigation", { name: "Console" })[0]!;
    expect(
      within(nav).getByRole("link", { name: "Activity" }).getAttribute("href"),
    ).toBe("#/platform/activity");
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
    cleanup();
    resetConsole();
    boot("#/platform/activity", {
      extra: { "/manage/api/platform/activity": activity },
    });
    await screen.findByRole("table", { name: "Activity" });
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });
});
