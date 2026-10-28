// The kit loads the QR encoder and the settings, device and account rows on demand (src/kit/lazy.ts).
// The suite loads them first, as a host that awaits `preloadKitParts()` would, so a test sees a
// screen whole on its first render.
import { preloadKitParts } from "@polaris-key/react/kit";
import { preloadParts } from "../src/kit/lazy.js";

await Promise.all([preloadKitParts(), preloadParts()]);

// English's second copy table loads on demand too (screens after a network answer); the suite
// provides the whole table, so a test sees every string on its first render.
import { provideKitCopy } from "@polaris-key/react/kit";
import {
  KIT_COPY_EN_LEAN,
  loadKitCopyEnRest,
} from "@polaris-key/brand/kit-copy/lean";

provideKitCopy("en", { ...KIT_COPY_EN_LEAN, ...(await loadKitCopyEnRest()) });
