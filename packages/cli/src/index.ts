import path from "node:path";
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
      case "trust":
        return cmdTrust(parsed, stdout);
      case "sdk":
        return cmdSdk(parsed, stdout);
      case "link":
        return cmdLink(parsed, stdout);
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
    modules?: unknown;
  };
  stdout.write(`\nRemote discovery: ok ${url}\n`);
  stdout.write(
    `Signing keys exposed: ${JSON.stringify(body.signing ?? body.trust ?? {})}\n`,
  );
  return localCode;
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

function cmdLink(
  parsed: ParsedArgs,
  stdout: Pick<NodeJS.WriteStream, "write">,
): number {
  const baseUrl = flagString(parsed, "base-url");
  const product = flagString(parsed, "product");
  const repo = flagString(parsed, "repo");
  if (!baseUrl || !product || !repo) {
    throw new Error(
      "Usage: pkey link --base-url <url> --product <slug> --repo <owner/name>",
    );
  }
  stdout.write(
    "Linking requires an authenticated admin session/API token in a future CLI release.\n",
  );
  stdout.write(
    `Prepared link request for product ${product} at ${baseUrl} from ${repo}.\n`,
  );
  stdout.write(
    "Use the admin Setup screen to complete repo linking for now.\n",
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
  pkey init [--product slug] [--name name] [--modules licensing,config,releases,oidc,edgeMint]
  pkey validate
  pkey doctor [--base-url url --product slug]
  pkey trust --kid kid --public-key key
  pkey sdk --product slug [--base-url url] [--kid kid --public-key key]
  pkey link --base-url url --product slug --repo owner/name
`;
}
