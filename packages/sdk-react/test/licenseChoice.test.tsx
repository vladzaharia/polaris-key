// @vitest-environment jsdom
//
// @pkey-feature identity.choice
//
// I-10a.11: `useLicenseChoice(grant)` over `usePolarisAuth().choice` (the transcript replayer drives
// the bearer engine; this is the hook and the adapters): loading, the view, devices, a
// refusal as state with its fresh view, complete, cancel, the grant's expiry, and the desktop
// renderer's typed unsupported.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { PolarisContext } from "../src/react/context.js";
import { useLicenseChoice } from "../src/react/useLicenseChoice.js";
import type { PolarisAdapter } from "../src/core/index.js";
import type { ChoiceNamespace, LicenseChoiceView } from "../src/core/choice.js";
import { DesktopAdapter } from "../src/desktop/desktopAdapter.js";
import { makeFakeBridge, okBridgeState } from "./fixtures.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const VIEW = {
  state: "choose",
  choices: [{ id: "lic_a" }],
} as unknown as LicenseChoiceView;
const FRESH = {
  state: "choose",
  choices: [{ id: "lic_b" }],
} as unknown as LicenseChoiceView;

function wrapperFor(choice: Partial<ChoiceNamespace>) {
  const adapter = { choice } as unknown as PolarisAdapter;
  return ({ children }: { children: ReactNode }) => (
    <PolarisContext.Provider value={{ adapter }}>
      {children}
    </PolarisContext.Provider>
  );
}

describe("useLicenseChoice", () => {
  it("loads the view, then completes", async () => {
    const complete = vi.fn(async () => ({
      kind: "ok" as const,
      licenseId: "lic_a",
      subject: "ps_1",
      scope: "profile",
      attachable: true as const,
    }));
    const { result } = renderHook(() => useLicenseChoice("sg_1"), {
      wrapper: wrapperFor({
        licenses: async () => ({ kind: "ok", view: VIEW }),
        complete,
      }),
    });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.view).toBe(VIEW);
    await act(async () => {
      await result.current.complete({ kind: "keep" });
    });
    expect(complete).toHaveBeenCalledWith("sg_1", { kind: "keep" });
    expect(result.current.status).toBe("done");
    expect(result.current.attachable).toBe(true);
    expect(result.current.completed?.licenseId).toBe("lic_a");
  });

  it("shows the initial view with no read, and keeps a device_limit refusal's fresh view", async () => {
    const licenses = vi.fn();
    const { result } = renderHook(
      () => useLicenseChoice("sg_1", { initial: VIEW }),
      {
        wrapper: wrapperFor({
          licenses,
          complete: async () => ({
            kind: "refused",
            code: "device_limit",
            httpStatus: 409,
            view: FRESH,
            manageUrl: "https://example.test/manage",
          }),
        }),
      },
    );
    expect(result.current.status).toBe("ready");
    expect(licenses).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.complete({ kind: "license", licenseId: "lic_a" });
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.refusal?.code).toBe("device_limit");
    expect(result.current.view).toBe(FRESH);
  });

  it("reads devices for Replace and cancels", async () => {
    const devices = vi.fn(async () => ({
      kind: "ok" as const,
      view: { licenseId: "lic_a", devices: [] },
    }));
    const cancel = vi.fn(async () => ({ kind: "ok" as const }));
    const { result } = renderHook(
      () => useLicenseChoice("sg_1", { initial: VIEW }),
      { wrapper: wrapperFor({ devices: devices as never, cancel }) },
    );
    await act(async () => {
      await result.current.devices("lic_a");
    });
    expect(devices).toHaveBeenCalledWith("sg_1", "lic_a");
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.status).toBe("cancelled");
  });

  it("a spent grant is expired, and so is one past its lifetime", async () => {
    const spent = renderHook(() => useLicenseChoice("sg_1"), {
      wrapper: wrapperFor({
        licenses: async () => ({
          kind: "refused",
          code: "invalid_grant",
          httpStatus: 400,
        }),
      }),
    });
    await waitFor(() => expect(spent.result.current.status).toBe("expired"));

    vi.useFakeTimers();
    const aged = renderHook(
      () => useLicenseChoice("sg_2", { initial: VIEW, expiresIn: 10 }),
      { wrapper: wrapperFor({}) },
    );
    expect(aged.result.current.status).toBe("ready");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(aged.result.current.status).toBe("expired");
  });

  it("a thrown error is state and leaves the grant open", async () => {
    const boom = new Error("network down");
    const { result } = renderHook(
      () => useLicenseChoice("sg_1", { initial: VIEW }),
      {
        wrapper: wrapperFor({
          complete: async () => {
            throw boom;
          },
        }),
      },
    );
    await act(async () => {
      await result.current.complete({ kind: "keep" }).catch(() => undefined);
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBe(boom);
  });
});

describe("the desktop renderer", () => {
  it("answers the typed unsupported (runtime) from every choice call", async () => {
    const adapter = new DesktopAdapter({
      bridge: makeFakeBridge(okBridgeState()),
    } as never);
    for (const call of [
      () => adapter.choice.licenses("sg"),
      () => adapter.choice.devices("sg", "lic"),
      () => adapter.choice.complete("sg", { kind: "keep" }),
      () => adapter.choice.cancel("sg"),
    ])
      await expect(call()).rejects.toMatchObject({
        name: "UnsupportedError",
        feature: "identity.choice",
        reason: "runtime",
      });
  });
});
