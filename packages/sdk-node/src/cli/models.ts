// The terminal kit's headless layer (docs/design/UI-KITS.md §1.3 layer c, §4.6): pure functions
// from SDK results to a view, `{ component, state, copy }` plus the data the view shows. The
// component and state names are those of packages/brand/kit-copy/components.json, and `copy`
// lists the catalog keys the view's visible strings come from, so a host that draws its own UI
// on these gets the same steps, states and copy keys as the drop-in flows (and the UK-02b
// ui-matrix rows can be run against them as they land).
//
// Nothing here touches a terminal, a network or a clock: the flows feed the SDK's answers in.

import type { LicenseInfo } from "../license/client.js";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import type { ActivationResult } from "../license/endpoints.js";
import type { InstallOutcome } from "../update/drivers/types.js";

/** A view: which component and state, the catalog keys it shows, and its data. */
export interface View<C extends string = string, S extends string = string> {
  component: C;
  state: S;
  /** Catalog keys of the visible strings (kit keys and `core.*`). */
  copy: string[];
}

// ── Activate: the key field ────────────────────────────────────────────────────────────────

/** A license key's secret: exactly 22 base64url characters (packages/worker/src/crypto.ts). */
export const KEY_SECRET_LENGTH = 22;
const KEY_PREFIX = "pkey_";
const KEY_SHAPE = /^pkey_([a-z0-9-]+)_([A-Za-z0-9_-]*)$/;

export type KeyFieldState =
  | "empty"
  | "typing"
  | "parsed"
  | "cut-short"
  | "rejected";

export interface KeyVerdict extends View<"Activate", KeyFieldState> {
  /** The product slug the key names, once it parses that far. */
  slug?: string;
  /** `pkey_<slug>_`: the key's public prefix. */
  prefix?: string;
  /** Secret characters present (for the cut-short line). */
  used?: number;
  limit: number;
  /** Why it is rejected: malformed, or nothing entered. */
  reason?: "malformed" | "empty";
}

/**
 * The live verdict on what is in the key field. `submitted` turns a short secret into
 * `cut-short` (EXPERIENCE P2) and an empty field into `rejected/empty`; while typing they are
 * `typing` and `empty`.
 */
export function keyVerdict(input: string, submitted = false): KeyVerdict {
  const key = input.trim();
  const limit = KEY_SECRET_LENGTH;
  if (key === "")
    return submitted
      ? {
          component: "Activate",
          state: "rejected",
          copy: ["part.keyField.empty"],
          reason: "empty",
          limit,
        }
      : {
          component: "Activate",
          state: "empty",
          copy: ["part.keyField.label", "activate.lede"],
          limit,
        };
  if (!key.startsWith(KEY_PREFIX)) {
    return KEY_PREFIX.startsWith(key) && !submitted
      ? {
          component: "Activate",
          state: "typing",
          copy: ["part.keyField.label"],
          limit,
        }
      : {
          component: "Activate",
          state: "rejected",
          copy: ["part.keyField.malformed"],
          reason: "malformed",
          limit,
        };
  }
  const m = KEY_SHAPE.exec(key);
  if (!m) {
    const slugSoFar = /^pkey_[a-z0-9-]*$/.test(key);
    return slugSoFar && !submitted
      ? {
          component: "Activate",
          state: "typing",
          copy: ["part.keyField.label"],
          limit,
        }
      : {
          component: "Activate",
          state: "rejected",
          copy: ["part.keyField.malformed"],
          reason: "malformed",
          limit,
        };
  }
  const slug = m[1]!;
  const used = [...m[2]!].length;
  const prefix = `${KEY_PREFIX}${slug}_`;
  if (used === limit)
    return {
      component: "Activate",
      state: "parsed",
      copy: ["part.keyField.forProduct"],
      slug,
      prefix,
      used,
      limit,
    };
  if (used > limit)
    return {
      component: "Activate",
      state: "rejected",
      copy: ["part.keyField.malformed"],
      reason: "malformed",
      slug,
      prefix,
      used,
      limit,
    };
  return submitted
    ? {
        component: "Activate",
        state: "cut-short",
        copy: ["part.keyField.cutShort"],
        slug,
        prefix,
        used,
        limit,
      }
    : {
        component: "Activate",
        state: "typing",
        copy: ["part.keyField.label"],
        slug,
        prefix,
        used,
        limit,
      };
}

