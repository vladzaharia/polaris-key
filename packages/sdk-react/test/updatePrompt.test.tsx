// `useLatestVersion` + `<UpdatePrompt>`.
//
// The two behaviours worth pinning: the hook does not poll a service the product does not run
// (D-21, and a 404 loop is the failure mode), and the banner does NOT steal focus — an
// available update is information, not a blocker.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { UpdatePrompt } from "../src/components/UpdatePrompt.js";
import { useLatestVersion } from "../src/update/useLatestVersion.js";
import { useUpdateDecision } from "../src/update/useUpdateDecision.js";
import type { UpdateCheck, UpdateDecision } from "@polaris-key/protocol/update";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisAdapter } from "../src/core/index.js";
import type { PolarisBridge } from "../src/desktop/bridge.js";
import {
  makeFakeBridge,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(cleanup);

/** `waitFor` treats a null RETURN as success — only a throw retries. This asserts inside the
 *  callback so the query actually waits for the element to appear. */
async function findEl<T extends Element>(
  container: HTMLElement,
  selector: string,
): Promise<T> {
  return (await waitFor(() => {
    const el = container.querySelector(selector);
    expect(el, selector).toBeTruthy();
    return el;
  })) as T;
}

const withUpdate = services("license", "config", "update");
const noUpdate = services("license", "config");

const newer = {
  version: "2.0.0",
  tag: "v2.0.0",
  url: "https://dl.example/2.0.0",
  updateAvailable: true,
};

function adapterWith(
  capabilities: ReturnType<typeof services>,
  invoke?: PolarisBridge["invoke"],
): PolarisAdapter {
  const bridge = makeFakeBridge(okBridgeState({ capabilities }));
  if (invoke) bridge.invoke = invoke;
  return desktopAdapter({
    bridge,
    now: () => NOW_SEC,
    expectServices: capabilities,
  });
}

function wrapperFor(adapter: PolarisAdapter) {
  return ({ children }: { children: ReactNode }) => (
    <PolarisKeyProvider productSlug="acme" adapter={adapter}>
      {children}
    </PolarisKeyProvider>
  );
}

// @pkey-feature update.check
describe("useLatestVersion", () => {
  it("checks once on mount and reports the newest build", async () => {
    const invoke = vi.fn(async () => newer);
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useLatestVersion(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.updateAvailable).toBe(true));
    expect(result.current.latest?.version).toBe("2.0.0");
    expect(invoke).toHaveBeenCalledWith("update", "check", {
      channel: undefined,
    });
    adapter.dispose();
  });

  it("does not poll at all when the product runs no Update service", async () => {
    const invoke = vi.fn(async () => newer);
    const adapter = adapterWith(noUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useLatestVersion(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.enabled).toBe(false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.latest).toBeNull();
    await act(async () => {
      expect(await result.current.check()).toBeNull();
    });
    adapter.dispose();
  });

  it("a host-supplied fetcher bypasses the adapter entirely — even with Update off", async () => {
    const invoke = vi.fn(async () => newer);
    const fetcher = vi.fn(async () => ({
      version: "9.9.9",
      tag: "v9.9.9",
      url: "https://internal/9.9.9",
      updateAvailable: true,
    }));
    const adapter = adapterWith(noUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useLatestVersion({ fetcher }), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.latest?.version).toBe("9.9.9"));
    expect(invoke).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("passes the channel through and records a failure without throwing", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("feed down");
    });
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useLatestVersion({ channel: "beta" }), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("update", "check", { channel: "beta" });
    expect(result.current.updateAvailable).toBe(false);
    adapter.dispose();
  });

  it("immediate:false defers the first check to the caller", async () => {
    const invoke = vi.fn(async () => newer);
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(
      () => useLatestVersion({ immediate: false }),
      { wrapper: wrapperFor(adapter) },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.check();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});

// @pkey-feature ui.kit
describe("UpdatePrompt", () => {
  function renderPrompt(
    capabilities: ReturnType<typeof services>,
    check: () => Promise<typeof newer>,
    props: Partial<Parameters<typeof UpdatePrompt>[0]> = {},
  ) {
    const adapter = adapterWith(capabilities, (async () =>
      check()) as PolarisBridge["invoke"]);
    const utils = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <UpdatePrompt {...props} />
      </PolarisKeyProvider>,
    );
    return { ...utils, adapter };
  }

  it("renders a polite status banner that does NOT steal focus", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => newer);
    const banner = await waitFor(() => within(container).getByRole("status"));
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(banner.textContent).toContain("2.0.0");
    // An update is not a blocker: no dialog, and focus stays where the user put it.
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(document.body);
    adapter.dispose();
  });

  it("renders nothing when the running build is current", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => ({
      ...newer,
      updateAvailable: false,
    }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.querySelector("[data-polaris-update]")).toBeNull();
    adapter.dispose();
  });

  it("renders nothing when the product runs no Update service", async () => {
    const { container, adapter } = renderPrompt(noUpdate, async () => newer);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(container.querySelector("[data-polaris-update]")).toBeNull();
    adapter.dispose();
  });

  it("dismiss removes the banner", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => newer);
    const dismiss = await findEl<HTMLButtonElement>(
      container,
      "[data-polaris-update-dismiss]",
    );
    fireEvent.click(dismiss);
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-update]")).toBeNull(),
    );
    adapter.dispose();
  });

  it("onUpdate receives the live check instead of opening a window", async () => {
    const onUpdate = vi.fn();
    const { container, adapter } = renderPrompt(withUpdate, async () => newer, {
      onUpdate,
    });
    const action = await findEl<HTMLButtonElement>(
      container,
      "[data-polaris-update-action]",
    );
    fireEvent.click(action);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0]?.latest?.url).toBe(newer.url);
    adapter.dispose();
  });

  it("variant=dialog uses the blocking MessageScreen contract", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => newer, {
      variant: "dialog",
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-polaris-update="dialog"]'),
      ).toBeTruthy(),
    );
    const dialog = within(container).getByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const action = within(dialog).getByRole("button", {
      name: /get the update/i,
    });
    // A blocking screen moves focus to its action (WCAG 2.4.3).
    await waitFor(() => expect(document.activeElement).toBe(action));
    adapter.dispose();
  });

  it("a prompt slot fully replaces the UI", async () => {
    const { container, adapter } = renderPrompt(withUpdate, async () => newer, {
      slots: {
        prompt: (ctx) => (
          <div data-testid="custom">{ctx.latest?.version ?? "none"}</div>
        ),
      },
    });
    await waitFor(() =>
      expect(within(container).getByTestId("custom").textContent).toBe("2.0.0"),
    );
    adapter.dispose();
  });
});

