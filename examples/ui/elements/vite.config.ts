// Both pages: the gate (index.html) and the index of states (states.html).
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default {
  build: {
    rollupOptions: {
      input: { index: at("./index.html"), states: at("./states.html") },
    },
  },
};
