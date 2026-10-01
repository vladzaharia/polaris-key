// `useImportBundle()` — the hook over either adapter's `importBundle` (P1b-07).
//
// @pkey-feature core.bundle
//
// The verifier and both transports are proven in bundleImport.test.ts (node environment, every
// corpus vector). This file holds the hook's plumbing only, over a v3 desktop bridge whose host
// side is faked: an import resolves and reports `activation: "bundle"`; a refusal resolves to
// null and lands in `error` with the host's §7 step as `wireCode`.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { useImportBundle } from "../src/react/hooks.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import {
  emptyBridgeState,
  makeDoc,
  makeFakeBridge,
  makeConfig,
  NOW_SEC,
  services,
} from "./fixtures.js";

afterEach(cleanup);

describe("useImportBundle()", () => {
  it("imports, then reports the bundle activation; a refusal lands in error", async () => {
    const base = makeFakeBridge(
      emptyBridgeState({ capabilities: services("license", "config") }),
    );
    const bridge = {
      ...base,
      version: 3,
      async importBundle(jws: string) {
        if (jws !== "good")
          throw Object.assign(new Error("refused"), {
            code: "bundle-claims-rejected",
          });
        base.push(
          emptyBridgeState({
            capabilities: services("license", "config"),
            activation: "bundle",
            doc: makeDoc(),
            config: makeConfig(),
          }),
        );
        return {
          bundleId: "b1",
          imported: ["license", "config"] as ("license" | "config")[],
        };
      },
    };
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    let hook: ReturnType<typeof useImportBundle> | null = null;
    function Probe(): JSX.Element {
      hook = useImportBundle();
      return <span data-testid="a">{hook.activation ?? "none"}</span>;
    }
    const { getByTestId } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <Probe />
      </PolarisKeyProvider>,
    );
    await waitFor(() => expect(adapter.snapshot().phase).toBe("ready"));
    let refused: unknown = "unset";
    await act(async () => {
      refused = await hook!.importBundle("bad");
    });
    expect(refused).toBeNull();
    expect(hook!.error?.code).toBe("bundle-rejected");
    expect(hook!.error?.wireCode).toBe("bundle-claims-rejected");
    await act(async () => {
      await hook!.importBundle("good");
    });
    await waitFor(() => expect(getByTestId("a").textContent).toBe("bundle"));
    expect(hook!.error).toBeNull();
    adapter.dispose();
  });
});