// ── wire v4: `useUpdateDecision` and `<UpdatePrompt source="decision">` ───────────────────────

const release = { version: "1.5.0", seq: 15 };
const full = { ...release, sha256: "a".repeat(64) };

/** Every answer plans/P3-01.md §2.8 defines for v4, by the state the prompt renders. */
const DECISIONS: Record<string, UpdateDecision> = {
  "none up-to-date": {
    action: "none",
    reason: "up-to-date",
    behind: false,
    discardStaged: false,
  },
  "none behind": {
    action: "none",
    reason: "behind",
    behind: true,
    discardStaged: false,
  },
  "code-ready": {
    action: "code-ready",
    release: full,
    critical: false,
    discardStaged: false,
  },
  binary: {
    action: "binary",
    method: "download",
    release: full,
    build: "macos-dmg",
    mandatory: false,
    critical: false,
    prestage: [],
    discardStaged: false,
  },
  "binary mandatory": {
    action: "binary",
    method: "download",
    release: full,
    build: "macos-dmg",
    mandatory: true,
    critical: false,
    prestage: [],
    discardStaged: false,
  },
  store: {
    action: "store",
    release,
    listingUrl: "https://apps.apple.com/app/id1234567890",
    mandatory: false,
    critical: false,
    discardStaged: false,
  },
  "store mandatory": {
    action: "store",
    release,
    listingUrl: null,
    mandatory: true,
    critical: false,
    discardStaged: true,
  },
  platform: {
    action: "platform",
    release,
    mandatory: false,
    critical: false,
    discardStaged: false,
  },
  "platform mandatory": {
    action: "platform",
    release,
    mandatory: true,
    critical: false,
    discardStaged: false,
  },
  blocked: { action: "blocked", reason: "app-floor", discardStaged: false },
};

