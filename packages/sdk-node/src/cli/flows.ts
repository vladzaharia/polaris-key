// The terminal kit's drop-in flows (docs/design/UI-KITS.md §1.3 layer a, §1.4 "Terminal";
// SIGN-IN.md §4.15 frame 32): one function per verb that runs the SDK call, draws the steps on
// the rail and returns the exit code and the `--json` envelope's fields. Under `--json` a flow
// draws nothing and never prompts.
//
// The flows sit on the headless models (models.ts) and the styled parts (parts.ts); every
// visible string is a catalog key (copy.ts). Masked key entry never shows a character of the
// secret, and a key is never printed, logged or put in the JSON.

import type { JSONValue } from "@polaris-key/protocol/core";
import type { PolarisKeyClient } from "../client.js";
import type { SignInPrompt, SignInResult } from "../identity/client.js";
import type { ActivationResult } from "../license/endpoints.js";
import { SDK_NAME, SDK_VERSION } from "../version.js";
import { Feature } from "../constants.generated.js";
import { getConfig } from "./commands.js";
import type { KitContext } from "./context.js";
import { eventLine, EXIT, type CliJsonError, type FlowResult } from "./json.js";
import {
  activationOutcome,
  clock,
  devicesView,
  installView,
  keyVerdict,
  progressView,
  statusExit,
  statusView,
  updateView,
  type ActivateOutcome,
  type DeviceLimitView,
} from "./models.js";
import {
  codeRows,
  endRow,
  fixRows,
  gap,
  hintsRow,
  keyMask,
  linkSpan,
  problemRows,
  productHeader,
  seatMeter,
  sep,
  stepRow,
  tableRows,
  textRow,
} from "./parts.js";
import {
  CANCEL,
  INTERRUPT,
  plainConfirm,
  plainSecret,
  promptConfirm,
  promptSecret,
} from "./term/prompt.js";
import { isCancel, isInterrupt } from "./term/keys.js";
import type { RailRow } from "./term/layout.js";
import { animate, LiveRegion, spinnerFrames } from "./term/live.js";
import { osc52 } from "./term/osc.js";
import { clean } from "./term/sanitize.js";
import { percent, progressSpans, qrLines } from "./term/progress.js";
import type { Line } from "./term/width.js";

// ── Helpers ────────────────────────────────────────────────────────────────────────────────

const quiet = (ctx: KitContext) => ctx.caps.json;

function show(ctx: KitContext, rows: readonly RailRow[]): void {
  if (!quiet(ctx)) ctx.rows(rows);
}

/** `<bin> <verb>`: the command a "Run … again" line names. */
const cmd = (ctx: KitContext, verb: string) => `${ctx.bin} ${verb}`;

/** The error envelope for a registry code, in the catalog's words. */
function codeError(ctx: KitContext, code: string | null): CliJsonError {
  const c = code ?? "unknown";
  return {
    code,
    title: ctx.copy.code(c, "title"),
    message: ctx.copy.code(c, "message"),
  };
}

/** A thrown error's registry code, when it carries one. */
function errorCode(e: unknown): string | null {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

const NETWORK = new Set(["network", "network-error", "transport", "timeout"]);

/** Ctrl-C: exit 130 with `"error": "interrupted"` (the Python kit's). */
function interrupted(fields: Record<string, unknown> = {}): FlowResult {
  return {
    exitCode: EXIT.interrupted,
    state: "interrupted",
    result: fields,
    error: { code: "interrupted", title: "", message: "" },
  };
}

/** Draw a thrown error and return its result. */
function failed(ctx: KitContext, e: unknown): FlowResult {
  const code = errorCode(e);
  const error = codeError(ctx, code);
  const network = code !== null && NETWORK.has(code);
  show(ctx, [
    ...problemRows(network ? "warn" : "fail", error.title, error.message),
    endRow(),
  ]);
  return {
    exitCode: EXIT.failed,
    state: "error",
    error: code ? error : { ...error, code: "internal" },
  };
}

/**
 * Run `work` with a spinner row (`label`) on a terminal that animates; elsewhere nothing is
 * drawn. The row is cleared when the work ends, so the next rows replace it.
 */
async function busy<T>(
  ctx: KitContext,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  // A short wait is not worth a line in a log: without animation nothing is drawn (D-77).
  if (quiet(ctx) || !ctx.caps.animate) return work();
  const live = new LiveRegion(ctx.stdout, ctx.caps);
  const frames = spinnerFrames(ctx.caps.unicode);
  const stop = animate(
    ctx.caps,
    (f) =>
      live.draw(
        ctx.render([
          {
            mark: { glyph: frames[f % frames.length]! },
            spans: [{ text: label }],
          },
        ]),
      ),
    ctx.ticker,
  );
  try {
    return await work();
  } finally {
    stop();
    live.commit([]);
  }
}

/** Read a line from a piped stdin (the key, when there is no terminal to ask on). */
async function readPiped(ctx: KitContext): Promise<string> {
  const it = ctx.stdin[Symbol.asyncIterator];
  if (!it) return "";
  let buf = "";
  for await (const chunk of ctx.stdin as AsyncIterable<Buffer | string>) {
    buf += chunk.toString();
    if (buf.length > 4096) break;
  }
  return (
    buf
      .split(/\r?\n/)
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

const lastPercent = new WeakMap<KitContext, Map<string, number>>();

/** A `--json` progress line, at most one per whole percent per item. */
function emitProgress(
  ctx: KitContext,
  command: string,
  done: number,
  total: number,
  fields: Record<string, unknown> = {},
): void {
  if (!quiet(ctx)) return;
  const p = percent(done, total);
  const key = `${command}\u0000${String(fields.packId ?? "")}`;
  const seen = lastPercent.get(ctx) ?? new Map<string, number>();
  lastPercent.set(ctx, seen);
  if (seen.get(key) === p) return;
  seen.set(key, p);
  ctx.stdout.write(
    `${eventLine(command, "progress", { ...fields, done, total, percent: p })}\n`,
  );
}

/** A catalog string whose `{url}` is drawn as a link (OSC 8 where the terminal takes it). */
function withLink(ctx: KitContext, key: string, url: string): Line {
  const mark = "\u0000";
  const [before = "", after = ""] = ctx.copy.t(key, { url: mark }).split(mark);
  return [
    ...(before ? [{ text: before }] : []),
    linkSpan(url),
    ...(after ? [{ text: after }] : []),
  ];
}

function formatDate(ctx: KitContext, epochSeconds: number): string {
  return new Intl.DateTimeFormat(ctx.copy.locale, {
    month: "short",
    day: "numeric",
  }).format(new Date(epochSeconds * 1000));
}

function formatBytes(ctx: KitContext, bytes: number): string {
  const mb = bytes / 1_000_000;
  return new Intl.NumberFormat(ctx.copy.locale, {
    style: "unit",
    unit: mb >= 1 ? "megabyte" : "kilobyte",
    maximumFractionDigits: mb >= 10 || mb < 1 ? 0 : 1,
  }).format(mb >= 1 ? mb : bytes / 1000);
}

function formatDuration(ctx: KitContext, seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  const [value, unit] =
    s >= 3600
      ? [Math.round(s / 3600), "hour"]
      : s >= 60
        ? [Math.round(s / 60), "minute"]
        : [s, "second"];
  return new Intl.NumberFormat(ctx.copy.locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
  }).format(value);
}

// ── status ─────────────────────────────────────────────────────────────────────────────────

/** `status`: the license, offline time and version; a blocked license with its fixes. */
export async function statusFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const st = client.status();
  const info = client.license.licenseInfo();
  const store = await client.storeStatus().catch(() => null);
  const services = client.capabilities();
  const view = statusView({
    status: st.status,
    ...(st.graceUntil !== undefined ? { graceUntil: st.graceUntil } : {}),
    info,
    now: Math.floor(ctx.now() / 1000),
    can: {
      signIn: services.identity?.enabled === true,
      update:
        services.update?.enabled === true || services.release?.enabled === true,
    },
  });
  const exitCode = statusExit(st.status);
  // The Python kit's status fields (UI-KITS §1.4 "Terminal"), plus the tier.
  const profile = info?.profile ?? client.license.getProfile?.() ?? null;
  const result = {
    status: st.status,
    usable: exitCode === EXIT.ok,
    component: view.component,
    state: view.state,
    graceUntil: st.graceUntil ?? null,
    allowedRange: st.allowedRange
      ? { min: st.allowedRange.min ?? null, max: st.allowedRange.max ?? null }
      : null,
    profile: profile
      ? { name: profile.name ?? null, email: profile.email ?? null }
      : null,
    version: client.core.version,
    channel: client.core.channel,
    tier: info?.tierLabel ?? info?.tier ?? null,
    tokenStore: store?.backend ?? null,
  };
  if (quiet(ctx)) return { exitCode, state: view.state, result };
  const t = ctx.copy.t.bind(ctx.copy);
  const rows: RailRow[] = productHeader(ctx, "status");
  switch (view.component) {
    case "AccountAndLicense": {
      const licenseValue: Line = [
        {
          text: view.tier
            ? t("account.tier", { tier: view.tier })
            : t("part.status.ok"),
          style: ["strong"],
        },
        {
          text: ` ${ctx.symbols.separator} ${view.holder ?? t("account.keyOnly")}`,
          style: ["muted"],
        },
      ];
      const table: Array<{ mark: "ok"; label: string; value: Line }> = [
        { mark: "ok", label: t("cli.status.license"), value: licenseValue },
      ];
      if (view.graceUntil !== null)
        table.push({
          mark: "ok",
          label: t("cli.status.offline"),
          value: [
            {
              text: t("cli.status.offlineUntil", {
                date: formatDate(ctx, view.graceUntil),
              }),
            },
          ],
        });
      table.push({
        mark: "ok",
        label: t("cli.status.version"),
        value: [
          { text: client.core.version, style: ["strong"] },
          {
            text: ` ${ctx.symbols.separator} ${client.core.channel}`,
            style: ["muted"],
          },
        ],
      });
      rows.push(...tableRows(table));
      break;
    }
    case "GraceBanner":
      rows.push(
        stepRow(
          "warn",
          view.state === "last-day"
            ? t("grace.lastDay", { product: ctx.product.name })
            : sep(ctx, t("grace.daysLeft", { days: view.daysLeft })),
        ),
        textRow(
          t("grace.deadline", { date: formatDate(ctx, view.graceUntil) }),
          ["muted"],
        ),
      );
      break;
    case "PolarisKeyGate":
      if (view.state === "licensed") {
        rows.push(
          stepRow("ok", t("core.gate.not-applicable.title")),
          textRow(t("core.gate.not-applicable.message")),
        );
        break;
      }
      rows.push(
        ...problemRows(
          "active",
          t("core.gate.needs-activation.title"),
          t("core.gate.needs-activation.message"),
        ),
        ...gap(ctx),
        ...fixRows(ctx, view.fixes),
      );
      break;
    case "StatusScreen": {
      const shown = view.fixes.filter((f) => f.verb !== null);
      rows.push(
        ...problemRows(
          "fail",
          t(`core.gate.${view.state}.title`),
          t(`core.gate.${view.state}.message`),
        ),
      );
      if (shown.length)
        rows.push(
          ...gap(ctx),
          textRow(t("cli.status.fixes", { product: ctx.product.name })),
          ...fixRows(ctx, shown),
        );
      break;
    }
  }
  if (ctx.theme.poweredBy)
    rows.push(...gap(ctx), textRow(t("part.poweredBy"), ["muted"]));
  rows.push(endRow());
  ctx.rows(rows);
  return { exitCode, state: view.state, result };
}

/** The gate check a product runs before its own work (Boot → licensed, or the status). */
export async function checkFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  await busy(ctx, ctx.copy.t("gate.checking"), () =>
    client.sync().catch(() => undefined),
  );
  const st = client.status();
  if (statusExit(st.status) !== EXIT.ok) return statusFlow(ctx, client);
  const info = client.license.licenseInfo();
  const tier = info?.tierLabel ?? info?.tier;
  show(ctx, [
    stepRow(
      "ok",
      tier ? `${ctx.product.name} ${tier}` : ctx.product.name,
      `${ctx.symbols.separator} ${ctx.copy.t("boot.ready")}`,
    ),
  ]);
  return {
    exitCode: EXIT.ok,
    state: "licensed",
    result: { status: st.status, usable: true },
  };
}

