// The CLI verbs (SDK parity pass SP-N14; restyled by the terminal kit, UK-14): every verb a
// licensed command-line app needs, as framework-agnostic functions over a `PolarisKeyClient` that
// return a `CommandResult` (`run`, the plain layer), each with its terminal kit flow (`flow`,
// flows.ts: the rail, prompts, spinners, `--json`), plus `CLI_VERBS`, the one table both adapters
// (commander, yargs) build from. The table is why the two front ends cannot drift: neither
// declares a verb of its own.
//
//   license   activate [key] · status · enroll · deactivate
//   identity  login (alias sign-in) · logout (alias sign-out)
//   devices   register · devices list|rename|deauthorize
//   config    config get|list|set|reset · secret · mint
//   update    update check|apply · changelog
//   packs     packs status|ensure
//   core      offline-request · import-bundle · doctor · completion
//
// `activate` takes its key from the masked prompt or stdin; a key given as an argument still
// works for old scripts and warns that it lands in the shell history.

import type { JSONValue } from "@polaris-key/protocol/core";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import type { PolarisKeyClient } from "../client.js";
import { copy } from "../core/copy.js";
import { qr } from "../qr/index.js";
import { SDK_NAME, SDK_VERSION } from "../version.js";
import type { InstallOutcome } from "../update/drivers/types.js";
import { Feature } from "../constants.generated.js";
import { createKitContext, type KitContext } from "./context.js";
import {
  activateFlow,
  changelogFlow,
  configGetFlow,
  configListFlow,
  configWriteFlow,
  deactivateFlow,
  devicesListFlow,
  devicesRemoveFlow,
  devicesRenameFlow,
  doctorFlow,
  enrollFlow,
  importBundleFlow,
  loginFlow,
  logoutFlow,
  mintFlow,
  offlineRequestFlow,
  packsEnsureFlow,
  packsStatusFlow,
  registerFlow,
  secretFlow,
  statusFlow,
  updateApplyFlow,
  updateCheckFlow,
} from "./flows.js";
import {
  COMPLETION_SHELLS,
  completionScript,
  type CompletionShell,
} from "./help.js";
import { EXIT, type FlowResult } from "./json.js";
import {
  activate,
  deactivate,
  enroll,
  getConfig,
  importBundle,
  register,
  status,
  type CommandResult,
} from "./commands.js";

/** What a verb may do besides returning its result. */
export interface CliIO {
  /** A line printed before the result (a sign-in prompt, a QR code). */
  print(line: string): void;
  /** A progress line that replaces the previous one (adapters draw it on stderr). */
  progress?(line: string): void;
  /** Stop a long-running verb (a sign-in wait, a download). */
  signal?: AbortSignal;
  /** Read a file named on the command line. */
  readFile?(path: string): Promise<string>;
  /** Read a license key from stdin (when `activate` is given none). */
  readKey?(): Promise<string>;
  /** `--reveal`: `secret` and `mint` print their value. Without it they print nothing. */
  reveal?: boolean;
}

function errorResult(verb: string, e: unknown): CommandResult {
  const err = e as { code?: unknown; message?: unknown };
  const code = typeof err?.code === "string" ? err.code : null;
  const message = code
    ? copy.message(code)
    : typeof err?.message === "string"
      ? err.message
      : String(e);
  return {
    ok: false,
    message: `${verb} failed: ${message}${code ? ` [${code}]` : ""}`,
    data: { code },
  };
}

async function guarded(
  verb: string,
  fn: () => Promise<CommandResult>,
): Promise<CommandResult> {
  try {
    return await fn();
  } catch (e) {
    return errorResult(verb, e);
  }
}

