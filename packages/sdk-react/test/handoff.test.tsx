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
import { LicenseGate } from "../src/components/LicenseGate.js";
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
    const well = container.querySelector("[data-polaris-code-well]")!;
    expect(well.querySelector("[data-polaris-code]")!.textContent).toBe(
      "WDJB-MJHT",
    );
    // The code is read once, under its label; Copy is inside the well and named for what it copies.
    expect(well.getAttribute("aria-label")).toBe("Sign-in code");
    expect(
      well.querySelector("[data-polaris-code]")!.getAttribute("aria-label"),
    ).toBeNull();
    const copyBtn = well.querySelector("[data-polaris-handoff-copy]")!;
    expect(copyBtn.getAttribute("aria-label")).toBe("Copy code");
    expect(card.querySelector("[data-polaris-handoff-url]")!.textContent).toBe(
      "Or go to key.plrs.im/activate",
    );
    expect(
      card.querySelector("[data-polaris-handoff-expires]")!.textContent,
    ).toBe("Code expires in 10:00");
    // The title is the hand-off's, headed by the product (icon and name); the methods are gone,
    // and the web draws no QR (DL14).
    expect(container.querySelector("h2")!.textContent).toBe(
      "Finish in your browser",
    );
    // The monogram tile (its initial) and the name, on one line.
    expect(
      container.querySelector("[data-polaris-handoff-header]")!.textContent,
    ).toBe("TTidewater");
    expect(container.querySelector("[data-polaris-methods]")).toBeNull();
    expect(container.querySelector("svg[role=img], canvas, img")).toBeNull();
    // Open browser is the one filled button and has focus; Cancel is a text action.
    const openBtn = card.querySelector(
      "[data-polaris-handoff-open]",
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(openBtn);
    const filled = [...container.querySelectorAll("button")].filter(
      (b) => (b as HTMLElement).style.background === "var(--pk-accent)",
    );
    expect(filled).toEqual([openBtn]);
    expect(
      (card.querySelector("[data-polaris-handoff-cancel]") as HTMLElement).style
        .background,
    ).toBe("transparent");
    fireEvent.click(openBtn);
    expect(open).toHaveBeenCalledWith(
      `${BASE}/activate?code=WDJB-MJHT`,
      "_blank",
      "noopener,noreferrer",
    );
    fireEvent.click(copyBtn);
    await flush(0);
    expect(write).toHaveBeenCalledWith("WDJB-MJHT");
    expect(
      card.querySelector("[data-polaris-handoff-status]")!.textContent,
    ).toBe("Copied");
    adapter.dispose();
  });

  it("the countdown is never announced: its nearest live ancestor is off", async () => {
    const server = scripted([]);
    const { container, adapter } = mount(server.fetchImpl);
    const view = (
      <PolarisKeyProvider
        productSlug="acme"
        adapter={adapter}
        theme={{ copy: { productName: "Tidewater" } }}
      >
        <LicenseGate>
          <div />
        </LicenseGate>
      </PolarisKeyProvider>
    );
    cleanup();
    const gated = render(view);
    void container;
    await flush(10);
    fireEvent.click(gated.container.querySelector("[data-polaris-oidc]")!);
    await flush(10);
    const countdown = gated.container.querySelector(
      "[data-polaris-handoff-expires]",
    )!;
    // Walk up from the countdown: the first element that sets a live behaviour decides.
    let live: string | null = null;
    for (let el: Element | null = countdown; el; el = el.parentElement) {
      const explicit = el.getAttribute("aria-live");
      const role = el.getAttribute("role");
      if (explicit) {
        live = explicit;
        break;
      }
      if (role === "status" || role === "alert" || role === "log") {
        live = "polite";
        break;
      }
    }
    expect(live).toBe("off");
    // The gate around it is polite (its screens announce); the countdown is carved out of it.
    expect(
      gated.container
        .querySelector("[data-polaris-gate]")!
        .getAttribute("aria-live"),
    ).toBe("polite");
    // And the text really does change every second.
    const text = () => countdown.textContent;
    const before = text();
    await flush(2_000);
    expect(text()).not.toBe(before);
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
    // The title names the state; the message is the catalog's, with no fixed lifetime claim.
    expect(container.querySelector("h2")!.textContent).toBe("Code expired");
    const message = container.querySelector(
      "[data-polaris-handoff-expired]",
    ) as HTMLElement;
    expect(message.textContent).toBe(
      "The code expired before sign-in finished. Start again.",
    );
    expect(container.textContent).not.toMatch(/10 minutes/);
    const again = container.querySelector(
      "[data-polaris-handoff-again]",
    ) as HTMLElement;
    expect(again.textContent).toBe("Sign in again");
    expect(again.getAttribute("aria-describedby")).toBe(message.id);
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

  it("Escape cancels from anywhere on the page, not only from inside the card", async () => {
    const server = scripted([]);
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await flush(0);
    expect(container.querySelector("[data-polaris-handoff]")).toBeNull();
    adapter.dispose();
  });

  it("a Sign in again right after Cancel is not undone by the first flow's late clean-up", async () => {
    const server = scripted([]);
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    fireEvent.click(
      container.querySelector("[data-polaris-handoff-cancel]") as HTMLElement,
    );
    // The new sign-in begins before the cancelled wait has finished unwinding.
    fireEvent.click(container.querySelector("[data-polaris-oidc]")!);
    await flush(50);
    expect(
      container.querySelector('[data-polaris-handoff="waiting"]'),
    ).toBeTruthy();
    expect(adapter.snapshot().busy.identity).toBe(true);
    await flush(10_000);
    expect(adapter.snapshot().busy.identity).toBe(true);
    adapter.dispose();
  });

  it("a card that unmounts stops the sign-in it started", async () => {
    const server = scripted([]);
    const { container, adapter, unmount } = mount(server.fetchImpl);
    await startSignIn(container);
    await flush(5_000);
    unmount();
    const before = server.polled();
    await flush(60_000);
    expect(server.polled()).toBe(before);
    expect(adapter.snapshot().busy.identity).toBe(false);
    adapter.dispose();
  });

  it("a refusal from the server lands in the card, under Sign in, with a glyph, and ends the hand-off", async () => {
    const server = scripted([{ status: 200, body: { status: "timeout" } }]);
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    await flush(5_000);
    expect(container.querySelector("[data-polaris-handoff]")).toBeNull();
    const err = container.querySelector("[data-polaris-signin-error]");
    expect(err).toBeTruthy();
    expect(err!.getAttribute("role")).toBe("alert");
    // An expired code says so (its own sentence), and the line is a word and a glyph.
    expect(err!.textContent).toBe(
      "The code expired before sign-in finished. Start again.",
    );
    expect(err!.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy();
    adapter.dispose();
  });

  it("links supplied but none usable: sign-in is unavailable, Cancel is the way out, no code", async () => {
    const server = scripted([], {
      verificationUriComplete: "javascript:alert(1)",
      verificationUri: "javascript:alert(1)",
    });
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    const card = container.querySelector('[data-polaris-handoff="unusable"]')!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain(
      "Sign-in is unavailable. Try again later.",
    );
    expect(container.querySelector("[data-polaris-handoff-open]")).toBeNull();
    expect(container.querySelector("[data-polaris-code]")).toBeNull();
    const cancel = container.querySelector(
      "[data-polaris-handoff-cancel]",
    ) as HTMLElement;
    expect(document.activeElement).toBe(cancel);
    // Not the hand-off's title, and Cancel is not dressed as the primary.
    expect(container.querySelector("h2")!.textContent).not.toBe(
      "Finish in your browser",
    );
    expect(cancel.style.background).not.toBe("var(--pk-accent)");
    fireEvent.click(cancel);
    await flush(0);
    expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy();
    adapter.dispose();
  });
});

describe("the hand-off inside the revoked and expired screens", () => {
  it("takes the hand-off's title and puts Try again away, and brings both back on Cancel", async () => {
    const fetchImpl = scripted([]).fetchImpl;
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
    // The signed state of a revoked device is a unit-test of the gate elsewhere; here the gate
    // is held on its revoked screen by a snapshot override.
    const real = adapter.snapshot.bind(adapter);
    let from: ReturnType<typeof real> | null = null;
    let out: ReturnType<typeof real> | null = null;
    adapter.snapshot = () => {
      const s = real();
      if (s !== from) {
        from = s;
        out = { ...s, status: "revoked", phase: "ready" } as typeof s;
      }
      return out!;
    };
    const { container } = render(
      <PolarisKeyProvider
        productSlug="acme"
        adapter={adapter}
        theme={{ copy: { productName: "Tidewater" } }}
      >
        <LicenseGate>
          <div />
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    await flush(10);
    expect(container.querySelector("h2")!.textContent).toBe("Signed out");
    const labels = () =>
      [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels()).toContain("Try again");
    fireEvent.click(container.querySelector("[data-polaris-oidc]")!);
    await flush(10);
    expect(container.querySelector("h2")!.textContent).toBe(
      "Finish in your browser",
    );
    expect(labels()).not.toContain("Try again");
    expect(container.querySelector("[data-polaris-code]")!.textContent).toBe(
      "WDJB-MJHT",
    );
    // The code sits in the head with the title, under the product's icon and name; only the
    // buttons are in the docked tail.
    const head = container.querySelector("[data-polaris-head]")!;
    expect(head.querySelector("[data-polaris-code]")).toBeTruthy();
    expect(
      head.querySelector("[data-polaris-handoff-header]")!.textContent,
    ).toBe("TTidewater");
    const tail = container.querySelector("[data-polaris-tail]")!;
    expect(tail.querySelector("[data-polaris-code]")).toBeNull();
    expect(tail.querySelector("[data-polaris-handoff-open]")).toBeTruthy();
    fireEvent.click(container.querySelector("[data-polaris-handoff-cancel]")!);
    await flush(0);
    expect(container.querySelector("h2")!.textContent).toBe("Signed out");
    expect(labels()).toContain("Try again");
    adapter.dispose();
  });
});

describe("an old error is not announced again", () => {
  it("Sign in after a failed sign-in, the code expiring, then Cancel: no stale alert comes back", async () => {
    const server = scripted([{ status: 200, body: { status: "timeout" } }]);
    const { container, adapter } = mount(server.fetchImpl);
    await startSignIn(container);
    await flush(5_000);
    expect(container.querySelector("[data-polaris-signin-error]")).toBeTruthy();
    // Sign in again: the error is cleared, the hand-off is up.
    fireEvent.click(container.querySelector("[data-polaris-oidc]")!);
    await flush(10);
    expect(container.querySelector("[data-polaris-signin-error]")).toBeNull();
    await flush(601_000);
    expect(
      container.querySelector('[data-polaris-handoff="expired"]'),
    ).toBeTruthy();
    fireEvent.click(container.querySelector("[data-polaris-handoff-cancel]")!);
    await flush(0);
    expect(container.querySelector("[data-polaris-oidc]")).toBeTruthy();
    expect(container.querySelector("[data-polaris-signin-error]")).toBeNull();
    expect(container.querySelector("[role=alert]")).toBeNull();
    adapter.dispose();
  });
});

describe("forced colours", () => {
  it("draws the primary as a solid system colour, and outlines the code well", async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q === "(forced-colors: active)",
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      const server = scripted([]);
      const { container, adapter } = mount(server.fetchImpl);
      await startSignIn(container);
      const open = container.querySelector(
        "[data-polaris-handoff-open]",
      ) as HTMLElement;
      expect(open.style.background.toLowerCase()).toBe("highlight");
      expect(open.style.color.toLowerCase()).toBe("highlighttext");
      // Forced colours would paint a Canvas backplate behind the label; the pair is kept.
      expect(open.getAttribute("style")).toMatch(/forced-color-adjust:\s*none/);
      expect(open.style.borderColor.toLowerCase()).toBe("highlight");
      const cancel = container.querySelector(
        "[data-polaris-handoff-cancel]",
      ) as HTMLElement;
      expect(cancel.style.background.toLowerCase()).not.toBe("highlight");
      expect(
        (
          container.querySelector("[data-polaris-code-well]") as HTMLElement
        ).style.border.toLowerCase(),
      ).toContain("canvastext");
      adapter.dispose();
    } finally {
      window.matchMedia = real;
    }
  });
});
