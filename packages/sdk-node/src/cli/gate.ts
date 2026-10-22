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
import {
  activateFlow,
  busyAfter,
  ensureDiscovery,
  portalRows,
} from "./flows.js";
import { envelope, EXIT, jsonLine } from "./json.js";
import { endRow, fixRows, gap, problemRows, textRow } from "./parts.js";
import type { RailRow } from "./term/layout.js";
import {
  presentationSourceOf,
  type PolarisKeyTerminalTheme,
  type PresentationSource,
} from "./theme.js";

/** The gate statuses a host's command runs on (with the entitlement held). */
const USABLE: readonly string[] = ["ok", "grace", "not-applicable"];
/** A license check that takes longer than this shows "Checking your license…" on stderr. */
const CHECKING_AFTER_MS = 400;
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
  /** The product page, or the developer's name where the kit knows no page. */
  link: "portal" | "contact" | null;
  fixes: StatusFix[];
}
interface StatusFix {
  verb: string;
  key: string;
}

const FIX_COPY: Record<string, string> = {
  activate: "welcome.useKey",
  login: "welcome.signIn",
  "update apply": "status.update",
  status: "cli.verb.status",
};

/** Every status the gate decides on; anything else is a check that failed (fail closed). */
const KNOWN: readonly string[] = [
  ...USABLE,
  ...INLINE_FLOW,
  "version-too-old",
  "version-too-new",
  "channel-not-entitled",
];

/**
 * The refusal for a status the command cannot run on (the `gate` rows of the `cli` family): the
 * title alone, because the rows that fix it follow. Not-entitled, channel and version-too-new lead
 * with the product page (nothing a command does fixes them); a refusal whose fix verbs the mount
 * does not offer is led by it too, so it never has zero rows.
 */
function refusalFor(
  status: string,
  usable: boolean,
  ctx: KitContext,
  r: Pick<GateRun, "command" | "mounted">,
  hasPage: boolean,
): Refusal {
  const t = ctx.copy.t.bind(ctx.copy);
  const notEntitled = usable || status === "channel-not-entitled";
  const verbs = notEntitled
    ? ["status"]
    : status === "version-too-new"
      ? ["status"]
      : status === "version-too-old"
        ? ["update apply"]
        : ["activate", "login"];
  const fixes = verbs
    .filter((v) => r.mounted === undefined || r.mounted.includes(v))
    .map((verb) => ({ verb, key: FIX_COPY[verb]! }));
  const leads = notEntitled || status === "version-too-new";
  return {
    error: notEntitled ? "not_entitled" : "license_required",
    title: usable
      ? t("cli.gate.notIncluded", { command: r.command })
      : status === "needs-activation"
        ? t("cli.gate.needs", { command: r.command })
        : t(`core.gate.${status}.title`),
    message: usable
      ? t("core.codes.not_entitled.message")
      : t(`core.gate.${status}.message`),
    link: leads || fixes.length === 0 ? (hasPage ? "portal" : "contact") : null,
    fixes,
  };
}

/** The link row of a refusal: the product page, or "Contact {developer}". */
function linkRows(
  ctx: KitContext,
  client: PolarisKeyClient | undefined,
  link: "portal" | "contact",
): RailRow[] {
  if (link === "portal" && client) return portalRows(ctx, client);
  return [
    textRow(
      ctx.copy.t("status.contact", {
        developer: ctx.product.developer ?? ctx.product.name,
      }),
    ),
  ];
}

/**
 * Check the license for a host command. Returns null when the command may run, else the exit
 * code to end with (4 for a refusal; the flow's own code when the inline flow failed or was
 * cancelled). Never throws for a license problem.
 */
export async function runGate(r: GateRun): Promise<number | null> {
  try {
    return await decide(r);
  } catch {
    // The check could not be made (it threw, or answered a status this kit does not know): the
    // command does not run, whatever the license is (fail closed).
    return failClosed(r);
  }
}

/**
 * Say the license could not be checked: a cross, what happened and no fix, exit 4 (`--json`: the
 * `license_required` result line). The exit code is 4 whatever fails while saying it.
 */
