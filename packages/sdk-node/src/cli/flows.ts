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
  commandRows,
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
  interactiveRegion,
  plainConfirm,
  plainSecret,
  promptConfirm,
  promptSecret,
} from "./term/prompt.js";
import { isCancel, isInterrupt } from "./term/keys.js";
import {
  closeRail,
  contentWidth,
  DROP,
  keyHints,
  type RailRow,
} from "./term/layout.js";
import { animate, LiveRegion, spinnerFrames } from "./term/live.js";
import { osc52 } from "./term/osc.js";
import { clean } from "./term/sanitize.js";
import {
  percent,
  progressSpans,
  QR_INDENT,
  qrFits,
  qrLines,
} from "./term/progress.js";
import { cellWidth, padEnd, wrapSpans, type Line } from "./term/width.js";

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
function failed(
  ctx: KitContext,
  e: unknown,
  lead: readonly RailRow[] = [],
): FlowResult {
  const code = errorCode(e);
  const error = codeError(ctx, code);
  const network = code !== null && NETWORK.has(code);
  show(ctx, [
    ...lead,
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
  /** Rows above the spinner (the flow's header), so the screen reads the same as it fills in. */
  lead: () => readonly RailRow[] = () => [],
): Promise<T> {
  // A short wait is not worth a line in a log: without animation nothing is drawn (D-77).
  if (quiet(ctx) || !ctx.caps.animate) return work();
  const live = ctx.live();
  const frames = spinnerFrames(ctx.caps.unicode);
  const stop = animate(
    ctx.caps,
    (f) =>
      live.draw(() => [
        ...lead(),
        {
          mark: { glyph: frames[f % frames.length]! },
          spans: [{ text: label }],
        },
      ]),
    ctx.ticker,
  );
  try {
    return await work();
  } finally {
    stop();
    live.close();
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

/** Spans that fit one rail line at the current width. */
function fitsLine(ctx: KitContext, spans: Line): boolean {
  return (
    cellWidth(spans.map((s) => s.text).join("")) <=
    contentWidth(ctx.caps.columns)
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
    // UK-13's shape (UI-KITS §1.4): the backend and why it is degraded, never a bare string.
    tokenStore: store
      ? {
          backend: store.backend,
          degraded: store.degraded
            ? {
                reason: store.degraded.reason,
                detail: store.degraded.detail ?? null,
              }
            : null,
        }
      : null,
  };
  if (quiet(ctx)) return { exitCode, state: view.state, result };
  const t = ctx.copy.t.bind(ctx.copy);
  const rows: RailRow[] = productHeader(ctx, "status");
  switch (view.component) {
    case "AccountAndLicense": {
      // The board's table: one ✓ row per fact, the datum in bold and its detail in muted. Each
      // name, email and date is a keep-unit, so a narrow line breaks between them, never inside.
      const sepSpan = { text: ` ${ctx.symbols.separator} `, style: ["muted"] };
      const unit = (text: string, style: string[]): Line[number] => ({
        text,
        style,
        unit: true,
      });
      const table: Array<{ mark: "ok"; label: string; value: Line }> = [
        {
          mark: "ok",
          label: t("cli.status.license"),
          value: [
            unit(view.tier ?? t("part.status.ok"), ["strong"]),
            sepSpan,
            unit(view.holder ?? t("account.keyOnly"), ["muted"]),
          ],
        },
      ];
      // Devices: only when the status data has the count (it does not come from a request here).
      const seats = info as {
        deviceCount?: number;
        deviceLimit?: number | null;
      } | null;
      if (seats && typeof seats.deviceCount === "number" && seats.deviceLimit)
        table.push({
          mark: "ok",
          label: t("cli.status.devices"),
          value: [
            unit(
              t("cli.status.seatsOf", {
                used: seats.deviceCount,
                limit: seats.deviceLimit,
              }),
              ["strong"],
            ),
          ],
        });
      if (view.graceUntil !== null)
        table.push({
          mark: "ok",
          label: t("cli.status.offline"),
          value: [
            unit(
              t("cli.status.offlineUntil", {
                date: formatDate(ctx, view.graceUntil),
              }),
              ["strong"],
            ),
          ],
        });
      table.push({
        mark: "ok",
        label: t("cli.status.version"),
        value: [
          unit(client.core.version, ["strong"]),
          sepSpan,
          unit(client.core.channel, ["muted"]),
        ],
      });
      rows.push(...tableRows(ctx, table));
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
      // The command rows say what the lede above them would: it is left out.
      rows.push(
        stepRow("active", t("core.gate.needs-activation.title")),
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

/**
 * The DeviceLimit rows (browser mode: the portal page that frees a seat), as the terminal board
 * draws them: the title, the meter as dots only (the title already says "3 of 3"), one sentence,
 * then the page that frees a seat.
 */
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
      // The terminal does not poll: it never promises the product continues by itself.
      textRow(t("cli.deviceLimit.body")),
      { ...textRow([linkSpan(v.manageUrl)]), keep: true },
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
  lead: () => readonly RailRow[],
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
        host: ctx,
      },
      {
        lead,
        title: [
          { text: t("part.keyField.label"), style: ["strong"] },
          { text: `  ${t("activate.lede")}`, style: ["muted"] },
        ],
        mask: (v) => keyMask(ctx, v),
        verdict: (v) => {
          const kv = keyVerdict(v);
          if (kv.state === "parsed") {
            // A key for another product is a warning, never a green tick.
            if (kv.slug && kv.slug !== ctx.slug)
              return stepRow("warn", [
                {
                  text: t("cli.activate.otherProduct", {
                    app: kv.slug,
                    product,
                  }),
                },
              ]);
            return stepRow("ok", [
              { text: t("part.keyField.forProduct", { product }) },
            ]);
          }
          if (kv.state === "rejected")
            return stepRow("fail", [{ text: t("part.keyField.malformed") }]);
          return null;
        },
        check: (v) => {
          const kv = keyVerdict(v, true);
          if (kv.state === "parsed" && kv.slug && kv.slug !== ctx.slug)
            return stepRow("warn", [
              {
                text: t("cli.activate.otherProduct", {
                  app: kv.slug,
                  product,
                }),
              },
            ]);
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
        // The answered step is drawn by the next screen (it is part of the flow's header block).
        done: () => [],
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
  // The flow's screen so far (header, then the answered key row): every later screen starts with
  // it, so a resize lays the whole flow out again.
  const hist: RailRow[] = [...productHeader(ctx, "activate")];
  const lead = () => hist;
  const key = await obtainKey(ctx, args, lead);
  if (key === CANCEL)
    return {
      exitCode: EXIT.failed,
      state: "cancelled",
      result: { kind: "cancelled" },
    };
  if (key === INTERRUPT) return interrupted();
  if (key === null) {
    const message = t("cli.activate.noKey", { command: cmd(ctx, "activate") });
    show(ctx, [...hist, stepRow("fail", [{ text: message }]), endRow()]);
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
  hist.push(
    stepRow("done", t("part.keyField.label"), [
      { text: `${ctx.symbols.separator} `, style: ["muted"] },
      ...keyMask(ctx, key, true, cellWidth(t("part.keyField.label")) + 3),
    ]),
  );
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
      ...hist,
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
      r = await busy(
        ctx,
        t("activate.busy"),
        () => client.license.activateWithKey(key),
        lead,
      );
    } catch (e) {
      return failed(ctx, e, hist);
    }
    const o = activationOutcome(r, client.license.licenseInfo());
    if (o.state !== "device-limit") {
      show(ctx, [...hist, ...outcomeRows(ctx, o), endRow()]);
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
    const outcome = (): RailRow[] => [
      ...deviceLimitRows(ctx, dl),
      endRow(t("cli.deviceLimit.again", { command: cmd(ctx, "activate") })),
    ];
    if (!ctx.keys || !dl.manageUrl || attempt >= 5) {
      show(ctx, [...hist, ...outcome()]);
      return result;
    }
    // Enter opens the portal page; then Enter tries again (one more activation), Esc stops. The
    // block is one live screen: a second limit replaces it, never prints a second copy.
    const live = interactiveRegion(ctx.stdout, ctx);
    let opened = false;
    let again = false;
    let interrupt = false;
    try {
      for (;;) {
        const hints = hintsRow(
          ctx,
          t(opened ? "cli.keys.retry" : "cli.keys.deviceLimit"),
        );
        live.draw(() => [...hist, ...deviceLimitRows(ctx, dl), hints]);
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
      if (again) live.close();
      else live.commit(() => [...hist, ...outcome()]);
    }
    if (interrupt) return interrupted(result.result);
    if (!again) return result;
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
  /** The verb the person ran (`login`, or `sign-in`): next-step commands name it. */
  verb?: string;
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
    // What happened, then the fix: this product takes a license key, not an account.
    const notice = t("cli.identityOff.notice", { product: ctx.product.name });
    const fix = t("cli.identityOff.fix", { command: cmd(ctx, "activate") });
    const message = `${notice} ${fix}`;
    show(ctx, [
      ...productHeader(ctx, "login"),
      stepRow("fail", [{ text: notice }]),
      textRow(fix),
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
  const verb = args.verb ?? "login";
  const header = () => productHeader(ctx, verb);
  let prompt: SignInPrompt;
  try {
    prompt = await busy(
      ctx,
      t("signInHandoff.starting"),
      () => client.identity.beginSignIn(),
      header,
    );
  } catch (e) {
    return { ...failed(ctx, e, header()), result: { state: "error" } };
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
  // Only an auto-detected headless computer is told so; --device-code asked for the code.
  const headlessNote = useCode && !args.deviceCode && !quiet(ctx);
  let noBrowser = false;
  // A browser is on offer until it fails to open (or the computer is headless).
  let browser = !useCode;
  if (!useCode) {
    const opened = await Promise.resolve(
      ctx.openUrl(prompt.verificationUriComplete),
    ).catch(() => false);
    if (!opened) {
      useCode = true;
      noBrowser = true;
      browser = false;
    }
  }
  const abort = new AbortController();
  const live = quiet(ctx) ? null : ctx.live();
  const frames = spinnerFrames(ctx.caps.unicode);
  let copiedAt = -Infinity;
  let frame = 0;
  // The whole screen, header to key hints: it is laid out spaced and compacts by fit (screen.ts).
  const screen = (): RailRow[] => {
    const rows: RailRow[] = [...header()];
    if (useCode) {
      if (headlessNote)
        rows.push(stepRow("done", [{ text: t("signin.cli.headless") }]));
      else if (noBrowser)
        rows.push(stepRow("warn", t("signin.handoff.noBrowser")));
      else rows.push(stepRow("active", t("signin.handoff.codeTitle")));
      rows.push(
        {
          ...textRow(withLink(ctx, "signin.handoff.codeBody", codeUrl)),
          keep: true,
        },
        ...codeRows(ctx, prompt.userCode),
        { ...textRow(t("signin.handoff.check")), drop: DROP.checkLine },
      );
      const left = prompt.expiresAt - ctx.now() / 1000;
      rows.push({
        ...textRow(t("signin.handoff.expires", { time: clock(left) }), [
          "muted",
        ]),
        drop: DROP.countdown,
      });
    } else {
      rows.push(stepRow("done", [{ text: t("signin.cli.opening") }]), {
        ...textRow(
          withLink(
            ctx,
            "signin.cli.ifNotOpened",
            prompt.verificationUriComplete,
          ),
        ),
        keep: true,
      });
    }
    rows.push(...gap(ctx));
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
      role: "spinner",
    });
    if (ctx.keys) {
      const text = useCode
        ? t(browser ? "cli.keys.codeBrowser" : "cli.keys.code")
        : t("signin.cli.keys");
      const hints = hintsRow(ctx, text);
      if (useCode && ctx.now() - copiedAt < 2000) {
        // The copy hint gives way to "Copied" on the same row; never an extra row.
        const rest = text.split(" · ").slice(1).join(" · ");
        hints.spans = [
          {
            text: `${ctx.symbols.ok} ${t("common.copied")}`,
            style: ["success"],
          },
          { text: ` ${ctx.symbols.separator} `, style: ["muted"] },
          ...keyHints(rest, ctx.symbols),
        ];
      }
      rows.push(hints);
    }
    return rows;
  };
  const draw = () => live?.draw(screen);
  const stopSpin = animate(
    ctx.caps,
    (f) => {
      frame = f;
      draw();
    },
    ctx.ticker,
  );
  // Keys run beside the wait; Esc and Ctrl-C cancel it.
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
        if (!useCode) useCode = true;
        else if (ctx.caps.links) {
          ctx.stdout.write(osc52(prompt.userCode));
          copiedAt = ctx.now();
        }
      } else if (k.name === "o" && useCode && browser)
        await Promise.resolve(
          ctx.openUrl(prompt.verificationUriComplete),
        ).catch(() => false);
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
      abort.abort();
      await keyLoop;
      live?.close();
      return { ...failed(ctx, e, header()), result: { state: "error" } };
    }
  } finally {
    stopSpin();
  }
  abort.abort();
  await keyLoop;
  // The outcome replaces the whole screen, header included: one result block, never the code view
  // above it. Without animation only the result prints (the screen was printed once already).
  const finish = (result: RailRow[]) => {
    const rows = [...header(), ...result];
    if (live) live.commit(() => rows, result);
  };
  const again = (): RailRow[] =>
    commandRows(ctx, [
      {
        label: [{ text: cmd(ctx, verb), style: ["strong"], keep: true }],
        value: [{ text: t("signin.again"), style: ["muted"] }],
      },
    ]);

  if (r === "cancelled") {
    const error = codeError(ctx, "cancelled");
    finish([stepRow("fail", error.title), ...gap(ctx), ...again(), endRow()]);
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
    finish([
      stepRow("ok", line),
      useCode ? endRow() : endRow(t("signin.cli.closeTab")),
    ]);
    return { exitCode: EXIT.ok, state: "signedIn", result };
  }
  const expired = r.status === "expired";
  const error: CliJsonError = expired
    ? {
        code: "signin_expired",
        title: ctx.copy.code("sign-in-expired", "title"),
        message: t("signin.cli.signInAgain", { command: cmd(ctx, verb) }),
      }
    : {
        code: "sign-in-denied",
        title: ctx.copy.code("sign-in-denied", "title"),
        message: t("signin.cli.signInAgain", { command: cmd(ctx, verb) }),
      };
  finish([stepRow("fail", error.title), ...gap(ctx), ...again(), endRow()]);
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
      host: ctx,
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

function relative(ctx: KitContext, epoch: number): string {
  // The cache keeps `lastVerifiedAt` in milliseconds where the type says seconds: a value that
  // large cannot be seconds, so it is read as the milliseconds it is (not "20,713,526 days ago").
  const epochSeconds = epoch > 1e11 ? epoch / 1000 : epoch;
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
  const sepSpan = { text: ` ${ctx.symbols.separator} `, style: ["muted"] };
  const rows: RailRow[] = [
    stepRow(
      "active",
      t("devices.title"),
      `${ctx.symbols.separator} ${view.rows.length}`,
    ),
  ];
  // One left edge for an item's text: a continuation hangs under the name, after "● ".
  const hang = (first: Line, rest: Line, radio: Line[number]): RailRow[] => {
    const width = Math.max(1, contentWidth(ctx.caps.columns) - 2);
    const lines = [...wrapSpans(first, width), ...wrapSpans(rest, width)];
    return lines.map((l, i) => ({
      mark: "rail" as const,
      spans: i === 0 ? [radio, ...l] : [{ text: "  " }, ...l],
    }));
  };
  for (const d of view.rows) {
    const name = d.name ?? t("devices.unnamed");
    const radio = d.current ? ctx.symbols.radioOn : ctx.symbols.radioOff;
    const unit = (
      text: string,
      style: string[],
      keep = false,
    ): Line[number] => ({
      text,
      style,
      unit: true,
      ...(keep ? { keep: true } : {}),
    });
    // The second line: platform (and when it was last seen), the id, and which one is this.
    const meta: Line = [];
    const add = (span: Line[number]) => {
      if (meta.length) meta.push(sepSpan);
      meta.push(span);
    };
    if (d.platform)
      add(
        unit(
          d.lastSeenAt !== null
            ? t("devices.meta", {
                platform: d.platform,
                when: relative(ctx, d.lastSeenAt),
              })
            : d.platform,
          ["muted"],
        ),
      );
    add(unit(d.id, ["muted"], true));
    if (d.current)
      add(
        unit(t("part.thisDeviceTitle", { formFactor: "computer" }), ["muted"]),
      );
    rows.push(
      ...hang(
        [{ text: name, style: d.current ? ["strong"] : [], unit: true }],
        meta,
        { text: `${radio} `, style: d.current ? ["accent"] : ["muted"] },
      ),
    );
  }
  rows.push(
    ...gap(ctx),
    ...commandRows(ctx, [
      {
        label: [
          {
            text: `${ctx.bin} devices rename <id> <name>`,
            style: ["strong"],
            keep: true,
          },
        ],
        value: [{ text: t("devices.rename"), style: ["muted"] }],
      },
      {
        label: [
          {
            text: `${ctx.bin} devices deauthorize <id>`,
            style: ["strong"],
            keep: true,
          },
        ],
        value: [{ text: t("devices.remove"), style: ["muted"] }],
      },
    ]),
  );
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
  const availableRows = (version: string, bytes: number | null): RailRow[] => [
    stepRow(
      "active",
      bytes !== null
        ? t("cli.update.available", { version, size: formatBytes(ctx, bytes) })
        : t("cli.update.availableNoSize", { version }),
    ),
    textRow(t("cli.update.have", { version: client.core.version }), ["muted"]),
  ];
  const updateCommands = (): RailRow[] =>
    commandRows(ctx, [
      {
        label: [{ text: apply, style: ["strong"], keep: true }],
        value: [{ text: t("cli.update.install"), style: ["muted"] }],
      },
      {
        label: [{ text: cmd(ctx, "changelog"), style: ["strong"], keep: true }],
        value: [{ text: t("update.whatsNew"), style: ["muted"] }],
      },
    ]);
  try {
    if (!client.update.decidable) {
      const v = await busy(ctx, t("boot.deciding"), () =>
        client.update.check(),
      );
      show(
        ctx,
        v.updateAvailable
          ? [
              ...availableRows(v.version, null),
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
      case "available": {
        if (!view.version) {
          rows.push(
            stepRow("active", t("updateProgress.contentTitle")),
            endRow(
              t("update.platform.command", {
                command: cmd(ctx, "packs status"),
              }),
            ),
          );
          break;
        }
        // "2.5.0 is available", what you have now, and the two commands that follow from it. The
        // version string passes through as the release gave it.
        const size = (r.decision as { release?: { size?: number } }).release
          ?.size;
        rows.push(
          ...availableRows(
            view.version,
            typeof size === "number" ? size : null,
          ),
          ...gap(ctx),
          ...updateCommands(),
          endRow(),
        );
        break;
      }
      case "mandatory":
        rows.push(
          ...problemRows(
            "warn",
            t("update.mandatoryTitle", { product }),
            t("update.mandatoryBody", { product }),
          ),
          ...gap(ctx),
          ...updateCommands(),
          endRow(),
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

/** The unit a size is shown in: megabytes from 1 MB up, else kilobytes. */
function sizeUnit(bytes: number): {
  unit: "megabyte" | "kilobyte";
  div: number;
} {
  return bytes >= 1_000_000
    ? { unit: "megabyte", div: 1_000_000 }
    : { unit: "kilobyte", div: 1000 };
}

/** "38" and "61 MB": the finished part as a bare number, the whole with the unit. */
function sizePair(
  ctx: KitContext,
  done: number,
  total: number,
): { size: string; total: string } {
  const { unit, div } = sizeUnit(total);
  const digits = (n: number) => (n >= 10 || n < 1 ? 0 : 1);
  const num = new Intl.NumberFormat(ctx.copy.locale, {
    maximumFractionDigits: digits(total / div),
  });
  const withUnit = new Intl.NumberFormat(ctx.copy.locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: digits(total / div),
  });
  return { size: num.format(done / div), total: withUnit.format(total / div) };
}

/** "20 s": the time left, with a space before the unit and never "0 s". */
function timeLeft(ctx: KitContext, seconds: number): string | null {
  const s = Math.round(seconds);
  if (!(s >= 1)) return null;
  const [value, unit] =
    s >= 3600
      ? [Math.round(s / 3600), "hour"]
      : s >= 60
        ? [Math.round(s / 60), "minute"]
        : [s, "second"];
  const narrow = new Intl.NumberFormat(ctx.copy.locale, {
    style: "unit",
    unit,
    unitDisplay: "narrow",
  }).format(value);
  return ctx.copy.t("cli.update.timeLeft", {
    time: narrow.replace(/^(\d+)(\D)/u, "$1 $2"),
  });
}

/**
 * The download's progress: the bar (at least 16 cells), the percentage, then the figures. As the
 * line narrows the figures give way in order: the time left goes, then the sizes shorten to
 * "38/61 MB", then they move to their own muted line under the bar. Each number keeps its unit.
 */
function progressRows(
  ctx: KitContext,
  done: number,
  total: number,
  startedAt: number,
): RailRow[] {
  const t = ctx.copy.t.bind(ctx.copy);
  const v = progressView(done, total);
  const elapsed = (ctx.now() - startedAt) / 1000;
  const rate = elapsed > 0 ? done / elapsed : 0;
  const pct = `  ${percent(done, total)}%`;
  const sep = ` ${ctx.symbols.separator} `;
  const sizes = sizePair(ctx, done, total);
  const eta =
    v.state === "downloading" && rate > 0
      ? timeLeft(ctx, (total - done) / rate)
      : null;
  const long = t("cli.update.figures", sizes);
  const short = t("cli.update.figuresShort", sizes);
  const variants = (
    v.state === "downloading"
      ? [[long, eta], [long], [short]].map((x) =>
          x.filter((p): p is string => !!p),
        )
      : [[v.state === "queued" ? t("updateProgress.queued") : sizes.total]]
  ).map((parts) => parts.join(sep));
  const cw = contentWidth(ctx.caps.columns);
  const bar = (w: number) =>
    progressSpans(v.fraction, ctx.symbols, Math.max(10, Math.min(36, w)));
  for (const meta of variants) {
    const room = cw - cellWidth(pct) - cellWidth(sep) - cellWidth(meta);
    if (room >= 16)
      return [
        {
          mark: "rail",
          keep: true,
          spans: [
            ...bar(room),
            { text: pct, style: ["strong"] },
            { text: `${sep}${meta}`, style: ["muted"] },
          ],
        },
      ];
  }
  return [
    {
      mark: "rail",
      keep: true,
      spans: [...bar(cw - cellWidth(pct)), { text: pct, style: ["strong"] }],
    },
    {
      mark: "rail",
      keep: true,
      spans: [{ text: variants[0]!, style: ["muted"], unit: true }],
    },
  ];
}

/** `update apply`: decide, then download with a redrawn bar, then install. */
export async function updateApplyFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): Promise<FlowResult> {
  const t = ctx.copy.t.bind(ctx.copy);
  const product = ctx.product.name;
  const header = () => productHeader(ctx, "update apply");
  let r;
  try {
    r = await busy(
      ctx,
      t("boot.deciding"),
      () => client.update.decide(),
      header,
    );
  } catch (e) {
    return failed(ctx, e, header());
  }
  const d = r.decision;
  if (d.action !== "binary" && d.action !== "store") {
    const view = updateView(d);
    show(ctx, [
      ...header(),
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
  const live = quiet(ctx) ? null : ctx.live();
  const abort = new AbortController();
  const started = ctx.now();
  let last = 0;
  let lastDone = 0;
  let lastTotal = 0;
  const title = () =>
    stepRow(
      "active",
      t("update.title", { product, version: d.release.version }),
    );
  // The whole screen, header to key hints, redrawn as one (a resize lays it out again).
  const screen = (): RailRow[] => [
    ...header(),
    title(),
    ...(ctx.caps.animate
      ? progressRows(ctx, lastDone, lastTotal, started)
      : []),
    ...(ctx.keys ? [hintsRow(ctx, t("cli.keys.download"))] : []),
  ];
  const redraw = () => live?.draw(screen);
  redraw();
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
  const finish = (result: RailRow[]) => {
    const rows = [...header(), ...result];
    if (live) live.commit(() => rows, result);
    else show(ctx, rows);
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
    if (cancelled) {
      finish([stepRow("fail", t("cli.update.cancelled")), endRow()]);
      if (interrupt) return interrupted({ state: "cancelled", ...fields });
      return {
        exitCode: EXIT.failed,
        state: "cancelled",
        result: { state: "cancelled", ...fields },
      };
    }
    // Say what happened, that nothing was installed, and the command to try again.
    const code = errorCode(e);
    const error = codeError(ctx, code);
    finish([
      stepRow("fail", error.title),
      textRow(t("cli.update.nothingInstalled")),
      ...gap(ctx),
      ...commandRows(ctx, [
        {
          label: [
            { text: cmd(ctx, "update apply"), style: ["strong"], keep: true },
          ],
          value: [{ text: t("common.tryAgain"), style: ["muted"] }],
        },
      ]),
      endRow(),
    ]);
    return {
      exitCode: EXIT.failed,
      state: "error",
      error: code ? error : { ...error, code: "internal" },
    };
  }
  abort.abort();
  await keyLoop;
  const view = installView(out);
  const version = "version" in out ? out.version : d.release.version;
  switch (view.state) {
    case "ready": {
      // One result block replaces the title and the bar; the chip already names the product.
      const size = lastTotal > 0 ? formatBytes(ctx, lastTotal) : null;
      finish([
        stepRow(
          "ok",
          size
            ? t("cli.update.ready", { version, size })
            : t("cli.update.readyNoSize", { version }),
        ),
        textRow(t("cli.update.restart")),
        endRow(),
      ]);
      break;
    }
    case "platform":
      finish([
        stepRow("ok", t("update.platform.generic", { product })),
        endRow(),
      ]);
      break;
    case "store":
      finish([
        stepRow("ok", t("update.platform.generic", { product })),
        ...("url" in out ? [textRow([linkSpan(out.url)])] : []),
        endRow(),
      ]);
      break;
    case "blocked": {
      const error = codeError(ctx, "unsupported");
      finish([...problemRows("fail", error.title, error.message), endRow()]);
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
    show(ctx, [
      stepRow("fail", error.title),
      textRow(t("cli.changelog.fix", { command: cmd(ctx, "changelog") })),
      endRow(),
    ]);
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
      ...progressRows(ctx, f.done, f.total, ctx.now()),
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
  const header = () => productHeader(ctx, "packs ensure");
  const live = quiet(ctx) ? null : ctx.live();
  live?.draw(header);
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
    live?.draw(() => [
      ...header(),
      {
        mark: "active",
        spans: [
          { text: e.packId, style: ["strong"], keep: true },
          ...(e.phase === "apply"
            ? [
                {
                  text: `  ${t("updateProgress.installing")}`,
                  style: ["muted"] as string[],
                },
              ]
            : []),
        ],
      },
      ...progressRows(ctx, e.done, e.total, started),
    ]);
  });
  const finish = (result: RailRow[]) => {
    const rows = [...header(), ...result];
    if (live) live.commit(() => rows, result);
    else show(ctx, rows);
  };
  try {
    const installs = await client.update.packs.ensure(packIds);
    finish(
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
    live?.close();
    return failed(ctx, e, header());
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
    tableRows(ctx, [
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
      ctx,
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

/** The side-by-side layout needs the text, a gap and the QR on one line (about 100 columns). */
const QR_GAP = 2;

/** `offline-request`: the request code, with a QR code where the screen has room for it. */
export function offlineRequestFlow(
  ctx: KitContext,
  client: PolarisKeyClient,
): FlowResult {
  const t = ctx.copy.t.bind(ctx.copy);
  const deviceId = client.core.deviceId;
  const result = { product: client.product, requestCode: deviceId };
  if (quiet(ctx)) return { exitCode: EXIT.ok, state: "default", result };
  // The chip already names the product: no "Product: …" line. One footer command row says what
  // to do with the file that comes back.
  const codeRow: RailRow = codeRows(ctx, deviceId)[1] ?? {
    mark: "rail",
    spans: [],
  };
  const codeLine =
    codeRows(ctx, deviceId).find((r) => r.spans.length) ?? codeRow;
  const head: RailRow[] = [
    ...productHeader(ctx, "offline-request"),
    stepRow("active", t("offlineActivation.title")),
    textRow(t("offlineActivation.request")),
  ];
  const footer = commandRows(ctx, [
    {
      label: [
        {
          text: cmd(ctx, "import-bundle <file>"),
          style: ["strong"],
          keep: true,
        },
      ],
      value: [{ text: t("cli.verb.importBundle"), style: ["muted"] }],
    },
  ]);
  const qr = qrLines(deviceId, ctx.caps);
  const terminalColumns = ctx.stdout.columns ?? ctx.caps.columns;
  const qrWidth = qr ? Math.max(...qr.map((l) => cellWidth(l))) : 0;
  const qrRow = (line: string): RailRow => ({
    mark: "rail",
    spans: [
      { text: " ".repeat(QR_INDENT - 3) },
      {
        text: line,
        style: ctx.caps.color === "none" ? [] : ["qr"],
        keep: true,
      },
    ],
  });
  const plain = [
    ...head,
    ...gap(ctx),
    codeLine,
    ...gap(ctx),
    ...footer,
    endRow(),
  ];
  const asRows = (rows: RailRow[]) => ctx.render(closeRail(rows));
  if (qr) {
    const left = asRows(plain);
    const leftWidth = Math.max(...left.map((l) => cellWidth(l)));
    // Landscape: the QR beside the request, top-aligned with its title, when the line has room.
    const titleAt = productHeader(ctx, "offline-request").length;
    if (
      leftWidth + QR_GAP + qrWidth <= terminalColumns &&
      terminalColumns >= 100 &&
      titleAt + qr.length <= ctx.caps.rows - 1
    ) {
      const rail = ctx.painter.style(ctx.symbols.rail, ["muted"]);
      const total = Math.max(left.length, titleAt + qr.length);
      const lines: string[] = [];
      for (let i = 0; i < total; i++) {
        const l = left[i] ?? rail;
        const q = qr[i - titleAt];
        lines.push(
          q === undefined
            ? l
            : `${padEnd(l, leftWidth)}${" ".repeat(QR_GAP)}${ctx.painter.style(q, ctx.caps.color === "none" ? [] : ["qr"])}`,
        );
      }
      ctx.stdout.write(`${lines.join("\n")}\n`);
      return { exitCode: EXIT.ok, state: "default", result };
    }
    // Portrait: the QR under the code (its own quiet zone is the gap), when the whole screen fits.
    const stacked = [
      ...head,
      ...gap(ctx),
      codeLine,
      ...qr.map(qrRow),
      ...footer,
      endRow(),
    ];
    const lines = asRows(stacked);
    if (
      qrFits(qr, { ...ctx.caps, terminalColumns }, lines.length - qr.length)
    ) {
      ctx.stdout.write(`${lines.join("\n")}\n`);
      return { exitCode: EXIT.ok, state: "default", result };
    }
  }
  ctx.stdout.write(`${asRows(plain).join("\n")}\n`);
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
    // One title, then who to ask for a new file: the same two lines in both kits.
    show(ctx, [
      stepRow("fail", shown.title),
      textRow(t("cli.import.fix")),
      endRow(),
    ]);
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
      ...tableRows(ctx, table),
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
