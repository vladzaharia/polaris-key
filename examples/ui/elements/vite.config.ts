// Three pages: the live gate (index.html), the gate on fixtures (play.html) and the index of
// states (states.html).
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default {
  build: {
    rollupOptions: {
      input: {
        index: at("./index.html"),
        play: at("./play.html"),
        states: at("./states.html"),
      },
    },
  },
};
