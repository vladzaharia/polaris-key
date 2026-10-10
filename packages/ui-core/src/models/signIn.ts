// The signIn family (ui-matrix.json `signIn`): the one sign-in form of SIGN-IN.md §3.17, whose
// body morphs in place through methods → handoff | code → finishing → choose ↔ replace | key →
// done (plans/I-04.md §G). SignIn is the form; SignInHandoff draws its step 2 (Finish in your
// browser, the device code); LicenseChoice its step 3 (with Replace a device). These are pure
// functions of the session; `SignInModel` (../signInModel.ts) is the state machine that drives
// the SDK primitives and feeds them.
//
// Precedence, where several states could hold (ui-matrix.json `vocabulary.precedence`):
//
//   SignIn          error, expired, done, key, replace, choose, finishing, code, handoff, methods
//   LicenseChoice   loading, grant-expired, raced, replace-open, none-keys | none-no-keys, new,
//                   create, all-full, keep, current, mixed, one, many
//
// A `browser` presentation or a device-code sign-in never reaches choose, replace or a
// LicenseChoice state (D4): the card chooses. `replace: "browser"` never opens the device list in
// the app; Replace opens the card instead (`replace-in-browser`).

import { activationCopy } from "../errors.js";
import {
  platformClass,
  systemConfirm,
  type Context,
  type LicenseChoiceRow,
} from "../input.js";
import { codeExpired, countdown, linkVerdict, validLink } from "../link.js";
import { loadingVisible } from "../loading.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

const DEFAULT_DEVICE_URL = "https://key.plrs.im/device";
const DEFAULT_TV_URL = "https://key.plrs.im/tv";

/** The sign-in is possible here: Identity is on and the build offers it. */
function signInOn(ctx: Context): boolean {
  return ctx.on("identity") && ctx.caps.signIn;
}

/** True when the license choice happens in the app (inline or sheet, browser channel: D4). */
function choosesInApp(ctx: Context): boolean {
  const s = ctx.input.signIn;
  return !!s && s.presentation !== "browser" && s.channel !== "device-code";
}

/** The device-code page: the product's own `deviceCodeUrl`, else the server's address, else
 *  Polaris Key's (`/tv` on a TV or console, `/device` elsewhere; SIGN-IN.md D-16). */
export function verificationUrl(ctx: Context): string {
  // The first that passes the opener (DL14): a broken integrator address never hides the
  // server's valid one.
  for (const candidate of [
    ctx.input.integrator?.deviceCodeUrl,
    ctx.input.deviceCode?.verificationUri,
  ])
    if (validLink(candidate) !== null) return candidate!;
  const c = platformClass(ctx.platform);
  return c === "tv" || c === "console" ? DEFAULT_TV_URL : DEFAULT_DEVICE_URL;
}

// ── SignIn ─────────────────────────────────────────────────────────────────────────────────────

export type SignInState =
  | "methods"
  | "handoff"
  | "code"
  | "finishing"
  | "choose"
  | "replace"
  | "key"
  | "done"
  | "error"
  | "expired"
  | "hidden";

/** The copy key of the first sign-in method, the methods step's primary (DL9). */
function methodsPrimary(ctx: Context): string {
  return platformClass(ctx.platform) === "desktop"
    ? "signin.desktop.continue"
    : "signin.provider.continue";
}

function methodsCopy(ctx: Context): (string | false)[] {
  const c = platformClass(ctx.platform);
  const keyPath = ctx.caps.keyEntry && ctx.on("license");
  const common = [
    "signIn.title",
    "signin.methods.ledeApp",
    "signin.provider.group",
    "signin.provider.continue",
    keyPath && "signin.choice.keyInstead",
    "common.cancel",
  ];
  // Desktop leads with Continue in browser and has no passkey or device-code row (D-69).
  if (c === "desktop")
    return [...common, "signin.desktop.continue", "signin.menu.signIn"];
  return [
    ...common,
    "signin.passkey",
    "signin.email.continue",
    // Sign in on your phone or computer: a phone or tablet hands off; a page is already there.
    c === "handheld" && ctx.caps.deviceCode && "signin.link.deviceCode",
  ];
}

