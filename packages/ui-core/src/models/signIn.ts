// The signIn family (ui-matrix.json `signIn`): the one sign-in form of SIGN-IN.md §3.17, whose
// body morphs in place through methods → handoff | code → finishing → choose ↔ replace | key →
// done (plans/I-04.md §G). SignIn is the form; SignInHandoff draws its step 2 (Finish in your
// browser, the device code); LicenseChoice its step 3 (with Replace a device). These are pure
// functions of the session; `SignInModel` (../signInModel.ts) is the state machine that drives
// the SDK primitives and feeds them.
//
// Precedence, where several states could hold (ui-matrix.json `vocabulary.precedence`):
//
//   SignIn          error, auto (an automatic sign-in step), expired, done, key, replace, choose,
//                   finishing, code, handoff, methods
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
  type AutoSignInInput,
  type Context,
  type LicenseChoiceRow,
} from "../input.js";
import {
  DEVICE_CODE_PAGE,
  SIGN_IN_PROVIDER_NAME,
  TV_CODE_PAGE,
} from "@polaris-key/protocol/core";
import { codeExpired, countdown, linkVerdict, validLink } from "../link.js";
import { loadingVisible } from "../loading.js";
import { keyRefusalOf, keyRefusalSpec } from "./keyRefusal.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

const DEFAULT_DEVICE_URL = DEVICE_CODE_PAGE;
const DEFAULT_TV_URL = TV_CODE_PAGE;
/** The provider the generic sign-in row names. That row opens Polaris Locker's own sign-in (the
 *  hosted card), so this is its true name; a product that shows a provider's row of its own (Apple,
 *  Google, Steam) says which with `UiInput.provider`. */
const DEFAULT_PROVIDER = SIGN_IN_PROVIDER_NAME;

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
 *  Polaris Locker's (`/tv` on a TV or console, `/device` elsewhere; SIGN-IN.md D-16). */
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

/** What opening, copying or scanning the link does: the Polaris Locker page we fall back to carries
 *  the code (`?user_code=`), so the person need not type it. The displayed address stays bare. */