// ── activate, enroll, DeviceLimit ──────────────────────────────────────────────────────────

/** The DeviceLimit rows (browser mode: the portal page that frees a seat). */
function deviceLimitRows(ctx: KitContext, v: DeviceLimitView): RailRow[] {
  const t = ctx.copy.t.bind(ctx.copy);
  const rows: RailRow[] = [];
  if (v.used !== null && v.limit !== null)
    rows.push(
      stepRow(
        "warn",
        t("deviceLimit.heading", { used: v.used, limit: v.limit }),
      ),
      seatMeter(ctx, v.used, v.limit),
    );
  else rows.push(stepRow("warn", t("core.activation.device-limit.title")));
  if (v.manageUrl)
    rows.push(
      textRow(t("deviceLimit.browser", { product: ctx.product.name })),
      textRow([linkSpan(v.manageUrl)]),
    );
  else rows.push(textRow(t("core.activation.device-limit.message")));
  return rows;
}

/** Rows for an activation outcome other than the device limit. */
function outcomeRows(
  ctx: KitContext,
  o: Exclude<ActivateOutcome, { state: "device-limit" }>,
): RailRow[] {
  const t = ctx.copy.t.bind(ctx.copy);
  if (o.state === "done")
    return [
      stepRow(
        "ok",
        t("core.activation.ok.title"),
        o.tier
          ? `${ctx.symbols.separator} ${t("account.tier", { tier: o.tier })}`
          : undefined,
      ),
      textRow(t("core.activation.ok.message")),
    ];
  if (o.kind === "key-entry-limit")
    return [
      ...problemRows(
        "fail",
        t("core.activation.key-entry-limit.title"),
        t("signin.key.noEntries", { product: ctx.product.name }),
      ),
      ...gap(ctx),
      ...fixRows(ctx, [{ verb: "login", key: "cli.fix.signIn" }]),
    ];
  const [title, message] = o.kind
    ? [
        t(`core.activation.${o.kind}.title`),
        t(`core.activation.${o.kind}.message`),
      ]
    : [ctx.copy.code(o.code, "title"), ctx.copy.code(o.code, "message")];
  return problemRows(NETWORK.has(o.code) ? "warn" : "fail", title, message);
}

function outcomeExit(o: ActivateOutcome): number {
  return o.state === "done" ? EXIT.ok : EXIT.failed;
}

/**
 * The result line's fields for an activation (the Python kit's: `kind`, `code`, `deviceCount`,
 * `limit`, `manageUrl`, and `status` once activated): never the key, never the device token.
 * A refusal's code is `code`, not `error`, as in the Python kit.
 */
function outcomeResult(
  client: PolarisKeyClient,
  r: ActivationResult,
  o: ActivateOutcome,
): Record<string, unknown> {
  const dl = r.kind === "device-limit" ? r : null;
  return {
    kind: r.kind,
    code: r.kind === "ok" ? null : r.code,
    deviceCount: dl?.deviceCount ?? null,
    limit: dl?.limit ?? null,
    manageUrl: dl?.manageUrl ?? null,
    ...(o.state === "done"
      ? { status: client.status().status, tier: o.tier }
      : {}),
  };
}

export interface ActivateArgs {
  /** A key given on the command line (kept for compatibility; it warns). */
  key?: string;
}

