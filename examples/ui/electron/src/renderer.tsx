// The renderer: the React kit over the bridge the preload exposed. No credential, keyring or
// network code runs here. The one theme line, `platform: "auto"`, turns on the desktop chrome
// (Windows, macOS, GNOME) from the host's OS, which comes over the bridge with its accent.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PolarisKeyProvider } from "@polaris-key/react";
import {
  NearbyApprover,
  NearbySignIn,
  PolarisKeyGate,
} from "@polaris-key/react/kit";
import "@polaris-key/react/fonts.css";
import "@polaris-key/react/styles.css";
import "./app.css";

// The e2e harness forces a chrome with PKEY_KIT_PLATFORM; the main process passes it as ?platform=.
const CHROMES = ["windows", "macos", "linux"] as const;
const forced = new URLSearchParams(location.search).get("platform");
const platform = CHROMES.find((c) => c === forced) ?? "auto";
// The nearby e2e opens one nearby sign-in screen on its own (main passes ?screen=).
const screen = new URLSearchParams(location.search).get("screen");

function Nearby({ which }: { which: string }) {
  return which === "nearby-approver" ? (
    <NearbyApprover theme={{ platform }} />
  ) : (
    <NearbySignIn theme={{ platform }} prompt={false} deviceName="Studio PC" />
  );
}

function App() {
  return (
    <main className="studio">
      <h1>Studio</h1>
      <p>Welcome back. Your sessions open here.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PolarisKeyProvider
      config={{
        productSlug: "tidewater",
        mode: "desktop",
        version: __APP_VERSION__,
      }}
    >
      {screen === "nearby-signin" || screen === "nearby-approver" ? (
        <Nearby which={screen} />
      ) : (
        <PolarisKeyGate theme={{ platform }}>
          <App />
        </PolarisKeyGate>
      )}
    </PolarisKeyProvider>
  </StrictMode>,
);
