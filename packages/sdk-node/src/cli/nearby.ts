// Nearby sign-in in the terminal kit (I-47.12; plans/I-47-slices.md D-5, D-6, D-10;
// WIRE-CONTRACT-V5 §12.11.5 and §15.6.1). Two flows:
//
//   nearbyLogin        `login`, the new device (D). On an interactive terminal it looks for the
//                      person's other devices first. An approver that answers within 2 s is
//                      listed (the one device after 3 s is chosen, 1 chooses it sooner, several
//                      are picked by number), its code is shown as `482 913` and the person
//                      taps it on the other device (the screen reader line is the code's a11y
//                      name, never a visible row: UXR-47 B3). `c` uses a code instead. Nothing answering in 2 s
//                      cancels nearby and the regular sign-in runs. After the poll signed in, the
//                      account is shown: Enter confirms it, `n` (or Esc) signs out again.
//   devicesApproveFlow `devices approve`, the signed-in device (M). It listens for up to 300 s,
//                      shows the three codes as choices 1-3 and `d` = Deny, then the outcome and
//                      the license choice.
//
// Neither starts under `--json` or without a terminal (D-10). Every label from the other device
// is display data from an unverified peer: it goes through `clean` here as well as in the Painter
// (SR-47: terminal injection), and a secret (the handle, the proof, the token) is never drawn.

import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { LicenseChoiceView } from "@polaris-key/protocol/identity";
import { present } from "@polaris-key/ui-core/terminal";
import type { PolarisKeyClient } from "../client.js";
import { ErrorCode } from "../constants.generated.js";
import type {
  NearbyApprovalStep,
  NearbyAsk,
} from "../identity/nearbyApprover.js";
import type {
  NearbyApprover,
  NearbySignInSession,
} from "../identity/nearbySession.js";
import type { ShownIdentity } from "../identity/signIn.js";
import type { KitContext } from "./context.js";
import { EXIT, type CliJsonError, type FlowResult } from "./json.js";
import {
  codeRows,
  commandRows,
  endRow,
  gap,
  hintsRow,
  productHeader,
  problemRows,
  stepRow,
  textRow,
} from "./parts.js";
import { isCancel, isInterrupt, type Key } from "./term/keys.js";
import { type RailRow } from "./term/layout.js";
import { animate, spinnerFrames } from "./term/live.js";
import { clean } from "./term/sanitize.js";
import type { Line } from "./term/width.js";

/** An approver that answers within this long keeps the nearby sign-in going (D-5). */
export const LISTEN_MS = 2000;
/** A lone approver is chosen after this long (D-5). */
export const LONE_MS = 3000;
/** `devices approve` listens this long for a device to ask (D-6). */
export const APPROVE_MS = 300_000;
/** The state-directory file that says a browse worked here (macOS: the Local Network prompt has been seen). */
const BROWSED_FILE = "nearby-browsed";

const quiet = (ctx: KitContext) => ctx.caps.json;
const cmd = (ctx: KitContext, verb: string) => `${ctx.bin} ${verb}`;

/** A person-facing name from the other device, cleaned and never empty. */
function nameOf(label: string | null | undefined, fallback: string): string {
  const c = label === null || label === undefined ? "" : clean(label).trim();
  return c === "" ? fallback : c;
}

function codeError(ctx: KitContext, code: string | null): CliJsonError {
  const c = code ?? "unknown";
  return {
    code,
    title: ctx.copy.code(c, "title"),
    message: ctx.copy.code(c, "message"),
  };
}

const errCode = (e: unknown): string | null => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
};

/** A spinner row (a still mark where the terminal does not animate). */
function spinnerRow(ctx: KitContext, frame: number, text: string): RailRow {
  const frames = spinnerFrames(ctx.caps.unicode);
  return {
    mark: ctx.caps.animate
      ? { glyph: frames[frame % frames.length]! }
      : "active",
    spans: [{ text }],
    role: "spinner",
  };
}