/** A fixed-width progress bar: `[#####.....]  50%  1.2/2.4 MB`. */
export function progressBar(done: number, total: number, width = 24): string {
  if (!(total > 0)) return `${done} bytes`;
  const f = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(f * width);
  const mb = (n: number) => (n / 1_048_576).toFixed(1);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${String(Math.round(f * 100)).padStart(3)}%  ${mb(done)}/${mb(total)} MB`;
}

// ── identity ───────────────────────────────────────────────────────────────────────────
/** Device-code sign-in with the code, the URL and a terminal QR printed first. */
export function signIn(
  client: PolarisKeyClient,
  io: CliIO,
  opts: { qr?: boolean; deviceName?: string } = {},
): Promise<CommandResult> {
  return guarded("Sign-in", async () => {
    const prompt = await client.identity.beginSignIn(
      opts.deviceName ? { deviceName: opts.deviceName } : {},
    );
    io.print(
      `Open ${prompt.verificationUri} and enter the code ${prompt.userCode}`,
    );
    if (opts.qr !== false) {
      const code = qr.terminal(prompt.verificationUriComplete);
      if (code) io.print(code);
    }
    io.print("Waiting for you to finish in the browser…");
    const r = await client.identity.waitForSignIn(
      prompt,
      io.signal ? { signal: io.signal } : {},
    );
    if (r.status === "ready") {
      const who = r.identity?.email ?? r.identity?.name;
      return {
        ok: true,
        message: `Signed in${who ? ` as ${who}` : ""}. Status: ${client.status().status}`,
        data: r,
      };
    }
    return {
      ok: false,
      message:
        r.status === "expired"
          ? "Sign-in failed: the code expired. Run sign-in again."
          : `Sign-in failed: ${r.message}`,
      data: r,
    };
  });
}

export function signOut(client: PolarisKeyClient): Promise<CommandResult> {
  return guarded("Sign-out", async () => {
    await client.identity.signOut();
    return { ok: true, message: "Signed out. Local credentials wiped." };
  });
}

// ── license ────────────────────────────────────────────────────────────────────────────
/** The request code an operator mints an offline bundle against (§7): the product and this
 *  device's id, with a QR of the id. */
export function offlineRequest(
  client: PolarisKeyClient,
  io: CliIO,
): CommandResult {
  const deviceId = client.core.deviceId;
  const code = qr.terminal(deviceId);
  if (code) io.print(code);
  return {
    ok: true,
    message: [
      "Send this request code to whoever issues your license:",
      `Product: ${client.product}`,
      `Request code: ${deviceId}`,
      "Then run import-bundle <file> with the bundle you receive.",
    ].join("\n"),
    data: { product: client.product, deviceId },
  };
}

// ── devices ────────────────────────────────────────────────────────────────────────────
export function devicesList(client: PolarisKeyClient): Promise<CommandResult> {
  return guarded("Listing devices", async () => {
    const rows = await client.listDevices();
    const lines = rows.map((d) => {
      const name = d.label ?? d.id;
      const where = [d.platform, d.arch].filter(Boolean).join("/");
      return `${d.current ? "*" : " "} ${name}${name !== d.id ? ` (${d.id})` : ""}${where ? `  ${where}` : ""}${d.appVersion ? `  v${d.appVersion}` : ""}`;
    });
    return {
      ok: true,
      message: [`${rows.length} device(s); * is this one`, ...lines].join("\n"),
      data: rows,
    };
  });
}

export function devicesRename(
  client: PolarisKeyClient,
  deviceId: string,
  label: string | null,
): Promise<CommandResult> {
  return guarded("Rename", async () => {
    await client.renameDevice(deviceId, label);
    return {
      ok: true,
      message: label
        ? `Renamed ${deviceId} to "${label}".`
        : `Cleared the name of ${deviceId}.`,
    };
  });
}

export function devicesDeauthorize(
  client: PolarisKeyClient,
  deviceId: string,
): Promise<CommandResult> {
  return guarded("Deauthorize", async () => {
    const self = deviceId === client.core.deviceId;
    await client.deauthorizeDevice(deviceId);
    return {
      ok: true,
      message: self
        ? "Deauthorized this device. Local credentials wiped."
        : `Deauthorized ${deviceId}; its seat is free.`,
    };
  });
}

// ── config ─────────────────────────────────────────────────────────────────────────────
export function configList(client: PolarisKeyClient): CommandResult {
  const rows = client.config.listUserConfig().map((e) => ({
    ...e,
    source: client.config.getConfigSource(e.key),
  }));
  return {
    ok: true,
    message: rows.length
      ? rows
          .map(
            (r) =>
              `${r.key} = ${JSON.stringify(r.value)} (${r.source}${r.enforced ? ", locked" : ""})`,
          )
          .join("\n")
      : "No user-visible settings.",
    data: rows,
  };
}

/** Parse a command-line value: JSON when it parses (`true`, `3`, `{"a":1}`), else the string. */
export function parseCliValue(raw: string): JSONValue {
  try {
    return JSON.parse(raw) as JSONValue;
  } catch {
    return raw;
  }
}

export function configSet(
  client: PolarisKeyClient,
  key: string,
  raw: string,
): Promise<CommandResult> {
  return guarded("Setting " + key, async () => {
    await client.config.set(key, parseCliValue(raw));
    return getConfig(client, key);
  });
}

export function configReset(
  client: PolarisKeyClient,
  key: string,
): Promise<CommandResult> {
  return guarded("Resetting " + key, async () => {
    await client.config.clear(key);
    const r = getConfig(client, key);
    return r.ok ? r : { ok: true, message: `${key} reset (no value).` };
  });
}

export function secret(
  client: PolarisKeyClient,
  key: string,
  reveal = false,
): CommandResult {
  const value = client.config.getSecret(key);
  if (value === null)
    return {
      ok: false,
      message: `${key}: no client-scoped secret is delivered here.`,
    };
  // The value is printed only when asked for; the result carries only that it is set.
  return reveal
    ? { ok: true, message: value, data: { key } }
    : {
        ok: false,
        message: `${key} is set but not printed. To print its value, run: secret ${key} --reveal`,
        data: { key },
      };
}

export function mint(
  client: PolarisKeyClient,
  recipeId: string,
  reveal = false,
): Promise<CommandResult> {
  return guarded("Mint", async () => {
    if (!reveal)
      return {
        ok: false,
        message: `Nothing was minted. To mint and print a token, run: mint ${recipeId} --reveal`,
      };
    const t = await client.config.mintToken(recipeId);
    return {
      ok: true,
      message: t.token,
      data: { recipeId, expiresAt: t.expiresAt },
    };
  });
}

// ── update / release ───────────────────────────────────────────────────────────────────
/** One line for a decision. */
export function describeDecision(d: UpdateDecision): string {
  switch (d.action) {
    case "none":
      return `Up to date (${d.reason}).`;
    case "binary":
      return `Version ${d.release.version} is available${d.mandatory ? " (required)" : ""}.`;
    case "store":
      return `Version ${d.release.version} is available from the store${d.listingUrl ? `: ${d.listingUrl}` : ""}.`;
    case "platform":
      return `Version ${d.release.version} is available through the platform's updater.`;
    case "code-ready":
      return `Code update ${d.release.version} is ready.`;
    case "blocked":
      return `Updates are blocked (${d.reason}).`;
    case "packs":
      return `${d.install.length} pack(s) to install, ${d.revoke.length} to remove.`;
  }
}

