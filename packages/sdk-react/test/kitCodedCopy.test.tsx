// @pkey-feature ui.kit license.activate
//
// English's wire-code texts (`core.codes.*`) are not in the bundled table (SP-47 size budget): the
// gate starts loading them as it mounts, ahead of the first fetch that could fail with a code. A
// coded refusal then shows the code's own message, never the generic fallback.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { copyFor } from "../src/kit/contract.js";
import { NOW_SEC, emptyBridgeState, makeFakeBridge } from "./fixtures.js";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

describe("a coded refusal in English", () => {
  it("shows the code's own message once the preloaded table has resolved", async () => {
    const bridge = makeFakeBridge(emptyBridgeState());
    bridge.submitKey = vi.fn(async () => ({
      kind: "refused" as const,
      code: "license_disabled",
      status: 403,
    }));
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    const { container } = render(
      <PolarisKeyProvider config={{ productSlug: "acme", adapter }}>
        <PolarisKeyGate theme={{ product: { name: "Acme Studio" } }}>
          <div>APP</div>
        </PolarisKeyGate>
      </PolarisKeyProvider>,
    );
    const control = (key: string) =>
      container.querySelector<HTMLButtonElement>(`button[data-key="${key}"]`);
    await waitFor(() => expect(control("welcome.useKey")).not.toBeNull());
    // The gate asked for the table at mount: it arrives with no error on screen yet.
    await waitFor(() =>
      expect(copyFor("en").has("core.codes.license_disabled.title")).toBe(true),
    );
    fireEvent.click(control("welcome.useKey")!);
    const field = await waitFor(() => {
      const f = container.querySelector<HTMLInputElement>("#pk-key");
      expect(f).not.toBeNull();
      return f!;
    });
    fireEvent.change(field, { target: { value: "pkey_acme_KEY" } });
    fireEvent.click(control("activate.submit")!);
    await waitFor(() =>
      expect(container.textContent).toContain(
        "This license has been disabled. Contact the developer.",
      ),
    );
    expect(container.textContent).not.toContain("Something went wrong");
    adapter.dispose();
  });
});
