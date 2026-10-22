/**
 * `pkey dev` (SP-41): a local Polaris Key for integrators. The real Worker router runs in this
 * process on Node's built-in SQLite, with in-memory KV and Durable Object mocks, a seeded
 * product, throwaway keys, a test key per state and a fake IdP. The server is the bundle
 * `dist/dev/server.mjs` (`scripts/bundle-dev.mjs`), loaded here by a path built at run time, so the
 * publish Action's bundle of this CLI does not carry it.
 *
 * `pkey dev` serves. `pkey dev <command>` steers a running one over `/__dev/*`.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadManifest } from "./manifest.js";
import { UsageError } from "./errors.js";

export const DEV_DEFAULT_PORT = 8787;
export const DEV_CONFIG_FILE = "polaris-key.json";

/** The test keys, by the state each puts the licence in. A test holds this to the server's. */
export const DEV_KEYS = [
  "ok",
  "expired",
  "disabled",
  "revoked",
  "device-limit-full",
  "key-entry-limit",
  "floating",
] as const;

/** Control commands that act on one test key. */
export const DEV_KEY_COMMANDS = [
  "expire",
  "disable",
  "revoke",
  "restore",
  "fill-seats",
] as const;

export const DEV_USAGE = [
  "Usage: pkey dev [--port n] [--auto-approve] [--builtin] [--out file | --no-write]",
  "pkey dev keys|status",
  `pkey dev ${DEV_KEY_COMMANDS.join("|")} <key>`,
  "pkey dev config <name> <json> [--key <key>]",
  "pkey dev release <version> [--channel stable|beta|name]",
  "pkey dev offline|online",
];

type Out = Pick<NodeJS.WriteStream, "write">;

export interface DevArgs {
  /** The word after `dev`: a control command; absent: serve. */
  sub?: string | undefined;
  positional: string[];
  port?: number | undefined;
  url?: string | undefined;
  autoApprove: boolean;
  builtin: boolean;
  /** `polaris-key.json` path; `null`: write nothing. */
  out: string | null;
  channel?: string | undefined;
  key?: string | undefined;
  json: boolean;
}

export interface DevIo {
  cwd: string;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch | undefined;
  /** Serving ends when this settles (Ctrl-C in the CLI). */
  stop?: Promise<void> | undefined;
}

/** What the server answers at `/__dev/info`, and `pkey dev keys` prints. */
export interface DevInfo {
  baseUrl: string;
  product: string;
  name: string;
  services: string[];
  trust: { pinnedKeys: Record<string, string> };
  releaseKeys: Record<string, string>;
  webOrigins: string[];
  keys: Record<string, string>;
  idp: { issuer: string | null; person: { name: string; email: string } };
  releases: Array<{ version: string; channel: string }>;
  notes: string[];
  offline?: boolean;
}

/** The slice of the dev world the CLI (and its tests) drive in-process; the rest is `/__dev/*`. */
export interface DevWorldControl {
  setConfig(key: string, value: unknown, target?: string): Promise<string>;
  publishRelease(version: string, channel: string): Promise<string>;
}

export interface DevServerHandle {
  url: string;
  world: DevWorldControl;
  /** Hosts a request tried to reach outside loopback; each was refused. */
  blocked: string[];
  close(): Promise<void>;
}

/** The public options accepted by the isolated `pkey dev` server bundle. */
export interface DevServerStartOptions {
  port?: number;
  manifest?: Record<string, string>;
  autoApprove?: boolean;
  log?: (line: string) => void;
}

interface DevBundle {
  startDevServer(opts: DevServerStartOptions): Promise<DevServerHandle>;
  infoOf(world: unknown): DevInfo;
}

const MIN_NODE = [22, 13];