// ── Activate: the outcome, and DeviceLimit ──────────────────────────────────────────────────

export interface DeviceLimitView extends View<
  "DeviceLimit",
  "browser-mode" | "default"
> {
  used: number | null;
  limit: number | null;
  /** The portal page that frees a seat (PX-W8), or null when the product's portal is off. */
  manageUrl: string | null;
}

export type ActivateOutcome =
  | (View<"Activate", "done"> & { tier: string | null })
  | (View<"Activate", "device-limit"> & { deviceLimit: DeviceLimitView })
  | (View<"Activate", "rejected"> & {
      /** The registry code (the activation kind's wire code). */
      code: string;
      /** The kind, for the `core.activation.*` table, or null when the copy is a code's. */
      kind: string | null;
    });

/** The refusal kinds `core.activation.*` describes. */
const ACTIVATION_KINDS = new Set([
  "device-limit",
  "fingerprint-required",
  "hardware-mismatch",
  "enroll-claimed",
  "license-disabled",
  "license-expired",
  "attestation-required",
  "rate-limited",
  "unauthorized",
  "enroll-disabled",
]);

/** The view for an activation (or enrolment) result. */
export function activationOutcome(
  r: ActivationResult,
  info: Pick<LicenseInfo, "tier" | "tierLabel"> | null = null,
): ActivateOutcome {
  if (r.kind === "ok")
    return {
      component: "Activate",
      state: "done",
      copy: ["core.activation.ok.title", "core.activation.ok.message"],
      tier: info?.tierLabel ?? info?.tier ?? null,
    };
  if (r.kind === "device-limit") {
    const manageUrl = r.manageUrl ?? null;
    return {
      component: "Activate",
      state: "device-limit",
      copy: [
        "core.activation.device-limit.title",
        "core.activation.device-limit.message",
        "deviceLimit.title",
      ],
      deviceLimit: {
        component: "DeviceLimit",
        state: manageUrl ? "browser-mode" : "default",
        copy: manageUrl
          ? [
              "deviceLimit.heading",
              "part.seatMeter.caption",
              "deviceLimit.browser",
            ]
          : [
              "deviceLimit.heading",
              "part.seatMeter.caption",
              "core.activation.device-limit.message",
            ],
        used: r.deviceCount ?? null,
        limit: r.limit ?? null,
        manageUrl,
      },
    };
  }
  if (r.kind === "refused" || r.kind === "error") {
    const code =
      r.kind === "error"
        ? r.code === "network"
          ? "network"
          : "unknown"
        : r.code;
    const kind = code === "key_entry_limit" ? "key-entry-limit" : null;
    return {
      component: "Activate",
      state: "rejected",
      copy: kind
        ? [`core.activation.${kind}.title`, `core.activation.${kind}.message`]
        : [`core.codes.${code}.title`, `core.codes.${code}.message`],
      code,
      kind,
    };
  }
  const kind = ACTIVATION_KINDS.has(r.kind) ? r.kind : null;
  return {
    component: "Activate",
    state: "rejected",
    copy: kind
      ? [`core.activation.${kind}.title`, `core.activation.${kind}.message`]
      : [`core.codes.${r.code}.title`, `core.codes.${r.code}.message`],
    code: r.code,
    kind,
  };
}

/** Seat meter cells: filled for used seats, empty for free ones (at most 12 drawn). */
export function seatCells(
  used: number,
  limit: number,
): { filled: number; empty: number } {
  const l = Math.max(0, Math.min(12, limit));
  const u = Math.max(0, Math.min(l, used));
  return { filled: u, empty: l - u };
}