/** A failure the person can only read: the error screen and the result that goes with it. */
function failure(
  ctx: KitContext,
  header: readonly RailRow[],
  e: unknown,
): FlowResult {
  const c = errCode(e);
  const error = codeError(ctx, c);
  ctx.rows([
    ...header,
    ...problemRows("fail", error.title, error.message),
    endRow(),
  ]);
  return {
    exitCode: EXIT.failed,
    state: "error",
    error: c ? error : { ...error, code: "internal" },
  };
}

const digit = (k: Key): number | null =>
  /^[1-9]$/.test(k.name) ? Number(k.name) : null;

// ── macOS: has a browse worked here? ───────────────────────────────────────────────────────

async function browsed(client: PolarisKeyClient): Promise<boolean> {
  try {
    await readFile(join(client.core.dirs.state, BROWSED_FILE));
    return true;
  } catch {
    return false;
  }
}

async function markBrowsed(client: PolarisKeyClient): Promise<void> {
  try {
    await mkdir(client.core.dirs.state, { recursive: true });
    await writeFile(join(client.core.dirs.state, BROWSED_FILE), "1\n");
  } catch {
    // Not remembered: the next run explains the prompt again.
  }
}

// ── login ──────────────────────────────────────────────────────────────────────────────────

/** What `loginFlow` supplies: its header and the blocks it shares with the device-code path. */
export interface LoginHooks {
  header(): RailRow[];
  /** "Signed in as Mara (mara@…)" for the account the sign-in showed. */
  signedIn(who: ShownIdentity): string | Line;
  /** The block of a sign-in that ended without signing in. */
  ended(how: "expired" | "denied" | "failed"): {
    rows: RailRow[];
    result: FlowResult;
  };
  /** The account now stored on this device, when the poll showed none. */
  current(): Promise<ShownIdentity>;
  status(): string;
}

/** The nearby path finished the sign-in (`FlowResult`), or the regular sign-in goes on. */
export type NearbyLoginResult =
  | FlowResult
  | { fallthrough: true; deviceCode: boolean };

const fall = (deviceCode = false): NearbyLoginResult => ({
  fallthrough: true,
  deviceCode,
});

function interruptedResult(fields: Record<string, unknown> = {}): FlowResult {
  return {
    exitCode: EXIT.interrupted,
    state: "interrupted",
    result: fields,
    error: { code: "interrupted", title: "", message: "" },
  };
}

type Stage = "looking" | "pick" | "code";

/**
 * `login`'s nearby start. Returns the sign-in's result, or `{fallthrough}` for the regular
 * sign-in (nothing nearby, nearby not on offer here, or `c` / "Not now"). Throws a failure the
 * caller draws.
 */
