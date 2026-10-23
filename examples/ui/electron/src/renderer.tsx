// The renderer: the React kit over the bridge the preload exposed. No credential, keyring or
// network code runs here. The one theme line, `platform: "auto"`, turns on the desktop chrome
// (Windows, macOS, GNOME) from the host's OS, which comes over the bridge with its accent.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PolarisKeyProvider } from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";
import "@polaris-key/react/fonts.css";
import "@polaris-key/react/styles.css";
import "./app.css";

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
      <PolarisKeyGate theme={{ platform: "auto" }}>
        <App />
      </PolarisKeyGate>
    </PolarisKeyProvider>
  </StrictMode>,
);