// ── SignInHandoff ──────────────────────────────────────────────────────────────────────────

export type HandoffState =
  | "starting"
  | "waiting"
  | "no-browser"
  | "code"
  | "link-copied"
  | "finishing"
  | "denied"
  | "expired"
  | "cancelled";

export interface HandoffView extends View<"SignInHandoff", HandoffState> {
  /** The page to open, as people read it (no scheme). */
  url?: string;
  userCode?: string;
  secondsLeft?: number;
}

/** SIGN-IN.md §4.15, frame 32: the terminal's hand-off steps and their copy. */
export function handoffView(
  state: HandoffState,
  data: { url?: string; userCode?: string; secondsLeft?: number } = {},
): HandoffView {
  const copy: Record<HandoffState, string[]> = {
    starting: ["signInHandoff.starting"],
    waiting: [
      "signin.cli.opening",
      "signin.cli.ifNotOpened",
      "signin.handoff.waiting",
      "signin.cli.keys",
    ],
    "no-browser": [
      "signin.cli.headless",
      "signin.handoff.codeBody",
      "signin.handoff.check",
      "signin.handoff.expires",
      "cli.signin.waitingCode",
      "cli.keys.code",
    ],
    code: [
      "signin.handoff.codeBody",
      "signin.handoff.check",
      "signin.handoff.expires",
      "cli.signin.waitingCode",
      "cli.keys.code",
    ],
    "link-copied": ["common.copied"],
    finishing: ["signin.handoff.finishing"],
    denied: ["core.codes.oidc_error.title", "core.codes.oidc_error.message"],
    expired: ["signin.handoff.tooLong", "signin.cli.signInAgain"],
    cancelled: ["core.codes.cancelled.title", "signin.cli.signInAgain"],
  };
  return { component: "SignInHandoff", state, copy: copy[state], ...data };
}

/** `m:ss` for a countdown (tabular in a terminal by construction). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Status: AccountAndLicense, GraceBanner, StatusScreen ───────────────────────────────────

export type GateStatus =
  | "ok"
  | "grace"
  | "expired"
  | "revoked"
  | "needs-activation"
  | "version-too-old"
  | "version-too-new"
  | "channel-not-entitled"
  | "not-applicable";

/** A fix the status names, as the verb that does it. */
export interface StatusFix {
  /** The CLI verb path (`activate`, `update apply`), or null for a fix outside the CLI. */
  verb: string | null;
  /** The catalog key of its description. */
  key: string;
}

export type StatusView =
  | (View<"AccountAndLicense", "signed-in" | "key-only"> & {
      tier: string | null;
      holder: string | null;
      graceUntil: number | null;
    })
  | (View<"GraceBanner", "days-left" | "last-day"> & {
      daysLeft: number;
      graceUntil: number;
    })
  | (View<
      "StatusScreen",
      | "revoked"
      | "expired"
      | "version-too-old"
      | "version-too-new"
      | "channel-not-entitled"
    > & { fixes: StatusFix[] })
  | (View<"PolarisKeyGate", "needs-activation"> & { fixes: StatusFix[] })
  | (View<"PolarisKeyGate", "licensed"> & { notApplicable: true });

export interface StatusInput {
  status: GateStatus | string;
  graceUntil?: number;
  info: Pick<LicenseInfo, "tier" | "tierLabel" | "profile"> | null;
  /** Epoch seconds. */
  now: number;
  /** What the product offers, so a fix is never a verb that cannot work. */
  can?: { signIn?: boolean; enroll?: boolean; update?: boolean };
}

const DAY = 86_400;

