import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ActivityCursor,
  ActivityFilters,
  ActivityItem,
  ActivityPage as Page,
} from "../src/api.js";
import {
  expectNoAxeViolations,
  hashQuery,
  renderAt,
  resetCore,
} from "./coreTestUtils.js";

const activity =
  vi.fn<
    (
      slug: string,
      cursor?: ActivityCursor | null,
      limit?: number,
      filters?: ActivityFilters,
    ) => Promise<Page>
  >();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      activity: (...a: Parameters<typeof activity>) => activity(...a),
    },
  };
});

const { ApiError } = await import("../src/api.js");
const { ActivityPage } = await import("../src/console/pages/core/Activity.js");

const NOW = Math.floor(Date.now() / 1000);

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "a1",
    at: NOW - 60,
    actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
    action: "license.disable",
    target: { kind: "license", id: "lic_1" },
    summary: "Chargeback; customer notified",
    ...over,
  };
}

const mount = (hash = "#/p/djdl/activity") =>
  renderAt(hash, <ActivityPage slug="djdl" />);

beforeEach(() => {
  resetCore();
  activity.mockReset().mockResolvedValue({ items: [item()], nextCursor: null });
});
afterEach(cleanup);

describe("Core → Activity", () => {
  it("renders entries as verbs, with the actor and a link to the target (ACT-2)", async () => {
    mount();
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("disabled license")).toBeTruthy();
    const link = screen.getByRole("link", { name: "lic_1" });
    expect(link.getAttribute("href")).toBe("#/p/djdl/license/licenses/lic_1");
    // The raw code stays visible in the details.
    expect(screen.getByText("license.disable")).toBeTruthy();
  });

  it("shows runtime rows as Polaris Key", async () => {
    activity.mockResolvedValue({
      items: [
        item({
          actor: { sub: "", name: "", email: "" },
          action: "device.fingerprint.drift",
          target: { kind: "device", id: "dev_1" },
        }),
      ],
      nextCursor: null,
    });
    mount();
    expect(await screen.findByText("Polaris Key")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "dev_1" }).getAttribute("href"),
    ).toBe("#/p/djdl/devices/dev_1");
  });

  it("walks nextCursor on Load older", async () => {
    const user = userEvent.setup();
    activity
      .mockResolvedValueOnce({
        items: [item()],
        nextCursor: { beforeAt: NOW - 60, beforeId: "a1" },
      })
      .mockResolvedValueOnce({
        items: [
          item({
            id: "a0",
            at: NOW - 120,
            summary: "older one",
            action: "tier.create",
          }),
        ],
        nextCursor: null,
      });
    mount();
    await user.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByText("created tier")).toBeTruthy();
    expect(activity.mock.calls[1]![1]).toEqual({
      beforeAt: NOW - 60,
      beforeId: "a1",
    });
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("sends filters to the server and keeps them in the URL (A-2, ACT-1)", async () => {
    mount(
      "#/p/djdl/activity?action=license.&actor=system&kind=license&target=lic_9",
    );
    await waitFor(() => expect(activity).toHaveBeenCalled());
    expect(activity.mock.calls[0]![3]).toEqual({
      action: "license.",
      actor: "system",
      targetKind: "license",
      targetId: "lic_9",
    });
    expect((screen.getByLabelText("Target id") as HTMLInputElement).value).toBe(
      "lic_9",
    );
  });

  it("writes a date range to the URL and sends it as `since`", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Ada Lovelace");
    await user.click(screen.getByRole("combobox", { name: "Date range" }));
    await user.click(
      await screen.findByRole("option", { name: "Last 7 days" }),
    );
    await waitFor(() => expect(hashQuery().get("range")).toBe("7d"));
    await waitFor(() =>
      expect(activity.mock.calls.at(-1)![3]!.since).toBeGreaterThan(
        NOW - 8 * 86400,
      ),
    );
  });

  it("shows no-results with a clear action when filters match nothing", async () => {
    const user = userEvent.setup();
    activity.mockResolvedValue({ items: [], nextCursor: null });
    mount("#/p/djdl/activity?action=tier.");
    expect(
      await screen.findByText("No activity matches these filters"),
    ).toBeTruthy();
    await user.click(
      screen.getAllByRole("button", { name: /Clear filters/ })[0]!,
    );
    await waitFor(() => expect(hashQuery().get("action")).toBeNull());
  });

  it("searches the loaded entries", async () => {
    const user = userEvent.setup();
    activity.mockResolvedValue({
      items: [
        item(),
        item({
          id: "a2",
          summary: "rotated nightly",
          action: "key.prepare",
          target: null,
        }),
      ],
      nextCursor: null,
    });
    mount();
    await screen.findByText("disabled license");
    await user.type(screen.getByLabelText("Search"), "nightly");
    await waitFor(() =>
      expect(screen.queryByText("disabled license")).toBeNull(),
    );
    expect(screen.getByText("prepared signing key")).toBeTruthy();
  });

  it("shows a first-run empty state when there is no activity", async () => {
    activity.mockResolvedValue({ items: [], nextCursor: null });
    mount();
    expect(await screen.findByText("No activity yet")).toBeTruthy();
  });

  it("surfaces a load error with a working retry", async () => {
    const user = userEvent.setup();
    activity.mockRejectedValueOnce(new ApiError(500));
    mount();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
  });

  it("has a table view, remembered in the URL", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Ada Lovelace");
    await user.click(screen.getByRole("radio", { name: /Table/ }));
    await waitFor(() => expect(hashQuery().get("view")).toBe("table"));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("disabled license")).toBeTruthy();
  });

  it("never makes a time focusable (ACT-4) and passes axe", async () => {
    const { container } = mount();
    await screen.findByText("Ada Lovelace");
    for (const t of container.querySelectorAll("time"))
      expect(t.getAttribute("tabindex")).toBeNull();
    await expectNoAxeViolations(container);
  });
});
