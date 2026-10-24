// The gate in a Tauri v2 window. The front end is plain web: registering the elements is the
// import, and `input` is set as a property. The Rust side (src-tauri/) is a reference only; it
// opens https links and nothing else. The Rust bridge that would feed the gate a real license
// is not shipped, so the gate runs on the Tidewater fixtures.
import { PolarisKey } from "@polaris-key/elements";

import { STATES, gateInput } from "../../shared/tidewater.js";
import "./app.css";

// ?theme=dark|light picks the scheme; anything else follows the system.
const params = new URLSearchParams(location.search);
const theme = params.get("theme");
PolarisKey.theme({
  colorScheme: theme === "dark" || theme === "light" ? theme : "system",
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

// ?state= pins the gate for one load; the default is the app behind a valid license.
const asked = params.get("state");
const gate = document.getElementById("gate");
gate.input = gateInput(STATES.includes(asked) ? asked : "ok");

// Welcome's buttons raise pk-action; a real app hands it to the SDK. Here either one grants.
gate.addEventListener("pk-action", (e) => {
  const { key } = e.detail;
  if (key === "welcome.signIn" || key === "welcome.useKey")
    gate.input = gateInput("ok");
});

// Links go through the opener plugin inside Tauri (capability: opener:allow-open-url, https
// only); in a plain browser they are ordinary links.
document.getElementById("help").addEventListener("click", async (e) => {
  if (!("__TAURI_INTERNALS__" in window)) return;
  e.preventDefault();
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(e.currentTarget.href);
});
