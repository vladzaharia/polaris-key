// The Release client in both React transports (P1b-07, PARITY §5.5).
//
// @pkey-feature release.changelog release.download
//
// The browser conversation is pinned by the release-changelog transcript (transcripts.test.ts
// replays it over `fetchChangelog` and the URL builders). This file holds the adapters' half:
// the D-21 refusal before any dial, the refusal codes, the desktop path through `invoke`, and the
// `useChangelog` hook.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { useChangelog } from "../src/release/useChangelog.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { PolarisError } from "../src/core/types.js";
import {
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
  services,
} from "./fixtures.js";

afterEach(cleanup);

const ENTRIES = [
  {
    version: "1.2.0",
    tag: "v1.2.0",
    date: "2023-11-10T00:00:00Z",
    summary: "Faster sync.",
    url: "https://github.com/acme/acme/releases/tag/v1.2.0",
  },
  {
    version: "1.1.0",
    tag: "v1.1.0",
    date: null,
    summary: null,
    url: "https://github.com/acme/acme/releases/tag/v1.1.0",
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function browserWith(
  changelog: () => Response,
  opts: { release?: boolean } = {},
) {
  const inner = makeFakeFetch(null, {
    capabilities:
      opts.release === false
        ? services("license", "config")
        : services("license", "config", "release"),
  });
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/release/")) {
      calls.push(url);
      return changelog();
    }
    return inner(input, init);
  }) as typeof fetch;
  const adapter = browserAdapter({
    productSlug: "acme",
    fetchImpl,
    now: () => NOW_SEC,
    offlineStore: null,
    expectServices:
      opts.release === false
        ? services("license", "config")
        : services("license", "config", "release"),
  });
  return { adapter, calls };
}

describe("browser Release client", () => {
  it("reads the changelog, keeping a null summary null", async () => {
    const { adapter, calls } = browserWith(() => json({ entries: ENTRIES }));
    await expect(adapter.changelog()).resolves.toEqual(ENTRIES);
    expect(calls).toEqual(["https://key.plrs.im/acme/release/changelog"]);
  });

  it("builds the install and artifact URLs without a request", async () => {
    const { adapter, calls } = browserWith(() => json({}));
    await expect(adapter.installUrl()).resolves.toBe(
      "https://key.plrs.im/acme/release/install.sh",
    );
    await expect(adapter.downloadUrl("1.3.0", "acme", "arm64")).resolves.toBe(
      "https://key.plrs.im/acme/release/dl/1.3.0/acme-arm64",
    );
    await expect(
      adapter.downloadUrl("1.3.0", "acme", "arm64", { dmg: true }),
    ).resolves.toBe("https://key.plrs.im/acme/release/dl/1.3.0/acme-arm64.dmg");
    await expect(
      adapter.downloadUrl("1.3.0", "acme", "x86_64", { checksum: true }),
    ).resolves.toBe(
      "https://key.plrs.im/acme/release/dl/1.3.0/acme-x86_64?checksum=sha256",
    );
    expect(calls).toEqual([]);
  });

  it("a product without Release is service-disabled before any dial (D-21)", async () => {
    const { adapter, calls } = browserWith(() => json({ entries: ENTRIES }), {
      release: false,
    });
    for (const call of [
      () => adapter.changelog(),
      () => adapter.installUrl(),
      () => adapter.downloadUrl("1.0.0", "acme", "arm64"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "service-disabled" });
    }
    expect(calls).toEqual([]);
  });

  it("a refusal is release-refused, carrying the body's own code", async () => {
    for (const [status, body, wire] of [
      [401, { error: { code: "unauthorized" } }, "unauthorized"],
      [401, { error: "download_auth_required" }, "download_auth_required"],
      [403, { error: { code: "channel_not_allowed" } }, "channel_not_allowed"],
      [403, {}, "forbidden"],
    ] as const) {
      const { adapter } = browserWith(() => json(body, status));
      // Let the first load land, so its projection does not race the error bookkeeping.
      for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++)
        await new Promise((r) => setTimeout(r, 0));
      await expect(adapter.changelog()).rejects.toMatchObject({
        code: "release-refused",
        wireCode: wire,
      });
      expect(adapter.snapshot().error.release?.code).toBe("release-refused");
    }
  });

  it("any other failure is network", async () => {
    const { adapter } = browserWith(() => json({}, 500));
    await expect(adapter.changelog()).rejects.toMatchObject({
      code: "network",
    });
  });
});

