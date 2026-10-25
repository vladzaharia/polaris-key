// Registering the elements is the import; Vue leaves pk-* alone (vite.config.js).
import "./app.css";
import { createApp } from "vue";
import { PolarisKey } from "@polaris-key/elements";

import App from "./App.vue";

// ?theme=dark|light picks the scheme; anything else follows the system.
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "dark" || theme === "light")
  document.body.style.colorScheme = theme;
PolarisKey.theme({
  colorScheme: theme === "dark" || theme === "light" ? theme : "system",
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

createApp(App).mount("#app");
