// The full CLI kit (SDK parity pass SP-N14): every verb a licensed command-line app needs, as
// framework-agnostic functions over a `PolarisKeyClient` that return a `CommandResult`, plus
// `CLI_VERBS`, the one table both adapters (commander, yargs) build their commands from. The
// table is why the two front ends cannot drift: neither declares a verb of its own.
//
//   license   activate · enroll · deactivate · status · offline-request
//   identity  sign-in (terminal QR) · sign-out
//   devices   register · devices list|rename|deauthorize
//   config    config get|list|set|reset · secret · mint
//   update    update check|apply · changelog
//   packs     packs status|ensure (progress bar)
//   core      import-bundle · doctor
//
// Long-running verbs report through `CliIO.progress` (the adapters draw it on stderr) and stop
// on `CliIO.signal`. Messages come from the copy catalog where a refusal has a code, and never
// print a raw response body.

import type { JSONValue } from "@polaris-key/protocol/core";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import type { PolarisKeyClient } from "../client.js";
import { copy } from "../core/copy.js";
import { qr } from "../qr/index.js";
import { SDK_NAME, SDK_VERSION } from "../version.js";
import type { InstallOutcome } from "../update/drivers/types.js";
import { Feature } from "../constants.generated.js";
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
      "Send this request code to whoever issues your licence:",
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

export function secret(client: PolarisKeyClient, key: string): CommandResult {
  const value = client.config.getSecret(key);
  return value === null
    ? {
        ok: false,
        message: `${key}: no client-scoped secret is delivered here.`,
      }
    : { ok: true, message: value, data: { key } };
}

export function mint(
  client: PolarisKeyClient,
  recipeId: string,
): Promise<CommandResult> {
  return guarded("Mint", async () => {
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

/** One verb, as both adapters declare it. */
export interface CliVerb {
  group: CliGroup;
  /** The command words: `["devices", "rename"]` is `devices rename`. */
  path: string[];
  /** Positional arguments in commander/yargs syntax: `<required>`, `[optional]`, `[many...]`. */
  args: string[];
  describe: string;
  run(
    client: PolarisKeyClient,
    args: unknown[],
    io: CliIO,
  ): Promise<CommandResult> | CommandResult;
}

const one = (a: unknown): string =>
  Array.isArray(a) ? a.join(" ") : String(a ?? "");
const many = (a: unknown): string[] =>
  Array.isArray(a) ? a.map(String) : a === undefined ? [] : [String(a)];

async function readArg(io: CliIO, file: string): Promise<string> {
  if (!io.readFile) throw new Error("this front end cannot read files");
  return (await io.readFile(file)).trim();
}

/** Every verb, in help order. */
export const CLI_VERBS: readonly CliVerb[] = [
  {
    group: "license",
    path: ["activate"],
    args: ["<key>"],
    describe: "Activate this device with a licence key",
    run: (c, a) => activate(c, one(a[0])),
  },
  {
    group: "license",
    path: ["enroll"],
    args: [],
    describe: "Obtain a licence with no key, when the product offers one",
    run: (c) => enroll(c),
  },
  {
    group: "license",
    path: ["deactivate"],
    args: [],
    describe: "Deauthorize this device and wipe local credentials",
    run: (c) => deactivate(c),
  },
  {
    group: "license",
    path: ["status"],
    args: [],
    describe: "Show the current licence gate status",
    run: async (c) => status(c, await c.storeStatus()),
  },
  {
    group: "license",
    path: ["offline-request"],
    args: [],
    describe: "Print the request code for an offline activation bundle",
    run: (c, _a, io) => offlineRequest(c, io),
  },
  {
    group: "identity",
    path: ["sign-in"],
    args: [],
    describe: "Sign in with your account (code and QR in the terminal)",
    run: (c, _a, io) => signIn(c, io),
  },
  {
    group: "identity",
    path: ["sign-out"],
    args: [],
    describe: "Sign out and wipe local credentials",
    run: (c) => signOut(c),
  },
  {
    group: "devices",
    path: ["register"],
    args: [],
    describe: "Register this device keylessly and pull its documents",
    run: (c) => register(c),
  },
  {
    group: "devices",
    path: ["devices", "list"],
    args: [],
    describe: "List the devices on this licence",
    run: (c) => devicesList(c),
  },
  {
    group: "devices",
    path: ["devices", "rename"],
    args: ["<deviceId>", "[label...]"],
    describe: "Name a device (no label clears it)",
    run: (c, a) => devicesRename(c, one(a[0]), many(a[1]).join(" ") || null),
  },
  {
    group: "devices",
    path: ["devices", "deauthorize"],
    args: ["<deviceId>"],
    describe: "Free a device's seat",
    run: (c, a) => devicesDeauthorize(c, one(a[0])),
  },
  {
    group: "config",
    path: ["config", "get"],
    args: ["<key>"],
    describe: "Resolve the effective value of a config key",
    run: (c, a) => getConfig(c, one(a[0])),
  },
  {
    group: "config",
    path: ["config", "list"],
    args: [],
    describe: "List the settings a user may see",
    run: (c) => configList(c),
  },
  {
    group: "config",
    path: ["config", "set"],
    args: ["<key>", "<value>"],
    describe: "Set a local override (JSON or text)",
    run: (c, a) => configSet(c, one(a[0]), one(a[1])),
  },
  {
    group: "config",
    path: ["config", "reset"],
    args: ["<key>"],
    describe: "Remove a local override",
    run: (c, a) => configReset(c, one(a[0])),
  },
  {
    group: "config",
    path: ["secret"],
    args: ["<key>"],
    describe: "Print a client-scoped secret",
    run: (c, a) => secret(c, one(a[0])),
  },
  {
    group: "config",
    path: ["mint"],
    args: ["<recipeId>"],
    describe: "Mint a short-lived token from an edge-mint recipe",
    run: (c, a) => mint(c, one(a[0])),
  },
  {
    group: "update",
    path: ["update", "check"],
    args: [],
    describe: "Check for an update",
    run: (c) => updateCheck(c),
  },
  {
    group: "update",
    path: ["update", "apply"],
    args: [],
    describe: "Download and install the update the signed decision offers",
    run: (c, _a, io) => updateApply(c, io),
  },
  {
    group: "update",
    path: ["changelog"],
    args: [],
    describe: "Show the published releases",
    run: (c) => changelog(c),
  },
  {
    group: "packs",
    path: ["packs", "status"],
    args: [],
    describe: "Show installed and downloading packs",
    run: (c) => packsStatus(c),
  },
  {
    group: "packs",
    path: ["packs", "ensure"],
    args: ["<packIds...>"],
    describe: "Install or update packs, with progress",
    run: (c, a, io) => packsEnsure(c, many(a[0]), io),
  },
  {
    group: "core",
    path: ["import-bundle"],
    args: ["<file>"],
    describe: "Import an offline activation bundle",
    run: async (c, a, io) => importBundle(c, await readArg(io, one(a[0]))),
  },
  {
    group: "core",
    path: ["doctor"],
    args: [],
    describe: "Diagnose the store, discovery and what is unsupported here",
    run: (c) => doctor(c),
  },
];

/** The argument's name without its brackets (`<key>` → `key`, `[label...]` → `label`). */
export function argName(spec: string): string {
  return spec.replace(/^[<[]|\.\.\.?|[>\]]$/g, "");
}