/** The one sign-in form. */
export function signInView(ctx: Context): View<"SignIn", SignInState> {
  const s = ctx.input.signIn;
  if (!signInOn(ctx) || !s) return hiddenView(ctx, "SignIn");
  const dc = ctx.input.deviceCode;
  const id = identityText(ctx);
  const args = { product: id.name, app: id.name };
  const license = ctx.on("license");
  const error = ctx.input.error?.code;
  if (error) {
    const primary = methodsPrimary(ctx);
    // Sign-in errors sit under Sign in (DL7); the methods stay.
    return makeView(ctx, "SignIn", {
      state: "error",
      copy: [
        error === "sign-in-unavailable"
          ? "signIn.noMethods"
          : "signIn.methodError",
      ],
      args,
      primary,
      tone: "danger",
      errorSlot: primary,
    });
  }
  if (
    s.outcome === "expired" ||
    (dc && (dc.phase === "expired" || codeExpired(dc.secondsLeft)))
  )
    return makeView(ctx, "SignIn", {
      state: "expired",
      copy:
        s.channel === "device-code"
          ? [
              "core.codes.sign-in-expired.title",
              "core.codes.sign-in-expired.message",
              "signin.again",
            ]
          : ["signin.handoff.tooLong", "signin.again"],
      args,
      primary: "signin.again",
      tone: "neutral",
    });
  if (s.outcome === "signedIn") {
    // How the form ends (SIGN-IN.md §3.17 item 4): Done when a license was added or issued now;
    // otherwise the form closes and the app opens with the toast. License off: no tier to name.
    const copy = !license
      ? ["signin.return.signedInShort"]
      : s.issuedNow
        ? ["signin.done.start", "signin.return.signedInShort"]
        : ["signin.desktop.toast"];
    return makeView(ctx, "SignIn", {
      state: "done",
      copy,
      args,
      primary: copy.includes("signin.done.start") ? "signin.done.start" : null,
      focus: copy.includes("signin.done.start") ? undefined : null,
    });
  }
  const inApp = choosesInApp(ctx);
  if (s.outcome === "choose" && inApp) {
    // Use a license key instead keeps the account: the key step is in the same form (Must not).
    if (s.event === "have-key" && license && ctx.caps.keyEntry) {
      const a = ctx.input.activation;
      return makeView(ctx, "SignIn", {
        state: "key",
        copy: [
          "signin.key.addTitle",
          "part.keyField.label",
          // `license_owned` never names the holder (S-16): only its core copy.
          ...(a && a.result !== "ok" ? activationCopy(a.result, a.code) : []),
        ],
        args,
        primary: "activate.submit",
        tone: a && a.result !== "ok" ? "neutral" : null,
        errorSlot: a && a.result !== "ok" ? "part.keyField.label" : null,
        focus: "part.keyField.label",
      });
    }
    if (
      s.event === "open-replace" &&
      s.replace === "inline" &&
      ctx.input.replaceView
    ) {
      const system = systemConfirm(ctx.platform, s.presentation);
      return makeView(ctx, "SignIn", {
        state: "replace",
        copy: [
          "signin.replace.open",
          "signin.replace.lede",
          system ? "signin.replace.openSystem" : "signin.replace.title",
        ],
        args,
        primary: system ? "signin.replace.openSystem" : "signin.replace.open",
      });
    }
    const desktop = platformClass(ctx.platform) === "desktop";
    return makeView(ctx, "SignIn", {
      state: "choose",
      copy: ["signin.choice.title", desktop && "signin.desktop.notifyChoose"],
      args,
      extraActions:
        s.event === "open-replace" && s.replace === "browser"
          ? ["replace-in-browser"]
          : [],
      // LicenseChoice draws the rows and Continue.
      primary: null,
      focus: null,
    });
  }
  if (s.redeeming || dc?.phase === "ok")
    return makeView(ctx, "SignIn", {
      state: "finishing",
      copy: ["signin.handoff.finishing", "a11y.busy"],
      args,
      focus: null,
    });
  if (s.channel === "device-code" || s.event === "use-code")
    // SignInHandoff draws the code view in the form's body.
    return makeView(ctx, "SignIn", {
      state: "code",
      copy: [],
      args,
      focus: null,
    });
  if (s.outcome === "pending")
    return makeView(ctx, "SignIn", {
      state: "handoff",
      copy: [
        "signin.handoff.title",
        "signin.handoff.browserBody",
        "signin.handoff.waiting",
        "signin.handoff.again",
        ctx.caps.deviceCode && "signin.handoff.useCode",
      ],
      args,
      primary: "signin.handoff.again",
    });
  // Cancel returns to step 1, with nothing else lost.
  return methodsView(ctx, args);
}

