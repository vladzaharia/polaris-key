// The kit loads the QR encoder and the settings, device and account rows on demand (src/kit/lazy.ts).
// The suite loads them first, as a host that awaits `preloadKitParts()` would, so a test sees a
// screen whole on its first render.
import { preloadKitParts } from "@polaris-key/react/kit";
import { preloadParts } from "../src/kit/lazy.js";

await Promise.all([preloadKitParts(), preloadParts()]);
