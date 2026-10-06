// The renderer: the React kit, unchanged, over the bridge the preload exposed. No credential,
// keyring or network code runs here.
import { createRoot } from "react-dom/client";
import { LicenseGate, PolarisKeyProvider } from "@polaris-key/react";

function App() {
  return <main>Licensed content</main>;
}

createRoot(document.getElementById("root")!).render(
  <PolarisKeyProvider productSlug="djdl" mode="desktop">
    <LicenseGate allowGrace>
      <App />
    </LicenseGate>
  </PolarisKeyProvider>,
);
