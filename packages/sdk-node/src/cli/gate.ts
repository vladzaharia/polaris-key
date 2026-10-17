// The gate for a host CLI's own commands (the `gate` rows of conformance/corpus/v2/ui-matrix.json,
// plans/UK-51.md): `requireLicense(handler)` runs the host's command only on a usable license that
// holds the entitlement. A person at a terminal is taken through the kit's activate flow first and
// the command then runs; anything else is a refusal, a triangle with the command that fixes it,
// and exit 4 (`EXIT.licenseRequired`, as `gh` exits for "requires authentication"). With `--json`
// the refusal is the result line on stdout, `license_required` or `not_entitled`.

import type { PolarisKeyClient } from "../client.js";
import {
  createKitContext,
  type KitContext,
  type TerminalIO,
} from "./context.js";
import { activateFlow, ensureDiscovery } from "./flows.js";
import { envelope, EXIT, jsonLine } from "./json.js";
import { endRow, fixRows, gap, problemRows } from "./parts.js";
import {
  presentationSourceOf,
  type PolarisKeyTerminalTheme,
  type PresentationSource,
} from "./theme.js";

/** The gate statuses a host's command runs on (with the entitlement held). */
const USABLE: readonly string[] = ["ok", "grace", "not-applicable"];
/** What an interactive run resolves inline: activating another key fixes them. */
const INLINE_FLOW: readonly string[] = [
  "needs-activation",
  "expired",
  "revoked",
];

export interface GateRun {
  client: PolarisKeyClient;
  /** The host command being gated, for the `--json` result line. */
  command: string;
  /** An entitlement the license must grant (`export.pdf`). */
  entitlement?: string;
  flags?: { json?: boolean; color?: boolean; ascii?: boolean };
  slug: string;
  /** What the person types before a verb (`tidewater`, or `tidewater license` under a namespace). */
  bin: string;
  /** The verb ids the mount offers: a fix for a verb that is not mounted is left out. */
  mounted?: readonly string[];
  io?: TerminalIO;
  theme?: PolarisKeyTerminalTheme;
  presentation?: PresentationSource;
  frame?: boolean;
}

interface Refusal {
  error: "license_required" | "not_entitled";
  title: string;
  message: string;
  fixes: StatusFixRow[];
}
interface StatusFixRow {
  verb: string;
  key: string;
}

const FIX_COPY: Record<string, string> = {
  activate: "welcome.useKey",
  login: "welcome.signIn",
  "update apply": "status.update",
  status: "cli.verb.status",
};

function refusalFor(
  status: string,
  usable: boolean,
  ctx: KitContext,
  mounted: readonly string[] | undefined,
): Refusal {
  const t = ctx.copy.t.bind(ctx.copy);
  const notEntitled = usable || status === "channel-not-entitled";
  const known = [
    "expired",
    "revoked",
    "needs-activation",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
  ];
  const state = usable ? null : known.includes(status) ? status : "revoked";
  const verbs = notEntitled
    ? ["status"]
    : state?.startsWith("version-")
      ? ["update apply"]
      : ["activate", "login"];
  return {
    error: notEntitled ? "not_entitled" : "license_required",
    title: usable
      ? t("core.codes.not_entitled.title")
      : t(`core.gate.${state}.title`),
    message: usable
      ? t("core.codes.not_entitled.message")
      : t(`core.gate.${state}.message`),
    fixes: verbs
      .filter((v) => mounted === undefined || mounted.includes(v))
      .map((verb) => ({ verb, key: FIX_COPY[verb]! })),
  };
}

/**
 * Check the license for a host command. Returns null when the command may run, else the exit
 * code to end with (4 for a refusal; the flow's own code when the inline flow failed or was
 * cancelled). Never throws for a license problem.
 */
