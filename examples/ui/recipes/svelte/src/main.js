// Registering the elements is the import; Svelte passes props to pk-* as properties.
import "./app.css";
import { mount } from "svelte";
import { PolarisKey } from "@polaris-key/elements";

import App from "./App.svelte";

// ?theme=dark|light picks the scheme; anything else follows the system.
const theme = new URLSearchParams(location.search).get("theme");
PolarisKey.theme({
  colorScheme: theme === "dark" || theme === "light" ? theme : "system",
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

mount(App, { target: document.getElementById("app") });
