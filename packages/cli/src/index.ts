import path from "node:path";
import { SERVICE_SLUGS } from "@polaris-key/manifest";
import {
  ADMIN_COOKIE_ENV,
  ADMIN_COOKIE_NAME,
  BUNDLE_USAGE,
  DEFAULT_BASE_URL,
  mintBundle,
} from "./bundle.js";
import {
  initManifest,
  loadManifest,
  normalizeModules,
  sdkSnippet,
  trustSnippet,
  validateLoadedManifest,
  type ProductModule,
} from "./manifest.js";

export {
  ADMIN_COOKIE_ENV,
  ADMIN_COOKIE_NAME,
  BUNDLE_USAGE,
  CSRF_HEADER,
  DEFAULT_BASE_URL,
  MAX_GRACE_DAYS,
  bundleFileName,
  mintBundle,
  type MintBundleOptions,
  type MintBundleResult,
} from "./bundle.js";

export {
  initManifest,
  loadManifest,
  normalizeModules,
  sdkSnippet,
  trustSnippet,
  validateLoadedManifest,
  type InitOptions,
  type InitResult,
  type LoadedManifest,
  type ProductModule,
  type ValidationMessage,
  type ValidationResult,
} from "./manifest.js";

export interface CliIo {
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

export async function runPkey(argv: string[], io: CliIo = {}): Promise<number> {
  const parsed = parseArgs(argv);
  const cwd = io.cwd ?? process.cwd();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    switch (parsed.command) {
      case "help":
      case "--help":
      case "-h":
        stdout.write(helpText());
        return 0;
      case "init":
        return await cmdInit(parsed, cwd, stdout);
      case "validate":
        return await cmdValidate(cwd, stdout);
      case "doctor":
        return await cmdDoctor(parsed, cwd, stdout);
      case "bundle":
        return await cmdBundle(parsed, cwd, stdout);
      case "trust":
        return cmdTrust(parsed, stdout);
      case "sdk":
        return cmdSdk(parsed, stdout);
      default:
        stderr.write(`Unknown command "${parsed.command}".\n\n${helpText()}`);
        return 2;
    }
  } catch (err) {
    stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2) as [
      string,
      string?,
    ];
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      i += 1;
    } else {
      flags[rawKey] = true;
    }
  }
  return { command, flags, positional };
}

async function cmdInit(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
  const basename =
    path
      .basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "my-product";
  const slug =
    flagString(parsed, "product") ?? flagString(parsed, "slug") ?? basename;
  const name = flagString(parsed, "name") ?? titleize(slug);
  const modules = normalizeModules(flagString(parsed, "modules"));
  const result = await initManifest({
    cwd,
    slug,
    name,
    modules,
    adminGroup: flagString(parsed, "admin-group"),
    releaseOwner: flagString(parsed, "release-owner"),
    releaseRepo: flagString(parsed, "release-repo"),
    force: flagBool(parsed, "force"),
  });
  stdout.write(
    `Created ${result.files.length} manifest file${result.files.length === 1 ? "" : "s"}:\n`,
  );
  for (const file of result.files)
    stdout.write(`- ${path.relative(cwd, file)}\n`);
  stdout.write("\nNext: pkey validate\n");
  return 0;
}

async function cmdValidate(
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
  const manifest = await loadManifest(cwd);
  const result = validateLoadedManifest(manifest);
  stdout.write(`Manifest: ${result.ok ? "valid" : "invalid"}\n`);
  stdout.write(
    `Modules: ${result.enabledModules.length ? result.enabledModules.join(", ") : "none"}\n`,
  );
  if (result.requiredSecrets.length)
    stdout.write(`Required secrets: ${result.requiredSecrets.join(", ")}\n`);
  for (const warning of result.warnings) {
    stdout.write(
      `warning ${warning.file}${warning.path}: ${warning.message}\n`,
    );
  }
  for (const error of result.errors) {
    stdout.write(`error ${error.file}${error.path}: ${error.message}\n`);
  }
  return result.ok ? 0 : 1;
}