function methodsView(
  ctx: Context,
  args: Record<string, string>,
): View<"SignIn", SignInState> {
  return makeView(ctx, "SignIn", {
    state: "methods",
    copy: methodsCopy(ctx),
    args,
    primary: methodsPrimary(ctx),
  });
}

// ── SignInHandoff ──────────────────────────────────────────────────────────────────────────────

export type HandoffState =
  | "starting"
  | "waiting"
  | "no-browser"
  | "code"
  | "link-copied"
  | "finishing"
  | "denied"
  | "expired"
  | "cancelled"
  | "hidden";

/** Step 2 of the form: Finish in your browser, or the device code. Moves on by itself. */
export function signInHandoffView(
  ctx: Context,
): View<"SignInHandoff", HandoffState> {
  const s = ctx.input.signIn;
  if (!signInOn(ctx) || !s) return hiddenView(ctx, "SignInHandoff");
  const id = identityText(ctx);
  const dc = ctx.input.deviceCode;
  const c = platformClass(ctx.platform);
  const link = linkVerdict(verificationUrl(ctx), ctx.platform, "sign-in");
  const args = {
    product: id.name,
    url: link.display ?? undefined,
    code: dc?.userCode,
    time: dc?.secondsLeft !== undefined ? countdown(dc.secondsLeft) : undefined,
  };
  if (s.channel === "device-code" || s.event === "use-code") {
    // The device-code poll's phase alone selects the state (plans/UK-02b.md §4.5). At 0:00 the
    // view switches to expired locally while any poll finishes (DL14).
    const phase = dc?.phase ?? "starting";
    const lapsed = codeExpired(dc?.secondsLeft);
    if (phase === "expired" || lapsed)
      return makeView(ctx, "SignInHandoff", {
        state: "expired",
        // A lapsed code is never polled again, and its code is gone from the screen (Must not).
        copy: [
          "core.codes.sign-in-expired.title",
          "core.codes.sign-in-expired.message",
          "signInHandoff.newCode",
        ],
        args,
        primary: "signInHandoff.newCode",
        tone: "neutral",
      });
    switch (phase) {
      case "starting":
        return makeView(ctx, "SignInHandoff", {
          state: "starting",
          copy: ["signInHandoff.starting", "a11y.busy"],
          args,
          focus: null,
        });
      case "ok":
        return makeView(ctx, "SignInHandoff", {
          state: "finishing",
          copy: ["signin.handoff.finishing", "signInHandoff.ok"],
          args,
          focus: null,
        });
      case "denied":
        return makeView(ctx, "SignInHandoff", {
          state: "denied",
          copy: [
            "core.codes.sign-in-denied.title",
            "core.codes.sign-in-denied.message",
            "signInHandoff.newCode",
          ],
          args,
          primary: "signInHandoff.newCode",
          tone: "danger",
          errorSlot: "screen",
        });
      case "cancelled":
        return makeView(ctx, "SignInHandoff", {
          state: "cancelled",
          copy: ["signin.handoff.cancelled", "signInHandoff.newCode"],
          args,
          primary: "signInHandoff.newCode",
        });
    }
    return codeView(ctx, c, link, args);
  }
  if (s.redeeming)
    return makeView(ctx, "SignInHandoff", {
      state: "finishing",
      copy: ["signin.handoff.finishing"],
      args,
      focus: null,
    });
  if (s.outcome === "pending") {
    // The opener failed: the screen stays, with Copy link (DL14).
    if (s.browserOpened === false) {
      if (s.event === "copy-link")
        return makeView(ctx, "SignInHandoff", {
          state: "link-copied",
          copy: ["signInHandoff.linkCopied"],
          args,
          focus: null,
        });
      return makeView(ctx, "SignInHandoff", {
        state: "no-browser",
        copy: [
          "signin.handoff.noBrowser",
          "signin.handoff.noBrowserBody",
          "signin.handoff.copyLink",
        ],
        args,
        primary: "signin.handoff.copyLink",
        tone: "neutral",
      });
    }
    return makeView(ctx, "SignInHandoff", {
      state: "waiting",
      copy: [
        "signin.handoff.title",
        "signin.handoff.waiting",
        "signin.handoff.again",
        ctx.caps.deviceCode && "signin.handoff.useCode",
        "common.cancel",
      ],
      args,
      // Open browser again reuses the request in flight; it never starts a second one.
      primary: "signin.handoff.again",
    });
  }
  if (s.outcome === "expired")
    return makeView(ctx, "SignInHandoff", {
      state: "expired",
      copy: ["signInHandoff.newCode"],
      args,
      primary: "signInHandoff.newCode",
      tone: "neutral",
    });
  if (s.outcome === "cancelled")
    return makeView(ctx, "SignInHandoff", {
      state: "cancelled",
      copy: ["signin.handoff.cancelled", "signInHandoff.newCode"],
      args,
      primary: "signInHandoff.newCode",
    });
  return makeView(ctx, "SignInHandoff", {
    state: "starting",
    copy: ["signInHandoff.starting", "a11y.busy"],
    args,
    focus: null,
  });
}