/** The signed decision when the client can make one, else the plain version check. */
export function updateCheck(client: PolarisKeyClient): Promise<CommandResult> {
  return guarded("Update check", async () => {
    if (client.update.decidable) {
      const r = await client.update.decide();
      return { ok: true, message: describeDecision(r.decision), data: r };
    }
    const v = await client.update.check();
    return {
      ok: true,
      message: v.updateAvailable
        ? `Version ${v.version} is available: ${v.url}`
        : `Up to date (${v.version} is the newest).`,
      data: v,
    };
  });
}

function describeOutcome(o: InstallOutcome): CommandResult {
  switch (o.kind) {
    case "restartRequired":
      return {
        ok: true,
        message: `Installed ${o.version}. Restart to finish.`,
        data: { kind: o.kind, version: o.version },
      };
    case "handedOff":
      return {
        ok: true,
        message: `The installer for ${o.version} took over.`,
        data: o,
      };
    case "storeOpened":
      return { ok: true, message: `Opened ${o.url}.`, data: o };
    case "unsupported":
      return {
        ok: false,
        message: `Update not installed (${o.reason}): ${o.detail}`,
        data: o,
      };
  }
}

/** Decide, then install what the decision offers through the configured driver. */
export function updateApply(
  client: PolarisKeyClient,
  io: CliIO,
): Promise<CommandResult> {
  return guarded("Update", async () => {
    const r = await client.update.decide();
    const d = r.decision;
    if (d.action !== "binary" && d.action !== "store")
      return { ok: true, message: describeDecision(d), data: r };
    io.print(describeDecision(d));
    const out = await client.update.install(d, {
      ...(io.progress
        ? {
            onProgress: (done, total) => io.progress!(progressBar(done, total)),
          }
        : {}),
      ...(io.signal ? { signal: io.signal } : {}),
    });
    return describeOutcome(out);
  });
}