/** Where the key comes from: the prompt, a pipe, or (with a warning) the command line. */
async function obtainKey(
  ctx: KitContext,
  args: ActivateArgs,
): Promise<string | typeof CANCEL | typeof INTERRUPT | null> {
  const t = ctx.copy.t.bind(ctx.copy);
  if (args.key) {
    // The positional key still works, and says why it should not be used (UI-KITS §0, GA).
    if (!quiet(ctx))
      ctx.stderr.write(
        `${ctx.render([stepRow("warn", [{ text: t("cli.activate.argWarning", { command: cmd(ctx, "activate") }) }])]).join("\n")}\n`,
      );
    return args.key.trim();
  }
  if (ctx.keys) {
    const product = ctx.product.name;
    return promptSecret(
      {
        caps: ctx.caps,
        painter: ctx.painter,
        symbols: ctx.symbols,
        out: ctx.stdout,
        keys: ctx.keys,
      },
      {
        title: [
          { text: t("part.keyField.label"), style: ["strong"] },
          { text: `  ${t("activate.lede")}`, style: ["muted"] },
        ],
        mask: (v) => keyMask(ctx, v),
        verdict: (v) => {
          const kv = keyVerdict(v);
          if (kv.state === "parsed")
            return stepRow("ok", [
              {
                text: t("part.keyField.forProduct", {
                  product:
                    kv.slug === ctx.slug ? product : (kv.slug ?? product),
                }),
              },
            ]);
          if (kv.state === "rejected")
            return stepRow("fail", [{ text: t("part.keyField.malformed") }]);
          return null;
        },
        check: (v) => {
          const kv = keyVerdict(v, true);
          if (kv.state === "rejected")
            return stepRow("fail", [
              {
                text: t(
                  kv.reason === "empty"
                    ? "part.keyField.empty"
                    : "part.keyField.malformed",
                ),
              },
            ]);
          if (kv.state === "cut-short")
            return stepRow("warn", [
              {
                text: t("part.keyField.cutShort", {
                  prefix: kv.prefix!,
                  used: kv.used!,
                  limit: kv.limit,
                }),
              },
            ]);
          return null;
        },
        hints: hintsRow(ctx, t("cli.keys.activate")).spans,
        done: (v) => [
          stepRow("done", t("part.keyField.label"), [
            { text: `${ctx.symbols.separator} `, style: ["muted"] },
            ...keyMask(ctx, v, true),
          ]),
        ],
        cancelled: () => [
          stepRow("done", t("part.keyField.label")),
          endRow(t("cli.nothingChanged")),
        ],
      },
    );
  }
  if (ctx.plainKeys)
    return plainSecret(
      ctx.plainKeys,
      ctx.stdout,
      `${t("part.keyField.label")}:`,
    );
  if (ctx.stdin.isTTY) return null;
  const piped = await readPiped(ctx);
  return piped === "" ? null : piped;
}

/**
 * `activate`: the masked key prompt (or a piped key), the live verdict, the activation, and
 * the device limit's browser hand-off with Try again.
 */
export async function activateFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  args: ActivateArgs = {},
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "activate"));
  const key = await obtainKey(ctx, args);
  if (key === CANCEL)
    return {
      exitCode: EXIT.failed,
      state: "cancelled",
      result: { kind: "cancelled" },
    };
  if (key === INTERRUPT) return interrupted();
  if (key === null) {
    const message = t("cli.activate.noKey", { command: cmd(ctx, "activate") });
    show(ctx, [stepRow("fail", [{ text: message }]), endRow()]);
    return {
      exitCode: EXIT.usage,
      state: "rejected",
      result: { usage: `${ctx.bin} activate` },
      error: {
        code: "usage",
        title: t("part.keyField.empty"),
        message,
        showMessage: true,
      },
    };
  }
  if (!ctx.keys)
    show(ctx, [
      stepRow("done", t("part.keyField.label"), [
        { text: `${ctx.symbols.separator} `, style: ["muted"] },
        ...keyMask(ctx, key, true),
      ]),
    ]);
  const verdict = keyVerdict(key, true);
  if (verdict.state === "rejected" || verdict.state === "cut-short") {
    const message =
      verdict.state === "cut-short"
        ? t("part.keyField.cutShort", {
            prefix: verdict.prefix!,
            used: verdict.used!,
            limit: verdict.limit,
          })
        : t(
            verdict.reason === "empty"
              ? "part.keyField.empty"
              : "part.keyField.malformed",
          );
    show(ctx, [
      stepRow(verdict.state === "cut-short" ? "warn" : "fail", [
        { text: message },
      ]),
      endRow(),
    ]);
    // Refused here, before any request: like a server refusal, exit 1 with the kind.
    return {
      exitCode: EXIT.failed,
      state: verdict.state,
      result: {
        kind: verdict.state === "cut-short" ? "cut-short" : "malformed",
        code: null,
      },
    };
  }
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await busy(ctx, t("activate.busy"), () =>
        client.license.activateWithKey(key),
      );
    } catch (e) {
      return failed(ctx, e);
    }
    const o = activationOutcome(r, client.license.licenseInfo());
    if (o.state !== "device-limit") {
      show(ctx, [...outcomeRows(ctx, o), endRow()]);
      return {
        exitCode: outcomeExit(o),
        state: o.state,
        result: outcomeResult(client, r, o),
      };
    }
    const dl = o.deviceLimit;
    const result: FlowResult = {
      exitCode: EXIT.failed,
      state: "device-limit",
      result: outcomeResult(client, r, o),
    };
    if (quiet(ctx)) return result;
    ctx.rows(deviceLimitRows(ctx, dl));
    if (!ctx.keys || !dl.manageUrl || attempt >= 5) {
      ctx.rows([
        endRow(t("cli.deviceLimit.again", { command: cmd(ctx, "activate") })),
      ]);
      return result;
    }
    // Enter opens the portal page; then Enter tries again (one more key entry), Esc stops.
    const live = new LiveRegion(ctx.stdout, { animate: true });
    let opened = false;
    let again = false;
    let interrupt = false;
    try {
      for (;;) {
        live.draw(
          ctx.render([
            hintsRow(
              ctx,
              t(opened ? "cli.keys.retry" : "cli.keys.deviceLimit"),
            ),
          ]),
        );
        const k = await ctx.keys.next();
        if (k !== null && isInterrupt(k)) interrupt = true;
        if (k === null || isCancel(k)) break;
        if (k.name !== "return" && k.name !== "enter") continue;
        if (!opened) {
          await Promise.resolve(ctx.openUrl(dl.manageUrl)).catch(() => false);
          opened = true;
          continue;
        }
        again = true;
        break;
      }
    } finally {
      live.commit([]);
    }
    if (interrupt) return interrupted(result.result);
    if (!again) {
      ctx.rows([
        endRow(t("cli.deviceLimit.again", { command: cmd(ctx, "activate") })),
      ]);
      return result;
    }
    ctx.rows(gap(ctx));
  }
}

/** `enroll`: the free license, with the same outcome rows as activate. */
export async function enrollFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  show(ctx, productHeader(ctx, "enroll"));
  let r;
  try {
    r = await busy(ctx, ctx.copy.t("activate.busy"), () =>
      client.license.enroll(),
    );
  } catch (e) {
    return failed(ctx, e);
  }
  const o = activationOutcome(r, client.license.licenseInfo());
  if (o.state === "device-limit")
    show(ctx, [...deviceLimitRows(ctx, o.deviceLimit), endRow()]);
  else show(ctx, [...outcomeRows(ctx, o), endRow()]);
  return {
    exitCode: outcomeExit(o),
    state: o.state,
    result: outcomeResult(client, r, o),
  };
}

// ── login, logout, deactivate ──────────────────────────────────────────────────────────────

export interface LoginArgs {
  /** `--device-code`: skip the browser (SIGN-IN.md D-68). */
  deviceCode?: boolean;
}

/**
 * `login` (SIGN-IN.md §4.15, frame 32): open the browser on the sign-in page and wait, with
 * Enter to open it again, c for the code and Esc to cancel; headless (or `--device-code`) shows
 * the code instead, with c to copy it. Never a QR (D-67) and never license rows (D-93): the
 * license is chosen on the card.
 */