/** The server bundle: `dist/dev/server.mjs`, or `--bundle`'s path in a test. */
export async function loadDevBundle(file?: string): Promise<DevBundle> {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0]! || (major === MIN_NODE[0] && minor < MIN_NODE[1]!))
    throw new Error(
      `pkey dev needs Node ${MIN_NODE.join(".")} or newer (its built-in SQLite); this is ${process.versions.node}.`,
    );
  const target =
    file ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "dev",
      "server.mjs",
    );
  try {
    return (await import(pathToFileURL(target).href)) as DevBundle;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND")
      throw new Error(
        "pkey dev is not in this build of pkey. Run it from the @polaris-key/cli package: npx @polaris-key/cli dev.",
      );
    throw e;
  }
}

/** The `.pkey/` documents under `cwd` as text, or null when there is no product there. */
async function repoManifest(
  cwd: string,
): Promise<{ files: Record<string, string>; dir: string } | null> {
  try {
    const m = await loadManifest(cwd);
    const files: Record<string, string> = {
      product: JSON.stringify(m.product),
    };
    if (m.schema !== undefined) files.schema = JSON.stringify(m.schema);
    if (m.release !== undefined) files.release = JSON.stringify(m.release);
    return { files, dir: m.rootDir };
  } catch (e) {
    if (/No \.pkey\/product manifest/.test((e as Error).message)) return null;
    throw e;
  }
}

/** What `polaris-key.json` holds: the shape `PolarisKeyClient.create()` takes, plus a `dev` block. */
export function configFile(info: DevInfo): Record<string, unknown> {
  return {
    productSlug: info.product,
    baseUrl: info.baseUrl,
    trust: info.trust,
    expectedServices: info.services,
    update: { pinnedReleaseKeys: info.releaseKeys },
    dev: {
      note: "Written by pkey dev; the keys last until it stops. Do not ship this file.",
      keys: info.keys,
      webOrigins: info.webOrigins,
    },
  };
}

function banner(info: DevInfo, wrote: string | null): string {
  const lines = [
    `Polaris Key dev  ${info.baseUrl}`,
    `Product   ${info.product} (${info.name}): ${info.services.join(", ")}`,
    "",
    "Signing keys (pinned)",
    ...Object.entries(info.trust.pinnedKeys).map(([k, v]) => `  ${k}  ${v}`),
    "Release keys (pinned)",
    ...Object.entries(info.releaseKeys).map(([k, v]) => `  ${k}  ${v}`),
    "",
    "Test keys",
    ...Object.entries(info.keys).map(([k, v]) => `  ${k.padEnd(18)}${v}`),
    "",
    ...(info.releases.length
      ? [
          `Releases  ${info.releases.map((r) => `${r.version} (${r.channel})`).join(", ")}`,
        ]
      : []),
    ...(info.idp.issuer
      ? [
          `Sign-in   ${info.idp.person.name} <${info.idp.person.email}> at ${info.idp.issuer}`,
        ]
      : []),
    ...info.notes.map((n) => `Note      ${n}`),
    ...(wrote ? [`Wrote     ${wrote}`] : []),
    "",
    "Control: pkey dev expire|disable|revoke|fill-seats <key>, config, release, offline.",
    "Ctrl-C stops it.",
  ];
  return `${lines.join("\n")}\n`;
}

/** `pkey dev`: serve until `stop` settles. */
export async function serveDev(
  args: DevArgs,
  io: DevIo,
  bundlePath?: string,
): Promise<number> {
  const bundle = await loadDevBundle(bundlePath);
  const repo = args.builtin ? null : await repoManifest(io.cwd);
  const server = await bundle.startDevServer({
    port: args.port ?? DEV_DEFAULT_PORT,
    ...(repo ? { manifest: repo.files } : {}),
    autoApprove: args.autoApprove,
    log: (l) => io.stderr.write(`${l}\n`),
  });
  try {
    const info = bundle.infoOf(server.world);
    if (repo) info.notes.unshift(`Seeded from ${repo.dir}.`);
    let wrote: string | null = null;
    if (args.out !== null) {
      const file = path.resolve(io.cwd, args.out);
      await writeFile(file, `${JSON.stringify(configFile(info), null, 2)}\n`);
      wrote = path.relative(io.cwd, file) || file;
    }
    io.stdout.write(
      args.json ? `${JSON.stringify(info)}\n` : banner(info, wrote),
    );
    await (io.stop ?? new Promise<void>(() => {}));
  } finally {
    await server.close();
  }
  return 0;
}

