// @pkey-feature update.check
//
// The update check is honest and shared (UK-47): a failed `update/version` carries a typed code
// (404 is not_found, 5xx server-error, 429 rate_limited, no connection network-error), the kit
// never says "You're up to date." after a failure or before an answer, and every component that
// asks the same source shares one request.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { UpdatePrompt } from "../src/components/UpdatePrompt.js";
import { LicenseGate } from "../src/components/LicenseGate.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import {
  NOW_SEC,
  discoveryBody,
  makeFakeBridge,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(cleanup);

const withUpdate = services("license", "config", "update");

function cookieAdapter(update: () => Response | Promise<Response>) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/.well-known/polaris.json"))
      return new Response(discoveryBody(withUpdate));
    if (url.includes("/update/version")) return update();
    return new Response(JSON.stringify({ authenticated: false, doc: null }));
  }) as typeof fetch;
  return browserAdapter({
    auth: "cookie",
    productSlug: "acme",
    fetchImpl,
    now: () => NOW_SEC,
    version: "1.0.0",
    expectServices: withUpdate,
  });
}

async function ready(adapter: { snapshot(): { phase: string } }) {
  await waitFor(() => expect(adapter.snapshot().phase).toBe("ready"));
}

describe("typed update codes", () => {
  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "server-error"],
    [503, "server-error"],
    [418, "http-error"],
  ])("a %i answer is %s", async (status, code) => {
    const adapter = cookieAdapter(() => new Response("{}", { status }));
    await ready(adapter);
    await expect(adapter.checkUpdate()).rejects.toMatchObject({
      code,
      status,
    });
    expect(adapter.snapshot().error.update?.code).toBe(code);
    adapter.dispose();
  });

  it("no connection is network-error", async () => {
    const adapter = cookieAdapter(() => {
      throw new TypeError("Failed to fetch");
    });
    await ready(adapter);
    await expect(adapter.checkUpdate()).rejects.toMatchObject({
      code: "network-error",
    });
    adapter.dispose();
  });

  it("a 200 that is not a release is a server error, never 'no update'", async () => {
    const adapter = cookieAdapter(
      () => new Response(JSON.stringify({ hello: "world" })),
    );
    await ready(adapter);
    await expect(adapter.checkUpdate()).rejects.toMatchObject({
      code: "server-error",
    });
    adapter.dispose();
  });

  it("a release is passed through as the four fields", async () => {
    const adapter = cookieAdapter(
      () =>
        new Response(
          JSON.stringify({
            version: "2.0.0",
            tag: "v2.0.0",
            url: "https://dl.example/2.0.0",
            extra: "dropped",
          }),
        ),
    );
    await ready(adapter);
    await expect(adapter.checkUpdate()).resolves.toEqual({
      version: "2.0.0",
      tag: "v2.0.0",
      url: "https://dl.example/2.0.0",
      updateAvailable: true,
    });
    adapter.dispose();
  });
});

describe("<UpdatePrompt showWhenCurrent> never says 'up to date' after a failure", () => {
  it("a 404 on update/version shows the failure and Try again, not 'You're up to date.'", async () => {
    let answer: () => Response = () => new Response("{}", { status: 404 });
    const adapter = cookieAdapter(() => answer());
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <UpdatePrompt showWhenCurrent />
      </PolarisKeyProvider>,
    );
    const failed = await waitFor(() => {
      const el = container.querySelector('[data-polaris-update="failed"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(container.textContent).not.toMatch(/up to date/i);
    expect(failed.querySelector("button")!.textContent).toBe("Try again");
    // Try again goes to the network, and a real answer replaces the failure.
    answer = () =>
      new Response(
        JSON.stringify({
          version: "1.0.0",
          tag: "v1.0.0",
          url: "https://dl.example/1.0.0",
        }),
      );
    fireEvent.click(failed.querySelector("button")!);
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-update="current"]')!.textContent,
      ).toBe("You're up to date."),
    );
    adapter.dispose();
  });

  it("renders nothing before the first answer", () => {
    const adapter = cookieAdapter(() => new Promise<Response>(() => undefined));
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <UpdatePrompt showWhenCurrent />
      </PolarisKeyProvider>,
    );
    expect(container.querySelector("[data-polaris-update]")).toBeNull();
    adapter.dispose();
  });
});

