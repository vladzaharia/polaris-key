// @vitest-environment jsdom
//
// @pkey-feature sync.keyring
//
// U-38.2: `useSyncLock` and `useRecoveryCode` over a scripted ring client (the engine itself is
// tested in keyring.test.ts): loading, locked, the unlock action and its refusal as state, a
// transport with no ring, and a failed read.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { PolarisContext } from "../src/react/context.js";
import { useRecoveryCode, useSyncLock } from "../src/react/useKeyring.js";
import type { PolarisAdapter } from "../src/core/index.js";
import { PolarisError } from "../src/core/types.js";
import {
  unsupportedKeyring,
  type RingStatus,
  type KeyringClient,
} from "../src/core/keyring.js";

afterEach(() => cleanup());

const status = (state: RingStatus["state"]): RingStatus => ({
  state,
  ringId: "rg_x",
  epoch: 1,
  recoverySet: true,
  persistence: "durable",
  canCreate: true,
});

/** A client that is locked until `recover` gets the right code. */
function scripted(): KeyringClient & { listeners: Set<() => void> } {
  let state: RingStatus["state"] = "locked";
  const listeners = new Set<() => void>();
  const base = unsupportedKeyring("runtime", "x");
  return {
    ...base,
    unsupported: null,
    listeners,
    status: async () => status(state),
    recover: async (code) => {
      if (code !== "RIGHT")
        throw new PolarisError("recovery-code-invalid", "not valid");
      state = "unlocked";
      for (const l of listeners) l();
      return status(state);
    },
    create: async () => ({ recoveryCode: "AAAA", ringId: "rg_x", epoch: 1 }),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

function wrapperFor(ring: KeyringClient) {
  const adapter = { keyring: ring } as unknown as PolarisAdapter;
  return ({ children }: { children: ReactNode }) => (
    <PolarisContext.Provider value={{ adapter }}>
      {children}
    </PolarisContext.Provider>
  );
}

describe("useSyncLock and useRecoveryCode", () => {
  it("follows the ring from locked to unlocked through the unlock action", async () => {
    const ring = scripted();
    const { result } = renderHook(
      () => ({ lock: useSyncLock(), code: useRecoveryCode() }),
      { wrapper: wrapperFor(ring) },
    );
    expect(result.current.lock.state).toBe("loading");
    await waitFor(() => expect(result.current.lock.state).toBe("locked"));
    let ok = true;
    await act(async () => {
      ok = await result.current.code.unlock("WRONG");
    });
    expect(ok).toBe(false);
    expect(result.current.code.error?.code).toBe("recovery-code-invalid");
    await act(async () => {
      ok = await result.current.code.unlock("RIGHT");
    });
    expect(ok).toBe(true);
    await waitFor(() => expect(result.current.lock.state).toBe("unlocked"));
    expect(result.current.code.error).toBeNull();
    // Unmounting stops following.
    cleanup();
    expect(ring.listeners.size).toBe(0);
  });

  it("hands the new code back once and keeps none in state", async () => {
    const { result } = renderHook(() => useRecoveryCode(), {
      wrapper: wrapperFor(scripted()),
    });
    let made: unknown;
    await act(async () => {
      made = await result.current.create();
    });
    expect(made).toMatchObject({ recoveryCode: "AAAA" });
    expect(JSON.stringify(result.current)).not.toContain("AAAA");
  });

  it("reports a transport with no ring without reading anything", () => {
    const ring = unsupportedKeyring("version", "no verb");
    const spy = vi.spyOn(ring, "status");
    const { result } = renderHook(() => useSyncLock(), {
      wrapper: wrapperFor(ring),
    });
    expect(result.current.state).toBe("unsupported");
    expect(result.current.unsupported?.reason).toBe("version");
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows a failed read as state", async () => {
    const ring = scripted();
    ring.status = async () => {
      throw new PolarisError("network", "down");
    };
    const { result } = renderHook(() => useSyncLock(), {
      wrapper: wrapperFor(ring),
    });
    await waitFor(() => expect(result.current.state).toBe("failed"));
    expect(result.current.error?.code).toBe("network");
  });
});
