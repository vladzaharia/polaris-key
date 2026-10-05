// A licensed command-line tool in one file (SDK parity pass SP-N18): every Polaris Key verb
// (activate, sign-in with a terminal QR, devices, config, update, packs, doctor, …) is attached
// to the tool's own commander program, and the tool's real work is gated on the licence.

import { Command } from "commander";
import { PolarisKeyClient } from "@polaris-key/node";
import { registerPolarisCommands } from "@polaris-key/node/cli";
import pkey from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

const program = new Command("djdl").option("--base-url <url>");

// `version` is omitted: the client reads it from this package.json.
const client = () =>
  PolarisKeyClient.create({ productSlug: pkey.productSlug, trust: pkey.trust });

registerPolarisCommands(
  program,
  (opts) =>
    PolarisKeyClient.create({
      productSlug: opts.productSlug,
      trust: { pinnedKeys: opts.pinnedKeys },
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    }),
  {
    pinnedKeys: pkey.trust.pinnedKeys,
    productSlug: pkey.productSlug,
  },
);

program
  .command("download <url>")
  .description("The tool's own work, for licensed devices")
  .action(async (url: string) => {
    const c = await client();
    const { outcome } = await c.boot();
    if (outcome !== "ready") {
      console.error(
        "Not licensed here. Run `djdl activate <key>` or `djdl sign-in`.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`downloading ${url}…`);
  });

await program.parseAsync(process.argv);