export async function runGate(r: GateRun): Promise<number | null> {
  const { client } = r;
  const base = {
    slug: r.slug,
    bin: r.bin,
    ...(r.theme ? { theme: r.theme } : {}),
    ...(r.frame === false ? { frame: false } : {}),
    presentation: r.presentation ?? presentationSourceOf(client),
  };
  const flags = {
    ...(r.flags?.json ? { json: true } : {}),
    ...(r.flags?.color === false ? { color: false } : {}),
    ...(r.flags?.ascii ? { ascii: true } : {}),
  };
  const ctx = await createKitContext({
    ...base,
    flags,
    ...(r.io ? { io: r.io } : {}),
  });
  const check = () => {
    const status = client.status().status as string;
    const usable = USABLE.includes(status);
    const entitled =
      r.entitlement === undefined || client.license.isEntitled(r.entitlement);
    return { status, usable, entitled };
  };
  try {
    let s = check();
    if (s.usable && s.entitled) return null;
    // A license that is not usable may be one sync away from it (an expired document, a renewal).
    if (!s.usable) {
      await ensureDiscovery(client);
      await client.sync().catch(() => undefined);
      s = check();
      if (s.usable && s.entitled) return null;
    }
    if (!s.usable && ctx.caps.interactive && INLINE_FLOW.includes(s.status)) {
      const flow = await activateFlow(ctx, client, {});
      if (flow.exitCode !== EXIT.ok) return flow.exitCode;
      s = check();
      if (s.usable && s.entitled) return null;
    }
    const refusal = refusalFor(s.status, s.usable, ctx, r.mounted);
    if (ctx.caps.json) {
      ctx.stdout.write(
        `${jsonLine(
          envelope(r.command, {
            exitCode: EXIT.licenseRequired,
            error: {
              code: refusal.error,
              title: refusal.title,
              message: refusal.message,
            },
          }),
        )}\n`,
      );
      return EXIT.licenseRequired;
    }
    // The refusal goes to stderr, laid out and coloured for that stream: no escape off a terminal.
    const errCtx = await createKitContext({
      ...base,
      flags,
      io: {
        ...r.io,
        stdout: r.io?.stderr ?? process.stderr,
      },
      queryScheme: false,
    });
    try {
      errCtx.rows([
        ...problemRows("warn", refusal.title, refusal.message),
        ...(refusal.fixes.length
          ? [...gap(errCtx), ...fixRows(errCtx, refusal.fixes)]
          : []),
        endRow(),
      ]);
    } finally {
      errCtx.close();
    }
    return EXIT.licenseRequired;
  } finally {
    ctx.close();
  }
}

// ── The host's side: mounts register a target; the gate finds it from the call ────────────────

/** What a mount tells the gate: how to build the client and what to call things. */
export interface GateTarget {
  /** Builds the client; `context` is what the host's parser handed the command (a commander
   *  `Command`, or yargs' `argv`). */
  client(context: unknown): Promise<PolarisKeyClient>;
  slug: string;
  bin: string;
  mounted: readonly string[];
  io?: TerminalIO;
  theme?: PolarisKeyTerminalTheme;
  presentation?: PresentationSource;
  frame?: boolean;
  setExitCode(code: number): void;
  /** Commands the kit owns (never gated by `polarisGate`). */
  owns?(command: object): boolean;
}

const targets = new WeakMap<object, GateTarget>();
let latest: GateTarget | null = null;

/** Called by a mount: `root` is the commander program, or null for yargs (one per process). */
export function bindGate(root: object | null, target: GateTarget): void {
  if (root) targets.set(root, target);
  latest = target;
}

/** The slice of a commander `Command` the gate reads. */
interface CommandLike {
  name(): string;
  parent?: CommandLike | null;
  optsWithGlobals?(): Record<string, unknown>;
  opts?(): Record<string, unknown>;
}

const isCommand = (v: unknown): v is CommandLike =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as CommandLike).name === "function" &&
  typeof (v as CommandLike).opts === "function";

const isArgv = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  Array.isArray((v as { _?: unknown })._);

/** The command's words below the program: `["devices", "list"]`. */
function wordsBelowRoot(cmd: CommandLike): string[] {
  const words: string[] = [];
  for (let c: CommandLike | null | undefined = cmd; c?.parent; c = c.parent)
    words.unshift(c.name());
  return words;
}

function rootOf(cmd: CommandLike): CommandLike {
  let c = cmd;
  while (c.parent) c = c.parent;
  return c;
}

export interface RequireLicenseOptions {
  /** An entitlement the license must grant (`export.pdf`). */
  entitlement?: string;
  /** Gate on this client instead of the mounted commands' (for a host that mounts nothing). */
  client?: PolarisKeyClient | (() => Promise<PolarisKeyClient>);
  /** Names for a gate with no mount: the product slug and the command people type. */
  slug?: string;
  bin?: string;
  io?: TerminalIO;
  theme?: PolarisKeyTerminalTheme;
  /** Where the exit code goes on a refusal (default: `process.exitCode`). */
  setExitCode?: (code: number) => void;
}

