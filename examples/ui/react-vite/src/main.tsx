// Tidewater Studio, gated by Polaris Key: the provider owns the SDK, the gate draws every screen
// the license calls for, and the app renders once it holds. By default the provider runs on the
// Tidewater fixture (src/fixtures.ts); `--live` talks to the Worker in src/polaris.config.ts.
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import { desktopAdapter } from "@polaris-key/react/desktop";
import "@polaris-key/react/fonts.css";

import { App } from "./App";
import { tidewaterBridge } from "./fixtures";
import { polarisKey as samplePolarisKey } from "./polaris.config";
import "./app.css";

function Root() {
  // One adapter for the page's life: a new one would start the SDK over.
  const fixture = useMemo(
    () =>
      __POLARIS_LIVE__
        ? undefined
        : desktopAdapter({ bridge: tidewaterBridge() }),
    [],
  );
  const polarisKey = useMemo(
    () => ({
      ...samplePolarisKey,
      version: __APP_VERSION__,
      ...(fixture ? { adapter: fixture } : {}),
    }),
    [fixture],
  );
  return (
    <PolarisKeyProvider config={polarisKey}>
      <PolarisKeyGate returnUrl={location.href}>
        <App />
      </PolarisKeyGate>
    </PolarisKeyProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
