// English's second copy table loads on demand (screens after a network answer), and the browser
// runner's server cannot serve that chunk. The suites provide the whole table first, so a scene
// sees every string on its first render.
import { provideKitCopy } from "@polaris-key/react/kit";
import { KIT_COPY_EN_LEAN } from "@polaris-key/brand/kit-copy/lean";
import enRest from "../../../brand/src/generated/kit-copy/en-rest.json" with { type: "json" };

provideKitCopy("en", { ...KIT_COPY_EN_LEAN, ...enRest });
