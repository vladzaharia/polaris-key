import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import * as React from "react";
import { ApiError } from "../../src/api.js";
import { Callout } from "../../src/ui/Callout.js";
import { EmptyState } from "../../src/ui/EmptyState.js";
import { ErrorState } from "../../src/ui/ErrorState.js";
import { lastAnnouncement } from "../../src/ui/LiveRegion.js";
import { PageSkeleton } from "../../src/ui/Skeleton.js";
import { RefetchBar, useLoadingAnnouncement } from "../../src/ui/loading.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Callout", () => {
  it("is a status only when live (EMR-2)", () => {
    const { rerender } = render(
      <Callout tone="warning" title="Held">
        2 releases
      </Callout>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <Callout tone="warning" title="Held" live>
        2 releases
      </Callout>,
    );
    expect(screen.getByRole("status").textContent).toContain("Held");
  });

  it("signed keeps its text out of gold", () => {
    render(<Callout tone="signed" title="Signed by release key rk-2026-09" />);
    const title = screen.getByText("Signed by release key rk-2026-09");
    expect(title.className).toContain("text-fg-strong");
    expect(title.className).not.toMatch(/text-signed/);
    expect(document.querySelector("svg.fill-signed")).not.toBeNull();
  });

  it("renders an action", () => {
    render(
      <Callout tone="info" action={<button type="button">Review</button>}>
        x
      </Callout>,
    );
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });
});

describe("EmptyState", () => {
  it("first-run draws the stationary star, unanimated", () => {
    render(<EmptyState kind="first-run" title="No tiers yet" />);
    const star = document.querySelector("[data-empty=first-run] svg")!;
    expect(star).not.toBeNull();
    expect(star.getAttribute("class") ?? "").not.toMatch(/animate|rotate|spin/);
    expect(star.closest("[aria-hidden]")).not.toBeNull();
  });

  it("no-results names the filters and clears them", () => {
    const clear = vi.fn();
    render(
      <EmptyState
        kind="no-results"
        title="No licenses match"
        filters="status: expired"
        onClearFilters={clear}
      />,
    );
    expect(screen.getByText("status: expired")).toBeTruthy();
    expect(document.querySelector("[data-empty=no-results] svg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(clear).toHaveBeenCalled();
  });

  it("service-off scopes the glyph and action to the service", () => {
    render(
      <EmptyState
        kind="service-off"
        service="distribution"
        title="The Distribution service isn't enabled for DJDL."
        primaryAction={<button type="button">Enable Distribution</button>}
        docs="/docs/services/distribution/"
      />,
    );
    expect(
      document.querySelectorAll("[data-service=distribution]").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: /Docs/ }).getAttribute("href"),
    ).toBe("/docs/services/distribution/");
    expect(
      screen
        .getByRole("button", { name: "Enable Distribution" })
        .closest("[data-service=distribution]"),
    ).not.toBeNull();
  });
});

describe("ErrorState", () => {
  it("words an ApiError and offers Retry", () => {
    const retry = vi.fn();
    render(
      <ErrorState
        error={new ApiError(429, undefined, "rate_limited")}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Too many requests")).toBeTruthy();
    expect(screen.queryByText(/api 429/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });

  it("offers Copy details for an unknown refusal", () => {
    render(<ErrorState error={new ApiError(418, undefined, "teapot")} />);
    expect(screen.getByText("The server refused this")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy details/ })).toBeTruthy();
  });

  it("lists service coherence lines", () => {
    render(
      <ErrorState
        error={
          new ApiError(422, undefined, "bad_request", [
            "update_requires_distribution",
          ])
        }
      />,
    );
    expect(
      screen.getByText(/Update is a feed over what Distribution delivers/),
    ).toBeTruthy();
  });

  it("links back to the collection on not-found", () => {
    render(
      <ErrorState
        error={new ApiError(404)}
        context={{
          thing: "License",
          collectionHref: "#/p/djdl/license/licenses",
        }}
      />,
    );
    expect(screen.getByText("License not found")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Back to the list" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses");
  });
});

describe("loading", () => {
  it("PageSkeleton announces what is loading", () => {
    render(<PageSkeleton template="table" label="licenses" />);
    expect(screen.getByRole("status").textContent).toBe("Loading licenses…");
  });

  it.each(["table", "record", "form", "matrix", "dashboard"] as const)(
    "PageSkeleton %s renders",
    (t) => {
      render(<PageSkeleton template={t} />);
      expect(document.querySelector(`[data-skeleton=${t}]`)).not.toBeNull();
    },
  );

  it("useLoadingAnnouncement announces start and finish", () => {
    const { rerender } = renderHook(
      ({ loading }) => useLoadingAnnouncement("licenses", loading),
      {
        initialProps: { loading: true },
      },
    );
    expect(lastAnnouncement()).toBe("Loading licenses…");
    rerender({ loading: false });
    expect(lastAnnouncement()).toBe("Licenses loaded");
  });

  it("RefetchBar appears only after 400 ms", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<RefetchBar active={false} />);
    rerender(<RefetchBar active />);
    act(() => vi.advanceTimersByTime(399));
    expect(container.querySelector("[data-active]")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector("[data-active]")).not.toBeNull();
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe(
      "true",
    );
    rerender(<RefetchBar active={false} />);
    expect(container.querySelector("[data-active]")).toBeNull();
  });

  it("a quick refetch never shows the bar", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<RefetchBar active />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<RefetchBar active={false} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelector("[data-active]")).toBeNull();
  });
});

// keep React in scope for JSX under the classic runtime checks
void React;
