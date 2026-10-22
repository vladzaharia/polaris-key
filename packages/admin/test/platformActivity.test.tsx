import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { boot, resetConsole } from "./consoleHarness.js";

/**
 * Platform → Activity (ST-51): platform events by default (D10) with the Product facet, the
 * platform's own action and target lists, Timeline and Table, Load more by cursor, CSV of the
 * loaded rows, and the routed event drawer.
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
  it("lists the platform's events by default and names a product's when one shows", async () => {
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
    expect(call?.query).toContain("product=platform");
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
    // The button went with the last page: focus is on the first new row.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Re-sealed 12 values"),
    );
  });

  it("filters on the server by product, and the choice is in the URL", async () => {
    const log = boot("#/platform/activity", {
      extra: { "/manage/api/platform/activity": activity },
    });
    await screen.findByRole("table", { name: "Activity" });
    await userEvent.click(
      screen.getByRole("combobox", { name: /^Product: Platform/ }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Any product" }),
    );
    await waitFor(() => expect(window.location.hash).toContain("product=all"));
    await waitFor(() =>
      expect(
        log.calls.some((c) => String(c.query).includes("product=all")),
      ).toBe(true),
    );
  });

  it("offers the platform's own actions and targets, and marks a set facet", async () => {
    boot("#/platform/activity?action=kek.", {
      extra: { "/manage/api/platform/activity": activity },
    });
    await screen.findByRole("table", { name: "Activity" });
    const action = screen.getByRole("combobox", { name: /^Action: / });
    expect(action.closest("[data-set]")).toBeTruthy();
    expect(
      screen
        .getByRole("combobox", { name: /^Actor: Anyone/ })
        .closest("[data-set]"),
    ).toBeNull();
    await userEvent.click(action);
    for (const label of [
      "Platform settings",
      "Key encryption",
      "API tokens",
      "Console sign-ins",
      "Trust policy",
    ])
      expect(await screen.findByRole("option", { name: label })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Licenses" })).toBeNull();
  });

  it("keeps the loaded pages when an event opens and closes, and focuses the row", async () => {
    boot("#/platform/activity", {
      extra: { "/manage/api/platform/activity": activity },
    });
    await screen.findByRole("table", { name: "Activity" });
    await userEvent.click(screen.getByRole("button", { name: /^Load more/ }));
    await screen.findByText("Re-sealed 12 values");
    const link = screen.getByRole("link", {
      name: "Turned on Commerce",
    });
    await userEvent.click(link);
    await screen.findByRole("dialog");
    expect(screen.getByText("Re-sealed 12 values")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(window.location.hash).toBe("#/platform/activity"),
    );
    expect(main().textContent).toContain("3 events");
    expect(
      screen.queryByRole("status", { name: /Loading activity/ }),
    ).toBeNull();
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

  it("shows a setting change's effective values in words, and a secret as Set", async () => {
    const snap = (effective: unknown) => ({
      stored: effective,
      version: 1,
      effective,
      source: "runtime",
    });
    const change = item("e9", {
      action: "platform.setting.set",
      target: { kind: "setting", id: "blobs.gc.graceDays" },
      summary: "Set blobs.gc.graceDays to 14",
      before: snap(30),
      after: snap(14),
    });
    boot("#/platform/activity/e9", {
      extra: {
        "/manage/api/platform/activity": () => ({
          items: [change],
          nextCursor: null,
        }),
      },
    });
    const drawer = await screen.findByRole("dialog");
    expect(
      await within(drawer).findByRole("heading", {
        name: "Blob collector grace period changed",
      }),
    ).toBeTruthy();
    expect(drawer.textContent).not.toContain("{");
    expect(drawer.textContent).toContain("Platform → Settings → Jobs");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Open the setting" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/platform/settings?setting=blobs.gc.graceDays",
      ),
    );
  });

  it("reads a secret's snapshot as Set and Not set", async () => {
    const secret = item("e8", {
      target: { kind: "setting", id: "x.secret" },
      before: { stored: { set: false }, version: 0, effective: { set: false } },
      after: { stored: { set: true }, version: 1, effective: { set: true } },
    });
    boot("#/platform/activity/e8", {
      extra: {
        "/manage/api/platform/activity": () => ({
          items: [secret],
          nextCursor: null,
        }),
      },
    });
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("Not set")).toBeTruthy();
    expect(within(drawer).getByText("Set")).toBeTruthy();
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

  it("answers a 403 with read-access copy, not edit access", async () => {
    boot("#/platform/activity", {
      extra: {
        "/manage/api/platform/activity": new Response(
          JSON.stringify({ code: "forbidden", message: "no" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      },
    });
    expect(await screen.findByText(/access to this/)).toBeTruthy();
    expect(main().textContent).not.toContain("edit access");
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