export async function nearbyLogin(
  ctx: KitContext,
  client: PolarisKeyClient,
  o: { verb: string; hooks: LoginHooks },
): Promise<NearbyLoginResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  const { hooks } = o;
  const keys = ctx.keys;
  if (keys === null) return fall();
  const available = await Promise.resolve()
    .then(() => client.identity.nearby.available({ role: "requester" }))
    .catch(() => false);
  if (!available) return fall();

  let live = ctx.live();
  let frame = 0;
  const spinner = (text: string): RailRow => spinnerRow(ctx, frame, text);

  // macOS asks for the Local Network on the first browse: say why before it does (D-A14).
  if (ctx.platform === "darwin" && !(await browsed(client))) {
    const rows = (): RailRow[] => [
      ...hooks.header(),
      stepRow("active", t("signin.nearby.promptTitle")),
      textRow(t("signin.nearby.prePrompt", { app: ctx.product.name })),
      hintsRow(ctx, t("signin.cli.nearbyPromptKeys")),
    ];
    live.draw(rows);
    let answer: "go" | "later" | "interrupt" = "later";
    for (;;) {
      const k = await keys.next();
      if (k === null) break;
      if (isCancel(k)) {
        answer = isInterrupt(k) ? "interrupt" : "later";
        break;
      }
      if (k.name === "return" || k.name === "enter") {
        answer = "go";
        break;
      }
    }
    live.close();
    if (answer === "interrupt")
      return interruptedResult({ state: "cancelled" });
    if (answer === "later") return fall();
    live = ctx.live();
  }

  let session: NearbySignInSession;
  try {
    session = (await client.identity.signIn.start({
      channel: "nearby",
    })) as NearbySignInSession;
  } catch (e) {
    live.close();
    // The product serves no nearby approval, or this runtime cannot take part: the regular sign-in.
    const code = errCode(e);
    if (
      code === ErrorCode.nearbyUnsupported ||
      code === ErrorCode.serviceUnavailable
    )
      return fall();
    throw e;
  }
  await markBrowsed(client);

  const abort = new AbortController();
  let list: readonly NearbyApprover[] = session.approvers;
  let code: string | null = session.code;
  let choosing = false;
  let loneGen = 0;
  let chosen: NearbyApprover | null = null;
  let lastStage: Stage | null = null;
  let ended: "code" | "cancel" | "handoff" | null = null;
  let interrupt = false;

  const label = (a: NearbyApprover): string =>
    nameOf(a.label, nameOf(a.platform, t("part.newDevice")));
  const stage = (): Stage =>
    code !== null ? "code" : list.length >= 1 ? "pick" : "looking";
  const screen = (): RailRow[] => {
    const rows: RailRow[] = [...hooks.header()];
    const s = stage();
    rows.push(stepRow("active", t("signin.nearby.title")));
    if (s === "code") {
      rows.push(
        {
          ...textRow(
            chosen === null
              ? t("signin.nearby.body", { app: ctx.product.name })
              : t("signin.nearby.bodyOn", {
                  app: ctx.product.name,
                  device: label(chosen),
                }),
          ),
          keep: true,
        },
        textRow(t("signin.nearby.match")),
        ...codeRows(ctx, code!),
        spinner(t("signin.cli.nearbyWaiting")),
        hintsRow(ctx, t("signin.cli.nearbyKey")),
      );
    } else if (s === "pick") {
      list
        .slice(0, 9)
        .forEach((a, i) =>
          rows.push(
            textRow([
              { text: String(i + 1), style: ["strong"] },
              { text: "  " },
              { text: label(a), keep: false },
            ]),
          ),
        );
      const n = Math.min(list.length, 9);
      rows.push(
        ...gap(ctx),
        hintsRow(
          ctx,
          n === 1
            ? t("signin.cli.nearbyPickOneKeys")
            : t("signin.cli.nearbyPickKeys", { n }),
        ),
      );
    } else {
      rows.push(
        spinner(t("signin.cli.nearbyLooking")),
        hintsRow(ctx, t("signin.cli.nearbyKey")),
      );
    }
    return rows;
  };
  const draw = (): void => {
    const s = stage();
    if (!ctx.caps.animate) {
      // A plain terminal prints a frame once: only a screen with something to read is printed,
      // each in a region of its own.
      if (s === "looking") return;
      if (s !== lastStage) {
        live.close();
        live = ctx.live();
      }
    }
    lastStage = s;
    live.draw(screen);
  };

  const pick = async (a: NearbyApprover): Promise<void> => {
    if (choosing || code !== null) return;
    choosing = true;
    try {
      chosen = a;
      code = (await session.choose(a.id)).code;
    } catch {
      choosing = false; // the device left: stay on the list
      chosen = null;
    }
    draw();
  };
  const onList = (): void => {
    const gen = ++loneGen;
    if (list.length === 1 && code === null) {
      const only = list[0]!;
      void ctx.delay(LONE_MS, abort.signal).then(() => {
        if (gen === loneGen && !abort.signal.aborted && list.length === 1)
          void pick(only);
      });
    }
    draw();
  };
  const off = session.onApprovers((l) => {
    list = l;
    onList();
  });
  void ctx.delay(LISTEN_MS, abort.signal).then(() => {
    if (!abort.signal.aborted && list.length === 0 && code === null) {
      // Nobody nearby answered: leave nearby, the regular sign-in is next.
      ended = "handoff";
      session.cancel();
      abort.abort();
    }
  });
  const stopSpin = animate(
    ctx.caps,
    (f) => {
      frame = f;
      if (stage() !== "pick") draw();
    },
    ctx.ticker,
  );
  onList();

  const keyLoop = (async () => {
    for (;;) {
      const k = await keys.next(abort.signal);
      if (k === null) return;
      if (isCancel(k)) {
        interrupt = isInterrupt(k);
        ended = "cancel";
        session.cancel();
        abort.abort();
        return;
      }
      if (k.name === "c") {
        ended = "code";
        session.cancel();
        abort.abort();
        return;
      }
      const n = digit(k);
      if (n !== null && n <= Math.min(list.length, 9)) void pick(list[n - 1]!);
    }
  })();

  let settled:
    | Awaited<ReturnType<NearbySignInSession["wait"]>>
    | { err: unknown };
  try {
    settled = await session.wait({ signal: abort.signal });
  } catch (e) {
    settled = { err: e };
  } finally {
    stopSpin();
    off();
  }
  const outcomeOf = (): "ok" | null => (ended === null ? "ok" : null);
  void outcomeOf;
  if (ended === "code" || ended === "handoff") {
    live.close();
    abort.abort();
    await keyLoop;
    return fall(ended === "code");
  }
  abort.abort();
  await keyLoop;
  const finish = (result: RailRow[]): void => {
    const rows = [...hooks.header(), ...result];
    live.commit(() => rows, result);
  };
  if (
    ended === "cancel" ||
    ("kind" in settled && settled.kind === "cancelled")
  ) {
    session.cancel();
    finish([endRow(t("cli.nothingChanged"))]);
    if (interrupt) return interruptedResult({ state: "cancelled" });
    return {
      exitCode: EXIT.failed,
      state: "cancelled",
      result: { state: "cancelled" },
    };
  }
  if ("err" in settled) {
    const e = settled.err;
    const c = errCode(e);
    if (c === ErrorCode.signInDenied || c === ErrorCode.signInFailed) {
      const b = hooks.ended(c === ErrorCode.signInDenied ? "denied" : "failed");
      finish(b.rows);
      return b.result;
    }
    live.close();
    throw e;
  }
  if (settled.kind !== "signedIn") {
    const b = hooks.ended("expired");
    finish(b.rows);
    return b.result;
  }

  // Signed in by the poll. Until the person says the account is theirs, nothing from the other
  // device is acted on (V5 §15.6.1 rule 12): the account is shown, Enter confirms, n signs out.
  const shown: ShownIdentity =
    settled.identity &&
    (present(settled.identity.name) || present(settled.identity.email))
      ? settled.identity
      : await hooks.current();
  const email = present(shown.email);
  const line = email
    ? t("signin.nearby.done", { email: clean(email) })
    : hooks.signedIn(shown);
  live.close();
  live = ctx.live();
  live.draw(() => [
    ...hooks.header(),
    // Still held: the active mark, not the check. The check is the committed frame (UXR-47 B2).
    stepRow("active", line),
    hintsRow(ctx, t("signin.cli.nearbyDoneKeys")),
  ]);
  let confirmed = false;
  let interrupted = false;
  for (;;) {
    const k = await keys.next();
    if (k === null) break;
    if (k.name === "return" || k.name === "enter") {
      confirmed = true;
      break;
    }
    if (k.name === "n" || isCancel(k)) {
      interrupted = isInterrupt(k);
      break;
    }
  }
  if (confirmed) {
    await session.confirmAccount().catch(() => undefined);
    finish([stepRow("ok", line), endRow()]);
    return {
      exitCode: EXIT.ok,
      state: "signedIn",
      result: {
        state: "signedIn",
        name: shown.name ?? null,
        email: shown.email ?? null,
        attached: settled.activation.attached ?? null,
        status: hooks.status(),
      },
    };
  }
  // "Not you?": drop the held records, sign out, and say how to sign in again.
  await session.declineAccount().catch(() => undefined);
  finish([
    stepRow("done", t("cli.logout.done", { product: ctx.product.name })),
    endRow(t("signin.cli.signInAgain", { command: cmd(ctx, o.verb) })),
  ]);
  if (interrupted) return interruptedResult({ state: "declined" });
  return {
    exitCode: EXIT.failed,
    state: "declined",
    result: { state: "declined" },
  };
}