async function gateCall(
  context: unknown,
  command: string,
  flags: Record<string, unknown>,
  options: RequireLicenseOptions,
  target: GateTarget | null,
): Promise<number | null> {
  const given = options.client;
  const client = given
    ? typeof given === "function"
      ? await given()
      : given
    : await target!.client(context);
  const slug = options.slug ?? client.product ?? target?.slug ?? "app";
  return runGate({
    client,
    command,
    ...(options.entitlement ? { entitlement: options.entitlement } : {}),
    flags: {
      json: flags.json === true,
      color: flags.color !== false,
      ascii: flags.ascii === true,
    },
    slug,
    bin: options.bin ?? target?.bin ?? slug,
    ...(target ? { mounted: target.mounted } : {}),
    ...((options.io ?? target?.io) ? { io: (options.io ?? target?.io)! } : {}),
    ...((options.theme ?? target?.theme)
      ? { theme: (options.theme ?? target?.theme)! }
      : {}),
    ...(target?.presentation ? { presentation: target.presentation } : {}),
    ...(target?.frame === false ? { frame: false } : {}),
  });
}

const defaultExitCode = (code: number): void => {
  process.exitCode = code;
};

/**
 * Wrap a host command's handler so it runs only on a usable license (and the entitlement, when
 * given). A refusal prints the fix, sets the exit code to 4 and does not call the handler:
 *
 *   program.command("export").action(requireLicense(runExport, { entitlement: "export.pdf" }));
 *
 * Works as a commander action and as a yargs handler. The commands the mount registered build
 * the client; pass `client` when nothing is mounted.
 */
export function requireLicense<A extends unknown[], R>(
  handler: (...args: A) => R | Promise<R>,
  options: RequireLicenseOptions = {},
): (...args: A) => Promise<R | undefined> {
  return async (...args: A) => {
    const last = args.at(-1);
    const first = args[0];
    let context: unknown = null;
    let command = "";
    let flags: Record<string, unknown> = {};
    let target: GateTarget | null = null;
    if (isCommand(last)) {
      context = last;
      command = wordsBelowRoot(last).join(" ");
      flags = last.optsWithGlobals?.() ?? last.opts?.() ?? {};
      target = targets.get(rootOf(last)) ?? latest;
    } else if (isArgv(first)) {
      context = first;
      command = (first._ as unknown[]).join(" ");
      flags = first;
      target = latest;
    } else target = latest;
    if (!options.client && !target)
      throw new Error(
        "requireLicense: register the kit commands first, or pass { client }.",
      );
    const code = await gateCall(context, command, flags, options, target);
    if (code === null) return handler(...args);
    (options.setExitCode ?? target?.setExitCode ?? defaultExitCode)(code);
    return undefined;
  };
}

export interface PolarisGateOptions {
  /** Top-level host commands to leave ungated (`help`, a `version` command, …). */
  except?: readonly string[];
  /** An entitlement every gated command needs. */
  entitlement?: string;
  /** How a refusal ends the process (default: `process.exit`). */
  exit?: (code: number) => never;
}

/** The slice of a commander program `polarisGate` uses. */
interface ProgramLike extends CommandLike {
  hook(
    event: "preAction",
    fn: (thisCommand: CommandLike, actionCommand: CommandLike) => unknown,
  ): unknown;
}

/**
 * Gate every host command on a usable license, in one line. Run it after
 * `registerPolarisCommands`: the Polaris Key verbs themselves are never gated.
 *
 *   polarisGate(program, { except: ["help"] });
 *
 * Commander runs the check before each command's action; a refusal ends the process with exit 4.
 */
export function polarisGate(
  program: ProgramLike,
  options: PolarisGateOptions = {},
): void {
  program.hook("preAction", async (_this, action) => {
    const target = targets.get(program) ?? latest;
    if (!target)
      throw new Error(
        "polarisGate: register the kit commands first (registerPolarisCommands).",
      );
    const words = wordsBelowRoot(action);
    if (target.owns?.(action)) return;
    if (options.except?.includes(words[0] ?? "")) return;
    const code = await gateCall(
      action,
      words.join(" "),
      action.optsWithGlobals?.() ?? action.opts?.() ?? {},
      options.entitlement ? { entitlement: options.entitlement } : {},
      target,
    );
    if (code !== null) (options.exit ?? process.exit)(code);
  });
}
