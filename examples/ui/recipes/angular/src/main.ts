// Registering the elements is the import; Angular binds [input] as a property.
import { bootstrapApplication } from "@angular/platform-browser";
import { PolarisKey } from "@polaris-key/elements";

import { App } from "./app/app";

// ?theme=dark|light picks the scheme; anything else follows the system.
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "dark" || theme === "light")
  document.body.style.colorScheme = theme;
PolarisKey.fonts(false);
PolarisKey.theme({
  colorScheme: theme === "dark" || theme === "light" ? theme : "system",
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

bootstrapApplication(App).catch((e) => console.error(e));