/**
 * The code view (UI-KITS.md §4.3, DL14): the code, the address and the countdown everywhere; a
 * QR only on a TV or a console; Open browser where the device can browse. The QR, Copy and the
 * visible text carry exactly the same code and link.
 */
function codeView(
  ctx: Context,
  c: ReturnType<typeof platformClass>,
  link: ReturnType<typeof linkVerdict>,
  args: Record<string, string | undefined>,
): View<"SignInHandoff", HandoffState> {
  const head = ["signin.handoff.codeTitle", "part.code.label", "a11y.code"];
  if (c === "tv")
    return makeView(ctx, "SignInHandoff", {
      state: "code",
      // The QR beside the code, the address on its own line.
      copy: [
        ...head,
        link.qr && "a11y.qr",
        link.qr && "signInHandoff.scanTv",
        link.url !== null && "signin.handoff.url",
      ],
      args,
      link,
    });
  if (c === "console")
    return makeView(ctx, "SignInHandoff", {
      state: "code",
      // A larger QR the person can enlarge; the address inside the sentence.
      copy: [
        ...head,
        link.qr && "a11y.qr",
        link.qr && "part.qr.enlarge",
        "signInHandoff.scan",
      ],
      args,
      link,
    });
  const open = link.open && "signin.handoff.openBrowser";
  if (c === "handheld")
    return makeView(ctx, "SignInHandoff", {
      state: "code",
      // A phone leads with Open browser, then the code with Copy and the address with Copy.
      copy: [
        ...head,
        "a11y.copyCode",
        link.url !== null && "signin.handoff.url",
        link.url !== null && "a11y.copyAddress",
        open,
      ],
      args,
      primary: link.open ? "signin.handoff.openBrowser" : null,
      link,
    });
  return makeView(ctx, "SignInHandoff", {
    state: "code",
    copy: [
      ...head,
      "a11y.copyCode",
      link.url !== null && "signin.handoff.codeBody",
      open,
    ],
    args,
    primary: link.open ? "signin.handoff.openBrowser" : null,
    link,
  });
}