async function cmdDoctor(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
  const localCode = await cmdValidate(cwd, stdout);
  const baseUrl = flagString(parsed, "base-url");
  const product = flagString(parsed, "product");
  if (!baseUrl || !product) {
    stdout.write(
      "\nRemote checks skipped. Pass --base-url and --product to check product discovery.\n",
    );
    return localCode;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(product)}/.well-known/polaris.json`;
  const res = await fetch(url);
  if (!res.ok) {
    stdout.write(`\nRemote discovery: failed (${res.status}) ${url}\n`);
    return 1;
  }
  const body = (await res.json()) as {
    signing?: unknown;
    trust?: unknown;
    services?: Record<string, { enabled?: unknown } | undefined>;
  };
  stdout.write(`\nRemote discovery: ok ${url}\n`);
  const enabled = Object.entries(body.services ?? {})
    .filter(([, service]) => service?.enabled === true)
    .map(([slug]) => slug);
  stdout.write(
    `Services enabled: ${enabled.length ? enabled.join(", ") : "none"}\n`,
  );
  stdout.write(
    `Signing keys exposed: ${JSON.stringify(body.signing ?? body.trust ?? {})}\n`,
  );
  return localCode;
}

/**
 * `pkey bundle` — mint one offline activation bundle. A thin shell over `mintBundle`: it reads
 * the flags, reads the admin session cookie out of the environment (the module itself never
 * touches `process.env`, so it stays testable), and prints what came back.
 */
async function cmdBundle(
  parsed: ParsedArgs,
  cwd: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
  const product = flagString(parsed, "product");
  const device = flagString(parsed, "device");
  const graceRaw = flagString(parsed, "grace-days");
  if (!product || !device || !graceRaw) throw new Error(BUNDLE_USAGE);

  const result = await mintBundle({
    cwd,
    product,
    deviceId: device,
    graceDays: Number(graceRaw),
    // `--no-config` is a boolean flag, so it is read with flagBool; see the parseArgs note in
    // helpText() about passing valueless flags last or with `=`.
    includeConfig: !flagBool(parsed, "no-config"),
    licenseId: flagString(parsed, "license"),
    baseUrl: flagString(parsed, "base-url"),
    out: flagString(parsed, "out"),
    force: flagBool(parsed, "force"),
    cookie: process.env[ADMIN_COOKIE_ENV],
  });

  const rel = path.relative(cwd, result.file);
  stdout.write(`Minted bundle ${result.bundleId}\n`);
  stdout.write(`- File: ${rel}\n`);
  stdout.write(`- Device: ${result.deviceId}\n`);
  stdout.write(
    `- Grace window: ${result.graceDays} day${result.graceDays === 1 ? "" : "s"} offline\n`,
  );
  // Which documents rode along is decided server-side by the product's enabled services, and
  // the mint response does not say — so claim nothing rather than guess.
  stdout.write(
    "\nNext: transfer this file to the offline machine and import it there.\n",
  );
  return 0;
}

function cmdTrust(
  parsed: ParsedArgs,
  stdout: Pick<NodeJS.WriteStream, "write">,
): number {
  const kid = flagString(parsed, "kid") ?? parsed.positional[0];
  const publicKey = flagString(parsed, "public-key") ?? parsed.positional[1];
  if (!kid || !publicKey)
    throw new Error("Usage: pkey trust --kid <kid> --public-key <base64url>");
  stdout.write(`${trustSnippet(kid, publicKey)}\n`);
  return 0;
}

function cmdSdk(
  parsed: ParsedArgs,
  stdout: Pick<NodeJS.WriteStream, "write">,
): number {
  const product = flagString(parsed, "product") ?? parsed.positional[0];
  const baseUrl = flagString(parsed, "base-url") ?? "https://key.example.com";
  if (!product)
    throw new Error(
      "Usage: pkey sdk --product <slug> [--base-url <url>] [--kid <kid> --public-key <key>]",
    );
  stdout.write(
    `${sdkSnippet({
      baseUrl,
      product,
      kid: flagString(parsed, "kid"),
      publicKey: flagString(parsed, "public-key"),
    })}\n`,
  );
  return 0;
}

function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true || parsed.flags[name] === "true";
}

function titleize(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function helpText(): string {
  return `pkey - Polaris Key platform CLI

Commands:
  pkey init [--product slug] [--name name] [--modules ${SERVICE_SLUGS.join(",")}]
  pkey validate
  pkey doctor [--base-url url --product slug]
  pkey trust --kid kid --public-key key
  pkey sdk --product slug [--base-url url] [--kid kid --public-key key]
  pkey bundle --product slug --device id --grace-days n [--no-config] [--license id]
              [--base-url url] [--out file] [--force]

pkey bundle mints one offline activation bundle and writes it to a file (default
<product>-<first 8 of device id>.pkeybundle; --base-url defaults to ${DEFAULT_BASE_URL}).
Copy that file to the air-gapped machine and import it there.

Environment:
  ${ADMIN_COOKIE_ENV}   Required by \`pkey bundle\`. The console's admin session cookie, as
                      \`${ADMIN_COOKIE_NAME}=<value>\` (the bare value is accepted too).
                      The admin API is authenticated by the console's browser session —
                      there is no API token yet — so copy the cookie from an authenticated
                      console tab: devtools -> Application -> Cookies -> the console origin.
                      It is a SHORT-LIVED session credential carrying full admin authority:
                      do not commit it, and do not export it into a shared shell.

Note: --no-config and --force take no value. A valueless flag swallows the next bare word, so
pass them last or as --no-config=true / --force=true.
`;
}
