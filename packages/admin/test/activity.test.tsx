import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityCursor, ActivityItem, ActivityPage } from "../src/api.js";

// Mock the typed client: the Activity view should drive pagination purely off the `nextCursor`
// the `activity` endpoint returns — page 1 has a cursor, page 2 does not.
const activity = vi.fn();
vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return { ...actual, api: { ...actual.api, activity: (...args: unknown[]) => activity(...args) } };
});

import { Activity } from "../src/views/Activity.js";

function item(id: string, at: number, over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    at,
    actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
    action: "license.create",
    target: { kind: "license", id: "lic_1" },
    summary: `did thing ${id}`,
    ...over,
  };
}

beforeEach(() => {
  activity.mockReset();
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
});
afterEach(cleanup);

describe("Activity view", () => {
  it("renders the first page and walks nextCursor on Load more", async () => {
    const page1: ActivityPage = {
      items: [item("a3", 3000), item("a2", 2000)],
      nextCursor: { beforeAt: 2000, beforeId: "a2" },
    };
    const page2: ActivityPage = { items: [item("a1", 1000, { action: "key.revoke" })], nextCursor: null };
    activity.mockImplementation(async (_slug: string, cursor: ActivityCursor | null) =>
      cursor ? page2 : page1,
    );

    render(<Activity slug="djdl" />);

    // Page 1 rows render.
    await waitFor(() => expect(screen.getByText("did thing a3")).toBeTruthy());
    expect(screen.getByText("did thing a2")).toBeTruthy();
    expect(screen.queryByText("did thing a1")).toBeNull();

    // First call was cursor-less.
    expect(activity).toHaveBeenCalledTimes(1);
    expect(activity.mock.calls[0]![1]).toBeNull();

    // Load more walks the cursor returned by page 1.
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText("did thing a1")).toBeTruthy());
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity.mock.calls[1]![1]).toEqual({ beforeAt: 2000, beforeId: "a2" });

    // No more pages → the Load more button is gone, footer shows the count.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.getByText(/End of log · 3 entries/)).toBeTruthy();
  });

  it("shows an empty state when there is no activity", async () => {
    activity.mockResolvedValue({ items: [], nextCursor: null } satisfies ActivityPage);
    render(<Activity slug="djdl" />);
    await waitFor(() => expect(screen.getByText("No activity yet")).toBeTruthy());
  });

  it("surfaces a load error with a retry", async () => {
    activity.mockRejectedValueOnce(new Error("network down"));
    render(<Activity slug="djdl" />);
    await waitFor(() => expect(screen.getByText("network down")).toBeTruthy());
    expect(screen.getByText("Couldn’t load activity")).toBeTruthy();

    // Retry succeeds.
    activity.mockResolvedValueOnce({ items: [item("a1", 1000)], nextCursor: null } satisfies ActivityPage);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("did thing a1")).toBeTruthy());
  });

  it("renders the actor name and a relative time with an absolute title", async () => {
    activity.mockResolvedValue({
      items: [item("a1", Math.floor(Date.now() / 1000) - 3600)],
      nextCursor: null,
    } satisfies ActivityPage);
    render(<Activity slug="djdl" />);
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeTruthy());
    const time = screen.getByText(/hour ago/);
    expect(time.tagName).toBe("TIME");
    expect(within(time.closest("td")!).getByText(/hour ago/)).toBeTruthy();
  });
});