export async function failClosed(
  r: Omit<GateRun, "client"> & { client?: PolarisKeyClient },
): Promise<number> {
  try {
    const flags = {
      ...(r.flags?.json ? { json: true } : {}),
      ...(r.flags?.color === false ? { color: false } : {}),
      ...(r.flags?.ascii ? { ascii: true } : {}),
    };
    const errCtx = await createKitContext({
      slug: r.slug,
      bin: r.bin,
      ...(r.theme ? { theme: r.theme } : {}),
      presentation: r.presentation ?? presentationSourceOf(r.client),
      flags,
      io: { ...r.io, stdout: r.io?.stderr ?? process.stderr },
      queryScheme: false,
    });
    try {
      const t = errCtx.copy.t.bind(errCtx.copy);
      const title = t("core.codes.sync-failed.title");
      const message = t("core.codes.sync-failed.message");
      if (errCtx.caps.json) {
        (r.io?.stdout ?? process.stdout).write(
          `${jsonLine(
            envelope(r.command, {
              exitCode: EXIT.licenseRequired,
              error: { code: "license_required", title, message },
            }),
          )}\n`,
        );
      } else errCtx.rows([...problemRows("fail", title, message), endRow()]);
    } finally {
      errCtx.close();
    }
  } catch {
    // Nothing more can be said; the refusal below still stands.
  }
  return EXIT.licenseRequired;
}

async function decide(r: GateRun): Promise<number | null> {
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
  // Everything the gate says to a person goes to stderr, laid out and coloured for that stream
  // (no escape off a terminal), and the kit's own frame stays even where the host's flows have none.
  const { frame: _frame, ...errBase } = base;
  const errCtx = await createKitContext({
    ...errBase,
    flags,
    io: {
      ...r.io,
      stdout: r.io?.stderr ?? process.stderr,
    },
    queryScheme: false,
  });
  const check = () => {
    const status = client.status().status as string;
    if (!KNOWN.includes(status)) throw new Error(`unknown status ${status}`);
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
      await busyAfter(
        errCtx,
        errCtx.copy.t("gate.checking"),
        async () => {
          await ensureDiscovery(client);
          await client.sync().catch(() => undefined);
        },
        CHECKING_AFTER_MS,
      );
      s = check();
      if (s.usable && s.entitled) return null;
    }
    let flowExit: number | null = null;
    if (!s.usable && ctx.caps.interactive && INLINE_FLOW.includes(s.status)) {
      const flow = await activateFlow(ctx, client, {
        reason: ctx.copy.t("cli.gate.needs", { command: r.command }),
      });
      if (flow.exitCode !== EXIT.ok) {
        // Esc leaves the command unrun: say so and show the way back. Ctrl-C ends quietly.
        if (flow.state !== "cancelled") return flow.exitCode;
        flowExit = flow.exitCode;
      } else {
        s = check();
        if (s.usable && s.entitled) return null;
      }
    }
    const refusal = refusalFor(
      s.status,
      s.usable,
      ctx,
      r,
      typeof client.product === "string" && client.product !== "",
    );
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
    errCtx.rows([
      ...problemRows("warn", refusal.title),
      ...(refusal.link ? linkRows(errCtx, client, refusal.link) : []),
      ...(refusal.fixes.length
        ? [...gap(errCtx), ...fixRows(errCtx, refusal.fixes)]
        : []),
      endRow(),
    ]);
    return flowExit ?? EXIT.licenseRequired;
  } finally {
    errCtx.close();
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
  let client: PolarisKeyClient;
  try {
    client = given
      ? typeof given === "function"
        ? await given()
        : given
      : await target!.client(context);
  } catch {
    // No client, no verdict: the command does not run.
    const slug = options.slug ?? target?.slug ?? "app";
    return failClosed({
      command,
      flags: {
        json: flags.json === true,
        color: flags.color !== false,
        ascii: flags.ascii === true,
      },
      slug,
      bin: options.bin ?? target?.bin ?? slug,
      ...((options.io ?? target?.io)
        ? { io: (options.io ?? target?.io)! }
        : {}),
      ...((options.theme ?? target?.theme)
        ? { theme: (options.theme ?? target?.theme)! }
        : {}),
      ...(target?.presentation ? { presentation: target.presentation } : {}),
    });
  }
  const slug = options.slug || client.product || target?.slug || "app";
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
        "requireLicense: call registerPolarisCommands(program, { config, version }) before the program runs, or pass { client }.",
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
