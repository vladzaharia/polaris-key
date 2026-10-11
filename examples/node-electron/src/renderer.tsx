// The renderer: the React kit, unchanged, over the bridge the preload exposed. No credential,
// keyring or network code runs here.
import { createRoot } from "react-dom/client";
import {
  PolarisKeyProvider,
  type PolarisKeyConfig,
} from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";

const polarisKey = {
  productSlug: "djdl",
  mode: "desktop",
} satisfies PolarisKeyConfig;

function App() {
  return <main>Licensed content</main>;
}

createRoot(document.getElementById("root")!).render(
  <PolarisKeyProvider config={polarisKey}>
    <PolarisKeyGate>
      <App />
    </PolarisKeyGate>
  </PolarisKeyProvider>,
);