/** The status view for the gate. */
export function statusView(i: StatusInput): StatusView {
  const can = { signIn: true, enroll: false, update: true, ...i.can };
  const keyFixes: StatusFix[] = [
    { verb: "activate", key: "signin.key.differentKey" },
    ...(can.signIn ? [{ verb: "login", key: "cli.fix.signIn" }] : []),
  ];
  switch (i.status) {
    case "ok": {
      const holder = i.info?.profile?.email ?? i.info?.profile?.name ?? null;
      return {
        component: "AccountAndLicense",
        state: holder ? "signed-in" : "key-only",
        copy: [
          "cli.status.license",
          "account.tier",
          "cli.status.offline",
          "cli.status.offlineUntil",
          "cli.status.version",
          ...(holder ? [] : ["account.keyOnly"]),
        ],
        tier: i.info?.tierLabel ?? i.info?.tier ?? null,
        holder,
        graceUntil: i.graceUntil ?? null,
      };
    }
    case "grace": {
      const until = i.graceUntil ?? i.now;
      const daysLeft = Math.max(0, Math.ceil((until - i.now) / DAY));
      return daysLeft <= 1
        ? {
            component: "GraceBanner",
            state: "last-day",
            copy: ["grace.lastDay", "grace.deadline"],
            daysLeft,
            graceUntil: until,
          }
        : {
            component: "GraceBanner",
            state: "days-left",
            copy: ["grace.daysLeft", "grace.deadline"],
            daysLeft,
            graceUntil: until,
          };
    }
    case "needs-activation":
      return {
        component: "PolarisKeyGate",
        state: "needs-activation",
        copy: [
          "core.gate.needs-activation.title",
          "core.gate.needs-activation.message",
          "cli.status.fixes",
        ],
        fixes: [
          { verb: "activate", key: "welcome.useKey" },
          ...(can.signIn ? [{ verb: "login", key: "welcome.signIn" }] : []),
          ...(can.enroll
            ? [{ verb: "enroll", key: "welcome.continueFree" }]
            : []),
        ],
      };
    case "not-applicable":
      return {
        component: "PolarisKeyGate",
        state: "licensed",
        copy: [
          "core.gate.not-applicable.title",
          "core.gate.not-applicable.message",
        ],
        notApplicable: true,
      };
    case "revoked":
    case "expired":
    case "version-too-old":
    case "version-too-new":
    case "channel-not-entitled": {
      const fixes: Record<string, StatusFix[]> = {
        revoked: keyFixes,
        expired: [{ verb: null, key: "status.renew" }, ...keyFixes],
        "version-too-old": can.update
          ? [{ verb: "update apply", key: "status.update" }]
          : [],
        "version-too-new": [{ verb: null, key: "status.switchChannel" }],
        "channel-not-entitled": [{ verb: null, key: "status.switchChannel" }],
      };
      return {
        component: "StatusScreen",
        state: i.status,
        copy: [
          `core.gate.${i.status}.title`,
          `core.gate.${i.status}.message`,
          "cli.status.fixes",
        ],
        fixes: fixes[i.status]!,
      };
    }
    default:
      return {
        component: "StatusScreen",
        state: "revoked",
        copy: ["core.fallback.title", "core.fallback.message"],
        fixes: keyFixes,
      };
  }
}

/** The exit code the status maps to (docs: 0 usable, 3 blocked or not activated). */
export function statusExit(status: string): number {
  return status === "ok" || status === "grace" || status === "not-applicable"
    ? 0
    : 3;
}

// ── UpdatePrompt and UpdateProgress ────────────────────────────────────────────────────────

export type UpdatePromptView = View<
  "UpdatePrompt",
  | "available"
  | "mandatory"
  | "blocked"
  | "store"
  | "platform"
  | "ready"
  | "up-to-date"
> & {
  version: string | null;
  storeUrl: string | null;
};