export function changelog(
  client: PolarisKeyClient,
  limit = 10,
): Promise<CommandResult> {
  return guarded("Changelog", async () => {
    const rows = await client.release.changelog();
    const shown = rows.slice(0, limit);
    return {
      ok: true,
      message: shown.length
        ? shown
            .map(
              (e) =>
                `${e.version}${e.date ? `  ${e.date.slice(0, 10)}` : ""}${e.summary ? `\n  ${e.summary}` : ""}`,
            )
            .join("\n")
        : "No releases published.",
      data: rows,
    };
  });
}

// ── packs ──────────────────────────────────────────────────────────────────────────────
export function packsStatus(client: PolarisKeyClient): Promise<CommandResult> {
  return guarded("Packs", async () => {
    const s = await client.update.packs.state();
    const active = Object.values(s.active);
    const lines = active.map(
      (p) =>
        `${p.packId}  ${p.version}  ${p.type}${s.running[p.packId] ? "" : "  (after restart)"}`,
    );
    for (const [id, f] of Object.entries(s.inflight))
      lines.push(`${id}  downloading ${progressBar(f.done, f.total)}`);
    if (s.stateIssue) lines.push(`State issue: ${s.stateIssue}`);
    return {
      ok: s.stateIssue === null,
      message: lines.length ? lines.join("\n") : "No packs installed.",
      data: s,
    };
  });
}

export function packsEnsure(
  client: PolarisKeyClient,
  packIds: string[],
  io: CliIO,
): Promise<CommandResult> {
  return guarded("Pack install", async () => {
    const off = client.update.packs.on((e) => {
      if (e.phase === "download" || e.phase === "apply")
        io.progress?.(`${e.packId} ${e.phase} ${progressBar(e.done, e.total)}`);
    });
    try {
      const installs = await client.update.packs.ensure(packIds);
      return {
        ok: true,
        message: installs.length
          ? installs.map((i) => `${i.packId} ${i.version} ready`).join("\n")
          : "Everything is already installed.",
        data: installs.map((i) => ({ packId: i.packId, version: i.version })),
      };
    } finally {
      off();
    }
  });
}

// ── core ───────────────────────────────────────────────────────────────────────────────
const DOCTOR_FEATURES = [
  Feature.coreStore,
  Feature.licenseActivate,
  Feature.licenseEnroll,
  Feature.identityDevicecode,
  Feature.devicesManage,
  Feature.configResolve,
  Feature.releaseDownload,
  Feature.updateDecide,
  Feature.updateDriver,
  Feature.commerceReceipt,
] as const;

/** Support diagnostics: the SDK, the store, discovery, the services, and what is unsupported
 *  here and why. `ok` is false when discovery failed or the store is degraded. */
export async function doctor(client: PolarisKeyClient): Promise<CommandResult> {
  const lines = [
    `${SDK_NAME} ${SDK_VERSION}`,
    `Product: ${client.product}  version ${client.core.version}  channel ${client.core.channel}`,
    `Base URL: ${client.core.baseUrl}`,
    `Device: ${client.core.deviceId}`,
  ];
  let ok = true;
  const store = await client.storeStatus();
  if (store) {
    lines.push(
      `Token store: ${store.backend}${store.degraded ? ` (degraded: ${store.degraded.reason}${store.degraded.detail ? `: ${store.degraded.detail}` : ""})` : ""}`,
    );
    if (store.degraded) ok = false;
  }
  let discovery: string;
  try {
    const d = await client.discover();
    discovery =
      d.kind === "ok"
        ? "ok"
        : d.kind === "not-found"
          ? "product not found"
          : d.message;
    if (d.kind !== "ok") ok = false;
  } catch (e) {
    discovery = (e as Error).message;
    ok = false;
  }
  lines.push(`Discovery: ${discovery}`);
  const services = Object.entries(client.capabilities())
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  lines.push(`Services: ${services.join(", ") || "none"}`);
  lines.push(`Gate: ${client.status().status}`);
  const outlet = client.update.outlet;
  if (outlet) lines.push(`Outlet: ${outlet.id} (${outlet.kind})`);
  const unsupported = DOCTOR_FEATURES.map(
    (f) => [f, client.supports(f)] as const,
  )
    .filter(([, s]) => !s.supported)
    .map(([f, s]) =>
      s.supported
        ? ""
        : `  ${f}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`,
    );
  if (unsupported.length) lines.push("Unsupported here:", ...unsupported);
  return {
    ok,
    message: lines.join("\n"),
    data: { discovery, services, store },
  };
}