// ── devices approve ────────────────────────────────────────────────────────────────────────

/** The block a step ends in, and the result it earns. */
function endOf(
  ctx: KitContext,
  step: Exclude<NearbyApprovalStep, { kind: "choose" }>,
  device: string,
  title: string,
): { rows: RailRow[]; result: FlowResult } {
  const t = ctx.copy.t.bind(ctx.copy);
  const result = (
    exitCode: number,
    state: string,
    fields: Record<string, unknown> = {},
  ): FlowResult => ({ exitCode, state, result: { state, ...fields } });
  switch (step.kind) {
    case "approved":
      return {
        rows: [
          stepRow("ok", t("signin.nearby.approved", { device: title })),
          endRow(),
        ],
        result: result(EXIT.ok, "approved", { device }),
      };
    case "mismatch":
      return {
        rows: [
          stepRow("warn", t("signin.nearby.mismatch", { device })),
          endRow(t("signin.nearby.expiredBody", { device })),
        ],
        result: result(EXIT.failed, "mismatch"),
      };
    case "denied":
      // The person's own choice, like a cancel (DL7): no mark that reads as a failure.
      return {
        rows: [endRow(t("signin.approve.deniedDone"))],
        result: result(EXIT.failed, "denied"),
      };
    case "not-nearby":
      return {
        rows: [
          stepRow("warn", t("signin.nearby.notNearby", { device: title })),
          textRow(t("signin.nearby.notNearbyBody", { device })),
          endRow(),
        ],
        result: result(EXIT.failed, "not-nearby"),
      };
    case "expired":
      return {
        rows: [
          stepRow("warn", ctx.copy.code("sign-in-expired", "title")),
          textRow(t("signin.nearby.expiredBody", { device })),
          endRow(),
        ],
        result: result(EXIT.failed, "expired"),
      };
    case "device-limit":
      return {
        rows: [
          stepRow("warn", ctx.copy.code("device_limit", "title")),
          textRow(t("signin.nearby.deviceLimitBody", { device })),
          ...commandRows(ctx, [
            {
              label: [
                {
                  text: cmd(ctx, "devices list"),
                  style: ["strong"],
                  keep: true,
                },
              ],
              value: [{ text: t("cli.verb.devicesList") }],
            },
          ]),
          endRow(),
        ],
        result: result(EXIT.failed, "device-limit"),
      };
    case "rate-limited":
      return {
        rows: [
          stepRow("warn", ctx.copy.code("rate_limited", "title")),
          textRow(t("signin.nearby.rateLimitedBody", { device })),
          endRow(),
        ],
        result: result(EXIT.failed, "rate-limited"),
      };
    case "account-required":
      return accountRequired(ctx);
  }
}