/** The view for an update decision. */
export function updateView(d: UpdateDecision): UpdatePromptView {
  const base = { component: "UpdatePrompt" as const, storeUrl: null };
  switch (d.action) {
    case "none":
      return {
        ...base,
        state: "up-to-date",
        copy: ["update.upToDate"],
        version: null,
      };
    case "binary":
      return {
        ...base,
        state: d.mandatory ? "mandatory" : "available",
        copy: d.mandatory
          ? [
              "update.mandatoryTitle",
              "update.mandatoryBody",
              "update.platform.command",
            ]
          : ["update.title", "update.platform.command"],
        version: d.release.version,
      };
    case "store":
      return {
        ...base,
        state: "store",
        copy: ["update.title", "update.openStore"],
        version: d.release.version,
        storeUrl: d.listingUrl ?? null,
      };
    case "platform":
      return {
        ...base,
        state: "platform",
        copy: ["update.title", "update.platform.generic"],
        version: d.release.version,
      };
    case "code-ready":
      return {
        ...base,
        state: "ready",
        copy: ["update.readyTitle", "update.readyBody"],
        version: d.release.version,
      };
    case "blocked":
      return {
        ...base,
        state: "blocked",
        copy: ["update.blockedTitle", "update.blockedBody"],
        version: null,
      };
    case "packs":
      return {
        ...base,
        state: "available",
        copy: ["updateProgress.contentTitle"],
        version: null,
      };
  }
}

export type UpdateProgressView = View<
  "UpdateProgress",
  "queued" | "downloading" | "installing" | "failed" | "done"
> & { fraction: number };

export function progressView(
  done: number,
  total: number,
  phase: "download" | "install" = "download",
): UpdateProgressView {
  if (phase === "install")
    return {
      component: "UpdateProgress",
      state: "installing",
      copy: ["updateProgress.installing"],
      fraction: 1,
    };
  if (!(total > 0) || done <= 0)
    return {
      component: "UpdateProgress",
      state: "queued",
      copy: ["updateProgress.queued"],
      fraction: 0,
    };
  return {
    component: "UpdateProgress",
    state: done >= total ? "done" : "downloading",
    copy:
      done >= total ? ["updateProgress.done"] : ["updateProgress.downloading"],
    fraction: Math.min(1, done / total),
  };
}

/** The view for how an install ended. */
export function installView(
  o: InstallOutcome,
): View<"UpdatePrompt", "ready" | "store" | "platform" | "blocked"> {
  switch (o.kind) {
    case "restartRequired":
      return {
        component: "UpdatePrompt",
        state: "ready",
        copy: ["update.readyTitle", "update.readyBody"],
      };
    case "handedOff":
      return {
        component: "UpdatePrompt",
        state: "platform",
        copy: ["update.title", "update.platform.generic"],
      };
    case "storeOpened":
      return {
        component: "UpdatePrompt",
        state: "store",
        copy: ["update.title", "update.openStore"],
      };
    case "unsupported":
      return {
        component: "UpdatePrompt",
        state: "blocked",
        copy: [
          "core.codes.unsupported.title",
          "core.codes.unsupported.message",
        ],
      };
  }
}

// ── Devices ────────────────────────────────────────────────────────────────────────────────

export interface DeviceRowInput {
  id: string;
  label?: string | null;
  platform?: string | null;
  current?: boolean;
  lastSeenAt?: number | null;
}

export type DevicesView = View<"Devices", "list" | "empty"> & {
  rows: Array<{
    id: string;
    name: string | null;
    platform: string | null;
    current: boolean;
    lastSeenAt: number | null;
  }>;
};

export function devicesView(devices: readonly DeviceRowInput[]): DevicesView {
  if (devices.length === 0)
    return {
      component: "Devices",
      state: "empty",
      copy: ["devices.empty"],
      rows: [],
    };
  return {
    component: "Devices",
    state: "list",
    copy: [
      "devices.title",
      "devices.count",
      "devices.meta",
      "devices.unnamed",
      "part.thisDeviceTitle",
    ],
    rows: devices.map((d) => ({
      id: d.id,
      name: d.label ?? null,
      platform: d.platform ?? null,
      current: d.current === true,
      lastSeenAt: d.lastSeenAt ?? null,
    })),
  };
}
