// The renderer: the React kit over the bridge the preload exposed. No credential, keyring or
// network code runs here. The window's chrome and the host's accent come over the bridge
// (`platform: "auto"`), so there is no theme code either.
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
      <PolarisKeyGate>
        <App />
      </PolarisKeyGate>
    </PolarisKeyProvider>
  </StrictMode>,
);