// ── The verb table ─────────────────────────────────────────────────────────────────────
export type CliGroup =
  | "license"
  | "identity"
  | "devices"
  | "config"
  | "update"
  | "packs"
  | "core";

/** The per-verb flags the terminal kit reads (`--yes`, `--device-code`, `--reveal`,
 *  `--allow-workflow-commands`). */
export interface VerbFlags {
  yes?: boolean;
  deviceCode?: boolean;
  allowWorkflowCommands?: boolean;
  reveal?: boolean;
}

/** One verb, as both adapters declare it. */
export interface CliVerb {
  group: CliGroup;
  /** The command words: `["devices", "rename"]` is `devices rename`. */
  path: string[];
  /** Other names for a one-word verb (`sign-in` for `login`), kept so old scripts still run. */
  aliases?: string[];
  /** Positional arguments in commander/yargs syntax: `<required>`, `[optional]`, `[many...]`. */
  args: string[];
  /** A plain English description (the `run` API's); help shows `describeKey` instead. */
  describe: string;
  /** The catalog key of the description help shows (`cli.verb.*`). */
  describeKey: string;
  /** The verb needs no client (`completion`). */
  clientless?: boolean;
  run(
    client: PolarisKeyClient,
    args: unknown[],
    io: CliIO,
  ): Promise<CommandResult> | CommandResult;
  /** The terminal kit's flow for this verb: drawn on the rail, or the `--json` envelope. */
  flow(
    ctx: KitContext,
    client: PolarisKeyClient | null,
    args: unknown[],
    flags: VerbFlags,
  ): Promise<FlowResult> | FlowResult;
}

const one = (a: unknown): string =>
  Array.isArray(a) ? a.join(" ") : String(a ?? "");
const many = (a: unknown): string[] =>
  Array.isArray(a) ? a.map(String) : a === undefined ? [] : [String(a)];

async function readArg(io: CliIO, file: string): Promise<string> {
  if (!io.readFile) throw new Error("this front end cannot read files");
  return (await io.readFile(file)).trim();
}

/** A client the verb needs; the adapters always pass one except to a clientless verb. */
const need = (c: PolarisKeyClient | null): PolarisKeyClient => {
  if (!c) throw new Error("this verb needs a client");
  return c;
};

/** `completion <shell>` outside the kit: the script in English, plain. */
async function completionResult(
  slug: string,
  shell: unknown,
): Promise<CommandResult> {
  const sh = one(shell) as CompletionShell;
  if (!COMPLETION_SHELLS.includes(sh))
    return { ok: false, message: `Shells: ${COMPLETION_SHELLS.join(", ")}` };
  const ctx = await createKitContext({
    slug,
    io: { stdout: { write: () => true }, env: {} },
    queryScheme: false,
  });
  return { ok: true, message: completionScript(ctx, sh, CLI_VERBS) };
}