/** The origin `polaris-key.json` names, when a pkey dev wrote it (it has a `dev` block). */
export async function devConfigUrl(cwd: string): Promise<string | null> {
  try {
    const file = JSON.parse(
      await readFile(path.join(cwd, DEV_CONFIG_FILE), "utf8"),
    ) as { baseUrl?: unknown; dev?: unknown };
    if (typeof file.baseUrl === "string" && file.dev)
      return file.baseUrl.replace(/\/+$/, "");
  } catch {
    // no file, or not ours
  }
  return null;
}

/** The running server's origin: `--url`, else `polaris-key.json`'s, else the default. */
async function targetUrl(args: DevArgs, cwd: string): Promise<string> {
  if (args.url) return args.url.replace(/\/+$/, "");
  return (await devConfigUrl(cwd)) ?? `http://127.0.0.1:${DEV_DEFAULT_PORT}`;
}

export async function devInfoFrom(
  base: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DevInfo> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/__dev/info`);
  } catch {
    throw new Error(
      `No pkey dev is running at ${base}. Start one with pkey dev, or name its origin with --url.`,
    );
  }
  if (!res.ok)
    throw new Error(`${base} did not answer as pkey dev (${res.status}).`);
  return (await res.json()) as DevInfo;
}

/** `pkey dev <command>`: steer a running server. */
export async function controlDev(args: DevArgs, io: DevIo): Promise<number> {
  const sub = args.sub!;
  const base = await targetUrl(args, io.cwd);
  const doFetch = io.fetchImpl ?? fetch;
  if (sub === "keys" || sub === "status") {
    const info = await devInfoFrom(base, doFetch);
    if (args.json) io.stdout.write(`${JSON.stringify(info)}\n`);
    else if (sub === "keys")
      io.stdout.write(
        `${Object.entries(info.keys)
          .map(([k, v]) => `${k.padEnd(18)}${v}`)
          .join("\n")}\n`,
      );
    else
      io.stdout.write(
        `${info.baseUrl}  ${info.product}  ${info.offline ? "offline" : "online"}\n` +
          `releases: ${info.releases.map((r) => `${r.version} (${r.channel})`).join(", ") || "none"}\n`,
      );
    return 0;
  }

  let body: Record<string, unknown>;
  if ((DEV_KEY_COMMANDS as readonly string[]).includes(sub)) {
    const key = args.positional[0];
    if (!key)
      throw new Error(`Usage: pkey dev ${sub} <key>  (${DEV_KEYS.join(", ")})`);
    if (!(DEV_KEYS as readonly string[]).includes(key))
      throw new UsageError(
        `${key} is not a test key. The test keys are ${DEV_KEYS.join(", ")}.`,
      );
    body = { key };
  } else if (sub === "config") {
    const [name, raw] = args.positional;
    if (!name || raw === undefined)
      throw new Error("Usage: pkey dev config <name> <json> [--key <key>]");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new UsageError(`${raw} is not JSON; quote strings: '"high"'.`);
    }
    body = { name, value, ...(args.key ? { key: args.key } : {}) };
  } else if (sub === "release") {
    const version = args.positional[0];
    if (!version)
      throw new Error("Usage: pkey dev release <version> [--channel name]");
    body = { version, ...(args.channel ? { channel: args.channel } : {}) };
  } else if (sub === "offline" || sub === "online") {
    body = {};
  } else {
    throw new UsageError(
      `Unknown dev command ${sub}.\n${DEV_USAGE.join("\n")}`,
    );
  }

  let res: Response;
  try {
    res = await doFetch(`${base}/__dev/${sub}`, {
      method: "POST",
      headers: { "x-pkey-dev": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `No pkey dev is running at ${base}. Start one with pkey dev, or name its origin with --url.`,
    );
  }
  const answer = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok)
    throw new Error(answer.message ?? `${sub} failed (${res.status}).`);
  io.stdout.write(`${answer.message ?? "done"}\n`);
  return 0;
}