export async function loginFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  args: LoginArgs = {},
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  if (!client.capabilities().identity?.enabled) {
    const message = t("signin.identityOff.notice", {
      product: ctx.product.name,
    });
    show(ctx, [
      ...productHeader(ctx, "login"),
      stepRow("fail", [{ text: message }]),
      endRow(),
    ]);
    return {
      exitCode: EXIT.failed,
      state: "error",
      result: { state: "error" },
      error: {
        code: "identity_disabled",
        title: ctx.copy.code("identity_disabled", "title"),
        message,
      },
    };
  }
  show(ctx, productHeader(ctx, "login"));
  let prompt: SignInPrompt;
  try {
    prompt = await busy(ctx, t("signInHandoff.starting"), () =>
      client.identity.beginSignIn(),
    );
  } catch (e) {
    return { ...failed(ctx, e), result: { state: "error" } };
  }
  const codeUrl = ctx.product.deviceCodeUrl ?? prompt.verificationUri;
  if (quiet(ctx)) {
    ctx.stdout.write(
      `${eventLine("login", "pending", {
        verificationUri: codeUrl,
        verificationUriComplete: prompt.verificationUriComplete,
        userCode: prompt.userCode,
        expiresAt: prompt.expiresAt,
      })}\n`,
    );
  }
  let useCode = args.deviceCode === true || ctx.caps.headless || quiet(ctx);
  let headlessNote = useCode && !args.deviceCode && !quiet(ctx);
  if (!useCode) {
    const opened = await Promise.resolve(
      ctx.openUrl(prompt.verificationUriComplete),
    ).catch(() => false);
    if (opened) {
      show(ctx, [
        stepRow("done", [{ text: t("signin.cli.opening") }]),
        textRow(
          withLink(
            ctx,
            "signin.cli.ifNotOpened",
            prompt.verificationUriComplete,
          ),
        ),
        ...gap(ctx),
      ]);
    } else {
      useCode = true;
      show(ctx, [stepRow("warn", t("signin.handoff.noBrowser"))]);
      headlessNote = false;
    }
  }
  const abort = new AbortController();
  const codeView = () => {
    show(ctx, [
      ...(headlessNote
        ? [stepRow("done", [{ text: t("signin.cli.headless") }])]
        : []),
      textRow(withLink(ctx, "signin.handoff.codeBody", codeUrl)),
      ...codeRows(ctx, prompt.userCode),
      textRow(t("signin.handoff.check")),
    ]);
  };
  if (useCode) codeView();

  // The live part: the countdown (code view), the spinner line and the keys.
  const live = quiet(ctx) ? null : new LiveRegion(ctx.stdout, ctx.caps);
  const frames = spinnerFrames(ctx.caps.unicode);
  let copied = false;
  let frame = 0;
  const draw = () => {
    if (!live) return;
    const left = prompt.expiresAt - ctx.now() / 1000;
    const rows: RailRow[] = [];
    if (useCode)
      rows.push(
        textRow(t("signin.handoff.expires", { time: clock(left) }), ["muted"]),
        ...gap(ctx),
      );
    rows.push({
      mark: ctx.caps.animate
        ? { glyph: frames[frame % frames.length]! }
        : "active",
      spans: [
        {
          text: useCode
            ? t("cli.signin.waitingCode")
            : t("signin.handoff.waiting"),
        },
      ],
    });
    if (ctx.keys) {
      const hints = hintsRow(
        ctx,
        useCode ? t("cli.keys.code") : t("signin.cli.keys"),
        "rail",
      );
      if (copied)
        hints.spans.push({
          text: `  ${ctx.symbols.ok} ${t("common.copied")}`,
          style: ["success"],
        });
      rows.push(hints);
    }
    live.draw(ctx.render(rows));
  };
  const stopSpin = animate(
    ctx.caps,
    (f) => {
      frame = f;
      draw();
    },
    ctx.ticker,
  );
  // Keys run beside the wait; Esc cancels it.
  let interrupt = false;
  const keyLoop = (async () => {
    if (!ctx.keys) return;
    for (;;) {
      const k = await ctx.keys.next(abort.signal);
      if (k === null) return;
      if (isCancel(k)) {
        interrupt = isInterrupt(k);
        abort.abort(new Error("cancelled"));
        return;
      }
      if (!useCode && (k.name === "return" || k.name === "enter"))
        await Promise.resolve(
          ctx.openUrl(prompt.verificationUriComplete),
        ).catch(() => false);
      else if (k.name === "c") {
        if (!useCode) {
          useCode = true;
          live?.commit([]);
          codeView();
        } else if (ctx.caps.links) {
          ctx.stdout.write(osc52(prompt.userCode));
          copied = true;
        }
      }
      draw();
    }
  })();

  let r: SignInResult | "cancelled";
  try {
    r = await client.identity.waitForSignIn(prompt, { signal: abort.signal });
  } catch (e) {
    if (abort.signal.aborted) r = "cancelled";
    else {
      stopSpin();
      live?.commit([]);
      abort.abort();
      await keyLoop;
      return { ...failed(ctx, e), result: { state: "error" } };
    }
  } finally {
    stopSpin();
  }
  abort.abort();
  await keyLoop;
  live?.commit([]);

  if (r === "cancelled") {
    const error = codeError(ctx, "cancelled");
    show(ctx, [
      stepRow("fail", error.title),
      endRow(t("signin.cli.signInAgain", { command: cmd(ctx, "login") })),
    ]);
    if (interrupt) return interrupted({ state: "cancelled" });
    // Esc: cancelled, exit 1 (the Python kit's `{"state": "cancelled"}`).
    return {
      exitCode: EXIT.failed,
      state: "cancelled",
      result: { state: "cancelled" },
    };
  }
  if (r.status === "ready") {
    const who = r.identity ?? {};
    const line =
      who.name && who.email
        ? t("signin.cli.signedIn", { name: who.name, email: who.email })
        : who.email
          ? t("cli.signin.signedInEmail", { email: who.email })
          : t("signInHandoff.ok");
    const result = {
      state: "signedIn",
      name: who.name ?? null,
      email: who.email ?? null,
      attached: r.attached ?? null,
      status: client.status().status,
    };
    show(ctx, [
      stepRow("ok", line),
      useCode ? endRow() : endRow(t("signin.cli.closeTab")),
    ]);
    return { exitCode: EXIT.ok, state: "signedIn", result };
  }
  const expired = r.status === "expired";
  const error: CliJsonError = expired
    ? {
        code: "signin_expired",
        title: t("signin.handoff.tooLong"),
        message: t("signin.cli.signInAgain", { command: cmd(ctx, "login") }),
      }
    : codeError(ctx, "oidc_error");
  show(
    ctx,
    expired
      ? [stepRow("fail", error.title), endRow(error.message)]
      : [
          ...problemRows("fail", error.title, error.message),
          endRow(t("signin.cli.signInAgain", { command: cmd(ctx, "login") })),
        ],
  );
  return {
    exitCode: EXIT.failed,
    state: expired ? "expired" : "denied",
    result: { state: expired ? "expired" : "denied" },
    error,
  };
}

export interface ConfirmArgs {
  /** `--yes`: no question (D-71). */
  yes?: boolean;
}

/** Ask the sign-out question when a person is there to answer it. */
async function confirmSignOut(
  ctx: KitContext,
  args: ConfirmArgs,
): Promise<boolean | typeof CANCEL | typeof INTERRUPT> {
  if (args.yes) return true;
  const question = ctx.copy.t("signin.cli.logoutConfirm", {
    product: ctx.product.name,
  });
  if (ctx.plainKeys) return plainConfirm(ctx.plainKeys, ctx.stdout, question);
  if (!ctx.keys) return true;
  return promptConfirm(
    {
      caps: ctx.caps,
      painter: ctx.painter,
      symbols: ctx.symbols,
      out: ctx.stdout,
      keys: ctx.keys,
    },
    {
      title: [{ text: question, style: ["strong"] }],
      done: () => [stepRow("done", [{ text: question }])],
      cancelled: () => [stepRow("done", [{ text: question }])],
    },
  );
}

/** `logout` (and `sign-out`): confirm, sign out, wipe the credentials. */
export async function logoutFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  args: ConfirmArgs = {},
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "logout"));
  const yes = await confirmSignOut(ctx, args);
  if (yes !== true) {
    show(ctx, [endRow(t("cli.nothingChanged"))]);
    if (yes === INTERRUPT) return interrupted({ signedOut: false });
    // Declined or cancelled: exit 1, as the Python kit.
    return {
      exitCode: EXIT.failed,
      state: "cancelled",
      result: { signedOut: false, state: "cancelled" },
    };
  }
  try {
    await busy(ctx, t("common.working"), () => client.identity.signOut());
  } catch (e) {
    return failed(ctx, e);
  }
  show(ctx, [
    stepRow("ok", t("cli.logout.done", { product: ctx.product.name })),
    endRow(t("signin.cli.signInAgain", { command: cmd(ctx, "login") })),
  ]);
  return { exitCode: EXIT.ok, state: "done", result: { signedOut: true } };
}