/** Every verb, in help order. */
export const CLI_VERBS: readonly CliVerb[] = [
  {
    group: "license",
    path: ["activate"],
    args: ["[key]"],
    describe:
      "Activate this device with a license key (prompted, or piped on stdin)",
    describeKey: "cli.verb.activate",
    run: async (c, a, io) => {
      const key = one(a[0]) || (io.readKey ? await io.readKey() : "");
      return key
        ? activate(c, key)
        : { ok: false, message: "Activation failed: no license key given." };
    },
    flow: (ctx, c, a) =>
      activateFlow(ctx, need(c), { key: one(a[0]) || undefined }),
  },
  {
    group: "license",
    path: ["status"],
    args: [],
    describe: "Show the current license gate status",
    describeKey: "cli.verb.status",
    run: async (c) => status(c, await c.storeStatus()),
    flow: (ctx, c) => statusFlow(ctx, need(c)),
  },
  {
    group: "license",
    path: ["enroll"],
    args: [],
    describe: "Obtain a license with no key, when the product offers one",
    describeKey: "cli.verb.enroll",
    run: (c) => enroll(c),
    flow: (ctx, c) => enrollFlow(ctx, need(c)),
  },
  {
    group: "license",
    path: ["deactivate"],
    args: [],
    describe: "Deauthorize this device and wipe local credentials",
    describeKey: "cli.verb.deactivate",
    run: (c) => deactivate(c),
    flow: (ctx, c, _a, f) => deactivateFlow(ctx, need(c), f),
  },
  {
    group: "identity",
    path: ["login"],
    aliases: ["sign-in"],
    args: [],
    describe: "Sign in with your account (browser, or a code when headless)",
    describeKey: "cli.verb.login",
    // No QR for sign-in on any desktop surface, terminals included (SIGN-IN.md D-67).
    run: (c, _a, io) => signIn(c, io, { qr: false }),
    flow: (ctx, c, _a, f) => loginFlow(ctx, need(c), f),
  },
  {
    group: "identity",
    path: ["logout"],
    aliases: ["sign-out"],
    args: [],
    describe: "Sign out and wipe local credentials",
    describeKey: "cli.verb.logout",
    run: (c) => signOut(c),
    flow: (ctx, c, _a, f) => logoutFlow(ctx, need(c), f),
  },
  {
    group: "devices",
    path: ["register"],
    args: [],
    describe: "Register this device keylessly and pull its documents",
    describeKey: "cli.verb.register",
    run: (c) => register(c),
    flow: (ctx, c) => registerFlow(ctx, need(c)),
  },
  {
    group: "devices",
    path: ["devices", "list"],
    args: [],
    describe: "List the devices on this license",
    describeKey: "cli.verb.devicesList",
    run: (c) => devicesList(c),
    flow: (ctx, c) => devicesListFlow(ctx, need(c)),
  },
  {
    group: "devices",
    path: ["devices", "rename"],
    args: ["<deviceId>", "[label...]"],
    describe: "Name a device (no label clears it)",
    describeKey: "cli.verb.devicesRename",
    run: (c, a) => devicesRename(c, one(a[0]), many(a[1]).join(" ") || null),
    flow: (ctx, c, a) =>
      devicesRenameFlow(ctx, need(c), one(a[0]), many(a[1]).join(" ") || null),
  },
  {
    group: "devices",
    path: ["devices", "deauthorize"],
    args: ["<deviceId>"],
    describe: "Free a device's seat",
    describeKey: "cli.verb.devicesRemove",
    run: (c, a) => devicesDeauthorize(c, one(a[0])),
    flow: (ctx, c, a) => devicesRemoveFlow(ctx, need(c), one(a[0])),
  },
  {
    group: "config",
    path: ["config", "get"],
    args: ["<key>"],
    describe: "Resolve the effective value of a config key",
    describeKey: "cli.verb.configGet",
    run: (c, a) => getConfig(c, one(a[0])),
    flow: (ctx, c, a) => configGetFlow(ctx, need(c), one(a[0])),
  },
  {
    group: "config",
    path: ["config", "list"],
    args: [],
    describe: "List the settings a user may see",
    describeKey: "cli.verb.configList",
    run: (c) => configList(c),
    flow: (ctx, c) => configListFlow(ctx, need(c)),
  },
  {
    group: "config",
    path: ["config", "set"],
    args: ["<key>", "<value>"],
    describe: "Set a local override (JSON or text)",
    describeKey: "cli.verb.configSet",
    run: (c, a) => configSet(c, one(a[0]), one(a[1])),
    flow: (ctx, c, a) =>
      configWriteFlow(ctx, need(c), one(a[0]), parseCliValue(one(a[1]))),
  },
  {
    group: "config",
    path: ["config", "reset"],
    args: ["<key>"],
    describe: "Remove a local override",
    describeKey: "cli.verb.configReset",
    run: (c, a) => configReset(c, one(a[0])),
    flow: (ctx, c, a) => configWriteFlow(ctx, need(c), one(a[0]), undefined),
  },
  {
    group: "config",
    path: ["secret"],
    args: ["<key>"],
    describe: "Print a client-scoped secret",
    describeKey: "cli.verb.secret",
    run: (c, a, io) => secret(c, one(a[0]), io.reveal === true),
    flow: (ctx, c, a, f) => secretFlow(ctx, need(c), one(a[0]), f),
  },
  {
    group: "config",
    path: ["mint"],
    args: ["<recipeId>"],
    describe: "Mint a short-lived token from an edge-mint recipe",
    describeKey: "cli.verb.mint",
    run: (c, a, io) => mint(c, one(a[0]), io.reveal === true),
    flow: (ctx, c, a, f) => mintFlow(ctx, need(c), one(a[0]), f),
  },
  {
    group: "update",
    path: ["update", "check"],
    args: [],
    describe: "Check for an update",
    describeKey: "cli.verb.updateCheck",
    run: (c) => updateCheck(c),
    flow: (ctx, c) => updateCheckFlow(ctx, need(c)),
  },
  {
    group: "update",
    path: ["update", "apply"],
    args: [],
    describe: "Download and install the update the signed decision offers",
    describeKey: "cli.verb.updateApply",
    run: (c, _a, io) => updateApply(c, io),
    flow: (ctx, c) => updateApplyFlow(ctx, need(c)),
  },
  {
    group: "update",
    path: ["changelog"],
    args: [],
    describe: "Show the published releases",
    describeKey: "cli.verb.changelog",
    run: (c) => changelog(c),
    flow: (ctx, c) => changelogFlow(ctx, need(c)),
  },
  {
    group: "packs",
    path: ["packs", "status"],
    args: [],
    describe: "Show installed and downloading packs",
    describeKey: "cli.verb.packsStatus",
    run: (c) => packsStatus(c),
    flow: (ctx, c) => packsStatusFlow(ctx, need(c)),
  },
  {
    group: "packs",
    path: ["packs", "ensure"],
    args: ["<packIds...>"],
    describe: "Install or update packs, with progress",
    describeKey: "cli.verb.packsEnsure",
    run: (c, a, io) => packsEnsure(c, many(a[0]), io),
    flow: (ctx, c, a) => packsEnsureFlow(ctx, need(c), many(a[0])),
  },
  {
    group: "core",
    path: ["offline-request"],
    args: [],
    describe: "Print the request code for an offline activation bundle",
    describeKey: "cli.verb.offlineRequest",
    run: (c, _a, io) => offlineRequest(c, io),
    flow: (ctx, c) => offlineRequestFlow(ctx, need(c)),
  },
  {
    group: "core",
    path: ["import-bundle"],
    args: ["<file>"],
    describe: "Import an offline activation bundle",
    describeKey: "cli.verb.importBundle",
    run: async (c, a, io) => importBundle(c, await readArg(io, one(a[0]))),
    flow: async (ctx, c, a) => {
      const file = one(a[0]);
      const { readFile } = await import("node:fs/promises");
      let jws: string;
      try {
        jws = (await readFile(file, "utf8")).trim();
      } catch {
        return importBundleFlow(ctx, need(c), "");
      }
      return importBundleFlow(ctx, need(c), jws);
    },
  },
  {
    group: "core",
    path: ["doctor"],
    args: [],
    describe: "Diagnose the store, discovery and what is unsupported here",
    describeKey: "cli.verb.doctor",
    run: (c) => doctor(c),
    flow: (ctx, c) => doctorFlow(ctx, need(c)),
  },
  {
    group: "core",
    path: ["completion"],
    args: ["<shell>"],
    describe: "Print the shell completion script (bash, zsh or fish)",
    describeKey: "cli.verb.completion",
    clientless: true,
    run: (c, a) => completionResult(c.product, a[0]),
    flow: (ctx, _c, a) => {
      const sh = one(a[0]) as CompletionShell;
      if (!COMPLETION_SHELLS.includes(sh)) {
        const message = `${ctx.bin} completion ${COMPLETION_SHELLS.join("|")}`;
        if (!ctx.caps.json) ctx.stderr.write(`${message}\n`);
        return {
          exitCode: EXIT.usage,
          error: { code: null, title: message, message },
        };
      }
      const script = completionScript(ctx, sh, CLI_VERBS);
      if (!ctx.caps.json) ctx.stdout.write(script);
      return { exitCode: EXIT.ok, result: { shell: sh, script } };
    },
  },
];

/** The argument's name without its brackets (`<key>` → `key`, `[label...]` → `label`). */
export function argName(spec: string): string {
  return spec.replace(/^[<[]|\.\.\.?|[>\]]$/g, "");
}
