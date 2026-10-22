import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { ApiError } from "../../src/api.js";
import { PortalApiError } from "../../src/portal/api.js";
import { portalVoice } from "../../src/portal/errors.js";
import { ErrorPanel } from "../../src/portal/components/States.js";
import { ErrorState } from "../../src/ui/ErrorState.js";
import { ErrorVoiceProvider } from "../../src/ui/errorVoice.js";

afterEach(cleanup);

describe("ErrorState, console voice (the default)", () => {
  it("words the refusal through errorCopy and offers Try again", () => {
    const retry = vi.fn();
    render(<ErrorState error={new ApiError(500)} onRetry={retry} />);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-error-action")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a named failure reads "{thing} didn\'t load" with Retry and Copy details', () => {
    render(
      <ErrorState
        error={new ApiError(500)}
        thing="Licenses"
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText("Licenses didn't load")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy details/ })).toBeTruthy();
  });

  it("ignores the portal's props: no h1, no portal look", () => {
    render(<ErrorState error={new ApiError(500)} asPage page="Library" />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

describe("ErrorState, portal voice", () => {
  const withPortal = (ui: React.ReactElement) =>
    render(<ErrorVoiceProvider voice={portalVoice}>{ui}</ErrorVoiceProvider>);

  it("titles a network failure in the person's words and offers Retry", () => {
    const retry = vi.fn();
    withPortal(
      <ErrorState error={new PortalApiError(0, "network")} onRetry={retry} />,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      portalVoice.copy(new PortalApiError(0, "network"), { account: false })
        .title,
    );
    fireEvent.click(
      screen.getByRole("button", { name: portalVoice.retryLabel }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry for a refusal that cannot be retried", () => {
    withPortal(
      <ErrorState
        error={new PortalApiError(404, "not_found")}
        onRetry={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: portalVoice.retryLabel }),
    ).toBeNull();
  });

  it("asPage makes the title the screen's h1", () => {
    withPortal(<ErrorState error={new PortalApiError(0, "network")} asPage />);
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("page keeps its own h1 and message replaces the catch-all only", () => {
    withPortal(
      <>
        <ErrorState
          error={new Error("boom")}
          page="Diceroll"
          message="We couldn't load Diceroll."
        />
        <ErrorState
          error={new PortalApiError(0, "network")}
          message="We couldn't load Diceroll."
        />
      </>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Diceroll",
    );
    expect(screen.getAllByText("We couldn't load Diceroll.")).toHaveLength(1);
  });

  it("a refusal with a Help page links to it", () => {
    withPortal(
      <ErrorState error={new PortalApiError(404, "file_not_found")} />,
    );
    const link = screen.getByRole("link", { name: portalVoice.helpLabel });
    expect(link.getAttribute("href")).toMatch(/^\/docs\//);
  });

  it("backTo adds the way out; Copy details carries the code and status", () => {
    withPortal(
      <ErrorState
        error={new PortalApiError(429, "rate_limited")}
        backTo={{ href: "#/", label: "Library" }}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Library" }).getAttribute("href"),
    ).toBe("#/");
    expect(
      portalVoice.details(new PortalApiError(429, "rate_limited")),
    ).toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    expect(screen.getByRole("button", { name: /Copy details/ })).toBeTruthy();
  });

  it("ErrorPanel speaks portal even outside a provider", () => {
    render(
      <ErrorPanel
        error={new PortalApiError(0, "network")}
        asPage
        backToLibrary
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