/** `deactivate`: the same confirmation, then the license is released on this device. */
export async function deactivateFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  args: ConfirmArgs = {},
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "deactivate"));
  const yes = await confirmSignOut(ctx, args);
  if (yes !== true) {
    show(ctx, [endRow(t("cli.nothingChanged"))]);
    if (yes === INTERRUPT) return interrupted({ signedOut: false });
    // Declined or cancelled: exit 1, as the Python kit.
    return {
      exitCode: EXIT.failed,
      state: "cancelled",
      result: { signedOut: false, state: "cancelled" },
    };
  }
  await busy(ctx, t("common.working"), () => client.license.deactivate());
  show(ctx, [
    stepRow("ok", t("cli.deactivate.done", { product: ctx.product.name })),
    endRow(),
  ]);
  return { exitCode: EXIT.ok, state: "done", result: { signedOut: true } };
}

// ── devices ────────────────────────────────────────────────────────────────────────────────

function relative(ctx: KitContext, epochSeconds: number): string {
  const days = Math.round((epochSeconds - ctx.now() / 1000) / 86_400);
  const fmt = new Intl.RelativeTimeFormat(ctx.copy.locale, { numeric: "auto" });
  return Math.abs(days) >= 1 ? fmt.format(days, "day") : fmt.format(0, "day");
}

/** `devices list`: the devices on this license, this one first and marked. */
export async function devicesListFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "devices list"));
  let list;
  try {
    list = await busy(ctx, t("common.loading"), () => client.listDevices());
  } catch (e) {
    return failed(ctx, e);
  }
  const sorted = [...list].sort(
    (a, b) => Number(b.current) - Number(a.current),
  );
  const view = devicesView(
    sorted.map((d) => ({
      id: d.id,
      label: d.label ?? null,
      platform: [d.platform, d.arch].filter(Boolean).join(" ") || null,
      current: d.current,
      lastSeenAt: d.current ? (d.lastVerifiedAt ?? null) : null,
    })),
  );
  if (view.state === "empty") {
    show(ctx, [stepRow("active", t("devices.empty")), endRow()]);
    return { exitCode: EXIT.ok, state: "empty", result: { devices: [] } };
  }
  const rows: RailRow[] = [
    stepRow(
      "active",
      t("devices.title"),
      `${ctx.symbols.separator} ${t("devices.count", { count: view.rows.length })}`,
    ),
  ];
  for (const d of view.rows) {
    const name = d.name ?? t("devices.unnamed");
    const radio = d.current ? ctx.symbols.radioOn : ctx.symbols.radioOff;
    const meta: string[] = [];
    if (d.platform)
      meta.push(
        d.lastSeenAt !== null
          ? t("devices.meta", {
              platform: d.platform,
              when: relative(ctx, d.lastSeenAt),
            })
          : d.platform,
      );
    if (d.current)
      meta.push(t("part.thisDeviceTitle", { formFactor: "computer" }));
    rows.push({
      mark: "rail",
      spans: [
        { text: `${radio} `, style: d.current ? ["accent"] : ["muted"] },
        { text: name, style: d.current ? ["strong"] : [] },
        ...(meta.length
          ? [{ text: `  ${sep(ctx, meta.join(" · "))}`, style: ["muted"] }]
          : []),
      ],
    });
    rows.push({
      mark: "rail",
      spans: [{ text: `  ${d.id}`, style: ["muted"], keep: true }],
    });
  }
  rows.push(endRow());
  show(ctx, rows);
  return {
    exitCode: EXIT.ok,
    state: "list",
    result: {
      devices: list.map((d) => ({
        id: d.id,
        label: d.label ?? null,
        platform: d.platform ?? null,
        current: d.current,
      })),
    },
  };
}

/** `devices rename`. */
export async function devicesRenameFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  deviceId: string,
  label: string | null,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "devices rename"));
  try {
    await busy(ctx, t("common.working"), () =>
      client.renameDevice(deviceId, label),
    );
  } catch (e) {
    return failed(ctx, e);
  }
  show(ctx, [
    stepRow(
      "ok",
      label
        ? t("cli.devices.renamed", { device: label })
        : t("cli.devices.nameCleared", { device: deviceId }),
    ),
    endRow(),
  ]);
  return {
    exitCode: EXIT.ok,
    state: "list",
    result: { renamed: deviceId, label },
  };
}

/** `devices deauthorize`: remove a device and free its seat. */
export async function devicesRemoveFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  deviceId: string,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "devices deauthorize"));
  const self = deviceId === client.core.deviceId;
  try {
    await busy(ctx, t("common.working"), () =>
      client.deauthorizeDevice(deviceId),
    );
  } catch (e) {
    return failed(ctx, e);
  }
  show(ctx, [
    stepRow(
      "ok",
      self
        ? t("cli.deactivate.done", { product: ctx.product.name })
        : t("cli.devices.removed", { device: deviceId }),
    ),
    endRow(),
  ]);
  return {
    exitCode: EXIT.ok,
    state: "list",
    result: { deauthorized: deviceId, self },
  };
}

/** `register`: the keyless device mint. */
export async function registerFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "register"));
  const r = await busy(ctx, t("common.working"), async () => {
    const res = await client.devices.register();
    return res;
  }).catch((e: unknown) => ({ kind: "throw" as const, e }));
  if (r.kind === "throw") return failed(ctx, r.e);
  if (r.kind === "ok") {
    await client.sync({ force: true }).catch(() => undefined);
    show(ctx, [stepRow("ok", t("cli.register.done")), endRow()]);
    return {
      exitCode: EXIT.ok,
      state: "done",
      result: { deviceId: r.deviceId, status: client.status().status },
    };
  }
  const code =
    r.kind === "registration-closed"
      ? "registration_closed"
      : r.kind === "rate-limited"
        ? "rate_limited"
        : r.kind === "not-configured"
          ? "not_found"
          : "unknown";
  const error = codeError(ctx, code);
  show(ctx, [...problemRows("fail", error.title, error.message), endRow()]);
  return {
    exitCode: EXIT.failed,
    state: "error",
    error,
    result: { kind: r.kind },
  };
}

// ── update, changelog, packs ───────────────────────────────────────────────────────────────

/** `update check`: the signed decision, or the plain version check. */
export async function updateCheckFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "update check"));
  const product = ctx.product.name;
  const apply = cmd(ctx, "update apply");
  try {
    if (!client.update.decidable) {
      const v = await busy(ctx, t("boot.deciding"), () =>
        client.update.check(),
      );
      show(
        ctx,
        v.updateAvailable
          ? [
              stepRow(
                "active",
                t("update.title", { product, version: v.version }),
              ),
              textRow([linkSpan(v.url)]),
              endRow(),
            ]
          : [
              stepRow("ok", t("update.upToDate")),
              textRow(t("account.version", { version: client.core.version }), [
                "muted",
              ]),
              endRow(),
            ],
      );
      return {
        exitCode: EXIT.ok,
        state: v.updateAvailable ? "available" : "up-to-date",
        result: {
          state: v.updateAvailable ? "available" : "up-to-date",
          version: v.version,
          updateAvailable: v.updateAvailable,
        },
      };
    }
    const r = await busy(ctx, t("boot.deciding"), () => client.update.decide());
    const view = updateView(r.decision);
    const rows: RailRow[] = [];
    switch (view.state) {
      case "up-to-date":
        rows.push(
          stepRow("ok", t("update.upToDate")),
          textRow(t("account.version", { version: client.core.version }), [
            "muted",
          ]),
        );
        break;
      case "available":
        rows.push(
          view.version
            ? stepRow(
                "active",
                t("update.title", { product, version: view.version }),
              )
            : stepRow("active", t("updateProgress.contentTitle")),
          endRow(
            t("update.platform.command", {
              command: view.version ? apply : cmd(ctx, "packs status"),
            }),
          ),
        );
        break;
      case "mandatory":
        rows.push(
          ...problemRows(
            "warn",
            t("update.mandatoryTitle", { product }),
            t("update.mandatoryBody", { product }),
          ),
          endRow(t("update.platform.command", { command: apply })),
        );
        break;
      case "store":
      case "platform":
        rows.push(
          stepRow(
            "active",
            t("update.title", { product, version: view.version! }),
          ),
          textRow(t("update.platform.generic", { product })),
          ...(view.storeUrl ? [textRow([linkSpan(view.storeUrl)])] : []),
        );
        break;
      case "ready":
        rows.push(
          ...problemRows(
            "ok",
            t("update.readyTitle", { product, version: view.version! }),
            t("update.readyBody", { product }),
          ),
        );
        break;
      case "blocked":
        rows.push(
          ...problemRows(
            "warn",
            t("update.blockedTitle"),
            t("update.blockedBody", { product }),
          ),
        );
        break;
    }
    if (rows.at(-1)?.mark !== "end") rows.push(endRow());
    show(ctx, rows);
    return {
      exitCode: EXIT.ok,
      state: view.state,
      result: { state: view.state, decision: r.decision, channel: r.channel },
    };
  } catch (e) {
    return failed(ctx, e);
  }
}

