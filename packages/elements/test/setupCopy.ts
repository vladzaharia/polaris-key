// English's second copy table loads on demand (screens after a network answer). The suite provides
// the whole table, so a test sees every string on its first render.
import {
  KIT_COPY_EN_LEAN,
  loadKitCopyEnRest,
} from "@polaris-key/brand/kit-copy/lean";
import { provideTable } from "../src/copy.js";

provideTable("en", { ...KIT_COPY_EN_LEAN, ...(await loadKitCopyEnRest()) });
