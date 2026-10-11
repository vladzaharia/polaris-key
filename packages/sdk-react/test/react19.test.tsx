// This file runs in the dedicated React 19 Vitest project in vitest.config.ts. It is deliberately
// server-rendered: JSX/runtime compatibility is proven without relying on browser-only kit effects.

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PolarisKeyTheme, Welcome } from "@polaris-key/react/kit";

describe(`React ${React.version} kit rendering`, () => {
  it("uses the React 19 runtime and renders the public theme/component surface", () => {
    expect(React.version.split(".")[0]).toBe("19");

    const markup = renderToStaticMarkup(
      <PolarisKeyTheme theme={{ product: { name: "Tidewater" } }}>
        <Welcome input={{ elapsedMs: 60_000, gate: { status: "none" } }} />
      </PolarisKeyTheme>,
    );

    expect(markup).toContain('data-component="Welcome"');
    expect(markup).toContain("Tidewater");
  });
});