/** A progress row: the bar, the percentage, then size and time left (UI-KITS update board). */
function progressRow(
  ctx: KitContext,
  done: number,
  total: number,
  startedAt: number,
): RailRow {
  const t = ctx.copy.t.bind(ctx.copy);
  const v = progressView(done, total);
  const elapsed = (ctx.now() - startedAt) / 1000;
  const rate = elapsed > 0 ? done / elapsed : 0;
  const width = Math.max(10, Math.min(36, ctx.caps.columns - 40));
  const figures =
    v.state === "downloading" && rate > 0
      ? t("updateProgress.downloading", {
          size: formatBytes(ctx, done),
          total: formatBytes(ctx, total),
          time: formatDuration(ctx, (total - done) / rate),
        })
      : v.state === "queued"
        ? t("updateProgress.queued")
        : t("updateProgress.done");
  return {
    mark: "rail",
    spans: [
      ...progressSpans(v.fraction, ctx.symbols, width),
      { text: `  ${percent(done, total)}%`, style: ["strong"] },
      {
        text: ` ${ctx.symbols.separator} ${sep(ctx, figures)}`,
        style: ["muted"],
      },
    ],
  };
}

/** `update apply`: decide, then download with a redrawn bar, then install. */
export async function updateApplyFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  const product = ctx.product.name;
  show(ctx, productHeader(ctx, "update apply"));
  let r;
  try {
    r = await busy(ctx, t("boot.deciding"), () => client.update.decide());
  } catch (e) {
    return failed(ctx, e);
  }
  const d = r.decision;
  if (d.action !== "binary" && d.action !== "store") {
    const view = updateView(d);
    show(ctx, [
      ...(view.state === "up-to-date"
        ? [stepRow("ok", t("update.upToDate"))]
        : view.state === "blocked"
          ? problemRows(
              "warn",
              t("update.blockedTitle"),
              t("update.blockedBody", { product }),
            )
          : [
              stepRow(
                "active",
                view.version
                  ? t("update.title", { product, version: view.version })
                  : t("updateProgress.contentTitle"),
              ),
            ]),
      endRow(),
    ]);
    return {
      exitCode: EXIT.ok,
      state: view.state,
      result: { state: view.state, decision: r.decision, channel: r.channel },
    };
  }
  show(ctx, [
    stepRow(
      "active",
      t("update.title", { product, version: d.release.version }),
    ),
  ]);
  const live = quiet(ctx) ? null : new LiveRegion(ctx.stdout, ctx.caps);
  const abort = new AbortController();
  const started = ctx.now();
  let last = 0;
  let lastDone = 0;
  let lastTotal = 0;
  const redraw = () =>
    live?.draw(
      ctx.render([
        progressRow(ctx, lastDone, lastTotal, started),
        ...(ctx.keys ? [hintsRow(ctx, t("cli.keys.download"))] : []),
      ]),
    );
  let interrupt = false;
  const keyLoop = (async () => {
    if (!ctx.keys) return;
    for (;;) {
      const k = await ctx.keys.next(abort.signal);
      if (k === null) return;
      if (isCancel(k)) {
        interrupt = isInterrupt(k);
        abort.abort(new Error("cancelled"));
        return;
      }
    }
  })();
  const fields = {
    decision: d,
    channel: r.channel,
  };
  let out;
  try {
    out = await client.update.install(d, {
      onProgress: (done, total) => {
        lastDone = done;
        lastTotal = total;
        emitProgress(ctx, "update apply", done, total);
        const now = ctx.now();
        // Redraw at most ten times a second (UI-KITS §4.8).
        if (ctx.caps.animate && now - last >= 100) {
          last = now;
          redraw();
        }
      },
      signal: abort.signal,
    });
  } catch (e) {
    const cancelled = abort.signal.aborted;
    abort.abort();
    await keyLoop;
    live?.commit([]);
    if (cancelled) {
      show(ctx, [stepRow("fail", t("cli.update.cancelled")), endRow()]);
      if (interrupt) return interrupted({ state: "cancelled", ...fields });
      return {
        exitCode: EXIT.failed,
        state: "cancelled",
        result: { state: "cancelled", ...fields },
      };
    }
    return failed(ctx, e);
  }
  abort.abort();
  await keyLoop;
  live?.commit(
    lastTotal > 0
      ? ctx.render([progressRow(ctx, lastTotal, lastTotal, started)])
      : [],
  );
  const view = installView(out);
  const version = "version" in out ? out.version : d.release.version;
  switch (view.state) {
    case "ready":
      show(ctx, [
        ...problemRows(
          "ok",
          t("update.readyTitle", { product, version }),
          t("update.readyBody", { product }),
        ),
        endRow(),
      ]);
      break;
    case "platform":
      show(ctx, [
        stepRow("ok", t("update.platform.generic", { product })),
        endRow(),
      ]);
      break;
    case "store":
      show(ctx, [
        stepRow("ok", t("update.platform.generic", { product })),
        ...("url" in out ? [textRow([linkSpan(out.url)])] : []),
        endRow(),
      ]);
      break;
    case "blocked": {
      const error = codeError(ctx, "unsupported");
      show(ctx, [...problemRows("fail", error.title, error.message), endRow()]);
      return {
        exitCode: EXIT.failed,
        state: "blocked",
        result: { state: view.state, ...fields, installed: out.kind },
        error,
      };
    }
  }
  return {
    exitCode: EXIT.ok,
    state: view.state,
    result: { state: view.state, ...fields, installed: out.kind },
  };
}

/** `changelog`: the published releases, newest first. */
export async function changelogFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  limit = 10,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "changelog"));
  let rows;
  try {
    rows = await busy(ctx, t("common.loading"), () =>
      client.release.changelog(),
    );
  } catch (e) {
    const error = {
      code: errorCode(e),
      title: t("releaseNotes.error"),
      message: t("releaseNotes.error"),
    };
    show(ctx, [stepRow("fail", error.title), endRow()]);
    return {
      exitCode: EXIT.failed,
      state: "error",
      error: { ...error, code: error.code ?? "internal" },
    };
  }
  if (rows.length === 0) {
    show(ctx, [stepRow("active", t("releaseNotes.empty")), endRow()]);
    return { exitCode: EXIT.ok, state: "empty", result: { entries: [] } };
  }
  const out: RailRow[] = [
    stepRow("active", t("releaseNotes.title", { product: ctx.product.name })),
  ];
  for (const e of rows.slice(0, limit)) {
    out.push(...gap(ctx), {
      mark: "rail",
      spans: [
        {
          text: t("releaseNotes.version", { version: e.version }),
          style: ["strong"],
        },
        ...(e.date
          ? [
              {
                text: `  ${ctx.symbols.separator} ${t("releaseNotes.released", { date: formatDate(ctx, Date.parse(e.date) / 1000) })}`,
                style: ["muted"],
              },
            ]
          : []),
      ],
    });
    if (e.summary) out.push(textRow(e.summary));
  }
  out.push(endRow());
  show(ctx, out);
  return {
    exitCode: EXIT.ok,
    state: "list",
    result: {
      entries: rows.slice(0, limit).map((e) => ({
        version: e.version,
        date: e.date,
        summary: e.summary,
        url: e.url,
      })),
    },
  };
}