// ── LicenseChoice ──────────────────────────────────────────────────────────────────────────────

export type LicenseChoiceState =
  | "loading"
  | "many"
  | "one"
  | "current"
  | "keep"
  | "new"
  | "create"
  | "all-full"
  | "mixed"
  | "replace-open"
  | "raced"
  | "none-keys"
  | "none-no-keys"
  | "grant-expired"
  | "hidden";

/** A license's origin in plain words (SIGN-IN.md O-17); `purchase` needs none. Keys whose
 *  facts `LicenseChoice` does not carry (a key's last six, a gift, an organization) wait for the
 *  packages that add them. */
const ORIGIN_KEY: Readonly<Record<string, string>> = {
  store: "signin.choice.origin.store",
  key: "signin.choice.origin.keyAdded",
  free: "signin.choice.origin.free",
  developer: "signin.choice.origin.developer",
  signin: "signin.choice.origin.signIn",
};

/** Step 3 of the form: choose a license for this device. */
export function licenseChoiceView(
  ctx: Context,
): View<"LicenseChoice", LicenseChoiceState> {
  const s = ctx.input.signIn;
  if (
    !signInOn(ctx) ||
    !ctx.on("license") ||
    !s ||
    !choosesInApp(ctx) ||
    s.outcome !== "choose"
  )
    return hiddenView(ctx, "LicenseChoice");
  const id = identityText(ctx);
  const args = { product: id.name };
  if (ctx.input.loading)
    return makeView(ctx, "LicenseChoice", {
      state: "loading",
      copy: loadingVisible(ctx.input.elapsedMs)
        ? ["signin.choice.title", "common.loading"]
        : [],
      args,
      focus: null,
    });
  if (s.grantExpired)
    return makeView(ctx, "LicenseChoice", {
      state: "grant-expired",
      copy: ["signin.handoff.tooLong", "signin.again"],
      args,
      primary: "signin.again",
      tone: "neutral",
    });
  const view = ctx.input.choices;
  if (!view)
    return makeView(ctx, "LicenseChoice", {
      state: "loading",
      copy: ["signin.choice.title", "common.loading"],
      args,
      focus: null,
    });
  const replaceBrowser = s.event === "open-replace" && s.replace === "browser";
  const extraActions = replaceBrowser ? (["replace-in-browser"] as const) : [];
  const full = view.choices.filter((r) => r.state !== "free");
  const replaceable = full.find((r) => r.replace?.allowed);
  const replaceLink = linkVerdict(
    replaceable?.freeDeviceUrl,
    ctx.platform,
    "replace-device",
  );
  if (s.raced)
    return makeView(ctx, "LicenseChoice", {
      state: "raced",
      copy: [
        s.event === "confirm-replace"
          ? "signin.replace.raced"
          : "signin.choice.raced",
      ],
      args,
      primary: "signin.choice.continue",
      tone: "neutral",
    });
  if (
    s.event === "open-replace" &&
    s.replace === "inline" &&
    ctx.input.replaceView
  ) {
    const rv = ctx.input.replaceView;
    const pick = rv.devices.find((d) => d.leastRecent) ?? rv.devices[0];
    return makeView(ctx, "LicenseChoice", {
      state: "replace-open",
      copy: [
        "signin.replace.title",
        "signin.replace.open",
        "signin.replace.confirm",
        "signin.replace.consequence",
        "signin.replace.back",
      ],
      args: { ...args, device: pick?.label ?? undefined },
      primary: "signin.replace.confirm",
    });
  }
  if (view.state === "none") {
    const get = view.getLicense;
    if (get?.keyEntry && ctx.caps.keyEntry)
      return makeView(ctx, "LicenseChoice", {
        state: "none-keys",
        copy: [
          "signin.none.title",
          "signin.none.body",
          "signin.choice.keyInstead",
        ],
        args,
        primary: "signin.choice.keyInstead",
      });
    const purchase = linkVerdict(get?.purchaseUrl, ctx.platform, "purchase");
    return makeView(ctx, "LicenseChoice", {
      state: "none-no-keys",
      copy: [
        "signin.none.title",
        "signin.none.body",
        purchase.url !== null && "signin.none.get",
        "signin.none.otherAccount",
      ],
      args,
      primary:
        purchase.url !== null ? "signin.none.get" : "signin.none.otherAccount",
      link: purchase.url !== null ? purchase : null,
    });
  }
  if (view.state === "autoIssue")
    return makeView(ctx, "LicenseChoice", {
      state: "new",
      copy: [
        "signin.choice.ledeNew",
        "signin.choice.metaNew",
        "signin.choice.tag.new",
      ],
      args: { ...args, tier: view.create?.tierName },
      primary: "signin.choice.continue",
    });
  if ((ctx.input.selected ?? view.preselected) === "create" && view.create)
    return makeView(ctx, "LicenseChoice", {
      state: "create",
      copy: ["signin.choice.create", "signin.choice.createMeta"],
      args: { ...args, tier: view.create.tierName },
      primary: "signin.choice.continue",
    });
  const free = view.choices.filter((r) => r.state === "free");
  if (free.length === 0 && !view.keep)
    // A full license is a limit, not an error (DL6): its fix is the primary.
    return makeView(ctx, "LicenseChoice", {
      state: "all-full",
      copy: [
        "signin.choice.tag.full",
        view.create
          ? "signin.choice.allFullCreate"
          : replaceable
            ? "signin.choice.allFull"
            : "signin.choice.noneReplaceable",
      ],
      args,
      extraActions,
      primary: view.create
        ? "signin.choice.create"
        : replaceable
          ? "signin.replace.open"
          : null,
      tone: "neutral",
      link: replaceBrowser ? replaceLink : null,
    });
  if (view.keep)
    // Keep is its own row and outcome: never blurred with create or a new license (Must not).
    return makeView(ctx, "LicenseChoice", {
      state: "keep",
      copy: ["signin.choice.keep", "signin.choice.keepMeta"],
      args,
      extraActions,
      primary: "signin.choice.continue",
    });
  if (view.choices.some((r) => r.current))
    return makeView(ctx, "LicenseChoice", {
      state: "current",
      copy: ["signin.choice.tag.current"],
      args,
      extraActions,
      primary: "signin.choice.continue",
    });
  const access = new Set(view.choices.map((r) => r.access));
  if (access.has("account") && access.has("seats"))
    return makeView(ctx, "LicenseChoice", {
      state: "mixed",
      // `signin.choice.combined` waits for an SDK result that carries the entitlement model.
      copy: [],
      args,
      extraActions,
      primary: "signin.choice.continue",
    });
  if (view.choices.length === 1)
    return makeView(ctx, "LicenseChoice", {
      state: "one",
      copy: [
        "signin.choice.title",
        "signin.choice.lede",
        "signin.choice.continue",
      ],
      args: { ...args, tier: view.choices[0]!.tierName },
      extraActions,
      primary: "signin.choice.continue",
    });
  return makeView(ctx, "LicenseChoice", {
    state: "many",
    copy: [
      "signin.choice.title",
      "signin.choice.lede",
      "signin.choice.group",
      "signin.choice.meta",
      "signin.choice.devices",
      "signin.choice.continue",
      ...rowCopy(view.choices),
    ],
    args,
    extraActions,
    primary: "signin.choice.continue",
  });
}

/** The origin and term keys the rows' meta lines use. */
function rowCopy(rows: readonly LicenseChoiceRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const origin = ORIGIN_KEY[r.origin];
    if (origin) out.push(origin);
    out.push(
      r.expiresAt === null ? "signin.term.lifetime" : "signin.term.until",
    );
  }
  return out;
}
