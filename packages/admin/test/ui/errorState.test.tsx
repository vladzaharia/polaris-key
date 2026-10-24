import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as React from "react";
import { HttpError } from "../../src/api.js";
import { portalVoice } from "../../src/portal/errors.js";
import { ErrorState } from "../../src/ui/ErrorState.js";
import { ErrorVoiceProvider } from "../../src/ui/errorVoice.js";

afterEach(cleanup);

describe("ErrorState, console voice (the default)", () => {
  it("words the refusal through errorCopy and offers Try again", () => {
    const retry = vi.fn();
    render(<ErrorState error={new HttpError(500)} onRetry={retry} />);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-error-action")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a named failure reads "{thing} didn\'t load" with Retry and Copy details', () => {
    render(
      <ErrorState
        error={new HttpError(500)}
        thing="Licenses"
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText("Licenses didn't load")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy details/ })).toBeTruthy();
  });

  it("ignores the portal's props: no h1, no portal look", () => {
    render(<ErrorState error={new HttpError(500)} asPage page="Library" />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

describe("ErrorState, portal voice", () => {
  const withPortal = (ui: React.ReactElement) =>
    render(<ErrorVoiceProvider voice={portalVoice}>{ui}</ErrorVoiceProvider>);

  it("titles a network failure in the person's words and offers Retry", () => {
    const retry = vi.fn();
    withPortal(
      <ErrorState
        error={new HttpError(0, { code: "network" })}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      portalVoice.copy(new HttpError(0, { code: "network" }), {
        account: false,
      }).title,
    );
    fireEvent.click(
      screen.getByRole("button", { name: portalVoice.retryLabel }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry for a refusal that cannot be retried", () => {
    withPortal(
      <ErrorState
        error={new HttpError(404, { code: "not_found" })}
        onRetry={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: portalVoice.retryLabel }),
    ).toBeNull();
  });

  it("asPage makes the title the screen's h1", () => {
    withPortal(
      <ErrorState error={new HttpError(0, { code: "network" })} asPage />,
    );
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
          error={new HttpError(0, { code: "network" })}
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
      <ErrorState error={new HttpError(404, { code: "file_not_found" })} />,
    );
    const link = screen.getByRole("link", { name: portalVoice.helpLabel });
    expect(link.getAttribute("href")).toMatch(/^\/docs\//);
  });

  it("backTo adds the way out; Copy details carries the code and status", () => {
    withPortal(
      <ErrorState
        error={new HttpError(429, { code: "rate_limited" })}
        backTo={{ href: "#/", label: "Library" }}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Library" }).getAttribute("href"),
    ).toBe("#/");
    expect(
      portalVoice.details(new HttpError(429, { code: "rate_limited" })),
    ).toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    expect(screen.getByRole("button", { name: /Copy details/ })).toBeTruthy();
  });

  it("Try again leads and Copy details is the quiet second action, one row", () => {
    withPortal(
      <ErrorState error={new Error("boom")} onRetry={() => undefined} />,
    );
    const retry = screen.getByRole("button", { name: portalVoice.retryLabel });
    const copy = screen.getByRole("button", { name: /Copy details/ });
    expect(retry.getAttribute("data-variant")).toBe("outline");
    expect(copy.getAttribute("data-variant")).toBe("ghost");
    expect(retry.parentElement).toBe(copy.closest("div"));
    expect(
      retry.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("alert").className).toContain("max-w-xl");
  });

  it("after Try again, focus goes to the page h1 once content arrives", async () => {
    function Page(): React.ReactElement {
      const [state, setState] = React.useState<"error" | "loading" | "ok">(
        "error",
      );
      return (
        <main>
          {state === "error" ? (
            <ErrorState
              error={new Error("boom")}
              asPage
              page="Diceroll"
              message="Couldn't load Diceroll."
              onRetry={() => {
                setState("loading");
                setTimeout(() => setState("ok"), 20);
              }}
            />
          ) : state === "loading" ? (
            <div aria-busy="true">
              <h1>Loading</h1>
            </div>
          ) : (
            <h1>Diceroll</h1>
          )}
        </main>
      );
    }
    withPortal(<Page />);
    const retry = screen.getByRole("button", { name: portalVoice.retryLabel });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1, name: "Diceroll" }),
      ),
    );
  });

  it("in a card, Try again moves focus to the card's h2", async () => {
    function Card(): React.ReactElement {
      const [failed, setFailed] = React.useState(true);
      return (
        <section aria-labelledby="section-devices-h">
          <h2 id="section-devices-h">Devices</h2>
          {failed ? (
            <ErrorState
              error={new Error("boom")}
              message="Couldn't load your devices."
              onRetry={() => setFailed(false)}
            />
          ) : (
            <p>none</p>
          )}
        </section>
      );
    }
    withPortal(<Card />);
    const retry = screen.getByRole("button", { name: portalVoice.retryLabel });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("section-devices-h"),
    );
  });
});