/** `packs status`: installed packs and any download in flight. */
export async function packsStatusFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "packs status"));
  let s;
  try {
    s = await client.update.packs.state();
  } catch (e) {
    return failed(ctx, e);
  }
  const active = Object.values(s.active);
  const rows: RailRow[] = [];
  if (active.length === 0 && Object.keys(s.inflight).length === 0)
    rows.push(stepRow("active", t("cli.packs.none")));
  for (const p of active)
    rows.push({
      mark: "ok",
      spans: [
        { text: p.packId, style: ["strong"], keep: true },
        { text: `  ${p.version}` },
        ...(s.running[p.packId]
          ? []
          : [
              {
                text: `  ${ctx.symbols.separator} ${t("cli.packs.afterRestart")}`,
                style: ["muted"],
              },
            ]),
      ],
    });
  for (const [id, f] of Object.entries(s.inflight))
    rows.push(
      { mark: "active", spans: [{ text: id, style: ["strong"], keep: true }] },
      progressRow(ctx, f.done, f.total, ctx.now()),
    );
  if (s.stateIssue) {
    const error = {
      code: s.stateIssue,
      title: t("core.fallback.title"),
      message: t("core.fallback.message", { code: s.stateIssue }),
    };
    rows.push(...problemRows("fail", error.title, error.message), endRow());
    show(ctx, rows);
    return {
      exitCode: EXIT.failed,
      state: "failed",
      result: { packs: packRows(s) },
      error,
    };
  }
  rows.push(endRow());
  show(ctx, rows);
  return {
    exitCode: EXIT.ok,
    state: active.length ? "done" : "queued",
    result: { packs: packRows(s) },
  };
}

/** The packs as the result line lists them (the Python kit's `packs`). */
function packRows(s: {
  active: Record<string, { packId: string; version: string; type: string }>;
  running: Record<string, unknown>;
  inflight: Record<string, { done: number; total: number }>;
}): Array<Record<string, unknown>> {
  return [
    ...Object.values(s.active).map((p) => ({
      pack: p.packId,
      version: p.version,
      type: p.type,
      running: Boolean(s.running[p.packId]),
    })),
    ...Object.entries(s.inflight).map(([id, f]) => ({
      pack: id,
      done: f.done,
      total: f.total,
    })),
  ];
}

/** `packs ensure`: install or update packs with a redrawn bar per pack. */
export async function packsEnsureFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  packIds: string[],
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "packs ensure"));
  const live = quiet(ctx) ? null : new LiveRegion(ctx.stdout, ctx.caps);
  const started = ctx.now();
  let last = 0;
  const off = client.update.packs.on((e) => {
    if (e.phase !== "download" && e.phase !== "apply") return;
    emitProgress(ctx, "packs ensure", e.done, e.total, {
      packId: e.packId,
      phase: e.phase,
    });
    const now = ctx.now();
    if (!ctx.caps.animate || now - last < 100) return;
    last = now;
    live?.draw(
      ctx.render([
        {
          mark: "active",
          spans: [
            { text: e.packId, style: ["strong"], keep: true },
            ...(e.phase === "apply"
              ? [
                  {
                    text: `  ${t("updateProgress.installing")}`,
                    style: ["muted"],
                  },
                ]
              : []),
          ],
        },
        progressRow(ctx, e.done, e.total, started),
      ]),
    );
  });
  try {
    const installs = await client.update.packs.ensure(packIds);
    live?.commit([]);
    show(
      ctx,
      installs.length
        ? [
            ...installs.map((i) => ({
              mark: "ok" as const,
              spans: [
                { text: i.packId, style: ["strong"], keep: true },
                { text: `  ${i.version}` },
              ],
            })),
            endRow(),
          ]
        : [stepRow("ok", t("updateProgress.done")), endRow()],
    );
    return {
      exitCode: EXIT.ok,
      state: "done",
      result: {
        packs: installs.map((i) => ({ pack: i.packId, version: i.version })),
      },
    };
  } catch (e) {
    live?.commit([]);
    return failed(ctx, e);
  } finally {
    off();
  }
}

// ── config, secret, mint ───────────────────────────────────────────────────────────────────

function sourceLabel(
  ctx: KitContext,
  source: string,
  enforced = false,
): string {
  if (enforced) return ctx.copy.t("a11y.locked");
  const key =
    source === "local" || source === "user"
      ? "settings.source.local"
      : source === "env"
        ? "settings.source.env"
        : "settings.source.default";
  return ctx.copy.t(key);
}

function valueText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** `config get`. */
export function configGetFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  key: string,
): FlowResult {
  const r = getConfig(client, key);
  show(ctx, productHeader(ctx, "config get"));
  if (!r.ok) {
    const message = ctx.copy.t("cli.config.unset", { name: key });
    show(ctx, [stepRow("active", [{ text: message }]), endRow()]);
    return {
      exitCode: EXIT.failed,
      state: "list",
      result: { key, value: null, source: null },
    };
  }
  const d = r.data as { key: string; value: unknown; source: string };
  show(ctx, [
    tableRows([
      {
        mark: "active",
        label: d.key,
        value: [
          { text: valueText(d.value), style: ["strong"], keep: true },
          {
            text: `  ${ctx.symbols.separator} ${sourceLabel(ctx, d.source)}`,
            style: ["muted"],
          },
        ],
      },
    ])[0]!,
    endRow(),
  ]);
  return {
    exitCode: EXIT.ok,
    state: "list",
    result: { key: d.key, value: d.value, source: d.source },
  };
}

/** `config list`: the Settings list, locked rows marked. */
export function configListFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): FlowResult {
  const t = ctx.copy.t.bind(ctx.copy);
  const rows = client.config
    .listUserConfig()
    .map((e) => ({ ...e, source: client.config.getConfigSource(e.key) }));
  show(ctx, productHeader(ctx, "config list"));
  if (rows.length === 0) {
    show(ctx, [stepRow("active", t("settings.empty")), endRow()]);
    return { exitCode: EXIT.ok, state: "list", result: { settings: [] } };
  }
  show(ctx, [
    stepRow("active", t("settings.title")),
    ...tableRows(
      rows.map((r) => ({
        label: r.key,
        value: [
          { text: valueText(r.value), style: ["strong"], keep: true },
          {
            text: `  ${ctx.symbols.separator} ${sourceLabel(ctx, r.source, r.enforced)}`,
            style: ["muted"],
          },
        ] as Line,
      })),
    ),
    endRow(),
  ]);
  return {
    exitCode: EXIT.ok,
    state: rows.some((r) => r.enforced) ? "locked" : "list",
    result: {
      settings: rows.map((r) => ({
        key: r.key,
        value: r.value,
        source: r.enforced ? "enforced" : r.source,
      })),
    },
  };
}

/** `config set` and `config reset`. */
export async function configWriteFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  key: string,
  value: JSONValue | undefined,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(
    ctx,
    productHeader(ctx, value === undefined ? "config reset" : "config set"),
  );
  try {
    if (value === undefined) await client.config.clear(key);
    else await client.config.set(key, value);
  } catch (e) {
    return failed(ctx, e);
  }
  const r = getConfig(client, key);
  const d = r.ok
    ? (r.data as { key: string; value: unknown; source: string })
    : null;
  show(ctx, [
    stepRow("ok", t("settings.saved")),
    textRow(
      d
        ? [
            { text: `${key}  ` },
            { text: valueText(d.value), style: ["strong"], keep: true },
            {
              text: `  ${ctx.symbols.separator} ${sourceLabel(ctx, d.source)}`,
              style: ["muted"],
            },
          ]
        : [{ text: t("cli.config.unset", { name: key }), style: ["muted"] }],
    ),
    endRow(),
  ]);
  return {
    exitCode: EXIT.ok,
    state: "saving",
    result: d
      ? { key: d.key, value: d.value, source: d.source }
      : { key, value: null, source: null },
  };
}

