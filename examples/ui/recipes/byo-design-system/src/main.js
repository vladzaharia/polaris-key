// The gate in a host design system. Three seams, nothing else: host tokens mapped onto --pk-*
// (app.css), structure through ::part() (app.css), and the accent through theme.accent below.
// No style is written into a shadow root.
import "@polaris-key/elements";

import { STATES, gateInput } from "../../shared/tidewater.js";
import "./app.css";

// ?theme=dark|light picks the scheme; anything else follows the system.
const params = new URLSearchParams(location.search);
const scheme = params.get("theme");
if (scheme === "dark" || scheme === "light")
  document.body.style.colorScheme = scheme;

// The host's brand color goes in as theme.accent. The kit resolves it for contrast in the
// scheme in effect (DL13); a raw --pk-accent from the host would skip that.
document.getElementById("provider").theme = {
  colorScheme: scheme === "dark" || scheme === "light" ? scheme : "system",
  accent: "#b45309",
  product: { name: "Tidewater Studio", developer: "Harbor Audio" },
};

// ?state= pins the gate; the default shows the welcome screen, where the parts are on view.
const asked = params.get("state");
const gate = document.getElementById("gate");
gate.input = gateInput(STATES.includes(asked) ? asked : "needs-activation");
gate.addEventListener("pk-action", (e) => {
  const { key } = e.detail;
  if (key === "welcome.signIn" || key === "welcome.useKey")
    gate.input = gateInput("ok");
});