/** Signed out: there is no account to approve for. */
function accountRequired(ctx: KitContext): {
  rows: RailRow[];
  result: FlowResult;
} {
  const t = ctx.copy.t.bind(ctx.copy);
  return {
    rows: [
      stepRow("warn", ctx.copy.code("account_required", "title")),
      // "Sign in" once: the title says why, the command row says what to run.
      ...commandRows(ctx, [
        {
          label: [{ text: cmd(ctx, "login"), style: ["strong"], keep: true }],
          value: [{ text: t("signin.key.signIn") }],
        },
      ]),
      endRow(),
    ],
    result: {
      exitCode: EXIT.failed,
      state: "account-required",
      result: { state: "account-required" },
    },
  };
}

/**
 * `devices approve`: wait for a device nearby to ask, show the three codes, and approve the one
 * the person picks. The advert stands only while this runs and is stopped on every way out (D-6).
 */
export async function devicesApproveFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  const header = () => productHeader(ctx, "devices approve");
  const keys = ctx.keys;
  if (quiet(ctx) || keys === null) {
    // Both sides need a person (D-10): a usage error, before anything starts.
    const message = t("cli.approve.needsPerson", {
      command: cmd(ctx, "devices approve"),
    });
    if (!quiet(ctx))
      ctx.rows([
        ...header(),
        ...problemRows("fail", t("cli.help.usage"), message),
        endRow(),
      ]);
    return {
      exitCode: EXIT.usage,
      state: "error",
      result: { usage: cmd(ctx, "devices approve") },
      error: {
        code: "usage",
        title: t("cli.help.usage"),
        message,
        showMessage: true,
      },
    };
  }

  let resolveAsk!: (a: NearbyAsk) => void;
  const asked = new Promise<NearbyAsk>((r) => (resolveAsk = r));
  let handle: Awaited<ReturnType<typeof client.identity.nearby.onRequest>>;
  try {
    handle = await client.identity.nearby.onRequest((a) => resolveAsk(a), {
      prompt: true,
    });
  } catch (e) {
    const c = errCode(e);
    if (c === ErrorCode.nearbyUnsupported) {
      const rows = [
        ...header(),
        stepRow("warn", t("signin.cli.approveUnsupportedTitle")),
        endRow(t("signin.cli.approveUnsupported")),
      ];
      ctx.rows(rows);
      return {
        exitCode: EXIT.failed,
        state: "unsupported",
        result: { state: "unsupported" },
      };
    }
    if (c === ErrorCode.accountRequired || c === ErrorCode.noToken) {
      const b = accountRequired(ctx);
      ctx.rows([...header(), ...b.rows]);
      return b.result;
    }
    return failure(ctx, header(), e);
  }

  const abort = new AbortController();
  let live = ctx.live();
  let frame = 0;
  const spinner = (text: string): RailRow => spinnerRow(ctx, frame, text);
  let rows: () => RailRow[] = () => [];
  const show = (r: () => RailRow[]): void => {
    rows = r;
    live.draw(rows);
  };
  const stopSpin = animate(
    ctx.caps,
    (f) => {
      frame = f;
      live.draw(rows);
    },
    ctx.ticker,
  );
  const done = (result: RailRow[]): void => {
    const all = [...header(), ...result];
    live.commit(() => all, result);
  };
  let interrupt = false;
  try {
    // Waiting for a device to ask: Esc stops, and 300 s end it.
    show(() => [
      ...header(),
      stepRow("active", t("signin.nearby.menu")),
      spinner(t("signin.cli.approveWaiting")),
      hintsRow(ctx, t("signin.cli.approveWaitKeys")),
    ]);
    type Early = "timeout" | "cancel";
    const early = new Promise<Early>((resolve) => {
      void ctx.delay(APPROVE_MS, abort.signal).then(() => {
        if (!abort.signal.aborted) resolve("timeout");
      });
      void (async () => {
        for (;;) {
          const k = await keys.next(abort.signal);
          if (k === null) return;
          if (isCancel(k)) {
            interrupt = isInterrupt(k);
            resolve("cancel");
            return;
          }
        }
      })();
    });
    const first = await Promise.race([asked, early]);
    abort.abort();
    if (typeof first === "string") {
      done([endRow(t("cli.nothingChanged"))]);
      if (interrupt) return interruptedResult({ state: "cancelled" });
      return {
        exitCode: EXIT.failed,
        state: first === "timeout" ? "timeout" : "cancelled",
        result: { state: first === "timeout" ? "timeout" : "cancelled" },
      };
    }
    const ask = first;
    const device = nameOf(ask.device, t("part.newDevice"));
    const title = nameOf(ask.device, t("part.newDeviceTitle"));

    // The three codes; the person taps the one the other device shows.
    show(() => [
      ...header(),
      stepRow("active", t("signin.nearby.ask", { device })),
      textRow(t("signin.approve.warning"), ["muted"]),
      textRow(t("signin.nearby.askBody")),
      ...gap(ctx),
      ...ask.codes.map((c, i) =>
        textRow([
          { text: String(i + 1), style: ["strong"] },
          { text: "  " },
          { text: c, style: ["code"], keep: true },
        ]),
      ),
      ...gap(ctx),
      hintsRow(ctx, t("signin.cli.approveKeys")),
    ]);
    const ask1 = async (): Promise<NearbyApprovalStep> => {
      for (;;) {
        const k = await keys.next();
        if (k === null || isCancel(k) || k.name === "d") {
          interrupt = k !== null && isInterrupt(k);
          await ask.deny();
          return { kind: "denied" };
        }
        const n = digit(k);
        if (n !== null && n <= 3) {
          show(() => [
            ...header(),
            stepRow("active", t("signin.nearby.ask", { device })),
            spinner(t("common.working")),
          ]);
          return ask.pick(ask.codes[n - 1]!);
        }
      }
    };
    // The license choice, as many rounds as the Worker asks for (it is asked at most three times).
    const choose = async (
      cur: Extract<NearbyApprovalStep, { kind: "choose" }>,
    ): Promise<NearbyApprovalStep> => {
      const view = cur.choices as LicenseChoiceView;
      const free = view.choices.filter((c) => c.state === "free").slice(0, 9);
      const create = view.create !== null;
      const options: ({ id: string } | "create")[] = [
        ...free.map((c) => ({ id: c.id })),
        ...(create ? (["create"] as const) : []),
      ];
      show(() => [
        ...header(),
        stepRow("active", t("signin.nearby.chooseTitle", { device })),
        textRow(t("signin.nearby.chooseLede", { product: ctx.product.name })),
        ...free.map((c, i) =>
          textRow([
            { text: String(i + 1), style: ["strong"] },
            { text: "  " },
            { text: nameOf(c.name, nameOf(c.tierName, "")), keep: false },
          ]),
        ),
        ...(create
          ? [
              textRow([
                { text: String(free.length + 1), style: ["strong"] },
                { text: "  " },
                { text: t("signin.choice.create") },
              ]),
            ]
          : []),
        ...gap(ctx),
        hintsRow(
          ctx,
          options.length === 1
            ? t("signin.cli.approveChooseOneKeys")
            : t("signin.cli.approveChooseKeys", { n: options.length }),
        ),
      ]);
      for (;;) {
        const k = await keys.next();
        if (k === null || isCancel(k)) {
          interrupt = k !== null && isInterrupt(k);
          return cur.cancel();
        }
        const n = digit(k);
        const opt = n === null ? undefined : options[n - 1];
        if (opt === undefined) continue;
        return cur.choose(
          opt === "create"
            ? { kind: "create" }
            : { kind: "license", licenseId: opt.id },
        );
      }
    };
    let step = await ask1();
    while (step.kind === "choose") step = await choose(step);
    const b = endOf(ctx, step, device, title);
    done(b.rows);
    return interrupt ? interruptedResult(b.result.result) : b.result;
  } catch (e) {
    live.close();
    return failure(ctx, header(), e);
  } finally {
    stopSpin();
    abort.abort();
    await handle.stop().catch(() => undefined);
  }
}
