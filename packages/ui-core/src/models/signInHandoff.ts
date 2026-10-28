// SignInHandoff and the shared pieces of the sign-in form's first two steps (the methods and the
// hand-off), in a module of their own so a page that draws only the hand-off (the gate) does not
// carry the rest of the form. ./signIn.ts re-exports them.

import { platformClass, systemConfirm, type Context } from "../input.js";
import {
  DEVICE_CODE_PAGE,
  SIGN_IN_PROVIDER_NAME,
  TV_CODE_PAGE,
} from "@polaris-key/protocol/core";
import { codeExpired, countdown, linkVerdict, validLink } from "../link.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

const DEFAULT_DEVICE_URL = DEVICE_CODE_PAGE;
const DEFAULT_TV_URL = TV_CODE_PAGE;
/** The provider the generic sign-in row names. That row opens Polaris Locker's own sign-in (the
 *  hosted card), so this is its true name; a product that shows a provider's row of its own (Apple,
 *  Google, Steam) says which with `UiInput.provider`. */
export const DEFAULT_PROVIDER = SIGN_IN_PROVIDER_NAME;

/** The sign-in is possible here: Identity is on and the build offers it. */
export function signInOn(ctx: Context): boolean {
  return ctx.on("identity") && ctx.caps.signIn;
}

/** True when the license choice happens in the app (inline or sheet, browser channel: D4). */
export function choosesInApp(ctx: Context): boolean {
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
  | "key-done"
  | "attach"
  | "added"
  | "done"
  | "error"
  | "expired"
  | "hidden";

/** The copy key of the first sign-in method, the methods step's primary (DL9). */
export function methodsPrimary(ctx: Context): string {
  return platformClass(ctx.platform) === "desktop"
    ? "signin.desktop.continue"
    : "signin.provider.continue";
}

export function methodsCopy(ctx: Context): (string | false)[] {
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

export function methodsView(
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
