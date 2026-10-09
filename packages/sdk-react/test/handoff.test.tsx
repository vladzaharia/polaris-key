// @pkey-feature ui.kit identity.devicecode
//
// The bearer device-code hand-off through the drop-in sign-in card (UK-47): the real browser
// adapter in bearer mode over a scripted server (the `identity/auth/device/{start,poll}` routes),
// so what the card shows is what a page would show. The code and the sign-in page are on screen,
// Open browser opens the validated link, Copy copies the code, the countdown is the code's life,
// and Cancel stops the polling and hands the sign-in methods back with focus on Sign in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { PolarisLogin } from "../src/components/PolarisLogin.js";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import { memoryStore } from "../src/browser/bearer/store.js";
import { discoveryBody, services } from "./fixtures.js";

const BASE = "https://key.plrs.im";
const PIN = { k1: "A".repeat(43) };

type Poll = { status: number; body: unknown };

/** A server that answers discovery and the device-code routes, polling from a script. */
function scripted(polls: Poll[], start: Record<string, unknown> = {}) {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { "content-type": "application/json" },
      });
    switch (url.pathname) {
      case "/acme/.well-known/polaris.json":
        return new Response(discoveryBody(services("license", "identity")));
      case "/acme/.well-known/polaris-trust.jws":
        return new Response("", { status: 404 });
      case "/acme/identity/auth/device/start":
        return json({
          deviceCode: "dc-1",
          userCode: "WDJB-MJHT",
          verificationUri: `${BASE}/activate`,
          verificationUriComplete: `${BASE}/activate?code=WDJB-MJHT`,
          expiresIn: 600,
          interval: 5,
          ...start,
        });
      case "/acme/identity/auth/device/poll": {
        const next = polls.shift() ?? {
          status: 200,
          body: { status: "pending" },
        };
        return json(next.body, next.status);
      }
      default:
        return new Response("", { status: 404 });
    }
  }) as typeof fetch;
  return {
    fetchImpl,
    seen,
    polled: () => seen.filter((p) => p.endsWith("/poll")).length,
  };
}

function mount(fetchImpl: typeof fetch) {
  const adapter = new BrowserAdapter({
    productSlug: "acme",
    baseUrl: BASE,
    auth: "bearer",
    trust: { pinnedKeys: PIN },
    store: memoryStore("acme"),
    offlineStore: null,
    fetchImpl,
    expectServices: services("license", "identity"),
  });
  const view = render(
    <PolarisKeyProvider
      productSlug="acme"
      adapter={adapter}
      theme={{ copy: { productName: "Tidewater" } }}
    >
      <PolarisLogin />
    </PolarisKeyProvider>,
  );
  return { adapter, ...view };
}

const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startSignIn(container: HTMLElement) {
  await flush(10);
  const signIn = container.querySelector("[data-polaris-oidc]") as HTMLElement;
  expect(signIn).toBeTruthy();
  fireEvent.click(signIn);
  await flush(10);
  return signIn;
}

describe("the device-code hand-off (bearer)", () => {
  it("shows the code and the address, opens the validated link, copies the code", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    const server = scripted([]);
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    const card = container.querySelector('[data-polaris-handoff="waiting"]')!;
    expect(card).toBeTruthy();
    expect(card.querySelector("[data-polaris-code]")!.textContent).toBe(
      "WDJB-MJHT",
    );
    expect(
      card.querySelector("[data-polaris-code]")!.getAttribute("aria-label"),
    ).toBe("Sign-in code WDJB-MJHT");
    expect(card.querySelector("[data-polaris-handoff-url]")!.textContent).toBe(
      "Or go to key.plrs.im/activate",
    );
    expect(
      card.querySelector("[data-polaris-handoff-expires]")!.textContent,
    ).toBe("Code expires in 10:00");
    // The title is the hand-off's, the methods are gone, and the web draws no QR (DL14).
    expect(container.querySelector("h2")!.textContent).toBe(
      "Finish in your browser",
    );
    expect(container.querySelector("[data-polaris-methods]")).toBeNull();
    expect(container.querySelector("svg[role=img], canvas, img")).toBeNull();
    // The one primary has focus.
    const openBtn = card.querySelector(
      "[data-polaris-handoff-open]",
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(openBtn);
    fireEvent.click(openBtn);
    expect(open).toHaveBeenCalledWith(
      `${BASE}/activate?code=WDJB-MJHT`,
      "_blank",
      "noopener,noreferrer",
    );
    fireEvent.click(card.querySelector("[data-polaris-handoff-copy]")!);
    await flush(0);
    expect(write).toHaveBeenCalledWith("WDJB-MJHT");
    expect(card.querySelector("[data-polaris-handoff-copy]")!.textContent).toBe(
      "Copied",
    );
    adapter.dispose();
  });

  it("the countdown follows the code's life and the card turns to expired at 0:00", async () => {
    const server = scripted([], { expiresIn: 65, interval: 30 });
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    const text = () =>
      container.querySelector("[data-polaris-handoff-expires]")?.textContent;
    expect(text()).toBe("Code expires in 1:05");
    await flush(5_000);
    expect(text()).toBe("Code expires in 1:00");
    await flush(60_000);
    expect(
      container.querySelector('[data-polaris-handoff="expired"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain("That code or link has expired");
    const again = container.querySelector(
      "[data-polaris-handoff-again]",
    ) as HTMLElement;
    expect(document.activeElement).toBe(again);
    adapter.dispose();
  });

  it("Cancel stops the polling, gives the methods back and focuses Sign in", async () => {
    const server = scripted([]);
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    await flush(5_000);
    const before = server.polled();
    expect(before).toBeGreaterThan(0);
    fireEvent.click(
      container.querySelector("[data-polaris-handoff-cancel]") as HTMLElement,
    );
    await flush(0);
    // The methods are back, with no error and no "cancelled" screen.
    expect(container.querySelector("[data-polaris-handoff]")).toBeNull();
    expect(container.querySelector("[data-polaris-signin-error]")).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector("[data-polaris-oidc]"),
    );
    await flush(60_000);
    expect(server.polled()).toBe(before);
    expect(adapter.snapshot().busy.identity).toBe(false);
    adapter.dispose();
  });

  it("Escape cancels like the button", async () => {
    const server = scripted([]);
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    const card = container.querySelector("[data-polaris-handoff]")!;
    fireEvent.keyDown(card, { key: "Escape" });
    await flush(0);
    expect(container.querySelector("[data-polaris-handoff]")).toBeNull();
    adapter.dispose();
  });

  it("a refusal from the server lands in the card, under Sign in, and ends the hand-off", async () => {
    const server = scripted([{ status: 200, body: { status: "timeout" } }]);
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    await flush(5_000);
    expect(container.querySelector("[data-polaris-handoff]")).toBeNull();
    const err = container.querySelector("[data-polaris-signin-error]");
    expect(err).toBeTruthy();
    expect(err!.getAttribute("role")).toBe("alert");
    // Sign in is there to try again.
    expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy();
    adapter.dispose();
  });

  it("hides the Open control for a link that is not https, and leaves the code working", async () => {
    const server = scripted([], {
      verificationUriComplete: "javascript:alert(1)",
      verificationUri: "javascript:alert(1)",
    });
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    expect(container.querySelector("[data-polaris-handoff-open]")).toBeNull();
    expect(container.querySelector("[data-polaris-handoff-url]")).toBeNull();
    expect(container.querySelector("[data-polaris-code]")!.textContent).toBe(
      "WDJB-MJHT",
    );
    adapter.dispose();
  });
});
