// English's second copy table loads on demand (screens after a network answer), and the kit draws
// nothing until it arrives. The suite provides the whole table to the built kit and to the source
// kit contract, so a test sees every string on its first render.
import { provideKitCopy } from "@polaris-key/react/kit";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";
import { provideTable } from "../../src/kit/contract.js";

provideKitCopy("en", KIT_COPY_EN);
provideTable("en", KIT_COPY_EN);