describe("one check behind every component", () => {
  it("two prompts and the gate's version block make one request", async () => {
    const invoke = vi.fn(async () => ({
      version: "2.0.0",
      tag: "v2.0.0",
      url: "https://dl.example/2.0.0",
      updateAvailable: true,
    }));
    const bridge = makeFakeBridge(
      okBridgeState({
        capabilities: withUpdate,
        blocked: { reason: "version-too-old", allowedRange: { min: "2.0.0" } },
      }),
    );
    bridge.invoke = invoke as PolarisBridge["invoke"];
    const adapter = desktopAdapter({
      bridge,
      now: () => NOW_SEC,
      expectServices: withUpdate,
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <UpdatePrompt />
        <UpdatePrompt variant="dialog" />
        <LicenseGate>
          <div />
        </LicenseGate>
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(container.querySelectorAll("[data-polaris-update]").length).toBe(
        2,
      ),
    );
    expect(
      container.querySelector('[data-polaris-gate="version-block"]'),
    ).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});

describe("a check that throws synchronously", () => {
  it("does not stick: the next check reaches the source again", async () => {
    const { SharedCheck } = await import("../src/update/sharedCheck.js");
    const shared = new SharedCheck();
    const boom = (): never => {
      throw new Error("sync boom");
    };
    expect(await shared.run(boom)).toBeNull();
    expect(shared.get().error?.message).toBe("sync boom");
    expect(shared.get().busy).toBe(false);
    const ok = vi.fn(async () => ({
      version: "1.0.0",
      tag: "v1.0.0",
      url: "https://dl.example/1",
      updateAvailable: false,
    }));
    expect(await shared.run(ok)).toMatchObject({ version: "1.0.0" });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(shared.get().error).toBeNull();
  });

  it("through the hook: a throwing fetcher, then a retry, hits the fetcher again", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { useLatestVersion } =
      await import("../src/update/useLatestVersion.js");
    const calls: number[] = [];
    const fetcher = vi.fn((): Promise<never> => {
      calls.push(1);
      if (calls.length === 1) throw new Error("sync");
      return Promise.resolve({
        version: "2.0.0",
        tag: "v2",
        url: "https://dl.example/2",
        updateAvailable: true,
      }) as never;
    });
    const bridge = makeFakeBridge(okBridgeState({ capabilities: withUpdate }));
    const adapter = desktopAdapter({
      bridge,
      now: () => NOW_SEC,
      expectServices: withUpdate,
    });
    const { result } = renderHook(() => useLatestVersion({ fetcher }), {
      wrapper: ({ children }) => (
        <PolarisKeyProvider productSlug="acme" adapter={adapter}>
          {children}
        </PolarisKeyProvider>
      ),
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    await act(async () => {
      await result.current.check();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.latest?.version).toBe("2.0.0");
    adapter.dispose();
  });
});

describe("links pass the kit's validator (DL14)", () => {
  it("an update link that is not https has no action, and nothing opens", async () => {
    const { openManageUrl } = await import("../src/components/PolarisLogin.js");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const bridge = makeFakeBridge(okBridgeState({ capabilities: withUpdate }));
    bridge.invoke = (async () => ({
      version: "2.0.0",
      tag: "v2",
      url: "javascript:alert(1)",
      updateAvailable: true,
    })) as never;
    const adapter = desktopAdapter({
      bridge,
      now: () => NOW_SEC,
      expectServices: withUpdate,
    });
    const { container } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <UpdatePrompt />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-update]")).toBeTruthy(),
    );
    expect(container.querySelector("[data-polaris-update-action]")).toBeNull();
    openManageUrl("javascript:alert(1)");
    openManageUrl("http://evil.example/x");
    expect(open).not.toHaveBeenCalled();
    openManageUrl("https://key.plrs.im/activate?product=acme");
    expect(open).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});
