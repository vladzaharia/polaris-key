import { createNextPolarisKey } from "@polaris-key/server/next";
import polarisConfig from "../polaris.config"; // written by `pkey sdk --lang node --write`

export const polaris = createNextPolarisKey({ config: polarisConfig });