/** `secret`: the value alone on stdout, for a script to read. */
export function secretFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  key: string,
): FlowResult {
  const value = client.config.getSecret(key);
  if (value === null) {
    const message = ctx.copy.t("cli.secret.none", { name: key });
    if (!quiet(ctx))
      ctx.stderr.write(
        `${ctx.render([stepRow("fail", [{ text: message }])]).join("\n")}\n`,
      );
    return {
      exitCode: EXIT.failed,
      state: "error",
      result: { key, present: false },
    };
  }
  // A script gets the value as stored; a terminal never gets a control character from it. The
  // `--json` line never carries the value (the Python kit's `key` and `present`).
  if (!quiet(ctx)) ctx.stdout.write(`${ctx.caps.tty ? clean(value) : value}\n`);
  return { exitCode: EXIT.ok, result: { key, present: true } };
}

/** `mint`: the token alone on stdout. */
export async function mintFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  recipeId: string,
): Promise<FlowResult> {
  try {
    const tk = await client.config.mintToken(recipeId);
    if (!quiet(ctx))
      ctx.stdout.write(`${ctx.caps.tty ? clean(tk.token) : tk.token}\n`);
    // The token goes to stdout for a script; the `--json` line never carries it (the Python
    // kit's `recipe` and `expiresAt`).
    return {
      exitCode: EXIT.ok,
      result: { recipe: recipeId, expiresAt: tk.expiresAt },
    };
  } catch (e) {
    const code = errorCode(e);
    const error = codeError(ctx, code);
    if (!quiet(ctx))
      ctx.stderr.write(
        `${ctx.render(problemRows("fail", error.title, error.message)).join("\n")}\n`,
      );
    return {
      exitCode: EXIT.failed,
      state: "error",
      error: { ...error, code: code ?? "internal" },
    };
  }
}

// ── offline activation, doctor ─────────────────────────────────────────────────────────────

/** `offline-request`: the request code, with a QR where the terminal is big enough. */
export function offlineRequestFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): FlowResult {
  const t = ctx.copy.t.bind(ctx.copy);
  const deviceId = client.core.deviceId;
  const result = { product: client.product, requestCode: deviceId };
  if (quiet(ctx)) return { exitCode: EXIT.ok, state: "default", result };
  const rows: RailRow[] = [
    ...productHeader(ctx, "offline-request"),
    stepRow("active", t("offlineActivation.title")),
    textRow(t("offlineActivation.request")),
    textRow(t("offlineActivation.product", { product: ctx.product.name }), [
      "muted",
    ]),
    ...codeRows(ctx, deviceId),
  ];
  const qr = qrLines(deviceId, {
    ...ctx.caps,
    terminalColumns: ctx.stdout.columns ?? ctx.caps.columns,
  });
  ctx.rows(rows);
  if (qr)
    ctx.stdout.write(
      `${qr.map((l) => `${ctx.painter.style(ctx.symbols.rail, ["muted"])}${" ".repeat(5)}${l}`).join("\n")}\n`,
    );
  ctx.rows([
    ...(qr ? gap(ctx) : []),
    endRow(
      t("cli.offline.import", { command: cmd(ctx, "import-bundle <file>") }),
    ),
  ]);
  return { exitCode: EXIT.ok, state: "default", result };
}

/** `import-bundle`: activate from the offline file. */
export async function importBundleFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
  jws: string,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  show(ctx, productHeader(ctx, "import-bundle"));
  let r;
  try {
    r = await client.importBundle(jws);
  } catch (e) {
    const code = errorCode(e) ?? "bundle";
    const shown = codeError(ctx, "bundle");
    show(ctx, [...problemRows("fail", shown.title, shown.message), endRow()]);
    // The Python kit's import-bundle failure: the code, and the SDK's message for it.
    return {
      exitCode: EXIT.failed,
      state: "rejected-signature",
      error: {
        code,
        title: shown.title,
        message: clean(String((e as { message?: unknown })?.message ?? "")),
        showMessage: true,
      },
    };
  }
  show(ctx, [stepRow("ok", t("offlineActivation.done")), endRow()]);
  return {
    exitCode: EXIT.ok,
    state: "done",
    result: {
      bundleId: r.bundleId,
      imported: [...r.imported],
      status: client.status().status,
    },
  };
}

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

/** `doctor`: support diagnostics, as label and value rows. */
export async function doctorFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  let ok = true;
  const store = await client.storeStatus().catch(() => null);
  if (store?.degraded) ok = false;
  let discovery: { kind: string; code: string | null };
  try {
    const d = await busy(ctx, t("common.loading"), () => client.discover());
    discovery = {
      kind: d.kind,
      code:
        d.kind === "ok"
          ? null
          : d.kind === "not-found"
            ? "not_found"
            : "network",
    };
    if (d.kind !== "ok") ok = false;
  } catch (e) {
    discovery = { kind: "error", code: errorCode(e) ?? "network" };
    ok = false;
  }
  const services = Object.entries(client.capabilities())
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  const unsupported = DOCTOR_FEATURES.map(
    (f) => [f, client.supports(f)] as const,
  ).flatMap(([f, s]) =>
    s.supported
      ? []
      : [
          {
            feature: f,
            reason: s.reason,
            ...(s.detail ? { detail: s.detail } : {}),
          },
        ],
  );
  const result = {
    sdk: `${SDK_NAME} ${SDK_VERSION}`,
    product: client.product,
    version: client.core.version,
    channel: client.core.channel,
    baseUrl: client.core.baseUrl,
    deviceId: client.core.deviceId,
    store,
    discovery: discovery.kind,
    services,
    gate: client.status().status,
    outlet: client.update.outlet ?? null,
    unsupported,
  };
  if (!quiet(ctx)) {
    const v = (text: string, style?: string[]): Line => [
      { text, ...(style ? { style } : {}), keep: text.length < 40 },
    ];
    const table: Array<{
      mark?: "ok" | "fail" | "warn";
      label: string;
      value: Line;
    }> = [
      { label: t("cli.doctor.sdk"), value: v(result.sdk) },
      {
        label: t("cli.doctor.product"),
        value: v(
          `${client.product} ${client.core.version} ${ctx.symbols.separator} ${client.core.channel}`,
        ),
      },
      {
        label: t("cli.doctor.server"),
        value: [linkSpan(client.core.baseUrl, [])],
      },
      { label: t("cli.doctor.device"), value: v(client.core.deviceId) },
    ];
    if (store)
      table.push({
        mark: store.degraded ? "warn" : "ok",
        label: t("cli.doctor.store"),
        value: v(
          store.degraded
            ? `${store.backend} ${ctx.symbols.separator} ${store.degraded.reason}`
            : store.backend,
        ),
      });
    table.push(
      {
        mark: discovery.code ? "fail" : "ok",
        label: t("cli.doctor.discovery"),
        value: v(
          discovery.code
            ? ctx.copy.code(discovery.code, "title")
            : t("cli.doctor.reachable"),
        ),
      },
      { label: t("cli.doctor.services"), value: v(services.join(", ") || "—") },
      {
        label: t("cli.status.license"),
        value: v(t(`core.gate.${result.gate}.title`)),
      },
    );
    if (result.outlet)
      table.push({
        label: t("cli.doctor.installedFrom"),
        value: v(`${result.outlet.id} (${result.outlet.kind})`),
      });
    const rows: RailRow[] = [
      ...productHeader(ctx, "doctor"),
      ...tableRows(table),
    ];
    if (unsupported.length)
      rows.push(
        ...gap(ctx),
        stepRow("active", t("cli.doctor.unsupported")),
        ...unsupported.map((u) =>
          textRow([
            { text: u.feature, keep: true },
            {
              text: `  ${u.reason}${u.detail ? ` ${ctx.symbols.separator} ${u.detail}` : ""}`,
              style: ["muted"],
            },
          ]),
        ),
      );
    if (ctx.theme.poweredBy)
      rows.push(...gap(ctx), textRow(t("part.poweredBy"), ["muted"]));
    rows.push(endRow());
    ctx.rows(rows);
  }
  return { exitCode: ok ? EXIT.ok : EXIT.failed, state: "default", result };
}
