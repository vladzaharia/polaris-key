// tidewater: the demo CLI for Tidewater Studio by Harbor Audio, drawn by the Polaris Key terminal
// kit (docs: /docs/build/ui/frameworks/terminal-node/). Every Polaris Key verb comes from one
// `registerPolarisCommands` call; `tidewater` with no verb runs the license check a product
// makes before its own work.
//
// By default it runs against the fixture client in fixtures.ts, with no Worker. `--live` builds a
// real `PolarisKeyClient` instead.

import { Command } from "commander";
import { openInBrowser, PolarisKeyClient } from "@polaris-key/node";
import {
  checkFlow,
  registerPolarisCommands,
  runKitVerb,
  status,
  type CliVerb,
} from "@polaris-key/node/cli";
import { createFixtureClient } from "./fixtures.js";
import pkey from "./polaris.config.js";

const env = process.env;

const program = new Command("tidewater")
  .option("--live", "use a real Polaris Key Worker instead of the fixtures")
  .option("--product <slug>", "the product slug for --live")
  .option("--app-version <version>", "the version --live reports")
  .option(
    "--pinned-key <kid=key>",
    "a pinned trust key for --live (repeatable)",
    (v: string, all: string[]) => [...all, v],
    [] as string[],
  )
  .option("--base-url <url>", "the Worker's address for --live")
  .option("--config-dir <dir>", "where --live keeps the device's credentials")
  // The flags every kit verb takes, here for the default check (and handed on to a verb below).
  .option("--json", "JSON output for scripts")
  .option("--no-color", "plain text")
  .option("--ascii", "ASCII symbols only");

const live = (): boolean =>
  program.opts().live === true || env.TIDEWATER_LIVE === "1";

/** `kid=key` pairs from the flags, else TIDEWATER_PINNED_KEYS (`kid=key,kid=key` or JSON). */
function pinnedKeys(): Record<string, string> {
  const fromFlags: string[] = program.opts().pinnedKey;
  const raw = env.TIDEWATER_PINNED_KEYS?.trim();
  if (fromFlags.length === 0 && raw?.startsWith("{"))
    return JSON.parse(raw) as Record<string, string>;
  const pairs = fromFlags.length ? fromFlags : (raw?.split(",") ?? []);
  const keys = Object.fromEntries(
    pairs.map((p) => p.split("=").map((s) => s.trim()) as [string, string]),
  );
  return Object.keys(keys).length ? keys : pkey.trust.pinnedKeys;
}

/** The client for this run: the fixture, or with `--live` a real one. */
async function client(): Promise<PolarisKeyClient> {
  if (!live()) return createFixtureClient();
  const o = program.opts();
  const baseUrl: string | undefined = o.baseUrl ?? env.TIDEWATER_BASE_URL;
  const version: string | undefined = o.appVersion ?? env.TIDEWATER_VERSION;
  return PolarisKeyClient.create({
    productSlug: o.product ?? env.TIDEWATER_PRODUCT ?? pkey.productSlug,
    trust: { pinnedKeys: pinnedKeys() },
    // Omitted, the version is read from this sample's package.json.
    ...(version ? { version } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(o.configDir ? { configDir: o.configDir } : {}),
  });
}

program.hook("preAction", (_program, verb) => {
  if (live() && Object.keys(pinnedKeys()).length === 0)
    program.error(
      "--live needs the product's pinned keys: --pinned-key <kid=key>, TIDEWATER_PINNED_KEYS or polaris.config.ts.",
      { exitCode: 2 },
    );
  // The program reads `--json`, `--no-color` and `--ascii` wherever they are typed; the verb
  // runs with them.
  const o = program.opts();
  if (o.json) verb.setOptionValue("json", true);
  if (o.color === false) verb.setOptionValue("color", false);
  if (o.ascii) verb.setOptionValue("ascii", true);
});

// The fixtures never open a browser: the sign-in page and the device portal are real pages that
// know nothing of the fixture's code or key.
const io = { openUrl: (url: string) => (live() ? openInBrowser(url) : true) };

// Every Polaris Key verb, grouped under the kit's help page: activate, status, login, logout,
// devices, config, update, changelog, packs, doctor, completion, …
registerPolarisCommands(program, client, {
  productSlug: "tidewater",
  pinnedKeys: pkey.trust.pinnedKeys,
  bin: "tidewater",
  io,
});

// `tidewater` with no verb: the gate check a product runs before its own work, on the kit's
// rail and with the same `--json` envelope as every verb.
const check: CliVerb = {
  group: "license",
  path: ["check"],
  args: [],
  describe: "Check the license before Tidewater starts",
  describeKey: "cli.verb.status",
  run: (c) => status(c),
  flow: (ctx, c) => checkFlow(ctx, c!),
};

program.action(async () => {
  const o = program.opts();
  process.exitCode = await runKitVerb(
    check,
    [],
    {
      json: o.json === true,
      color: o.color !== false,
      ascii: o.ascii === true,
    },
    client,
    { slug: "tidewater", bin: "tidewater", io },
  );
  // Exit code 0: licensed, so Tidewater's own work would start here.
});

program.addHelpText(
  "after",
  `
Sample options:
  --live                   use a real Polaris Key Worker instead of the fixtures
  --product <slug>         the product slug (TIDEWATER_PRODUCT)
  --app-version <version>  the version reported (TIDEWATER_VERSION)
  --pinned-key <kid=key>   a pinned trust key, repeatable (TIDEWATER_PINNED_KEYS)
  --base-url <url>         the Worker's address (TIDEWATER_BASE_URL)
  --config-dir <dir>       where the device's credentials are kept
`,
);

await program.parseAsync(process.argv);