describe("desktop Release client", () => {
  function bridgeWith(
    invoke?: (s: string, m: string, a?: unknown) => Promise<unknown>,
  ) {
    const calls: [string, string, unknown][] = [];
    const bridge = {
      ...makeFakeBridge(
        okBridgeState({
          capabilities: services("license", "config", "release"),
        }),
      ),
      ...(invoke
        ? {
            invoke: async (s: string, m: string, a?: unknown) => {
              calls.push([s, m, a]);
              return invoke(s, m, a);
            },
          }
        : {}),
    };
    return { bridge, calls };
  }

  async function ready(a: { snapshot(): { phase: string } }) {
    for (let i = 0; i < 50 && a.snapshot().phase === "loading"; i++)
      await new Promise((r) => setTimeout(r, 0));
  }

  it("crosses the bridge as release.changelog / installUrl / downloadUrl", async () => {
    const { bridge, calls } = bridgeWith(async (_s, m) =>
      m === "changelog" ? ENTRIES : `url:${m}`,
    );
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    await expect(a.changelog()).resolves.toEqual(ENTRIES);
    await expect(a.installUrl()).resolves.toBe("url:installUrl");
    await expect(
      a.downloadUrl("1.3.0", "acme", "arm64", { checksum: true }),
    ).resolves.toBe("url:downloadUrl");
    expect(calls).toEqual([
      ["release", "changelog", undefined],
      ["release", "installUrl", undefined],
      [
        "release",
        "downloadUrl",
        { version: "1.3.0", binary: "acme", arch: "arm64", checksum: true },
      ],
    ]);
    a.dispose();
  });

  it("a host refusal keeps its code as wireCode", async () => {
    const { bridge } = bridgeWith(async () => {
      throw Object.assign(new Error("refused"), { code: "unauthorized" });
    });
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    await expect(a.changelog()).rejects.toMatchObject({
      code: "release-refused",
      wireCode: "unauthorized",
    });
    a.dispose();
  });

  it("a host without invoke reports the release client unsupported", async () => {
    const { bridge } = bridgeWith();
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    await ready(a);
    await expect(a.changelog()).rejects.toBeInstanceOf(PolarisError);
    await expect(a.installUrl()).rejects.toMatchObject({
      code: "service-disabled",
    });
    a.dispose();
  });
});

describe("useChangelog()", () => {
  it("loads the entries through the adapter", async () => {
    const { adapter } = browserWith(() => json({ entries: ENTRIES }));
    function Probe(): JSX.Element {
      const c = useChangelog();
      return (
        <span data-testid="v">
          {c.enabled ? c.entries.map((e) => e.version).join(",") : "off"}
        </span>
      );
    }
    const { getByTestId } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <Probe />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(getByTestId("v").textContent).toBe("1.2.0,1.1.0"),
    );
  });

  it("is disabled, and requests nothing, for a product without Release", async () => {
    const { adapter, calls } = browserWith(() => json({ entries: ENTRIES }), {
      release: false,
    });
    function Probe(): JSX.Element {
      return (
        <span data-testid="v">{useChangelog().enabled ? "on" : "off"}</span>
      );
    }
    const { getByTestId } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <Probe />
      </PolarisKeyProvider>,
    );
    await waitFor(() => expect(getByTestId("v").textContent).toBe("off"));
    expect(calls).toEqual([]);
  });
});