function verificationTarget(ctx: Context, shown: string): string {
  const code = ctx.input.deviceCode?.userCode;
  if (!code || (shown !== DEFAULT_DEVICE_URL && shown !== DEFAULT_TV_URL))
    return shown;
  return `${shown}?user_code=${encodeURIComponent(code)}`;
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
  | "key-refused"
  | "confirm"
  | "link-offer"
  | "link-done"
  | "link-conflict"
  | "nearby-prompt"
  | "nearby-wait"
  | "nearby-done"
  | "device-limit"
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
  const provider = ctx.input.provider ?? DEFAULT_PROVIDER;
  const args = {
    product: id.name,
    app: id.name,
    provider,
    // The sign-in that failed is the one the methods step's first row started.
    method: provider,
  };
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
  if (ctx.input.autoSignIn)
    return autoStepView(ctx, ctx.input.autoSignIn, {
      ...args,
      developer: id.developer ?? undefined,
      email: ctx.input.autoSignIn.email,
    });
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
        ? [
            "signin.done.start",
            // One key for "You're signed in · Pro license", so no kit joins two with a separator.
            ctx.input.account?.tier
              ? "signin.return.signedInTier"
              : "signin.return.signedInShort",
          ]
        : ["signin.desktop.toast"];
    return makeView(ctx, "SignIn", {
      state: "done",
      copy,
      args: {
        ...args,
        name: ctx.input.account?.holder,
        tier: ctx.input.account?.tier,
      },
      primary: copy.includes("signin.done.start") ? "signin.done.start" : null,
      focus: copy.includes("signin.done.start") ? undefined : null,
    });
  }
  const inApp = choosesInApp(ctx);
  if (s.outcome === "choose" && inApp) {
    // Use a license key instead keeps the account: the key step is in the same form (Must not).
    if (s.event === "have-key" && license && ctx.caps.keyEntry) {
      const a = ctx.input.activation;
      const refusal = keyRefusalOf(a);
      // The refusals a different key cannot fix leave the field behind (DL6).
      if (a && refusal !== null) {
        const spec = keyRefusalSpec(ctx, refusal, a);
        return makeView(ctx, "SignIn", {
          state: "key-refused",
          copy: spec.copy,
          args,
          primary: spec.primary,
          tone: "neutral",
          link: spec.link,
          qr: spec.qr,
        });
      }
      return makeView(ctx, "SignIn", {
        state: "key",
        copy: [
          "signin.key.addTitle",
          "part.keyField.label",
          // `license_owned` never names the holder (S-16): only its core copy.
          ...(a && a.result !== "ok" ? activationCopy(a.result, a.code) : []),
        ],
        args: { ...args, code: a?.code },
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
      const rv = ctx.input.replaceView;
      const pick = rv.devices.find((d) => d.leastRecent) ?? rv.devices[0];
      return makeView(ctx, "SignIn", {
        state: "replace",
        copy: [
          "signin.replace.open",
          "signin.replace.lede",
          system ? "signin.replace.openSystem" : "signin.replace.title",
        ],
        args: { ...args, device: pick?.label ?? undefined },
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

/** The provider's identity is per developer: Apple always, Google unless shared across apps. */
function perDeveloper(
  provider: string,
  reach: AutoSignInInput["reach"],
): boolean {
  return provider === "Apple" || reach !== "global";
}

/** Automatic sign-in's steps, drawn in the form's body (plans/auto-sign-in.md §3): confirm the
 *  account, offer to link the provider, and the nearby wait. Every outcome has a title that takes
 *  focus and one way on (Continue). */
function autoStepView(
  ctx: Context,
  auto: AutoSignInInput,
  args: Record<string, string | undefined>,
): View<"SignIn", SignInState> {
  const provider = ctx.input.provider ?? DEFAULT_PROVIDER;
  const view = (
    state: SignInState,
    copy: (string | false | undefined)[],
    o: {
      primary?: string | null;
      tone?: "neutral";
      focus?: string | null;
    } = {},
  ) =>
    makeView(ctx, "SignIn", {
      state,
      copy,
      args: {
        ...args,
        provider,
        tier: ctx.input.account?.tier,
        code: auto.code,
      },
      primary: o.primary ?? null,
      tone: o.tone ?? null,
      focus: o.focus === undefined ? "heading" : o.focus,
    });
  switch (auto.step) {
    case "confirm":
      return view(
        "confirm",
        [
          "signin.auto.confirm.title",
          auto.email ? "signin.auto.confirm.as" : "signin.auto.confirm.asApple",
          // What Continue does: the license this device gets, and what the app also receives.
          auto.license && "signin.consent.license",
          auto.license === "new" && "signin.consent.newLicense",
          auto.license === "existing" && "signin.consent.licenseLine",
          auto.alsoGets && "signin.consent.alsoGets",
          auto.alsoGets && "signin.consent.profile",
          auto.alsoGets && "signin.consent.pairwise",
          "signin.auto.confirm.primary",
          "signin.auto.confirm.other",
        ],
        { primary: "signin.auto.confirm.primary" },
      );
    case "link-offer": {
      // Per developer: named when the developer is known, else the app and its developer's others.
      const body = !perDeveloper(provider, auto.reach)
        ? "signin.linkOffer.bodyGlobal"
        : args.developer
          ? "signin.linkOffer.bodyDeveloper"
          : "signin.linkOffer.bodyApp";
      return view(
        "link-offer",
        [
          "signin.linkOffer.title",
          body,
          "signin.linkOffer.primary",
          "signin.linkOffer.decline",
        ],
        { primary: "signin.linkOffer.primary" },
      );
    }
    case "link-done":
      return view("link-done", ["signin.linkOffer.done", "common.continue"], {
        primary: "common.continue",
      });
    case "link-conflict":
      return view(
        "link-conflict",
        [
          "signin.linkOffer.conflictTitle",
          "signin.linkOffer.conflict",
          "signin.linkOffer.join",
          "common.continue",
        ],
        { primary: "common.continue", tone: "neutral" },
      );
    case "nearby-prompt":
      return view(
        "nearby-prompt",
        [
          "signin.nearby.promptTitle",
          "signin.nearby.prePrompt",
          "common.continue",
          "common.notNow",
        ],
        { primary: "common.continue" },
      );
    case "nearby-wait":
      return view("nearby-wait", [
        "signin.nearby.title",
        "signin.nearby.body",
        "signin.nearby.match",
        auto.code && "a11y.nearbyCode",
        "signin.nearby.code",
      ]);
    case "device-limit": {
      // A device limit with no license rows, reached from automatic sign-in or a provider
      // sign-in: its own step, never the key screen. Replace opens the refusal's `manageUrl`.
      const link = linkVerdict(auto.manageUrl, ctx.platform, "replace-device");
      const replace = link.url !== null;
      return makeView(ctx, "SignIn", {
        state: "device-limit",
        copy: [
          "core.codes.device_limit.title",
          "core.codes.device_limit.message",
          replace ? "signin.deviceLimit.replace" : "deviceLimit.noManage",
          replace && "a11y.externalLink",
          "signin.auto.confirm.other",
          "common.cancel",
        ],
        args: { ...args, provider },
        primary: replace ? "signin.deviceLimit.replace" : null,
        tone: "neutral",
        focus: "heading",
        link,
        extraActions: replace ? ["open-manage-url"] : [],
      });
    }
    case "nearby-done":
      return view(
        "nearby-done",
        ["signin.nearby.done", "common.continue", "signin.nearby.notYou"],
        { primary: "common.continue" },
      );
  }
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
  | "failed"
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
  const shown = verificationUrl(ctx);
  const bare = linkVerdict(shown, ctx.platform, "sign-in");
  const link = bare.url
    ? { ...bare, url: verificationTarget(ctx, bare.url) }
    : bare;
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
      case "failed":
        return makeView(ctx, "SignInHandoff", {
          state: "failed",
          copy: [
            "core.codes.sign-in-failed.title",
            "core.codes.sign-in-failed.message",
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
  const args = { product: id.name, developer: id.developer ?? id.name };
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