const checkOf = (decision: UpdateDecision): UpdateCheck => ({
  channel: "stable",
  decision,
  feed: "network",
  record: "network",
  errors: [],
});

// @pkey-feature update.decide
describe("useUpdateDecision", () => {
  it("asks the adapter once on mount and reports the check, its boot value and lock", async () => {
    const invoke = vi.fn(async () => checkOf(DECISIONS["binary mandatory"]!));
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(
      () =>
        useUpdateDecision({
          channel: "latest",
          staged: { version: "1.5.0", channel: "stable" },
          skipVersion: "1.4.9",
        }),
      { wrapper: wrapperFor(adapter) },
    );
    await waitFor(() => expect(result.current.check).not.toBeNull());
    expect(invoke).toHaveBeenCalledWith("update", "decide", {
      channel: "latest",
      staged: { version: "1.5.0", channel: "stable" },
      skipVersion: "1.4.9",
    });
    expect(result.current.decision?.action).toBe("binary");
    expect(result.current.boot).toBe("optional");
    expect(result.current.undismissable).toBe(true);
    adapter.dispose();
  });

  it("never asks a product without the Update service", async () => {
    const invoke = vi.fn(async () => checkOf(DECISIONS.binary!));
    const adapter = adapterWith(noUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useUpdateDecision(), {
      wrapper: wrapperFor(adapter),
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(result.current.enabled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("records a refusal without throwing", async () => {
    const invoke = vi.fn(async () => {
      throw Object.assign(new Error("x"), { code: "service-unavailable" });
    });
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    const { result } = renderHook(() => useUpdateDecision(), {
      wrapper: wrapperFor(adapter),
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect((result.current.error as { code?: string }).code).toBe(
      "service-unavailable",
    );
    adapter.dispose();
  });
});

// @pkey-feature update.decide
describe('UpdatePrompt source="decision" — every v4 action', () => {
  function renderDecision(
    decision: UpdateDecision,
    props: Partial<Parameters<typeof UpdatePrompt>[0]> = {},
  ) {
    const adapter = adapterWith(withUpdate);
    const decider = vi.fn(async () => checkOf(decision));
    const utils = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <UpdatePrompt source="decision" decider={decider} {...props} />
      </PolarisKeyProvider>,
    );
    return { ...utils, adapter, decider };
  }

  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });

  it("none renders nothing, and up-to-date only with showWhenCurrent", async () => {
    for (const name of ["none up-to-date", "none behind"]) {
      const { container, adapter } = renderDecision(DECISIONS[name]!);
      await settle();
      expect(container.querySelector("[data-polaris-update]")).toBeNull();
      adapter.dispose();
      cleanup();
    }
    const { container, adapter } = renderDecision(
      DECISIONS["none up-to-date"]!,
      { showWhenCurrent: true },
    );
    await findEl(container, '[data-polaris-update="current"]');
    adapter.dispose();
  });

  for (const name of ["code-ready", "binary", "store", "platform"]) {
    it(`${name} is a dismissable banner`, async () => {
      const decision = DECISIONS[name]!;
      const onAction = vi.fn();
      const { container, adapter } = renderDecision(decision, { onAction });
      const banner = await findEl<HTMLElement>(
        container,
        `[data-polaris-update="${decision.action}"]`,
      );
      expect(banner.getAttribute("role")).toBe("status");
      expect(banner.textContent).toContain("1.5.0");
      expect(
        container.querySelector("[data-polaris-update-mandatory]"),
      ).toBeNull();
      fireEvent.click(
        container.querySelector("[data-polaris-update-action]") as Element,
      );
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction.mock.calls[0]?.[0]?.decision).toEqual(decision);
      fireEvent.click(
        container.querySelector("[data-polaris-update-dismiss]") as Element,
      );
      await waitFor(() =>
        expect(container.querySelector("[data-polaris-update]")).toBeNull(),
      );
      adapter.dispose();
    });
  }

  for (const name of [
    "binary mandatory",
    "store mandatory",
    "platform mandatory",
    "blocked",
  ]) {
    for (const variant of ["banner", "dialog"] as const) {
      it(`${name} (${variant}) is a prompt the player cannot dismiss, over a running app`, async () => {
        const decision = DECISIONS[name]!;
        const { container, adapter } = renderDecision(decision, { variant });
        const prompt = await findEl<HTMLElement>(
          container,
          `[data-polaris-update="${decision.action}"]`,
        );
        expect(prompt.hasAttribute("data-polaris-update-mandatory")).toBe(true);
        // No dismiss control.
        expect(
          container.querySelector("[data-polaris-update-dismiss]"),
        ).toBeNull();
        // Not a full-window modal: no v4 answer stops play (plans/P3-01.md §2.8).
        expect(prompt.getAttribute("role")).toBe("alert");
        expect(container.querySelector('[role="alertdialog"]')).toBeNull();
        expect(container.querySelector('[aria-modal="true"]')).toBeNull();
        expect(prompt.style.position).not.toBe("fixed");
        for (const el of Array.from(container.querySelectorAll("*")))
          expect((el as HTMLElement).style.position).not.toBe("fixed");
        adapter.dispose();
      });
    }
  }

  it("a dismissable decision with variant=dialog is the dialog, with a dismiss control", async () => {
    const { container, adapter } = renderDecision(DECISIONS.binary!, {
      variant: "dialog",
      onAction: vi.fn(),
    });
    const dialog = await waitFor(() =>
      within(container).getByRole("alertdialog"),
    );
    expect(dialog).toBeTruthy();
    expect(
      container.querySelector("[data-polaris-update-mandatory]"),
    ).toBeNull();
    fireEvent.click(
      container.querySelector("[data-polaris-update-dismiss]") as Element,
    );
    await waitFor(() =>
      expect(container.querySelector("[data-polaris-update]")).toBeNull(),
    );
    adapter.dispose();
  });

  it("store opens its listing URL by default", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container, adapter } = renderDecision(DECISIONS.store!);
    fireEvent.click(
      await findEl<HTMLButtonElement>(
        container,
        "[data-polaris-update-action]",
      ),
    );
    expect(open).toHaveBeenCalledWith(
      "https://apps.apple.com/app/id1234567890",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
    adapter.dispose();
  });

  it("code-ready and blocked offer no action without onAction", async () => {
    for (const name of ["code-ready", "blocked"]) {
      const { container, adapter } = renderDecision(DECISIONS[name]!);
      await findEl(container, "[data-polaris-update]");
      expect(
        container.querySelector("[data-polaris-update-action]"),
      ).toBeNull();
      // Only the dismiss control remains, and `blocked` has not even that.
      expect(
        container.querySelector(
          "[data-polaris-update] button:not([data-polaris-update-dismiss])",
        ),
      ).toBeNull();
      if (name === "blocked")
        expect(
          container.querySelector("[data-polaris-update] button"),
        ).toBeNull();
      adapter.dispose();
      cleanup();
    }
  });

  it("a decision slot replaces the UI, and dismiss is inert while locked", async () => {
    const { container, adapter } = renderDecision(DECISIONS.blocked!, {
      slots: {
        decision: (ctx) => (
          <button data-testid="slot" onClick={ctx.dismiss}>
            {ctx.decision?.action}
          </button>
        ),
      },
    });
    const slot = await waitFor(() => within(container).getByTestId("slot"));
    fireEvent.click(slot);
    await settle();
    expect(within(container).getByTestId("slot").textContent).toBe("blocked");
    adapter.dispose();
  });

  it('the default source is still "version" (useLatestVersion, update.check)', async () => {
    const invoke = vi.fn(async () => newer);
    const adapter = adapterWith(withUpdate, invoke as PolarisBridge["invoke"]);
    render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <UpdatePrompt />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("update", "check", {
        channel: undefined,
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "update",
      "decide",
      expect.anything(),
    );
    adapter.dispose();
  });
});
